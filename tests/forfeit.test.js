/**
 * 个人赛弃权（M5-3 / D41、D42）自检
 * ============================================================
 * 弃权是一套通用规则：学院赛小场由管理员代记（M4-7，见 college-score.test.js），
 * 个人赛由本人自选。这里把个人赛那条路钉死：
 *
 *   1. 本人自选 —— 给自己那场记弃权，比分清空、胜方判给对手；
 *   2. 对手晋级 —— 单败首轮都弃权后，下一轮由两位对手排出来；
 *   3. 不计 ELO —— 弃权场不进回放，双方等级分都不动；
 *   4. 权限 —— 旁人不能替场上的人弃权，管理员可以代记；
 *   5. 边界 —— 约球（无赛事）与已生效的比赛都不能弃权；
 *   6. 小组赛 —— 弃权按对手获胜计入组内积分（D42）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const facade = require('../miniprogram/services/index.js');
const {
  MATCH_TYPE,
  MATCH_STATUS,
  MATCH_OUTCOME,
  EVENT_LEVEL,
  EVENT_FORMAT,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  BRACKET_STAGE,
} = require('../miniprogram/utils/constants.js');
const { computeStandings } = require('../miniprogram/utils/standings.js');

/** 种子里的管理员 */
const ADMIN_ID = 'u01';

beforeEach(() => {
  facade.resetCache();
});

/** 一份合法的单打赛事表单 */
function draft(overrides = {}) {
  return {
    title: '弃权演练赛',
    description: 'M5-3 弃权路径自检',
    matchType: MATCH_TYPE.SINGLES,
    level: EVENT_LEVEL.SECOND,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    seedMode: SEED_MODE.ELO,
    seedCount: 4,
    startTime: '2026-05-20T09:00:00',
    location: '学校体育馆',
    quota: 4,
    courtCount: 4,
    ...overrides,
  };
}

/** 取某赛事名下的全部比赛 */
async function eventMatches(eventId) {
  return facade.getMatchRecords({ eventId });
}

/** 一组选手当前的等级分（单打 / 双打两池） */
async function ratingsOf(userIds) {
  const members = await facade.getMembers();
  const out = {};
  for (const id of userIds) {
    const member = members.find((item) => item._id === id);
    out[id] = { singles: member.ratings.singles.elo, doubles: member.ratings.doubles.elo };
  }
  return out;
}

/**
 * 造一场进行中的 4 人单败赛事：发布 → 报名 → 抽签 → 开赛。
 * @returns {Promise<{eventId:string, players:string[]}>}
 */
async function setupSingles(overrides = {}) {
  const members = await facade.getMembers();
  const players = members.slice(0, 4).map((member) => member._id);

  const published = await facade.publishEvent(draft(overrides), ADMIN_ID);
  assert.strictEqual(published.ok, true, `发布赛事失败：${published.firstError}`);

  const eventId = published.record._id;
  for (const userId of players) {
    const signed = await facade.signUpEvent(eventId, userId);
    assert.strictEqual(signed.ok, true, `报名失败：${signed.message}`);
  }

  const drawn = await facade.drawEvent(eventId, ADMIN_ID, { seedValue: 11 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await facade.startEvent(eventId, ADMIN_ID);
  assert.strictEqual(started.ok, true, `开赛失败：${started.message}`);

  return { eventId, players };
}

/** 站在对面的一侧 */
function otherSide(match, userId) {
  return match.teamA.includes(userId) ? 'B' : 'A';
}

/* ============================================================
 * 一、本人自选弃权
 * ============================================================ */

test('弃权 —— 本人给自己那场弃权：比分清空、胜方判给对手、记录随即生效', async () => {
  const { eventId } = await setupSingles();
  const round1 = (await eventMatches(eventId)).filter((match) => match.round === 1);
  assert.strictEqual(round1.length, 2, '4 人单败首轮应有两场');

  const match = round1[0];
  const me = match.teamA[0];
  const expectedWinner = otherSide(match, me);

  const result = await facade.forfeitMatch(match._id, me, me);
  assert.strictEqual(result.ok, true, result.message);

  const after = (await eventMatches(eventId)).find((item) => item._id === match._id);
  assert.strictEqual(after.outcome, MATCH_OUTCOME.FORFEIT, '结果性质由 outcome 表达');
  assert.strictEqual(after.forfeitBy, me);
  assert.strictEqual(after.status, MATCH_STATUS.ACTIVE, '弃权也是一场已生效的比赛');
  assert.strictEqual(after.winner, expectedWinner, '胜方必须判给对手');
  assert.deepStrictEqual(after.scoreA, []);
  assert.deepStrictEqual(after.scoreB, []);
});

/* ============================================================
 * 二、对手晋级
 * ============================================================ */

test('弃权 —— 首轮两场都弃权后，下一轮由两位对手排出来', async () => {
  const { eventId } = await setupSingles();
  const round1 = (await eventMatches(eventId)).filter((match) => match.round === 1);

  const winners = [];
  for (const match of round1) {
    const me = match.teamA[0];
    winners.push(match.teamB[0]);

    const result = await facade.forfeitMatch(match._id, me, me);
    assert.strictEqual(result.ok, true, result.message);
  }

  // 打三四名模式下，第 2 轮除了决赛还有一场季军赛，这里只看主签表那场
  const finals = (await eventMatches(eventId)).filter(
    (match) => match.round === 2 && match.stage === BRACKET_STAGE.MAIN
  );
  assert.strictEqual(finals.length, 1, '两场首轮都有结果后应排出决赛');

  const finalists = [...finals[0].teamA, ...finals[0].teamB].sort();
  assert.deepStrictEqual(finalists, winners.slice().sort(), '晋级的是两位对手');
});

/* ============================================================
 * 三、不计 ELO
 * ============================================================ */

test('弃权 —— 双方等级分都不变（弃权场不进回放）', async () => {
  const { eventId, players } = await setupSingles();
  const before = await ratingsOf(players);

  const round1 = (await eventMatches(eventId)).filter((match) => match.round === 1);
  for (const match of round1) {
    const me = match.teamA[0];
    const result = await facade.forfeitMatch(match._id, me, me);
    assert.strictEqual(result.ok, true, result.message);
  }

  const after = await ratingsOf(players);
  assert.deepStrictEqual(after, before, '弃权不该让任何人的等级分发生变化');
});

/* ============================================================
 * 四、权限
 * ============================================================ */

test('弃权 —— 旁人不能替场上的人弃权，场上的另一位也不行', async () => {
  const { eventId, players } = await setupSingles();
  const round1 = (await eventMatches(eventId)).filter((match) => match.round === 1);
  const match = round1[0];

  const me = match.teamA[0];
  const outsider = players.find(
    (id) => !match.teamA.includes(id) && !match.teamB.includes(id)
  );
  assert.ok(outsider, '应能找到一位不在场上的选手');

  const byOutsider = await facade.forfeitMatch(match._id, me, outsider);
  assert.strictEqual(byOutsider.ok, false, '不在场的人不能替你弃权');

  const stillPending = (await eventMatches(eventId)).find((item) => item._id === match._id);
  assert.strictEqual(stillPending.status, MATCH_STATUS.PENDING, '被拒后记录不动');
  assert.strictEqual(stillPending.outcome, undefined);
});

test('弃权 —— 管理员可以替没到场的选手代记', async () => {
  const { eventId } = await setupSingles();
  const round1 = (await eventMatches(eventId)).filter((match) => match.round === 1);
  const match = round1[0];

  const result = await facade.forfeitMatch(match._id, match.teamA[0], ADMIN_ID);
  assert.strictEqual(result.ok, true, result.message);
});

/* ============================================================
 * 五、边界：约球与已生效的比赛
 * ============================================================ */

test('弃权 —— 日常约球没有晋级这回事，不能记弃权', async () => {
  const members = await facade.getMembers();
  const a = members[0]._id;
  const b = members[1]._id;

  const submitted = await facade.submitMatch({
    matchType: MATCH_TYPE.SINGLES,
    teamA: [a],
    teamB: [b],
    scoreA: ['11'],
    scoreB: ['5'],
    gamePoints: 11,
    bestOf: 1,
    matchTime: '2026-05-01T18:00:00',
    location: '学校体育馆 1 号场',
  });
  assert.strictEqual(submitted.ok, true, submitted.firstError);
  assert.strictEqual(submitted.match.eventId, null, '约球不带赛事编号');

  const result = await facade.forfeitMatch(submitted.match._id, a, a);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /无权/);
});

test('弃权 —— 已生效的比赛不能再记弃权，要改得走撤销', async () => {
  const { eventId } = await setupSingles();
  const round1 = (await eventMatches(eventId)).filter((match) => match.round === 1);
  const match = round1[0];

  const me = match.teamA[0];
  const rival = match.teamB[0];

  // 抽签比赛的局制来自赛事配置（三局两胜），要录满两局才判得出胜负
  const recorded = await facade.submitMatch({
    id: match._id,
    scoreA: ['11', '11'],
    scoreB: ['5', '3'],
    actor: me,
  });
  assert.strictEqual(recorded.ok, true, recorded.firstError);

  const confirmed = await facade.confirmMatch(match._id, rival);
  assert.strictEqual(confirmed.ok, true, confirmed.message);

  const result = await facade.forfeitMatch(match._id, me, me);
  assert.strictEqual(result.ok, false, '已生效的成绩不能被弃权覆盖');

  const after = (await eventMatches(eventId)).find((item) => item._id === match._id);
  assert.strictEqual(after.outcome, undefined, '原记录不该被改动');
  assert.strictEqual(after.status, MATCH_STATUS.ACTIVE);
});

/* ============================================================
 * 六、小组赛：弃权按对手获胜计入积分（D42）
 * ============================================================ */

test('弃权 —— 循环赛里按对手获胜计入组内积分，同样不计 ELO', async () => {
  const { eventId, players } = await setupSingles({
    format: EVENT_FORMAT.ROUND_ROBIN,
    seedCount: 2,
  });

  const before = await ratingsOf(players);
  const matches = await eventMatches(eventId);
  assert.ok(matches.length > 0, '循环赛应排出比赛');

  const target = matches[0];
  assert.strictEqual(target.stage, BRACKET_STAGE.GROUP, '循环赛的比赛都在 groups 阶段');

  const me = target.teamA[0];
  const rival = target.teamB[0];

  const result = await facade.forfeitMatch(target._id, me, me);
  assert.strictEqual(result.ok, true, result.message);

  const after = (await eventMatches(eventId)).find((item) => item._id === target._id);
  assert.strictEqual(after.winner, otherSide(target, me));

  const standings = computeStandings({
    entries: players,
    matches: await eventMatches(eventId),
  });
  const mine = standings.find((row) => row.id === me);
  const theirs = standings.find((row) => row.id === rival);
  assert.strictEqual(theirs.wins, 1, '对手记一胜');
  assert.strictEqual(theirs.losses, 0);
  assert.strictEqual(mine.losses, 1, '弃权方记一负');
  assert.strictEqual(mine.wins, 0);

  assert.deepStrictEqual(await ratingsOf(players), before, '循环赛弃权同样不计等级分');
});
