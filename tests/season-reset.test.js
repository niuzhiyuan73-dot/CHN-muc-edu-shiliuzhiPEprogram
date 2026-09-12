/**
 * 赛季软重置 —— 端到端
 * ============================================================
 * 这一组盯的是「重置之后分数到底怎么变」，横跨三层：
 *   1. 回放引擎：分界点之前打的球在分界处统一压分，起点分同步刷新；
 *   2. 云函数：resetSeason 只认管理员，写分界点并把版本号加一；
 *   3. mock 数据源：与云端返回同一形状，分数同样被压过。
 * 小程序内已不再提供赛季管理入口，重置改由云控制台手动触发，
 * 因此不再有对应的页面视图模型。
 *
 * 【为什么要断言「起点分」】
 * 起点分是进步榜的分母。历史上重置只改 elo、不动 startElo，导致新赛季
 * 第一天人人显示「已进步几百分」。这是本次修复的核心，必须钉死。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { replaySeason } = require('../miniprogram/services/replay.js');
const {
  applySeasonalReset,
  DEFAULT_CONFIG,
} = require('../miniprogram/utils/elo.js');
const { getPoolRating } = require('../miniprogram/utils/rating.js');
const {
  MATCH_TYPE,
  MATCH_STATUS,
  RATING_POOL,
} = require('../miniprogram/utils/constants.js');
const { DEFAULT_RESET_POLICY } = require('../miniprogram/services/season.js');

const mock = require('../miniprogram/services/mock.js');
const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const {
  defaultSeason,
  bumpSeason,
  writeSeasonReset,
  SEASON_ID,
} = require('../cloudfunctions/data/src/core/season.js');
const { createFixtureRepo, contextFor, NOW } = require('./helpers/cloud-fixture.js');

const MALE_START = DEFAULT_CONFIG.initialRating;
const userOf = (result, id) => result.users.find((u) => u._id === id);

/** 造一场单打 */
function singles(id, a, b, winner, time) {
  return {
    _id: id,
    matchType: MATCH_TYPE.SINGLES,
    teamA: [a],
    teamB: [b],
    winner,
    matchTime: new Date(time),
    eventId: null,
    status: MATCH_STATUS.ACTIVE,
  };
}

/* ============================================================
 * 回放引擎：软重置
 * ============================================================ */

describe('replaySeason —— 软重置分界', () => {
  test('分界之后的第一场，从压分后的分数与起点分起算', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const matches = [
      singles('m1', 'a', 'b', 'A', '2026-05-01T18:00:00'),
      singles('m2', 'a', 'b', 'A', '2026-05-10T18:00:00'),
    ];
    const policy = { retentionFactor: 0.75, anchorRating: 1450 };

    // 先跑一遍不重置的，拿到 m1 结束时的分数作为压分输入
    const baseline = replaySeason({ members, matches });
    const aAfterM1 = baseline.matches
      .find((m) => m._id === 'm1')
      .players.find((p) => p.userId === 'a').eloAfter;
    const expectedStart = applySeasonalReset(aAfterM1, policy);

    const result = replaySeason({
      members,
      matches,
      options: { resetTime: '2026-05-05T00:00:00', resetPolicy: policy },
    });

    const a = userOf(result, 'a');
    const m2a = result.matches
      .find((m) => m._id === 'm2')
      .players.find((p) => p.userId === 'a');

    assert.equal(a.ratings[RATING_POOL.SINGLES].startElo, expectedStart);
    assert.equal(m2a.eloBefore, expectedStart, '分界后的第一场必须从压分后的分数起算');
  });

  test('分界之后才首次入池的人不被压分（他的起点本来就是本赛季的）', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
    const matches = [
      singles('m1', 'a', 'b', 'A', '2026-05-01T18:00:00'),
      singles('m2', 'a', 'c', 'A', '2026-05-10T18:00:00'),
    ];
    // 故意用非默认参数：若 c 被误压，1450 会变成 1525，一眼可辨
    const policy = { retentionFactor: 0.5, anchorRating: 1600 };

    const result = replaySeason({
      members,
      matches,
      options: { resetTime: '2026-05-05T00:00:00', resetPolicy: policy },
    });

    const c = userOf(result, 'c');
    assert.equal(c.ratings[RATING_POOL.SINGLES].startElo, MALE_START);
  });

  test('重置之后再没打过球的人，也要在收尾时被压分', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const matches = [singles('m1', 'a', 'b', 'A', '2026-05-01T18:00:00')];
    const policy = { retentionFactor: 0.5, anchorRating: 1600 };

    const baseline = replaySeason({ members, matches });
    const aFinal = baseline.matches[0].players.find((p) => p.userId === 'a').eloAfter;
    const expected = applySeasonalReset(aFinal, policy);

    const result = replaySeason({
      members,
      matches,
      options: { resetTime: '2026-05-05T00:00:00', resetPolicy: policy },
    });

    const a = userOf(result, 'a');
    assert.equal(a.ratings[RATING_POOL.SINGLES].elo, expected, '停了几个月的老会员不能躲过重置');
    assert.equal(a.ratings[RATING_POOL.SINGLES].startElo, expected);
  });

  test('不传分界点时行为与从前一致（起点仍是入池分）', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const matches = [singles('m1', 'a', 'b', 'A', '2026-05-01T18:00:00')];
    const result = replaySeason({ members, matches });

    const a = userOf(result, 'a');
    assert.equal(a.ratings[RATING_POOL.SINGLES].startElo, MALE_START);
    assert.equal(result.meta.resetTime, null);
  });
});

/* ============================================================
 * 云函数：getSeasonState / resetSeason
 * ============================================================ */

describe('云函数 —— 赛季状态与重置', () => {
  test('getSeasonState —— 从未重置时给默认策略，不是空值', async () => {
    const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
    const res = await dispatch('getSeasonState', {}, ctx);

    assert.equal(res.ok, true);
    assert.deepEqual(res.data, {
      anchorTime: null,
      resetTime: null,
      policy: DEFAULT_RESET_POLICY,
      seasonNumber: 1,
      version: 0,
    });
  });

  test('getSeasonState —— 读接口不拦未登录', async () => {
    const ctx = await contextFor(createFixtureRepo(), null);
    const res = await dispatch('getSeasonState', {}, ctx);

    assert.equal(res.ok, true, '看赛季状态不需要登录，与其它读接口一致');
    assert.equal(res.data.version, 0);
  });

  test('resetSeason —— 管理员可重置，写入分界点并把版本号加一', async () => {
    const repo = createFixtureRepo();
    const ctx = await contextFor(repo, 'openid-admin');
    const res = await dispatch('resetSeason', {}, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.season.version, 1);
    assert.equal(new Date(res.data.season.resetTime).getTime(), NOW.getTime());

    // 必须真落库，否则缓存永远不会失效
    const doc = await repo.seasons.get('current');
    assert.equal(new Date(doc.resetTime).getTime(), NOW.getTime());
    assert.deepEqual(res.data.season.policy, DEFAULT_RESET_POLICY);
  });

  test('resetSeason —— 普通会员被拒，业务失败包在 ok:true 里', async () => {
    const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
    const res = await dispatch('resetSeason', {}, ctx);

    assert.equal(res.ok, true, '业务失败不是基础设施故障');
    assert.equal(res.data.ok, false);
    assert.match(res.data.message, /管理员/);
  });

  test('resetSeason —— 未登录是顶层 ok:false', async () => {
    const ctx = await contextFor(createFixtureRepo(), null);
    const res = await dispatch('resetSeason', {}, ctx);

    assert.equal(res.ok, false);
    assert.equal(res.message, '请先登录后再操作');
  });
});

/* ============================================================
 * 赛季编号：只由「开始新赛季」递增
 * ============================================================
 * 曾经的缺陷：界面上的「第 N 赛季」直接拿 version + 1 来显示，而 version
 * 是读缓存计数器，录一场球、审一位会员就 +1。于是管理员什么都没做，
 * 赛季数却自己从第四涨到第六。这里把「日常写入不许动编号」钉死。
 * ============================================================ */

describe('赛季编号 —— 只由「开始新赛季」递增', () => {
  test('日常写入（bumpSeason）不让编号前进，但版本号照旧每次都走', async () => {
    const repo = createFixtureRepo();

    for (let i = 0; i < 5; i += 1) {
      await repo.transaction((tx) => bumpSeason(tx, { anchorTime: NOW, now: NOW }));
    }

    const doc = await repo.seasons.get(SEASON_ID);
    assert.equal(doc.seasonNumber, 1, '录比赛之类的写入绝不能让赛季数虚涨');
    assert.equal(doc.version, 5, '版本号必须仍随每次写入前进，它是读缓存的凭据');
  });

  test('只有 writeSeasonReset 让编号加一，其后的日常写入也不再动它', async () => {
    const repo = createFixtureRepo();

    await repo.transaction((tx) => writeSeasonReset(tx, { resetTime: NOW, now: NOW }));
    await repo.transaction((tx) => writeSeasonReset(tx, { resetTime: NOW, now: NOW }));
    await repo.transaction((tx) => bumpSeason(tx, { anchorTime: NOW, now: NOW }));

    const doc = await repo.seasons.get(SEASON_ID);
    assert.equal(doc.seasonNumber, 3, '两次开始新赛季 → 第三赛季，之后的写入不再叠加');
  });

  test('缺字段的老赛季文档按第一赛季补上', () => {
    assert.equal(defaultSeason().seasonNumber, 1);
  });
});

/* ============================================================
 * mock 数据源
 * ============================================================ */

describe('mock 数据源 —— 赛季状态与重置', () => {
  test('getSeasonState —— 形状与云端一致', async () => {
    mock.resetCache();
    const state = await mock.getSeasonState();

    assert.equal(state.resetTime, null);
    assert.equal(state.version, 0);
    assert.equal(state.seasonNumber, 1, '没开始新赛季前恒为第一赛季');
    assert.deepEqual(state.policy, DEFAULT_RESET_POLICY);
    assert.ok(state.anchorTime, '演示数据必有赛季首场，锚点不该为空');
  });

  test('resetSeason —— 记下分界点，并把打过球的人的分数压向锚点', async () => {
    mock.resetCache();

    // 挑当前单打分最高的那位：他一定在锚点之上，压分后必然下降
    const members = await mock.getMembers();
    const top = members
      .map((user) => ({ user, rating: getPoolRating(user, RATING_POOL.SINGLES) }))
      .filter((item) => item.rating.matchCount > 0)
      .sort((a, b) => b.rating.elo - a.rating.elo)[0];
    assert.ok(top, '演示数据里应当有人打过单打');

    const before = top.rating.elo;
    // 重置要管理员，种子里的管理员是 u01
    const result = await mock.resetSeason('u01');

    assert.equal(result.ok, true);
    assert.ok(result.season.resetTime, '重置后要记下分界点');
    assert.equal(result.season.version, 1);
    assert.equal(result.season.seasonNumber, 2, '开始新赛季后应是第二赛季');

    const after = getPoolRating(await mock.getMember(top.user._id), RATING_POOL.SINGLES);
    assert.ok(after.elo < before, '高分段应当被压向锚点');
    assert.equal(after.startElo, after.elo, '起点分要跟着刷新，否则进步榜虚高');

    mock.resetCache();
  });
});

/* ============================================================
 * 页面视图模型已随 season-manage 页面一并移除；
 * 赛季更新的入口从「我的」收敛到云控制台手动操作。
 * ============================================================ */
