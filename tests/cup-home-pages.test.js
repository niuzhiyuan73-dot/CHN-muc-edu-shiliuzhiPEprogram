/**
 * 石榴籽杯：页面装配与旧入口下线自检
 * ============================================================
 * 学院赛从协会工作台迁入校级活动「石榴籽杯」后，页面问题（漏注册、wxml 绑了
 * 不存在的方法、旧入口没删干净）只有点一遍才会暴露。这里静态比对四件事：
 *   1. cup-home 在 app.json 注册，且 js/json/wxml/wxss 齐备；
 *   2. wxml 里每个事件处理器都在 Page 配置里真实存在；
 *   3. 协会页「校级活动」档有石榴籽杯入口，与运动会并列；
 *   4. 旧入口真的下线了：工作台赛事面板没有学院赛区，event-list 不再有
 *      type=college 分支（只做重定向）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
// 页面已按域拆进分包，路径一律从 app.json 查，见 helpers/page-registry.js
const { pagePathOf, pageFileOf, isRegistered } = require('./helpers/page-registry.js');

/** 抓住 Page(配置)：页面文件在 require 时调用 Page()。 */
function loadPage(name) {
  const file = path.join(MINI, pagePathOf(name));
  const saved = { Page: global.Page, wx: global.wx };
  let captured = null;
  global.Page = (config) => { captured = config; };
  global.wx = global.wx || {};
  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    global.Page = saved.Page;
    global.wx = saved.wx;
  }
  assert.ok(captured, `${name} 没有调用 Page()`);
  return captured;
}

/** wxml 里声明的所有事件处理器名（bindtap / catchtap / bindinput …） */
function handlersOf(name) {
  const file = pageFileOf(name, '.wxml');
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/(?:bind|catch)[a-z]*="([A-Za-z0-9_]+)"/g)) names.add(match[1]);
  return [...names];
}

function read(name, ext) {
  return fs.readFileSync(pageFileOf(name, `.${ext}`), 'utf8');
}

test('cup-home 已注册，四件套齐备，wxml 处理器都存在', () => {
  assert.ok(isRegistered('cup-home'), 'cup-home 未在 app.json 注册（主包或分包）');
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(pageFileOf('cup-home', `.${ext}`)), `cup-home.${ext} 缺失`);
  }

  const page = loadPage('cup-home');
  const missing = handlersOf('cup-home').filter((handler) => typeof page[handler] !== 'function');
  assert.deepEqual(missing, [], 'cup-home 的 wxml 绑定了不存在的方法');

  // 列表页加载、筛选、分页、切换项目、发起、进详情都要接到服务层
  for (const method of ['reload', 'loadMore', 'onPickYear', 'onPickStatus',
    'onPickProject', 'onCreate', 'onOpenEvent']) {
    assert.equal(typeof page[method], 'function', `cup-home 缺少 ${method}`);
  }
  assert.equal(page.data.statusOptions[0].value, '', '状态下拉第一项应为「全部状态」');
  assert.equal(page.data.years[0].value, '', '年份下拉第一项应为「全部年份」');

  const json = JSON.parse(read('cup-home', 'json'));
  assert.equal(json.navigationBarTitleText, '石榴籽杯');
  assert.equal(json.enablePullDownRefresh, true, '杯赛首页支持下拉刷新');
});

test('协会页有石榴籽杯入口，与运动会并列在「校级活动」档', () => {
  const wxml = fs.readFileSync(pageFileOf('association', '.wxml'), 'utf8');
  assert.ok(/assoc-item-cup/.test(wxml), '校级活动档里没有石榴籽杯入口');
  assert.ok(/bindtap="onChooseCup"/.test(wxml), '石榴籽杯入口没有绑定跳转');

  const page = loadPage('association');
  assert.equal(typeof page.onChooseCup, 'function');
});

test('旧学院赛入口已下线：工作台无学院赛区，event-list 无学院赛分支', () => {
  const panel = fs.readFileSync(path.join(MINI, 'components', 'events-panel', 'events-panel.wxml'), 'utf8');
  for (const handler of ['onOpenCollegeEvent', 'onOpenCollegePublish', 'onToggleCollegePin', 'onMoreCollegeEvents']) {
    assert.ok(!panel.includes(handler), `工作台还挂着 ${handler}`);
  }

  const listJs = read('event-list', 'js');
  assert.ok(!listJs.includes('onOpenCollegeEvent'), 'event-list 还留着学院赛行点击');
  assert.ok(/redirectTo[\s\S]*?cup-home/.test(listJs), '旧链接应重定向到杯赛首页');

  // 旧链接确实被重定向，而不是加载第二套列表
  const saved = { Page: global.Page, wx: global.wx };
  const redirects = [];
  global.Page = (config) => { saved.config = config; };
  global.wx = { redirectTo: (opts) => redirects.push(opts.url) };
  try {
    delete require.cache[require.resolve(pageFileOf('event-list', '.js'))];
    require(pageFileOf('event-list', '.js'));
    saved.config.onLoad({ type: 'college' });
  } finally {
    global.Page = saved.Page;
    global.wx = saved.wx;
  }
  assert.deepEqual(redirects, ['/packageCollege/cup-home/cup-home']);
});

test('发布页显示所属项目，且不可在表单内修改', () => {
  const page = loadPage('college-event-edit');
  const wxml = read('college-event-edit', 'wxml');
  assert.ok(wxml.includes('所属项目'), '发布页没有交代所属项目');
  assert.ok(!/bindchange/.test(wxml.match(/所属项目[\s\S]{0,400}?<\/view>/)[0]), '所属项目不可改');

  // 项目名由进入时选定的协会推导
  page.data.projectName = '';
  assert.equal(page.projectNameOf('pkb'), '匹克球');
  assert.equal(page.projectNameOf('no-such-assoc'), '');
});

test('发布页直接带 projectId 进入时锁定到该项目（不经杯赛首页的兜底）', () => {
  const scope = require('../miniprogram/services/association-scope.js');
  scope.setAssociation('pkb');

  const page = loadPage('college-event-edit');
  // 从分享链接直进，带的是乒乓球：应强制归属到 tt，而不是沿用全局的 pkb
  page.applyProjectFromQuery({ projectId: 'tt' });
  assert.equal(scope.getAssociation(), 'tt', '应锁到传入的项目，避免发错协会');

  // 不带 projectId 时不改动，沿用当前全局协会
  page.applyProjectFromQuery({});
  assert.equal(scope.getAssociation(), 'tt', '无 projectId 时不改动当前协会');

  // 已经是目标协会时也不重复写
  page.applyProjectFromQuery({ projectId: 'tt' });
  assert.equal(scope.getAssociation(), 'tt');
});

/* ------------------------------------------------------------ 项目栏与搜索 */

test('项目栏：一屏三个、其余左滑，选中项自动滚进可视区', () => {
  const wxml = read('cup-home', 'wxml');
  const wxss = fs.readFileSync(pageFileOf('cup-home', '.wxss'), 'utf8');

  // 只露三个：宽度按「一屏减留白再三等分」算；多了靠横向滑动，不撑高页头
  assert.ok(/\.cup-project\s*\{[^}]*width:\s*calc\(\(100vw - 96rpx\) \/ 3\)/.test(wxss),
    '项目栏不是「一屏三个」的宽度');
  assert.ok(/scroll-x/.test(wxml) && /scroll-into-view="\{\{projectAnchor\}\}"/.test(wxml),
    '项目栏缺少横向滑动或选中项定位');

  // 选中态必须有实色，否则「当前是哪个项目」只能靠位置猜
  assert.ok(/\.cup-project\.is-active\s*\{[^}]*background:\s*#b23a2e/.test(wxss), '选中项目没有明显底色');

  const page = loadPage('cup-home');
  assert.equal(page.anchorOf('bk'), 'proj-bk', '滚动锚点要按项目 id 给出节点 id');
  assert.equal(page.anchorOf(''), '');
});

test('搜索：一个框同时搜项目与赛事，点项目即切换并清空关键词', async () => {
  const { instantiate, withApi } = require('./helpers/page-harness');
  await withApi({
    listCollegeEvents: () => ({ ok: true, events: [], total: 0, hasMore: false, canManage: false }),
  }, async () => {
    const page = instantiate(loadPage('cup-home'));
    await page.onLoad({ projectId: 'bk' });
    assert.deepEqual(page.data.projectMatches, [], '没输入时不该有项目结果');

    // 「篮球」既是项目名，也可能是赛事名：两样都要命中
    page.onKeywordInput({ detail: { value: '篮球' } });
    assert.deepEqual(page.data.projectMatches.map((item) => item.sportName), ['篮球']);
    assert.equal(page.data.projectMatches[0].current, true, '当前项目要标出来');

    // 换一个字继续搜：项目结果跟着变（本地即时，不等防抖）
    page.onKeywordInput({ detail: { value: '足' } });
    assert.deepEqual(page.data.projectMatches.map((item) => item.sportName), ['足球']);

    // 简称、全称、徽标字也算命中，学校里的叫法长短不一
    page.onKeywordInput({ detail: { value: '民大' } });
    assert.ok(page.data.projectMatches.length >= 4, '按简称应能搜到多个项目');
    page.onKeywordInput({ detail: { value: '足' } });
    page.onPickMatchedProject({ currentTarget: { dataset: { id: 'fb' } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(page.data.projectId, 'fb', '点项目结果应切过去');
    assert.equal(page.data.keyword, '', '切换后不该把项目名继续当赛事关键词');
    assert.deepEqual(page.data.projectMatches, []);
    assert.equal(page.data.projectAnchor, 'proj-fb');
  });
});

test('搜索：赛事关键词防抖、结果聚成一组；清空后恢复状态分组', async () => {
  const { instantiate, withApi } = require('./helpers/page-harness');
  const all = [
    { eventId: 'e1', title: '2026 春季篮球联赛', location: '主体育馆', status: 2, statusLabel: '进行中', legPlanText: '', rosterText: '' },
    { eventId: 'e2', title: '院际杯羽毛球赛', location: '综合馆', status: 0, statusLabel: '报名中', legPlanText: '', rosterText: '' },
  ];
  await withApi({
    listCollegeEvents: (payload) => {
      const rows = payload.keyword
        ? all.filter((row) => row.title.includes(payload.keyword))
        : all;
      return { ok: true, events: rows, total: rows.length, hasMore: false, canManage: false };
    },
  }, async (calls) => {
    const page = instantiate(loadPage('cup-home'));
    await page.onLoad({ projectId: 'pkb' });
    assert.equal(page.data.total, 2);
    assert.equal(page.data.groups.length, 2, '未搜索时按状态分组');

    // 接管定时器：连打两下，只应留下最后一个待执行的回调
    const pending = new Map();
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let seq = 0;
    global.setTimeout = (fn) => { seq += 1; pending.set(seq, fn); return seq; };
    global.clearTimeout = (id) => { pending.delete(id); };
    let timerCount = 0;
    try {
      page.onKeywordInput({ detail: { value: '篮' } });
      page.onKeywordInput({ detail: { value: '篮球' } });
      timerCount = pending.size;
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
    assert.equal(timerCount, 1, '防抖没有生效：每敲一个字都排了一次请求');

    const before = calls.length;
    for (const fn of pending.values()) fn();
    await new Promise((resolve) => realSetTimeout(resolve, 10));
    assert.equal(calls.length, before + 1, '一次搜索只发一次请求');
    assert.equal(calls[calls.length - 1][1].keyword, '篮球');

    assert.equal(page.data.total, 1);
    assert.deepEqual(page.data.groups.map((group) => group.label), ['赛事结果'], '搜索时不再拆成状态分组');
    assert.equal(page.data.groups[0].rows[0].eventId, 'e1');

    // 清空：立刻重取，且请求里不再带关键词
    await page.onClearKeyword();
    await new Promise((resolve) => realSetTimeout(resolve, 10));
    assert.equal(page.data.keyword, '');
    assert.equal(calls[calls.length - 1][1].keyword, undefined, '清空后不该再带 keyword');
    assert.equal(page.data.total, 2);
    assert.equal(page.data.groups.length, 2);
  });
});

test('搜索：过期响应不覆盖最新结果，后台重取不把列表切回加载中', async () => {
  const { instantiate, withApi } = require('./helpers/page-harness');
  let round = 0;
  const resolvers = [];
  await withApi({
    listCollegeEvents: () => {
      round += 1;
      if (round === 1) return { ok: true, events: [], total: 0, hasMore: false, canManage: false };
      return new Promise((resolve) => {
        resolvers.push((total, title) => resolve({ ok: true, total, hasMore: false, canManage: false,
          events: [{ eventId: `e${total}`, title, status: 0, statusLabel: '报名中', legPlanText: '', rosterText: '' }] }));
      });
    },
  }, async () => {
    const page = instantiate(loadPage('cup-home'));
    await page.onLoad({ projectId: 'pkb' });
    const slow = page.reload({ silent: true });
    assert.equal(page.data.loading, false, '搜索中的后台重取不应把整页切回「正在加载」');
    const latest = page.reload({ silent: true });
    // 故意让旧请求后回：最后落屏的必须是新请求那一份
    resolvers[1](2, '新结果');
    resolvers[0](9, '旧结果');
    await Promise.all([slow, latest]);
    assert.equal(page.data.total, 2, '过期响应把列表覆盖了');
    assert.equal(page.data.groups[0].rows[0].title, '新结果');
  });
});

test('团队项目：杯赛页改读学院赛子集，行是同一套结构、路由进团队赛事', async () => {
  const { instantiate, withApi, withWx } = require('./helpers/page-harness');
  const calls = [];
  await withApi({
    listTeamEvents: (payload) => {
      calls.push(payload);
      return {
        ok: true, canManage: true,
        events: [
          { eventId: 'tev:1', name: '2026 石榴籽杯篮球学院赛', format: 'single_elim', status: 'registration',
            statusLabel: '报名中', entryCount: 6, location: '体育馆主馆', canSubmit: true,
            createdAt: '2026-10-01T02:00:00.000Z', isCollegeCup: true },
          { eventId: 'tev:2', name: '2026 春季学院赛', format: 'round_robin', status: 'finished',
            statusLabel: '已结束', entryCount: 8, location: '', canSubmit: false,
            createdAt: '2026-03-01T02:00:00.000Z', isCollegeCup: true },
        ],
      };
    },
  }, async () => {
    const page = instantiate(loadPage('cup-home'));
    await page.onLoad({ projectId: 'bk' });
    assert.equal(page.data.isTeamFeed, true, '篮球是团队项目');
    assert.equal(calls[0].cupMode, 'college', '只取学院赛，不把普通赛事搬进来');

    assert.equal(page.data.total, 2);
    assert.equal(page.data.groups[0].label, '报名中');
    const row = page.data.rows[0];
    assert.equal(row.kind, 'team');
    assert.equal(row.status, 0, '团队赛状态归到四组');
    assert.match(row.metaText, /单败淘汰 · 已报名 6 院/);
    assert.equal(row.actionText, '报名');
    assert.equal(row.canSubmit, true);
    assert.equal(page.data.groups[1].rows[0].status, 3, '已结束归第三组');

    // 状态筛选在页面内按归组筛（下拉第 5 项 = 已结束）
    page.data.statusIndex = 0;
    await page.onPickStatus({ detail: { value: 4 } });
    assert.deepEqual(page.data.rows.map(item => item.eventId), ['tev:2']);

    await withWx(({ navigations }) => {
      page.onOpenEvent({ currentTarget: { dataset: { eventId: 'tev:1', kind: 'team', canSubmit: true } } });
      assert.match(navigations[0], /team-event-detail\?eventId=tev%3A1/);
      page.onCreate();
      assert.match(navigations[1], /team-event-list\?create=1&cupMode=college&projectId=bk/);
    });
  });
});

test('团队赛事的年份筛选与关键词交给服务端，关键词为空时不下发', async () => {
  const { instantiate, withApi } = require('./helpers/page-harness');
  const calls = [];
  await withApi({
    listTeamEvents: (payload) => { calls.push(payload); return { ok: true, canManage: false, events: [] }; },
  }, async () => {
    const page = instantiate(loadPage('cup-home'));
    await page.onLoad({ projectId: 'fb' });
    assert.equal(page.data.isTeamFeed, true);
    assert.equal(calls[0].keyword, undefined, '空关键词不该出现在请求里');
    assert.equal(calls[0].year, undefined);

    page.onKeywordInput({ detail: { value: '学院赛' } });
    await page.onKeywordConfirm();
    assert.equal(calls[calls.length - 1].keyword, '学院赛');
  });
});
