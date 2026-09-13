/**
 * 学院赛模拟场景 —— 16 进 8 已打完，八进四进行中
 * ============================================================
 * 这不是一条「验证某个函数」的单元测试，而是一份可运行的**场景快照**：
 * 用真实数据源（mock）按真人操作顺序把一场学院赛推到指定进度，然后
 * 断言这个进度上的关键事实，并把它打印出来，便于人工核对页面该长什么样。
 *
 * 场景设定（与需求一一对应）：
 *   · 赛事正在进行，赛制为团体单败、每场大场两个小项（男单 + 女单）
 *   · 第一轮「16 进 8」已全部打完
 *   · 第二轮「八进四」进行中，已打完三场，只剩一场没开打
 *   · 演示账号 u06「赵明宇」所在的法学院已进八强
 *   · 赵明宇是法学院的干事，本人不参赛
 *   · 法学院那场八进四还没提交出场名单（大场停在「待排阵」）
 *
 * 怎么看到它：
 *   npm test 会跑到本文件；单独看这一份可以
 *     node --test tests/college-demo.test.js
 *   运行后终端会打印一段场景摘要（见 printScenario）。
 *
 * 【为什么要现造第 16 所学院】
 * 种子里 24 位会员只覆盖 15 所学院，凑不满 16 签位。这里用「注册 → 管理员
 * 审核通过」这条真实通路补一位文学院会员，而不是改 seed.js——种子里的人数
 * 被多个用例钉死（datasource / page 都断言 getMembers().length === 24），
 * 动它会连累一片无关的测试。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const facade = require('../miniprogram/services/index.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  COLLEGE_EVENT_STATUS_LABEL,
  TIE_STATUS,
  TIE_STATUS_LABEL,
  LEG_DISCIPLINE,
  LEG_DISCIPLINE_LABEL,
  TIE_ALGO,
  TIE_NET_MODE,
} = require('../miniprogram/utils/constants.js');
const { canManageCollegeEvent } = require('../miniprogram/services/college-event.js');
const { canSubmitLineup, playersPerLeg } = require('../miniprogram/services/college-lineup.js');
// 视图模型不在数据源门面上（门面只透传 mock 的函数），要从 college-view 直接取
const { loadCollegeLineupView } = require('../miniprogram/services/college-view.js');

/** 种子里的管理员，全场规则性操作都由他做 */
const ADMIN_ID = 'u01';
/** 演示账号：赵明宇，本场被任命为法学院干事 */
const LEADER_ID = 'u06';
const LAW_COLLEGE = '法学院';
/** 种子里只有 15 所学院有会员，补的这一所用于凑满 16 签位 */
const EXTRA_COLLEGE = '文学院';
const EXTRA_MEMBER = {
  realName: '顾清和',
  nickName: '清和',
  gender: 'F',
  studentId: '20240099',
  college: EXTRA_COLLEGE,
  phone: '13800000099',
};

/* ============================================================
 * 通用小工具
 * ============================================================ */

/** 某学院可以上场的会员编号（在册、且不是干事——干事不参赛） */
async function rosterIdsOf(college) {
  const members = await facade.getMembers();
  return members
    .filter(
      (member) =>
        member.college === college &&
        member.status === USER_STATUS.ACTIVE &&
        member._id !== LEADER_ID
    )
    .map((member) => member._id);
}

/** 替某学院排阵的人：法学院的名单交给干事，其余学院由管理员代劳 */
function lineupActorOf(college) {
  return college === LAW_COLLEGE ? LEADER_ID : ADMIN_ID;
}

/** 按每个小项需要的人数排人；单打 1 人，双打 2 人（本场景只用到单打） */
function lineupEntries(ids, legs) {
  return legs.map((leg) => {
    const need = playersPerLeg(leg.discipline);
    const players = [];
    for (let i = 0; i < need; i += 1) players.push(ids[i % ids.length]);
    return { legNo: leg.legNo, players };
  });
}

/** 取某大场里某场小场的比赛记录 */
async function legMatchOf(tie, legNo) {
  const leg = tie.legs.find((item) => Number(item.legNo) === Number(legNo));
  const records = await facade.getMatchRecords({ id: leg.matchId });
  return records[0] || null;
}

/** 录一场 11:5 的比分并由对手确认生效 */
async function settleLeg(tie, legNo, winnerIsA) {
  const match = await legMatchOf(tie, legNo);
  assert.ok(match, `第 ${legNo} 场小场没有生成比赛记录`);
  const winnerId = winnerIsA ? match.teamA[0] : match.teamB[0];
  const loserId = winnerIsA ? match.teamB[0] : match.teamA[0];

  const submitted = await facade.submitMatch({
    id: match._id,
    scoreA: winnerIsA ? ['11'] : ['5'],
    scoreB: winnerIsA ? ['5'] : ['11'],
    actor: winnerId,
  });
  assert.strictEqual(submitted.ok, true, `录分失败：${submitted.firstError}`);
  const confirmed = await facade.confirmMatch(match._id, loserId);
  assert.strictEqual(confirmed.ok, true, `确认失败：${confirmed.message}`);
}

/**
 * 打完一场大场，指定某所学院全取两个小项。
 * 排阵由各方（干事 / 管理员）提交，大场级「开始」仍只归管理员。
 */
async function playTie(tie, winCollege) {
  for (const college of [tie.collegeA, tie.collegeB]) {
    const ids = await rosterIdsOf(college);
    assert.ok(ids.length > 0, `${college} 没有可上场的会员`);
    const lineup = await facade.submitLineup(
      { tieId: tie._id, college, entries: lineupEntries(ids, tie.legs) },
      lineupActorOf(college)
    );
    assert.strictEqual(lineup.ok, true, `${college} 排阵失败：${lineup.message}`);
  }

  const started = await facade.startTie(tie._id, ADMIN_ID);
  assert.strictEqual(started.ok, true, `开始大场失败：${started.message}`);

  const winIsA = tie.collegeA === winCollege;
  for (const leg of started.record.legs) {
    await settleLeg(started.record, leg.legNo, winIsA);
  }
}

/* ============================================================
 * 场景构建
 * ============================================================ */

/**
 * 把一场学院赛推到「八进四进行中」。
 * @returns {Promise<{event:Object, lawTie:Object, colleges:Array<string>}>}
 */
async function buildScenario() {
  // 1. 补第 16 所学院：种子里只有 15 所学院有会员
  const registered = await facade.registerMember(EXTRA_MEMBER, {
    now: new Date('2026-08-01T09:00:00'),
  });
  assert.strictEqual(registered.ok, true, `注册文学院会员失败：${registered.firstError}`);
  const approved = await facade.approveMember(registered.account._id, ADMIN_ID);
  assert.strictEqual(approved.ok, true, `审核文学院会员失败：${approved.message}`);

  // 2. 任命赵明宇为法学院干事（本人不参赛，见 rosterIdsOf 的排除）
  const appointed = await facade.setCollegeLeader(LEADER_ID, ADMIN_ID, true);
  assert.strictEqual(appointed.ok, true, `任命干事失败：${appointed.message}`);
  assert.strictEqual(appointed.account.role, ROLE.STAFF);
  assert.strictEqual(appointed.account.college, LAW_COLLEGE);

  // 3. 发布学院赛：团体单败，一场大场打男单 + 女单
  const published = await facade.publishCollegeEvent(
    {
      title: '2026 院际匹克球团体赛',
      description: '16 所学院单败淘汰；当前进度：16 进 8 已打完，八进四进行中',
      legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS],
      allowMultiEntry: true,
      rosterMin: 1,
      rosterMax: 20,
      tieAlgo: TIE_ALGO.FULL_POINTS,
      tieNetMode: TIE_NET_MODE.WIN_DIFF,
      startTime: '2026-09-20T09:00:00',
      location: '学校体育馆',
    },
    ADMIN_ID
  );
  assert.strictEqual(published.ok, true, `发布学院赛失败：${published.firstError}`);
  const event = published.record;

  // 4. 16 所学院交名单（干事本人不进名单）
  const colleges = Array.from(
    new Set((await facade.getMembers()).map((member) => member.college))
  ).sort();
  assert.strictEqual(colleges.length, 16, '应当正好 16 所学院参赛');

  for (const college of colleges) {
    const memberIds = await rosterIdsOf(college);
    assert.ok(memberIds.length > 0, `${college} 凑不出名单`);
    const submitted = await facade.submitCollegeEntry(
      { eventId: event._id, college, memberIds },
      ADMIN_ID
    );
    assert.strictEqual(submitted.ok, true, `${college} 交名单失败：${submitted.message}`);
  }
  for (const entry of await facade.getCollegeEntries(event._id)) {
    const reviewed = await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN_ID);
    assert.strictEqual(reviewed.ok, true, `审核 ${entry.college} 名单失败：${reviewed.message}`);
  }

  // 5. 抽签（名单就此锁定）→ 赛事级开始，生成首轮 8 场
  const drawn = await facade.drawCollegeEvent(event._id, ADMIN_ID, { seedValue: 20260920 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);
  const started = await facade.startCollegeEvent(event._id, ADMIN_ID);
  assert.strictEqual(started.ok, true, `赛事开始失败：${started.message}`);
  assert.strictEqual(started.ties.length, 8, '16 所学院首轮应有 8 场大场');

  // 6. 打完 16 进 8，法学院所在的那场让法学院赢
  for (const tie of started.ties) {
    await playTie(tie, LAW_COLLEGE);
  }

  // 7. 八进四：打掉不含法学院的三场，把法学院那场留成「待排阵」
  const round2 = (await facade.getCollegeTies(event._id)).filter(
    (tie) => Number(tie.round) === 2
  );
  assert.strictEqual(round2.length, 4, '八进四应有 4 场大场');
  const lawTie = round2.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );
  assert.ok(lawTie, '法学院应当晋级八强');
  for (const tie of round2) {
    if (tie._id === lawTie._id) continue;
    await playTie(tie, tie.collegeA);
  }

  // 发布时拿到的 record 只是一份快照；抽签与开赛改的是台账，这里重新取一份最新的
  const latest = await facade.getCollegeEvent(event._id);
  return { event: latest, lawTie, colleges };
}

/** 整个文件共用一份场景：不设 beforeEach 复位，构建一次反复断言 */
let scenarioPromise = null;
function scenario() {
  if (!scenarioPromise) scenarioPromise = buildScenario();
  return scenarioPromise;
}

/* ============================================================
 * 打印：把场景摊成一段人话
 * ============================================================ */

/** 大场状态文案（进行中的大场按存储状态读，不用再推一遍） */
function statusTextOf(tie) {
  if (tie.status === TIE_STATUS.FINISHED) return '已结束';
  if (tie.status === TIE_STATUS.ONGOING) return '进行中';
  if (tie.status === TIE_STATUS.READY) return '待开赛（双方已排阵）';
  return TIE_STATUS_LABEL[TIE_STATUS.PENDING_LINEUP];
}

function tieLine(tie, mark = '') {
  const result = tie.winner ? `，${tie.winner} 晋级` : '';
  return `  · ${tie.collegeA} vs ${tie.collegeB} —— ${statusTextOf(tie)}${result}${mark}`;
}

/** 生成场景摘要文本 */
async function scenarioText({ event, lawTie, colleges }) {
  const ties = await facade.getCollegeTies(event._id);
  const round1 = ties.filter((tie) => Number(tie.round) === 1);
  const round2 = ties.filter((tie) => Number(tie.round) === 2);
  const lawEntry = (await facade.getCollegeEntries(event._id)).find(
    (entry) => entry.college === LAW_COLLEGE
  );
  const leader = await facade.getMember(LEADER_ID);
  const byId = new Map((await facade.getMembers()).map((member) => [member._id, member]));
  const nameOf = (id) => {
    const member = byId.get(id);
    return member ? member.nickName || member.realName || id : id;
  };
  const opponent = lawTie.collegeA === LAW_COLLEGE ? lawTie.collegeB : lawTie.collegeA;
  const ownRound1 = round1.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );

  const lines = [];
  lines.push('');
  lines.push('════════════ 学院赛模拟场景 ════════════');
  lines.push(`赛事：${event.title}`);
  lines.push(
    `状态：${COLLEGE_EVENT_STATUS_LABEL[event.status]}　` +
      `小项：${event.legPlan.map((item) => LEG_DISCIPLINE_LABEL[item]).join(' · ')}　` +
      `参赛学院：${colleges.length} 所`
  );
  lines.push('');
  lines.push(`【第一轮 · 16 进 8】已全部打完（${round1.length} 场）`);
  if (ownRound1) lines.push(tieLine(ownRound1, '　← 法学院在这一场'));
  lines.push('');
  lines.push(`【第二轮 · 八进四】进行中（${round2.length} 场）`);
  for (const tie of round2) {
    lines.push(tieLine(tie, tie._id === lawTie._id ? '　← 还没开打' : ''));
  }
  lines.push('');
  lines.push(`【法学院视角】${leader.nickName}（${leader.realName} / ${leader._id}）`);
  lines.push(
    `  身份：${lawEntry ? LAW_COLLEGE : ''}干事（${leader.role === ROLE.STAFF ? '干事' : '非干事'}）　` +
      `是否参赛：否（不在法学院名单内）`
  );
  lines.push(
    `  法学院参赛名单：${lawEntry.members.map(nameOf).join('、')}（共 ${lawEntry.members.length} 人）`
  );
  lines.push(`  八进四对手：${opponent}`);
  lines.push(
    `  本场排阵：尚未提交（大场状态「${statusTextOf(lawTie)}」；排阵页会沿用上一轮人选作默认）`
  );
  lines.push('════════════════════════════════════════');
  lines.push('');
  return lines.join('\n');
}

/* ============================================================
 * 用例
 * ============================================================ */

test('学院赛模拟场景 —— 16 进 8 已打完、八进四进行中，法学院进八强待排阵', async () => {
  const state = await scenario();
  const { event, lawTie } = state;

  // ---- 赛事整体 ----
  assert.strictEqual(event.status, COLLEGE_EVENT_STATUS.ONGOING, '赛事应当进行中');
  assert.deepStrictEqual(event.legPlan, [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS]);

  const ties = await facade.getCollegeTies(event._id);
  const round1 = ties.filter((tie) => Number(tie.round) === 1);
  const round2 = ties.filter((tie) => Number(tie.round) === 2);

  // ---- 16 进 8 已结束 ----
  assert.strictEqual(round1.length, 8);
  for (const tie of round1) {
    assert.strictEqual(tie.status, TIE_STATUS.FINISHED, `${tie.collegeA}/${tie.collegeB} 应已结束`);
    assert.ok(tie.winner, '已结束的大场必须有胜者');
  }
  const lawRound1 = round1.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );
  assert.ok(lawRound1, '法学院打过首轮');
  assert.strictEqual(lawRound1.winner, LAW_COLLEGE, '法学院赢下 16 进 8');

  // ---- 八进四进行中：三场打完，法学院那场待排阵 ----
  assert.strictEqual(round2.length, 4);
  const finishedRound2 = round2.filter((tie) => tie.status === TIE_STATUS.FINISHED);
  assert.strictEqual(finishedRound2.length, 3, '八进四已打完三场');
  assert.strictEqual(lawTie.status, TIE_STATUS.PENDING_LINEUP, '法学院这场还没排阵');
  assert.strictEqual(lawTie.lineupA, false, 'A 方未交名单');
  assert.strictEqual(lawTie.lineupB, false, 'B 方未交名单');
  assert.ok(
    lawTie.collegeA === LAW_COLLEGE || lawTie.collegeB === LAW_COLLEGE,
    '法学院在这签位上'
  );

  // 这场大场名下一条排阵记录都没有
  const lineups = await facade.getCollegeLineups(event._id);
  assert.strictEqual(
    lineups.filter((item) => item.tieId === lawTie._id).length,
    0,
    '法学院这场没有任何排阵记录'
  );

  // 本轮没打完，不该冒出半决赛
  assert.strictEqual(
    ties.filter((tie) => Number(tie.round) === 3).length,
    0,
    '八进四没打完不排半决赛'
  );

  // ---- 赵明宇：法学院干事，且不参赛 ----
  const leader = await facade.getMember(LEADER_ID);
  assert.strictEqual(leader.nickName, '明宇');
  assert.strictEqual(leader.realName, '赵明宇');
  assert.strictEqual(leader.role, ROLE.STAFF, '赵明宇是干事');
  assert.strictEqual(leader.college, LAW_COLLEGE);

  const lawEntry = (await facade.getCollegeEntries(event._id)).find(
    (entry) => entry.college === LAW_COLLEGE
  );
  assert.ok(lawEntry, '法学院交了名单');
  assert.ok(!lawEntry.members.includes(LEADER_ID), '干事本人不在参赛名单里');

  // 打印场景，便于人工核对
  console.log(await scenarioText(state));
});

test('学院赛模拟场景 —— 干事能替本学院排八进四，但发布与开赛仍归管理员', async () => {
  const { event, lawTie } = await scenario();
  const leader = await facade.getMember(LEADER_ID);

  // 干事能替法学院交这场八进四的排阵
  assert.strictEqual(
    canSubmitLineup(lawTie, leader, { college: LAW_COLLEGE, event }),
    true,
    '干事可以替本学院排阵'
  );

  // 但发布学院赛 / 抽签 / 开始大场这些规则性操作只归管理员
  assert.strictEqual(canManageCollegeEvent(leader), false, '干事不能管理学院赛');
  const refuseStart = await facade.startTie(lawTie._id, LEADER_ID);
  assert.strictEqual(refuseStart.ok, false, '干事开不了大场');
  assert.match(refuseStart.message, /管理员|排阵/);

  // 排阵页视图：站在赵明宇的视角看，这场是可以提交的，且还没排人
  const view = await loadCollegeLineupView(lawTie._id, {
    user: leader,
    eventId: event._id,
  });
  assert.strictEqual(view.found, true);
  assert.strictEqual(view.canSubmit, true, `排阵页应当可提交：${view.blockReason}`);
  assert.strictEqual(view.blockReason, '');
  assert.strictEqual(view.hasLineup, false, '本场尚未提交过排阵');
  assert.strictEqual(view.statusLabel, TIE_STATUS_LABEL[TIE_STATUS.PENDING_LINEUP]);
  assert.strictEqual(view.rosterCount, 1, '法学院名单只有孙悦一人');
  // 本场确实没交过排阵（hasLineup 为 false），但页面会把上一轮的人沿用成默认值，
  // 所以每个小项显示的是上一轮那位队员，而不是「未排人」——排阵页正是靠这个
  // 让干事少点几下。想让场景停在「一个人都没排」，得让她上一轮也没上过。
  assert.match(view.carryHint, /沿用/, '页面提示已沿用上一轮排阵');
  assert.ok(view.legs.length > 0);
  for (const leg of view.legs) {
    assert.notStrictEqual(leg.pickedText, '未排人', '已沿用上一轮人选');
    assert.ok(leg.pickedText.length > 0, `第 ${leg.legNo} 项列出了沿用的人选`);
  }
});
