/**
 * 云函数数据集派生 —— 锚点、缓存与台账
 * ============================================================
 * 等级分不落库，每次读都由比赛流水重放出来（理由见 derive.js）。这条
 * 路线能不能站住，全看三件事：
 *   1. 赛季锚点被钉死，撤销一场比赛不会让全站分数静默漂移；
 *   2. 写操作让缓存失效，改了分数下一次读就能看见；
 *   3. 待确认的比赛进不了回放，「对手确认」这道闸门真的挡得住。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const { getDataset, resetMemo } = require('../cloudfunctions/data/src/core/derive.js');
const { SEASON_ID } = require('../cloudfunctions/data/src/core/season.js');
const { USERS, MATCHES, NOW, createFixtureRepo, contextFor } = require('./helpers/cloud-fixture.js');

const MATCH_FORM = {
  matchType: 1,
  teamA: ['u01'],
  teamB: ['u02'],
  scoreA: [11],
  scoreB: [9],
  gamePoints: 11,
  bestOf: 1,
  matchTime: '2026-05-01T18:00:00',
  recorder: 'u01',
};

/** 造一场单打 */
function singles(id, winnerId, loserId, matchTime, recorder = winnerId) {
  return {
    _id: id,
    matchType: 1,
    pool: 'singles',
    teamA: [winnerId],
    teamB: [loserId],
    scoreA: [11],
    scoreB: [9],
    gamePoints: 11,
    bestOf: 1,
    winner: 'A',
    location: '',
    matchTime,
    recorder,
    eventId: null,
    status: 1,
  };
}

/**
 * 一套带「中途入会者」的数据。
 *
 * u_late 在 2026-04-15 入会，晚于赛季首场（04-08），所以他要按前几场
 * 对手的水平定级。一旦锚点漂到 04-15 之后，他就被当成创始会员，
 * 定级分凭空消失——这正是锚点必须钉死的原因。
 */
function lateJoinerRepo() {
  const late = {
    ...USERS[1],
    _id: 'u_late',
    openId: 'openid-late',
    nickName: '晚',
    joinDate: '2026-04-15T00:00:00',
  };

  return createFixtureRepo({
    users: [...USERS, late],
    matches: [
      singles('p1', 'u01', 'u02', '2026-04-08T18:00:00'),
      singles('p2', 'u_late', 'u01', '2026-04-20T18:00:00'),
      singles('p3', 'u_late', 'u02', '2026-04-22T18:00:00'),
    ],
  });
}

const seasonStartOf = (dataset) => new Date(dataset.meta.seasonStart).getTime();

/* ---------- 锚点 ---------- */

test('只读接口不写库 —— 还没写过时，赛季文档根本不存在', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const dataset = await getDataset(ctx);

  assert.equal(seasonStartOf(dataset), new Date('2026-04-08T18:00:00').getTime());
  assert.equal(await repo.seasons.get(SEASON_ID), null, '读操作不该在数据库里留下痕迹');
});

test('首次写入把锚点钉在当前已知最早一场，而不是这次写的那一场', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  // 录一场五月的比赛；此刻已知最早的是四月的 m1
  await dispatch('submitMatch', MATCH_FORM, ctx);

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(season.version, 1);
  assert.equal(
    new Date(season.anchorTime).getTime(),
    new Date('2026-04-08T18:00:00').getTime(),
    '锚点必须钉在最早一场，否则四月入会者会被重新定级'
  );
});

test('锚点钉死 —— 撤销一场晚些的比赛不会把中途入会者变成创始会员', async () => {
  const repo = lateJoinerRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const before = await getDataset(admin);
  assert.equal(seasonStartOf(before), new Date('2026-04-08T18:00:00').getTime());
  assert.ok(
    Object.prototype.hasOwnProperty.call(before.meta.placements, 'u_late'),
    '前提：u_late 是中途入会者，拿得到定级分'
  );

  // p3 是 u_late 录的，时间是 04-22——比最早一场晚得多
  const revoked = await dispatch('revokeMatch', { id: 'p3', reason: '重复录入' }, admin);
  assert.equal(revoked.data.ok, true);

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(
    new Date(season.anchorTime).getTime(),
    new Date('2026-04-08T18:00:00').getTime(),
    '锚点只能盯最早一场，不能被这次撤销的那一场带跑'
  );

  const after = await getDataset(admin);
  assert.equal(seasonStartOf(after), new Date('2026-04-08T18:00:00').getTime());
  assert.ok(
    Object.prototype.hasOwnProperty.call(after.meta.placements, 'u_late'),
    '锚点钉死后，撤销晚些的比赛不该让 u_late 重新分类'
  );
});

test('锚点一旦落库，再撤最早那场也不动它', async () => {
  const repo = lateJoinerRepo();
  const admin = await contextFor(repo, 'openid-admin');

  // 先让锚点落库
  await dispatch('submitMatch', MATCH_FORM, admin);
  const pinned = (await repo.seasons.get(SEASON_ID)).anchorTime;

  await dispatch('revokeMatch', { id: 'p1', reason: '日期录错了' }, admin);

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(
    new Date(season.anchorTime).getTime(),
    new Date(pinned).getTime(),
    '最早那场没了，锚点也要留在原地——这正是「钉死」二字的意思'
  );

  const after = await getDataset(admin);
  assert.equal(seasonStartOf(after), new Date(pinned).getTime());
  assert.ok(Object.prototype.hasOwnProperty.call(after.meta.placements, 'u_late'));
});

/* ---------- 缓存 ---------- */

test('写操作让版本号 +1，下一次读拿到的是新数据集', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const before = await getDataset(ctx);
  assert.equal(before.ledger.length, 4);

  await dispatch('submitMatch', MATCH_FORM, ctx);

  const after = await getDataset(ctx);
  assert.notEqual(after, before, '版本变了，缓存必须失效');
  assert.equal(after.ledger.length, 5, '新录的比赛要马上出现在台账里');

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(season.version, 1);
});

test('没有写入时，重复读命中同一份数据集', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const first = await getDataset(ctx);
  const second = await getDataset(ctx);

  assert.equal(second, first, '没有写操作就不该反复重放');
});

/* ---------- 台账与回放名单 ---------- */

test('待确认的比赛进台账，但不进回放名单', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const before = await getDataset(ctx);
  const eloBefore = before.users.find((u) => u._id === 'u01').ratings.singles.elo;

  const submitted = await dispatch('submitMatch', MATCH_FORM, ctx);
  const id = submitted.data.match._id;

  const after = await getDataset(ctx);
  const pending = after.ledger.find((m) => m._id === id);

  assert.equal(pending.status, 0, '录入一律以「待确认」入账');
  assert.equal(pending.players, undefined, '没进回放，就不该有逐人明细');
  assert.ok(!after.matches.some((m) => m._id === id), '待确认的比赛不在已生效流水里');

  const eloAfter = after.users.find((u) => u._id === 'u01').ratings.singles.elo;
  assert.equal(eloAfter, eloBefore, '没确认之前，等级分一分都不该动');
});

test('确认之后成绩立刻计入，且带上逐人明细', async () => {
  const repo = createFixtureRepo();
  const recorder = await contextFor(repo, 'openid-u01');

  const submitted = await dispatch('submitMatch', MATCH_FORM, recorder);
  const id = submitted.data.match._id;

  const opponent = await contextFor(repo, 'openid-u02');
  assert.equal((await dispatch('confirmMatch', { id }, opponent)).data.ok, true);

  const after = await getDataset(recorder);
  const active = after.matches.find((m) => m._id === id);

  assert.ok(active, '确认后这场比赛应进入已生效流水');
  assert.equal(active.players.length, 2);
  assert.deepEqual(active.players.map((p) => p.userId).sort(), ['u01', 'u02']);
});

test('已撤销的比赛留在台账里，但不再参与回放', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const before = await getDataset(admin);
  assert.ok(before.matches.some((m) => m._id === 'm1'));

  await dispatch('revokeMatch', { id: 'm1', reason: '对手记错了' }, admin);

  const after = await getDataset(admin);
  const record = after.ledger.find((m) => m._id === 'm1');

  assert.equal(record.status, 2, '撤销只是改状态，记录要留痕');
  assert.ok(!after.matches.some((m) => m._id === 'm1'), '已撤销的不再计入等级分');
  assert.equal(after.matches.length, MATCHES.length - 1);
});

test('夹具里的时间基准没有漂移', () => {
  // 这条断言只是提醒后来人：改动夹具的时间会让上面所有断言一起失效
  assert.equal(NOW.getTime(), new Date('2026-06-01T12:00:00').getTime());
});

/* ---------- 排行榜快照（rankings） ---------- */

test('读一次就把排行榜快照落库，冷启动不必再全表读 + 重放', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const first = await getDataset(ctx);
  const snapshot = await repo.rankings.get('current');
  assert.ok(snapshot, '读过一次之后，rankings 里应留下快照');
  assert.ok(!snapshot.data.nameOf, 'nameOf 是函数，落不了库，快照里不该有它');
  assert.equal(snapshot.data.ledger.length, first.ledger.length);

  // 模拟云函数冷启动：容器里的 WeakMap 缓存没了，只剩数据库里的快照
  resetMemo(repo);
  let listCalls = 0;
  const originalList = repo.users.list;
  repo.users.list = () => {
    listCalls += 1;
    return originalList();
  };

  const second = await getDataset(ctx);
  repo.users.list = originalList;

  assert.equal(listCalls, 0, '命中快照就不该再读原始集合');
  assert.equal(second.ledger.length, first.ledger.length);
  assert.equal(second.nameOf('u01'), '甲', '快照读回来要能重建 nameOf');
});

test('快照键对不上就重算，不会拿旧分数糊弄', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  await getDataset(ctx);
  const stale = await repo.rankings.get('current');
  // 把键改坏，等价于「数据变了但快照没跟着更新」这种最坏情况
  await repo.rankings.set('current', { ...stale, key: 'bogus' });

  resetMemo(repo);
  const dataset = await getDataset(ctx);

  assert.equal(dataset.ledger.length, 4, '键对不上就必须重放，不能沿用旧快照');
  const refreshed = await repo.rankings.get('current');
  assert.notEqual(refreshed.key, 'bogus', '重算后要把正确的快照写回');
});

test('快照被改坏时退回重放，而不是把读接口带崩', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  await getDataset(ctx);
  const good = await repo.rankings.get('current');
  // 缺了必备字段，等价于控制台里被人手改坏
  await repo.rankings.set('current', { ...good, data: { users: null, ledger: null } });

  resetMemo(repo);
  const dataset = await getDataset(ctx);

  assert.equal(dataset.ledger.length, 4, '坏快照必须被忽略，退回现场重放');
});

test('写操作让快照作废，冷启动后读到的仍是新流水', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  await getDataset(ctx);
  const before = await repo.rankings.get('current');

  await dispatch('submitMatch', MATCH_FORM, ctx);

  resetMemo(repo);
  const after = await getDataset(ctx);

  assert.equal(after.ledger.length, 5, '新录的比赛必须出现在快照重算后的台账里');
  const snapshot = await repo.rankings.get('current');
  assert.notEqual(snapshot.key, before.key, '版本号变了，快照的键也必须跟着变');
});

/* ---------- 写库必 +1：裁判与学院赛小场 ---------- */
/*
 * 等级分不落库、全靠重放，所以「读到的数据」是按赛季版本号缓存的。
 * 凡是写了 matches / events 的动作都必须 bumpSeason，否则新值要等某次
 * 无关写入才「自己好了」——表现为「指派了裁判却看不见」「刚开台就报
 * 找不到这场比赛」。下面三条按「那个动作该让谁看见」来钉。
 */

/** 一条待确认的单打（裁判指派只认待确认） */
function pendingSingles(id, teamA, teamB, matchTime = '2026-05-02T18:00:00') {
  return {
    _id: id,
    matchType: 1,
    pool: 'singles',
    teamA,
    teamB,
    scoreA: [],
    scoreB: [],
    gamePoints: 11,
    bestOf: 1,
    winner: null,
    location: '',
    matchTime,
    recorder: '',
    eventId: null,
    status: 0,
  };
}

test('指派个人赛裁判让版本号 +1 —— 不 +1 就是「指派了看不见」', async () => {
  const repo = createFixtureRepo({
    matches: [...MATCHES, pendingSingles('p_ref', ['u01'], ['u02'])],
  });
  const admin = await contextFor(repo, 'openid-admin');

  const before = await getDataset(admin);
  assert.equal(before.ledger.find((m) => m._id === 'p_ref').referee, undefined, '前提：还没指派');

  const res = await dispatch('assignMatchReferee', { matchId: 'p_ref', refereeId: 'u03' }, admin);
  assert.equal(res.data.ok, true, res.data.message);

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(season.version, 1, 'referee 只从 dataset 读得到，写了就得让缓存失效');

  const after = await getDataset(admin);
  assert.notEqual(after, before, '版本变了，缓存必须失效');
  assert.equal(
    after.ledger.find((m) => m._id === 'p_ref').referee,
    'u03',
    '不 +1 的话，改派后的裁判在明细里看不见，参赛者也照样能录分'
  );
});

/** 一场学院赛大场：双方排阵已齐，等管理员点「开始」 */
function collegeFixture(overrides = {}) {
  const lineup = (college, players) => ({
    _id: `ln_${college}`,
    eventId: 'ce1',
    tieId: 't1',
    college,
    entries: [{ legNo: 1, players }],
  });

  return createFixtureRepo({
    collegeEvents: [{ _id: 'ce1', title: '学院杯', location: '体育馆', status: 1 }],
    ties: [
      {
        _id: 't1',
        eventId: 'ce1',
        round: 1,
        stage: 'main',
        slot: 1,
        collegeA: '甲院',
        collegeB: '乙院',
        lineupA: true,
        lineupB: true,
        legs: [{ legNo: 1, discipline: 'MS', matchId: '' }],
        status: 1,
        ...overrides.tie,
      },
    ],
    lineups: [lineup('甲院', ['u01']), lineup('乙院', ['u02'])],
    ...overrides.repo,
  });
}

test('开始大场让版本号 +1 —— 不 +1，刚生成的小场就查不到', async () => {
  const repo = collegeFixture();
  const admin = await contextFor(repo, 'openid-admin');

  const legId = 'l_ce1_t1_1';
  const before = await getDataset(admin);
  assert.ok(!before.ledger.some((m) => m._id === legId), '前提：小场还没生成');

  const res = await dispatch('startTie', { tieId: 't1' }, admin);
  assert.equal(res.data.ok, true, res.data.message);
  assert.deepEqual(res.data.legs.map((leg) => leg._id), [legId]);

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(season.version, 1, '小场落的是 matches 集合，必须让缓存失效');

  const after = await getDataset(admin);
  assert.notEqual(after, before);
  assert.ok(
    after.ledger.some((m) => m._id === legId),
    '不 +1，紧接着的录分会报「找不到这场比赛」'
  );
});

test('指派大场裁判让版本号 +1，且下发到名下小场', async () => {
  const repo = collegeFixture({
    tie: { status: 2, legs: [{ legNo: 1, discipline: 'MS', matchId: 'leg1' }] },
    repo: {
      matches: [
        ...MATCHES,
        { ...pendingSingles('leg1', ['u01'], ['u02']), collegeEventId: 'ce1', tieId: 't1' },
      ],
    },
  });
  const admin = await contextFor(repo, 'openid-admin');

  const before = await getDataset(admin);
  assert.equal(before.ledger.find((m) => m._id === 'leg1').referee, undefined, '前提：还没指派');

  const res = await dispatch('assignTieReferee', { tieId: 't1', refereeId: 'u03' }, admin);
  assert.equal(res.data.ok, true, res.data.message);
  assert.deepEqual(res.data.matches.map((m) => m._id), ['leg1'], '一次指派要落到名下每一场小场');

  const season = await repo.seasons.get(SEASON_ID);
  assert.equal(season.version, 1, '小场的 referee 从 dataset 读，必须让缓存失效');

  const after = await getDataset(admin);
  assert.notEqual(after, before);
  assert.equal(
    after.ledger.find((m) => m._id === 'leg1').referee,
    'u03',
    '不 +1，小场看不到裁判，改派后的权限收窄也不生效'
  );
});
