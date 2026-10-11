const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const {
  pickProject,
  buildChart,
  buildHistoryRow,
  loadMemberView,
  DEFAULT_HISTORY_LIMIT,
} = require('../miniprogram/services/profile-view.js');
const { PLACEHOLDER } = require('../miniprogram/utils/format.js');
const { sortProjectsForDisplay } = require('../miniprogram/utils/leaderboard.js');
const { RANK_PROJECT_CONFIG, ROLE, USER_STATUS } = require('../miniprogram/utils/constants.js');
const {
  getMatchHistory,
  getMyProjects,
  setMemberElo,
  resetCache,
} = require('../miniprogram/services/index.js');

/* 模拟数据源默认会装载学院赛演示场景（见 services/college-demo.js），
 * 其中的演示账号 u06 被任命为法学院负责人。本文件断言的是干净种子
 * （u06 还是普通会员），所以每个用例前复位一次——resetCache 同时会
 * 关掉演示场景，之后各用例拿到的都是 24 人基线。 */
beforeEach(() => {
  resetCache();
});

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('sortProjectsForDisplay —— 单打排在双打前面，其余按出场次数', () => {
  // 双打一场四个人，场次天然比单打多；不重排的话页面一打开就是双打
  const projects = [
    { project: 'doubles', pool: 'doubles', matchCount: 52 },
    { project: 'men_singles', pool: 'singles', matchCount: 37 },
  ];
  const sorted = sortProjectsForDisplay(projects);

  assert.deepStrictEqual(sorted.map((item) => item.project), ['men_singles', 'doubles']);
  // 只是展示顺序，不能把调用方传进来的数组就地改掉
  assert.strictEqual(projects[0].project, 'doubles');
});

test('sortProjectsForDisplay —— 没有单打成绩时双打仍排在最前，不会给空页', () => {
  const projects = [{ project: 'doubles', pool: 'doubles', matchCount: 5 }];
  assert.deepStrictEqual(sortProjectsForDisplay(projects).map((item) => item.project), ['doubles']);
  assert.deepStrictEqual(sortProjectsForDisplay(null), []);
});

test('pickProject —— 优先使用调用方指定的项目', () => {
  const projects = [{ project: 'doubles' }, { project: 'men_singles' }];
  assert.strictEqual(pickProject(projects, 'men_singles').project, 'men_singles');
});

test('pickProject —— 指定的项目不存在时退回列表第一个，不返回空', () => {
  // 男会员点不到「女单」，此时不能给空白页。loadMemberView 传进来的
  // 列表已经按「单打在前」排过，所以第一个就是他该看的项目。
  const projects = [{ project: 'men_singles' }, { project: 'doubles' }];
  assert.strictEqual(pickProject(projects, 'women_singles').project, 'men_singles');
});

test('pickProject —— 没有任何项目时返回 null', () => {
  assert.strictEqual(pickProject([], 'doubles'), null);
  assert.strictEqual(pickProject(null), null);
  assert.strictEqual(pickProject(undefined, 'doubles'), null);
});

test('buildChart —— 没打过比赛时曲线只有一个起点', () => {
  const chart = buildChart([], 1000);
  assert.strictEqual(chart.empty, true);
  assert.deepStrictEqual(chart.values, [1000]);
  assert.strictEqual(chart.currentElo, 1000);
  assert.strictEqual(chart.pointCount, 0);
  // 没有对局就谈不上「最大涨幅」，此时必须是 null 而不是编造一个 0
  assert.strictEqual(chart.best, null);
  assert.strictEqual(chart.worst, null);
});

test('buildChart —— 序列首部补上入池起点分', () => {
  // 曲线要从进池那天开始画，这样和图上那条虚线（起点）才衔接得上
  const history = [
    { eloAfter: 1016, eloDelta: 16, matchTime: '2026-04-06T18:00:00' },
    { eloAfter: 1004, eloDelta: -12, matchTime: '2026-04-08T18:00:00' },
    { eloAfter: 1030, eloDelta: 26, matchTime: '2026-04-10T18:00:00' },
  ];
  const chart = buildChart(history, 1000);

  assert.deepStrictEqual(chart.values, [1000, 1016, 1004, 1030]);
  assert.strictEqual(chart.pointCount, 3);
  assert.strictEqual(chart.startElo, 1000);
  assert.strictEqual(chart.currentElo, 1030);
  assert.strictEqual(chart.maxElo, 1030);
  assert.strictEqual(chart.minElo, 1000);
});

test('buildChart —— 单场最大涨幅与最大跌幅单独拎出来', () => {
  const history = [
    { eloAfter: 1016, eloDelta: 16, matchTime: '2026-04-06T18:00:00' },
    { eloAfter: 974, eloDelta: -42, matchTime: '2026-04-08T18:00:00' },
    { eloAfter: 1004, eloDelta: 30, matchTime: '2026-04-10T18:00:00' },
  ];
  const chart = buildChart(history, 1000);

  assert.strictEqual(chart.best.deltaText, '+30');
  assert.strictEqual(chart.best.dateText, '4月10日');
  assert.strictEqual(chart.worst.deltaText, '-42');
  assert.strictEqual(chart.worst.dateText, '4月8日');
});

test('buildChart —— 起点分不同也能正确算涨幅，不假设一定是 1000', () => {
  // 动态初始分机制下，新人的起点可能是 1125 这样的值
  const chart = buildChart([{ eloAfter: 1150, eloDelta: 25, matchTime: '2026-05-01T18:00:00' }], 1125);
  assert.deepStrictEqual(chart.values, [1125, 1150]);
  assert.strictEqual(chart.currentElo, 1150);
});

test('buildHistoryRow —— 双打显示搭档，单打写明「单打」', () => {
  const doubles = buildHistoryRow({
    matchId: 'm1',
    matchTime: '2026-05-01T18:00:00',
    isWin: true,
    opponentNames: ['张三', '李四'],
    partnerNames: ['王五'],
    score: { mine: [11, 12], theirs: [9, 10] },
    eloDelta: 9,
    pointDelta: 3,
    eventId: 'e1',
    pool: 'doubles',
  });

  assert.strictEqual(doubles.rivalText, '张三、李四');
  assert.strictEqual(doubles.partnerText, '搭档 王五');
  assert.strictEqual(doubles.scoreText, '11:9  12:10');
  assert.strictEqual(doubles.resultText, '胜');
  assert.strictEqual(doubles.eloDeltaText, '+9');
  assert.strictEqual(doubles.pointDeltaText, '+3');
  assert.strictEqual(doubles.hasPointDelta, true, '真的有积分时才显示那一行');
  assert.strictEqual(doubles.isEvent, true);
  assert.strictEqual(doubles.poolLabel, '双打');

  const singles = buildHistoryRow({
    matchId: 'm2',
    matchTime: '2026-05-02T18:00:00',
    isWin: false,
    opponentNames: ['张三'],
    partnerNames: [],
    score: { mine: [9], theirs: [11] },
    eloDelta: -14,
    pointDelta: 1,
    eventId: null,
    pool: 'singles',
  });

  assert.strictEqual(singles.partnerText, '单打');
  assert.strictEqual(singles.resultText, '负');
  assert.strictEqual(singles.eloDeltaText, '-14');
  assert.strictEqual(singles.isEvent, false);
  assert.strictEqual(singles.poolLabel, '单打');
});

test('buildHistoryRow —— 分数没涨没跌时显示 0，不显示 -0', () => {
  const row = buildHistoryRow({
    matchId: 'm3',
    matchTime: '2026-05-02T18:00:00',
    isWin: true,
    opponentNames: [],
    partnerNames: [],
    score: { mine: [], theirs: [] },
    eloDelta: -0,
    pointDelta: 0,
    eventId: null,
    pool: 'doubles',
  });

  assert.strictEqual(row.eloDeltaText, '0');
  assert.strictEqual(row.scoreText, PLACEHOLDER);
  // 日常比赛不给积分，0 分那一行整行隐去，不留一句「积分 0」
  assert.strictEqual(row.hasPointDelta, false);
});

test('buildHistoryRow —— 带赛制时渲染成「11 分制 · 三局两胜」', () => {
  const row = buildHistoryRow({
    matchId: 'm4',
    matchTime: '2026-05-02T18:00:00',
    isWin: true,
    opponentNames: ['张三'],
    partnerNames: [],
    score: { mine: [11, 9], theirs: [9, 11] },
    eloDelta: 8,
    pointDelta: 2,
    eventId: null,
    pool: 'singles',
    gamePoints: 11,
    bestOf: 3,
  });

  assert.strictEqual(row.formatText, '11 分制 · 三局两胜');
});

test('buildHistoryRow —— 老数据没有赛制时 formatText 是空串，模板可挡住', () => {
  const row = buildHistoryRow({
    matchId: 'm5',
    matchTime: '2026-05-02T18:00:00',
    isWin: true,
    opponentNames: [],
    partnerNames: [],
    score: { mine: [], theirs: [] },
    eloDelta: 0,
    pointDelta: 0,
    eventId: null,
    pool: 'doubles',
  });

  assert.strictEqual(row.formatText, '');
});

/* ============================================================
 * 二、真实模拟数据的端到端部分
 * ============================================================ */

test('loadMemberView —— 查无此人时如实返回 found:false', async () => {
  const view = await loadMemberView('u99');
  assert.deepStrictEqual(view, { found: false });
});

test('loadMemberView —— 不传 userId 时看的是当前登录会员', async () => {
  const view = await loadMemberView();
  assert.strictEqual(view.found, true);
  assert.strictEqual(view.user.userId, 'u06');
  assert.ok(view.user.nickName.length > 0);
});

test('loadMemberView —— 项目切换标签里恰好有一个是选中的', async () => {
  const view = await loadMemberView();
  const active = view.projectTabs.filter((tab) => tab.active);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].project, view.activeProject);
  assert.strictEqual(view.hasProject, true);
});

test('loadMemberView —— 默认停在单打上，而不是场次更多的双打', async () => {
  const raw = await getMyProjects('u06');
  const singles = raw.find((item) => item.pool === 'singles');
  const doubles = raw.find((item) => item.pool === 'doubles');
  assert.ok(singles, '这位会员应当有单打成绩，否则这条测试没有意义');
  // 双打场次确实更多——正是靠这一点确认「默认单打」不是碰巧
  assert.ok(doubles.matchCount > singles.matchCount);

  const view = await loadMemberView('u06');

  assert.strictEqual(view.activeProject, singles.project);
  assert.strictEqual(view.projectTabs[0].active, true, '默认项目应当排在标签首位');
});

test('loadMemberView —— 分数卡与曲线的末点必须是同一个数', async () => {
  // 这两处分别从「池快照」和「逐场流水」算出来，是对同一事实的两种推导。
  // 一旦对不上，说明回放链路里有一环算错了。
  const view = await loadMemberView();
  assert.strictEqual(view.chart.currentElo, view.summary.elo);
  assert.strictEqual(view.chart.values[0], view.summary.startElo);
  assert.strictEqual(view.chart.values.length, view.chart.pointCount + 1);
});

test('loadMemberView —— 曲线的高低点与数据一致', async () => {
  const view = await loadMemberView();
  const values = view.chart.values;
  assert.strictEqual(view.chart.maxElo, Math.max(...values));
  assert.strictEqual(view.chart.minElo, Math.min(...values));
});

test('loadMemberView —— 分数卡上的名次和百分位都算得出来', async () => {
  const view = await loadMemberView();
  assert.ok(view.summary.rank >= 1);
  assert.ok(view.summary.total >= view.summary.rank);
  assert.match(view.summary.rankText, /第 \d+ \/ \d+ 名/);
  assert.match(view.summary.beatText, /超过 \d+% 的会员/);
  assert.strictEqual(view.summary.matchCount, view.summary.wins + view.summary.losses);
});

test('loadMemberView —— 交锋记录里每行的胜负之和等于交手场次', async () => {
  const view = await loadMemberView();
  assert.ok(view.headToHead.length > 0, '默认视角应当有交锋记录');

  for (const row of view.headToHead) {
    const matched = /^(\d+) 胜 (\d+) 负$/.exec(row.recordText);
    assert.ok(matched, `无法解析的胜负文案：${row.recordText}`);
    assert.strictEqual(Number(matched[1]) + Number(matched[2]), row.matchCount);
  }
});

test('loadMemberView —— 逐场战绩按时间倒序，最近的排在最前', async () => {
  // 比对原始流水，确认页面这一份既没有被打乱、也没有漏掉任何一场。
  // 只检查日期文案是不够的——同一天可能有好几场，顺序错了也看不出来。
  const view = await loadMemberView('u06', { historyLimit: DEFAULT_HISTORY_LIMIT });
  // 逐场战绩是按「池」过滤的：项目只是展示口径，池才是比赛流水口径
  const raw = await getMatchHistory('u06', {
    pool: RANK_PROJECT_CONFIG[view.activeProject].pool,
    limit: DEFAULT_HISTORY_LIMIT,
  });

  assert.ok(raw.length > 1);
  assert.deepStrictEqual(
    view.history.map((row) => row.matchId),
    raw.map((row) => row.matchId)
  );

  for (let i = 1; i < raw.length; i += 1) {
    assert.ok(
      new Date(raw[i - 1].matchTime) >= new Date(raw[i].matchTime),
      '流水必须是时间倒序的'
    );
  }
});

test('loadMemberView —— 逐场战绩条数受 historyLimit 限制', async () => {
  const view = await loadMemberView(null, { historyLimit: 3 });
  assert.ok(view.history.length <= 3);
  assert.ok(view.history.length > 0);
});

test('loadMemberView —— 赛事汇总与赛事明细对得上', async () => {
  const view = await loadMemberView();
  assert.strictEqual(view.events.summary.eventCount, view.events.records.length);

  for (const record of view.events.records) {
    assert.ok(record.placement >= 1);
    assert.ok(record.participantCount > 0);
    // 名次不可能比参赛人数还靠后
    assert.ok(record.placement <= record.participantCount);
    assert.notStrictEqual(record.placementText, PLACEHOLDER);
  }
});

test('loadMemberView —— 近期状态最多 5 个点', async () => {
  const view = await loadMemberView();
  assert.ok(view.form.dots.length <= 5);
  for (const dot of view.form.dots) {
    assert.ok(dot === 'W' || dot === 'L');
  }
  assert.strictEqual(view.form.wins + view.form.losses, view.form.dots.length);
});

test('loadMemberView —— 切换项目之后整页数据都跟着换', async () => {
  const view = await loadMemberView(null, { project: 'men_singles' });

  assert.strictEqual(view.activeProject, 'men_singles');
  assert.strictEqual(view.activeProjectLabel, '男单');

  // 这是本页最重要的不变式：切到男单之后，下面每一行都必须是单打
  for (const row of view.history) {
    assert.strictEqual(row.poolLabel, '单打');
    assert.strictEqual(row.partnerText, '单打');
  }
  for (const record of view.events.records) {
    assert.strictEqual(record.title.includes('双打'), false);
  }
  // 单打没有搭档，搭档记录必须为空，而不是把别的池的搭档混进来
  assert.strictEqual(view.partners.length, 0);
});

test('loadMemberView —— 切到双打时每行都有搭档', async () => {
  const view = await loadMemberView(null, { project: 'doubles' });

  assert.strictEqual(view.activeProject, 'doubles');
  assert.ok(view.history.length > 0);
  for (const row of view.history) {
    assert.strictEqual(row.poolLabel, '双打');
    assert.ok(row.partnerText.startsWith('搭档 '), `双打必须有搭档：${row.partnerText}`);
  }
  assert.ok(view.partners.length > 0, '双打视角应当有搭档记录');
});

test('loadMemberView —— 指定的项目不存在时退回默认项目，而不是给空白页', async () => {
  // 赵明宇是男会员，没有女单成绩
  const view = await loadMemberView(null, { project: 'women_singles' });
  assert.strictEqual(view.found, true);
  assert.strictEqual(view.hasProject, true);
  assert.notStrictEqual(view.activeProject, 'women_singles');
  assert.ok(view.history.length > 0);
});

test('loadMemberView —— 曲线点数等于该项目的出场次数', async () => {
  const view = await loadMemberView(null, { project: 'doubles' });
  // 出场多少次就有多少个赛后分，再加上首部的入池起点分
  assert.strictEqual(view.chart.pointCount, view.summary.matchCount);
});

test('loadMemberView —— 不同会员看到的是各自的数据', async () => {
  const me = await loadMemberView('u06');
  const other = await loadMemberView('u01');

  assert.strictEqual(other.user.userId, 'u01');
  assert.notStrictEqual(other.user.nickName, me.user.nickName);
  assert.notStrictEqual(other.summary.elo, me.summary.elo);
});

test('loadMemberView —— 头卡同时给出昵称与真名，真名另标一个字段', async () => {
  const view = await loadMemberView('u06');

  // 昵称在主位，真名另存一处交给模板以小字并排渲染
  assert.strictEqual(view.user.nickName, '明宇');
  assert.strictEqual(view.user.realName, '赵明宇');
  assert.strictEqual(view.user.showRealName, true);
  // 学号也带出来，编辑页要展示且不可改
  assert.ok(view.user.studentId);
});

test('loadMemberView —— 头像缺省时用昵称首字兜底', async () => {
  const view = await loadMemberView('u06');
  assert.strictEqual(view.user.avatarText, view.user.nickName.slice(0, 1));
});

/* ============================================================
 * 任免学院负责人的入口
 * ============================================================
 * 种子里 u01 巴特尔是管理员、u02 张宇轩是学院负责人，其余是普通会员。
 * 按钮只该出现在「管理员看别人的主页」这一种情形里。
 * ============================================================ */

const ADMIN_VIEWER = { _id: 'u01', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };
const STAFF_VIEWER = { _id: 'u02', role: ROLE.STAFF, status: USER_STATUS.ACTIVE };

test('loadMemberView —— 管理员看普通会员，入口是「设为学院负责人」', async () => {
  const view = await loadMemberView('u06', { viewer: ADMIN_VIEWER });
  assert.strictEqual(view.leader.visible, true);
  assert.strictEqual(view.leader.makeLeader, true);
  assert.strictEqual(view.leader.label, '设为学院负责人');
  assert.ok(view.leader.hint);
});

test('loadMemberView —— 管理员看已经是学院负责人的人，入口翻成「撤销学院负责人」', async () => {
  const view = await loadMemberView('u02', { viewer: ADMIN_VIEWER });
  assert.strictEqual(view.leader.visible, true);
  assert.strictEqual(view.leader.makeLeader, false);
  assert.strictEqual(view.leader.label, '撤销学院负责人');
});

test('loadMemberView —— 看自己的主页不给入口', async () => {
  const view = await loadMemberView('u01', { viewer: ADMIN_VIEWER });
  assert.strictEqual(view.leader.visible, false);
});

test('loadMemberView —— 学院负责人与普通会员都看不到入口，访客同理', async () => {
  // 任免只给管理员（见 member-review.canSetCollegeLeader）
  assert.strictEqual((await loadMemberView('u06', { viewer: STAFF_VIEWER })).leader.visible, false);
  assert.strictEqual(
    (await loadMemberView('u06', { viewer: { _id: 'u06', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE } }))
      .leader.visible,
    false
  );
  // 不传 viewer 时按「没有旁观者」处理，一律不出现
  assert.strictEqual((await loadMemberView('u06')).leader.visible, false);
});

/* ============================================================
 * 协会负责人任免入口（仅全局管理员）
 * ============================================================
 * 协会负责人的**有效角色**也是 ADMIN，单看 role 分不出他与全局管理员。
 * 所以这条入口只认 isGlobalAdmin——否则协会负责人就能反手把自己人提成
 * 协会负责人，层层自封（见 member-review.validateAssociationLeader）。
 * ============================================================ */

/** 全局管理员：既有 ADMIN 角色，也带 isGlobalAdmin 标记 */
const GLOBAL_ADMIN_VIEWER = {
  _id: 'u01',
  role: ROLE.ADMIN,
  status: USER_STATUS.ACTIVE,
  isGlobalAdmin: true,
};

test('loadMemberView —— 协会负责人入口只对全局管理员出现，文案随目标身份翻转', async () => {
  const asGlobalAdmin = await loadMemberView('u06', { viewer: GLOBAL_ADMIN_VIEWER });
  assert.strictEqual(asGlobalAdmin.associationLeader.visible, true);
  assert.strictEqual(asGlobalAdmin.associationLeader.makeLeader, true);
  assert.strictEqual(asGlobalAdmin.associationLeader.label, '设为协会负责人');
  assert.ok(asGlobalAdmin.associationLeader.hint);
});

test('loadMemberView —— 协会负责人与学院负责人、普通会员、访客都看不到协会负责人入口', async () => {
  // 有效角色同为 ADMIN 的协会负责人（isGlobalAdmin=false）也进不来
  const assocLeaderViewer = {
    _id: 'u06',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    isGlobalAdmin: false,
  };
  assert.strictEqual(
    (await loadMemberView('u05', { viewer: assocLeaderViewer })).associationLeader.visible,
    false
  );
  assert.strictEqual((await loadMemberView('u06', { viewer: STAFF_VIEWER })).associationLeader.visible, false);
  assert.strictEqual(
    (await loadMemberView('u06', { viewer: { _id: 'u05', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE } }))
      .associationLeader.visible,
    false
  );
  assert.strictEqual((await loadMemberView('u06')).associationLeader.visible, false);
});

test('loadMemberView —— 看自己的主页不给协会负责人入口', async () => {
  const view = await loadMemberView('u01', { viewer: GLOBAL_ADMIN_VIEWER });
  assert.strictEqual(view.associationLeader.visible, false);
});

/* ============================================================
 * 角色徽标：协会负责人要显「协会负责人」，不是「管理员」
 * ============================================================
 * 协会负责人的有效角色也是 ADMIN，但它是**本协会**给的身份。徽标要按
 * isGlobalAdmin 把两种人分开（见 profile-view.roleLabelOf），否则协会
 * 负责人会在本协会里被显示成跨协会的「管理员」。
 * ============================================================ */

test('loadMemberView —— 全局管理员显「管理员」，协会负责人显「协会负责人」', async () => {
  // u01 是全站唯一的全局管理员
  assert.strictEqual((await loadMemberView('u01')).user.roleLabel, '管理员');
  // u09 在默认协会 pkb 是协会负责人：有效角色 ADMIN，但不是全局管理员
  assert.strictEqual((await loadMemberView('u09')).user.roleLabel, '协会负责人');
});

test('loadMemberView —— 学院负责人与普通会员的角色徽标照旧', async () => {
  assert.strictEqual((await loadMemberView('u02')).user.roleLabel, '学院负责人');
  assert.strictEqual((await loadMemberView('u06')).user.roleLabel, '会员');
});

test('loadMemberView —— 角色徽标随协会变化：u04 在 tt 是协会负责人，在 pkb 只是会员', async () => {
  assert.strictEqual((await loadMemberView('u04', { association: 'tt' })).user.roleLabel, '协会负责人');
  assert.strictEqual((await loadMemberView('u04', { association: 'pkb' })).user.roleLabel, '会员');
});

/* ============================================================
 * 当前等级分调整入口
 * ============================================================
 * 出过场的人也能改——用来同步「在外面打完比赛」的分数。改的是**当前显示
 * 项目**对应的池，所以入口只有在该会员有项目时才出现。
 * ============================================================ */

test('loadMemberView —— 有权限时出现当前等级分入口，跟着当前项目走', async () => {
  const view = await loadMemberView('u06', { viewer: GLOBAL_ADMIN_VIEWER });
  assert.strictEqual(view.currentElo.visible, true);
  // 入口作用在当前显示的项目上
  assert.strictEqual(view.currentElo.project, view.activeProject);
  assert.strictEqual(view.currentElo.label, view.activeProjectLabel);
  // 当前值就是该项目解析出来的原始分数
  assert.strictEqual(typeof view.currentElo.current, 'number');
});

test('loadMemberView —— 普通会员看不到当前等级分入口', async () => {
  const view = await loadMemberView('u06', {
    viewer: { _id: 'u05', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(view.currentElo.visible, false);
});

test('loadMemberView —— 改分后入口显示新值', async () => {
  const before = await loadMemberView('u06', { viewer: GLOBAL_ADMIN_VIEWER });
  const pool = before.currentElo.pool;

  const set = await setMemberElo('u06', pool, 1750, 'u01');
  assert.strictEqual(set.ok, true, set.message);

  const after = await loadMemberView('u06', {
    viewer: GLOBAL_ADMIN_VIEWER,
    project: before.activeProject,
  });
  assert.strictEqual(after.currentElo.current, 1750);
});
