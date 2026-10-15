/**
 * 学校维度：个人赛事「发布 + 报名」阶段（迁移清单 M1-a）
 *
 * 守的是两件事：
 *   1. 同协会的会员能读能报，跨学校 / 跨协会读不到、更写不进；
 *   2. 报名阶段的规则（名额、性别项目、报名截止 / 抽签冻结、幂等）与旧栈同一口径。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-event-service');
const {
  schoolMemberKey, schoolEventKey, schoolEventSignupKey,
} = require('../miniprogram/utils/school');
const { MATCH_TYPE, EVENT_STATUS, SIGNUP_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const startAt = new Date(NOW.getTime() + DAY).toISOString();

function fixture({ memberGender = 'M' } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  const setGender = (id, gender) => {
    const user = seed.users.find(item => item._id === id);
    if (user) user.gender = gender;
  };
  setGender('demo_muc_member', memberGender);
  setGender('demo_muc_admin', 'M');
  setGender('demo_buaa_member', 'M');
  // 第二个民大在册会员：用于验证名额上限（同样满足「本协会有效会员」资格）。
  seed.users.push({ _id: 'demo_muc_member_2', openId: 'mock_openid_muc_member_2',
    nickName: '民大模拟会员二', gender: 'M', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: 'muc', simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_member_2', 'muc'),
    userId: 'demo_muc_member_2', schoolId: 'muc', collegeId: 'c01',
    studentId: 'TEST003', status: 'active', simulated: true });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '周末单打赛', description: '协会常规赛', matchType: MATCH_TYPE.SINGLES, level: 3,
  format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
  startTime: startAt, courtCount: 2, ...extra,
});

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishSchoolEvent', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.event;
}

test('发布：仅协会负责人及以上可发，会员被拒', async () => {
  const repo = fixture();
  const byMember = await call(repo, 'publishSchoolEvent', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /负责人/);

  const byAdmin = await call(repo, 'publishSchoolEvent', { requestId: 'r1', ...valid() });
  assert.equal(byAdmin.ok, true, byAdmin.message);
  assert.equal(byAdmin.event.status, EVENT_STATUS.SIGNUP);
  assert.equal(byAdmin.event.signupCount, 0);
});

test('发布：请求编号幂等，改内容重发被拒；非法编号与非法表单被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1');
  const again = await call(repo, 'publishSchoolEvent', { requestId: 'r1', ...valid() });
  assert.equal(again.ok, true);
  assert.equal(again.event.eventId, first.eventId, '同编号同内容返回同一条');

  const changed = await call(repo, 'publishSchoolEvent',
    { requestId: 'r1', ...valid({ title: '换了名字的赛' }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /已使用/);

  const badToken = await call(repo, 'publishSchoolEvent', { requestId: '含 空格', ...valid() });
  assert.equal(badToken.ok, false);

  const badForm = await call(repo, 'publishSchoolEvent', { requestId: 'r2', ...valid({ title: '短' }) });
  assert.equal(badForm.ok, false);
  assert.ok(badForm.errors && badForm.errors.title, '表单错误按字段下发');
});

test('报名：会员可报，人数计数与重复报名幂等', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  const signed = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(signed.ok, true, signed.message);
  assert.equal(signed.signup.status, SIGNUP_STATUS.SIGNED);
  assert.equal(signed.event.signupCount, 1);

  const again = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(again.ok, true, '重复报名幂等');
  assert.equal(again.event.signupCount, 1, '不重复计数');

  const detail = await call(repo, 'getSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(detail.ok, true);
  assert.equal(detail.event.mySignup.status, SIGNUP_STATUS.SIGNED);
  assert.equal(detail.capabilities.canSignUp, false, '已报名不能再报');
  assert.equal(detail.capabilities.canCancelSignup, true);
});

test('详情：能力旗标按角色与赛程状态下发，写端仍会再判一次', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  // 报名阶段：会员可报不能开赛/抽签/录名次；管理员可开赛但还不能开（未抽签由写端挡）。
  const asMember = await call(repo, 'getSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(asMember.capabilities.canSignUp, true);
  assert.equal(asMember.capabilities.canStart, false);
  assert.equal(asMember.capabilities.canDraw, false);
  assert.equal(asMember.capabilities.canFinish, false);

  const asAdmin = await call(repo, 'getSchoolEvent', { eventId: event.eventId });
  assert.equal(asAdmin.capabilities.canDraw, true, '负责人可抽签');
  assert.equal(asAdmin.capabilities.canStart, true, '负责人可开赛');
  assert.equal(asAdmin.capabilities.canFinish, false, '还没开赛，不能录名次');

  // 详情不下发未抽签时的签表 / 名次（真值为空）。
  assert.equal(asAdmin.event.draw, null);
  assert.deepEqual(asAdmin.event.results, []);
});

test('报名名单：带姓名与学院；取消者剔除；跨校读不到', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member_2' });
  // 第三个人报了又退，名单里不应出现。
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_admin' });
  await call(repo, 'cancelSchoolEventSignup', { eventId: event.eventId }, { actor: 'demo_muc_admin' });

  const roster = await call(repo, 'listSchoolEventSignups', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(roster.ok, true, roster.message);
  assert.deepEqual(roster.signups.map(row => row.userId).sort(),
    ['demo_muc_member', 'demo_muc_member_2'], '取消报名的人不占名单');

  const first = roster.signups.find(row => row.userId === 'demo_muc_member');
  assert.ok(first, '报名者在名单里');
  assert.ok(first.nickName, '带昵称');
  assert.equal(typeof first.college, 'string');
  assert.equal(first.status, SIGNUP_STATUS.SIGNED);
  assert.equal(first.canCheckIn, false, '报名阶段还不能签到');

  // 名单只下发展示字段：不得出现学号 / 手机号。
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'studentId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'phone'), false);

  // 外校读不到这份名单。
  const buaa = await call(repo, 'listSchoolEventSignups', { eventId: event.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_admin' });
  assert.equal(buaa.ok, false);
});

test('报名：名额满了就拒，取消报名释放名额', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1', { quota: 1 });

  const first = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(first.ok, true);

  const second = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member_2' });
  assert.equal(second.ok, false, '名额只剩 0，第二人被拒');
  assert.match(second.message, /满/);

  const cancel = await call(repo, 'cancelSchoolEventSignup', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.event.signupCount, 0);
  assert.equal(cancel.event.mySignup.status, SIGNUP_STATUS.CANCELED);

  const resub = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(resub.ok, true, '取消后可重新报名');
  assert.equal(resub.event.signupCount, 1);
});

test('报名：性别项目只收相符性别', async () => {
  const repo = fixture({ memberGender: 'F' });
  const event = await publish(repo, 'r1', { discipline: 'MS' }); // 男单

  const blocked = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /男单/);

  const byMale = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_admin' });
  assert.equal(byMale.ok, true, byMale.message);
});

test('跨学校 / 跨协会：读不到、写不进', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  // 北航看不到民大的赛事。
  const buaaList = await call(repo, 'listSchoolEvents', {}, {
    schoolId: 'buaa', actor: 'demo_buaa_admin', association: 'pkb',
  });
  assert.equal(buaaList.ok, true);
  assert.equal(buaaList.events.length, 0, '外校列表为空');

  const buaaGet = await call(repo, 'getSchoolEvent', { eventId: event.eventId }, {
    schoolId: 'buaa', actor: 'demo_buaa_member', association: 'pkb',
  });
  assert.equal(buaaGet.ok, false);
  assert.match(buaaGet.message, /不存在/);

  // 北航会员报名民大 / 北航的赛事键（同一 eventId 在北航范围内不存在）。
  const buaaSignup = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, {
    schoolId: 'buaa', actor: 'demo_buaa_member', association: 'pkb',
  });
  assert.equal(buaaSignup.ok, false);

  // 民大另一协会（乒乓）也看不到。
  const otherAssoc = await call(repo, 'listSchoolEvents', {}, {
    actor: 'demo_muc_member', association: 'tt',
  });
  assert.equal(otherAssoc.ok, true);
  assert.equal(otherAssoc.events.length, 0, '本校外协会看不到');
});

test('主记录带范围：schoolId + association，键含范围', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  const stored = await repo.events.getById(event.eventId);
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
  assert.equal(event.eventId, schoolEventKey(require('../miniprogram/utils/school')
    .schoolKey('e', 'demo_muc_admin', 'r1'), { schoolId: 'muc', association: 'pkb' }));
});

test('报名记录：稳定主键按范围生成，跨范围读不到', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');
  await call(repo, 'signUpSchoolEvent', { eventId: event.eventId }, { actor: 'demo_muc_member' });

  const key = schoolEventSignupKey(event.eventId, 'demo_muc_member', { schoolId: 'muc', association: 'pkb' });
  const row = await repo.eventSignups.getById(key);
  assert.equal(row.schoolId, 'muc');
  assert.equal(row.association, 'pkb');
  assert.equal(row.status, SIGNUP_STATUS.SIGNED);

  // 换一个范围用同一个键读不到。
  const otherKey = schoolEventSignupKey(event.eventId, 'demo_muc_member', { schoolId: 'buaa', association: 'pkb' });
  assert.equal(await repo.eventSignups.getById(otherKey), null);
});

test('报名截止后不能再报；抽签冻结报名', async () => {
  const repo = fixture();
  const event = await publish(repo, 'r1');

  // 直接把赛事推进到进行中（开赛在后续切片接入，这里只验证报名端的闸门）。
  const stored = await repo.events.getById(event.eventId);
  await repo.events.set(event.eventId, { ...stored, status: EVENT_STATUS.ONGOING });
  const afterStart = await call(repo, 'signUpSchoolEvent', { eventId: event.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(afterStart.ok, false);
  assert.match(afterStart.message, /截止/);

  // 另一场：报名中但已抽签（draw 非空）——名单冻结。
  const drawn = await publish(repo, 'r2');
  const drawnDoc = await repo.events.getById(drawn.eventId);
  await repo.events.set(drawn.eventId, { ...drawnDoc, draw: { size: 2, slots: [] } });
  const afterDraw = await call(repo, 'signUpSchoolEvent', { eventId: drawn.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(afterDraw.ok, false);
  assert.match(afterDraw.message, /抽签/);
});
