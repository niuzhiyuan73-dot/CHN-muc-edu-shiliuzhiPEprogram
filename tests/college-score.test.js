/**
 * 学院赛小场录分与大场推进（M4-2 ~ M4-7）自检
 * ============================================================
 * 这里走的是完整链路：开赛 → 排阵 → 大场开始生成小场 → 录分 → 对手确认
 * → 大场汇总 → 本轮打完排下一轮。每条边界都用真实数据源钉死：
 *
 *   1. 小场写库 —— 大场开始时按排阵生成小场记录，键唯一、归属字段齐（M4-1）；
 *   2. 录分确认 —— 参赛者录分，对手确认后大场写回结果（M4-2）；
 *   3. 单打即时结算 —— 确认后个人等级分立刻变化（M4-3）；
 *   4. 双打不计分 —— 双打小场确认后任何个人分都不动（M4-4）；
 *   5. 大场汇总 —— 打满比净胜定出胜负（M4-5）；
 *   6. 轮次推进 —— 本轮全部结束后自动生成下一轮（M4-6）；
 *   7. 弃权 —— 仅管理员可记，弃权方丢分、对手晋级且不计等级分（M4-7）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const facade = require('../miniprogram/services/index.js');
const {
  ROLE,
  COLLEGE_EVENT_STATUS,
  TIE_STATUS,
  MATCH_STATUS,
  MATCH_OUTCOME,
  MATCH_COMPETITION,
  MATCH_TYPE,
  EVENT_LEVEL,
  COLLEGE_LEG_FORMAT,
  TEAM,
  requiredGendersOf,
} = require('../miniprogram/utils/constants.js');

/** 管理员 */
const ADMIN = { _id: 'u01', role: ROLE.ADMIN };

/**
 * 种子数据里「一男一女各一名」的四个学院，够撑起两轮签表。
 * 必须各有两性：本文件的赛程是男单 + 混双，排阵要按小项校验性别。
 */
const COLLEGES = ['经济学院', '管理学院', '历史文化学院', '民族学与社会学学院'];

beforeEach(() => {
  facade.resetCache();
});

/** 取某学院在册会员（含性别），排阵要按小项性别挑人 */
async function rosterOf(college) {
  const members = await facade.getMembers();
  return members.filter((member) => member.college === college);
}

/** 取某学院在册会员的编号 */
async function memberIdsOf(college) {
  return (await rosterOf(college)).map((member) => member._id);
}

/** 某个选手当前的个人等级分（单打 / 双打两池） */
async function ratingOf(userId) {
  const members = await facade.getMembers();
  const member = members.find((item) => item._id === userId);
  return {
    singles: member.ratings.singles.elo,
    doubles: member.ratings.doubles.elo,
  };
}

/**
 * 按小项要求的性别排一份阵容：男单取男队员，混双取一男一女。
 * 与真人在排阵页上能点出的组合一致（校验在数据层兜底）。
 */
function lineupEntries(roster, legs) {
  return legs.map((leg) => {
    const used = new Set();
    const players = [];
    for (const gender of requiredGendersOf(leg.discipline) || []) {
      const pick = roster.find((member) => !used.has(member._id) && member.gender === gender);
      used.add(pick._id);
      players.push(pick._id);
    }
    return { legNo: leg.legNo, players };
  });
}

/**
 * 造一场进行中的学院赛：发布 → 四院交名单 → 审核通过 → 抽签 → 开赛。
 * @returns {Promise<{event:Object, ties:Array}>}
 */
async function setupOngoing(legPlan = ['MS', 'XD']) {
  const published = await facade.publishCollegeEvent(
    {
      title: '学院团体赛测试',
      legPlan,
      startTime: '2026-10-01T09:00:00',
      rosterMin: 1,
      rosterMax: 20,
    },
    ADMIN._id
  );
  assert.strictEqual(published.ok, true, `发布学院赛失败：${published.firstError}`);
  const event = published.record;

  for (const college of COLLEGES) {
    const result = await facade.submitCollegeEntry(
      { eventId: event._id, college, memberIds: await memberIdsOf(college) },
      ADMIN._id
    );
    assert.strictEqual(result.ok, true, `提交 ${college} 名单失败：${result.message}`);
  }
  for (const entry of await facade.getCollegeEntries(event._id)) {
    await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN._id);
  }

  const drawn = await facade.drawCollegeEvent(event._id, ADMIN._id, { seedValue: 42 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await facade.startCollegeEvent(event._id, ADMIN._id);
  assert.strictEqual(started.ok, true, `开始赛事失败：${started.message}`);

  return { event: drawn.record, ties: started.ties };
}

/** 双方排阵齐后开始大场，返回该大场的小场编号 */
async function beginTie(tie) {
  const aRoster = await rosterOf(tie.collegeA);
  const bRoster = await rosterOf(tie.collegeB);
  const aIds = aRoster.map((member) => member._id);
  const bIds = bRoster.map((member) => member._id);

  const lineupA = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeA, entries: lineupEntries(aRoster, tie.legs) },
    ADMIN._id
  );
  assert.strictEqual(lineupA.ok, true, `A 排阵失败：${lineupA.message}`);
  const lineupB = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeB, entries: lineupEntries(bRoster, tie.legs) },
    ADMIN._id
  );
  assert.strictEqual(lineupB.ok, true, `B 排阵失败：${lineupB.message}`);

  const started = await facade.startTie(tie._id, ADMIN._id);
  assert.strictEqual(started.ok, true, `开始大场失败：${started.message}`);

  const saved = (await facade.getCollegeTies(tie.eventId)).find((item) => item._id === tie._id);
  return { tie: saved, aIds, bIds };
}

/** 取某大场里的某场小场比赛记录 */
async function legMatchOf(tie, legNo) {
  const leg = tie.legs.find((item) => Number(item.legNo) === Number(legNo));
  const records = await facade.getMatchRecords({ id: leg.matchId });
  return records[0] || null;
}

/** 录一场 11:5 的比分并由对手确认 */
async function settleLeg(tie, legNo, winnerIsA) {
  const match = await legMatchOf(tie, legNo);
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

/** 把一场大场按指定一方赢下全部小项 */
async function finishTie(tie, winnerIsA) {
  for (const leg of tie.legs) {
    await settleLeg(tie, leg.legNo, winnerIsA);
  }
}

/* ============================================================
 * 一、小场写库（M4-1）
 * ============================================================ */

test('大场开始 —— 按排阵生成小场记录，键唯一且归属字段齐全', async () => {
  const { event, ties } = await setupOngoing();
  const { tie, aIds, bIds } = await beginTie(ties[0]);

  assert.strictEqual(tie.status, TIE_STATUS.ONGOING);
  assert.strictEqual(tie.legs.length, 2);

  const matchIds = tie.legs.map((leg) => leg.matchId);
  assert.ok(matchIds.every(Boolean), '每个小项都要落一场比赛');
  assert.strictEqual(new Set(matchIds).size, 2, '小场键互不相同');

  const singles = await legMatchOf(tie, 1);
  assert.strictEqual(singles.competition, MATCH_COMPETITION.COLLEGE);
  assert.strictEqual(singles.collegeEventId, event._id);
  assert.strictEqual(singles.tieId, tie._id);
  assert.strictEqual(singles.legNo, 1);
  assert.strictEqual(singles.discipline, 'MS');
  assert.strictEqual(singles.matchType, MATCH_TYPE.SINGLES);
  assert.strictEqual(singles.eventId, null, '小场不挂个人赛事编号，避免污染个人读路径');
  assert.strictEqual(singles.level, EVENT_LEVEL.FIRST, '学院赛按一级 K 计');
  assert.strictEqual(singles.status, MATCH_STATUS.PENDING);
  assert.strictEqual(singles.outcome, MATCH_OUTCOME.NORMAL);
  assert.strictEqual(singles.gamePoints, COLLEGE_LEG_FORMAT.gamePoints);
  assert.strictEqual(singles.bestOf, COLLEGE_LEG_FORMAT.bestOf);
  assert.deepStrictEqual(singles.teamA, [aIds[0]]);
  assert.deepStrictEqual(singles.teamB, [bIds[0]]);
  assert.strictEqual(singles.winner, null, '刚生成的小场还没有胜方');

  const doubles = await legMatchOf(tie, 2);
  assert.strictEqual(doubles.matchType, MATCH_TYPE.DOUBLES);
  assert.deepStrictEqual(doubles.teamA, aIds.slice(0, 2));
});

/* ============================================================
 * 二、录分与确认（M4-2）
 * ============================================================ */

test('录分确认 —— 对手确认后大场写回该小项的结果', async () => {
  const { ties } = await setupOngoing();
  const { tie, aIds, bIds } = await beginTie(ties[0]);

  const match = await legMatchOf(tie, 1);
  const submitted = await facade.submitMatch({
    id: match._id,
    scoreA: ['11'],
    scoreB: ['7'],
    actor: aIds[0],
  });
  assert.strictEqual(submitted.ok, true, submitted.firstError);
  assert.strictEqual(submitted.match.status, MATCH_STATUS.PENDING, '录完仍是待确认');

  const confirmed = await facade.confirmMatch(match._id, bIds[0]);
  assert.strictEqual(confirmed.ok, true, confirmed.message);

  const saved = (await facade.getCollegeTies(tie.eventId)).find((item) => item._id === tie._id);
  const leg = saved.legs.find((item) => Number(item.legNo) === 1);
  assert.strictEqual(leg.winner, tie.collegeA);
  assert.strictEqual(leg.scoreText, '11:7');
  assert.strictEqual(leg.pointsA, 11);
  assert.strictEqual(leg.pointsB, 7);
});

/* ============================================================
 * 三、单打小场即时结算（M4-3）
 * ============================================================ */

test('单打小场确认 —— 胜者涨分、负者降分，个人等级分立刻变化', async () => {
  const { ties } = await setupOngoing();
  const { tie, aIds, bIds } = await beginTie(ties[0]);

  const beforeA = await ratingOf(aIds[0]);
  const beforeB = await ratingOf(bIds[0]);

  await settleLeg(tie, 1, true);

  const afterA = await ratingOf(aIds[0]);
  const afterB = await ratingOf(bIds[0]);

  assert.ok(afterA.singles > beforeA.singles, `胜者应涨分：${beforeA.singles} → ${afterA.singles}`);
  assert.ok(afterB.singles < beforeB.singles, `负者应降分：${beforeB.singles} → ${afterB.singles}`);
});

/* ============================================================
 * 四、双打小场不计分（M4-4）
 * ============================================================ */

test('双打小场确认 —— 不改变任何人的个人等级分', async () => {
  const { ties } = await setupOngoing();
  const { tie, aIds, bIds } = await beginTie(ties[0]);

  // 先确认单打，再看双打确认前后是否有任何变化
  await settleLeg(tie, 1, true);
  const players = [...aIds.slice(0, 2), ...bIds.slice(0, 2)];
  const before = await Promise.all(players.map(ratingOf));

  await settleLeg(tie, 2, true);

  const after = await Promise.all(players.map(ratingOf));
  assert.deepStrictEqual(after, before, '双打小场不能动任何个人分（单打、双打两池都不动）');
});

/* ============================================================
 * 五、大场汇总与结束（M4-5）
 * ============================================================ */

test('大场汇总 —— 全部小项打完后定出胜负并置为已结束', async () => {
  const { ties } = await setupOngoing();
  const { tie } = await beginTie(ties[0]);

  await finishTie(tie, true);

  const saved = (await facade.getCollegeTies(tie.eventId)).find((item) => item._id === tie._id);
  assert.strictEqual(saved.status, TIE_STATUS.FINISHED);
  assert.strictEqual(saved.winner, tie.collegeA);
});

/* ============================================================
 * 六、轮次推进（M4-6）
 * ============================================================ */

test('轮次推进 —— 首轮两场都结束后自动排出下一轮', async () => {
  const { event, ties } = await setupOngoing();
  assert.strictEqual(ties.length, 2, '四所学院抽签后首轮两场');

  const first = await beginTie(ties[0]);
  const second = await beginTie(ties[1]);

  // 只打完第一场：本轮还没结束，不应冒出下一轮
  await finishTie(first.tie, true);
  let all = await facade.getCollegeTies(event._id);
  assert.strictEqual(all.filter((item) => Number(item.round) === 2).length, 0, '本轮没打完不排下一轮');

  await finishTie(second.tie, false);

  all = await facade.getCollegeTies(event._id);
  const round2 = all.filter((item) => Number(item.round) === 2);
  assert.strictEqual(round2.length, 1, '首轮打完自动生成决赛');

  const winners = [first.tie.collegeA, second.tie.collegeB].sort();
  assert.deepStrictEqual([round2[0].collegeA, round2[0].collegeB].sort(), winners);
});

/* ============================================================
 * 七、弃权（M4-7）
 * ============================================================ */

test('弃权 —— 管理员可记，弃权方丢小项、对手晋级且不计等级分', async () => {
  const { ties } = await setupOngoing();
  const { tie, aIds } = await beginTie(ties[0]);

  const beforeA = await ratingOf(aIds[0]);

  const result = await facade.recordForfeit(tie._id, 1, tie.collegeA, ADMIN._id);
  assert.strictEqual(result.ok, true, result.message);

  const saved = (await facade.getCollegeTies(tie.eventId)).find((item) => item._id === tie._id);
  const leg = saved.legs.find((item) => Number(item.legNo) === 1);
  assert.strictEqual(leg.winner, tie.collegeB, '弃权方丢掉这一小项');
  assert.strictEqual(leg.outcome, MATCH_OUTCOME.FORFEIT);

  const match = await legMatchOf(saved, 1);
  assert.strictEqual(match.status, MATCH_STATUS.ACTIVE);
  assert.strictEqual(match.outcome, MATCH_OUTCOME.FORFEIT);
  assert.strictEqual(match.winner, TEAM.B);
  assert.deepStrictEqual(match.scoreA, []);
  assert.deepStrictEqual(match.scoreB, []);
  assert.strictEqual(match.forfeitBy, tie.collegeA);

  const afterA = await ratingOf(aIds[0]);
  assert.deepStrictEqual(afterA, beforeA, '弃权场不计 ELO');

  // 已有结果的小项不能再记弃权
  const again = await facade.recordForfeit(tie._id, 1, tie.collegeB, ADMIN._id);
  assert.strictEqual(again.ok, false);
});

test('弃权 —— 干事无权记录，且不许替非参赛学院记', async () => {
  const { ties } = await setupOngoing();
  const { tie } = await beginTie(ties[0]);

  const byStaff = await facade.recordForfeit(tie._id, 1, tie.collegeA, 'u02');
  assert.strictEqual(byStaff.ok, false);
  assert.match(byStaff.message, /只有管理员/);

  const outsider = await facade.recordForfeit(tie._id, 1, '经济学院', ADMIN._id);
  assert.strictEqual(outsider.ok, false);
  assert.match(outsider.message, /参赛学院/);
});

test('弃权 —— 大场还没开始不能记', async () => {
  const { ties } = await setupOngoing();
  const tie = ties[0];

  const result = await facade.recordForfeit(tie._id, 1, tie.collegeA, ADMIN._id);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /还没开始/);
});
