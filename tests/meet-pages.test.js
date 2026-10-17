/**
 * B4b：运动会三个页面的装配自检
 * ============================================================
 * 页面问题（require 路径写错、wxml 里 bindtap 指向不存在的方法、页面没注册）
 * 只有在开发者工具里点一遍才会暴露。这里用最小环境把 Page 配置抓下来，
 * 静态比对三件事：
 *   1. 三个页面都在 app.json 注册，且四件套齐备；
 *   2. wxml 里每一个 bind/catch 处理器都在 Page 配置里真实存在；
 *   3. 协会页（tabBar 第 2 页）里有运动会入口，且入口跳的是运动会列表（R01）；
 *   4. 列表页标题就是「历史运动会记录」（R02：只有一个一级标签）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

const PAGES = ['meet-list', 'meet-detail', 'meet-setup', 'meet-college', 'meet-schedule', 'meet-score'];

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

test('运动会六个页面都已注册，且 js/json/wxml/wxss 齐备', () => {
  const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
  for (const name of PAGES) {
    assert.ok(app.pages.includes(`pages/${name}/${name}`), `${name} 未在 app.json 注册`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(path.join(MINI, 'pages', name, `${name}.${ext}`)), `${name}.${ext} 缺失`);
    }
  }
});

test('wxml 里的每个事件处理器都在 Page 配置中', () => {
  for (const name of PAGES) {
    const page = loadPage(name);
    const missing = handlersOf(name).filter((handler) => typeof page[handler] !== 'function');
    assert.deepEqual(missing, [], `${name} 的 wxml 绑定了不存在的方法`);
  }
});

test('列表页标题为「历史运动会记录」，且只有一个一级标签', () => {
  const json = JSON.parse(fs.readFileSync(path.join(MINI, 'pages', 'meet-list', 'meet-list.json'), 'utf8'));
  assert.equal(json.navigationBarTitleText, '历史运动会记录');

  // R02：列表页没有 tab 切换控件（不新增一级标签）
  const wxml = fs.readFileSync(path.join(MINI, 'pages', 'meet-list', 'meet-list.wxml'), 'utf8');
  assert.equal(/tab-item|tabs|segmented/.test(wxml), false, '列表页不应出现一级标签切换');
});

test('协会页里有运动会入口，与协会并列并跳运动会列表（R01）', () => {
  const wxml = fs.readFileSync(path.join(MINI, 'pages', 'association', 'association.wxml'), 'utf8');
  assert.ok(/assoc-item-meet/.test(wxml), '协会网格里没有运动会入口');
  assert.ok(/bindtap="onChooseMeet"/.test(wxml), '运动会入口没有绑定跳转');

  const page = loadPage('association');
  assert.equal(typeof page.onChooseMeet, 'function');
});

test('列表页加载、搜索、分页与详情跳转都接到服务层', () => {
  const page = loadPage('meet-list');
  for (const method of ['reload', 'loadMore', 'onSearch', 'onYearChange', 'onStatusChange', 'onOpenMeet', 'onCreate']) {
    assert.equal(typeof page[method], 'function', `缺少 ${method}`);
  }
  assert.equal(page.data.years[0].value, '', '年份下拉第一项应为「全部年份」');
  assert.equal(page.data.statusOptions[0].value, '', '状态下拉第一项应为「全部状态」');
});

test('详情页与向导页的关键动作存在', () => {
  const detail = loadPage('meet-detail');
  for (const method of ['reload', 'onPublish', 'onDelete', 'onOpenSetup', 'onOpenAtChange', 'onCloseAtChange',
    'onInterest', 'onWithdrawInterest', 'onReview', 'onOpenCollege', 'onOpenSchedule', 'onOpenScore']) {
    assert.equal(typeof detail[method], 'function', `详情页缺少 ${method}`);
  }
  const setup = loadPage('meet-setup');
  for (const method of ['loadTemplates', 'onNext', 'onToggleGroup', 'onStep', 'onSubmit', 'onCategoryTap',
    'onPickRounds', 'onPickFormat', 'onMembersInput', 'onLimitInput',
    'onToggleMembersUnlimited', 'onToggleLimitUnlimited',
    'onGroupCountInput', 'onAdvancePerGroupInput', 'pickedFromEvents']) {
    assert.equal(typeof setup[method], 'function', `向导页缺少 ${method}`);
  }
  // 带 meetId 进入时应直接落在第二步（继续配置）
  assert.equal(setup.data.step, 1, '无 meetId 时应从第一步开始');

  const college = loadPage('meet-college');
  for (const method of ['reload', 'onOpenEvent', 'onToggleApplicant', 'onSubmitEntry', 'onWithdrawEntry']) {
    assert.equal(typeof college[method], 'function', `学院工作台缺少 ${method}`);
  }

  const schedulePage = loadPage('meet-schedule');
  for (const method of ['reload', 'onSaveSession', 'onAssignJudge', 'onRemoveJudge', 'onStartSession',
    'onPublishSchedule', 'onPickSession']) {
    assert.equal(typeof schedulePage[method], 'function', `赛程编排页缺少 ${method}`);
  }

  const scorePage = loadPage('meet-score');
  for (const method of ['reload', 'onOpenSession', 'onSubmitScore', 'onOpenEvent', 'onToggleVoid', 'onPublish',
    // B8a：预赛抽签、晋级、签表编排与判胜
    'onPickRound', 'onDrawHeats', 'onAdvance', 'onDrawBracket', 'onSetWinner',
    'decorateEvent', 'decorateBracket']) {
    assert.equal(typeof scorePage[method], 'function', `录分页缺少 ${method}`);
  }
});
