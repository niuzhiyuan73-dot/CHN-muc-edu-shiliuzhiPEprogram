/**
 * 开始新赛季 —— 端到端
 * ============================================================
 * 这一组盯的是「开始新赛季之后什么变了、什么没变」，横跨三层：
 *   1. 回放引擎：分界之前的赛事积分不计入本赛季；等级分纹丝不动；
 *   2. 云函数：resetSeason 只认管理员，写分界点并把版本号加一；
 *   3. mock 数据源：与云端返回同一形状，积分同样被切掉。
 * 小程序内已不再提供赛季管理入口，重置改由云控制台手动触发，
 * 因此不再有对应的页面视图模型。
 *
 * 【为什么必须钉死「等级分不变」】
 * 早先的软重置会把所有人的等级分按 R' = R×0.75 + 1450×0.25 压向锚点。
 * 那套压分会让评级失去跨赛季的可比性：一个打了三年、稳定在 1800 分的
 * 老会员，新赛季第一天就被打回 1712 分，而他一场球都没打。
 * 现在只清积分、不碰等级分，这条边界必须由测试守住。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { replaySeason } = require('../miniprogram/services/replay.js');
const { DEFAULT_CONFIG } = require('../miniprogram/utils/elo.js');
const { getPoolRating } = require('../miniprogram/utils/rating.js');
const {
  MATCH_TYPE,
  MATCH_STATUS,
  EVENT_STATUS,
  RATING_POOL,
} = require('../miniprogram/utils/constants.js');

const mock = require('../miniprogram/services/mock.js');
const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const {
  defaultSeason,
  bumpSeason,
  writeSeasonReset,
  seasonId,
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

/** 造一场已结束的单打赛事，默认 5 月 10 日收尾（早于本组用到的 6/1 分界） */
function event(id, results, extra = {}) {
  return {
    _id: id,
    matchType: MATCH_TYPE.SINGLES,
    status: EVENT_STATUS.FINISHED,
    level: 3,
    endTime: new Date('2026-05-10T18:00:00'),
    results,
    ...extra,
  };
}

/* ============================================================
 * 回放引擎：分界只切积分
 * ============================================================ */

describe('replaySeason —— 赛季分界只切积分，不动等级分', () => {
  test('分界之后的等级分与不传分界时逐场一致', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const matches = [
      singles('m1', 'a', 'b', 'A', '2026-05-01T18:00:00'),
      singles('m2', 'a', 'b', 'A', '2026-05-10T18:00:00'),
      singles('m3', 'a', 'b', 'B', '2026-06-10T18:00:00'),
    ];

    const baseline = replaySeason({ members, matches });
    const cut = replaySeason({
      members,
      matches,
      options: { resetTime: '2026-06-01T00:00:00' },
    });

    for (const id of ['a', 'b']) {
      assert.equal(
        userOf(cut, id).ratings[RATING_POOL.SINGLES].elo,
        userOf(baseline, id).ratings[RATING_POOL.SINGLES].elo,
        '开新赛季不该改变任何人的等级分'
      );
    }
    // 逐场明细也要一模一样：分数变动、赛事所属都没被分界影响
    assert.deepEqual(
      cut.matches.map((m) => m.players.map((p) => [p.userId, p.eloBefore, p.eloAfter])),
      baseline.matches.map((m) => m.players.map((p) => [p.userId, p.eloBefore, p.eloAfter]))
    );
  });

  test('起点分不随分界刷新，仍是入池时那个分数', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const matches = [singles('m1', 'a', 'b', 'A', '2026-05-01T18:00:00')];

    const result = replaySeason({
      members,
      matches,
      options: { resetTime: '2026-06-01T00:00:00' },
    });

    assert.equal(userOf(result, 'a').ratings[RATING_POOL.SINGLES].startElo, MALE_START);
  });

  test('分界之前的赛事积分归上个赛季，不计入本赛季', () => {
    const members = [{ _id: 'a' }];
    const result = replaySeason({
      members,
      matches: [],
      events: [
        event('e_old', [{ userId: 'a', placement: 1 }]),
        event('e_new', [{ userId: 'a', placement: 1 }], {
          endTime: new Date('2026-06-05T18:00:00'),
        }),
      ],
      options: { resetTime: '2026-06-01T00:00:00' },
    });

    // 三级赛冠军 22 分，只有分界之后那场算数
    assert.equal(userOf(result, 'a').points, 22);
  });

  test('不传分界点时所有已结束赛事都算，meta 里是 null', () => {
    const members = [{ _id: 'a' }];
    const result = replaySeason({
      members,
      matches: [],
      events: [event('e_old', [{ userId: 'a', placement: 1 }])],
    });

    assert.equal(userOf(result, 'a').points, 22);
    assert.equal(result.meta.resetTime, null);
  });

  test('meta 原样回报本次使用的分界点', () => {
    const result = replaySeason({
      members: [{ _id: 'a' }],
      matches: [],
      events: [],
      options: { resetTime: '2026-06-01T00:00:00' },
    });
    assert.equal(new Date(result.meta.resetTime).getTime(), new Date('2026-06-01T00:00:00').getTime());
  });
});

/* ============================================================
 * 云函数：getSeasonState / resetSeason
 * ============================================================ */

describe('云函数 —— 赛季状态与开始新赛季', () => {
  test('getSeasonState —— 从未开始新赛季时各字段都是初值', async () => {
    const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
    const res = await dispatch('getSeasonState', {}, ctx);

    assert.equal(res.ok, true);
    assert.deepEqual(res.data, {
      anchorTime: null,
      resetTime: null,
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

  test('resetSeason —— 管理员可开始新赛季，写入分界点并把版本号加一', async () => {
    const repo = createFixtureRepo();
    const ctx = await contextFor(repo, 'openid-admin');
    const res = await dispatch('resetSeason', {}, ctx);

    assert.equal(res.ok, true);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.season.version, 1);
    assert.equal(res.data.season.seasonNumber, 2);
    assert.equal(new Date(res.data.season.resetTime).getTime(), NOW.getTime());

    // 必须真落库，否则缓存永远不会失效（dispatch 默认协会 pkb → current_pkb）
    const doc = await repo.seasons.get(seasonId('pkb'));
    assert.equal(new Date(doc.resetTime).getTime(), NOW.getTime());
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
    assert.equal(defaultSeason().resetTime, null);
  });
});

/* ============================================================
 * mock 数据源
 * ============================================================ */

describe('mock 数据源 —— 赛季状态与开始新赛季', () => {
  test('getSeasonState —— 形状与云端一致', async () => {
    mock.resetCache();
    const state = await mock.getSeasonState();

    assert.deepEqual(Object.keys(state).sort(), ['anchorTime', 'resetTime', 'seasonNumber', 'version']);
    assert.equal(state.resetTime, null);
    assert.equal(state.version, 0);
    assert.equal(state.seasonNumber, 1, '没开始新赛季前恒为第一赛季');
    assert.ok(state.anchorTime, '演示数据必有赛季首场，锚点不该为空');
  });

  test('resetSeason —— 清掉本赛季积分，等级分原地不动', async () => {
    mock.resetCache();

    const members = await mock.getMembers();
    const before = members.map((user) => ({
      id: user._id,
      points: user.points,
      elo: getPoolRating(user, RATING_POOL.SINGLES).elo,
      startElo: getPoolRating(user, RATING_POOL.SINGLES).startElo,
    }));
    assert.ok(
      before.some((item) => item.points > 0),
      '演示数据里应当有人拿过赛事积分，否则这条测试验不出东西'
    );

    // 开始新赛季要管理员，种子里的管理员是 u01
    const result = await mock.resetSeason('u01');
    assert.equal(result.ok, true);
    assert.ok(result.season.resetTime, '开始新赛季后要记下分界点');
    assert.equal(result.season.version, 1);
    assert.equal(result.season.seasonNumber, 2, '开始新赛季后应是第二赛季');

    for (const item of before) {
      const after = await mock.getMember(item.id);
      const rating = getPoolRating(after, RATING_POOL.SINGLES);
      assert.equal(after.points, 0, `${item.id} 的本赛季积分应当清零`);
      assert.equal(rating.elo, item.elo, `${item.id} 的等级分不该被赛季重置改动`);
      assert.equal(rating.startElo, item.startElo, `${item.id} 的起点分不该被赛季重置改动`);
    }

    mock.resetCache();
  });

  test('resetSeason —— 普通会员被拒', async () => {
    mock.resetCache();
    const result = await mock.resetSeason('u02');

    assert.equal(result.ok, false, '普通会员不能开始新赛季');
    assert.match(result.message, /管理员/);
    mock.resetCache();
  });
});

/* ============================================================
 * 页面视图模型已随 season-manage 页面一并移除；
 * 赛季更新的入口从「我的」收敛到云控制台手动操作。
 * ============================================================ */
