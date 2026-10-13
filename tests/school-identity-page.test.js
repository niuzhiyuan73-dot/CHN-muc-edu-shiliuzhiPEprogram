const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const facade = require('../miniprogram/services/index');
const mock = require('../miniprogram/services/school-mock');
const service = require('../miniprogram/services/school-identity');
const scope = require('../miniprogram/services/association-scope');

function page() {
  let definition;
  const prior = global.Page;
  global.Page = value => { definition = value; };
  const path = require.resolve('../miniprogram/pages/school-identity/school-identity');
  delete require.cache[path];
  try { require(path); } finally { global.Page = prior; }
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values); } };
}
const select = value => ({ detail: { value } });
const reviewEvent = decision => ({ currentTarget: { dataset: { userId: 'demo_applicant', decision } } });
async function submit(p) {
  p.onCollegeChange(select(0));
  p.onStudentIdInput(select('NEW003'));
  await p.onApply();
}
beforeEach(() => { facade.setDataSource('mock'); mock.reset(); scope.setAssociation('tt'); });

test('page supports Beihang application and local-admin approval without changing old association', async () => {
  const p = page();
  await p.onLoad();
  assert.equal(p.data.canApply, true);
  await p.onSchoolChange(select(1));
  assert.equal(p.data.schoolName, '北京航空航天大学');
  await submit(p);
  assert.equal(p.data.statusText, '待审核');
  await p.onDemoActorChange(select(1));
  assert.equal(p.data.canReview, false);
  assert.deepEqual(p.data.applications, []);
  await p.onDemoActorChange(select(2));
  assert.equal(p.data.canReview, true);
  assert.equal(p.data.applications.length, 1);
  assert.equal(p.data.applications[0].nickName, '模拟申请人');
  await p.onReview(reviewEvent('approve'));
  assert.equal(p.data.applications.length, 0);
  await p.onDemoActorChange(select(0));
  assert.equal(p.data.statusText, '已通过');
  assert.equal(p.data.canApply, false);
  await p.onSchoolChange(select(0));
  assert.equal(p.data.canApply, false);
  assert.match(p.data.notice, /转校/);
  assert.equal(scope.getAssociation(), 'tt');
});

test('rejection requires a reason, returns it to applicant and allows resubmission', async () => {
  const p = page();
  await p.onLoad();
  await submit(p);
  await p.onDemoActorChange(select(1));
  await p.onReview(reviewEvent('reject'));
  assert.match(p.data.error, /理由/);
  p.onReasonInput({ currentTarget: { dataset: { userId: 'demo_applicant' } }, detail: { value: '请核实学号' } });
  await p.onReview(reviewEvent('reject'));
  await p.onDemoActorChange(select(0));
  assert.equal(p.data.statusText, '已驳回');
  assert.equal(p.data.account.reviewReason, '请核实学号');
  await submit(p);
  assert.equal(p.data.statusText, '待审核');
  assert.equal(p.data.account.revision, 3);
});

test('duplicate clicks submit once and source scope is locked while writing', async () => {
  const p = page();
  await p.onLoad();
  p.onCollegeChange(select(0));
  p.onStudentIdInput(select('NEW003'));
  const original = p.api;
  let release;
  let calls = 0;
  p.api = { ...original, applySchoolMembership: async fields => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return original.applySchoolMembership(fields);
  } };
  const pending = p.onApply();
  await p.onApply();
  await p.onSchoolChange(select(1));
  await p.onDemoActorChange(select(2));
  assert.equal(p.data.schoolId, 'muc');
  assert.equal(mock.getDemoActor(), 'demo_applicant');
  release();
  await pending;
  assert.equal(calls, 1);
  assert.equal(p.data.statusText, '待审核');
  assert.equal(p.data.submitting, false);
});

test('failed write releases button state and retains editable form', async () => {
  const p = page();
  await p.onLoad();
  p.onCollegeChange(select(0));
  p.onStudentIdInput(select('NEW003'));
  p.api = { applySchoolMembership: async () => { throw new Error('offline'); } };
  await p.onApply();
  assert.equal(p.data.error, 'offline');
  assert.equal(p.data.submitting, false);
  assert.equal(p.data.studentId, 'NEW003');
  assert.equal(p.data.canApply, true);
});

test('older responses and unloaded page do not overwrite the latest scope', async () => {
  const p = page();
  await p.onLoad();
  const original = service.forSchoolIdentity;
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  service.forSchoolIdentity = target => {
    const api = original(target);
    return target.schoolId === 'muc' ? { ...api, getSchoolIdentitySession: async () => {
      await delayed;
      return api.getSchoolIdentitySession();
    } } : api;
  };
  try {
    const stale = p.reload();
    await p.onSchoolChange(select(1));
    release();
    await stale;
    assert.equal(p.data.schoolId, 'buaa');
    assert.equal(p.data.schoolName, '北京航空航天大学');
    const pending = p.reload();
    p.onUnload();
    const saved = JSON.stringify(p.data);
    await pending;
    assert.equal(JSON.stringify(p.data), saved);
  } finally { service.forSchoolIdentity = original; }
});

test('demo client binds actor at creation and serializes competing approvals', async () => {
  const applicant = mock.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  await applicant.applySchoolMembership({ collegeId: 'c01', studentId: 'NEW100' });
  mock.setDemoActor('demo_muc_admin');
  const admin = mock.forSchoolIdentity({ schoolId: 'muc', association: 'pkb' });
  assert.equal((await applicant.getSchoolIdentitySession()).user.userId, 'demo_applicant');
  const results = await Promise.all([1, 2].map(() => admin.reviewSchoolMembership({ userId: 'demo_applicant', revision: 1, decision: 'approve' })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal((await applicant.getMySchoolMembership()).account.status, 'active');
});

test('cloud mode hides demo controls and prevents demo actor selection', async () => {
  facade.setDataSource('cloud');
  assert.deepEqual(service.getDemoActors(), []);
  assert.throws(() => service.setDemoActor('demo_muc_admin'));
  facade.setDataSource('mock');
});
