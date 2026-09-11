/**
 * 云函数核心 —— 分发、筛选、排序
 * ============================================================
 * 这一组测试盯两件事：
 *   1. 前端能调的名字，云端必须都有；反之云端不许有多余的路由。
 *      名字对不上是接入阶段最容易犯、也最难在真机上定位的错——
 *      用户点下去只看到「未知的操作」，测试却全绿。
 *   2. 只读接口的筛选与排序口径。云端与 mock 是两套实现，形状却必须
 *      一样，否则切换数据源时页面会以各种方式崩掉。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cloud = require('../miniprogram/services/cloud.js');
const { ALL_ACTIONS } = require('../cloudfunctions/data/src/actions.js');
const { HANDLERS, dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const { createFixtureRepo, contextFor } = require('./helpers/cloud-fixture.js');

/** 用一份全新的夹具调一次接口 */
async function call(action, payload = {}, openId = 'openid-u01') {
  const ctx = await contextFor(createFixtureRepo(), openId);
  return dispatch(action, payload, ctx);
}

/* ---------- 名单对齐 ---------- */

test('前端 cloud.js 的调用名与云端操作名单逐一对应', () => {
  // request 是发起请求的工具函数，CLOUD_FUNCTION 是字符串，都不是 action
  const called = Object.keys(cloud)
    .filter((name) => typeof cloud[name] === 'function' && name !== 'request')
    .sort();

  assert.deepEqual(
    called,
    [...ALL_ACTIONS].sort(),
    '前端导出的调用名与 actions.js 的名单不一致：加了接口要同步加进名单'
  );
});

test('每个 action 都有处理器，且没有计划外的路由', () => {
  assert.deepEqual(
    Object.keys(HANDLERS).sort(),
    [...ALL_ACTIONS].sort(),
    'dispatch 的路由表必须与 actions.js 一字不差'
  );
});

test('未知的 action —— 顶层 ok:false，属于基础设施故障', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
  const res = await dispatch('不存在的操作', {}, ctx);

  assert.equal(res.ok, false);
  assert.match(res.message, /未知的操作/);
});

/* ---------- 会员 ---------- */

test('getMembers —— 只给审核通过的会员，申请中的不算', async () => {
  const res = await call('getMembers');

  assert.equal(res.ok, true);
  assert.deepEqual(
    res.data.map((m) => m._id).sort(),
    ['u01', 'u02', 'u03', 'u04', 'u_admin']
  );
});

test('getMemberApplications —— 只给非正常状态的账号', async () => {
  const res = await call('getMemberApplications');

  assert.deepEqual(res.data.map((m) => m._id), ['u_pending']);
});

test('getMember —— 会员与申请都能查到，查不到返回 null', async () => {
  assert.equal((await call('getMember', { userId: 'u01' })).data._id, 'u01');
  assert.equal((await call('getMember', { userId: 'u_pending' })).data._id, 'u_pending');
  assert.equal((await call('getMember', { userId: 'nobody' })).data, null);
});

test('getCurrentUser —— 由 OpenID 决定，而不是前端说了算', async () => {
  const mine = await call('getCurrentUser', {}, 'openid-admin');
  assert.equal(mine.data._id, 'u_admin');
  assert.equal(mine.data.role, 2);

  const guest = await call('getCurrentUser', {}, null);
  assert.equal(guest.data, null);
});

/* ---------- 比赛与台账 ---------- */

test('getMatches —— 只给已生效的比赛，按时间倒序', async () => {
  const res = await call('getMatches');

  assert.deepEqual(res.data.map((m) => m._id), ['m4', 'm3', 'm2', 'm1']);
});

test('getMatches —— 支持 user / pool / event / limit 四种筛选', async () => {
  assert.deepEqual(
    (await call('getMatches', { userId: 'u01' })).data.map((m) => m._id),
    ['m4', 'm3', 'm1']
  );
  assert.deepEqual(
    (await call('getMatches', { pool: 'singles' })).data.map((m) => m._id),
    ['m4', 'm2', 'm1']
  );
  assert.deepEqual((await call('getMatches', { eventId: 'ev1' })).data, []);
  assert.deepEqual(
    (await call('getMatches', { limit: 2 })).data.map((m) => m._id),
    ['m4', 'm3']
  );
});

test('getMatchRecords —— 台账含待确认与已撤销，status 0 不能被当成假值', async () => {
  // 夹具里四场都已生效，没有待确认的
  assert.deepEqual((await call('getMatchRecords', { status: 0 })).data, []);

  const active = await call('getMatchRecords', { status: 1 });
  assert.deepEqual(active.data.map((m) => m._id), ['m4', 'm3', 'm2', 'm1']);
});

/* ---------- 公告 ---------- */

test('getAnnouncements —— 已下架的从公开列表消失，台账里仍留着', async () => {
  const publicList = await call('getAnnouncements');
  assert.deepEqual(publicList.data.map((a) => a._id), ['a2', 'a1']);

  const ledger = await call('getAnnouncementRecords');
  assert.equal(ledger.data.length, 3, '台账要能看到已下架的那条，否则查不到「通知哪去了」');
});

/* ---------- 榜单 ---------- */

test('getLeaderboard —— 男单榜只列男会员，且分数来自同一个单打池', async () => {
  const board = (await call('getLeaderboard', { project: 'men_singles' })).data;
  const ids = board.map((row) => row._id);

  assert.deepEqual([...ids].sort(), ['u01', 'u02', 'u_admin']);
  assert.ok(!ids.includes('u03'), '女会员不该出现在男单榜上');

  // 榜是按等级分降序排的
  for (let i = 1; i < board.length; i += 1) {
    assert.ok(board[i - 1].elo >= board[i].elo, '榜单必须按等级分降序');
  }
});

test('getLeaderboard —— 女单榜与男单榜共用单打池的分数', async () => {
  const men = (await call('getLeaderboard', { project: 'men_singles' })).data;
  const women = (await call('getLeaderboard', { project: 'women_singles' })).data;

  assert.deepEqual(women.map((row) => row._id).sort(), ['u03', 'u04']);
  assert.ok(!men.some((row) => row._id === 'u03'), '两个榜只是过滤条件不同');
});

test('getLeaderboard —— 双打榜不分性别', async () => {
  const board = (await call('getLeaderboard', { project: 'doubles' })).data;
  assert.deepEqual(
    board.map((row) => row._id).sort(),
    ['u01', 'u02', 'u03', 'u04', 'u_admin']
  );
});

test('getMyProjects —— 只列打过球的项目，且不带异性项目', async () => {
  const mine = (await call('getMyProjects', { userId: 'u01' })).data;
  const projects = mine.map((item) => item.project);

  assert.deepEqual(projects, ['men_singles', 'doubles']);
  assert.ok(!projects.includes('women_singles'), '男会员不该看到女单项目');

  const singles = mine.find((item) => item.project === 'men_singles');
  assert.equal(singles.pool, 'singles');
  assert.equal(singles.matchCount, 2);
  assert.equal(singles.delta, singles.elo - singles.startElo);
});

test('getMyProjects —— 没打过球的人没有任何项目', async () => {
  const none = (await call('getMyProjects', { userId: 'u_admin' })).data;
  assert.deepEqual(none, []);
});

test('getHomeSummary —— 会员数只算审核通过的，榜首只算打过球的', async () => {
  const home = (await call('getHomeSummary')).data;

  assert.equal(home.memberCount, 5, '申请中的那位不能被算进会员数');
  assert.equal(home.matchCount, 4);
  assert.equal(home.eventCount, 1);

  assert.equal(home.topByProject.men_singles.playerCount, 2);
  assert.equal(home.topByProject.women_singles.playerCount, 2);
  assert.equal(home.topByProject.doubles.playerCount, 4);
});

/* ---------- 赛事 ---------- */

test('getEvents —— 原样透传', async () => {
  const res = await call('getEvents');
  assert.deepEqual(res.data.map((e) => e._id), ['ev1']);
});

test('getEventRecord —— 只给这位会员参加过的赛事', async () => {
  const mine = (await call('getEventRecord', { userId: 'u01' })).data;
  assert.equal(mine.records.length, 1);
  assert.equal(mine.records[0].placement, 1);
  assert.deepEqual(mine.summary, {
    eventCount: 1,
    championCount: 1,
    topThreeCount: 1,
    bestPlacement: 1,
  });

  const other = (await call('getEventRecord', { userId: 'u03' })).data;
  assert.deepEqual(other.records, []);
});

/* ---------- 未登录 ---------- */

test('未登录调用写接口 —— 顶层 ok:false，且提示先登录', async () => {
  const ctx = await contextFor(createFixtureRepo(), null);
  const res = await dispatch('submitMatch', {}, ctx);

  assert.equal(res.ok, false);
  assert.equal(res.message, '请先登录后再操作');
});
