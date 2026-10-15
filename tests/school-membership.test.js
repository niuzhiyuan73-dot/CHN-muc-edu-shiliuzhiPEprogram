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

test('unified grant is tiered by identity and cross-school browsing is read-only', async () => {
  const repo = fixture();
  await repo.users.set('platformAdmin', { _id: 'platformAdmin', openId: 'openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin' });
  await apply(repo);
  await review(repo);
  const grant = (payload, openId = 'openid_platform_admin', schoolId = 'muc') =>
    request(repo, 'grantSchoolPermission', payload, openId, schoolId);
  const roster = (openId = 'mock_openid_muc_admin', schoolId = 'muc') =>
    request(repo, 'getSchoolMembers', {}, openId, schoolId);

  // 平台管理员三档全开；校管理员收窄到协会 / 学院两档
  assert.deepEqual((await request(repo, 'getSchoolIdentitySession', {}, 'openid_platform_admin')).data
    .grants.map(g => g.permission), ['schoolAdmin', 'associationLeader', 'collegeLeader']);
  assert.deepEqual((await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin')).data
    .grants.map(g => g.permission), ['associationLeader', 'collegeLeader']);

  assert.equal((await grant({ userId: 'new1', permission: 'associationLeader', make: true })).data.ok, true);
  let rows = (await roster()).data;
  assert.equal(rows.readOnly, false);
  assert.equal(rows.members.find(m => m.userId === 'new1').permissionLabel, '协会负责人');
  // 升任协会负责人后只剩学院一档可授
  assert.deepEqual((await request(repo, 'getSchoolIdentitySession', {}, 'new1')).data
    .grants.map(g => g.permission), ['collegeLeader']);
  // 学院负责人须落到本校有效学院
  assert.equal((await grant({ userId: 'demo_muc_member', permission: 'collegeLeader', make: true }, 'mock_openid_muc_admin')).data.ok, false);
  assert.equal((await grant({ userId: 'demo_muc_member', permission: 'collegeLeader', make: true, collegeId: 'c01' }, 'mock_openid_muc_admin')).data.ok, true);
  rows = (await roster()).data;
  assert.equal(rows.members.find(m => m.userId === 'demo_muc_member').permission, 'collegeLeader');

  // 跨校只读：可读外校名单，但没有授权入口，也无法越权写入
  const remote = (await roster('mock_openid_muc_admin', 'buaa')).data;
  assert.equal(remote.readOnly, true);
  assert.deepEqual(remote.grants, []);
  assert.ok(remote.members.some(m => m.userId === 'demo_buaa_member'));
  assert.equal((await grant({ userId: 'demo_buaa_member', permission: 'collegeLeader', make: true, collegeId: 'c01' }, 'mock_openid_muc_admin', 'buaa')).data.ok, false);
  // 不能给自己指定权限
  assert.equal((await grant({ userId: 'platformAdmin', permission: 'schoolAdmin', make: true })).data.ok, false);
});

test('identity session exposes local review capability without disclosing global account fields', async () => {
  const repo = fixture();
  const local = (await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin')).data;
  assert.equal(local.canReview, true);
  // user 只含本人账号展示字段（B3：昵称 / 实名 / 性别 / 头像随账号走）与
  // primarySchoolId / platformStatus，不下发 openId / 学号占用等账号隐私。
  assert.deepEqual(Object.keys(local.user).sort(),
    ['avatarUrl', 'gender', 'nickName', 'platformStatus', 'primarySchoolId', 'realName', 'userId']);
  const remote = (await request(repo, 'getSchoolIdentitySession', {}, 'mock_openid_muc_admin', 'buaa')).data;
  assert.equal(remote.canReview, false);
  assert.equal(remote.account, null);
  const guest = (await request(repo, 'getSchoolIdentitySession', {}, '')).data;
  assert.equal(guest.user, null);
  assert.equal(guest.canReview, false);
});

test('identity session discloses the actor own permission tier and college-manage ability', async () => {
  const repo = fixture();
  const session = (openId, schoolId = 'muc') =>
    request(repo, 'getSchoolIdentitySession', {}, openId, schoolId).then(res => res.data);

  // 校管理员：校级档，能管本校任意学院（含自己的）
  const admin = await session('mock_openid_muc_admin');
  assert.equal(admin.permission, 'schoolAdmin');
  assert.equal(admin.permissionLabel, '校级管理员');
  assert.equal(admin.canManageCollege, true);

  // 普通会员：无权限档，展示标签退回「会员」，也管不了学院
  const member = await session('mock_openid_muc_member');
  assert.equal(member.permission, '');
  assert.equal(member.permissionLabel, '会员');
  assert.equal(member.canManageCollege, false);

  // 授予学院负责人后：档位与「管得动本学院」同时为真——这正是旧栈会话里
  // 无从分辨、页面推不出来的那一档
  await request(repo, 'grantSchoolPermission',
    { userId: 'demo_muc_member', permission: 'collegeLeader', make: true, collegeId: 'c01' },
    'mock_openid_muc_admin', 'muc');
  const leader = await session('mock_openid_muc_member');
  assert.equal(leader.permission, 'collegeLeader');
  assert.equal(leader.permissionLabel, '学院负责人');
  assert.equal(leader.canManageCollege, true);

  // 跨校只读与访客：不下发权限档，也管不了任何学院
  const remote = await session('mock_openid_muc_admin', 'buaa');
  assert.equal(remote.permission, '');
  assert.equal(remote.permissionLabel, '');
  assert.equal(remote.canManageCollege, false);

  const guest = await session('');
  assert.equal(guest.permission, '');
  assert.equal(guest.canManageCollege, false);
});
