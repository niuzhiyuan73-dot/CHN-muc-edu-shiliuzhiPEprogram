/**
 * 学院赛端到端演练（M6-4、M6-5）
 * ============================================================
 * 前面每个里程碑各测一段，这里按真人操作顺序把整场学院赛一口气跑完，
 * 用一条链验证各段的衔接处没有缝：
 *
 *   发布 → 四院交名单 → 审核通过 → 抽签 → 赛事开始 → 首轮大场
 *   → 双方排阵 → 大场开始（生成小场）→ 录分确认 → 本轮结束排下一轮
 *   → 决赛 → 录入名次结束赛事
 *
 * 另跑一条弃权支线：大场未排齐不可开赛 → 开赛后记弃权 → 对手拿到小项、
 * 弃权方不计 ELO → 本轮照样自动推进；并复核个人赛自弃权。
 *
 * 两条链都用真实数据源，不打桩，跑通即视为可交付。
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
  EVENT_BRONZE_MODE,
  SEED_MODE,
  BRACKET_STAGE,
  TEAM,
} = require('../miniprogram/utils/constants.js');

/** 种子里的管理员 */
const ADMIN = { _id: 'u01', role: ROLE.ADMIN };

/** 演示数据里有在册会员的四个学院，够撑起两轮单败签表 */
const COLLEGES = ['体育学院', '信息工程学院', '经济学院', '管理学院'];

beforeEach(() => {
  facade.resetCache();
});

/** 取某学院在册会员的编号 */
async function memberIdsOf(college) {
  const members = await facade.getMembers();
  return members.filter((member) => member.college === college).map((member) => member._id);
}

/** 造一场进行中的学院赛：发布 → 四院交名单 → 审核通过 → 抽签 → 开赛 */
async function setupOngoing(legPlan = ['MS']) {
  const published = await facade.publishCollegeEvent(
    {
      title: '学院赛端到端演练',
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

/** 按小项人数排一份阵容：单打 1 人、双打 2 人 */
function lineupEntries(ids, legs) {
  return legs.map((leg) => ({
    legNo: leg.legNo,
    players: leg.discipline.endsWith('S') ? [ids[0]] : ids.slice(0, 2),
  }));
}

/** 取最新的某大场记录 */
async function tieOf(eventId, tieId) {
  return (await facade.getCollegeTies(eventId)).find((item) => item._id === tieId);
}

/** 双方排阵齐后开始大场，返回该大场的小场信息 */
async function beginTie(tie) {
  const aIds = await memberIdsOf(tie.collegeA);
  const bIds = await memberIdsOf(tie.collegeB);

  const lineupA = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeA, entries: lineupEntries(aIds, tie.legs) },
    ADMIN._id
  );
  assert.strictEqual(lineupA.ok, true, `A 排阵失败：${lineupA.message}`);
  const lineupB = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeB, entries: lineupEntries(bIds, tie.legs) },
    ADMIN._id
  );
  assert.strictEqual(lineupB.ok, true, `B 排阵失败：${lineupB.message}`);

  const started = await facade.startTie(tie._id, ADMIN._id);
  assert.strictEqual(started.ok, true, `开始大场失败：${started.message}`);

  return { tie: await tieOf(tie.eventId, tie._id), aIds, bIds };
}

/** 取某大场里某场小场的比赛记录 */
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
 * 一、完整链路（M6-4）
 * ============================================================ */

test('端到端 —— 发布到名次：四院单败两轮跑通，名次只记给学院', async () => {
  const { event, ties } = await setupOngoing(['MS']);
  assert.strictEqual(ties.length, 2, '四所学院抽签后首轮两场');

  // ---------- 首轮 ----------
  const first = await beginTie(ties[0]);
  const second = await beginTie(ties[1]);

  // 小场归属字段齐全，且不挂个人赛事编号（否则会污染个人读路径）
  const sampleLeg = await legMatchOf(first.tie, 1);
  assert.strictEqual(sampleLeg.competition, MATCH_COMPETITION.COLLEGE);
  assert.strictEqual(sampleLeg.eventId, null);
  assert.strictEqual(sampleLeg.collegeEventId, event._id);
  assert.strictEqual(sampleLeg.matchType, MATCH_TYPE.SINGLES);
  assert.strictEqual(sampleLeg.level, EVENT_LEVEL.FIRST, '学院赛按一级 K 计');

  await finishTie(first.tie, true);
  assert.strictEqual(
    (await tieOf(event._id, first.tie._id)).status,
    TIE_STATUS.FINISHED,
    '单小项大场打完即结束'
  );

  // 刚打完一场，本轮没结束，不该冒出下一轮
  assert.strictEqual(
    (await facade.getCollegeTies(event._id)).filter((item) => Number(item.round) === 2).length,
    0,
    '本轮没打完不排下一轮'
  );

  await finishTie(second.tie, false);

  // ---------- 第二轮 ----------
  const round2 = (await facade.getCollegeTies(event._id)).filter(
    (item) => Number(item.round) === 2
  );
  assert.strictEqual(round2.length, 1, '首轮打完自动生成决赛');

  assert.deepStrictEqual(
    [round2[0].collegeA, round2[0].collegeB].sort(),
    [first.tie.collegeA, second.tie.collegeB].sort(),
    '晋级的是两位对手'
  );

  const final = await beginTie(round2[0]);
  await finishTie(final.tie, true);
  assert.strictEqual((await tieOf(event._id, final.tie._id)).status, TIE_STATUS.FINISHED);

  // ---------- 名次 ----------
  const ratingsAfterPlay = await facade.getMembers();

  const champion = final.tie.collegeA;
  const runnerUp = final.tie.collegeB;
  const others = COLLEGES.filter((college) => college !== champion && college !== runnerUp);

  const finished = await facade.finishCollegeEvent(
    event._id,
    [
      { college: champion, placement: 1 },
      { college: runnerUp, placement: 2 },
      { college: others[0], placement: 3 },
      { college: others[1], placement: 3 },
    ],
    ADMIN._id
  );
  assert.strictEqual(finished.ok, true, finished.message);

  const saved = await facade.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.FINISHED);
  assert.strictEqual(saved.results.find((row) => row.placement === 1).college, champion);

  // 名次是整场的句号：结束后不再接受改动
  const again = await facade.finishCollegeEvent(event._id, [{ college: champion, placement: 1 }], ADMIN._id);
  assert.strictEqual(again.ok, false);
  assert.match(again.message, /已经结束/);

  // ---------- 隔离复核 ----------
  // 打小场会让个人 ELO 变化，但录入院名次不该再动任何个人分（M5-2）
  assert.deepStrictEqual(
    await facade.getMembers(),
    ratingsAfterPlay,
    '录入名次不产生任何个人等级分或积分变化'
  );
});

/* ============================================================
 * 二、弃权支线（M6-5）
 * ============================================================ */

test('弃权演练 —— 排阵未齐不可开赛，开赛后弃权对手拿分且不计 ELO', async () => {
  const { event, ties } = await setupOngoing(['MS']);
  const tie = ties[0];

  // 一方都没排：管理员也开不动
  const tooEarly = await facade.startTie(tie._id, ADMIN._id);
  assert.strictEqual(tooEarly.ok, false);
  assert.match(tooEarly.message, /排阵/);

  const { tie: started, aIds } = await beginTie(tie);
  const beforeA = await ratingOf(aIds[0]);

  // 管理员记录 A 学院弃权
  const forfeit = await facade.recordForfeit(started._id, 1, started.collegeA, ADMIN._id);
  assert.strictEqual(forfeit.ok, true, forfeit.message);

  const saved = await tieOf(event._id, started._id);
  const leg = saved.legs.find((item) => Number(item.legNo) === 1);
  assert.strictEqual(leg.winner, started.collegeB, '弃权方丢掉这一小项');
  assert.strictEqual(leg.outcome, MATCH_OUTCOME.FORFEIT);

  const match = await legMatchOf(saved, 1);
  assert.strictEqual(match.status, MATCH_STATUS.ACTIVE, '弃权场直接生效');
  assert.strictEqual(match.winner, TEAM.B);
  assert.strictEqual(match.forfeitBy, started.collegeA);
  assert.deepStrictEqual(match.scoreA, []);
  assert.deepStrictEqual(match.scoreB, []);

  assert.deepStrictEqual(await ratingOf(aIds[0]), beforeA, '弃权场不计 ELO');

  // 弃权同样推动轮次：另一场也弃权后照样排出决赛
  const second = await beginTie(ties[1]);
  const forfeit2 = await facade.recordForfeit(second.tie._id, 1, second.tie.collegeA, ADMIN._id);
  assert.strictEqual(forfeit2.ok, true, forfeit2.message);

  const round2 = (await facade.getCollegeTies(event._id)).filter(
    (item) => Number(item.round) === 2
  );
  assert.strictEqual(round2.length, 1, '弃权也算本轮有了结果，照样排下一轮');
  assert.deepStrictEqual(
    [round2[0].collegeA, round2[0].collegeB].sort(),
    [started.collegeB, second.tie.collegeB].sort(),
    '晋级的是两位对手'
  );
});

test('弃权演练 —— 个人赛本人可自弃，对手晋级且不计 ELO', async () => {
  const members = await facade.getMembers();
  const players = members.slice(0, 4).map((member) => member._id);

  const published = await facade.publishEvent(
    {
      title: '个人赛弃权演练',
      description: 'M6-5',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SECOND,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      seedMode: SEED_MODE.ELO,
      seedCount: 4,
      startTime: '2026-05-20T09:00:00',
      location: '学校体育馆',
      quota: 4,
    },
    ADMIN._id
  );
  assert.strictEqual(published.ok, true, published.firstError);
  const eventId = published.record._id;

  for (const userId of players) {
    await facade.signUpEvent(eventId, userId);
  }
  await facade.drawEvent(eventId, ADMIN._id, { seedValue: 11 });
  await facade.startEvent(eventId, ADMIN._id);

  const round1 = (await facade.getMatchRecords({ eventId })).filter((match) => match.round === 1);
  const before = await Promise.all(players.map(ratingOf));

  const winners = [];
  for (const match of round1) {
    const me = match.teamA[0];
    winners.push(match.teamB[0]);
    const result = await facade.forfeitMatch(match._id, me, me);
    assert.strictEqual(result.ok, true, result.message);
  }

  const finals = (await facade.getMatchRecords({ eventId })).filter(
    (match) => match.round === 2 && match.stage === BRACKET_STAGE.MAIN
  );
  assert.strictEqual(finals.length, 1, '两场首轮弃权后排出决赛');
  assert.deepStrictEqual(
    [...finals[0].teamA, ...finals[0].teamB].sort(),
    winners.slice().sort(),
    '晋级的是两位对手'
  );

  assert.deepStrictEqual(await Promise.all(players.map(ratingOf)), before, '个人赛弃权同样不计 ELO');
});

/** 某个选手当前的个人等级分（单打 / 双打两池） */
async function ratingOf(userId) {
  const members = await facade.getMembers();
  const member = members.find((item) => item._id === userId);
  return { singles: member.ratings.singles.elo, doubles: member.ratings.doubles.elo };
}
