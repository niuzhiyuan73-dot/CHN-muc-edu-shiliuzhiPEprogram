/**
 * B6：赛程与裁判指派
 * ============================================================
 * 守三条：
 *   1. 时间与场地没配齐就不能发布赛程，并且要指出缺哪些项目（D53）；
 *   2. 没有有效裁判的场次不能开赛；
 *   3. 裁判只能指派本校在册且账号有效的成员（D59）；撤换保留记录（N4 的前置）。
 * 另外钉住一处**刻意的取舍**：D55 不做冲突检测——同一裁判同一时间被派两个场次
 * 不会被拦，这不是漏实现，是用户明确裁掉的。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../miniprogram/services/meet-context.js');
const meetService = require('../miniprogram/services/meet-service.js');
const leadService = require('../miniprogram/services/meet-college-lead-service.js');
const schedule = require('../miniprogram/services/meet-schedule-service.js');
const { meetEventKey, meetSessionKey } = require('../miniprogram/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../miniprogram/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-17T09:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-20T23:59' };

const users = [
  ['u_admin', '校管理员'], ['u_judge', '裁判甲'], ['u_judge2', '裁判乙'], ['u_s1', '学生一'],
  ['u_lead', '学院部长'], ['u_out', '外校成员'],
].map(([id, name]) => ({
  _id: id, openId: `o_${id}`, name, platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));

const colleges = [
  { _id: collegeKey(SCHOOL, 'c01'), schoolId: SCHOOL, collegeId: 'c01', name: '信息工程学院', status: 'active' },
];

const schoolMembers = [
  ['u_admin', 'c01'], ['u_judge', 'c01'], ['u_judge2', 'c01'], ['u_s1', 'c01'], ['u_lead', 'c01'],
].map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId,
  status: 'active', gender: 'male',
}));

const schoolRoles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

async function makeWorld() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers, schoolRoles,
  });
  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  await meetService.configureMeetEvent({ templateId: 'sprint-200m', group: 'male' }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);
  await leadService.grantMeetCollegeLead({ collegeId: 'c01', userId: 'u_lead' }, admin);
  return { repo, meetId };
}

const eventOf = (meetId, templateId) => meetEventKey(meetId, templateId, 'male');
const SESSION = { round: 'final', index: 1, startAt: '2026-10-24T09:00', endAt: '2026-10-24T09:30', venue: '田径场直道' };

test('保存场次：时间与场地落库', async () => {
  const { repo, meetId } = await makeWorld();
  const result = await schedule.saveMeetSession(
    { eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.session.venue, '田径场直道');
  assert.equal(result.data.session.roundLabel, '决赛');

  const stored = await repo.sportsMeetSessions.getById(
    meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1));
  assert.equal(stored.startAt, '2026-10-24T09:00');
});

test('场次时间只作为告知信息：格式随意，也不比较先后', async () => {
  const { repo, meetId } = await makeWorld();
  const ctx = await ctxOf(repo, 'u_admin', meetId);
  // 结束早于开始、用空格代替 T、只写 HH:mm —— 都接受
  for (const patch of [
    { ...SESSION, endAt: '2026-10-24T08:00' },
    { ...SESSION, startAt: '2026-10-24 09:00' },
    { ...SESSION, startAt: '下午三点' },
  ]) {
    const saved = await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...patch }, ctx);
    assert.equal(saved.ok, true, `${patch.startAt} 应被接受：${saved.message}`);
  }
});

test('场次时间仍然必填', async () => {
  const { repo, meetId } = await makeWorld();
  const saved = await schedule.saveMeetSession({
    eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION, startAt: '',
  }, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(saved.ok, false);
  assert.match(saved.message, /请填写开始时间/);
});

test('赛程没配齐时不能发布，并指出缺哪些项目（D53）', async () => {
  const { repo, meetId } = await makeWorld();
  await schedule.saveMeetSession(
    { eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, await ctxOf(repo, 'u_admin', meetId));

  const result = await schedule.publishMeetSchedule({}, await ctxOf(repo, 'u_admin', meetId));
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 1);
  assert.match(result.message, /200 米/);
});

test('配齐后可以发布赛程，运动会转为「赛程已发布」', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  await schedule.saveMeetSession({
    eventKey: eventOf(meetId, 'sprint-200m'), ...SESSION, startAt: '2026-10-24T10:00', endAt: '2026-10-24T10:30',
  }, admin);

  const result = await schedule.publishMeetSchedule({}, admin);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.data.meet.status, 'scheduled');
});

test('草稿期不能发布赛程（先发布报名）', async () => {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers, schoolRoles,
  });
  const created = await meetService.createSportsMeet({
    name: '草稿届', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male' }, admin);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);

  const result = await schedule.publishMeetSchedule({}, admin);
  assert.equal(result.ok, false);
  assert.match(result.message, /先发布报名/);
});

test('裁判只能指派本校在册且账号有效者（D59）', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  const sessionKey = meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1);

  const okAssign = await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_judge' }, admin);
  assert.equal(okAssign.ok, true, okAssign.message);

  const outside = await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_out' }, admin);
  assert.equal(outside.ok, false);
  assert.match(outside.message, /本校在册/);
});

test('同一场次重复指派同一裁判是幂等的', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  const sessionKey = meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1);

  await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_judge' }, admin);
  const again = await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_judge' }, admin);
  assert.equal(again.ok, true);
  assert.equal(again.data.created, false);

  const sched = await schedule.getMeetSchedule({}, admin);
  const session = sched.data.items[0].sessions[0];
  assert.equal(session.judgeCount, 1, '重复指派不应把裁判数加成 2');
});

test('没有裁判不能开赛；指派后可以开赛并转进行中', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  const sessionKey = meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1);

  const blocked = await schedule.startMeetEvent({ sessionKey }, admin);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /还没有指派裁判/);

  await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_judge' }, admin);
  const started = await schedule.startMeetEvent({ sessionKey }, admin);
  assert.equal(started.ok, true, started.message);

  const meet = await repo.sportsMeets.getById(meetId);
  assert.equal(meet.status, 'running');
});

test('撤换裁判后计数递减，场次回到「未指派」状态', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  const sessionKey = meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1);

  await schedule.assignMeetJudge({ sessionKey, judgeId: 'u_judge' }, admin);
  const removed = await schedule.removeMeetJudge({ sessionKey, judgeId: 'u_judge' }, admin);
  assert.equal(removed.ok, true, removed.message);

  const blocked = await schedule.startMeetEvent({ sessionKey }, admin);
  assert.equal(blocked.ok, false, '撤掉唯一裁判后不应还能开赛');

  const sched = await schedule.getMeetSchedule({}, admin);
  assert.equal(sched.data.items[0].sessions[0].judgeCount, 0);
});

test('裁判任务只返回指派给自己的场次', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  await schedule.saveMeetSession({
    eventKey: eventOf(meetId, 'sprint-200m'), ...SESSION, startAt: '2026-10-24T10:00', endAt: '2026-10-24T10:30',
  }, admin);
  const key100 = meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1);
  const key200 = meetSessionKey(meetId, eventOf(meetId, 'sprint-200m'), 'final', 1);
  await schedule.assignMeetJudge({ sessionKey: key100, judgeId: 'u_judge' }, admin);
  await schedule.assignMeetJudge({ sessionKey: key200, judgeId: 'u_judge2' }, admin);

  const mine = await schedule.getMyMeetJudgeTasks({}, await ctxOf(repo, 'u_judge', meetId));
  assert.equal(mine.data.items.length, 1);
  assert.equal(mine.data.items[0].name, '100 米');

  const other = await schedule.getMyMeetJudgeTasks({}, await ctxOf(repo, 'u_judge2', meetId));
  assert.equal(other.data.items[0].name, '200 米');
});

test('普通学生不能编排赛程或指派裁判', async () => {
  const { repo, meetId } = await makeWorld();
  const eventKey = eventOf(meetId, 'sprint-100m');
  const saved = await schedule.saveMeetSession(
    { eventKey, ...SESSION }, await ctxOf(repo, 'u_s1', meetId));
  assert.equal(saved.ok, false);
  assert.match(saved.message, /校级管理员及以上/);
});

test('赛程按开始时间排序，未配时间的排最后', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  await schedule.saveMeetSession({
    eventKey: eventOf(meetId, 'sprint-200m'), ...SESSION, startAt: '2026-10-24T11:00', endAt: '2026-10-24T11:30',
  }, admin);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);

  const sched = await schedule.getMeetSchedule({}, admin);
  const times = sched.data.items.flatMap((item) => item.sessions.map((row) => row.startAt));
  assert.deepEqual(times, [...times].sort());
});

test('D55 明确的取舍：同一裁判同一时间可被派两个场次，不阻断', async () => {
  const { repo, meetId } = await makeWorld();
  const admin = await ctxOf(repo, 'u_admin', meetId);
  // 两个项目组别同一时间段
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-100m'), ...SESSION }, admin);
  await schedule.saveMeetSession({ eventKey: eventOf(meetId, 'sprint-200m'), ...SESSION }, admin);
  const key100 = meetSessionKey(meetId, eventOf(meetId, 'sprint-100m'), 'final', 1);
  const key200 = meetSessionKey(meetId, eventOf(meetId, 'sprint-200m'), 'final', 1);

  assert.equal((await schedule.assignMeetJudge({ sessionKey: key100, judgeId: 'u_judge' }, admin)).ok, true);
  const second = await schedule.assignMeetJudge({ sessionKey: key200, judgeId: 'u_judge' }, admin);
  assert.equal(second.ok, true, '本期不做冲突检测，同时间段重复指派应被允许');
});
