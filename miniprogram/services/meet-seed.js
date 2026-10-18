/**
 * 运动会演示种子（B9）
 * ============================================================
 * 一届「第 59 届田径运动会（演示）」的完整生命周期：
 *   建届 → 任命学院部长 → 配项目 → 发布报名 → 意向/提交/审核 →
 *   定赛制抽签 → 排期派裁判 → 发布赛程 → 开赛 → 录分 → 发布 →
 *   更正一次 → 学院总榜与个人荣誉；另建一届草稿并删除一次。
 *
 * 【为什么全部由真实服务驱动，而不是手写业务文档】
 * 手写的签表、名次、积分迟早与服务端算法分叉，而演示数据一旦分叉就会
 * 误导人——页面显示的名次和库里算出来的不是一套。这里每一次写入都走
 * 页面同一条调用链：报名走「意向 → 部长提交 → 管理员审核」，成绩走
 * 「三裁判去极值平均」，积分走发布事务累加。种子层只负责「演哪些场景」。
 *
 * 【覆盖的演示场景】（施工分批计划 B9 演示数据最低覆盖 + 预赛晋级）
 *   · 学院不报项目——五院只报部分项目（c04 不报任何个人项，c05 只报团体操）；
 *   · 未报满——100 米每院上限 3，一院只报 2；
 *   · 团体与接力——4×100 接力四院各一队；
 *   · 三人板鞋固定 3 人——同场演示「2 人组」被服务端拒绝；
 *   · 三裁判平均——广播体操 88/90/92 去极值平均为 90（展示类不计分）；
 *   · 并列名次——100 米两院同成绩并列第 3（更正前）；
 *   · 人数不足——800 米只报 2 人，单场进行；
 *   · 无成绩——800 米一名选手记无成绩，不得分、不占名次、无荣誉；
 *   · 学院总榜 / 个人荣誉——发布后按名次分表累加，零分学院也在榜上（D82）；
 *   · 更正一次——100 米计时更正后重发，总分替换不翻倍（D87）；
 *   · 删除一次——另建一届草稿并删除，列表不再可见；
 *   · 预赛晋级——400 米 9 人分 2 组预赛，每组前 2 进决赛（D47）。
 * ============================================================
 */

const { createSchoolMemoryRepo } = require('./school-memory-repo.js');
const { buildMeetContext } = require('./meet-context.js');
const meetService = require('./meet-service.js');
const leadService = require('./meet-college-lead-service.js');
const reg = require('./meet-registration-service.js');
const schedule = require('./meet-schedule-service.js');
const score = require('./meet-score-service.js');
const advance = require('./meet-advance-service.js');
const standing = require('./meet-standing-service.js');
const { collegeKey, schoolMemberKey, schoolRoleKey } = require('../utils/school.js');
const {
  MEET_COLLECTIONS, meetSessionKey,
} = require('../utils/meet-scope.js');
const { COLLEGES } = require('../utils/constants.js');

const SCHOOL = 'muc'; // 中央民族大学，与学校演示种子同一所学校
const MEET_NAME = '第 59 届田径运动会（演示）';
const DRAFT_NAME = '第 58 届田径运动会（演示草稿）';
// 两届的创建时间必须错开：meetId 由「学校 + 创建秒数」生成，同一秒建两届
// 会拿到同一个编号（createSportsMeet 对同人同秒是幂等的，会把草稿当成主届）。
const T0 = new Date('2026-10-24T08:00:00Z'); // 草稿届
const T1 = new Date('2026-10-24T08:10:00Z'); // 主届（之后全程用它）
const WINDOW = { openAt: '2026-10-01T00:00', closeAt: '2026-12-31T23:59' };

const JUDGES = ['m_j1', 'm_j2', 'm_j3'];
const JUDGE_NAMES = { m_j1: '张裁判', m_j2: '李裁判', m_j3: '王裁判' };
const COLLEGE_IDS = ['c01', 'c02', 'c03', 'c04', 'c05'];
const LEAD_OF = Object.fromEntries(COLLEGE_IDS.map((id) => [id, `m_lead_${id}`]));
const STUDENTS = Object.fromEntries(COLLEGE_IDS.map((id) => [
  id,
  id === 'c05' ? ['m_c05_1'] : Array.from({ length: 6 }, (_, i) => `m_${id}_${i + 1}`),
]));

/** 每院 6 名学生（c05 只 1 名）+ 3 名裁判 + 5 名部长 + 1 名校管理员。 */
function demoUsers() {
  const users = [{
    _id: 'm_admin', openId: 'mock_openid_m_admin', nickName: '演示校管', realName: '演示校管',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
  }];
  for (const judgeId of JUDGES) {
    users.push({
      _id: judgeId, openId: `mock_openid_${judgeId}`, nickName: JUDGE_NAMES[judgeId],
      realName: JUDGE_NAMES[judgeId],
      platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
    });
  }
  for (const collegeId of COLLEGE_IDS) {
    users.push({
      _id: LEAD_OF[collegeId], openId: `mock_openid_m_lead_${collegeId}`,
      nickName: `${COLLEGES[COLLEGE_IDS.indexOf(collegeId)]}部长（演示）`,
      realName: `${COLLEGES[COLLEGE_IDS.indexOf(collegeId)]}部长（演示）`,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
    });
    for (const userId of STUDENTS[collegeId]) {
      users.push({
        _id: userId, openId: `mock_openid_${userId}`,
        nickName: `${COLLEGES[COLLEGE_IDS.indexOf(collegeId)]}${userId.slice(-1)}号（演示）`,
        realName: `${COLLEGES[COLLEGE_IDS.indexOf(collegeId)]}${userId.slice(-1)}号（演示）`,
        platformStatus: 'active', platformRole: 'member', primarySchoolId: SCHOOL,
      });
    }
  }
  return users;
}

/** 学籍：全员在册，性别统一男（演示项目都开男子组或混合组）。 */
function demoMembers() {
  const rows = [['m_admin', 'c01'], ...JUDGES.map((id) => [id, 'c01'])];
  for (const collegeId of COLLEGE_IDS) {
    rows.push([LEAD_OF[collegeId], collegeId]);
    for (const userId of STUDENTS[collegeId]) rows.push([userId, collegeId]);
  }
  return rows.map(([userId, collegeId]) => ({
    _id: schoolMemberKey(userId, SCHOOL), schoolId: SCHOOL, userId, collegeId,
    status: 'active', gender: 'male',
  }));
}

/**
 * 报名计划：逐项目组别列出「每个学院报几条名单」。
 * 单人项目一条名单一个人；团体/队伍一条名单一整队。
 */
const PLAN = [
  // 100 米：c01 报 2 条（上限 3，未报满）；c04、c05 不报个人项
  { templateId: 'sprint-100m', group: 'male', perCollegeLimit: 3, colleges: { c01: [['m_c01_1'], ['m_c01_2']], c02: [['m_c02_1']], c03: [['m_c03_1']] } },
  // 800 米：只报 2 人——人数不足，单场进行
  { templateId: 'middle-800m', group: 'male', colleges: { c01: [['m_c01_3']], c02: [['m_c02_2']] } },
  // 400 米：9 条报名，8 道 → 预赛分 2 组，每组前 2 进决赛
  { templateId: 'sprint-400m', group: 'male', perCollegeLimit: 3, colleges: {
    c01: [['m_c01_1'], ['m_c01_2'], ['m_c01_3']],
    c02: [['m_c02_1'], ['m_c02_2'], ['m_c02_3']],
    c03: [['m_c03_1'], ['m_c03_2']],
    c04: [['m_c04_1']],
  } },
  // 4×100 接力：四院各一队（c05 不报）
  { templateId: 'relay-4x100', group: 'male', members: 4, perCollegeLimit: 1, colleges: {
    c01: [['m_c01_1', 'm_c01_2', 'm_c01_3', 'm_c01_4']],
    c02: [['m_c02_1', 'm_c02_2', 'm_c02_3', 'm_c02_4']],
    c03: [['m_c03_1', 'm_c03_2', 'm_c03_3', 'm_c03_4']],
    c04: [['m_c04_1', 'm_c04_2', 'm_c04_3', 'm_c04_4']],
  } },
  // 三人板鞋：固定 3 人；另演示 c03 交 2 人被拒
  { templateId: 'fun-clogs', group: 'mixed', colleges: {
    c01: [['m_c01_4', 'm_c01_5', 'm_c01_6']],
    c02: [['m_c02_4', 'm_c02_5', 'm_c02_6']],
  } },
  // 广播体操：展示类不计分；人数不限（members=0），c05 只上场 1 人也合法
  { templateId: 'show-gymnastics', group: 'mixed', members: 0, perCollegeLimit: 1, colleges: {
    c01: [['m_c01_1', 'm_c01_2', 'm_c01_3', 'm_c01_4']],
    c02: [['m_c02_1', 'm_c02_2', 'm_c02_3', 'm_c02_4']],
    c03: [['m_c03_1', 'm_c03_2', 'm_c03_3', 'm_c03_4']],
    c04: [['m_c04_1', 'm_c04_2', 'm_c04_3', 'm_c04_4']],
    c05: [['m_c05_1']],
  } },
];

/** 各项目成绩（按学院、按名单顺序对齐 PLAN）。裁判三人给同一个值——除展示类。 */
const VALUES = {
  'sprint-100m': { c01: ['12.10', '12.20'], c02: ['12.30'], c03: ['12.30'] }, // c02/c03 并列
  'middle-800m': { c01: ['135.30'], c02: ['139.80'] }, // c02 记无成绩
  'relay-4x100': { c01: ['45.10'], c02: ['45.20'], c03: ['45.30'], c04: ['45.40'] },
  'fun-clogs': { c01: ['32.10'], c02: ['32.50'] },
  // 广播体操：三名裁判分别给 88/90/92，去极值平均为 90
  'show-gymnastics': { perJudge: ['88', '90', '92'] },
  'sprint-400m': { c01: ['52.10', '52.40', '53.00'], c02: ['52.20', '52.60', '53.10'], c03: ['52.30', '53.20'], c04: ['53.30'] },
};

/** 场次排期（项目 → 各场次的时间与场地，顺序即 index）。 */
const SCHEDULE = {
  'sprint-100m': [['2026-10-24 09:00', '田径场']],
  'middle-800m': [['2026-10-24 09:30', '田径场']],
  'sprint-400m': [['2026-10-24 10:00', '田径场'], ['2026-10-24 10:20', '田径场'], ['2026-10-24 15:00', '田径场']],
  'relay-4x100': [['2026-10-24 11:00', '田径场']],
  'fun-clogs': [['2026-10-24 11:30', '田径场']],
  'show-gymnastics': [['2026-10-24 14:00', '体育馆']],
};
/** 400 米三个场次分别是什么轮次（抽签已建好场次，这里只补时间场地）。 */
const R400_ROUNDS = ['heat', 'heat', 'final'];

const DUMP_KEYS = ['users', 'schoolMembers', 'schoolRoles', 'sportsMeetCollegeLeads', ...MEET_COLLECTIONS];

/** 调一次服务，失败就抛——演示种子宁可炸也不能留半届。 */
async function call(fn, payload, ctx, what) {
  const result = await fn(payload, ctx);
  if (!result.ok) throw new Error(`演示种子：${what}失败——${result.message}`);
  return result.data;
}

/**
 * 跑完整届演示。
 *
 * @returns {Promise<{repo:Object, world:Object}>} repo 为内含全部演示记录的内存
 * 仓储（测试与 mock 装载都用它）；world 是给断言用的结构化摘要。
 */
async function runMeetDemo() {
  const repo = createSchoolMemoryRepo({
    schools: [{ _id: SCHOOL, schoolId: SCHOOL, name: '中央民族大学', status: 'active' }],
    users: demoUsers(),
    // 学院目录用真实的（与 mock 的民大种子同一批）：sportsMeetColleges 的
    // 名称快照因此与真实目录一致，不会出现「榜单显示一院、目录显示全称」。
    colleges: COLLEGE_IDS.map((id, index) => ({
      _id: collegeKey(SCHOOL, id), schoolId: SCHOOL, collegeId: id,
      name: COLLEGES[index], status: 'active',
    })),
    schoolMembers: demoMembers(),
    schoolRoles: [{
      _id: schoolRoleKey('m_admin', SCHOOL), schoolId: SCHOOL, userId: 'm_admin',
      role: 'admin', status: 'active',
    }],
  });
  const ctxOf = (actorId, meetId = '', now = T1) => buildMeetContext({
    repo, actorId, scope: { schoolId: SCHOOL, meetId }, now,
  });

  // ── 1. 删除一次的素材：先建一届草稿，流程走完再删 ────────────────────
  const draft = await call(meetService.createSportsMeet,
    { name: DRAFT_NAME, year: 2025, startDate: '2025-10-24', endDate: '2025-10-25' },
    await ctxOf('m_admin', '', T0), '创建草稿届');
  const draftMeetId = draft.meet.meetId;

  // ── 2. 主届：建届 + 任命五院部长 ────────────────────────────────────
  const created = await call(meetService.createSportsMeet,
    { name: MEET_NAME, year: 2026, startDate: '2026-10-24', endDate: '2026-10-25', location: '田径场' },
    await ctxOf('m_admin'), '创建主届');
  const meetId = created.meet.meetId;
  const admin = await ctxOf('m_admin', meetId);
  for (const collegeId of COLLEGE_IDS) {
    await call(leadService.grantMeetCollegeLead,
      { collegeId, userId: LEAD_OF[collegeId] }, admin, `任命${collegeId}部长`);
  }

  // ── 3. 配项目（草稿期；赛制留到报名截止后） ─────────────────────────
  const eventKeyOf = {};
  for (const item of PLAN) {
    const configured = await call(meetService.configureMeetEvent, {
      templateId: item.templateId, group: item.group,
      ...(item.members === undefined ? {} : { members: item.members }),
      ...(item.perCollegeLimit === undefined ? {} : { perCollegeLimit: item.perCollegeLimit }),
    }, admin, `配置${item.templateId}`);
    eventKeyOf[item.templateId] = configured.event.eventKey;
  }

  // ── 4. 发布报名 ─────────────────────────────────────────────────────
  await call(meetService.publishMeetRegistration, WINDOW, admin, '发布报名');

  // ── 5. 报名主链：意向 → 部长提交 → 管理员审核 ───────────────────────
  // D25：本院一旦提交正式名单，该项目的意向入口就关了——所以先把**所有**
  // 意向交完，再逐条提交名单（同一项目报第二条时，第一个人的意向已经
  // 因为「已提交正式名单」而交不进去了）。
  for (const item of PLAN) {
    const eventKey = eventKeyOf[item.templateId];
    for (const teams of Object.values(item.colleges)) {
      for (const userIds of teams) {
        for (const userId of userIds) {
          await call(reg.submitMeetInterest, { eventKey }, await ctxOf(userId, meetId), `${userId} 交意向`);
        }
      }
    }
  }
  /** 一条名单：以部长身份提交，管理员审核通过 */
  async function enroll(templateId, collegeId, userIds) {
    const submitted = await call(reg.submitMeetCollegeEntry,
      { eventKey: eventKeyOf[templateId], userIds },
      await ctxOf(LEAD_OF[collegeId], meetId), `${collegeId} 提交${templateId}`);
    await call(reg.reviewMeetEntry,
      { entryKey: submitted.entry._id, decision: 'approve' }, admin, '审核名单');
    return submitted.entry._id;
  }

  const entryKeys = {}; // templateId → collegeId → [entryKey]
  for (const item of PLAN) {
    entryKeys[item.templateId] = {};
    for (const [collegeId, teams] of Object.entries(item.colleges)) {
      entryKeys[item.templateId][collegeId] = [];
      for (const userIds of teams) {
        entryKeys[item.templateId][collegeId].push(await enroll(item.templateId, collegeId, userIds));
      }
    }
  }

  // 三人板鞋固定 3 人：c03 交一条 2 人名单，必须被服务端拒绝（D39）
  const clogsEventKey = eventKeyOf['fun-clogs'];
  for (const userId of ['m_c03_1', 'm_c03_2']) {
    await call(reg.submitMeetInterest, { eventKey: clogsEventKey }, await ctxOf(userId, meetId), '板鞋意向');
  }
  const clogsRejected = await reg.submitMeetCollegeEntry(
    { eventKey: clogsEventKey, userIds: ['m_c03_1', 'm_c03_2'] },
    await ctxOf(LEAD_OF.c03, meetId));
  // c05 只有一条意向、从未被选入正式名单——「只要报名了一个人就算参与」（D82）：
  // 学院范围行在交意向时已随 c05 的唯一一名学生落下，无需额外动作。

  // ── 6. 报名截止后：400 米定「预赛+决赛、每组前 2 晋级」并抽签 ────────
  const e400 = eventKeyOf['sprint-400m'];
  await call(meetService.setMeetEventProcedure,
    { eventKey: e400, rounds: 'heat_final', advance: { mode: 'per_heat', count: 2 } },
    admin, '设置 400 米赛制');
  const draw = await call(advance.drawMeetHeats, { eventKey: e400, seed: 20261024 }, admin, '400 米抽签');
  const heatKeys = draw.heats.map((heat) => meetSessionKey(meetId, e400, 'heat', heat.index));
  const final400Key = meetSessionKey(meetId, e400, 'final', 1);

  // 其余数值项目按「一批 = 上限」抽签：分道项目顺带落下道次（B9e）。
  // 展示类（广播体操）单场进行，不抽签。
  for (const templateId of ['sprint-100m', 'middle-800m', 'relay-4x100', 'fun-clogs']) {
    await call(advance.drawMeetHeats,
      { eventKey: eventKeyOf[templateId], heatCount: 1, seed: 20261024 },
      admin, `${templateId} 抽签`);
  }
  const sprintSessionKey = meetSessionKey(meetId, eventKeyOf['sprint-100m'], 'final', 1);

  // ── 7. 排期：每个场次配齐时间与场地（抽签已建好场次，这里只补排期） ──
  // 场次下标按「轮次内序号」算，不能拿计划数组的下标顶替：400 米第三个槽位
  // 是决赛，但它是该轮次的第 1 场——写成 index:3 会另建一个「决赛第 3 场」，
  // 抽签建好的决赛场次永远配不齐时间，发布赛程必然缺项。
  for (const [templateId, slots] of Object.entries(SCHEDULE)) {
    const eventKey = eventKeyOf[templateId];
    const rounds = templateId === 'sprint-400m' ? R400_ROUNDS : ['final'];
    const nthOf = new Map();
    for (let index = 0; index < slots.length; index += 1) {
      const round = rounds[index] || 'final';
      const nth = (nthOf.get(round) || 0) + 1;
      nthOf.set(round, nth);
      const [startAt, venue] = slots[index];
      await call(schedule.saveMeetSession,
        { eventKey, round, index: nth, startAt, venue }, admin, `${templateId} 排期`);
    }
  }

  // ── 8. 批量派裁判：一次选 3 人，按「整个项目」指派 ───────────────────
  for (const templateId of Object.keys(SCHEDULE)) {
    await call(schedule.assignMeetJudges,
      { judgeIds: JUDGES, eventKey: eventKeyOf[templateId] }, admin, `${templateId} 派裁判`);
  }
  await call(schedule.publishMeetSchedule, {}, admin, '发布赛程');

  // ── 9. 逐场次开赛 ───────────────────────────────────────────────────
  const sessions = await repo.sportsMeetSessions.list();
  for (const session of sessions) {
    if (session.meetId !== meetId) continue;
    await call(schedule.startMeetEvent, { sessionKey: session._id }, admin, `开赛 ${session._id}`);
  }

  // ── 10. 录分：管理员代录，三名裁判逐个提交 ──────────────────────────
  /** 给一个场次里的所有参赛记录打分（perJudge 时三名裁判各给各的值） */
  async function scoreSession(sessionKey, valueOf) {
    const view = await call(score.getMeetSessionScores, { sessionKey }, admin, '读取录分表');
    for (const item of view.items) {
      for (const judgeId of JUDGES) {
        const rawText = valueOf(item.entryKey, judgeId);
        await call(score.saveMeetJudgeScore,
          { sessionKey, entryKey: item.entryKey, judgeId, rawText }, admin, '保存成绩');
        await call(score.submitMeetJudgeScore,
          { sessionKey, entryKey: item.entryKey, judgeId }, admin, '提交成绩');
      }
    }
  }

  /** 按项目成绩表造「entryKey → 原始成绩」的取值器 */
  const valueGetter = (templateId) => {
    const byEntry = {};
    for (const [collegeId, values] of Object.entries(VALUES[templateId])) {
      if (!Array.isArray(values)) continue;
      (entryKeys[templateId][collegeId] || []).forEach((key, index) => { byEntry[key] = values[index]; });
    }
    return (entryKey) => byEntry[entryKey];
  };

  for (const templateId of ['sprint-100m', 'middle-800m', 'relay-4x100', 'fun-clogs', 'show-gymnastics']) {
    const spec = VALUES[templateId];
    const getter = valueGetter(templateId);
    for (const session of sessions.filter((doc) => doc.eventKey === eventKeyOf[templateId])) {
      await scoreSession(session._id, (entryKey, judgeId) => (
        Array.isArray(spec.perJudge) ? spec.perJudge[JUDGES.indexOf(judgeId)] : getter(entryKey)
      ));
    }
  }

  // 400 米预赛两组
  const getter400 = valueGetter('sprint-400m');
  for (const heatKey of heatKeys) {
    await scoreSession(heatKey, (entryKey) => getter400(entryKey));
  }

  // ── 11. 发布：先两个预赛组，再晋级，再决赛 ──────────────────────────
  const publications = {};
  publications['sprint-100m'] = await call(score.publishMeetResults,
    { eventKey: eventKeyOf['sprint-100m'] }, admin, '发布 100 米');
  // 更正前的 100 米成绩快照：c02 与 c03 同成绩并列第 3（竞赛排名 1,2,3,3）
  const sprintBeforeCorrection = publications['sprint-100m'].publication.rows
    .map((row) => ({ collegeId: row.collegeId, rank: row.rank, points: row.points, status: row.status }));
  publications['middle-800m'] = await call(score.publishMeetResults,
    { eventKey: eventKeyOf['middle-800m'], voidEntryKeys: [entryKeys['middle-800m'].c02[0]] },
    admin, '发布 800 米');
  publications['relay-4x100'] = await call(score.publishMeetResults,
    { eventKey: eventKeyOf['relay-4x100'] }, admin, '发布接力');
  publications['fun-clogs'] = await call(score.publishMeetResults,
    { eventKey: eventKeyOf['fun-clogs'] }, admin, '发布板鞋');
  publications['show-gymnastics'] = await call(score.publishMeetResults,
    { eventKey: eventKeyOf['show-gymnastics'] }, admin, '发布体操');

  for (const heatKey of heatKeys) {
    publications[`400 米预赛 ${heatKey}`] = await call(score.publishMeetResults,
      { eventKey: e400, sessionKey: heatKey }, admin, '发布 400 米预赛');
  }
  await call(advance.advanceMeetEvent, { eventKey: e400 }, admin, '400 米晋级');
  const finalists = (await repo.sportsMeetSessions.getById(final400Key)).entryKeys;
  // 决赛成绩按预赛名次顺序重排：预赛最快的决赛也最快（现场常见形态）
  const finalTimes = ['51.90', '52.10', '52.30', '52.50'];
  const finalValue = new Map(
    [...finalists]
      .sort((a, b) => Number(getter400(a)) - Number(getter400(b)))
      .map((key, index) => [key, finalTimes[index] || '53.00']),
  );
  await scoreSession(final400Key, (entryKey) => finalValue.get(entryKey));
  publications['sprint-400m'] = await call(score.publishMeetResults,
    { eventKey: e400, sessionKey: final400Key }, admin, '发布 400 米决赛');

  // ── 12. 更正一次：100 米第二名实际是 12.00，重发替换不翻倍 ───────────
  const correctedEntry = entryKeys['sprint-100m'].c02[0];
  for (const judgeId of JUDGES) {
    await call(score.saveMeetJudgeScore,
      { sessionKey: sprintSessionKey, entryKey: correctedEntry, judgeId, rawText: '12.00', allowResubmit: true },
      admin, '更正成绩');
    await call(score.submitMeetJudgeScore,
      { sessionKey: sprintSessionKey, entryKey: correctedEntry, judgeId }, admin, '提交更正');
  }
  publications['sprint-100m'] = await call(score.publishMeetResults,
    { eventKey: eventKeyOf['sprint-100m'], reason: '计时更正：第二名实际成绩 12.00' },
    admin, '更正发布 100 米');

  // ── 13. 删除一次：草稿届软删，列表不再可见 ──────────────────────────
  await call(meetService.deleteSportsMeet, {}, await ctxOf('m_admin', draftMeetId), '删除草稿届');

  // ── 14. 汇总：总榜、荣誉、列表 ──────────────────────────────────────
  const board = await call(standing.getMeetStandings, {}, admin, '读取总榜');
  const honors = {};
  for (const userId of ['m_c01_1', 'm_c01_3', 'm_c02_1', 'm_c02_2', 'm_c05_1']) {
    honors[userId] = await call(standing.getMyMeetHonors, {},
      await ctxOf(userId, meetId), `读取 ${userId} 的荣誉`);
  }
  const list = await call(meetService.listSportsMeets, {}, await ctxOf('m_admin'), '读取届列表');

  // 结果行快照（含预赛行与最新更正版）：供断言逐项核对名次、成绩与计分。
  // 行按同主键覆盖，list 出来的就是最新版；发布文档用来补上「哪一场、是否正式」。
  const pubDocs = await repo.sportsMeetPublications.list();
  const pubOf = new Map(pubDocs.map((doc) => [doc._id, doc]));
  const resultRows = (await repo.sportsMeetResultRows.list()).map((doc) => {
    const pub = pubOf.get(doc.publicationKey) || {};
    return {
      eventKey: doc.eventKey,
      sessionKey: pub.sessionKey || '',
      official: pub.official === true,
      collegeId: doc.collegeId,
      rank: doc.rank,
      value: doc.value,
      points: doc.points,
      status: doc.status,
    };
  });
  const collegeScope = (await repo.sportsMeetColleges.list()).map((doc) => ({
    collegeId: doc.collegeId, name: doc.name,
  }));

  const world = {
    schoolId: SCHOOL,
    meetId,
    meetName: MEET_NAME,
    draftMeetId,
    eventKeys: eventKeyOf,
    entryKeys,
    entryCount: Object.fromEntries(Object.entries(entryKeys).map(([templateId, byCollege]) => [
      templateId,
      Object.fromEntries(Object.entries(byCollege).map(([collegeId, keys]) => [collegeId, keys.length])),
    ])),
    clogsRejected: clogsRejected.ok ? null : clogsRejected.message,
    draw: { heatCount: draw.heatCount, heatMode: draw.heatMode, heatCapacity: draw.heatCapacity },
    finalists,
    beforeCorrection: sprintBeforeCorrection,
    sprintCorrection: { version: publications['sprint-100m'].publication.version },
    publications: Object.fromEntries(Object.entries(publications).map(([key, data]) => [
      key,
      { version: data.publication.version, official: data.publication.official },
    ])),
    standings: board.items.map((row) => ({
      collegeId: row.collegeId, collegeName: row.collegeName, rank: row.rank, total: row.total,
      gold: row.gold, silver: row.silver, bronze: row.bronze,
    })),
    standingsPublished: board.published,
    honors: Object.fromEntries(Object.entries(honors).map(([userId, data]) => [
      userId,
      { total: data.total, summary: data.summary, items: data.items },
    ])),
    listVisible: list.items.map((row) => row.meetId),
    resultRows,
    collegeScope,
  };
  return { repo, world };
}

/**
 * 取出演示记录，供 mock 仓储一次性装载（与 createSchoolDemoContent 同角色）。
 *
 * 记录全部由上面的服务链路产出，这里只做「读出来」——不在种子层手写任何
 * 业务文档。学院目录（colleges）不随演示装载：mock 的民大种子已有 c01–c19，
 * 名称用真实的，与 sportsMeetColleges 里的快照一致。
 */
async function createMeetDemoRecords() {
  const { repo } = await runMeetDemo();
  const records = {};
  for (const key of DUMP_KEYS) {
    records[key] = await repo[key].list();
  }
  return records;
}

module.exports = { runMeetDemo, createMeetDemoRecords, SCHOOL, MEET_NAME };
