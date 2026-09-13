/**
 * 实时比分 —— 纯状态机与接口演练（M7）
 * ============================================================
 * 实时比分把「一场比赛」拆成逐球累计的过程态：判一球、撤一球，够分且
 * 领先 2 分才记一局，局数过半即结束。这条链分三层来钉：
 *
 *   1. 纯状态机（live-score.js）—— 赛制口径、撤销重算、定稿只交打完的局；
 *   2. 内存数据源闭环 —— 开台 → 判球 → 撤销 → 定稿 → 确认，全程走真实门面；
 *   3. 云端处理器 —— 同一套动作在云函数侧的权限与形状必须与 mock 一致。
 *
 * 另覆盖幂等、越权、未开台、未打完、不进回放几条底线（§八）。
 * ============================================================
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const facade = require('../miniprogram/services/index.js');
const live = require('../miniprogram/services/live-score.js');
const { HANDLERS, dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const {
  createFixtureRepo,
  contextFor,
  MATCHES,
} = require('./helpers/cloud-fixture.js');
const {
  ROLE,
  MATCH_TYPE,
  MATCH_STATUS,
  MATCH_COMPETITION,
  MATCH_TYPE_TO_POOL,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
} = require('../miniprogram/utils/constants.js');

/* ============================================================
 * 一、纯状态机
 * ============================================================ */

/** 一场最小可用的比赛记录 */
function baseMatch(overrides = {}) {
  return {
    _id: 'mm',
    teamA: ['a'],
    teamB: ['b'],
    gamePoints: 11,
    bestOf: 3,
    ...overrides,
  };
}

/** 连判 n 球给同一侧 */
function repeat(state, side, n) {
  let next = state;
  for (let i = 0; i < n; i += 1) next = live.applyRally(next, side);
  return next;
}

describe('实时比分状态机', () => {
  test('开台态 —— 主键、默认零分、按比赛类型区分个人 / 学院', () => {
    const personal = live.createLive(baseMatch());
    assert.equal(personal._id, 'ls_mm');
    assert.equal(personal.status, live.LIVE_STATUS.LIVE);
    assert.deepEqual(
      [personal.pointsA, personal.pointsB, personal.gamesA, personal.gamesB],
      [0, 0, 0, 0]
    );
    assert.equal(personal.competition, 'personal');
    assert.deepEqual(personal.rallies, []);

    const college = live.createLive(
      baseMatch({ competition: MATCH_COMPETITION.COLLEGE, collegeA: '甲院', collegeB: '乙院' })
    );
    assert.equal(college.competition, 'college');
    assert.equal(college.collegeA, '甲院');
  });

  test('一局 —— 够分且领先 2 分才算赢，不封顶', () => {
    assert.equal(live.gameWon(11, 9, 11), true);
    assert.equal(live.gameWon(11, 10, 11), false, '11:10 还没结束');
    assert.equal(live.gameWon(12, 10, 11), true);
    assert.equal(live.gameWon(13, 11, 11), true);
    assert.equal(live.gameWon(10, 9, 11), false, '没够分');
  });

  test('三局两胜 —— 连赢两局即结束，一局打完分数归零', () => {
    let state = live.createLive(baseMatch());
    state = repeat(state, live.SIDE.A, 11);
    assert.equal(state.gamesA, 1);
    assert.equal(state.gameIndex, 1);
    assert.equal(state.status, live.LIVE_STATUS.LIVE);
    assert.equal(state.pointsA, 0, '进下一局，当前分归零');

    state = repeat(state, live.SIDE.A, 11);
    assert.equal(state.gamesA, 2);
    assert.equal(state.status, live.LIVE_STATUS.FINISHED);
  });

  test('五局三胜 —— 要赢满三局', () => {
    let state = live.createLive(baseMatch({ bestOf: 5 }));
    state = repeat(state, live.SIDE.A, 33);
    assert.equal(state.gamesA, 3);
    assert.equal(state.status, live.LIVE_STATUS.FINISHED);
  });

  test('撤销 —— 撤掉决定性的那一球，整场退回进行中', () => {
    let state = live.createLive(baseMatch());
    state = repeat(state, live.SIDE.A, 22);
    assert.equal(state.status, live.LIVE_STATUS.FINISHED);

    state = live.undoRally(state);
    assert.equal(state.status, live.LIVE_STATUS.LIVE, '制胜球一撤，比赛重新悬着');
    assert.equal(state.gamesA, 1);
    assert.equal(state.pointsA, 10);
    assert.equal(state.gameIndex, 1);
  });

  test('幂等 —— 只认编号，空编号从不算已记', () => {
    const state = live.applyRally(live.createLive(baseMatch()), 'A', { rallyId: 'r1' });
    assert.equal(live.hasRally(state, 'r1'), true);
    assert.equal(live.hasRally(state, 'r2'), false);
    assert.equal(live.hasRally(state, ''), false);
  });

  test('定稿 —— 只交打完的局，进行中的那局不算', () => {
    let state = live.createLive(baseMatch());
    state = repeat(state, live.SIDE.A, 11); // 第一局 11:0
    state = repeat(state, live.SIDE.B, 3); // 第二局进行中 0:3
    assert.deepEqual(live.toOfficialScores(state), { scoreA: [11], scoreB: [0] });
  });

  test('查看端视图 —— 带领先方与结束标记，不吐逐球流水', () => {
    let state = live.createLive(baseMatch());
    state = repeat(state, live.SIDE.B, 2);
    const view = live.liveScoreOf(state);
    assert.equal(view.leading, 'B');
    assert.equal(view.finished, false);
    assert.equal(view.pointsB, 2);
    assert.equal(view.pointsA, 0);
    assert.equal(view.rallies, undefined, '轮询不背逐球流水');
  });
});

/* ============================================================
 * 二、内存数据源闭环
 * ============================================================ */

beforeEach(() => {
  facade.resetCache();
});

const ADMIN_ID = 'u01';

/** 造一场进行中的 4 人单败赛事，返回首轮那场待确认比赛 */
async function setupSingles() {
  const members = await facade.getMembers();
  // 只用普通会员当选手：管理员那套绕过规则会掩盖权限闸门是否真的生效
  const plain = members.filter((member) => member.role === ROLE.MEMBER);
  const players = plain.slice(0, 4).map((member) => member._id);
  const outsider = plain[4]._id;

  const published = await facade.publishEvent(
    {
      title: '实时比分演练赛',
      description: 'M7 自检',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SECOND,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      seedMode: SEED_MODE.ELO,
      seedCount: 4,
      startTime: '2026-05-20T09:00:00',
      location: '学校体育馆',
      quota: 4,
    },
    ADMIN_ID
  );
  assert.equal(published.ok, true, `发布赛事失败：${published.firstError}`);
  const eventId = published.record._id;

  for (const userId of players) {
    const signed = await facade.signUpEvent(eventId, userId);
    assert.equal(signed.ok, true, `报名失败：${signed.message}`);
  }
  const drawn = await facade.drawEvent(eventId, ADMIN_ID, { seedValue: 11 });
  assert.equal(drawn.ok, true, `抽签失败：${drawn.message}`);
  const started = await facade.startEvent(eventId, ADMIN_ID);
  assert.equal(started.ok, true, `开赛失败：${started.message}`);

  const match = (await facade.getMatchRecords({ eventId })).find((item) => item.round === 1);
  assert.ok(match, '首轮应有一场待确认比赛');
  return { eventId, match, players, outsider };
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

describe('实时比分（内存数据源）', () => {
  test('闭环 —— 开台 → 判球 → 撤销 → 定稿 → 确认', async () => {
    const { match } = await setupSingles();
    const me = match.teamA[0];
    const rival = match.teamB[0];

    const started = await facade.startLiveScore(match._id, me);
    assert.equal(started.ok, true, started.message);
    assert.equal(started.live.status, 'live');
    assert.equal(started.live.pointsA, 0);

    // 重开不重置比分
    const again = await facade.startLiveScore(match._id, me);
    assert.equal(again.ok, true);
    assert.equal(again.live.pointsA, 0);

    const one = await facade.recordRally(match._id, 'A', me, { rallyId: 'r1' });
    assert.equal(one.ok, true, one.message);
    assert.equal(one.live.pointsA, 1);

    // 查看端轮询读到实时分
    const polled = await facade.getLiveScores([match._id]);
    assert.equal(polled.length, 1);
    assert.equal(polled[0].pointsA, 1);
    assert.equal(polled[0].leading, 'A');

    // 台账里也挂着实时分
    const ledger = await facade.getMatchRecords({ id: match._id });
    assert.equal(ledger[0].live.pointsA, 1);

    // 撤销
    const undone = await facade.undoRally(match._id, me);
    assert.equal(undone.ok, true, undone.message);
    assert.equal(undone.live.pointsA, 0);

    // 连判 22 球，A 直落两局
    let state = undone.live;
    for (let i = 0; i < 22; i += 1) {
      const res = await facade.recordRally(match._id, 'A', me, { rallyId: `w${i}` });
      assert.equal(res.ok, true, res.message);
      state = res.live;
    }
    assert.equal(state.status, 'finished');
    assert.equal(state.gamesA, 2);

    // 定稿：转成正式比分，仍是待确认
    const done = await facade.finishLiveScore(match._id, me);
    assert.equal(done.ok, true, done.message);
    assert.deepEqual(done.match.scoreA, [11, 11]);
    assert.deepEqual(done.match.scoreB, [0, 0]);
    assert.equal(done.match.status, MATCH_STATUS.PENDING);
    assert.equal(done.live.status, 'finished', '定稿后实时态留在台账，查看端仍显示终局');
    // 轮询读到的视图也带着终局标记
    const finalView = (await facade.getLiveScores([match._id]))[0];
    assert.equal(finalView.finished, true);

    // 对手确认后计入正式流水
    const confirmed = await facade.confirmMatch(match._id, rival);
    assert.equal(confirmed.ok, true, confirmed.message);
    const after = (await facade.getMatchRecords({ id: match._id }))[0];
    assert.equal(after.status, MATCH_STATUS.ACTIVE);
  });

  test('幂等 —— 同一个编号重发不重复计分', async () => {
    const { match } = await setupSingles();
    const me = match.teamA[0];
    await facade.startLiveScore(match._id, me);

    const first = await facade.recordRally(match._id, 'A', me, { rallyId: 'same' });
    assert.equal(first.live.pointsA, 1);
    const retry = await facade.recordRally(match._id, 'A', me, { rallyId: 'same' });
    assert.equal(retry.ok, true);
    assert.equal(retry.live.pointsA, 1, '重发同一编号不应加第二次');
  });

  test('权限 —— 非参赛者不能开台', async () => {
    const { match, outsider } = await setupSingles();
    const res = await facade.startLiveScore(match._id, outsider);
    assert.equal(res.ok, false);
    assert.match(res.message, /无权/);
  });

  test('边界 —— 已生效的比赛不能开台', async () => {
    const { match } = await setupSingles();
    const me = match.teamA[0];
    const rival = match.teamB[0];
    await facade.submitMatch({ id: match._id, scoreA: ['11', '11'], scoreB: ['5', '3'], actor: me });
    await facade.confirmMatch(match._id, rival);

    const res = await facade.startLiveScore(match._id, me);
    assert.equal(res.ok, false);
    assert.match(res.message, /已生效/);
  });

  test('边界 —— 没开台判球、没打完定稿都被拒', async () => {
    const { match } = await setupSingles();
    const me = match.teamA[0];

    const noTable = await facade.recordRally(match._id, 'A', me);
    assert.equal(noTable.ok, false);
    assert.match(noTable.message, /还没开/);

    await facade.startLiveScore(match._id, me);
    const tooEarly = await facade.finishLiveScore(match._id, me);
    assert.equal(tooEarly.ok, false);
    assert.match(tooEarly.message, /还没打完/);
  });

  test('边界 —— 没有可撤销的判球', async () => {
    const { match } = await setupSingles();
    const me = match.teamA[0];
    await facade.startLiveScore(match._id, me);

    const res = await facade.undoRally(match._id, me);
    assert.equal(res.ok, false);
    assert.match(res.message, /没有可撤销/);
  });

  test('空名单 —— 不产生任何读取', async () => {
    assert.deepEqual(await facade.getLiveScores([]), []);
    assert.deepEqual(await facade.getLiveScores(), []);
  });

  test('不进回放 —— 逐球期间等级分不动', async () => {
    const { match, players, outsider } = await setupSingles();
    const me = match.teamA[0];
    const before = await ratingsOf([...players, outsider]);

    await facade.startLiveScore(match._id, me);
    for (let i = 0; i < 3; i += 1) {
      await facade.recordRally(match._id, 'A', me, { rallyId: `p${i}` });
    }

    assert.deepStrictEqual(await ratingsOf([...players, outsider]), before);
  });
});

/* ============================================================
 * 三、云端处理器
 * ============================================================ */

/** 一条待确认的个人赛记录，用来喂云端夹具（夹具自带的四场都已生效） */
const PENDING_MATCH = {
  _id: 'p_live',
  matchType: MATCH_TYPE.SINGLES,
  pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
  teamA: ['u01'],
  teamB: ['u02'],
  scoreA: [],
  scoreB: [],
  gamePoints: 11,
  bestOf: 3,
  winner: null,
  location: '',
  matchTime: '2026-05-10T18:00:00',
  recorder: '',
  eventId: null,
  status: MATCH_STATUS.PENDING,
};

function liveFixture() {
  return createFixtureRepo({ matches: [...MATCHES, { ...PENDING_MATCH }] });
}

/** 用一份夹具调一次云端接口 */
async function cloudCall(repo, action, payload = {}, openId = 'openid-u01') {
  const ctx = await contextFor(repo, openId);
  return dispatch(action, payload, ctx);
}

describe('实时比分（云端）', () => {
  test('五个动作都已有处理器', () => {
    for (const action of [
      'startLiveScore',
      'recordRally',
      'undoRally',
      'finishLiveScore',
      'getLiveScores',
    ]) {
      assert.equal(typeof HANDLERS[action], 'function', `${action} 未登记到 dispatch`);
    }
  });

  test('闭环 —— 开台 → 判球 → 幂等 → 定稿与 mock 同形', async () => {
    const repo = liveFixture();

    const start = await cloudCall(repo, 'startLiveScore', { matchId: 'p_live' });
    assert.equal(start.data.ok, true, start.data.message);
    assert.equal(start.data.live.status, 'live');
    assert.equal(start.data.live._id, 'ls_p_live');

    const r1 = await cloudCall(repo, 'recordRally', {
      matchId: 'p_live',
      side: 'A',
      rallyId: 'c1',
    });
    assert.equal(r1.data.live.pointsA, 1);

    // 幂等：同编号重发只算一球
    const r2 = await cloudCall(repo, 'recordRally', {
      matchId: 'p_live',
      side: 'A',
      rallyId: 'c1',
    });
    assert.equal(r2.data.live.pointsA, 1);

    // 读接口与台账并入
    const got = await cloudCall(repo, 'getLiveScores', { matchIds: ['p_live'] });
    assert.equal(got.data[0].pointsA, 1);
    const ledger = await cloudCall(repo, 'getMatchRecords', { id: 'p_live' });
    assert.equal(ledger.data[0].live.pointsA, 1);

    // 撤销
    const undone = await cloudCall(repo, 'undoRally', { matchId: 'p_live' });
    assert.equal(undone.data.live.pointsA, 0);

    // 打完两局
    for (let i = 0; i < 22; i += 1) {
      await cloudCall(repo, 'recordRally', { matchId: 'p_live', side: 'A', rallyId: `cw${i}` });
    }

    const done = await cloudCall(repo, 'finishLiveScore', { matchId: 'p_live' });
    assert.equal(done.data.ok, true, done.data.message);
    assert.deepEqual(done.data.match.scoreA, [11, 11]);
    assert.deepEqual(done.data.match.scoreB, [0, 0]);
    assert.equal(done.data.match.status, MATCH_STATUS.PENDING, '定稿仍待确认');
  });

  test('权限 —— 非参赛者被拒，未登录算基础设施故障', async () => {
    const repo = liveFixture();

    const outsider = await cloudCall(repo, 'startLiveScore', { matchId: 'p_live' }, 'openid-u03');
    assert.equal(outsider.data.ok, false);
    assert.match(outsider.data.message, /无权/);

    const guest = await cloudCall(repo, 'startLiveScore', { matchId: 'p_live' }, null);
    assert.equal(guest.ok, false, '未登录是顶层故障');
    assert.match(guest.message, /登录/);
  });

  test('边界 —— 已生效的比赛不能开台', async () => {
    const repo = liveFixture();
    const res = await cloudCall(repo, 'startLiveScore', { matchId: 'm1' });
    assert.equal(res.data.ok, false);
    assert.match(res.data.message, /已生效/);
  });

  test('边界 —— 没开台判球、没打完定稿都被拒', async () => {
    const repo = liveFixture();

    const noTable = await cloudCall(repo, 'recordRally', { matchId: 'p_live', side: 'A' });
    assert.equal(noTable.data.ok, false);
    assert.match(noTable.data.message, /还没开/);

    await cloudCall(repo, 'startLiveScore', { matchId: 'p_live' });
    const early = await cloudCall(repo, 'finishLiveScore', { matchId: 'p_live' });
    assert.equal(early.data.ok, false);
    assert.match(early.data.message, /还没打完/);
  });

  test('空名单 —— 云端同样不产生读取', async () => {
    const repo = liveFixture();
    const res = await cloudCall(repo, 'getLiveScores', { matchIds: [] });
    assert.deepEqual(res.data, []);
  });
});
