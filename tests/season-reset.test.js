/**
 * 赛季软重置 —— 端到端
 * ============================================================
 * 这一组盯的是「重置之后分数到底怎么变」，横跨四层：
 *   1. 回放引擎：分界点之前打的球在分界处统一压分，起点分同步刷新；
 *   2. 云函数：resetSeason 只认管理员，写分界点并把版本号加一；
 *   3. mock 数据源：与云端返回同一形状，分数同样被压过；
 *   4. 视图模型：没有权限时失败关闭，文案与策略参数对得上。
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
  ROLE,
  USER_STATUS,
} = require('../miniprogram/utils/constants.js');
const { DEFAULT_RESET_POLICY } = require('../miniprogram/services/season.js');
const { loadSeasonManageView, describePolicy } = require('../miniprogram/services/season-view.js');

const mock = require('../miniprogram/services/mock.js');
const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
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

/** 一位正常在册的会员 */
function account(id, role = ROLE.MEMBER) {
  return { _id: id, nickname: id, status: USER_STATUS.ACTIVE, role };
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
 * mock 数据源
 * ============================================================ */

describe('mock 数据源 —— 赛季状态与重置', () => {
  test('getSeasonState —— 形状与云端一致', async () => {
    mock.resetCache();
    const state = await mock.getSeasonState();

    assert.equal(state.resetTime, null);
    assert.equal(state.version, 0);
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
    const result = await mock.resetSeason(mock.DEFAULT_CURRENT_USER_ID);

    assert.equal(result.ok, true);
    assert.ok(result.season.resetTime, '重置后要记下分界点');
    assert.equal(result.season.version, 1);

    const after = getPoolRating(await mock.getMember(top.user._id), RATING_POOL.SINGLES);
    assert.ok(after.elo < before, '高分段应当被压向锚点');
    assert.equal(after.startElo, after.elo, '起点分要跟着刷新，否则进步榜虚高');

    mock.resetCache();
  });
});

/* ============================================================
 * 视图模型
 * ============================================================ */

describe('season-view —— 赛季管理页视图', () => {
  test('描述策略时给出与参数对得上的例子', () => {
    const text = describePolicy(DEFAULT_RESET_POLICY);
    assert.match(text, /75%/);
    assert.match(text, /1900 分降到 1788 分/);
    assert.match(text, /1200 分升到 1263 分/);
  });

  test('访客失败关闭，一个字段都不下发', async () => {
    const view = await loadSeasonManageView({ user: null, isMock: true });
    assert.equal(view.allowed, false);
    assert.match(view.blockedText, /请先登录/);
    assert.equal(view.policyText, '');
  });

  test('普通会员在正式口径下无权，mock 口径下放行且给出演示提示', async () => {
    const member = account('u1', ROLE.MEMBER);

    const strict = await loadSeasonManageView({ user: member, isMock: false });
    assert.equal(strict.allowed, false);
    assert.match(strict.blockedText, /权限/);

    const relaxed = await loadSeasonManageView({ user: member, isMock: true });
    assert.equal(relaxed.allowed, true);
    assert.match(relaxed.demoNotice, /演示数据源/);
    assert.ok(relaxed.policyText, '有权限时要给出压分说明');
  });

  test('管理员在正式口径下放行，且没有演示提示', async () => {
    mock.resetCache();
    const view = await loadSeasonManageView({ user: account('admin', ROLE.ADMIN), isMock: false });

    assert.equal(view.allowed, true);
    assert.equal(view.demoNotice, '');
    assert.equal(view.hasReset, false);
    assert.equal(view.resetText, '本赛季尚未重置');
  });
});
