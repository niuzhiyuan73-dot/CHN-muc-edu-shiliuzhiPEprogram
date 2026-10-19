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

/** 抓住 Page(配置)：页面文件在 require 时调用 Page()。 */
function loadPage(name) {
  const file = path.join(MINI, 'pages', name, `${name}.js`);
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
  const file = path.join(MINI, 'pages', name, `${name}.wxml`);
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/(?:bind|catch)[a-z]*="([A-Za-z0-9_]+)"/g)) names.add(match[1]);
  return [...names];
}

function read(name, ext) {
  return fs.readFileSync(path.join(MINI, 'pages', name, `${name}.${ext}`), 'utf8');
}

test('cup-home 已注册，四件套齐备，wxml 处理器都存在', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/cup-home/cup-home'), 'cup-home 未在 app.json 注册');
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(path.join(MINI, 'pages', 'cup-home', `cup-home.${ext}`)), `cup-home.${ext} 缺失`);
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
  const wxml = fs.readFileSync(path.join(MINI, 'pages', 'association', 'association.wxml'), 'utf8');
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
    delete require.cache[require.resolve(path.join(MINI, 'pages', 'event-list', 'event-list.js'))];
    require(path.join(MINI, 'pages', 'event-list', 'event-list.js'));
    saved.config.onLoad({ type: 'college' });
  } finally {
    global.Page = saved.Page;
    global.wx = saved.wx;
  }
  assert.deepEqual(redirects, ['/pages/cup-home/cup-home']);
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
