/**
 * 跨校邀请赛与学校身份：**真实环境（云数据源）下的入口**
 * ============================================================
 * 背景（2026-10-16 排查）：这两个功能在云数据源下曾经一个入口都没有，而底层链路
 * 其实是通的——协议 2 已注册学校身份 13 个动作（含转校 3 个）与邀请赛 16 个动作，
 * 卡住的全是前端门口的两道门：
 *   · 「我的」页的跨校邀请赛入口除了模板上的 `wx:if="{{isMock}}"`，方法体里还有
 *     一道 `if (facade.isMockNow()) return;`——双保险，真实环境点不动；
 *   · 首页的学校切换器在云端被提前 return 清空，而「浏览外校」正是转校与跨校读
 *     的自然入口。
 *
 * 这一组用例守的就是「别再退回门控」：
 *   1. 云数据源下「我的」页仍能进跨校邀请赛页；
 *   2. 模板上那张卡不再被 isMock 门控（Node 里没有模板渲染器，只能落到 wxml 上验）；
 *   3. 邀请赛页自身只在模拟环境显示「切换体验身份」（云端 getDemoActors() 是空
 *      数组，留一个空下拉比不显示更糟），学校切换与功能按钮不受数据源影响；
 *   4. 首页的学校切换器在云端也装载，且真的去问学校目录，不再提前返回。
 * ============================================================
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = require('../miniprogram/services/runtime-mode.js');
const schoolSession = require('../miniprogram/services/school-session.js');

/* ============================================================
 * 最小小程序运行环境：只要 navigateTo 与 getApp 两个桩
 * ============================================================ */

const navigations = [];
global.wx = { navigateTo: options => navigations.push(options.url) };
global.getApp = () => ({ globalData: { userInfo: null } });

/** 取页面配置（与各页面用例同一写法：先装好 Page 再 require） */
function loadPage(relative) {
  let config;
  const old = global.Page;
  global.Page = value => { config = value; };
  const modulePath = require.resolve(relative);
  delete require.cache[modulePath];
  try { require(modulePath); } finally { global.Page = old; }
  return { ...config,
    data: JSON.parse(JSON.stringify(config.data)),
    setData(values) { Object.assign(this.data, values); } };
}

const readWxml = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

/** 取「某个事件处理函数所在的那个标签」——用来验模板门控，而不是整份模板 */
function tagOf(wxml, handler) {
  const at = wxml.indexOf(handler);
  assert.ok(at > 0, `模板里找不到 ${handler}`);
  return wxml.slice(wxml.lastIndexOf('<', at), wxml.indexOf('>', at) + 1);
}

beforeEach(() => {
  runtime.setDataSource('mock');
  schoolSession.reset();
  navigations.length = 0;
});

/* ============================================================
 * 一、「我的」页：入口不再被数据源门控
 * ============================================================ */

test('云数据源下「我的」页仍能进跨校邀请赛页', () => {
  runtime.setDataSource('cloud');
  const page = loadPage('../miniprogram/pages/profile/profile.js');
  // isMock 只剩「页脚标注数据来源」一个用途，不该同时兼作入口开关
  assert.equal(page.data.isMock, false);
  page.onGoSchoolExchange();
  assert.deepEqual(navigations, ['/pages/school-exchange/school-exchange']);
});

test('模拟数据源下同一入口照旧可点（不能为了云端正反而关掉本地演示）', () => {
  const page = loadPage('../miniprogram/pages/profile/profile.js');
  assert.equal(page.data.isMock, true);
  page.onGoSchoolExchange();
  assert.deepEqual(navigations, ['/pages/school-exchange/school-exchange']);
});

test('模板：跨校邀请赛入口卡没有任何条件门控，副标题才按数据源分流', () => {
  const wxml = readWxml('miniprogram/pages/profile/profile.wxml');
  const card = tagOf(wxml, 'onGoSchoolExchange');
  assert.doesNotMatch(card, /wx:if/, '入口卡不该被任何条件拦一道（曾经是 wx:if="{{isMock}}"）');
  assert.doesNotMatch(card, /hidden/, '也不该用 hidden 变相藏起来');
  assert.match(wxml, /<view class="entry-card-title">跨校邀请赛<\/view>/, '卡片上要有标题');
  // isMock 只留在副标题那一行里（换文案），不参与显隐
  const hintAt = wxml.indexOf('entry-card-hint');
  assert.ok(hintAt > wxml.indexOf('onGoSchoolExchange'), '副标题要留在入口卡内');
});

/* ============================================================
 * 二、邀请赛页自身：哪些按数据源分流，哪些不
 * ============================================================ */

test('邀请赛页：只有「切换体验身份」按数据源显隐，学校切换与功能入口不受影响', () => {
  const wxml = readWxml('miniprogram/pages/school-exchange/school-exchange.wxml');

  // 体验身份下拉：云端没有演示身份（getDemoActors() 返回空数组），必须整条不渲染
  assert.match(tagOf(wxml, 'onActorChange'), /wx:if="\{\{isMock\}\}"/,
    '「切换体验身份」只在模拟环境出现');

  // 学校切换是真实功能（转校与跨校读的入口），任何数据源下都要在
  const schoolPicker = tagOf(wxml, 'onSchoolChange');
  assert.doesNotMatch(schoolPicker, /wx:if/, '切换学校不该被数据源门控');
  assert.match(wxml, /bindtap="onCreate"/, '发起邀请赛的按钮要在模板里');
  assert.match(wxml, /bindtap="onSignup"/, '报名按钮要在模板里');

  // 「本地模拟体验」提示本身不该写死
  assert.doesNotMatch(wxml, />本地模拟体验/, '提示文案不能硬编码成模拟环境');
});

test('邀请赛页：data.isMock 跟着数据源走，用于两处展示口径', () => {
  const mockPage = loadPage('../miniprogram/pages/school-exchange/school-exchange.js');
  assert.equal(mockPage.data.isMock, true, '默认（mock）时是模拟环境');
  runtime.setDataSource('cloud');
  const cloudPage = loadPage('../miniprogram/pages/school-exchange/school-exchange.js');
  assert.equal(cloudPage.data.isMock, false, '云端不是模拟环境');
  runtime.setDataSource('mock');
  const backToMock = loadPage('../miniprogram/pages/school-exchange/school-exchange.js');
  assert.equal(backToMock.data.isMock, true, '切回模拟数据源要跟着变');
});

/* ============================================================
 * 三、首页的学校切换器：云端也要装载
 * ============================================================ */

test('云数据源下首页仍装载学校切换器（浏览外校是转校与跨校读的入口）', async () => {
  const identity = require('../miniprogram/services/school-identity.js');
  const original = identity.forSchoolIdentity;
  const asked = [];
  // 真问一次目录：如果这里被跳过（曾经云端提前 return 清空 schoolList），asked 就是空的
  identity.forSchoolIdentity = (input) => {
    asked.push(input);
    return {
      getSchoolDirectory: async () => ({ ok: true, schools: [
        { schoolId: 'muc', name: '中央民族大学' }, { schoolId: 'buaa', name: '北京航空航天大学' }] }),
      getSchoolIdentitySession: async () => ({ ok: true, user: { primarySchoolId: 'muc' } }),
    };
  };
  runtime.setDataSource('cloud');
  try {
    const page = loadPage('../miniprogram/pages/index/index.js');
    await page.loadSchoolScope();
    assert.equal(asked.length, 1, '云端也要真的去问学校目录，而不是提前返回');
    assert.deepEqual(page.data.schoolList.map(row => row.schoolId), ['muc', 'buaa']);
    assert.equal(page.data.schoolId, 'muc');
    assert.equal(page.data.schoolName, '中央民族大学');
    assert.equal(page.data.readOnlySchool, false, '看自己的学校不是只读');
  } finally {
    identity.forSchoolIdentity = original;
    runtime.setDataSource('mock');
  }
});

test('云数据源下目录取不到时，切换器照旧收起而不是打白整页', async () => {
  const identity = require('../miniprogram/services/school-identity.js');
  const original = identity.forSchoolIdentity;
  identity.forSchoolIdentity = () => ({
    getSchoolDirectory: async () => { throw new Error('云开发尚未初始化'); },
    getSchoolIdentitySession: async () => ({ ok: true, user: null }),
  });
  runtime.setDataSource('cloud');
  try {
    const page = loadPage('../miniprogram/pages/index/index.js');
    await page.loadSchoolScope();
    assert.deepEqual(page.data.schoolList, []);
    assert.equal(page.data.readOnlySchool, false);
  } finally {
    identity.forSchoolIdentity = original;
    runtime.setDataSource('mock');
  }
});
