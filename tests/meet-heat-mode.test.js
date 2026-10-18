/**
 * 分批口径（heatMode / heatCapacity）
 * ============================================================
 * 上一版把所有项目都按「每组 = 跑道数（6）」分批，导致两类明显错误：
 *   · 1500 米 30 人被拆成 5 组，而规则是 15 人左右一组；
 *   · 跳远 30 人被拆成「决赛 第 1–5 枪」，而田赛根本不分批、按顺序试跳。
 *
 * 这里把 46 个项目的分批规则按分类推导，并盯住三种模式各自的边界：
 *   lane     → 分道跑，一批 = 道数
 *   capacity → 一批 = 人数上限（长跑 15、次数 10、趣味 6）
 *   single   → 不分批（田赛、评分展示）
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../miniprogram/services/meet-event-catalog.js');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildMeetContext } = require('../miniprogram/services/meet-context.js');
const meetService = require('../miniprogram/services/meet-service.js');
const leadService = require('../miniprogram/services/meet-college-lead-service.js');
const reg = require('../miniprogram/services/meet-registration-service.js');
const advance = require('../miniprogram/services/meet-advance-service.js');
const { meetEventKey } = require('../miniprogram/utils/meet-scope.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../miniprogram/utils/school.js');

const SCHOOL = 'muc';
const T0 = new Date('2026-10-24T08:00:00Z');
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-10-25T23:59' };
const COLLEGES = ['c01', 'c02', 'c03', 'c04'];
const LEAD = { c01: 'u_l1', c02: 'u_l2', c03: 'u_l3', c04: 'u_l4' };

// 每个学院 8 名运动员：长跑要凑到 30 人才能验证「15 人一组」的组数
const STUDENTS = {};
for (const c of COLLEGES) {
  STUDENTS[c] = Array.from({ length: 8 }, (_, i) => `u_${c}_${i + 1}`);
}
const ALL_STUDENTS = COLLEGES.flatMap((c) => STUDENTS[c]);
const ids = ['u_admin', ...COLLEGES.map((c) => LEAD[c]), ...ALL_STUDENTS];
const users = ids.map((id) => ({
  _id: id, openId: `o_${id}`, nickName: id, realName: id,
  platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
}));
const colleges = COLLEGES.map((id, index) => ({
  _id: collegeKey(SCHOOL, id), schoolId: SCHOOL, collegeId: id, name: `${index + 1} 院`, status: 'active',
}));
const memberRows = [];
for (const c of COLLEGES) {
  memberRows.push([LEAD[c], c]);
  for (const s of STUDENTS[c]) memberRows.push([s, c]);
}
memberRows.push(['u_admin', 'c01']);
const members = memberRows.map(([userId, collegeId]) => ({
  _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId, status: 'active', gender: 'male',
}));
const roles = [
  { _id: schoolRoleKey('u_admin', SCHOOL), schoolId: SCHOOL, userId: 'u_admin', role: 'admin', status: 'active' },
];

const ctxOf = (repo, actorId, meetId = '', at = T0) => buildMeetContext({
  repo, actorId, scope: { schoolId: SCHOOL, meetId }, now: at,
});

async function makeWorld() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users, colleges, schoolMembers: members, schoolRoles: roles,
  });
  const created = await meetService.createSportsMeet({
    name: '第 59 届田径运动会', year: 2026, startDate: '2026-10-24', endDate: '2026-10-25',
  }, await ctxOf(repo, 'u_admin'));
  const meetId = created.data.meet.meetId;
  const admin = await ctxOf(repo, 'u_admin', meetId);
  for (const collegeId of COLLEGES) {
    await leadService.grantMeetCollegeLead({ collegeId, userId: LEAD[collegeId] }, admin);
  }

  /** 一批学生报名同一项目：先全员交意向，再由学院逐条提交并审核 */
  const enrollMany = async (eventKey, userIds, leadId) => {
    for (const userId of userIds) {
      const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
      assert.equal(interest.ok, true, interest.message);
    }
    for (const userId of userIds) {
      const submitted = await reg.submitMeetCollegeEntry(
        { eventKey, userIds: [userId] }, await ctxOf(repo, leadId, meetId));
      assert.equal(submitted.ok, true, submitted.message);
      const approved = await reg.reviewMeetEntry(
        { entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
      assert.equal(approved.ok, true, approved.message);
    }
  };
  /** 队伍项目：先全员交意向，再一次性提交整队（队伍人数必须一次给齐） */
  const enrollTeam = async (eventKey, userIds, leadId) => {
    for (const userId of userIds) {
      const interest = await reg.submitMeetInterest({ eventKey }, await ctxOf(repo, userId, meetId));
      assert.equal(interest.ok, true, interest.message);
    }
    const submitted = await reg.submitMeetCollegeEntry(
      { eventKey, userIds }, await ctxOf(repo, leadId, meetId));
    assert.equal(submitted.ok, true, submitted.message);
    const approved = await reg.reviewMeetEntry(
      { entryKey: submitted.data.entry._id, decision: 'approve' }, admin);
    assert.equal(approved.ok, true, approved.message);
  };
  return { repo, meetId, admin, enrollMany, enrollTeam };
}

// ---------- 元数据：46 个项目的分批规则 ----------

test('46 个项目的分批规则分布正确：lane 11 / capacity 20 / single 14 / 胜负 1', () => {
  const counts = {};
  for (const t of catalog.TEMPLATES) {
    const key = String(t.heatMode);
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.deepEqual(counts, { lane: 11, capacity: 20, single: 14, null: 1 });
});

test('关键项目的分批规则逐项钉死', () => {
  const cases = [
    // 分道跑：一批 = 道数
    ['sprint-100m', 'lane', 8],
    ['sprint-400m', 'lane', 8],
    ['hurdle-110m', 'lane', 8],
    ['relay-4x100', 'lane', 8],
    // 不分道长跑：15 人一组（Q1）
    ['middle-800m', 'capacity', 15],
    ['middle-1500m', 'capacity', 15],
    ['middle-5000m', 'capacity', 15],
    ['steeplechase', 'capacity', 15],
    // 田赛：不分批
    ['jump-high', 'single', 0],
    ['jump-long', 'single', 0],
    ['throw-shot', 'single', 0],
    // 评分展示：不分批
    ['show-gymnastics', 'single', 0],
    ['show-parade', 'single', 0],
    // 次数类：10 人一批
    ['reps-rope', 'capacity', 10],
    ['reps-basketball', 'capacity', 10],
    // 趣味：6 条记录一批；接力类只跑 2 队
    ['fun-three-leg', 'capacity', 6],
    ['fun-kangaroo', 'capacity', 6],
    ['fun-dribble', 'capacity', 2],
    ['fun-obstacle', 'capacity', 2],
    // 两队对向跑
    ['relay-shuttle', 'capacity', 2],
    // 团体跳绳
    ['team-rope', 'capacity', 6],
    // 拔河走签表，没有「每批几人」
    ['tug-of-war', null, 0],
  ];
  for (const [id, mode, capacity] of cases) {
    const t = catalog.getTemplate(id);
    assert.equal(t.heatMode, mode, `${id} 的 heatMode 应是 ${mode}`);
    assert.equal(t.heatCapacity, capacity, `${id} 的 heatCapacity 应是 ${capacity}`);
  }
});

// ---------- 长跑：30 人应分 2 组，而不是 5 组 ----------

test('1500 米 30 人按 15 人一组分成 2 组（不再是 6 人一组的 5 组）', async () => {
  const { meetId, admin, enrollMany } = await makeWorld();
  const eventKey = meetEventKey(meetId, 'middle-1500m', 'male');
  const configured = await meetService.configureMeetEvent(
    { templateId: 'middle-1500m', group: 'male', perCollegeLimit: 8 }, admin);
  assert.equal(configured.ok, true, configured.message);
  assert.equal(configured.data.event.heatMode, 'capacity');
  assert.equal(configured.data.event.heatCapacity, 15);

  await meetService.publishMeetRegistration(WINDOW, admin);
  // 8 + 8 + 7 + 7 = 30 人
  for (const [collegeId, count] of [['c01', 8], ['c02', 8], ['c03', 7], ['c04', 7]]) {
    await enrollMany(eventKey, STUDENTS[collegeId].slice(0, count), LEAD[collegeId]);
  }

  const drawn = await advance.drawMeetHeats({ eventKey, seed: 11 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.heatMode, 'capacity');
  assert.equal(drawn.data.heatCapacity, 15);
  assert.equal(drawn.data.heatCount, 2, '30 人 / 每组 15 人 = 2 组');
});

test('100 米 9 人按道数分成 2 组（8 道）', async () => {
  const { meetId, admin, enrollMany } = await makeWorld();
  const eventKey = meetEventKey(meetId, 'sprint-100m', 'male');
  await meetService.configureMeetEvent(
    { templateId: 'sprint-100m', group: 'male', perCollegeLimit: 3 }, admin);
  await meetService.publishMeetRegistration(WINDOW, admin);

  let left = 9;
  for (const collegeId of COLLEGES) {
    const take = Math.min(3, left);
    await enrollMany(eventKey, STUDENTS[collegeId].slice(0, take), LEAD[collegeId]);
    left -= take;
    if (left === 0) break;
  }

  const drawn = await advance.drawMeetHeats({ eventKey, seed: 5 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.heatMode, 'lane');
  assert.equal(drawn.data.heatCapacity, 8);
  assert.equal(drawn.data.heatCount, 2, '9 人 / 8 道 = 2 组');
});

// ---------- 田赛：锁死单场（Q3） ----------

test('跳远不允许分组：直接拒绝并说明单场进行', async () => {
  const { meetId, admin, enrollMany } = await makeWorld();
  const eventKey = meetEventKey(meetId, 'jump-long', 'male');
  const configured = await meetService.configureMeetEvent(
    { templateId: 'jump-long', group: 'male', perCollegeLimit: 3 }, admin);
  assert.equal(configured.ok, true, configured.message);
  assert.equal(configured.data.event.heatMode, 'single');

  await meetService.publishMeetRegistration(WINDOW, admin);
  await enrollMany(eventKey, STUDENTS.c01.slice(0, 3), LEAD.c01);

  const drawn = await advance.drawMeetHeats({ eventKey }, admin);
  assert.equal(drawn.ok, false);
  assert.match(drawn.message, /不需要分组/);
});

test('跳远不接受「预赛+决赛」：田赛只有一个场次', async () => {
  const { meetId, admin } = await makeWorld();
  const eventKey = meetEventKey(meetId, 'jump-long', 'male');
  await meetService.configureMeetEvent({ templateId: 'jump-long', group: 'male' }, admin);

  const rejected = await meetService.setMeetEventProcedure(
    { eventKey, rounds: 'heat_final' }, admin);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /一个场次内按顺序进行/);
});

// ---------- 迎面接力：一批只能 2 队 ----------

test('迎面接力 4 支队伍按每批 2 队分成 2 组', async () => {
  const { meetId, admin, enrollTeam } = await makeWorld();
  const eventKey = meetEventKey(meetId, 'relay-shuttle', 'mixed');
  const configured = await meetService.configureMeetEvent(
    { templateId: 'relay-shuttle', group: 'mixed', members: 2, perCollegeLimit: 1 }, admin);
  assert.equal(configured.ok, true, configured.message);
  assert.equal(configured.data.event.heatCapacity, 2);

  await meetService.publishMeetRegistration(WINDOW, admin);
  for (const collegeId of COLLEGES) {
    await enrollTeam(eventKey, STUDENTS[collegeId].slice(0, 2), LEAD[collegeId]);
  }

  const drawn = await advance.drawMeetHeats({ eventKey, seed: 3 }, admin);
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.data.heatCount, 2, '4 队 / 每批 2 队 = 2 组');
});

// ---------- 每组人数可在编排阶段改 ----------

test('长跑的每组上限可以逐项目改，改完影响组数', async () => {
  const { meetId, admin } = await makeWorld();
  const eventKey = meetEventKey(meetId, 'middle-1500m', 'male');
  await meetService.configureMeetEvent({ templateId: 'middle-1500m', group: 'male' }, admin);

  const narrowed = await meetService.setMeetEventProcedure(
    { eventKey, rounds: 'final', heatCapacity: 10 }, admin);
  assert.equal(narrowed.ok, true, narrowed.message);
  assert.equal(narrowed.data.event.heatCapacity, 10);
  // 旧字段仍同步：非分道项目没有「道数」
  assert.equal(narrowed.data.event.laneCount, 0);

  const tooBig = await meetService.setMeetEventProcedure(
    { eventKey, rounds: 'final', heatCapacity: 51 }, admin);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.message, /2–50/);
});
