const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { schoolMemberKey, schoolRoleKey } = require('../miniprogram/utils/school');
const { handleSchoolRequest } = require('../cloudfunctions/data/src/core/school-request');

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push(...['new1', 'new2'].map(id => ({ _id: id, openId: id, platformStatus: 'active', platformRole: 'member' })));
  return createMemoryRepo(seed);
}
const request = (repo, action, payload = {}, openId = 'new1', schoolId = 'muc') => handleSchoolRequest({
  protocolVersion: 2, schoolId, association: 'pkb', action, payload,
}, { repo, openId, now: new Date('2026-10-13T12:00:00Z') });
const apply = (repo, user = 'new1', schoolId = 'muc', studentId = 'NEW001') => request(repo, 'applySchoolMembership', { collegeId: 'c01', studentId }, user, schoolId);
const review = (repo, user = 'new1', schoolId = 'muc', revision = 1) => request(repo, 'reviewSchoolMembership', {
  userId: user, decision: 'approve', revision,
}, `mock_openid_${schoolId}_admin`, schoolId);

test('application, local review, student claim, primary school and private read form a complete flow', async () => {
  const repo = fixture();
  const first = (await apply(repo)).data;
  assert.equal(first.ok, true);
  assert.equal(first.account.status, 'pending');
  assert.equal((await apply(repo)).data.account.revision, 1);
  const rows = (await request(repo, 'getSchoolApplications', {}, 'mock_openid_muc_admin')).data.applications;
  assert.equal(rows.length, 1);
  assert.equal((await review(repo)).data.ok, true);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'muc');
  assert.equal((await request(repo, 'getMySchoolMembership', { userId: 'new2' })).data.account.userId, 'new1');
  const claims = await repo.studentIdClaims.list();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].studentId, undefined);
  assert.ok(!claims[0]._id.includes('NEW001'));
  assert.equal((await review(repo)).data.ok, false);
});

test('same-school duplicate student IDs are denied, including pre-S2 active identities', async () => {
  const repo = fixture();
  await apply(repo, 'new1', 'muc', 'TEST001');
  assert.equal((await review(repo)).data.ok, false);
  await apply(repo, 'new1', 'muc', 'NEW001');
  assert.equal((await review(repo, 'new1', 'muc', 2)).data.ok, true);
  await apply(repo, 'new2');
  assert.equal((await review(repo, 'new2')).data.ok, false);
  assert.equal((await repo.users.getById('new2')).primarySchoolId, undefined);
});

test('identical student IDs are allowed in different schools', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new2', 'buaa');
  assert.equal((await review(repo)).data.ok, true);
  assert.equal((await review(repo, 'new2', 'buaa')).data.ok, true);
  assert.equal((await repo.studentIdClaims.list()).length, 2);
});

test('concurrent school approvals re-read primary identity before committing', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new1', 'buaa');
  const original = repo.transaction;
  let injected = false;
  repo.transaction = async fn => {
    if (!injected) { injected = true; assert.equal((await review(repo, 'new1', 'buaa')).data.ok, true); }
    return original(fn);
  };
  assert.equal((await review(repo)).data.ok, false);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, 'buaa');
  assert.equal((await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'))).status, 'pending');
});

test('student claim protects approvals even when competitor commits after membership list read', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new2');
  const original = repo.transaction;
  let injected = false;
  repo.transaction = async fn => {
    if (!injected) { injected = true; assert.equal((await review(repo, 'new2')).data.ok, true); }
    return original(fn);
  };
  assert.equal((await review(repo)).data.ok, false);
  assert.equal((await repo.studentIdClaims.list()).length, 1);
});

test('audit failure rolls back approval, identity pointer and student claim', async () => {
  const repo = fixture();
  await apply(repo);
  const original = repo.transaction;
  repo.transaction = fn => original(async tx => {
    tx.audit.append = async () => { throw new Error('injected audit failure'); };
    return fn(tx);
  });
  await assert.rejects(review(repo), /injected/);
  assert.equal((await repo.users.getById('new1')).primarySchoolId, undefined);
  assert.equal((await repo.studentIdClaims.list()).length, 0);
  assert.equal((await repo.schoolMembers.getById(schoolMemberKey('new1', 'muc'))).status, 'pending');
  repo.transaction = original;
  assert.equal((await review(repo)).data.ok, true);
});

test('stale applications must be refreshed and rejection requires a reason', async () => {
  const repo = fixture();
  await apply(repo);
  await apply(repo, 'new1', 'muc', 'NEW002');
  assert.equal((await review(repo)).data.ok, false);
  const payload = { userId: 'new1', decision: 'reject', revision: 2 };
  assert.equal((await request(repo, 'reviewSchoolMembership', payload, 'mock_openid_muc_admin')).data.ok, false);
  assert.equal((await request(repo, 'reviewSchoolMembership', { ...payload, reason: '信息需核实' }, 'mock_openid_muc_admin')).data.ok, true);
  assert.equal((await apply(repo)).data.account.revision, 4);
});

test('authorization revoked after request context is rechecked inside approval transaction', async () => {
  const repo = fixture();
  await apply(repo);
  const original = repo.transaction;
  repo.transaction = async fn => {
    await repo.schoolRoles.set(schoolRoleKey('demo_muc_admin', 'muc'), {
      userId: 'demo_muc_admin', schoolId: 'muc', role: 'admin', status: 'disabled',
    });
    return original(fn);
  };
  assert.equal((await review(repo)).data.ok, false);
});

test('cross-school readers, forged actors and legacy actions cannot use school protocol', async () => {
  const repo = fixture();
  await apply(repo);
  assert.equal((await request(repo, 'getSchoolApplications', { actorId: 'demo_muc_admin' }, 'new1')).data.ok, false);
  assert.equal((await request(repo, 'getSchoolApplications', {}, 'mock_openid_muc_admin', 'buaa')).data.ok, false);
  assert.equal((await request(repo, 'submitMatch')).ok, false);
  assert.equal((await request(repo, 'toString')).ok, false);
  assert.equal((await handleSchoolRequest({ action: 'applySchoolMembership' }, { repo, openId: 'new1' })).ok, false);
  assert.equal((await apply(repo, 'mock_openid_buaa_member', 'muc')).data.ok, false);
});

test('identity client binds school and protocol across interleaved requests', async () => {
  const { forSchoolIdentity } = require('../miniprogram/services/school-cloud');
  const calls = [];
  global.wx = { cloud: { callFunction: async ({ data }) => { calls.push(data); return { result: { ok: true, data: { ok: true } } }; } } };
  try {
    const input = { schoolId: 'muc', association: 'pkb' };
    const a = forSchoolIdentity(input);
    input.schoolId = 'buaa';
    const b = forSchoolIdentity(input);
    await Promise.all([a.getMySchoolMembership(), b.getMySchoolMembership()]);
    assert.deepEqual(calls.map(c => c.schoolId), ['muc', 'buaa']);
    assert.ok(calls.every(c => c.protocolVersion === 2));
  } finally { delete global.wx; }
});

test('school directory is public but exposes only names and IDs of the selected colleges', async () => {
  const repo = fixture();
  const result = (await request(repo, 'getSchoolDirectory', {}, '', 'buaa')).data;
  assert.equal(result.ok, true);
  assert.equal(result.schools.length, 2);
  assert.equal(result.colleges[0].name, '航空学院（模拟）');
  assert.deepEqual(Object.keys(result.schools[0]).sort(), ['name', 'schoolId', 'shortName']);
  assert.deepEqual(Object.keys(result.colleges[0]).sort(), ['collegeId', 'name']);
});

test('identity session exposes local review capability without disclosing global account fields', async () => {
  const repo = fixture();
  const local = (await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin')).data;
  assert.equal(local.canReview, true);
  assert.deepEqual(Object.keys(local.user).sort(), ['nickName', 'primarySchoolId', 'userId']);
  const remote = (await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin', 'buaa')).data;
  assert.equal(remote.canReview, false);
  assert.equal(remote.account, null);
  const guest = (await request(repo, 'getSchoolIdentitySession', {}, '')).data;
  assert.equal(guest.user, null);
  assert.equal(guest.canReview, false);
});
