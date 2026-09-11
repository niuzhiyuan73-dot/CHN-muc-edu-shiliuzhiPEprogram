/**
 * 页面装配自检
 * ============================================================
 * 页面的问题（require 路径写错、字段名对不上、setData 漏了回调）
 * 在 Node 测试里原本是最难发现的一类——只有打开开发者工具点一遍才会暴露。
 * 但这些代码本身并不依赖真机，只要把 wx API 和 Page 构造函数补上，
 * 就能在 Node 里把整个生命周期跑一遍。
 *
 * 这里替小程序搭一个最小运行环境，然后真的去执行 onLoad / 切池 /
 * 加载更多 / 点击跳转，验证数据流是通的。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

/** 数据源门面。写接口会改内存，用例之间必须把缓存清干净 */
const facade = require('../miniprogram/services/index.js');
// 直接拿实现模块，是为了在个别用例里临时把某个接口换掉。
// 门面是「调用时才解析实现」，所以改这里的导出真的会作用到上面那层
const mock = require('../miniprogram/services/mock.js');
const {
  MATCH_STATUS,
  MATCH_TYPE,
  USER_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  SIGNUP_STATUS,
} = require('../miniprogram/utils/constants.js');

/* ============================================================
 * 最小小程序运行环境
 * ============================================================ */

/** 记录所有被调用的 wx API，供断言检查 */
const calls = {
  navigations: [],
  tabSwitches: [],
  titles: [],
  pullDownStopped: 0,
  toasts: [],
  backCount: 0,
};

/** 供 canvas 使用的假 2d 上下文，只记录调用 */
function createFakeContext() {
  const record = () => () => {};
  const ctx = {
    clearRect: record(),
    beginPath: record(),
    closePath: record(),
    moveTo: record(),
    lineTo: record(),
    arc: record(),
    stroke: record(),
    fill: record(),
    fillText: record(),
    save: record(),
    restore: record(),
    setLineDash: record(),
    scale: record(),
    font: '',
    textAlign: '',
    textBaseline: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    globalAlpha: 1,
  };
  return ctx;
}

const canvas = {
  width: 0,
  height: 0,
  getContext: () => createFakeContext(),
};

/** 尺寸由页面样式决定，这里假定占满宽度 320px、高 160px */
const CANVAS_SIZE = { width: 320, height: 160 };
const PIXEL_RATIO = 2;

const query = {
  in: () => query,
  select: () => query,
  fields: () => query,
  exec: (callback) => callback([{ node: canvas, ...CANVAS_SIZE }]),
};

global.wx = {
  createSelectorQuery: () => query,
  getWindowInfo: () => ({ pixelRatio: PIXEL_RATIO }),
  setNavigationBarTitle: (options) => calls.titles.push(options.title),
  stopPullDownRefresh: () => {
    calls.pullDownStopped += 1;
  },
  navigateTo: (options) => calls.navigations.push(options.url),
  switchTab: (options) => calls.tabSwitches.push(options.url),
  // 比赛页与录入页靠轻提示告知结果，只记文案即可——图标类型不参与断言
  showToast: (options) => calls.toasts.push(options.title),
  // 录入成功后返回上一页。不补这个桩，页面会在提交的最后一步抛错，
  // 表现成「提交失败」，让人以为是数据层的问题
  navigateBack: () => {
    calls.backCount += 1;
  },
};

/**
 * 最小可用的 app 实例。
 * 页面通过 getApp() 读数据源与登录态，登录页还会往里写登录态，
 * 所以这里带的三个方法要和 app.js 的语义一致：内存与「缓存」同步更新。
 */
const app = {
  globalData: { dataSource: 'mock', userInfo: null },
  getUserInfo() {
    return this.globalData.userInfo;
  },
  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
  },
  clearUserInfo() {
    this.globalData.userInfo = null;
  },
};

global.getApp = () => app;

/** 收集所有 Page() 注册的配置 */
const registered = [];
global.Page = (config) => registered.push(config);

// 注册动作发生在 require 的那一刻，所以必须先装好 Page 再引入页面
require('../miniprogram/pages/index/index.js');
require('../miniprogram/pages/profile/profile.js');
require('../miniprogram/pages/member/member.js');
require('../miniprogram/pages/rank/rank.js');
require('../miniprogram/pages/login/login.js');
require('../miniprogram/pages/match/match.js');
require('../miniprogram/pages/match-entry/match-entry.js');
// 新页面一律追加在末尾：registered[] 是按 require 顺序取下标的，
// 插在中间会让 0–6 全部错位，已有用例会成片地「装成别的页面」失败
require('../miniprogram/pages/member-review/member-review.js');
require('../miniprogram/pages/announcements/announcements.js');
require('../miniprogram/pages/announcement-manage/announcement-manage.js');
require('../miniprogram/pages/announcement-edit/announcement-edit.js');
require('../miniprogram/pages/profile-edit/profile-edit.js');
require('../miniprogram/pages/profile-detail/profile-detail.js');
require('../miniprogram/pages/season-manage/season-manage.js');
require('../miniprogram/pages/events/events.js');
require('../miniprogram/pages/event-detail/event-detail.js');
require('../miniprogram/pages/event-edit/event-edit.js');
require('../miniprogram/pages/event-placement/event-placement.js');

/**
 * 深拷贝页面初值。
 * structuredClone 遇到函数或特殊对象会抛错，退回到 JSON 一趟即可——
 * 页面初值里本来就只有普通数据。
 *
 * @param {Object} value
 * @returns {Object}
 */
function cloneData(value) {
  try {
    return structuredClone(value);
  } catch (err) {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * 把页面配置实例化成一个可用的对象。
 * 小程序的 Page 实例会把配置里的方法挂到 this 上，setData 则负责
 * 合并数据并触发重渲染——这里照着做一份最小实现。
 *
 * @param {Object} config
 * @returns {Object}
 */
function instantiate(config) {
  const page = {
    // 必须深拷贝：表单、错误提示这些都是嵌套对象，浅拷贝会让两个页面实例
    // 共用同一个 data.form，一条用例往里填的字会漏到另一条用例里
    data: cloneData(config.data),
    setData(patch, callback) {
      for (const [key, value] of Object.entries(patch)) {
        // 真机上 'form.realName' 这样的路径键会逐层写入；这里照着做，
        // 否则登录页的表单在测试里会全部堆到 data['form.realName'] 上
        const path = key.split('.');
        let target = this.data;
        for (let i = 0; i < path.length - 1; i += 1) {
          if (target[path[i]] === null || typeof target[path[i]] !== 'object') {
            target[path[i]] = {};
          }
          target = target[path[i]];
        }
        target[path[path.length - 1]] = value;
      }
      // 真机上 setData 是异步的，回调在渲染后触发；
      // 测试里同步执行即可，反正我们只关心回调有没有被调用
      if (callback) callback();
    },
  };

  for (const key of Object.keys(config)) {
    if (typeof config[key] === 'function') {
      page[key] = config[key].bind(page);
    }
  }

  return page;
}

const indexConfig = registered[0];
const profileConfig = registered[1];
const memberConfig = registered[2];
const rankConfig = registered[3];
const loginConfig = registered[4];
const matchConfig = registered[5];
const matchEntryConfig = registered[6];
const memberReviewConfig = registered[7];
const announcementsConfig = registered[8];
const announcementManageConfig = registered[9];
const announcementEditConfig = registered[10];
const profileEditConfig = registered[11];
const profileDetailConfig = registered[12];
const seasonManageConfig = registered[13];
const eventsConfig = registered[14];
const eventDetailConfig = registered[15];
const eventEditConfig = registered[16];
const eventPlacementConfig = registered[17];

// 写接口（确认 / 撤销 / 录入）只改内存，跑完一条用例就得把内存退回种子状态，
// 否则上一条确认过的比赛会让下一条拿到的榜单与台账都不一样
beforeEach(() => {
  facade.resetCache();
});

/** 每一条用例开始前把登录态清干净，避免互相串味 */
function resetSession() {
  app.globalData.userInfo = null;
}

/** 造一个「已登录」的会员对象，字段与 mock 数据源一致 */
function fakeMember(overrides = {}) {
  return {
    _id: 'u06',
    nickName: '赵明宇',
    avatarUrl: '',
    role: 0,
    status: 1,
    ...overrides,
  };
}

/**
 * 摆好登录态。
 * 「我的」页只在已登录时加载数据——它看的人就是本地会话里的那个，
 * 没有会话就一行都不查（否则云端会按 OpenID 把刚退出的账号答回来）。
 */
function loginAs(overrides) {
  app.globalData.userInfo = fakeMember(overrides);
  return app.globalData.userInfo;
}

/* ============================================================
 * 首页
 * ============================================================ */

test('首页 —— 未登录时显示登录引导，而不是冒用别人的分数', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.dataSourceLabel, '本地模拟数据');
  assert.strictEqual(page.data.auth.loggedIn, false);
  assert.strictEqual(page.data.view.scoreCard.hasUser, false);
  // 没登录却把演示会员的项目列出来，用户会以为那是自己的成绩
  assert.strictEqual(page.data.view.scoreCard.projects, undefined);
});

test('首页 —— 点登录引导跳到登录注册页', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
});

test('首页 —— 登录后渲染当前会员的分数卡片', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.auth.loggedIn, true);
  assert.strictEqual(page.data.auth.statusLabel, '正常');
  assert.strictEqual(page.data.view.scoreCard.hasUser, true);
  assert.strictEqual(page.data.view.scoreCard.user.nickName, '赵明宇');
  assert.ok(page.data.view.scoreCard.projects.length > 0);
  // 与「我的」页保持同一套口径：单打排在双打前面
  assert.strictEqual(page.data.view.scoreCard.projects[0].label, '男单');
});

test('首页 —— 待审核的账号能登录，但分数卡片给出提示', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.auth.isPending, true);
  assert.strictEqual(page.data.auth.canRecord, false);
  // 本地注册的账号不在模拟名单里，自然也没有战绩
  assert.strictEqual(page.data.view.scoreCard.hasProjects, false);
  assert.ok(page.data.view.scoreCard.hasUser);
});

test('首页 —— 最近比赛与公告都有内容，数据里没有 undefined 或 NaN', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.summary.memberCount, 24);
  assert.ok(page.data.view.summary.matchCount > 0);
  assert.strictEqual(page.data.view.recentMatches.length, 5);
  assert.ok(page.data.view.announcements.rows.length > 0);

  // 队名要解析成昵称，不能是 u03 这样的编号
  for (const row of page.data.view.recentMatches) {
    assert.ok(row.teamAName && !/^u\d\d$/.test(row.teamAName), '队名没解析成昵称');
    assert.ok(row.scoreText && row.scoreText !== '—', '比分不该是占位符');
  }

  // 置顶公告排在最前面
  const rows = page.data.view.announcements.rows;
  assert.strictEqual(rows[0].pinned, true);

  // 把渲染用的视图模型压成字符串，扫一遍最常见的渲染事故。
  // 页面字段名写错时不会报错，只会安静地渲染出「undefined」。
  const text = JSON.stringify(page.data.view);
  assert.ok(!text.includes('undefined'), '视图数据里出现了 undefined');
  assert.ok(!text.includes('null'), '视图数据里出现了 null');
  assert.ok(!text.includes('NaN'), '视图数据里出现了 NaN');
});

test('首页 —— 下拉刷新会收起刷新动画', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

/* ============================================================
 * 我的页
 * ============================================================ */

test('我的页 —— 启动后处于加载态，数据来源标注为模拟数据', () => {
  const page = instantiate(profileConfig);
  assert.strictEqual(page.data.loading, true);
  assert.strictEqual(page.data.isMock, true);
  assert.deepStrictEqual(page.data.view, {}, '初值必须是空对象，WXML 展开才不会出错');
});

test('我的页 —— onLoad 之后渲染出当前会员的数据', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
  assert.ok(page.data.view.projectTabs.length > 0);
});

test('我的页 —— 点头卡头像进个人详情页', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, ['/pages/profile-detail/profile-detail']);
});

test('我的页 —— 单打与双打两张分卡的分数、排名、百分位都取得到', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  const tabs = page.data.view.projectTabs;
  // 赵明宇有男单和双打，正好两张卡；每张都得有分数
  assert.strictEqual(tabs.length, 2);
  assert.strictEqual(tabs[0].label, '男单');
  for (const tab of tabs) {
    assert.ok(tab.elo, `${tab.label} 要有当前分数`);
  }
  // 排名与百分位取自主项目（默认单打）
  assert.ok(page.data.view.summary.rankText);
  assert.ok(page.data.view.summary.beatText);
});

test('我的页 —— 默认展示单打，且单打标签排在最前', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  // 双打场次比单打多，默认落到双打是「按出场次数排序」造成的，不是想要的
  assert.strictEqual(page.data.view.activeProjectLabel, '男单');
  assert.strictEqual(page.data.view.projectTabs[0].active, true);
});

test('我的页 —— 下拉刷新会收起刷新动画', async () => {
  const page = instantiate(profileConfig);
  await page.onLoad({});

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  // 不调用 stopPullDownRefresh 的话，转圈会一直停不下来
  assert.strictEqual(calls.pullDownStopped, 1);
});

test('我的页 —— 访客看不到会员审核入口', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, false);
});

test('我的页 —— 待审核账号自己还没转正，同样没有审核入口', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, false);
});

test('我的页 —— 正常会员看到审核入口，点进去跳转审核页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, true);
  assert.ok(page.data.reviewEntry.hint, '入口卡上要写清楚点进去是干什么的');

  calls.navigations.length = 0;
  page.onGoReview();
  assert.deepStrictEqual(calls.navigations, ['/pages/member-review/member-review']);
});

test('我的页 —— 退出登录后 onShow 会把审核入口收回去', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.reviewEntry.visible, true);

  app.globalData.userInfo = null;
  page.onShow();
  assert.strictEqual(page.data.reviewEntry.visible, false, '权限没了，入口不能还挂着');
});

test('我的页 —— 访客看不到公告管理入口', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.adminEntry.visible, false);
});

test('我的页 —— 正常会员看到公告管理入口，点进去跳转公告管理页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.adminEntry.visible, true);
  assert.ok(page.data.adminEntry.hint, '入口卡上要写清楚点进去是干什么的');

  calls.navigations.length = 0;
  page.onGoAnnouncementsAdmin();
  assert.deepStrictEqual(calls.navigations, ['/pages/announcement-manage/announcement-manage']);
});

test('我的页 —— 退出登录后 onShow 会把公告管理入口一并收回去', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.adminEntry.visible, true);

  app.globalData.userInfo = null;
  page.onShow();
  assert.strictEqual(page.data.adminEntry.visible, false, '权限没了，入口不能还挂着');
});

test('我的页 —— 访客看不到赛季管理入口', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.seasonEntry.visible, false);
});

test('我的页 —— 正常会员看到赛季管理入口，点进去跳转赛季管理页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.seasonEntry.visible, true);
  assert.ok(page.data.seasonEntry.hint, '入口卡上要写清楚点进去是干什么的');

  calls.navigations.length = 0;
  page.onGoSeasonManage();
  assert.deepStrictEqual(calls.navigations, ['/pages/season-manage/season-manage']);
});

test('我的页 —— 退出登录后 onShow 会把赛季管理入口一并收回去', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.seasonEntry.visible, true);

  app.globalData.userInfo = null;
  page.onShow();
  assert.strictEqual(page.data.seasonEntry.visible, false, '权限没了，入口不能还挂着');
});

test('我的页 —— 已登录才给退出按钮，点了清登录态并回首页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.loggedIn, true, '登录了就该有退出按钮');

  calls.tabSwitches.length = 0;
  page.onLogout();

  assert.strictEqual(app.globalData.userInfo, null, '退出登录要把全局登录态清掉');
  assert.strictEqual(page.data.loggedIn, false);
  assert.deepStrictEqual(calls.tabSwitches, ['/pages/index/index'], '退出后回首页');
});

test('我的页 —— 未登录时不给退出按钮', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loggedIn, false);
});

test('我的页 —— 登录后切回本页会自动补取数据，不停在登录前那份空视图', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  // 这个页面实例是在未登录时建出来的：view 停在 {found:false}
  await page.onLoad({});
  assert.strictEqual(page.data.loggedIn, false);

  // 用户去登录页登录成功，再切回「我的」——tabBar 页只走 onShow，不重新 onLoad
  loginAs();
  await page.onShow();

  assert.strictEqual(page.data.loggedIn, true);
  assert.strictEqual(page.data.view.found, true, '登录后必须重新取数');
  assert.strictEqual(page.data.view.user.userId, 'u06');
});

test('我的页 —— 登录后补取数据期间显示加载态，而不是「没有找到这位会员」', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.loading, false);

  loginAs();
  const pending = page.onShow();

  // 云端还没回来。此时 loading 若还是 false，模板就会拿登录前那份
  // {found:false} 去渲染「没有找到这位会员」——冷启动要等好几秒
  assert.strictEqual(page.data.loading, true, '取数期间要挂加载态');

  await pending;
  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.found, true);
});

test('我的页 —— 切回本页时登录态没变就不重复取数', async () => {
  resetSession();
  loginAs();

  // 切 tab 很频繁，每次都白跑一趟云端没有意义
  let queried = 0;
  const originalGetCurrentUser = mock.getCurrentUser;
  mock.getCurrentUser = async (...args) => {
    queried += 1;
    return originalGetCurrentUser.apply(mock, args);
  };

  try {
    const page = instantiate(profileConfig);
    await page.onLoad({});
    assert.strictEqual(queried, 1, 'onLoad 取一次');

    await page.onShow();
    assert.strictEqual(queried, 1, '登录态没变，onShow 不该再取');
  } finally {
    mock.getCurrentUser = originalGetCurrentUser;
  }
});

test('我的页 —— 退出后重新登录会重新取数，不把上一个人那份空视图留住', async () => {
  resetSession();
  loginAs();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.view.user.userId, 'u06');

  // 退出再登进来也走同一条路径
  page.onLogout();
  assert.strictEqual(page.data.loggedIn, false);

  loginAs();
  await page.onShow();
  assert.strictEqual(page.data.loggedIn, true);
  assert.strictEqual(page.data.view.found, true, '重新登录后要补取数据');
});

test('我的页 —— 未登录时不查数据，只给登录引导', async () => {
  resetSession();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false, '不能一直挂在加载态');
  // 关键：数据源的 getCurrentUser 认的是 OpenID，退出登录后照样答得出是谁，
  // 所以未登录时必须什么都不查，否则「我的」页会继续显示刚退出的那个账号
  assert.strictEqual(page.data.view.found, false);

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
});

test('我的页 —— 服务端查无此人时清掉登录态，不把人困在「没有找到这位会员」', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  // 本地缓存还留着登录态（比如账号刚在后台被删掉，或这台设备上的微信号
  // 与服务端那个账号不是同一个），数据源却答不出这个人
  const originalGetCurrentUser = mock.getCurrentUser;
  mock.getCurrentUser = async () => undefined;

  try {
    calls.tabSwitches.length = 0;
    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.view.found, false);
    assert.strictEqual(page.data.loading, false, '不能一直挂在加载态');
    assert.strictEqual(page.data.loggedIn, false, '对不上的登录态要清掉');
    assert.strictEqual(app.globalData.userInfo, null, '全局登录态也要一并清掉');
    // 这一步不跳页：用户正站在「我的」上，原地换成登录引导即可
    assert.deepStrictEqual(calls.tabSwitches, [], '不要把人甩到别的页面去');
  } finally {
    mock.getCurrentUser = originalGetCurrentUser;
  }
});

test('我的页 —— 加载失败时留着登录态，只提示重试', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  // 抛错是网络/云函数故障，与「查无此人」不是一回事：这时把人的登录态
  // 清掉，等于让他白白重新登录一次
  const originalGetCurrentUser = mock.getCurrentUser;
  mock.getCurrentUser = async () => {
    throw new Error('云函数调用失败');
  };

  try {
    const page = instantiate(profileConfig);
    await page.onLoad({});

    assert.strictEqual(page.data.error, '数据加载失败，请下拉重试');
    assert.strictEqual(page.data.loggedIn, true, '故障时不该把人踢下线');
    assert.ok(app.globalData.userInfo);
  } finally {
    mock.getCurrentUser = originalGetCurrentUser;
  }
});

/* ============================================================
 * 个人详情（从「我的」页点头像进来）
 * ============================================================ */

test('个人详情 —— onLoad 之后渲染出当前会员的数据', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
});

test('个人详情 —— 曲线画到了 canvas 上，并按设备像素比做了缩放', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  canvas.width = 0;
  canvas.height = 0;

  await page.onLoad({});

  // 不乘 dpr 的话，曲线在手机上会糊成一片
  assert.strictEqual(canvas.width, CANVAS_SIZE.width * PIXEL_RATIO);
  assert.strictEqual(canvas.height, CANVAS_SIZE.height * PIXEL_RATIO);
});

test('个人详情 —— 切换项目后整页数据跟着换', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  await page.onSwitchProject({ currentTarget: { dataset: { project: 'men_singles' } } });

  assert.strictEqual(page.data.view.activeProject, 'men_singles');
  assert.strictEqual(page.data.switching, false, '切完要把淡出状态收回');
  assert.ok(page.data.view.history.length > 0);
  for (const row of page.data.view.history) {
    assert.strictEqual(row.poolLabel, '单打');
  }
});

test('个人详情 —— 重复点当前项目不做无谓的重新加载', async () => {
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  const before = page.data.view;
  await page.onSwitchProject({
    currentTarget: { dataset: { project: page.data.view.activeProject } },
  });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('个人详情 —— 切项目时不整页替成加载态，别把刚看到的内容抹掉', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.view.hasProject, true);

  const pending = page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });
  assert.strictEqual(page.data.loading, false, '换项目不该把整页数据换成加载中');
  assert.strictEqual(page.data.switching, true, '但要给个切换中的反馈');

  await pending;
  assert.strictEqual(page.data.view.activeProject, 'doubles');
});

test('个人详情 —— 加载更多会扩大取数范围', async () => {
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  const before = page.data.historyLimit;
  await page.onLoadMore();
  assert.strictEqual(page.data.historyLimit, before + 20);
});

test('个人详情 —— 是否还有更多战绩，按实际总场次判断', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  // 只取一场，这个池肯定不止一场
  page.data.historyLimit = 1;
  await page.onLoad({});
  assert.strictEqual(page.data.hasMore, true);

  // 上限放到远超总场次，再点「加载更多」就没意义了，按钮该消失
  page.data.historyLimit = 100000;
  await page.refresh();
  assert.strictEqual(page.data.hasMore, false);
});

test('个人详情 —— 点交锋记录里的人会跳到对方主页', async () => {
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/pages/member/member?userId=u01']);
});

test('个人详情 —— 点到自己不会再跳一层', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u06' } } });
  assert.deepStrictEqual(calls.navigations, [], '自己的名字点了不该再开一个页面');
});

test('个人详情 —— 修改头像入口跳到编辑资料页', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileEdit();
  assert.deepStrictEqual(calls.navigations, ['/pages/profile-edit/profile-edit']);
});

test('个人详情 —— 详情页里再点头像不跳转', async () => {
  loginAs();
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, [], '已经在详情页了，不该再开一层');
});

/* ============================================================
 * 他人主页
 * ============================================================ */

test('他人主页 —— 按地址栏里的 userId 加载对应会员', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u01');
});

test('他人主页 —— 拿不到 userId 时退化成看自己，而不是白屏', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
});

test('他人主页 —— 查无此人时给出明确提示', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u99' });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.found, false);
  assert.strictEqual(page.data.hasMore, false);
});

test('他人主页 —— 导航栏标题会换成被查看会员的昵称', async () => {
  // 顺着交锋记录一路点进来会有好几层，标题不写名字就不知道在看谁
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  assert.strictEqual(calls.titles[calls.titles.length - 1], page.data.view.user.nickName);
});

test('他人主页 —— 头卡是共用的，但点头像不会跳走', async () => {
  // 头像跳详情只有「我的」页需要；看别人资料时点头像不该有任何反应
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, []);
});

/* ============================================================
 * 排行榜
 * ============================================================ */

test('排行榜 —— 首屏加载后展示默认项目的等级分榜', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.activeBoard, 'elo');
  assert.ok(page.data.view.rows.length > 0);
});

test('排行榜 —— 切项目会换成对应的榜，且名次重新从 1 排起', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  await page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });

  assert.strictEqual(page.data.view.activeProject, 'doubles');
  assert.strictEqual(page.data.switching, false, '切完要把淡出状态收回来');
  assert.strictEqual(page.data.view.rows[0].rank, 1);
});

test('排行榜 —— 切到同一个项目不重复加载', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchProject({ currentTarget: { dataset: { project: page.data.view.activeProject } } });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('排行榜 —— 切榜单类型会换成进步榜', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  await page.onSwitchBoard({ currentTarget: { dataset: { board: 'progress' } } });

  assert.strictEqual(page.data.view.activeBoard, 'progress');
  assert.strictEqual(page.data.view.activeBoardLabel, '进步榜');
  assert.ok(page.data.view.rows.length > 0);
});

test('排行榜 —— 切到同一榜单类型不重复加载', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchBoard({ currentTarget: { dataset: { board: 'elo' } } });

  assert.strictEqual(page.data.view, before);
});

test('排行榜 —— 项目和榜单两个维度互不影响', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  await page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });
  await page.onSwitchBoard({ currentTarget: { dataset: { board: 'progress' } } });

  // 切榜单不该把项目切回去——两个状态各记各的
  assert.strictEqual(page.data.view.activeProject, 'doubles');
  assert.strictEqual(page.data.view.activeBoard, 'progress');
});

test('排行榜 —— 点榜上的人会跳到他的主页', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/pages/member/member?userId=u01']);
});

test('排行榜 —— 下拉刷新会收起刷新动画', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

test('排行榜 —— 搜索框空着时就是完整榜单，计数为「N 人上榜」', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, page.data.view.rows.length);
  assert.strictEqual(page.data.playerCountText, `${page.data.rows.length} 人上榜`);
  assert.strictEqual(page.data.empty, false);
});

test('排行榜 —— 输入名字后只剩命中的人，名次保持不变', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const target = page.data.rows[0];
  page.onInputKeyword({ detail: { value: target.nickName } });

  assert.strictEqual(page.data.searching, true);
  assert.ok(page.data.rows.length >= 1, '至少要搜到榜首本人');
  assert.ok(page.data.rows.every((row) => row.nickName.includes(target.nickName)));
  assert.strictEqual(page.data.playerCountText, `找到 ${page.data.rows.length} 人`);
  // 关键：搜索不是重新排名，被搜到的人名次不能变
  const sameRow = page.data.rows.find((row) => row.userId === target.userId);
  assert.strictEqual(sameRow.rank, target.rank);
});

test('排行榜 —— 搜不到时提示里带上搜索词，而不是笼统地说没人打过', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  page.onInputKeyword({ detail: { value: '查无此人' } });

  assert.strictEqual(page.data.empty, true);
  assert.strictEqual(page.data.rows.length, 0);
  assert.ok(page.data.emptyNote.includes('查无此人'), '要告诉用户是哪个词没搜到');
  assert.strictEqual(page.data.playerCountText, '找到 0 人');
});

test('排行榜 —— 清空搜索后回到完整榜单', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const total = page.data.rows.length;
  page.onInputKeyword({ detail: { value: '查无此人' } });
  page.onClearKeyword();

  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, total);
});

test('排行榜 —— 切换项目后搜索词保留，不悄悄回到全部', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const target = page.data.rows[0];
  page.onInputKeyword({ detail: { value: target.nickName } });
  await page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });

  assert.strictEqual(page.data.keyword, target.nickName, '切榜不该把搜索框清空');
  assert.strictEqual(page.data.searching, true);
});

/* ============================================================
 * 赛事（赛季积分榜）
 * ============================================================ */

test('赛事页 —— 首屏加载后展示赛季积分榜', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.ok(page.data.view.rows.length > 0, '种子里有单打赛事，榜上不该空着');
  assert.ok(page.data.view.seasonText.length > 0);
});

test('赛事页 —— 榜上的人名次连续、积分从高到低', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const rows = page.data.view.rows;
  rows.forEach((row, index) => {
    assert.strictEqual(row.rank, index + 1);
    assert.ok(Number(row.valueText) > 0, '0 分的人不该出现在积分榜上');
  });
  const points = rows.map((row) => Number(row.valueText));
  assert.deepStrictEqual(points, [...points].sort((a, b) => b - a));
});

test('赛事页 —— 点榜上的人会跳到他的主页', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/pages/member/member?userId=u01']);
});

test('赛事页 —— 点空白行不会乱跳', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: {} } });
  assert.deepStrictEqual(calls.navigations, []);
});

test('赛事页 —— 下拉刷新会收起刷新动画', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

test('赛事页 —— 加载失败时给出提示而不是白屏', async () => {
  const page = instantiate(eventsConfig);
  // 门面是「调用时解析实现」，改实现模块的导出就能让这次取数失败
  const original = mock.getEvents;
  mock.getEvents = async () => {
    throw new Error('模拟数据源故障');
  };

  try {
    await page.onLoad();
    assert.strictEqual(page.data.loading, false);
    assert.ok(page.data.error.length > 0, '失败要有文案，不能只剩一个空页面');
  } finally {
    mock.getEvents = original;
  }
});

/* ============================================================
 * 赛事闭环（列表 → 详情 → 发布 → 名次录入）
 * ============================================================ */

/** 造一场「报名中」的赛事，返回落库后的记录 */
async function publishTestEvent(overrides = {}) {
  const user = loginAs();
  const result = await facade.publishEvent(
    {
      title: '测试单打赛',
      description: '淘汰赛制',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SECOND,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      seedMode: SEED_MODE.ELO,
      seedCount: 8,
      location: '体育馆 1 号场',
      startTime: '2026-06-10T09:00:00',
      quota: 8,
      ...overrides,
    },
    user._id
  );
  assert.strictEqual(result.ok, true, `发布赛事失败：${result.firstError}`);
  return result.record;
}

test('赛事页 —— 赛事列表把报名中的排在已结束之前', async () => {
  loginAs();
  const created = await publishTestEvent();

  const page = instantiate(eventsConfig);
  await page.onLoad();

  const rows = page.data.view.events;
  assert.ok(rows.length > 0, '种子里有赛事，列表不该空着');

  // 种子里那场「报名中」的赛事（e07）与刚发布的都排在已结束的之前。
  // 同为报名中时按开赛时间由近及远——e07 在 9 月，于是排在 6 月这场之前
  const signingUp = rows.filter((row) => row.status === EVENT_STATUS.SIGNUP);
  assert.ok(signingUp.some((row) => row.id === created._id), '刚发布的赛事在列表里');
  assert.ok(signingUp.some((row) => row.id === 'e07'), '种子里的报名中赛事在列表里');
  assert.strictEqual(rows[0].statusLabel, '报名中');
  assert.strictEqual(rows[signingUp.length - 1].status, EVENT_STATUS.SIGNUP);

  const statuses = rows.map((row) => row.status);
  assert.deepStrictEqual(statuses, [...statuses].sort((a, b) => a - b), '按状态分档');
});

test('赛事页 —— 点一场赛事跳到详情', async () => {
  loginAs();
  const created = await publishTestEvent();

  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: { eventId: created._id } } });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/event-detail/event-detail?eventId=${created._id}`,
  ]);
});

test('赛事页 —— 点空白行不会乱跳', async () => {
  loginAs();
  const page = instantiate(eventsConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: {} } });
  assert.deepStrictEqual(calls.navigations, []);
});

test('赛事页 —— 有管理权才渲染发布入口', async () => {
  loginAs();
  const allowed = instantiate(eventsConfig);
  await allowed.onLoad();
  assert.strictEqual(allowed.data.view.canPublish, true, '演示数据源下登录会员即可发布');

  calls.navigations.length = 0;
  allowed.onOpenPublish();
  assert.deepStrictEqual(calls.navigations, ['/pages/event-edit/event-edit']);

  resetSession();
  const blocked = instantiate(eventsConfig);
  await blocked.onLoad();
  assert.strictEqual(blocked.data.view.canPublish, false, '没登录不给发布入口');
});

test('赛事详情 —— 未登录也能看，但没有报名按钮', async () => {
  loginAs();
  const created = await publishTestEvent();
  resetSession();

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });

  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.event.isSignup, true);
  assert.strictEqual(page.data.view.event.canSignUp, false, '没登录不能报名');
  assert.strictEqual(page.data.view.event.mySignupLabel, '未报名');
});

test('赛事详情 —— 报名成功后状态变为已报名、人数加一', async () => {
  loginAs();
  const created = await publishTestEvent();

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.event.quotaText, '0/8 人');

  await page.onSignUp();

  assert.strictEqual(page.data.view.event.mySignupLabel, '已报名');
  assert.strictEqual(page.data.view.event.quotaText, '1/8 人');
  assert.strictEqual(page.data.view.hasSignups, true);
  assert.strictEqual(page.data.view.signupRows[0].isMe, true);
});

test('赛事详情 —— 找不到的赛事给出提示而不是白屏', async () => {
  loginAs();
  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: 'no-such-event' });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, false);
  assert.ok(page.data.view.notFoundText.length > 0);
});

test('赛事详情 —— 开始赛事之后可以给报名者代签', async () => {
  loginAs();
  const created = await publishTestEvent();
  await facade.signUpEvent(created._id, 'u06');

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.event.canStart, true);

  await page.onStart();
  assert.strictEqual(page.data.view.event.isOngoing, true);

  assert.strictEqual(page.data.view.signupRows[0].canCheckIn, true);
  await page.onCheckIn({ currentTarget: { dataset: { userId: 'u06' } } });

  assert.strictEqual(page.data.view.signupRows[0].checkedIn, true);
  assert.strictEqual(page.data.view.signupRows[0].canCheckIn, false);
});

test('赛事详情 —— 手工指定种子：点抽签先弹面板，凑齐人数才真正落签', async () => {
  loginAs();
  const created = await publishTestEvent({ seedMode: SEED_MODE.MANUAL, seedCount: 2 });
  for (const userId of ['u06', 'u01', 'u02']) await facade.signUpEvent(created._id, userId);

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });

  assert.strictEqual(page.data.view.event.isManualSeed, true);
  assert.strictEqual(page.data.view.manualSeedNeeded, 2, '选定 2 位种子');
  assert.strictEqual(page.data.view.seedCandidates.length, 3, '候选就是三位报名者');

  // 点「开始抽签」：先把点名面板开出来，不能直接按默认顺序抽
  await page.onDraw();
  assert.strictEqual(page.data.seedDialogOpen, true);
  assert.strictEqual(page.data.view.event.drawn, false, '还没点名，签不该落下来');

  // 只点一位就确定：挡下来，说清还差几位
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u02' } } });
  assert.deepStrictEqual(page.data.seedPicked, ['u02']);
  assert.strictEqual(page.data.seedRows.find((row) => row.userId === 'u02').order, 1, '先点的排 1 号');

  await page.onConfirmSeeds();
  assert.strictEqual(page.data.seedDialogOpen, true, '没凑齐不该关面板');
  assert.ok(page.data.seedError.includes('还需指定 1 位'));
  assert.strictEqual(page.data.view.event.drawn, false);

  // 选满了再多点一位：拒绝并提示，不把第 3 个人挤进去
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u01' } } });
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u06' } } });
  assert.deepStrictEqual(page.data.seedPicked, ['u02', 'u01']);
  assert.ok(page.data.seedError.includes('2 位'));

  // 再点一次已选的人＝取消，方便点错就地改
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(page.data.seedPicked, ['u02']);

  // 换成先点 u06、后点 u01 的顺序，凑齐后抽签
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u06' } } });
  assert.deepStrictEqual(page.data.seedPicked, ['u02', 'u06']);
  await page.onConfirmSeeds();

  assert.strictEqual(page.data.seedDialogOpen, false);
  assert.strictEqual(page.data.view.event.drawn, true);
  assert.strictEqual(page.data.view.hasBracket, true);

  const events = await facade.getEvents();
  const drawn = events.find((item) => item._id === created._id);
  assert.deepStrictEqual(
    drawn.draw.seeds.slice().sort(),
    ['u02', 'u06'],
    '落库的种子正是点名的那两位（顺序即 1 号、2 号）'
  );
  assert.strictEqual(drawn.draw.drawCount, 1);
});

test('赛事详情 —— 手工种子面板可以清空重选、点遮罩关掉', async () => {
  loginAs();
  const created = await publishTestEvent({ seedMode: SEED_MODE.MANUAL, seedCount: 2 });
  for (const userId of ['u06', 'u01', 'u02']) await facade.signUpEvent(created._id, userId);

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });

  await page.onDraw();
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u01' } } });
  page.onToggleSeed({ currentTarget: { dataset: { userId: 'u02' } } });
  page.onClearSeeds();
  assert.deepStrictEqual(page.data.seedPicked, []);
  assert.deepStrictEqual(page.data.seedRows.map((row) => row.order), [0, 0, 0]);

  page.onCloseSeedDialog();
  assert.strictEqual(page.data.seedDialogOpen, false);
  assert.deepStrictEqual(page.data.seedPicked, []);
  assert.strictEqual(page.data.view.event.drawn, false, '关掉面板什么都没抽');
});

test('发布赛事 —— 未登录时不给表单', () => {
  resetSession();
  const page = instantiate(eventEditConfig);
  page.onLoad();

  assert.ok(page.data.blockReason.length > 0);
});

test('发布赛事 —— 等级与三四名赛没选就提交，逐字段报错', async () => {
  loginAs();
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '秋季单打赛' } });
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });

  const before = calls.backCount;
  await page.onSubmit();

  assert.ok(page.data.errors.level, '等级必须显式选择');
  assert.ok(page.data.errors.bronzeMode, '三四名赛方式必须显式选择');
  assert.ok(page.data.errorText.length > 0);
  assert.strictEqual(calls.backCount, before, '没通过校验不该退回');
});

test('发布赛事 —— 填全后提交落库，并退回上一页', async () => {
  loginAs();
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '秋季单打赛' } });
  page.onPickLevel({ detail: { value: '1' } }); // 下拉第 2 项 = 二级赛事
  page.onPickBronzeMode({ detail: { value: '1' } }); // 下拉第 2 项 = 打三四名
  page.onPickSeedMode({ detail: { value: '1' } }); // 下拉第 2 项 = 按等级分
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputQuota({ detail: { value: '8' } });

  const before = calls.backCount;
  await page.onSubmit();
  assert.strictEqual(calls.backCount, before + 1);

  const events = await facade.getEvents();
  const created = events.find((item) => item.title === '秋季单打赛');
  assert.ok(created, '发布后赛事应在台账里');
  assert.strictEqual(created.level, EVENT_LEVEL.SECOND);
  assert.strictEqual(created.bronzeMode, EVENT_BRONZE_MODE.PLAYOFF);
  assert.strictEqual(created.seedMode, SEED_MODE.ELO);
  assert.strictEqual(created.seedCount, 8, '种子数量默认 8');
  assert.strictEqual(created.draw, null, '创建时还没抽签');
  assert.strictEqual(created.status, EVENT_STATUS.SIGNUP);
});

test('录入名次 —— 未登录时整页挡住，不给名单', async () => {
  loginAs();
  const created = await publishTestEvent();
  resetSession();

  const page = instantiate(eventPlacementConfig);
  await page.onLoad({ eventId: created._id });

  assert.strictEqual(page.data.view.allowed, false);
  assert.ok(page.data.view.blockedText.length > 0);
  assert.deepStrictEqual(page.data.view.rows, []);
});

test('录入名次 —— 一个名次都没填就提交，给出提示', async () => {
  loginAs();
  const created = await publishTestEvent();
  await facade.signUpEvent(created._id, 'u06');
  await facade.startEvent(created._id, 'u06');

  const page = instantiate(eventPlacementConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.canEdit, true);

  await page.onSubmit();
  assert.ok(page.data.errorText.length > 0);
});

test('录入名次 —— 提交后赛事结束、名次落定', async () => {
  loginAs();
  const created = await publishTestEvent();
  await facade.signUpEvent(created._id, 'u06');
  await facade.startEvent(created._id, 'u06');

  const page = instantiate(eventPlacementConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.rows.length, 1);

  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1' } });

  const before = calls.backCount;
  await page.onSubmit();
  assert.strictEqual(calls.backCount, before + 1);

  const events = await facade.getEvents();
  const finished = events.find((item) => item._id === created._id);
  assert.strictEqual(finished.status, EVENT_STATUS.FINISHED);
  assert.deepStrictEqual(finished.results, [{ userId: 'u06', placement: 1 }]);
});

/* ============================================================
 * 登录 / 注册
 * ============================================================ */

test('登录页 —— 未登录时停在入口，提供登录与注册两个选择', () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();

  assert.strictEqual(page.data.step, 'entry');
  assert.strictEqual(page.data.existing.loggedIn, false);
  assert.strictEqual(page.data.isMock, true);
});

test('登录页 —— 已登录时显示账号卡片，可退出登录', () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(loginConfig);
  page.onLoad();
  assert.strictEqual(page.data.existing.loggedIn, true);
  assert.strictEqual(page.data.existing.nickName, '赵明宇');
  assert.strictEqual(page.data.existing.statusLabel, '正常');

  page.onLogout();
  assert.strictEqual(app.globalData.userInfo, null, '退出登录要把全局登录态清掉');
  assert.strictEqual(page.data.existing.loggedIn, false);
});

test('登录页 —— 一键登录写入全局登录态并回到首页', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();

  calls.tabSwitches.length = 0;
  await page.onLogin();

  assert.ok(app.globalData.userInfo, '登录态没有写进全局');
  assert.strictEqual(app.globalData.userInfo._id, 'u06');
  assert.strictEqual(page.data.submitting, false);
  assert.deepStrictEqual(calls.tabSwitches, ['/pages/index/index']);
});

test('登录页 —— 服务端没有这个账号时，引导去注册而不是让人干重试', async () => {
  resetSession();

  // 换台设备最常见的情形：这个 OpenID 在服务端还没有账号
  const originalGetCurrentUser = mock.getCurrentUser;
  mock.getCurrentUser = async () => undefined;

  try {
    const page = instantiate(loginConfig);
    page.onLoad();

    calls.tabSwitches.length = 0;
    await page.onLogin();

    assert.strictEqual(page.data.submitting, false);
    assert.strictEqual(app.globalData.userInfo, null, '没有账号就不该写入登录态');
    assert.match(page.data.errorText, /新会员注册/, '要告诉他下一步该点哪里');
    assert.deepStrictEqual(calls.tabSwitches, [], '没登录成功不能回首页');
  } finally {
    mock.getCurrentUser = originalGetCurrentUser;
  }
});

test('登录页 —— 表单校验不过时不提交，并逐字段报错', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();
  page.onGoRegister();

  assert.strictEqual(page.data.step, 'profile');

  // 注册要走数据源，onSubmit 因此是异步的——不等它跑完，断言会跑在错误之前
  await page.onSubmit();

  // 一项都没填，四个必填字段都该有错误提示
  assert.ok(page.data.errors.realName);
  assert.ok(page.data.errors.studentId);
  assert.ok(page.data.errors.college);
  assert.ok(page.data.errors.phone);
  assert.strictEqual(page.data.errorText, page.data.errors.realName);
  assert.strictEqual(page.data.step, 'profile', '校验失败不能跳到待审核');
  assert.strictEqual(app.globalData.userInfo, null, '校验失败不该写入登录态');
});

test('登录页 —— 填写完整后提交，申请落进数据源并停在待审核', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();
  page.onGoRegister();

  const membersBefore = (await facade.getMembers()).length;

  fillValidForm(page);
  await page.onSubmit();

  assert.strictEqual(page.data.step, 'pending');
  assert.strictEqual(page.data.pending.statusLabel, '待审核');
  assert.strictEqual(page.data.pending.realName, '马小雨');
  assert.ok(page.data.pending.studentId);
  assert.ok(page.data.errors.realName === undefined || page.data.errors.realName === '');
  assert.strictEqual(page.data.submitting, false, '提交完要把按钮解冻');

  assert.ok(app.globalData.userInfo, '注册后应把账号写进登录态');
  assert.strictEqual(app.globalData.userInfo.status, 0, '新账号必须是待审核');
  assert.strictEqual(page.data.existing.isPending, true);

  // 光有登录态还不够：不落到数据源，审核页就永远看不到这条申请
  const applications = await facade.getMemberApplications();
  assert.ok(
    applications.some((item) => item.realName === '马小雨' && item.status === USER_STATUS.PENDING),
    '注册产生的申请应当进入待审列表'
  );
  assert.strictEqual(
    (await facade.getMembers()).length,
    membersBefore,
    '还没通过审核的人不能被当成正式会员'
  );
});

test('登录页 —— 已经有账号的人再提交，结果页不说「申请已提交」', () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();

  // 同一个 OpenID 只有一条账号，重复注册时服务端把现有账号原样返回
  page.showPending(fakeMember({ _id: 'u01' }), {
    isPending: false,
    isActive: true,
    statusLabel: '正常',
    notice: '',
  });

  assert.strictEqual(page.data.pending.title, '你已经是会员了');
  assert.strictEqual(page.data.pending.actionLabel, '进入首页');
  assert.strictEqual(page.data.pending.statusClass, 'tag-success', '已经是正常会员，不能再挂黄色的待审核标签');
});

test('登录页 —— 真的待审核时结果页仍是「申请已提交」', () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();

  page.showPending(fakeMember({ _id: 'local_1', status: 0 }), {
    isPending: true,
    isActive: false,
    statusLabel: '待审核',
    notice: '实名信息正在审核，通过后即可录入比赛成绩',
  });

  assert.strictEqual(page.data.pending.title, '申请已提交');
  assert.strictEqual(page.data.pending.actionLabel, '先随便逛逛');
  assert.strictEqual(page.data.pending.statusClass, 'tag-warning');
});

test('登录页 —— 待审核那一步也能退出登录，并退回入口', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();
  page.onGoRegister();
  fillValidForm(page);
  await page.onSubmit();
  assert.strictEqual(page.data.step, 'pending');

  // 待审核页上不给退出，人就被锁在这一屏了
  page.onLogout();
  assert.strictEqual(page.data.step, 'entry', '退出后应回到入口，不能停在待审核');
  assert.strictEqual(page.data.existing.loggedIn, false);
  assert.strictEqual(app.globalData.userInfo, null);
});

test('登录页 —— 输入或选择学院会把该项的旧错误清掉', async () => {
  resetSession();
  const page = instantiate(loginConfig);
  page.onLoad();
  page.onGoRegister();
  await page.onSubmit();
  assert.ok(page.data.errors.realName);

  page.onInput({ currentTarget: { dataset: { field: 'realName' } }, detail: { value: '马小雨' } });
  assert.strictEqual(page.data.form.realName, '马小雨');
  assert.strictEqual(page.data.errors.realName, '');

  page.onPickCollege({ detail: { value: 0 } });
  assert.strictEqual(page.data.errors.college, '');
  assert.ok(page.data.form.college);
});

/** 往注册表单里填一份合法数据 */
function fillValidForm(page) {
  const values = { realName: '马小雨', studentId: '2023001234', phone: '13800138000' };
  for (const [field, value] of Object.entries(values)) {
    page.onInput({ currentTarget: { dataset: { field } }, detail: { value } });
  }
  page.onPickGender({ detail: { value: 0 } }); // 下拉第 1 项 = 男
  page.onPickCollege({ detail: { value: 0 } });
}

/* ============================================================
 * 比赛页
 * ============================================================ */

/** 造一个「已登录且审核通过」的会员——录入与撤销都要求这个身份 */
function activeMember(overrides = {}) {
  return fakeMember({ _id: 'u06', status: 1, ...overrides });
}

/** 一场可以直接提交的单打：我 vs 对手，11 分制三局两胜 */
function pendingParams() {
  return {
    matchType: MATCH_TYPE.SINGLES,
    teamA: [ME],
    teamB: [RIVAL],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    // 排在种子最后一场（8 月 22 日）之后，必然落在最近一批里，
    // 不受比赛页默认条数截断的影响
    matchTime: '2026-09-01T10:00:00',
    location: '学校体育馆 1 号场',
  };
}

const ME = 'u06';
const RIVAL = 'u02';

test('比赛页 —— 访客只看得到已生效的成绩，录入入口给出登录提示', async () => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.viewer.loggedIn, false);
  assert.strictEqual(page.data.auth.canRecord, false);
  assert.match(page.data.entryHint, /登录/);
  assert.ok(page.data.view.records.length > 0, '成绩公示对访客仍然可见');
  // 待确认与已撤销是流转中的临时状态，不该进入对外口径
  assert.ok(page.data.view.records.every((row) => row.status === MATCH_STATUS.ACTIVE));
});

test('比赛页 —— 登录后看到台账与自己的录入权限', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.auth.loggedIn, true);
  assert.strictEqual(page.data.auth.canRecord, true);
  assert.strictEqual(page.data.view.viewer.loggedIn, true);
  assert.match(page.data.entryHint, /计入等级分/);
  assert.strictEqual(page.data.view.tabs.filter((item) => item.active).length, 1);
});

test('比赛页 —— 切到「我参与的」，整页换成我的比赛', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });

  assert.strictEqual(page.data.view.activeTab, 'mine');
  assert.strictEqual(page.data.switching, false, '切完要把淡出状态收回');
  assert.ok(page.data.view.records.length > 0);
  assert.ok(page.data.view.records.every((row) => row.isMine));
});

test('比赛页 —— 重复点当前标签不做无谓的重新加载', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchTab({ currentTarget: { dataset: { tab: page.data.view.activeTab } } });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('比赛页 —— 台账每场都带赛制文案，11 分制三局两胜渲染得出来', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  const rows = page.data.view.records;
  assert.ok(rows.some((row) => row.formatText === '11 分制 · 三局两胜'));
  for (const row of rows) {
    // 老数据没有赛制时是空串，由模板挡住，不能是 undefined
    if (row.formatText) assert.match(row.formatText, /^\d+ 分制 · (一局一胜|三局两胜|五局三胜)$/);
  }
});

test('比赛页 —— 未登录时点录入只给提示，不进录入页', async () => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.toasts.length = 0;
  calls.navigations.length = 0;
  page.onGoEntry();

  assert.deepStrictEqual(calls.navigations, [], '没有身份就不该进录入页');
  assert.ok(calls.toasts.some((text) => /登录/.test(text)));
});

test('比赛页 —— 待审核账号不能录入，提示写明原因', async () => {
  resetSession();
  // 本地注册的账号状态是待审核，能登录但还没通过实名核对
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.match(page.data.entryHint, /审核/);

  calls.toasts.length = 0;
  calls.navigations.length = 0;
  page.onGoEntry();

  assert.deepStrictEqual(calls.navigations, []);
  assert.ok(calls.toasts.some((text) => /审核/.test(text)));
});

test('比赛页 —— 正常账号点录入跳到录入页', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoEntry();
  assert.deepStrictEqual(calls.navigations, ['/pages/match-entry/match-entry']);
});

test('比赛页 —— 点队名跳到该会员主页', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onOpenMember({ currentTarget: { dataset: { userId: 'u01' } } });
  assert.deepStrictEqual(calls.navigations, ['/pages/member/member?userId=u01']);
});

test('比赛页 —— 确认后成绩计入等级分，待确认标签随即空掉', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  // 只有已生效的比赛才进回放集，多出一场即证明它已计入等级分
  const before = (await facade.getMatches()).length;

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'pending' } } });

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row, '刚提交的比赛应当出现在待确认里');
  assert.strictEqual(row.statusLabel, '待确认');
  assert.strictEqual(row.canConfirm, true);

  calls.toasts.length = 0;
  await page.onConfirm({ currentTarget: { dataset: { matchId: match._id } } });

  assert.strictEqual((await facade.getMatches()).length, before + 1);
  assert.deepStrictEqual(page.data.view.records, [], '确认之后待确认里就不该再有它');
  assert.ok(calls.toasts.some((text) => /已计入等级分/.test(text)));
});

test('比赛页 —— 撤销后分数回滚，理由留在台账里', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  await facade.confirmMatch(match._id, ME);
  const beforeRevoke = (await facade.getMatches()).length;

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual(row.canRevoke, true, '录入者应当能撤销自己录的比赛');

  await page.onOpenAction({ currentTarget: { dataset: { matchId: match._id, kind: 'revoke' } } });
  page.onInputReason({ detail: { value: '这局其实没打完' } });

  calls.toasts.length = 0;
  await page.onSubmitAction();

  // 撤销只是写一条改判，下一次加载把它从回放集里丢掉——分数就这样回滚
  assert.strictEqual((await facade.getMatches()).length, beforeRevoke - 1);
  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.REVOKED);
  assert.strictEqual(ledgerRow.reason, '这局其实没打完');

  const after = page.data.view.records.find((item) => item.matchId === match._id);
  assert.strictEqual(after.statusLabel, '已撤销');
  assert.strictEqual(after.statusReason, '这局其实没打完');
  assert.ok(calls.toasts.some((text) => /已撤销/.test(text)));
});

test('比赛页 —— 撤销不填理由被拦下，比赛原样不动', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  await facade.confirmMatch(match._id, ME);

  const page = instantiate(matchConfig);
  await page.onLoad();

  await page.onOpenAction({ currentTarget: { dataset: { matchId: match._id, kind: 'revoke' } } });
  await page.onSubmitAction();

  assert.strictEqual(page.data.actionError, '请填写理由');
  assert.strictEqual(page.data.action.open, true, '校验失败时面板不该关掉');
  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.ACTIVE, '没有理由就不能作废成绩');
});

test('比赛页 —— 驳回与撤销共用终态，但文案要分得清', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());

  const page = instantiate(matchConfig);
  await page.onLoad();

  await page.onOpenAction({ currentTarget: { dataset: { matchId: match._id, kind: 'reject' } } });
  assert.strictEqual(page.data.action.title, '驳回这场比分');
  page.onInputReason({ detail: { value: '第二局比分录反了' } });
  await page.onSubmitAction();

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.REVOKED);
  assert.strictEqual(ledgerRow.action, 'reject');

  // 终态一样，靠 action 把文案区分开——为驳回单开枚举会波及所有判断
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });
  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.strictEqual(row.statusLabel, '已驳回');
});

test('比赛页 —— 下拉刷新会收起刷新动画', async () => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

/* ============================================================
 * 录入比赛成绩
 * ============================================================ */

/** 把一份可直接提交的单打表单填满：我 vs 对手，11 分制三局两胜 */
function fillSinglesForm(page) {
  page.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: RIVAL } } });
  const scores = [
    ['A', 0, '11'],
    ['B', 0, '9'],
    ['A', 1, '11'],
    ['B', 1, '7'],
  ];
  for (const [side, slot, value] of scores) {
    page.onInputScore({ currentTarget: { dataset: { side, slot } }, detail: { value } });
  }
}

test('录入页 —— 首屏把 A 队第一格锁成自己，赛制默认 11 分制三局两胜', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.blockReason, '');
  assert.strictEqual(page.data.members.length, 24, '选手名单必须来自会员表');

  assert.strictEqual(page.data.form.matchType, MATCH_TYPE.SINGLES);
  assert.strictEqual(page.data.teamARows.length, 1);
  assert.strictEqual(page.data.teamARows[0].locked, true, '「我」这一格不给选');
  assert.strictEqual(page.data.teamARows[0].id, 'u06');
  assert.strictEqual(page.data.scoreRows.length, 3);
  assert.strictEqual(page.data.formatText, '11 分制 · 三局两胜');
  // 时间默认填今天与此刻：绝大多数比赛是刚打完就来录的
  assert.match(page.data.form.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(page.data.form.time, /^\d{2}:\d{2}$/);
});

test('录入页 —— 未登录直接进来会被整页挡住，提交也无从谈起', async () => {
  resetSession();
  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.strictEqual(page.data.blockReason, '请先登录后再录入比赛成绩');

  const before = (await facade.getMatchRecords()).length;
  await page.onSubmit();
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

test('录入页 —— 切双打后两队各两格，自己仍锁在第一格', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.DOUBLES } } });

  assert.strictEqual(page.data.form.matchType, MATCH_TYPE.DOUBLES);
  assert.strictEqual(page.data.teamARows.length, 2);
  assert.strictEqual(page.data.teamBRows.length, 2);
  assert.strictEqual(page.data.teamARows[0].locked, true);
  assert.strictEqual(page.data.teamARows[1].locked, false);
});

test('录入页 —— 双打换回单打时多出来的队友被丢掉，自己留下', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.DOUBLES } } });
  page.onPickMember({ currentTarget: { dataset: { side: 'A', slot: 1, id: RIVAL } } });
  assert.strictEqual(page.data.teamARows[1].id, RIVAL);

  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.SINGLES } } });

  assert.strictEqual(page.data.teamARows.length, 1);
  assert.strictEqual(page.data.teamARows[0].id, 'u06');
});

test('录入页 —— 点格子打开找人面板，默认列出全部会员', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  assert.strictEqual(page.data.pickerVisible, true);
  assert.strictEqual(page.data.pickerSide, 'B');
  assert.strictEqual(page.data.pickerKeyword, '');
  assert.strictEqual(page.data.pickerRows.length, page.data.members.length);
});

test('录入页 —— 面板里输入名字后只剩命中的人', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  const target = page.data.members[0];
  page.onInputPickerKeyword({ detail: { value: target.name } });

  assert.ok(page.data.pickerRows.length >= 1);
  assert.ok(page.data.pickerRows.every((row) => row.name.includes(target.name)));
  assert.strictEqual(page.data.pickerKeyword, target.name);
});

test('录入页 —— 面板里搜不到时，提示带上搜索词', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  page.onInputPickerKeyword({ detail: { value: '查无此人' } });

  assert.strictEqual(page.data.pickerRows.length, 0);
  assert.ok(page.data.pickerEmptyText.includes('查无此人'));

  // 清空搜索后名单恢复
  page.onClearPickerKeyword();
  assert.strictEqual(page.data.pickerKeyword, '');
  assert.strictEqual(page.data.pickerRows.length, page.data.members.length);
});

test('录入页 —— 点中一个人填进那一格，并收起面板清掉搜索词', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });
  page.onInputPickerKeyword({ detail: { value: '张' } });

  page.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: RIVAL } } });

  assert.strictEqual(page.data.teamBRows[0].id, RIVAL);
  assert.ok(page.data.teamBRows[0].name, '选完要能显示昵称');
  assert.strictEqual(page.data.pickerVisible, false);
  assert.strictEqual(page.data.pickerKeyword, '');
  assert.deepStrictEqual(page.data.pickerRows, []);
});

test('录入页 —— 收起面板不改动任何一格', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  page.onClosePicker();

  assert.strictEqual(page.data.pickerVisible, false);
  assert.strictEqual(page.data.teamBRows[0].id, '', '只是关掉面板，不能顺手把格子清空');
});

test('录入页 —— 面板里会勾出这一格当前选中的人', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onPickMember({ currentTarget: { dataset: { side: 'B', slot: 0, id: RIVAL } } });

  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  const picked = page.data.pickerRows.find((row) => row.id === RIVAL);
  assert.strictEqual(picked.selected, true);
  assert.strictEqual(page.data.pickerRows.filter((row) => row.selected).length, 1);
});

test('录入页 —— 换局制时比分输入行跟着变，已填的比分之一保留', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  page.onInputScore({ currentTarget: { dataset: { side: 'A', slot: 0 } }, detail: { value: '11' } });
  // BEST_OF_OPTIONS = [1, 3, 5]，下标 2 是五局三胜
  page.onPickBestOf({ detail: { value: 2 } });

  assert.strictEqual(page.data.form.bestOf, 5);
  assert.strictEqual(page.data.scoreRows.length, 5, '五局三胜要有五行输入框');
  assert.strictEqual(page.data.scoreRows[0].a, '11', '改局制不该把已填的比分清掉');
});

test('录入页 —— 换分制后赛制文案跟着变', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  // GAME_POINTS_OPTIONS = [11, 15, 21]，下标 1 是 15 分制
  page.onPickGamePoints({ detail: { value: 1 } });

  assert.strictEqual(page.data.form.gamePoints, 15);
  assert.strictEqual(page.data.formatText, '15 分制 · 三局两胜');
});

test('录入页 —— 比分填完就实时预告谁赢，不用用户心算', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  fillSinglesForm(page);

  // u06 的昵称是「明宇」，真名「赵明宇」只在「我的」页以小字并排显示
  assert.strictEqual(page.data.winnerText, '明宇 胜');
});

test('录入页 —— 没选对手就提交，逐字段标红且不写台账', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  const before = (await facade.getMatchRecords()).length;
  await page.onSubmit();

  assert.ok(page.data.errors.teamB, '缺对手应当在 B 队上报错');
  assert.ok(page.data.errorText, '只标红不滚屏的话，用户可能找不到错在哪');
  assert.strictEqual(page.data.submitting, false);
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

test('录入页 —— 比分没打完被拦下，提示具体是哪一局', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  fillSinglesForm(page);
  // 11:10 是没打完的局：先到 11 分还要领先 2 分才算赢
  page.onInputScore({ currentTarget: { dataset: { side: 'B', slot: 0 } }, detail: { value: '10' } });

  const before = (await facade.getMatchRecords()).length;
  await page.onSubmit();

  assert.ok(page.data.scoreErrors.length > 0);
  assert.match(page.data.errorText, /第 1 局/);
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

test('录入页 —— 提交成功后返回上一页，台账里多出一场待确认', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  fillSinglesForm(page);
  const before = (await facade.getMatchRecords()).length;

  calls.toasts.length = 0;
  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.submitting, false);
  assert.strictEqual(page.data.errorText, '');
  assert.deepStrictEqual(calls.toasts, ['已提交，等待对手确认']);
  assert.strictEqual(calls.backCount, 1, '录完要退回比赛页，onShow 会刷新出这一场');

  const ledger = await facade.getMatchRecords();
  assert.strictEqual(ledger.length, before + 1);

  // 录入一律先记「待确认」——成绩要对手确认后才生效
  const record = ledger.find((item) => item.status === MATCH_STATUS.PENDING);
  assert.ok(record, '新增的这一场应当是待确认');
  assert.strictEqual(record.recorder, 'u06');
  assert.strictEqual(record.pool, 'singles');
  assert.strictEqual(record.gamePoints, 11);
  assert.strictEqual(record.bestOf, 3);
  assert.deepStrictEqual(record.teamA, ['u06']);
  assert.deepStrictEqual(record.teamB, [RIVAL]);
  assert.strictEqual(record.winner, 'A');
});

test('录入页 —— 取消直接返回，同样不写台账', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  const before = (await facade.getMatchRecords()).length;
  calls.backCount = 0;
  page.onCancel();

  assert.strictEqual(calls.backCount, 1);
  assert.strictEqual((await facade.getMatchRecords()).length, before);
});

/* ============================================================
 * 会员审核
 * ============================================================ */

test('会员审核页 —— 访客被整页挡住，一行申请人的资料都拿不到', async () => {
  resetSession();
  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.allowed, false);
  assert.deepStrictEqual(page.data.view.rows, [], '没权限就不该下发任何一行申请');
  assert.match(page.data.view.blockedText, /登录/);

  // 防泄漏不能只测 rows：整页数据里都不能出现申请人的学号
  const text = JSON.stringify(page.data.view);
  assert.ok(!text.includes('20240117'), '访客的页面数据里漏出了申请人的学号');
});

test('会员审核页 —— 待审核账号自己还没转正，不能去审别人', async () => {
  resetSession();
  // 本地注册的账号状态是待审核，能登录，但资格还没被核对
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, false);
  assert.deepStrictEqual(page.data.view.rows, []);
  assert.match(page.data.view.blockedText, /权限/);
});

test('会员审核页 —— 正常会员看到两条待审申请，并挂出演示口径提示', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, true);
  assert.strictEqual(page.data.view.rows.length, 2);
  assert.strictEqual(page.data.view.pendingCount, 2);
  assert.ok(page.data.view.demoNotice, 'mock 放宽了审核权，必须在页面上写明这是演示口径');
  assert.strictEqual(page.data.view.tabs.filter((item) => item.active).length, 1);
  assert.strictEqual(page.data.view.viewer.roleLabel, '会员');

  const text = JSON.stringify(page.data.view);
  assert.ok(!text.includes('undefined'), '视图数据里出现了 undefined');
  assert.ok(!text.includes('null'), '视图数据里出现了 null');
  assert.ok(!text.includes('NaN'), '视图数据里出现了 NaN');
});

test('会员审核页 —— 通过后申请离开待审列表，申请人成为正式会员', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const applicationId = page.data.view.rows[0].applicationId;
  const membersBefore = (await facade.getMembers()).length;

  calls.toasts.length = 0;
  await page.onApprove({ currentTarget: { dataset: { applicationId } } });

  assert.strictEqual(page.data.view.rows.length, 1, '处理过的申请不该还留在待审里');
  assert.strictEqual((await facade.getMembers()).length, membersBefore + 1);
  assert.ok(calls.toasts.some((text) => /已通过/.test(text)));
  // 通过的人立刻进入会员名单，录入页的选手选择器就能选到他
  assert.ok((await facade.getMembers()).some((item) => item._id === applicationId));
});

test('会员审核页 —— 驳回不填理由被拦下，申请原样不动', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const applicationId = page.data.view.rows[0].applicationId;
  await page.onOpenReject({ currentTarget: { dataset: { applicationId } } });
  await page.onSubmitAction();

  assert.strictEqual(page.data.actionError, '请填写驳回理由');
  assert.strictEqual(page.data.action.open, true, '校验失败时面板不该关掉');

  const account = await facade.getMember(applicationId);
  assert.strictEqual(account.status, USER_STATUS.PENDING, '没有理由就不能驳回');
});

test('会员审核页 —— 驳回后进「已处理」标签页，理由留在卡片上', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const applicationId = page.data.view.rows[0].applicationId;
  await page.onOpenReject({ currentTarget: { dataset: { applicationId } } });
  page.onInputReason({ detail: { value: '学号与姓名对不上' } });

  calls.toasts.length = 0;
  await page.onSubmitAction();

  assert.strictEqual(page.data.view.rows.length, 1, '驳回的申请也该离开待审列表');
  assert.ok(calls.toasts.some((text) => /已驳回/.test(text)));

  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'handled' } } });

  const row = page.data.view.rows.find((item) => item.applicationId === applicationId);
  assert.ok(row, '驳回过的申请应当出现在「已处理」里');
  assert.strictEqual(row.statusLabel, '已驳回');
  assert.strictEqual(row.reason, '学号与姓名对不上');
  assert.strictEqual(row.canApprove, false, '处理过的申请不该再有按钮');
  assert.strictEqual(row.canReject, false);
});

test('会员审核页 —— 重复点当前标签不做无谓的重新加载', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchTab({ currentTarget: { dataset: { tab: page.data.view.activeTab } } });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('会员审核页 —— 下拉刷新会收起刷新动画', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

/* ============================================================
 * 公告列表页
 * ============================================================ */

test('首页 —— 点公告卡片跳到公告列表页', async () => {
  resetSession();

  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoAnnouncements();
  assert.deepStrictEqual(calls.navigations, ['/pages/announcements/announcements']);
});

test('公告列表页 —— 未登录也能看，置顶排最前且绝无管理按钮', async () => {
  resetSession();

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.total, 6);
  assert.strictEqual(page.data.view.rows[0].pinned, true);
  // 公开页的每一行都不带管理按钮——视图模型给的是 actor: null
  for (const row of page.data.view.rows) {
    assert.strictEqual(row.canArchive, false);
  }
});

test('公告列表页 —— 点分类标签整页换成该分类，别的分类计数不归零', async () => {
  resetSession();

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  await page.onSwitchTab({ currentTarget: { dataset: { tab: '赛事' } } });

  assert.strictEqual(page.data.view.activeTab, '赛事');
  assert.strictEqual(page.data.view.rows.length, 2);
  for (const row of page.data.view.rows) assert.strictEqual(row.category, '赛事');
  assert.strictEqual(page.data.view.tabs.find((t) => t.tab === '通知').count, 2);
});

test('公告列表页 —— 重复点当前标签不做无谓的重新加载', async () => {
  resetSession();

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchTab({ currentTarget: { dataset: { tab: page.data.view.activeTab } } });

  assert.strictEqual(page.data.view, before);
});

test('公告列表页 —— 下拉刷新会收起刷新动画', async () => {
  resetSession();

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});

/* ============================================================
 * 公告管理页
 * ============================================================ */

test('公告管理页 —— 访客被整页挡住，一条公告台账都拿不到', async () => {
  resetSession();

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, false);
  assert.deepStrictEqual(page.data.view.rows, []);
  assert.match(page.data.view.blockedText, /登录/);
});

test('公告管理页 —— 正常会员看到台账，并挂出演示口径提示', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, true);
  assert.strictEqual(page.data.view.total, 6);
  assert.strictEqual(page.data.view.publishedCount, 6);
  assert.strictEqual(page.data.view.archivedCount, 0);
  assert.ok(page.data.view.demoNotice.length > 0);
  // 有发布权时每一行都给下架按钮
  assert.strictEqual(page.data.view.rows[0].canArchive, true);
});

test('公告管理页 —— 下架后台账里仍在、沉到底部且不再给按钮，公开页少一条', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  const target = page.data.view.rows[0].id;
  await page.onArchive({ currentTarget: { dataset: { id: target } } });

  assert.strictEqual(page.data.view.total, 6);
  assert.strictEqual(page.data.view.publishedCount, 5);
  assert.strictEqual(page.data.view.archivedCount, 1);

  const last = page.data.view.rows[page.data.view.rows.length - 1];
  assert.strictEqual(last.id, target);
  assert.strictEqual(last.archived, true);
  assert.strictEqual(last.canArchive, false);

  assert.strictEqual((await facade.getAnnouncements()).length, 5);
});

test('公告管理页 —— 点发布跳到发布页', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoPublish();
  assert.deepStrictEqual(calls.navigations, ['/pages/announcement-edit/announcement-edit']);
});

test('公告管理页 —— 从发布页返回时刷新台账', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementManageConfig);
  await page.onLoad();
  assert.strictEqual(page.data.view.total, 6);

  // 模拟在发布页里发了一条，返回时 onShow 应当把它带出来
  await facade.publishAnnouncement(
    { title: '临时通知', content: '明天停训一次。', category: '通知' },
    'u06'
  );
  await page.onShow();

  assert.strictEqual(page.data.view.total, 7);
});

/* ============================================================
 * 发布公告页
 * ============================================================ */

test('发布公告页 —— 未登录被整页挡住，表单都不给', () => {
  resetSession();

  const page = instantiate(announcementEditConfig);
  page.onLoad();

  assert.match(page.data.blockReason, /登录/);
});

test('发布公告页 —— 正常会员能填表，填好后提交落进数据源并返回上一页', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementEditConfig);
  page.onLoad();
  assert.strictEqual(page.data.blockReason, '');

  page.onInputTitle({ detail: { value: '周末训练改到周六' } });
  page.onInputContent({ detail: { value: '因场地检修，本周训练顺延一天。' } });

  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.submitting, false);
  assert.deepStrictEqual(page.data.errors, {});
  assert.strictEqual(calls.backCount, 1);

  const list = await facade.getAnnouncements();
  assert.ok(list.some((item) => item.title === '周末训练改到周六'));
});

test('发布公告页 —— 标题为空时不提交，逐字段报错', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementEditConfig);
  page.onLoad();

  const before = (await facade.getAnnouncements()).length;
  page.onInputContent({ detail: { value: '只有正文，没有标题。' } });

  calls.backCount = 0;
  await page.onSubmit();

  assert.ok(page.data.errors.title);
  assert.ok(page.data.errorText);
  assert.strictEqual(calls.backCount, 0);
  // 校验不过不许留下任何痕迹
  assert.strictEqual((await facade.getAnnouncements()).length, before);
});

test('发布公告页 —— 输入标题会把该项的旧错误清掉', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(announcementEditConfig);
  page.onLoad();

  await page.onSubmit();
  assert.ok(page.data.errors.title);

  page.onInputTitle({ detail: { value: '训练通知' } });
  assert.strictEqual(page.data.errors.title, '');
});

/* ============================================================
 * 编辑资料页
 * ============================================================ */

/** 一位带实名信息的已登录会员，编辑页要拿它填只读的姓名与学号 */
function loggedInWithRealName(overrides = {}) {
  return loginAs({ realName: '赵明宇', studentId: '20230006', ...overrides });
}

test('编辑资料页 —— 未登录被整页挡住，表单都不给', () => {
  resetSession();

  const page = instantiate(profileEditConfig);
  page.onLoad();

  assert.match(page.data.blockReason, /登录/);
});

test('编辑资料页 —— 已登录时填入当前昵称，真名与学号只读展示', () => {
  resetSession();
  loggedInWithRealName();

  const page = instantiate(profileEditConfig);
  page.onLoad();

  assert.strictEqual(page.data.blockReason, '');
  assert.strictEqual(page.data.form.nickName, '赵明宇');
  assert.strictEqual(page.data.realName, '赵明宇');
  assert.strictEqual(page.data.studentId, '20230006');
});

test('编辑资料页 —— 改昵称保存：落进数据源、更新登录态、返回上一页', async () => {
  resetSession();
  loggedInWithRealName();

  const page = instantiate(profileEditConfig);
  page.onLoad();

  page.onInputNickname({ detail: { value: '小明' } });

  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.submitting, false);
  assert.deepStrictEqual(page.data.errors, {});
  assert.strictEqual(calls.backCount, 1);

  // 数据层与本地登录态都要更新，否则「我的」页返回后仍是旧名字
  assert.strictEqual((await facade.getMember('u06')).nickName, '小明');
  assert.strictEqual(app.globalData.userInfo.nickName, '小明');
  // 实名信息不因改昵称而变动
  assert.strictEqual(app.globalData.userInfo.realName, '赵明宇');
});

test('编辑资料页 —— 昵称清空时不提交，逐字段报错且不返回', async () => {
  resetSession();
  loggedInWithRealName();

  const page = instantiate(profileEditConfig);
  page.onLoad();

  page.onInputNickname({ detail: { value: '   ' } });

  calls.backCount = 0;
  await page.onSubmit();

  assert.ok(page.data.errors.nickName);
  assert.ok(page.data.errorText);
  assert.strictEqual(calls.backCount, 0);
  assert.strictEqual((await facade.getMember('u06')).nickName, '明宇');
});

test('编辑资料页 —— 选择头像写入表单，本地模拟下原样保留临时路径', async () => {
  resetSession();
  loggedInWithRealName();

  const page = instantiate(profileEditConfig);
  page.onLoad();

  await page.onChooseAvatar({ detail: { avatarUrl: 'http://tmp/abc.png' } });
  assert.strictEqual(page.data.form.avatarUrl, 'http://tmp/abc.png');
});

test('编辑资料页 —— 输入昵称会把旧的错误提示清掉', async () => {
  resetSession();
  loggedInWithRealName();

  const page = instantiate(profileEditConfig);
  page.onLoad();

  page.setData({ 'form.nickName': '' });
  await page.onSubmit();
  assert.ok(page.data.errors.nickName);

  page.onInputNickname({ detail: { value: '新昵称' } });
  assert.strictEqual(page.data.errors.nickName, '');
  assert.strictEqual(page.data.errorText, '');
});

test('编辑资料页 —— 调用抛异常时也要给出提示并恢复按钮，不能点了没反应', async () => {
  resetSession();
  loggedInWithRealName();

  // 云端未部署新版（「未知的操作」）或网络断开时，取数层是直接抛错的
  const original = mock.updateProfile;
  mock.updateProfile = async () => {
    throw new Error('未知的操作：updateProfile');
  };

  try {
    const page = instantiate(profileEditConfig);
    page.onLoad();
    page.onInputNickname({ detail: { value: '新名字' } });

    calls.backCount = 0;
    await page.onSubmit();

    assert.strictEqual(page.data.submitting, false, '按钮必须放回来');
    assert.ok(page.data.errorText);
    assert.strictEqual(calls.backCount, 0, '没保存成功就不能返回');
  } finally {
    mock.updateProfile = original;
  }
});

/* ============================================================
 * 「我的」页 —— 头像入口与改完后的回显
 * ============================================================ */

test('我的页 —— 未登录时不给个人数据，也不给编辑资料入口', async () => {
  resetSession();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loggedIn, false, '没登录就没有编辑入口');
  assert.strictEqual(page.data.view.found, false, '没登录也不该渲染别人的战绩');
});

test('我的页 —— 改完昵称返回后会重取数据，头卡显示新名字', async () => {
  resetSession();
  loginAs();
  await facade.resetCache();

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.view.user.nickName, '明宇');

  // 模拟在编辑页里改了昵称：数据源与本地登录态都更新，再返回本页
  await facade.updateProfile({ nickName: '改过的名字' }, 'u06');
  app.globalData.userInfo = fakeMember({ nickName: '改过的名字' });

  await page.onShow();

  // 只比编号就不会重取，这一页会一直挂着旧名字
  assert.strictEqual(page.data.view.user.nickName, '改过的名字');
  assert.strictEqual(page.data.view.user.realName, '赵明宇');
});

/* ============================================================
 * 赛季管理页
 * ============================================================ */

test('赛季管理页 —— 访客被整页挡住，赛季数据一个字段都拿不到', async () => {
  resetSession();

  const page = instantiate(seasonManageConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, false);
  assert.match(page.data.view.blockedText, /登录/);
  assert.strictEqual(page.data.view.policyText, '');
});

test('赛季管理页 —— 正常会员看到赛季状态与压分说明，并挂出演示口径提示', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(seasonManageConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, true);
  assert.strictEqual(page.data.view.hasReset, false);
  assert.strictEqual(page.data.view.resetText, '本赛季尚未重置');
  assert.ok(page.data.view.policyText, '要说明重置后会怎么压分');
  assert.ok(page.data.view.demoNotice.length > 0);
});

test('赛季管理页 —— 执行重置后状态翻新并给出成功提示', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(seasonManageConfig);
  await page.onLoad();
  assert.strictEqual(page.data.view.hasReset, false);

  calls.toasts.length = 0;
  await page.onReset();

  assert.strictEqual(page.data.view.hasReset, true);
  assert.notStrictEqual(page.data.view.resetText, '本赛季尚未重置');
  assert.strictEqual(page.data.acting, false, '动作结束后按钮要能再点');
  assert.ok(calls.toasts.includes('新赛季已开始'));
});

test('赛季管理页 —— 从别处返回时刷新状态', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(seasonManageConfig);
  await page.onLoad();
  assert.strictEqual(page.data.view.hasReset, false);

  // 模拟管理员在别处刚重置过，返回本页时不该仍显示「尚未重置」
  await facade.resetSeason('u06');
  await page.onShow();

  assert.strictEqual(page.data.view.hasReset, true);
});

test('赛季管理页 —— 下拉刷新会收掉刷新动画', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(seasonManageConfig);
  await page.onLoad();

  calls.pullDownStopped = 0;
  await page.onPullDownRefresh();
  assert.strictEqual(calls.pullDownStopped, 1);
});
