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
  ROLE,
  MATCH_STATUS,
  MATCH_OUTCOME,
  MATCH_TYPE,
  USER_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  SIGNUP_STATUS,
  EVENT_FORMAT,
  EVENT_PLACEMENT_MODE,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  RATED_PAIR_LIMIT,
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
  // 弃权确认框的内容。默认一律「确认」，用例要测取消就把 modalConfirmed 置 false
  modals: [],
  modalConfirmed: true,
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
  // 弃权等破坏性操作先弹确认框。这里同步回调，用例不必自己造 Promise
  showModal: (options) => {
    calls.modals.push(options.content || options.title || '');
    const confirmed = calls.modalConfirmed !== false;
    if (typeof options.success === 'function') {
      options.success({ confirm: confirmed, cancel: !confirmed });
    }
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
require('../miniprogram/pages/events/events.js');
require('../miniprogram/pages/event-detail/event-detail.js');
require('../miniprogram/pages/event-edit/event-edit.js');
require('../miniprogram/pages/event-placement/event-placement.js');
require('../miniprogram/pages/college-event-edit/college-event-edit.js');
require('../miniprogram/pages/college-entry/college-entry.js');
require('../miniprogram/pages/college-entry-review/college-entry-review.js');
require('../miniprogram/pages/college-event-detail/college-event-detail.js');
require('../miniprogram/pages/college-lineup/college-lineup.js');
require('../miniprogram/pages/college-match/college-match.js');
require('../miniprogram/pages/college-placement/college-placement.js');
require('../miniprogram/pages/event-list/event-list.js');
require('../miniprogram/pages/live-score/live-score.js');

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
const eventsConfig = registered[13];
const eventDetailConfig = registered[14];
const eventEditConfig = registered[15];
const eventPlacementConfig = registered[16];
const collegeEventEditConfig = registered[17];
const collegeEntryConfig = registered[18];
const collegeEntryReviewConfig = registered[19];
const collegeEventDetailConfig = registered[20];
const collegeLineupConfig = registered[21];
const collegeMatchConfig = registered[22];
const collegePlacementConfig = registered[23];
// 「查看全部」列表页，最后注册，下标自然接在末尾
const eventListConfig = registered[24];
// 实时计分台（唯一的横屏页），注册顺序在最后
const liveScoreConfig = registered[25];

// 写接口（确认 / 撤销 / 录入）只改内存，跑完一条用例就得把内存退回种子状态，
// 否则上一条确认过的比赛会让下一条拿到的榜单与台账都不一样
beforeEach(() => {
  facade.resetCache();
  calls.modals.length = 0;
  calls.modalConfirmed = true;
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

/**
 * 演示数据里的两种管理者。
 * 发布 / 抽签 / 开始 / 结束赛事一律只有管理员能做；学院负责人比会员多的只是
 * 「代签到」与「录入比分」——普通会员（默认 u06）与线上一样被挡住。
 * 管理类动作要按对应身份登录，别再拿普通会员顶替。
 */
const STAFF = { role: 1, _id: 'u02', nickName: '张宇轩' };
const ADMIN = { role: 2, _id: 'u01', nickName: '巴特尔' };

/* ============================================================
 * 首页
 * ============================================================ */

test('首页 —— 访客只看得到公告，赛事与概况一概不取', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.dataSourceLabel, '本地模拟数据');
  assert.strictEqual(page.data.auth.loggedIn, false);
  // 个人分数已经收进排行榜与「我的」页，首页不再摆一份
  assert.strictEqual(page.data.view.scoreCard, undefined);
  // 游客只看得到公告（需求整理 §11.8）：赛事与概况都不取
  assert.ok(page.data.view.announcements.rows.length > 0, '访客能看公告');
  assert.deepStrictEqual(page.data.view.upcomingEvents, [], '访客看不到近期赛事');
  assert.strictEqual(page.data.view.summary, null, '访客看不到概况');
});

test('首页 —— 点登录引导跳到登录注册页', async () => {
  resetSession();
  const page = instantiate(indexConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
});

test('首页 —— 近期赛事只列报名中/进行中，按开赛时间升序且不超过三条', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  const rows = page.data.view.upcomingEvents;
  assert.ok(rows.length > 0, '种子里有进行中的赛事');
  assert.ok(rows.length <= 3, '首屏只放得下三条');

  // 已结束的赛事不进「近期」，否则历史赛事会把还能报名的挤下去
  for (const row of rows) {
    assert.ok(
      row.status === EVENT_STATUS.SIGNUP || row.status === EVENT_STATUS.ONGOING,
      `不该出现状态为 ${row.status} 的赛事`
    );
  }

  // 开赛时间升序：最近要打的排在最前面
  const times = rows.map((row) => new Date(row.timeText.replace(/-/g, '/')).getTime());
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), '按开赛时间升序');
});

test('首页 —— 一场近期赛事都没有时照常出卡，由模板写空态', async () => {
  resetSession();
  loginAs();
  const original = mock.getEvents;
  // 把赛事全换成已结束的：近期赛事应当筛成空数组，但字段仍在
  mock.getEvents = async () => [
    {
      _id: 'e_x',
      title: '往届赛事',
      matchType: MATCH_TYPE.SINGLES,
      status: EVENT_STATUS.FINISHED,
      startTime: '2026-01-01T09:00:00',
      quota: 8,
    },
  ];

  try {
    const page = instantiate(indexConfig);
    await page.onLoad();
    assert.deepStrictEqual(page.data.view.upcomingEvents, [], '已结束的赛事不算近期');
  } finally {
    mock.getEvents = original;
  }
});

test('首页 —— 登录后近期赛事标出自己报没报', async () => {
  resetSession();
  const events = await facade.getEvents();
  const upcoming = events.find((item) => item.status === EVENT_STATUS.ONGOING);
  assert.ok(upcoming, '种子里有进行中的赛事');

  // 名单里挑一个真实报名者来登录，免得断言依赖某个写死的账号
  const signups = await facade.getEventSignups(upcoming._id);
  assert.ok(signups.length > 0);
  app.globalData.userInfo = fakeMember({ _id: signups[0].userId, nickName: '报名者' });

  const page = instantiate(indexConfig);
  await page.onLoad();

  const mine = page.data.view.upcomingEvents.find((row) => row.id === upcoming._id);
  assert.ok(mine, '进行中的赛事在近期列表里');
  assert.strictEqual(mine.signedUp, true);
});

test('首页 —— 待审核的账号能登录，首页照常可看', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ _id: 'local_1', nickName: '新会员', status: 0 });

  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.auth.isPending, true);
  assert.strictEqual(page.data.auth.canRecord, false);
  // 首页两块内容与登录状态无关，待审核账号也看得到
  assert.ok(page.data.view.announcements.rows.length > 0);
  assert.ok(Array.isArray(page.data.view.upcomingEvents));
});

test('首页 —— 点近期赛事的一条会进详情', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  const target = page.data.view.upcomingEvents[0].id;
  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: { eventId: target } } });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/event-detail/event-detail?eventId=${target}`,
  ]);

  // 没有编号的空白行不该乱跳
  calls.navigations.length = 0;
  page.onOpenEvent({ currentTarget: { dataset: {} } });
  assert.deepStrictEqual(calls.navigations, []);
});

test('首页 —— 公告与概况都有内容，数据里没有 undefined 或 NaN', async () => {
  resetSession();
  loginAs();
  const page = instantiate(indexConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.summary.memberCount, 24);
  assert.ok(page.data.view.summary.matchCount > 0);
  assert.ok(page.data.view.announcements.rows.length > 0);

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

test('首页 —— 可切换浏览的学校，切到外校进入只读', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  schoolSession.reset();
  // 让模拟身份带本校学籍（民大），切走后才判得出「正在浏览外校」
  schoolMock.setDemoActor('demo_muc_member');
  try {
    resetSession();
    const page = instantiate(indexConfig);
    await page.onLoad();

    assert.ok(page.data.schoolList.length >= 2, '双校目录里至少两所学校');
    assert.strictEqual(page.data.schoolId, 'muc');
    assert.strictEqual(page.data.readOnlySchool, false);

    page.onSchoolChange({ detail: { schoolId: 'buaa' } });
    assert.strictEqual(page.data.schoolId, 'buaa');
    assert.strictEqual(page.data.schoolName, '北京航空航天大学');
    assert.strictEqual(page.data.readOnlySchool, true, '切到外校后进入只读');
  } finally {
    schoolMock.setDemoActor('demo_applicant');
    schoolSession.reset();
  }
});

test('首页 —— 切到北航显示北航自己的演示内容', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  schoolSession.reset();
  schoolMock.setDemoActor('demo_muc_member');
  try {
    resetSession();
    loginAs();
    const page = instantiate(indexConfig);
    await page.onLoad();

    // 本校（民大）展示应用本身的跨协会聚合内容，不是北航演示
    assert.strictEqual(page.data.schoolContent, false);
    assert.ok(!page.data.view.announcements.rows.every((row) => row.associationName === '北航'));

    page.onSchoolChange({ detail: { schoolId: 'buaa' } });

    assert.strictEqual(page.data.schoolContent, true);
    const rows = page.data.view.announcements.rows;
    assert.ok(rows.length > 0, '北航有演示公告');
    assert.ok(rows.every((row) => row.associationName === '北航'), '每条都标成北航');
    assert.ok(page.data.view.upcomingEvents.length > 0, '北航有演示赛事');
    assert.ok(page.data.view.summary.memberCount > 0);
    assert.strictEqual(page.data.view.loggedIn, true);

    // 演示内容没有对应的列表页，点「看全部」不应跳走（入口本身也已隐藏）
    calls.navigations.length = 0;
    calls.tabSwitches.length = 0;
    page.onGoAnnouncements();
    page.onGoEvents();
    assert.deepStrictEqual(calls.navigations, []);
    assert.deepStrictEqual(calls.tabSwitches, []);

    // 切回本校即还原聚合内容
    page.onSchoolChange({ detail: { schoolId: 'muc' } });
    assert.strictEqual(page.data.schoolContent, false);
    assert.strictEqual(page.data.view.summary.memberCount, 24);
  } finally {
    schoolMock.setDemoActor('demo_applicant');
    schoolSession.reset();
  }
});

test('排行榜 —— 切到北航显示北航的演示榜单且整页只读', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  schoolSession.reset();
  schoolMock.setDemoActor('demo_muc_member');
  try {
    resetSession();
    loginAs();
    const page = instantiate(rankConfig);
    await page.onLoad();

    // 本校（民大）走真实榜单，不是演示
    assert.strictEqual(page.data.demoSchool, false);
    assert.ok(page.data.view.rows.length > 0);

    // 切到北航：换成演示榜单，且没有「我」这一行
    schoolSession.setSchoolId('buaa');
    await page.refresh();

    assert.strictEqual(page.data.demoSchool, true);
    assert.strictEqual(page.data.demoSchoolName, '北航');
    assert.ok(page.data.view.rows.length > 0, '北航有演示榜单');
    assert.strictEqual(page.data.view.me, null);
    assert.ok(page.data.view.rows.every((row) => row.isMe === false));

    // 演示榜单里的人没有本校账号，点行不跳转
    calls.navigations.length = 0;
    page.onOpenMember({ currentTarget: { dataset: { userId: page.data.view.rows[0].userId } } });
    assert.deepStrictEqual(calls.navigations, []);

    // 切项目仍停在北航演示榜
    await page.onSwitchProject({ currentTarget: { dataset: { project: 'doubles' } } });
    assert.strictEqual(page.data.view.activeProject, 'doubles');
    assert.strictEqual(page.data.demoSchool, true);
  } finally {
    schoolMock.setDemoActor('demo_applicant');
    schoolSession.reset();
  }
});

test('比赛页 —— 切到北航显示北航的演示比赛，且没有任何操作入口', async () => {
  const schoolSession = require('../miniprogram/services/school-session');
  const schoolMock = require('../miniprogram/services/school-mock');
  schoolSession.reset();
  schoolMock.setDemoActor('demo_muc_member');
  try {
    resetSession();
    app.globalData.userInfo = activeMember();
    const page = instantiate(matchConfig);
    await page.onLoad();

    assert.strictEqual(page.data.demoSchool, false);

    schoolSession.setSchoolId('buaa');
    await page.refresh();

    assert.strictEqual(page.data.demoSchool, true);
    assert.strictEqual(page.data.demoSchoolName, '北航');
    assert.strictEqual(page.data.auth.canRecord, false);

    const rows = page.data.view.records;
    assert.ok(rows.length > 0, '北航有演示比赛');
    // 只剩一排「全部比赛」——浏览者不是该校会员，没有「我的比赛 / 待确认」
    assert.deepStrictEqual(page.data.view.tabs.map((item) => item.label), ['全部比赛']);
    // 任何写入口都被关掉
    assert.ok(
      rows.every(
        (row) =>
          !row.canRecord && !row.canConfirm && !row.canRevoke && !row.canForfeit && !row.canAssignReferee
      )
    );

    // 点队名不跳转、点录入不进录入页
    calls.navigations.length = 0;
    calls.toasts.length = 0;
    page.onOpenMember({ currentTarget: { dataset: { userId: rows[0].teamAList[0].userId } } });
    page.onGoEntry();
    assert.deepStrictEqual(calls.navigations, []);
    assert.deepStrictEqual(calls.toasts, []);
  } finally {
    schoolMock.setDemoActor('demo_applicant');
    schoolSession.reset();
  }
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

test('我的页 —— onLoad 之后渲染出全局头卡与跨协会聚合的荣誉', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.user.userId, 'u06');
  // 等级分/项目分卡已移入个人详情页，这一页不再有
  assert.strictEqual(page.data.view.projectTabs, undefined, '「我的」不再摆等级分');
  assert.strictEqual(page.data.view.user.showPoints, false, '头卡不显示赛季积分标签');
  assert.ok(page.data.view.honors, '有跨协会聚合的荣誉');
});

test('我的页 —— 点头卡头像进个人详情页', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, ['/pages/profile-detail/profile-detail']);
});

test('我的页 —— 荣誉跨协会聚合：汇总数字等于各分组名次之和', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  const honors = page.data.view.honors;
  assert.ok(Array.isArray(honors.groups), '按协会分组');
  const summed = honors.groups.reduce((total, group) => total + group.records.length, 0);
  assert.strictEqual(summed, honors.summary.eventCount, '汇总参赛数 = 各分组记录数之和');
  assert.strictEqual(honors.total, honors.summary.eventCount);
  // 未参赛的协会不出现：分组里必须有记录，且都带协会标识
  for (const group of honors.groups) {
    assert.ok(group.associationId && group.associationName, '每组要标注所属协会');
    assert.ok(group.records.length > 0, '没有记录的协会不该建分组');
  }
  if (honors.total === 0) assert.strictEqual(honors.groups.length, 0);
});

test('我的页 —— 切换协会只改全局，本页内容不重取', async () => {
  loginAs();
  const page = instantiate(profileConfig);
  await page.onLoad({});

  const before = page.data.view;
  const globalBefore = facade.getAssociation();
  const target = globalBefore === 'tt' ? 'pkb' : 'tt';

  try {
    await page.onAssociationChange({ detail: { id: target } });
    // 内容对象没被整体替换，说明没有重新取数——「我的」是跨协会聚合的，不随切换变
    assert.strictEqual(page.data.view, before, '切协会不该重取本页内容');
    // 但全局当前协会确实改掉了（作用在中间三个界面）
    assert.strictEqual(facade.getAssociation(), target);
  } finally {
    // 全局协会是模块级单例，别把改动漏给后面的用例
    facade.setAssociation(globalBefore);
  }
});

test('我的页 —— 首页切了协会再回来，徽章跟着全局走（不再两张皮）', async () => {
  loginAs();
  const globalBefore = facade.getAssociation();
  facade.setAssociation('pkb');
  try {
    const page = instantiate(profileConfig);
    await page.onLoad({});
    assert.strictEqual(page.data.associationId, 'pkb', '首屏徽章是当前全局协会');

    // 模拟在首页把全局协会切到 tt，再切回「我的」tab——tab 切换只走 onShow。
    // 本页内容是跨协会聚合的、不随它变，会话指纹没变，refresh 会被跳过；
    // 若不在 onShow 里单独同步徽章，这里就会停在 pkb，与首页显示的两张皮。
    const viewBefore = page.data.view;
    facade.setAssociation('tt');
    await page.onShow();

    assert.strictEqual(page.data.associationId, 'tt', '徽章必须跟上全局协会');
    assert.strictEqual(page.data.view, viewBefore, '切协会不该重取本页内容');
  } finally {
    facade.setAssociation(globalBefore);
  }
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

test('我的页 —— 普通会员看不到任何管理入口', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember();

  const page = instantiate(profileConfig);
  await page.onLoad({});

  // 演示数据源不再放宽：普通会员与线上一样，管理入口一个都不给
  assert.strictEqual(page.data.reviewEntry.visible, false);
  assert.strictEqual(page.data.adminEntry.visible, false);
});

test('我的页 —— 管理员看到审核入口，点进去跳转审核页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, true);
  assert.ok(page.data.reviewEntry.hint, '入口卡上要写清楚点进去是干什么的');

  calls.navigations.length = 0;
  page.onGoReview();
  assert.deepStrictEqual(calls.navigations, ['/pages/member-review/member-review']);
});

test('我的页 —— 学院负责人看不到审核入口：入会审核是俱乐部全局事务', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(STAFF);

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.reviewEntry.visible, false);
});

test('我的页 —— 退出登录后 onShow 会把审核入口收回去', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

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

test('我的页 —— 管理员看到公告管理入口，点进去跳转公告管理页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.adminEntry.visible, true);
  assert.ok(page.data.adminEntry.hint, '入口卡上要写清楚点进去是干什么的');

  calls.navigations.length = 0;
  page.onGoAnnouncementsAdmin();
  assert.deepStrictEqual(calls.navigations, ['/pages/announcement-manage/announcement-manage']);
});

test('我的页 —— 学院负责人看不到公告管理入口：公告是发给全俱乐部的', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(STAFF);

  const page = instantiate(profileConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.adminEntry.visible, false);
});

test('我的页 —— 退出登录后 onShow 会把公告管理入口一并收回去', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(profileConfig);
  await page.onLoad({});
  assert.strictEqual(page.data.adminEntry.visible, true);

  app.globalData.userInfo = null;
  page.onShow();
  assert.strictEqual(page.data.adminEntry.visible, false, '权限没了，入口不能还挂着');
});

test('我的页 —— 赛季管理入口已移除，管理员也看不到', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember({ role: 2, _id: 'u01', nickName: '巴特尔' });

  const page = instantiate(profileConfig);
  await page.onLoad({});

  // 赛季更新改为在云控制台手动操作，小程序内不再提供入口
  assert.strictEqual(page.data.seasonEntry, undefined);
  assert.strictEqual(typeof page.onGoSeasonManage, 'undefined');
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

test('个人详情 —— 页内默认本人比赛最多的协会，切换只改本页', async () => {
  loginAs(); // u06，比赛多在匹克球协会
  const page = instantiate(profileDetailConfig);
  await page.onLoad({});

  assert.strictEqual(page.data.switchValue, 'pkb', '默认落在本人比赛最多的协会');
  assert.strictEqual(page.data.showSwitch, true, '已登录且有多协会，给切换徽章');
  assert.ok(page.data.view.summary, '承接了「我的」移出的等级分');

  const globalBefore = facade.getAssociation();
  try {
    await page.onAssociationChange({ detail: { id: 'tt' } });
    assert.strictEqual(page.data.switchValue, 'tt');
    assert.strictEqual(facade.getAssociation(), globalBefore, '页内切换不写回全局');
  } finally {
    facade.setAssociation(globalBefore);
  }
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

test('他人主页 —— 导航栏按页内协会套品牌（标题 = 协会简称）', async () => {
  // u01 的比赛多在乒乓协会，页内默认落在 tt，标题随之是它的简称（§11.7）
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  assert.strictEqual(page.data.switchValue, 'tt');
  assert.strictEqual(calls.titles[calls.titles.length - 1], '民大乒乓');
});

test('他人主页 —— 页内切换协会整页重取，但不写回全局', async () => {
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' }); // 默认 tt
  const globalBefore = facade.getAssociation();

  try {
    await page.onAssociationChange({ detail: { id: 'pkb' } });
    assert.strictEqual(page.data.switchValue, 'pkb');
    assert.strictEqual(page.data.view.found, true);
    assert.strictEqual(facade.getAssociation(), globalBefore, '页内切换不写回全局');
  } finally {
    facade.setAssociation(globalBefore);
  }
});

test('他人主页 —— 头卡是共用的，但点头像不会跳走', async () => {
  // 头像跳详情只有「我的」页需要；看别人资料时点头像不该有任何反应
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u01' });

  calls.navigations.length = 0;
  page.onGoProfileDetail();
  assert.deepStrictEqual(calls.navigations, []);
});

test('他人主页 —— 管理员看到任免入口，点一下把对方设为学院负责人', async () => {
  // u01 是种子里的管理员；u06 是普通会员、学院确定
  loginAs({ _id: 'u01', role: 2, college: '体育学院', status: 1 });
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u06' });

  assert.strictEqual(page.data.view.leader.visible, true);
  assert.strictEqual(page.data.view.leader.label, '设为学院负责人');

  calls.toasts.length = 0;
  await page.onSetCollegeLeader();

  const after = await facade.getMember('u06');
  assert.strictEqual(after.role, 1, '点击后应当真的写进数据源');
  assert.ok(calls.toasts.includes('已设为学院负责人'));
});

test('他人主页 —— 普通会员看不到任免入口，也没有可点的按钮', async () => {
  loginAs({ _id: 'u06', role: 0 });
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u02' });

  assert.strictEqual(page.data.view.leader.visible, false);
  // 即使误触发也没有副作用
  await page.onSetCollegeLeader();
  assert.strictEqual((await facade.getMember('u02')).role, 1, 'u02 种子里就是学院负责人，不该被改动');
});

test('他人主页 —— 协会负责人在本协会能看到并执行任免入口', async () => {
  // 登录快照故意写成「普通会员」（role 0），模拟快照按别的协会读下、与本页
  // 协会对不上的情形。u09 在匹克球协会（pkb）是协会负责人，入口是否出现应当
  // 以**本页协会**解析出的身份为准，而不是拿快照里的旧 role 一刀切。
  loginAs({ _id: 'u09', role: 0, status: 1 });
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u06' });
  // 页内切到 pkb（u06 默认协会可能不是这个）：切换后按本协会重新解析身份
  await page.onAssociationChange({ detail: { id: 'pkb' } });

  assert.strictEqual(page.data.switchValue, 'pkb');
  assert.strictEqual(page.data.view.leader.visible, true, '本协会负责人应当看到任免入口');

  calls.toasts.length = 0;
  await page.onSetCollegeLeader();
  assert.strictEqual((await facade.getMember('u06')).role, 1, '点击后真的写进数据源');
  assert.ok(calls.toasts.includes('已设为学院负责人'));
});

test('他人主页 —— 统一的指定权限入口按可授予档位分发', async () => {
  // 全局管理员看别人主页时协会负责人与学院负责人两档都开；统一入口点开
  // 取首项（协会负责人）执行，证明它复用了既有的任免处理。
  loginAs({ _id: 'u01', role: 2, college: '体育学院', status: 1 });
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u06' });

  assert.strictEqual(page.data.view.associationLeader.visible, true);
  assert.strictEqual(page.data.view.leader.visible, true);

  calls.toasts.length = 0;
  await page.onGrantPermission();
  assert.strictEqual((await facade.getMember('u06')).role, 2, '统一入口应当真的写入数据源');
  assert.ok(calls.toasts.includes('已设为协会负责人'));
});

test('他人主页 —— 无任免资格时不出现指定权限入口', async () => {
  loginAs({ _id: 'u06', role: 0 });
  const page = instantiate(memberConfig);
  await page.onLoad({ userId: 'u02' });

  assert.strictEqual(page.data.view.leader.visible, false);
  assert.strictEqual(page.data.view.associationLeader.visible, false);
  // 误触发也没有任何副作用
  assert.strictEqual(page.onGrantPermission(), undefined);
});

/* ============================================================
 * 排行榜
 * ============================================================ */

test('排行榜 —— 首屏加载后展示默认项目的等级分榜，且最多 10 行', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.activeBoardLabel, '等级分榜');
  assert.ok(page.data.view.rows.length > 0);
  assert.ok(page.data.view.rows.length <= 10, '等级榜只显示前 10 名');
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

test('排行榜 —— 已经没有榜单类型切换了', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  // 进步榜被移除，页面不该再留着切榜单的入口
  assert.strictEqual(typeof page.onSwitchBoard, 'undefined');
  assert.strictEqual(page.data.view.boardTabs, undefined);
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

test('排行榜 —— 首屏还没落地时 onShow 不重复取数', async () => {
  const page = instantiate(rankConfig);
  // 框架不 await onLoad，紧接着就会同步调一次 onShow；此时 loaded 还是假，
  // 应当被挡下，否则首屏白刷两遍
  const loading = page.onLoad();
  assert.strictEqual(page.onShow(), undefined);
  await loading;
});

test('排行榜 —— 从别的页面切回来会重算榜单', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();
  const before = page.data.view;

  // 刚确认的比赛会改名字次，切回来必须重取
  await page.onShow();
  assert.notStrictEqual(page.data.view, before, 'onShow 应当重新装载一份视图模型');
});

test('排行榜 —— 搜索框空着时就是榜单本身，计数与视图模型一致', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, page.data.view.rows.length);
  // 计数必须用完整榜单人数，不能只报榜上这（最多 10）行
  assert.strictEqual(page.data.playerCountText, page.data.view.playerCountText);
  assert.ok(page.data.playerCountText.includes(String(page.data.view.total)));
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

test('排行榜 —— 搜索范围是全量榜单，前十之外的人也能搜到', async () => {
  const page = instantiate(rankConfig);
  await page.onLoad();

  const outside = page.data.view.allRows[10];
  assert.ok(outside, '要有前十之外的会员才能验证全量搜索');
  assert.ok(
    !page.data.rows.some((row) => row.userId === outside.userId),
    '默认榜单不该显示他'
  );

  page.onInputKeyword({ detail: { value: outside.nickName } });

  const hit = page.data.rows.find((row) => row.userId === outside.userId);
  assert.ok(hit, '前十之外的人必须能被搜到');
  assert.strictEqual(hit.rank, outside.rank, '搜索只是定位，不改名次');
  assert.ok(hit.rank > 10);
});

test('排行榜 —— 用真实姓名也能搜到同一个人，展示的仍是昵称', async () => {
  // 种子里 u06：昵称「明宇」、真实姓名「赵明宇」。只按昵称搜时，
  // 输入「赵」查无此人——这正是用户反馈的问题。
  const page = instantiate(rankConfig);
  await page.onLoad();

  const target = page.data.view.allRows.find((row) => row.userId === 'u06');
  assert.ok(target, '种子里应当有这位会员');
  assert.strictEqual(target.nickName, '明宇');
  assert.strictEqual(target.realName, '赵明宇');

  page.onInputKeyword({ detail: { value: '赵' } });

  const hit = page.data.rows.find((row) => row.userId === 'u06');
  assert.ok(hit, '输入真名的姓也要能搜到人');
  assert.strictEqual(hit.rank, target.rank, '按真名搜同样不改名次');
  // 真实姓名只作为搜索依据，榜面上显示的一律是昵称
  assert.strictEqual(hit.nickName, '明宇');
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

test('赛事页 —— 积分榜只列前 10 名，计数交代总人数', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, Math.min(10, page.data.view.total));
  assert.ok(page.data.rows.length <= 10, '积分榜只显示前 10 名');
  assert.strictEqual(page.data.playerCountText, page.data.view.playerCountText);
  assert.ok(page.data.playerCountText.includes(String(page.data.view.total)));
});

test('赛事页 —— 输入名字后只剩命中的人，名次保持不变', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const target = page.data.view.allRows[0];
  page.onInputKeyword({ detail: { value: target.nickName } });

  assert.strictEqual(page.data.searching, true);
  assert.ok(page.data.rows.length >= 1, '至少要搜到榜首本人');
  assert.strictEqual(page.data.playerCountText, `找到 ${page.data.rows.length} 人`);
  const sameRow = page.data.rows.find((row) => row.userId === target.userId);
  assert.strictEqual(sameRow.rank, target.rank, '搜索只是定位，不改名次');
});

test('赛事页 —— 搜索范围是全量榜单，前十之外的人也能搜到', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const outside = page.data.view.allRows[10];
  assert.ok(outside, '要有前十之外的会员才能验证全量搜索');
  assert.ok(
    !page.data.rows.some((row) => row.userId === outside.userId),
    '默认榜单不该显示他'
  );

  page.onInputKeyword({ detail: { value: outside.nickName } });

  const hit = page.data.rows.find((row) => row.userId === outside.userId);
  assert.ok(hit, '前十之外的人必须能被搜到');
  assert.strictEqual(hit.rank, outside.rank);
});

test('赛事页 —— 积分榜用真实姓名也能搜到同一个人', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const target = page.data.view.allRows.find((row) => row.userId === 'u06');
  assert.ok(target, '种子里应当有这位会员');
  assert.strictEqual(target.realName, '赵明宇');

  page.onInputKeyword({ detail: { value: '赵' } });

  const hit = page.data.rows.find((row) => row.userId === 'u06');
  assert.ok(hit, '输入真名的姓也要能搜到人');
  assert.strictEqual(hit.rank, target.rank);
  assert.strictEqual(hit.nickName, '明宇', '展示的仍是昵称');
});

test('赛事页 —— 搜不到时提示里带上搜索词，清空后回到默认榜', async () => {
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const total = page.data.rows.length;
  page.onInputKeyword({ detail: { value: '查无此人' } });

  assert.strictEqual(page.data.empty, true);
  assert.strictEqual(page.data.rows.length, 0);
  assert.ok(page.data.emptyNote.includes('查无此人'), '要告诉用户是哪个词没搜到');
  assert.strictEqual(page.data.playerCountText, '找到 0 人');

  page.onClearKeyword();
  assert.strictEqual(page.data.keyword, '');
  assert.strictEqual(page.data.searching, false);
  assert.strictEqual(page.data.rows.length, total);
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

/**
 * 造一场「报名中」的赛事，返回落库后的记录。
 * 发布门槛是学院负责人，这里直接以管理员身份落库，与会话解耦——
 * 用例想以谁的身份看赛事，自己在 onLoad 前摆登录态即可。
 */
async function publishTestEvent(overrides = {}) {
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
      courtCount: 4,
      ...overrides,
    },
    ADMIN._id
  );
  assert.strictEqual(result.ok, true, `发布赛事失败：${result.firstError}`);
  return result.record;
}

test('赛事页 —— 赛事列表把报名中、进行中的排在已结束之前', async () => {
  loginAs();
  const created = await publishTestEvent();

  const page = instantiate(eventsConfig);
  await page.onLoad();

  const rows = page.data.view.events;
  assert.ok(rows.length > 0, '种子里有赛事，列表不该空着');

  // 排序口径：报名中 → 进行中 → 已结束。刚发布的排在种子里那场
  // 「进行中」的赛事（e07）之前，两者又都排在已结束的之前。
  const signingUp = rows.filter((row) => row.status === EVENT_STATUS.SIGNUP);
  const ongoing = rows.filter((row) => row.status === EVENT_STATUS.ONGOING);
  assert.ok(signingUp.some((row) => row.id === created._id), '刚发布的赛事在列表里');
  assert.ok(ongoing.some((row) => row.id === 'e07'), '种子里的进行中赛事在列表里');
  assert.strictEqual(rows[0].id, created._id);
  assert.strictEqual(rows[0].statusLabel, '报名中');
  assert.strictEqual(rows[signingUp.length].id, 'e07');
  assert.strictEqual(rows[signingUp.length].statusLabel, '进行中');

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

test('赛事页 —— 只有管理员才渲染发布入口', async () => {
  loginAs(ADMIN);
  const allowed = instantiate(eventsConfig);
  await allowed.onLoad();
  assert.strictEqual(allowed.data.view.canPublish, true, '管理员才给发布入口');

  calls.navigations.length = 0;
  allowed.onOpenPublish();
  assert.deepStrictEqual(calls.navigations, ['/pages/event-edit/event-edit']);

  // 学院负责人只多「代签到」与「录入比分」，操盘赛事的入口不给
  loginAs(STAFF);
  const staff = instantiate(eventsConfig);
  await staff.onLoad();
  assert.strictEqual(staff.data.view.canPublish, false, '学院负责人不给发布入口');

  // 普通会员登录也一样看不到：演示数据源不再放宽
  loginAs();
  const member = instantiate(eventsConfig);
  await member.onLoad();
  assert.strictEqual(member.data.view.canPublish, false, '普通会员不给发布入口');

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
  loginAs(ADMIN);
  // 单打双打都要先抽签才能开赛，路线与真人一致：发布 → 两人报名 → 抽签 → 开赛
  const created = await publishTestEvent({ seedCount: 2 });
  await facade.signUpEvent(created._id, 'u06');
  await facade.signUpEvent(created._id, 'u01');
  await facade.drawEvent(created._id, ADMIN._id, { seedValue: 11 });

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.event.canStart, true);

  await page.onStart();
  assert.strictEqual(page.data.view.event.isOngoing, true);

  const rowOf = (userId) => page.data.view.signupRows.find((row) => row.userId === userId);
  assert.strictEqual(rowOf('u06').canCheckIn, true);
  await page.onCheckIn({ currentTarget: { dataset: { userId: 'u06' } } });

  assert.strictEqual(rowOf('u06').checkedIn, true);
  assert.strictEqual(rowOf('u06').canCheckIn, false);
});

test('赛事详情 —— 管理员在签表上指派裁判，行上随即显示是谁执法', async () => {
  loginAs(ADMIN);
  // 2 人单打抽签后签表有一场待确认的比赛，正是可以指派裁判的场次
  const created = await publishTestEvent({ seedCount: 2 });
  await facade.signUpEvent(created._id, 'u06');
  await facade.signUpEvent(created._id, 'u01');
  await facade.drawEvent(created._id, ADMIN._id, { seedValue: 11 });

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });

  const row = page.data.view.bracketRows[0];
  assert.ok(row, '抽签后应当有一场签表比赛');
  assert.strictEqual(row.hasReferee, false);
  assert.strictEqual(row.canAssignReferee, true, '管理员在未生效的场次上可以指派');

  await page.onOpenReferee({ currentTarget: { dataset: { matchId: row.matchId } } });
  assert.strictEqual(page.data.referee.open, true);
  assert.ok(page.data.referee.rows.length > 0);

  calls.toasts.length = 0;
  await page.onPickReferee({ currentTarget: { dataset: { userId: RIVAL } } });

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === row.matchId);
  assert.strictEqual(ledgerRow.referee, RIVAL, '指派已经落库');
  assert.strictEqual(ledgerRow.refereeBy, ADMIN._id);

  assert.strictEqual(page.data.referee.open, false, '选完即关面板');
  const after = page.data.view.bracketRows[0];
  assert.strictEqual(after.hasReferee, true);
  assert.ok(after.refereeName, '签表行上要显示裁判名字');
  assert.ok(calls.toasts.some((text) => /已指派裁判/.test(text)));
});

test('赛事详情 —— 普通会员在签表上看不到指派入口', async () => {
  loginAs(ADMIN);
  const created = await publishTestEvent({ seedCount: 2 });
  await facade.signUpEvent(created._id, 'u06');
  await facade.signUpEvent(created._id, 'u01');
  await facade.drawEvent(created._id, ADMIN._id, { seedValue: 11 });

  // 以参赛者身份登录：能录分，但没有指派权
  loginAs();
  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });

  const row = page.data.view.bracketRows[0];
  assert.ok(row);
  assert.strictEqual(row.canAssignReferee, false);
});

test('赛事详情 —— 单打没抽签就点开始赛事：不生效并提示先抽签', async () => {
  loginAs(ADMIN);
  const created = await publishTestEvent();
  await facade.signUpEvent(created._id, 'u06');

  const page = instantiate(eventDetailConfig);
  await page.onLoad({ eventId: created._id });
  // 按钮照常显示，点下去才拿到「请先抽签」——否则管理员不知道还差什么
  assert.strictEqual(page.data.view.event.canStart, true);

  calls.toasts.length = 0;
  await page.onStart();

  assert.strictEqual(page.data.view.event.isOngoing, false, '没抽签不该开始');
  assert.ok(
    calls.toasts.some((text) => /抽签/.test(text)),
    '要明确提示先抽签'
  );
});

test('赛事详情 —— 手工指定种子：点抽签先弹面板，凑齐人数才真正落签', async () => {
  loginAs(ADMIN);
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
  loginAs(ADMIN);
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
  loginAs(ADMIN);
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
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '秋季单打赛' } });
  page.onPickLevel({ detail: { value: '1' } }); // 下拉第 2 项 = 二级赛事
  page.onPickBronzeMode({ detail: { value: '1' } }); // 下拉第 2 项 = 打三四名
  page.onPickSeedMode({ detail: { value: '1' } }); // 下拉第 2 项 = 按等级分
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputQuota({ detail: { value: '8' } });
  page.onInputCourtCount({ detail: { value: '4' } });

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

test('发布赛事 —— 选循环赛落库带上赛制，组数与出线人数留空、排位不启用', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '循环赛测试' } });
  page.onPickFormat({ detail: { value: '1' } }); // 下拉第 2 项 = 循环赛
  page.onPickLevel({ detail: { value: '1' } });
  page.onPickBronzeMode({ detail: { value: '1' } });
  page.onPickSeedMode({ detail: { value: '1' } });
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputQuota({ detail: { value: '8' } });
  page.onInputCourtCount({ detail: { value: '4' } });

  await page.onSubmit();

  const created = (await facade.getEvents()).find((item) => item.title === '循环赛测试');
  assert.ok(created, '循环赛赛事应当落库');
  assert.strictEqual(created.format, EVENT_FORMAT.ROUND_ROBIN);
  assert.strictEqual(created.groupCount, null, '循环赛恒为单组，不落组数');
  assert.strictEqual(created.advancePerGroup, null);
  assert.strictEqual(
    created.placementMode,
    EVENT_PLACEMENT_MODE.NONE,
    '循环赛没有淘汰阶段，倒三角排位不启用'
  );
});

test('发布赛事 —— 小组赛可选出线人数，组数与出线人数一并落库', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '小组赛测试' } });
  page.onPickFormat({ detail: { value: '2' } }); // 下拉第 3 项 = 小组赛
  page.onPickGroupCount({ detail: { value: '0' } }); // 第 1 项 = 2 组
  page.onPickAdvance({ detail: { value: '1' } }); // 第 2 项 = 每组出线 2 人
  page.onPickLevel({ detail: { value: '1' } });
  page.onPickBronzeMode({ detail: { value: '1' } });
  page.onPickSeedMode({ detail: { value: '1' } });
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputQuota({ detail: { value: '8' } });
  page.onInputCourtCount({ detail: { value: '4' } });

  await page.onSubmit();

  const created = (await facade.getEvents()).find((item) => item.title === '小组赛测试');
  assert.ok(created, '小组赛赛事应当落库');
  assert.strictEqual(created.format, EVENT_FORMAT.GROUP_KNOCKOUT);
  assert.strictEqual(created.groupCount, 2);
  assert.strictEqual(created.advancePerGroup, 2);
});

test('发布赛事 —— 切到双打：赛制保留，种子来源去掉「按赛季积分」', () => {
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onPickFormat({ detail: { value: '2' } });
  assert.strictEqual(page.data.form.format, EVENT_FORMAT.GROUP_KNOCKOUT);

  // 单打下先选一个双打没有的来源，验证切换时会被清掉
  page.onPickSeedMode({ detail: { value: '2' } });
  assert.strictEqual(page.data.form.seedMode, SEED_MODE.POINTS);

  page.onPickMatchType({ detail: { value: '1' } }); // 双打

  // 双打与单打同步：赛制照常可选，不再被一刀收回单败
  assert.strictEqual(page.data.form.format, EVENT_FORMAT.GROUP_KNOCKOUT);
  assert.strictEqual(page.data.formatIndex, 2);

  // 来源只剩手工 / 等级分两项，「按赛季积分」不再出现
  assert.deepStrictEqual(page.data.seedModes, ['手工指定', '按等级分']);
  assert.strictEqual(page.data.seedModeIndex, 0);
  assert.strictEqual(page.data.form.seedMode, '', '原先选的按积分在双打下不合法，要清掉重选');
});

test('发布赛事 —— 选双败淘汰：可关掉总决赛重赛，组数与三四名留空', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '双败测试' } });
  page.onPickFormat({ detail: { value: '4' } }); // 下拉第 5 项 = 双败淘汰
  page.onToggleGfReset({ detail: { value: false } });
  page.onPickLevel({ detail: { value: '1' } });
  page.onPickSeedMode({ detail: { value: '1' } });
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputQuota({ detail: { value: '8' } });
  page.onInputCourtCount({ detail: { value: '4' } });

  await page.onSubmit();

  const created = (await facade.getEvents()).find((item) => item.title === '双败测试');
  assert.ok(created, '双败赛事应当落库');
  assert.strictEqual(created.format, EVENT_FORMAT.DOUBLE_ELIM);
  assert.strictEqual(created.gfReset, false, '关掉重赛要落库');
  assert.strictEqual(created.groupCount, null, '双败不分组，不落组数');
  assert.strictEqual(created.advancePerGroup, null);
  assert.strictEqual(created.bronzeMode, null, '双败名次由败者组排出，没有三四名赛');
  assert.strictEqual(created.placementMode, EVENT_PLACEMENT_MODE.NONE);
});

test('发布赛事 —— 小组赛+双败：出线人数不足 4 人时挡下不落库', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '双败人不够' } });
  page.onPickFormat({ detail: { value: '5' } }); // 下拉第 6 项 = 小组赛+双败
  page.onPickGroupCount({ detail: { value: '0' } }); // 2 组
  page.onPickAdvance({ detail: { value: '0' } }); // 每组出线 1 人 → 共 2 人
  page.onPickLevel({ detail: { value: '1' } });
  page.onPickSeedMode({ detail: { value: '1' } });
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });

  await page.onSubmit();

  assert.ok(page.data.errors.advancePerGroup, '要给出线人数一条错误提示');
  const created = (await facade.getEvents()).find((item) => item.title === '双败人不够');
  assert.strictEqual(created, undefined, '排不出败者组，不该落库');
});

test('发布赛事 —— 小组赛+双败：2 组出线 2 人（共 4 人）正常落库', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '小组双败测试' } });
  page.onPickFormat({ detail: { value: '5' } });
  page.onPickGroupCount({ detail: { value: '0' } }); // 2 组
  page.onPickAdvance({ detail: { value: '1' } }); // 每组出线 2 人
  page.onPickLevel({ detail: { value: '1' } });
  page.onPickSeedMode({ detail: { value: '1' } });
  page.onPickDate({ detail: { value: '2026-06-10' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputCourtCount({ detail: { value: '4' } });

  await page.onSubmit();

  const created = (await facade.getEvents()).find((item) => item.title === '小组双败测试');
  assert.ok(created, '小组赛+双败应当落库');
  assert.strictEqual(created.format, EVENT_FORMAT.GROUP_DOUBLE_ELIM);
  assert.strictEqual(created.groupCount, 2);
  assert.strictEqual(created.advancePerGroup, 2);
  assert.strictEqual(created.gfReset, true, '重赛默认开启');
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
  loginAs(ADMIN);
  // 单打双打都要先抽签，路线与真人一致：发布 → 两人报名 → 抽签 → 开赛
  const created = await publishTestEvent({ seedCount: 2 });
  await facade.signUpEvent(created._id, 'u06');
  await facade.signUpEvent(created._id, 'u01');
  await facade.drawEvent(created._id, ADMIN._id, { seedValue: 11 });
  await facade.startEvent(created._id, ADMIN._id);

  const page = instantiate(eventPlacementConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.canEdit, true);

  await page.onSubmit();
  assert.ok(page.data.errorText.length > 0);
});

test('录入名次 —— 提交后赛事结束、名次落定', async () => {
  loginAs(ADMIN);
  // 单打双打都要先抽签，路线与真人一致：发布 → 两人报名 → 抽签 → 开赛
  const created = await publishTestEvent({ seedCount: 2 });
  await facade.signUpEvent(created._id, 'u06');
  await facade.signUpEvent(created._id, 'u01');
  await facade.drawEvent(created._id, ADMIN._id, { seedValue: 11 });
  await facade.startEvent(created._id, ADMIN._id);

  const page = instantiate(eventPlacementConfig);
  await page.onLoad({ eventId: created._id });
  assert.strictEqual(page.data.view.rows.length, 2);

  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1' } });
  page.onInputPlacement({ currentTarget: { dataset: { index: 1 } }, detail: { value: '2' } });

  const before = calls.backCount;
  await page.onSubmit();
  assert.strictEqual(calls.backCount, before + 1);

  const events = await facade.getEvents();
  const finished = events.find((item) => item._id === created._id);
  assert.strictEqual(finished.status, EVENT_STATUS.FINISHED);
  assert.deepStrictEqual(finished.results, [
    { userId: 'u06', placement: 1 },
    { userId: 'u01', placement: 2 },
  ]);
});

test('录入名次 —— 双打按队给行（两人一起显示），一行名次摊到两名成员', async () => {
  loginAs(ADMIN);
  // 双打与单打同步：4 人组成 2 队，路线为 发布 → 报名 → 抽签 → 开赛
  const created = await publishTestEvent({ matchType: MATCH_TYPE.DOUBLES, seedCount: 2 });
  const players = ['u01', 'u02', 'u03', 'u04'];
  for (const userId of players) await facade.signUpEvent(created._id, userId);
  await facade.drawEvent(created._id, ADMIN._id, { seedValue: 11 });
  await facade.startEvent(created._id, ADMIN._id);

  const page = instantiate(eventPlacementConfig);
  await page.onLoad({ eventId: created._id });

  // 一行一支队，名字是两人用顿号连起来；userId 是队号，userIds 是两名成员
  assert.strictEqual(page.data.view.rows.length, 2, '两队两行，不是四人四行');
  const champion = page.data.view.rows[0];
  assert.strictEqual(champion.userIds.length, 2);
  assert.ok(champion.nickName.includes('、'), `双打一行要显示两人：${champion.nickName}`);

  // 只给冠军队那行填 1，提交即结束（双打冠军恰为队里两人）
  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1' } });
  await page.onSubmit();

  const finished = (await facade.getEvents()).find((item) => item._id === created._id);
  assert.strictEqual(finished.status, EVENT_STATUS.FINISHED);
  assert.deepStrictEqual(
    finished.results.map((row) => row.userId).sort(),
    champion.userIds.slice().sort(),
    '一行名次摊到两名成员'
  );
  assert.ok(finished.results.every((row) => row.placement === 1), '两人名次相同');
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

/** 造一个「已登录且审核通过」的会员——录入要求这个身份 */
function activeMember(overrides = {}) {
  return fakeMember({ _id: 'u06', status: 1, ...overrides });
}

/**
 * 管理员。撤销是「改写已生效的账本」，只留给他。
 * 用的是种子里那位真管理员（u01 巴特尔）：写接口查的是台账里的角色，
 * 光把 userInfo 的 role 改大是骗不过门面的。
 */
function adminMember(overrides = {}) {
  return activeMember({ _id: ADMIN_ID, nickName: '巴特尔', role: ROLE.ADMIN, ...overrides });
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
/** 种子里的管理员（u01 巴特尔） */
const ADMIN_ID = 'u01';

test('比赛页 —— 访客看不到台账，录入入口与空态都给登录引导', async () => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.view.found, true);
  assert.strictEqual(page.data.view.viewer.loggedIn, false);
  assert.strictEqual(page.data.auth.canRecord, false);
  assert.match(page.data.entryHint, /登录/);
  // 访客没有「自己的比赛」可言：台账不下发，空态引导去登录
  assert.deepStrictEqual(page.data.view.records, []);
  assert.strictEqual(page.data.view.needLogin, true);
  assert.match(page.data.view.emptyText, /登录/);
});

test('比赛页 —— 访客点登录按钮跳到登录页', async () => {
  resetSession();
  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoLogin();
  assert.deepStrictEqual(calls.navigations, ['/pages/login/login']);
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

test('比赛页 —— 默认落在「我的比赛」，页面上只列自己参加过的', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.activeTab, 'mine');
  assert.deepStrictEqual(
    page.data.view.tabs.map((item) => item.tab),
    ['mine', 'pending'],
    '只剩「我的比赛」与「待确认」两个标签，没有「全部比赛」'
  );
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
  // 种子里演示赛事还留着两场没打的半决赛，它们仍会出现在待确认里；
  // 要断言的是「刚确认的那一场」已经退出了待确认
  assert.ok(
    !page.data.view.records.some((item) => item.matchId === match._id),
    '确认之后待确认里就不该再有它'
  );
  assert.ok(calls.toasts.some((text) => /已计入等级分/.test(text)));
});

test('比赛页 —— 管理员撤销后分数回滚，理由留在台账里', async () => {
  resetSession();
  app.globalData.userInfo = adminMember();

  // 让管理员本人就在场上：这样「我参与的」一栏里找得到它，写入端也会
  // 按 u01 在种子里的角色（管理员）放行——两个「u01」必须是同一个人
  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN_ID],
    teamB: [RIVAL],
  });
  await facade.confirmMatch(match._id, RIVAL);
  const beforeRevoke = (await facade.getMatches()).length;

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual(row.canRevoke, true, '管理员应当能撤销这场');

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

test('比赛页 —— 撤销权只在管理员手上，录入者本人也撤不动', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  // ME 就是这一场的录入者
  const { match } = await facade.submitMatch(pendingParams());
  await facade.confirmMatch(match._id, ME);

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual(row.canRevoke, false, '撤销入口不该出现在普通会员的页面上');

  // 就算绕过界面直接提交，写入端也要挡住——界面上的按钮不是权限边界
  page.setData({
    action: { open: true, matchId: match._id, kind: 'revoke' },
    reason: '我自己录的，我想撤',
  });
  await page.onSubmitAction();

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.status, MATCH_STATUS.ACTIVE, '被挡下就不该动到状态');
});

test('比赛页 —— 撤销不填理由被拦下，比赛原样不动', async () => {
  resetSession();
  app.globalData.userInfo = adminMember();

  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN_ID],
    teamB: [RIVAL],
  });
  await facade.confirmMatch(match._id, RIVAL);

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

test('比赛页 —— 普通会员看不到指派裁判的入口', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  // 指派权只给管理员，页面这一层压根不该出现入口
  assert.strictEqual(row.canAssignReferee, false);
  assert.strictEqual(row.hasReferee, false);
});

test('比赛页 —— 管理员在面板里指派裁判，落库并显示在那一行上', async () => {
  resetSession();
  app.globalData.userInfo = activeMember(ADMIN);

  // 管理员自己也在场上，这场比赛才会出现在「我的比赛」里
  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN._id],
    actor: ADMIN._id,
  });

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row, '管理员作为参赛者应当看得到这场');
  assert.strictEqual(row.canAssignReferee, true, '还没生效的比赛才开指派入口');

  await page.onOpenReferee({ currentTarget: { dataset: { matchId: match._id } } });
  assert.strictEqual(page.data.referee.open, true);
  assert.ok(page.data.referee.rows.length > 0, '面板里应当有可选会员');

  calls.toasts.length = 0;
  await page.onPickReferee({ currentTarget: { dataset: { userId: RIVAL } } });

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.referee, RIVAL, '指派已经落库');
  assert.strictEqual(ledgerRow.refereeBy, ADMIN._id, '谁派的要留痕');

  assert.strictEqual(page.data.referee.open, false, '选完即关面板');
  const after = page.data.view.records.find((item) => item.matchId === match._id);
  assert.strictEqual(after.hasReferee, true);
  assert.ok(after.refereeName, '行上要显示裁判名字');
  // 比赛还没生效，改派入口仍然开着
  assert.strictEqual(after.canAssignReferee, true);
  assert.ok(calls.toasts.some((text) => /已指派裁判/.test(text)));
});

test('比赛页 —— 管理员可以撤下裁判，比赛回到「人人照旧」', async () => {
  resetSession();
  app.globalData.userInfo = activeMember(ADMIN);

  const { match } = await facade.submitMatch({
    ...pendingParams(),
    teamA: [ADMIN._id],
    actor: ADMIN._id,
  });
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onOpenReferee({ currentTarget: { dataset: { matchId: match._id } } });
  assert.strictEqual(page.data.referee.hasReferee, true);

  calls.toasts.length = 0;
  await page.onClearReferee();

  const ledgerRow = (await facade.getMatchRecords()).find((item) => item._id === match._id);
  assert.strictEqual(ledgerRow.referee, '', '撤下即写空串');
  assert.ok(calls.toasts.some((text) => /已撤下裁判/.test(text)));
});

test('比赛页 —— 裁判接管后，参赛者看到收口提示且确认按钮消失', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  const page = instantiate(matchConfig);
  await page.onLoad();

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row);
  assert.strictEqual(row.hasReferee, true);
  assert.match(row.refereeNotice, /仅裁判与管理员可录分/);
  // 即便是参赛者本人，裁判接管后也不再能确认——这道闸门要一路传到视图模型
  assert.strictEqual(row.canConfirm, false);
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

test('录入页 —— 选对手时每个人后面带上本赛季已交手的场次', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.ok(page.pairInfo, '加载时应当取到交手场次');
  assert.strictEqual(page.pairInfo.limit, RATED_PAIR_LIMIT);

  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });

  // 面板上的数字与服务端闸门同一份：行上的场次就是 pairInfo 里那个人对应的数字
  for (const row of page.data.pickerRows) {
    assert.strictEqual(row.pairCount, page.pairInfo.counts[row.id] || 0);
  }
  assert.ok(
    page.data.pickerRows.some((row) => row.pairCount > 0),
    '演示流水里当前会员应当已经和某些人打过球，否则这条测试验不出东西'
  );
});

test('录入页 —— 选搭档时不带交手场次（名额只数隔网相对的人）', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const page = instantiate(matchEntryConfig);
  await page.onLoad();
  page.onPickMatchType({ currentTarget: { dataset: { value: MATCH_TYPE.DOUBLES } } });
  page.onOpenPicker({ currentTarget: { dataset: { side: 'A', slot: 1 } } });

  assert.strictEqual(page.data.pickerSide, 'A');
  assert.ok(
    page.data.pickerRows.every((row) => row.pairCount === 0),
    '搭档不算一对：在搭档面板上显示场次会让人以为「跟他搭档也占名额」'
  );
});

test('录入页 —— 未登录时取不到交手场次，面板照常能开', async () => {
  resetSession();
  const page = instantiate(matchEntryConfig);
  await page.onLoad();

  assert.strictEqual(page.pairInfo, null, '没有身份就没有「我本赛季」可言');
  page.onOpenPicker({ currentTarget: { dataset: { side: 'B', slot: 0 } } });
  assert.strictEqual(page.data.pickerRows.length, page.data.members.length);
  assert.ok(page.data.pickerRows.every((row) => row.pairCount === 0));
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
  const beforeRecords = await facade.getMatchRecords();
  // 演示赛事里本就留有待确认的场次，按编号找出「新增的这一场」才不会被它顶替
  const beforeIds = new Set(beforeRecords.map((item) => item._id));

  calls.toasts.length = 0;
  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.submitting, false);
  assert.strictEqual(page.data.errorText, '');
  assert.deepStrictEqual(calls.toasts, ['已提交，等待对手确认']);
  assert.strictEqual(calls.backCount, 1, '录完要退回比赛页，onShow 会刷新出这一场');

  const ledger = await facade.getMatchRecords();
  assert.strictEqual(ledger.length, beforeRecords.length + 1);

  // 录入一律先记「待确认」——成绩要对手确认后才生效
  const record = ledger.find((item) => !beforeIds.has(item._id));
  assert.ok(record, '新增的这一场应当在台账里');
  assert.strictEqual(record.status, MATCH_STATUS.PENDING);
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

test('录入页 —— 裁判接管后，参赛者整页被挡住且写明是谁执法', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  // 一场还没确认的比赛，被指派给 u02 执法；u06 是参赛者，管不着这一场
  const { match } = await facade.submitMatch(pendingParams());
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  const page = instantiate(matchEntryConfig);
  await page.onLoad({ matchId: match._id });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.referee.hasReferee, true);
  assert.ok(page.data.referee.name, '要把裁判的名字亮出来');
  assert.match(page.data.blockReason, /裁判执法/);
  // 挡住就不能提交，不能靠按钮拦
  calls.backCount = 0;
  await page.onSubmit();
  assert.strictEqual(calls.backCount, 0, '被挡住时不该有提交动作');
});

test('录入页 —— 裁判本人与管理员仍可照常录入', async () => {
  resetSession();
  app.globalData.userInfo = activeMember();

  const { match } = await facade.submitMatch(pendingParams());
  await facade.assignMatchReferee(match._id, RIVAL, ADMIN._id);

  // 裁判本人
  resetSession();
  app.globalData.userInfo = activeMember({ _id: RIVAL, role: 1, nickName: '张宇轩' });
  const asReferee = instantiate(matchEntryConfig);
  await asReferee.onLoad({ matchId: match._id });
  assert.strictEqual(asReferee.data.referee.hasReferee, true);
  assert.strictEqual(asReferee.data.blockReason, '', '裁判本人当然能录');
  assert.strictEqual(asReferee.data.scheduled, true);

  // 管理员兜底
  resetSession();
  app.globalData.userInfo = activeMember(ADMIN);
  const asAdmin = instantiate(matchEntryConfig);
  await asAdmin.onLoad({ matchId: match._id });
  assert.strictEqual(asAdmin.data.blockReason, '');
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

test('会员审核页 —— 学院负责人被整页挡住：学院负责人是学院范围角色，管不到入会审核', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(STAFF);

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, false);
  assert.deepStrictEqual(page.data.view.rows, [], '学院负责人不该拿到申请人的实名资料');
  assert.match(page.data.view.blockedText, /权限/);
});

test('会员审核页 —— 管理员看到两条待审申请', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, true);
  assert.strictEqual(page.data.view.rows.length, 2);
  assert.strictEqual(page.data.view.pendingCount, 2);
  assert.strictEqual(page.data.view.tabs.filter((item) => item.active).length, 1);
  assert.strictEqual(page.data.view.viewer.roleLabel, '管理员');

  const text = JSON.stringify(page.data.view);
  assert.ok(!text.includes('undefined'), '视图数据里出现了 undefined');
  assert.ok(!text.includes('null'), '视图数据里出现了 null');
  assert.ok(!text.includes('NaN'), '视图数据里出现了 NaN');
});

test('会员审核页 —— 通过后申请离开待审列表，申请人成为正式会员', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const applicationId = page.data.view.rows[0].applicationId;
  const membersBefore = (await facade.getMembers()).length;

  calls.toasts.length = 0;
  // 通过要先过一块面板确认；不填初始分就是纯通过
  await page.onOpenApprove({ currentTarget: { dataset: { applicationId } } });
  await page.onSubmitAction();

  assert.strictEqual(page.data.view.rows.length, 1, '处理过的申请不该还留在待审里');
  assert.strictEqual((await facade.getMembers()).length, membersBefore + 1);
  assert.ok(calls.toasts.some((text) => /已通过/.test(text)));
  // 通过的人立刻进入会员名单，录入页的选手选择器就能选到他
  assert.ok((await facade.getMembers()).some((item) => item._id === applicationId));
});

test('会员审核页 —— 通过时填的初始分会落到账号上', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const applicationId = page.data.view.rows[0].applicationId;
  await page.onOpenApprove({ currentTarget: { dataset: { applicationId } } });
  page.onInputRating({ detail: { value: '1620' } });
  await page.onSubmitAction();

  const account = await facade.getMember(applicationId);
  assert.strictEqual(account.status, USER_STATUS.ACTIVE);
  assert.strictEqual(account.initialElo, 1620);
});

test('会员审核页 —— 初始分越界时挡在本地，申请保持待审核', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const applicationId = page.data.view.rows[0].applicationId;
  await page.onOpenApprove({ currentTarget: { dataset: { applicationId } } });
  page.onInputRating({ detail: { value: '99999' } });
  await page.onSubmitAction();

  assert.match(page.data.actionError, /之间/);
  assert.strictEqual(page.data.action.open, true, '校验失败时面板不该关掉');

  const account = await facade.getMember(applicationId);
  assert.strictEqual(account.status, USER_STATUS.PENDING);
});

test('会员审核页 —— 驳回不填理由被拦下，申请原样不动', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

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
  app.globalData.userInfo = fakeMember(ADMIN);

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
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(memberReviewConfig);
  await page.onLoad();

  const before = page.data.view;
  await page.onSwitchTab({ currentTarget: { dataset: { tab: page.data.view.activeTab } } });

  // 视图模型对象被整体替换过就说明真的重算了
  assert.strictEqual(page.data.view, before);
});

test('会员审核页 —— 下拉刷新会收起刷新动画', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

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

test('公告列表页 —— 未登录也能看，顶部协会标签，默认看当前协会且绝无管理按钮', async () => {
  resetSession();
  facade.setAssociation('pkb');

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  // 顶部一栏协会标签：每个启用协会一个，按注册表次序
  assert.deepStrictEqual(
    page.data.view.associationTabs.map((tab) => tab.associationId),
    ['pkb', 'tt', 'bd']
  );
  // 没指定时停在全局所在协会，只展示它的公告
  assert.strictEqual(page.data.view.activeAssociation, 'pkb');
  assert.strictEqual(page.data.view.total, 6);
  assert.strictEqual(page.data.view.rows[0].pinned, true);
  // 公开页的每一行都不带管理按钮——视图模型给的是 actor: null
  for (const row of page.data.view.rows) assert.strictEqual(row.canArchive, false);
});

test('公告列表页 —— 点协会标签只看该协会，分类计数跟着换', async () => {
  resetSession();
  facade.setAssociation('pkb');

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  await page.onSwitchAssociation({ currentTarget: { dataset: { association: 'tt' } } });

  assert.strictEqual(page.data.view.activeAssociation, 'tt');
  assert.strictEqual(page.data.view.total, 4);
  for (const row of page.data.view.rows) assert.strictEqual(row.association, 'tt');
  assert.strictEqual(page.data.view.tabs[0].count, 4);
});

test('公告列表页 —— 点分类标签整页换成该分类，别的分类计数不归零', async () => {
  resetSession();
  facade.setAssociation('pkb');

  const page = instantiate(announcementsConfig);
  await page.onLoad();

  await page.onSwitchTab({ currentTarget: { dataset: { tab: '赛事' } } });

  assert.strictEqual(page.data.view.activeTab, '赛事');
  assert.strictEqual(page.data.view.visibleCount, 2);
  for (const row of page.data.view.rows) assert.strictEqual(row.category, '赛事');
  assert.strictEqual(page.data.view.tabs.find((t) => t.tab === '通知').count, 2);
});

test('公告列表页 —— 重复点当前标签不做无谓的重新加载', async () => {
  resetSession();
  facade.setAssociation('pkb');

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

test('公告管理页 —— 学院负责人被整页挡住：公告是发给全俱乐部的，学院负责人没有这个范围', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(STAFF);

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, false);
  assert.deepStrictEqual(page.data.view.rows, [], '学院负责人不该拿到公告台账，尤其是已下架的');
  assert.match(page.data.view.blockedText, /权限/);
});

test('发布公告页 —— 学院负责人填不了表，整页只给一句提示', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(STAFF);

  const page = instantiate(announcementEditConfig);
  await page.onLoad();

  assert.match(page.data.blockReason, /权限/);
});

test('公告管理页 —— 管理员看到台账', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  assert.strictEqual(page.data.view.allowed, true);
  assert.strictEqual(page.data.view.total, 6);
  assert.strictEqual(page.data.view.publishedCount, 6);
  assert.strictEqual(page.data.view.archivedCount, 0);
  // 有发布权时每一行都给下架按钮
  assert.strictEqual(page.data.view.rows[0].canArchive, true);
});

test('公告管理页 —— 下架后台账里仍在、沉到底部且不再给按钮，公开页少一条', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

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
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(announcementManageConfig);
  await page.onLoad();

  calls.navigations.length = 0;
  page.onGoPublish();
  assert.deepStrictEqual(calls.navigations, ['/pages/announcement-edit/announcement-edit']);
});

test('公告管理页 —— 从发布页返回时刷新台账', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

  const page = instantiate(announcementManageConfig);
  await page.onLoad();
  assert.strictEqual(page.data.view.total, 6);

  // 模拟在发布页里发了一条，返回时 onShow 应当把它带出来
  await facade.publishAnnouncement(
    { title: '临时通知', content: '明天停训一次。', category: '通知' },
    ADMIN._id
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

test('发布公告页 —— 管理员能填表，填好后提交落进数据源并返回上一页', async () => {
  resetSession();
  app.globalData.userInfo = fakeMember(ADMIN);

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
  app.globalData.userInfo = fakeMember(ADMIN);

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
  app.globalData.userInfo = fakeMember(ADMIN);

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
 * 学院赛 —— 发布（M2-2）
 * ============================================================ */

test('发布学院赛 —— 只有管理员能进表单，学院负责人与会员被挡', () => {
  loginAs(ADMIN);
  const allowed = instantiate(collegeEventEditConfig);
  allowed.onLoad();
  assert.strictEqual(allowed.data.blockReason, '', '管理员给表单');

  // 学院负责人管的是本学院临场事务，发布学院赛定的是整场规则，门槛收口到管理员
  loginAs(STAFF);
  const staff = instantiate(collegeEventEditConfig);
  staff.onLoad();
  assert.match(staff.data.blockReason, /没有发布学院赛的权限/);

  loginAs();
  const member = instantiate(collegeEventEditConfig);
  member.onLoad();
  assert.match(member.data.blockReason, /没有发布学院赛的权限/);

  resetSession();
  const guest = instantiate(collegeEventEditConfig);
  guest.onLoad();
  assert.match(guest.data.blockReason, /请先登录/);
});

test('发布学院赛 —— 填齐配置可发布，落库即报名中', async () => {
  loginAs(ADMIN);
  const page = instantiate(collegeEventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '学院团体赛' } });
  page.onInputDescription({ detail: { value: '各院限报一队' } });
  page.onPickDate({ detail: { value: '2026-10-01' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onInputLocation({ detail: { value: '体育馆' } });
  page.onInputCourtCount({ detail: { value: '4' } });

  // 默认先摆一项男单，点两次「+」依次补齐女单与男双，行号即出场顺序
  assert.deepStrictEqual(page.data.form.legPlan, ['MS']);
  page.onAddLeg();
  page.onAddLeg();
  assert.deepStrictEqual(page.data.form.legPlan, ['MS', 'WS', 'MD']);
  assert.strictEqual(page.data.legRows.length, 3);

  // 把第 3 项改成混双，验证按行改项目
  page.onPickLeg({ currentTarget: { dataset: { row: 2 } }, detail: { value: '4' } });
  assert.strictEqual(page.data.legRows[2].label, '混双');
  assert.deepStrictEqual(page.data.form.legPlan, ['MS', 'WS', 'XD']);

  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(page.data.errorText, '', page.data.errorText);
  assert.strictEqual(calls.backCount, 1, '发布后返回上一页');

  const list = await facade.getCollegeEvents();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, '学院团体赛');
  assert.deepStrictEqual(list[0].legPlan, ['MS', 'WS', 'XD']);
  assert.strictEqual(list[0].status, COLLEGE_EVENT_STATUS.SIGNUP, '发布即报名中');
  // 人数留空取默认区间；算法默认打满比净胜
  assert.strictEqual(list[0].rosterMin, 4);
  assert.strictEqual(list[0].rosterMax, 20);
  assert.strictEqual(list[0].courtCount, 4);
  assert.strictEqual(list[0].tieAlgo, 'full_points');
  assert.strictEqual(list[0].tieNetMode, 'win_diff');
});

test('发布学院赛 —— 至少留一个小项：最后一个删不掉，空序列也进不了库', async () => {
  loginAs(ADMIN);
  const page = instantiate(collegeEventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '学院团体赛' } });
  page.onPickDate({ detail: { value: '2026-10-01' } });
  page.onPickTime({ detail: { value: '09:00' } });

  // 默认就一项，删不动
  assert.deepStrictEqual(page.data.form.legPlan, ['MS']);
  page.onRemoveLeg({ currentTarget: { dataset: { row: 0 } } });
  assert.deepStrictEqual(page.data.form.legPlan, ['MS'], '最后一个小项删不掉');
  assert.strictEqual(page.data.legRows.length, 1);

  // 加一项后可以删回去，但仍旧留一项
  page.onAddLeg();
  assert.deepStrictEqual(page.data.form.legPlan, ['MS', 'WS']);
  page.onRemoveLeg({ currentTarget: { dataset: { row: 1 } } });
  assert.deepStrictEqual(page.data.form.legPlan, ['MS']);

  // 序列若被清空（例如从别处塞进来），服务端仍拦下且不落库
  page.setData({ form: { ...page.data.form, legPlan: [] } });
  await page.onSubmit();
  assert.match(page.data.errors.legPlan, /至少安排一个小项/);
  assert.strictEqual((await facade.getCollegeEvents()).length, 0, '校验不过不落库');
});

test('发布学院赛 —— 先到 N 场胜时不校验净胜口径', async () => {
  loginAs(ADMIN);
  const page = instantiate(collegeEventEditConfig);
  page.onLoad();

  page.onInputTitle({ detail: { value: '学院团体赛' } });
  page.onPickDate({ detail: { value: '2026-10-01' } });
  page.onPickTime({ detail: { value: '09:00' } });
  page.onPickTieAlgo({ detail: { value: '1' } });
  page.onInputCourtCount({ detail: { value: '4' } });
  await page.onSubmit();

  const list = await facade.getCollegeEvents();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].tieAlgo, 'first_to_n');
  // 用不上净胜口径时记 null，读的时候不必判「这个字段有没有意义」
  assert.strictEqual(list[0].tieNetMode, null);
});

test('赛事页 —— 学院赛发布入口同样只给管理员', async () => {
  loginAs(ADMIN);
  const admin = instantiate(eventsConfig);
  await admin.onLoad();
  assert.strictEqual(admin.data.view.canManageCollege, true, '管理员才给学院赛入口');

  calls.navigations.length = 0;
  admin.onOpenCollegePublish();
  assert.deepStrictEqual(calls.navigations, ['/pages/college-event-edit/college-event-edit']);

  loginAs(STAFF);
  const staff = instantiate(eventsConfig);
  await staff.onLoad();
  assert.strictEqual(staff.data.view.canManageCollege, false, '学院负责人不给学院赛入口');

  loginAs();
  const member = instantiate(eventsConfig);
  await member.onLoad();
  assert.strictEqual(member.data.view.canManageCollege, false, '普通会员不给学院赛入口');
});

/* ============================================================
 * 学院赛 —— 名单提交（M2-3）与名单审核（M2-4）
 * ============================================================ */

/**
 * 学院赛用例围着这一所学院转：一男一女各一名，排阵才排得出男单 + 女单
 * （单一性别的学院凑不出阵，性别校验在数据层兜底）。
 *
 * 【为什么学院负责人换成了本校会员】
 * 种子里唯一的学院负责人 u02 张宇轩在信息工程学院，而信息工程学院只有两名男
 * 会员，排不出女单。权限判定按编号回查台账（见 mock.accountOf），不能拿
 * u02 去管别的学院；所以改由管理员把本校一名男会员任为学院负责人，再用他的
 * 身份走完整条链路——与真人被任命的路径一致。
 */
const STAFF_COLLEGE = '管理学院';
/** 管理学院的负责人：王浩然（u04），发布赛事时现场任命 */
const STAFF_ID = 'u04';

/**
 * 造一场「报名中」的学院赛。门槛是管理员，这里以管理员身份落库，
 * 用例想以谁的身份看，自己在 onLoad 前摆登录态即可。
 * 默认人数下限压到 1：演示数据里单个学院凑不满默认的 4 人。
 *
 * 顺带把 STAFF_ID 任为 STAFF_COLLEGE 的负责人：resetCache 会清掉角色任免，
 * 而学院赛的写入口一律按编号回查角色，不在每条用例里重新任命就都过不去。
 */
async function publishTestCollegeEvent(overrides = {}) {
  const result = await facade.publishCollegeEvent(
    {
      title: '学院团体赛',
      legPlan: ['MS', 'WS'],
      startTime: '2026-10-01T09:00:00',
      rosterMin: 1,
      rosterMax: 20,
      courtCount: 4,
      ...overrides,
    },
    ADMIN._id
  );
  assert.strictEqual(result.ok, true, `发布学院赛失败：${result.firstError}`);

  const appointed = await facade.setCollegeLeader(STAFF_ID, ADMIN._id, true);
  assert.strictEqual(appointed.ok, true, `任命 ${STAFF_COLLEGE} 学院负责人失败：${appointed.message}`);

  return result.record;
}

/** 取某学院在册会员的编号，用于拼一份合法名单 */
async function memberIdsOf(college) {
  const members = await facade.getMembers();
  return members.filter((member) => member.college === college).map((member) => member._id);
}

test('名单提交 —— 学院负责人只看得到本学院的候选，外院的人不在其中', async () => {
  const event = await publishTestCollegeEvent();
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeEntryConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.canSubmit, true);
  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.college, STAFF_COLLEGE);
  assert.ok(page.data.view.candidates.length > 0, '本院应有候选队员');

  const members = await facade.getMembers();
  const byId = new Map(members.map((member) => [member._id, member]));
  for (const candidate of page.data.view.candidates) {
    assert.strictEqual(byId.get(candidate.memberId).college, STAFF_COLLEGE, '候选里不许混进外院的人');
  }
});

test('名单提交 —— 学院负责人提交本学院名单成功，落库为待审核', async () => {
  const event = await publishTestCollegeEvent();
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeEntryConfig);
  await page.onLoad({ eventId: event._id });

  const ids = page.data.view.candidates.map((candidate) => candidate.memberId);
  page.onToggleMember({ detail: { value: ids } });
  assert.strictEqual(page.data.view.selectedCount, ids.length, '勾选人数回写到视图模型');

  calls.backCount = 0;
  await page.onSubmit();

  assert.strictEqual(calls.backCount, 1, '提交成功后返回上一页');
  const entries = await facade.getCollegeEntries(event._id);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].college, STAFF_COLLEGE);
  assert.strictEqual(entries[0].status, COLLEGE_ENTRY_STATUS.PENDING, '提交即待审核');
  assert.deepStrictEqual(
    entries[0].members.slice().sort(),
    ids.slice().sort(),
    '名单里的人就是勾选的人'
  );
});

test('名单提交 —— 普通会员与访客都被挡在名单页外', async () => {
  const event = await publishTestCollegeEvent();

  // 普通会员：有账号但管不了任何学院
  loginAs();
  const member = instantiate(collegeEntryConfig);
  await member.onLoad({ eventId: event._id });
  assert.strictEqual(member.data.view.canSubmit, false);
  assert.match(member.data.view.blockReason, /只能提交本学院的名单/);

  // 访客：连登录都没有
  resetSession();
  const guest = instantiate(collegeEntryConfig);
  await guest.onLoad({ eventId: event._id });
  assert.match(guest.data.view.blockReason, /请先登录/);
});

test('名单提交 —— 名单混入外院队员被数据层拒下，不落库', async () => {
  const event = await publishTestCollegeEvent();
  const members = await facade.getMembers();
  const outsider = members.find((member) => member.college !== STAFF_COLLEGE && member.status === USER_STATUS.ACTIVE);
  assert.ok(outsider, '演示数据里应有一个外院会员');
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const result = await facade.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: [outsider._id] },
    STAFF_ID
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不属于本学院/);
  assert.strictEqual((await facade.getCollegeEntries(event._id)).length, 0, '校验不过不落库');
});

test('名单提交 —— 学院负责人替别的学院提交被拒', async () => {
  const event = await publishTestCollegeEvent();
  const members = await facade.getMembers();
  const otherCollege = members.find((member) => member.college !== STAFF_COLLEGE).college;
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const result = await facade.submitCollegeEntry(
    { eventId: event._id, college: otherCollege, memberIds: [] },
    STAFF_ID
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.message, /只能提交本学院的名单/);
});

test('名单提交 —— 人数不在上下限内会被数据层拒下', async () => {
  // 演示数据里每个学院恰好两人，把区间定成 1–1 就能同时卡住两端
  const event = await publishTestCollegeEvent({ rosterMin: 1, rosterMax: 1 });
  const ids = await memberIdsOf(STAFF_COLLEGE);
  assert.ok(ids.length >= 2, '演示数据里本院至少两人');

  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const args = { eventId: event._id, college: STAFF_COLLEGE };

  const justRight = await facade.submitCollegeEntry({ ...args, memberIds: ids.slice(0, 1) }, STAFF_ID);
  assert.strictEqual(justRight.ok, true, '刚好落在区间内可以提交');

  const tooMany = await facade.submitCollegeEntry({ ...args, memberIds: ids.slice(0, 2) }, STAFF_ID);
  assert.strictEqual(tooMany.ok, false);
  assert.match(tooMany.message, /最多 1 人/);

  // 下限同样由数据层把关：另开一场要求至少两人
  const strict = await publishTestCollegeEvent({ rosterMin: 2, rosterMax: 2 });
  const tooFew = await facade.submitCollegeEntry(
    { eventId: strict._id, college: STAFF_COLLEGE, memberIds: ids.slice(0, 1) },
    STAFF_ID
  );
  assert.strictEqual(tooFew.ok, false);
  assert.match(tooFew.message, /至少 2 人/);
});

test('赛事页 —— 学院赛一行按身份去不同的页', async () => {
  const event = await publishTestCollegeEvent();

  // 管理员：进详情页（抽签、开赛、大场与审核入口都在那里）
  loginAs(ADMIN);
  const admin = instantiate(eventsConfig);
  await admin.onLoad();
  assert.strictEqual(admin.data.view.hasCollegeEvents, true);
  const adminRow = admin.data.view.collegeEvents[0];
  assert.strictEqual(adminRow.canReview, true);
  assert.strictEqual(adminRow.canSubmit, false);
  assert.strictEqual(adminRow.actionText, '管理');

  calls.navigations.length = 0;
  admin.onOpenCollegeEvent({
    currentTarget: { dataset: { eventId: event._id, canSubmit: false } },
  });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/college-event-detail/college-event-detail?eventId=${event._id}`,
  ]);

  // 学院负责人：报名中直接进本学院的名单页
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(eventsConfig);
  await staff.onLoad();
  const staffRow = staff.data.view.collegeEvents[0];
  assert.strictEqual(staffRow.canReview, false, '学院负责人没有审核权');
  assert.strictEqual(staffRow.canSubmit, true);
  assert.strictEqual(staffRow.actionText, '提交名单');

  calls.navigations.length = 0;
  staff.onOpenCollegeEvent({
    currentTarget: { dataset: { eventId: event._id, canSubmit: true } },
  });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/college-entry/college-entry?eventId=${event._id}`,
  ]);

  // 普通会员：进详情页看签表与对阵
  loginAs();
  const member = instantiate(eventsConfig);
  await member.onLoad();
  const memberRow = member.data.view.collegeEvents[0];
  assert.strictEqual(memberRow.canSubmit, false);
  assert.strictEqual(memberRow.actionText, '查看');

  calls.navigations.length = 0;
  member.onOpenCollegeEvent({
    currentTarget: { dataset: { eventId: event._id, canSubmit: false } },
  });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/college-event-detail/college-event-detail?eventId=${event._id}`,
  ]);
});

test('名单审核 —— 只有管理员能进，学院负责人被挡', async () => {
  const event = await publishTestCollegeEvent();

  loginAs(ADMIN);
  const admin = instantiate(collegeEntryReviewConfig);
  await admin.onLoad({ eventId: event._id });
  assert.strictEqual(admin.data.view.canReview, true);
  assert.strictEqual(admin.data.view.blockReason, '');

  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(collegeEntryReviewConfig);
  await staff.onLoad({ eventId: event._id });
  assert.match(staff.data.view.blockReason, /只有管理员/);
});

test('名单审核 —— 通过后状态变为已通过', async () => {
  const event = await publishTestCollegeEvent();
  const ids = await memberIdsOf(STAFF_COLLEGE);
  await facade.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: ids },
    STAFF_ID
  );

  loginAs(ADMIN);
  const page = instantiate(collegeEntryReviewConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.pendingCount, 1);
  const { entryId } = page.data.view.rows[0];

  await page.onApprove({ currentTarget: { dataset: { entryId } } });

  assert.strictEqual(page.data.view.pendingCount, 0);
  assert.strictEqual(page.data.view.rows[0].statusLabel, '已通过');
  const entries = await facade.getCollegeEntries(event._id);
  assert.strictEqual(entries[0].status, COLLEGE_ENTRY_STATUS.APPROVED);
});

test('名单审核 —— 退回必须填理由，填了才生效', async () => {
  const event = await publishTestCollegeEvent();
  const ids = await memberIdsOf(STAFF_COLLEGE);
  await facade.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: ids },
    STAFF_ID
  );

  loginAs(ADMIN);
  const page = instantiate(collegeEntryReviewConfig);
  await page.onLoad({ eventId: event._id });
  const { entryId } = page.data.view.rows[0];

  page.onOpenReject({ currentTarget: { dataset: { entryId, college: STAFF_COLLEGE } } });
  assert.strictEqual(page.data.reject.open, true);

  // 没填理由：挡下，名单仍是待审核
  await page.onSubmitReject();
  assert.match(page.data.actionError, /请填写退回理由/);
  assert.strictEqual((await facade.getCollegeEntries(event._id))[0].status, COLLEGE_ENTRY_STATUS.PENDING);

  // 填了理由：退回生效，理由留在记录上
  page.onInputReason({ detail: { value: '名单人数不足' } });
  await page.onSubmitReject();

  assert.strictEqual(page.data.reject.open, false);
  const entries = await facade.getCollegeEntries(event._id);
  assert.strictEqual(entries[0].status, COLLEGE_ENTRY_STATUS.RETURNED);
  assert.strictEqual(entries[0].reason, '名单人数不足');
  assert.strictEqual(page.data.view.rows[0].statusLabel, '已退回');
});

/* ============================================================
 * 学院赛详情 / 排阵 / 大场开始
 * ============================================================ */

/** 历史文化学院 —— 演示数据里的另一所参赛学院（同样一男一女） */
const OTHER_COLLEGE = '历史文化学院';

/**
 * 造一场两院参赛、已抽签并已开始的学院赛。
 * 路线与管理员实际操作一致：交名单 → 审核通过 → 抽签 → 开始赛事。
 *
 * @returns {Promise<{event:Object, ties:Array<Object>}>}
 */
async function startTestCollegeEvent() {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });

  await facade.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: await memberIdsOf(STAFF_COLLEGE) },
    STAFF_ID
  );
  await facade.submitCollegeEntry(
    { eventId: event._id, college: OTHER_COLLEGE, memberIds: await memberIdsOf(OTHER_COLLEGE) },
    ADMIN._id
  );

  for (const entry of await facade.getCollegeEntries(event._id)) {
    await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN._id);
  }

  const drawn = await facade.drawCollegeEvent(event._id, ADMIN._id, { seedValue: 42 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await facade.startCollegeEvent(event._id, ADMIN._id);
  assert.strictEqual(started.ok, true, `开始赛事失败：${started.message}`);
  return { event: drawn.record, ties: started.ties };
}

test('学院赛详情 —— 未登录整页挡住', async () => {
  const event = await publishTestCollegeEvent();
  resetSession();

  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  assert.match(page.data.view.blockReason, /请先登录/);
});

test('学院赛详情 —— 管理员点选种子并抽签，名单就此锁定', async () => {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });
  await facade.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: await memberIdsOf(STAFF_COLLEGE) },
    STAFF_ID
  );
  await facade.submitCollegeEntry(
    { eventId: event._id, college: OTHER_COLLEGE, memberIds: await memberIdsOf(OTHER_COLLEGE) },
    ADMIN._id
  );
  for (const entry of await facade.getCollegeEntries(event._id)) {
    await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN._id);
  }

  loginAs(ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.canManage, true, '管理员应看到抽签入口');
  assert.strictEqual(page.data.view.hasApprovedColleges, true);
  assert.strictEqual(page.data.seedRows.length, 2);

  // 点两下同一所学院：先选中，再取消
  page.onToggleSeed({ currentTarget: { dataset: { college: OTHER_COLLEGE } } });
  assert.deepStrictEqual(page.data.seeds, [OTHER_COLLEGE]);
  assert.strictEqual(page.data.seedRows.find((row) => row.college === OTHER_COLLEGE).seedOrderText, '种子 1');

  page.onToggleSeed({ currentTarget: { dataset: { college: OTHER_COLLEGE } } });
  assert.deepStrictEqual(page.data.seeds, []);

  // 按顺序指定两个种子，抽签落库
  page.onToggleSeed({ currentTarget: { dataset: { college: OTHER_COLLEGE } } });
  page.onToggleSeed({ currentTarget: { dataset: { college: STAFF_COLLEGE } } });
  await page.onDraw();

  assert.strictEqual(page.data.view.hasDraw, true);
  assert.strictEqual(page.data.view.isReady, true, '抽签后转「待开赛」，名单锁定');
  assert.strictEqual(page.data.view.canStartEvent, true);

  const saved = await facade.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.READY);
  assert.deepStrictEqual(saved.draw.seeds, [OTHER_COLLEGE, STAFF_COLLEGE]);
});

test('学院赛详情 —— 学院负责人报名中能从详情页进名单页', async () => {
  const event = await publishTestCollegeEvent();
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.view.canSubmitEntry, true);
  assert.strictEqual(page.data.view.canManage, false, '学院负责人不该看到抽签入口');

  calls.navigations.length = 0;
  page.onOpenEntry();
  assert.deepStrictEqual(calls.navigations, [`/pages/college-entry/college-entry?eventId=${event._id}`]);
});

test('学院赛详情 —— 开始赛事生成首轮大场，双方排阵齐后可开始大场', async () => {
  const event = await publishTestCollegeEvent({ legPlan: ['MS', 'WS'] });
  await facade.submitCollegeEntry(
    { eventId: event._id, college: STAFF_COLLEGE, memberIds: await memberIdsOf(STAFF_COLLEGE) },
    STAFF_ID
  );
  await facade.submitCollegeEntry(
    { eventId: event._id, college: OTHER_COLLEGE, memberIds: await memberIdsOf(OTHER_COLLEGE) },
    ADMIN._id
  );
  for (const entry of await facade.getCollegeEntries(event._id)) {
    await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN._id);
  }
  await facade.drawCollegeEvent(event._id, ADMIN._id, { seedValue: 42 });

  loginAs(ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });
  assert.strictEqual(page.data.view.canStartEvent, true);

  await page.onStartEvent();

  assert.strictEqual(page.data.view.isOngoing, true);
  assert.strictEqual(page.data.view.hasTies, true);
  const tieRow = page.data.view.ties[0];
  assert.strictEqual(tieRow.isPendingLineup, true, '刚生成的大场在等双方排阵');
  assert.strictEqual(tieRow.canStart, false, '排阵没齐不能开始');
  assert.strictEqual(tieRow.legRows.length, 2, '小项按赛事配置铺好');
});

test('排阵页 —— 未登录与非本大场的学院都被挡住', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  resetSession();
  const anon = instantiate(collegeLineupConfig);
  await anon.onLoad({ tieId: tie._id, eventId: event._id });
  assert.match(anon.data.view.blockReason, /请先登录/);

  // 用一所没进这场大场的学院登录：看不到也排不了
  loginAs({ role: 1, _id: 'u05', college: '经济学院' });
  const outsider = instantiate(collegeLineupConfig);
  await outsider.onLoad({ tieId: tie._id, eventId: event._id });
  assert.match(outsider.data.view.blockReason, /不在本大场的参赛学院内/);
});

test('排阵页 —— 学院负责人按默认值排人并提交，A 侧标记为已排阵', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id });

  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.college, STAFF_COLLEGE);
  assert.strictEqual(page.data.view.hasLineup, false);
  // 演示数据里两所学院各两人，单打各需一人
  assert.deepStrictEqual(page.data.view.legs.map((leg) => leg.need), [1, 1]);

  const ids = await memberIdsOf(STAFF_COLLEGE);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 2 } }, detail: { value: [ids[1]] } });

  await page.onSubmit();

  assert.strictEqual(page.data.view.hasLineup, true, '提交后本场有我方排阵');
  assert.match(page.data.view.carryHint, /已提交过本场排阵/);

  const lineups = await facade.getCollegeLineups(event._id);
  assert.strictEqual(lineups.length, 1);
  assert.strictEqual(lineups[0].college, STAFF_COLLEGE);
  assert.deepStrictEqual(lineups[0].entries.map((row) => row.players), [[ids[0]], [ids[1]]]);

  // 该大场的对应一侧被翻开
  const saved = (await facade.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  const mySide = STAFF_COLLEGE === tie.collegeA ? saved.lineupA : saved.lineupB;
  assert.strictEqual(mySide, true);
});

test('排阵页 —— 超过小项人数上限时撤回过多的点选并提示', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id });

  const ids = await memberIdsOf(STAFF_COLLEGE);
  calls.toasts.length = 0;
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: ids } });

  assert.match(calls.toasts[0], /第 1 场最多只能排 1 名队员/);
  assert.strictEqual(page.data.view.legs[0].pickedText, '未排人', '超限整次改动作废');
});

test('排阵页 —— 有人没排满时提交被数据层拒下', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });

  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id });

  const ids = await memberIdsOf(STAFF_COLLEGE);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });

  calls.toasts.length = 0;
  await page.onSubmit();

  assert.match(calls.toasts[0], /第 2 场还没排满 1 名队员/);
  assert.strictEqual((await facade.getCollegeLineups(event._id)).length, 0, '没排满不落库');
});

test('大场开始 —— 双方排阵齐后管理员才能点开始', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  // 一人排一半：大场起始仍是待排阵，管理员点不动
  const staffIds = await memberIdsOf(STAFF_COLLEGE);
  await facade.submitLineup(
    {
      tieId: tie._id,
      college: STAFF_COLLEGE,
      entries: [
        { legNo: 1, players: [staffIds[0]] },
        { legNo: 2, players: [staffIds[1]] },
      ],
    },
    STAFF_ID
  );

  loginAs(ADMIN);
  const partial = instantiate(collegeEventDetailConfig);
  await partial.onLoad({ eventId: event._id });
  assert.strictEqual(partial.data.view.ties[0].canStart, false, '只交了一方，不能开');
  assert.match(partial.data.view.ties[0].statusLabel, /待排阵/);

  // 另一方也交齐
  const otherIds = await memberIdsOf(OTHER_COLLEGE);
  await facade.submitLineup(
    {
      tieId: tie._id,
      college: OTHER_COLLEGE,
      entries: [
        { legNo: 1, players: [otherIds[0]] },
        { legNo: 2, players: [otherIds[1]] },
      ],
    },
    ADMIN._id
  );

  await partial.refresh();
  const readyRow = partial.data.view.ties[0];
  assert.strictEqual(readyRow.statusLabel, '待开赛');
  assert.strictEqual(readyRow.lineupASubmitted, true);
  assert.strictEqual(readyRow.lineupBSubmitted, true);
  assert.strictEqual(readyRow.canStart, true);

  await partial.onStartTie({ currentTarget: { dataset: { tieId: tie._id } } });

  assert.match(partial.data.view.ties[0].statusLabel, /进行中/);
});

test('学院赛详情 —— 管理员在大场上指派裁判，铺到还没开打的小场', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  const referee = (await facade.getMembers()).find((member) => member._id === STAFF_ID);
  assert.ok(referee, '拿一位在册会员当裁判');

  loginAs(ADMIN);
  const page = instantiate(collegeEventDetailConfig);
  await page.onLoad({ eventId: event._id });

  const before = page.data.view.ties[0];
  assert.strictEqual(before.referee, '', '还没指派');
  assert.strictEqual(before.canAssignReferee, true, '管理员在未结束的大场上可以指派');

  calls.toasts.length = 0;
  await page.onOpenReferee({ currentTarget: { dataset: { tieId: tie._id } } });
  assert.strictEqual(page.data.referee.open, true);
  assert.strictEqual(page.data.referee.tieId, tie._id);
  assert.ok(page.data.referee.rows.length > 0, '面板里摆出在册会员');

  await page.onPickReferee({ currentTarget: { dataset: { userId: STAFF_ID } } });

  assert.strictEqual(page.data.referee.open, false, '指派后收起面板');
  assert.match(calls.toasts.join('|'), /已指派裁判/);

  const after = page.data.view.ties[0];
  assert.strictEqual(after.referee, STAFF_ID, '指派已落库并回到页面上');
  assert.strictEqual(after.refereeName, referee.nickName, '页面显示裁判的名字而不是编号');

  const saved = (await facade.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  assert.strictEqual(saved.referee, STAFF_ID, '大场这一层记下了裁判');

  // 开打后生成的小场要带上大场的裁判：权限判定在小场，不能等到录分时再回头问大场
  const staffIds = await memberIdsOf(STAFF_COLLEGE);
  await facade.submitLineup(
    {
      tieId: tie._id,
      college: STAFF_COLLEGE,
      entries: [
        { legNo: 1, players: [staffIds[0]] },
        { legNo: 2, players: [staffIds[1]] },
      ],
    },
    STAFF_ID
  );
  const otherIds = await memberIdsOf(OTHER_COLLEGE);
  await facade.submitLineup(
    {
      tieId: tie._id,
      college: OTHER_COLLEGE,
      entries: [
        { legNo: 1, players: [otherIds[0]] },
        { legNo: 2, players: [otherIds[1]] },
      ],
    },
    ADMIN._id
  );
  await facade.startTie(tie._id, ADMIN._id);

  const started = (await facade.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  const ledger = await facade.getMatchRecords();
  for (const leg of started.legs) {
    const match = ledger.find((item) => item._id === leg.matchId);
    assert.ok(match, '小场已经生成');
    assert.strictEqual(match.referee, STAFF_ID, '小场跟着大场指派到了裁判');
  }
});

test('学院赛详情 —— 只有管理员看得到指派裁判入口', async () => {
  const { event } = await startTestCollegeEvent();

  // 学院负责人：管得了本学院名单，但派不了裁判
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(collegeEventDetailConfig);
  await staff.onLoad({ eventId: event._id });
  assert.strictEqual(staff.data.view.ties[0].canAssignReferee, false);

  // 普通会员：同样不给入口
  loginAs(activeMember());
  const member = instantiate(collegeEventDetailConfig);
  await member.onLoad({ eventId: event._id });
  assert.strictEqual(member.data.view.ties[0].canAssignReferee, false);
});

test('学院赛详情 —— 管理员能替两侧排阵，学院负责人只拿到本侧', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  // 管理员：本人学院（体育学院）并不在这两侧，仍应两侧各给一个排阵入口
  loginAs(ADMIN);
  const admin = instantiate(collegeEventDetailConfig);
  await admin.onLoad({ eventId: event._id });

  const adminRow = admin.data.view.ties.find((row) => row.tieId === tie._id);
  assert.strictEqual(adminRow.canSubmitLineup, true, '管理员该能看到排阵入口');
  assert.deepStrictEqual(
    adminRow.lineupActions.map((action) => action.college),
    [tie.collegeA, tie.collegeB],
    '两侧各一个入口'
  );
  assert.deepStrictEqual(
    adminRow.lineupActions.map((action) => action.side),
    ['A', 'B']
  );
  assert.match(adminRow.lineupActions[0].label, /提交 A 侧排阵/);

  // 点某一侧的按钮：跳排阵页时把那一侧学院带上
  calls.navigations.length = 0;
  admin.onOpenLineup({ currentTarget: { dataset: { tieId: tie._id, college: tie.collegeB } } });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/college-lineup/college-lineup?tieId=${tie._id}&eventId=${event._id}&college=${encodeURIComponent(tie.collegeB)}`,
  ]);

  // 学院负责人：只解得出自己那一侧，入口只有一个
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const staff = instantiate(collegeEventDetailConfig);
  await staff.onLoad({ eventId: event._id });
  const staffRow = staff.data.view.ties.find((row) => row.tieId === tie._id);
  assert.strictEqual(staffRow.lineupActions.length, 1, '学院负责人只管自己那一侧');
  assert.strictEqual(staffRow.lineupActions[0].college, STAFF_COLLEGE);
});

test('排阵页 —— 管理员带 college 参数替任一方排阵', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];
  const sideCollege = STAFF_COLLEGE;
  loginAs(ADMIN);

  // 不带 college：管理员本人学院不在大场内，被挡住（这正是要修的旧行为）
  const noParam = instantiate(collegeLineupConfig);
  await noParam.onLoad({ tieId: tie._id, eventId: event._id });
  assert.match(noParam.data.view.blockReason, /不在本大场的参赛学院内/);

  // 带 college：替该侧排阵，进得去
  const page = instantiate(collegeLineupConfig);
  await page.onLoad({ tieId: tie._id, eventId: event._id, college: sideCollege });
  assert.strictEqual(page.data.view.blockReason, '');
  assert.strictEqual(page.data.view.college, sideCollege);
  assert.strictEqual(page.data.view.canSubmit, true);

  // 能真正提交：数据层按编号回查，管理员替任一方兜底是允许的
  const ids = await memberIdsOf(sideCollege);
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 1 } }, detail: { value: [ids[0]] } });
  page.onTogglePlayer({ currentTarget: { dataset: { legNo: 2 } }, detail: { value: [ids[1]] } });
  await page.onSubmit();

  const lineups = await facade.getCollegeLineups(event._id);
  assert.strictEqual(lineups.length, 1);
  assert.strictEqual(lineups[0].college, sideCollege, '排阵落在指定的那一侧学院名下');
});

test('学院赛小场录分 —— 大场指派的裁判亮在小场页上，别人的录入随之收口', async () => {
  const { event, ties } = await startTestCollegeEvent();
  const tie = ties[0];

  const staffIds = await memberIdsOf(STAFF_COLLEGE);
  await facade.submitLineup(
    {
      tieId: tie._id,
      college: STAFF_COLLEGE,
      entries: [
        { legNo: 1, players: [staffIds[0]] },
        { legNo: 2, players: [staffIds[1]] },
      ],
    },
    STAFF_ID
  );
  const otherIds = await memberIdsOf(OTHER_COLLEGE);
  await facade.submitLineup(
    {
      tieId: tie._id,
      college: OTHER_COLLEGE,
      entries: [
        { legNo: 1, players: [otherIds[0]] },
        { legNo: 2, players: [otherIds[1]] },
      ],
    },
    ADMIN._id
  );
  await facade.startTie(tie._id, ADMIN._id);

  const started = (await facade.getCollegeTies(event._id)).find((item) => item._id === tie._id);
  const matchId = started.legs[0].matchId;
  assert.ok(matchId, '大场开打后小场才生成');

  const assigned = await facade.assignTieReferee(tie._id, STAFF_ID, ADMIN._id);
  assert.strictEqual(assigned.ok, true, assigned.message);
  const referee = (await facade.getMembers()).find((member) => member._id === STAFF_ID);

  // 场上别的人：看得到谁执法，录不了分
  loginAs(activeMember());
  const outsider = instantiate(collegeMatchConfig);
  await outsider.onLoad({ matchId });
  assert.strictEqual(outsider.data.view.hasReferee, true);
  assert.strictEqual(outsider.data.view.refereeName, referee.nickName);
  assert.strictEqual(outsider.data.view.canRecord, false, '裁判接管后旁人不能录分');
  assert.match(outsider.data.view.refereeNotice, /仅裁判与管理员可录入比分/);

  // 裁判本人：照常录入，不必再对自己重复一遍限制
  loginAs({ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE });
  const self = instantiate(collegeMatchConfig);
  await self.onLoad({ matchId });
  assert.strictEqual(self.data.view.canRecord, true);
  assert.strictEqual(self.data.view.refereeRestricted, false);
  assert.strictEqual(self.data.view.refereeNotice, '');
});

/* ============================================================
 * 个人赛弃权（M5-3）入口
 * ============================================================ */

/**
 * 造一场进行中的 4 人单败赛事，返回首轮其中一场。
 * 路线与真人一致：发布 → 报名 → 抽签 → 开赛。
 */
async function scheduledSinglesMatch() {
  const members = await facade.getMembers();
  const players = members.slice(0, 4).map((member) => member._id);

  const published = await facade.publishEvent(
    {
      title: '弃权入口自检赛',
      description: 'M5-3 页面入口',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SECOND,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      seedMode: SEED_MODE.ELO,
      seedCount: 4,
      startTime: '2026-05-20T09:00:00',
      location: '学校体育馆',
      quota: 4,
      courtCount: 4,
    },
    ADMIN._id
  );
  assert.strictEqual(published.ok, true, `发布赛事失败：${published.firstError}`);

  const eventId = published.record._id;
  for (const userId of players) {
    await facade.signUpEvent(eventId, userId);
  }
  await facade.drawEvent(eventId, ADMIN._id, { seedValue: 11 });
  await facade.startEvent(eventId, ADMIN._id);

  const matches = await facade.getMatchRecords({ eventId });
  return { eventId, players, match: matches.filter((item) => item.round === 1)[0] };
}

test('比赛页 —— 赛事里待打的比赛给本人「弃权」入口，确认后对手晋级且不计分', async () => {
  const { eventId, match } = await scheduledSinglesMatch();
  const me = match.teamA[0];
  const expectedWinner = 'B';

  const before = await facade.getMembers();
  loginAs({ _id: me, role: 0, status: 1 });

  const page = instantiate(matchConfig);
  await page.onLoad();
  await page.onSwitchTab({ currentTarget: { dataset: { tab: 'mine' } } });

  const row = page.data.view.records.find((item) => item.matchId === match._id);
  assert.ok(row, '自己那场应在「我的比赛」里');
  assert.strictEqual(row.canForfeit, true, '待打的赛事比赛给本人弃权入口');

  calls.modals.length = 0;
  await page.onForfeit({ currentTarget: { dataset: { matchId: match._id } } });

  assert.strictEqual(calls.modals.length, 1, '破坏性操作先弹确认框');
  assert.match(calls.modals[0], /不计个人等级分/, '要说清弃权的后果');

  const after = (await facade.getMatchRecords({ eventId })).find((item) => item._id === match._id);
  assert.strictEqual(after.outcome, MATCH_OUTCOME.FORFEIT);
  assert.strictEqual(after.winner, expectedWinner);
  assert.deepStrictEqual(await facade.getMembers(), before, '弃权不计任何个人等级分或积分');
});

test('比赛页 —— 取消确认框时不落库', async () => {
  const { eventId, match } = await scheduledSinglesMatch();
  loginAs({ _id: match.teamA[0], role: 0, status: 1 });

  const page = instantiate(matchConfig);
  await page.onLoad();

  calls.modalConfirmed = false;
  await page.onForfeit({ currentTarget: { dataset: { matchId: match._id } } });

  const after = (await facade.getMatchRecords({ eventId })).find((item) => item._id === match._id);
  assert.strictEqual(after.outcome, undefined, '点了取消就不该写库');
  assert.strictEqual(after.status, MATCH_STATUS.PENDING);
});

/* ============================================================
 * 学院名次录入页（M5-1）
 * ============================================================ */

test('学院名次页 —— 管理员填名次并提交，赛事随即结束', async () => {
  const { event } = await startTestCollegeEvent();
  loginAs(ADMIN);

  const page = instantiate(collegePlacementConfig);
  await page.onLoad({ eventId: event._id });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.view.canSubmit, true);
  assert.strictEqual(page.data.view.hasRows, true);
  assert.strictEqual(page.data.view.rows.length, 2, '两所已通过名单的学院各一行');

  const [first, second] = page.data.view.rows.map((row) => row.college);
  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1' } });
  page.onInputPlacement({ currentTarget: { dataset: { index: 1 } }, detail: { value: '2' } });

  calls.toasts.length = 0;
  const backsBefore = calls.backCount;
  await page.onSubmit();

  const saved = await facade.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.FINISHED);
  assert.deepStrictEqual(saved.results, [
    { college: first, placement: 1 },
    { college: second, placement: 2 },
  ]);
  assert.ok(calls.toasts.some((text) => /名次已录入/.test(text)));
  assert.strictEqual(calls.backCount, backsBefore + 1, '提交完回详情页');
});

test('学院名次页 —— 名次不是正整数时挡下，赛事不结束', async () => {
  const { event } = await startTestCollegeEvent();
  loginAs(ADMIN);

  const page = instantiate(collegePlacementConfig);
  await page.onLoad({ eventId: event._id });
  page.onInputPlacement({ currentTarget: { dataset: { index: 0 } }, detail: { value: '1.5' } });

  await page.onSubmit();

  assert.match(page.data.errorText, /整数/);
  assert.strictEqual(
    (await facade.getCollegeEvent(event._id)).status,
    COLLEGE_EVENT_STATUS.ONGOING,
    '校验不过时不能结束赛事'
  );
});

test('学院名次页 —— 学院负责人与会员整页挡住，一条学院名单都不下发', async () => {
  const { event } = await startTestCollegeEvent();

  for (const actor of [{ role: 1, _id: STAFF_ID, college: STAFF_COLLEGE }, { role: 0, _id: 'u06' }]) {
    loginAs(actor);
    const page = instantiate(collegePlacementConfig);
    await page.onLoad({ eventId: event._id });

    assert.strictEqual(page.data.view.canSubmit, false);
    assert.match(page.data.view.blockReason, /只有管理员/);
    assert.deepStrictEqual(page.data.view.rows, [], '没有录入资格就不给名单');
  }
});

/* ============================================================
 * 赛事列表改版：近 3 条 + 查看全部 + 置顶
 * ============================================================ */

test('赛事页 —— 列表只摆近 3 条，「查看全部」入口指向完整列表页', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventsConfig);
  await page.onLoad();

  const view = page.data.view;
  assert.strictEqual(view.events.length, 3, '赛事列表默认只摆 3 条');
  assert.strictEqual(view.hasMoreEvents, true, '演示数据里的赛事多于 3 场');
  assert.ok(view.eventTotal > 3);

  calls.navigations.length = 0;
  page.onMoreEvents();
  assert.deepStrictEqual(calls.navigations, ['/pages/event-list/event-list?type=event']);

  calls.navigations.length = 0;
  page.onMoreCollegeEvents();
  assert.deepStrictEqual(calls.navigations, ['/pages/event-list/event-list?type=college']);
});

test('赛事页 —— 管理员点「置顶」把赛事提到最前，普通会员看不到按钮', async () => {
  loginAs(ADMIN);
  const page = instantiate(eventsConfig);
  await page.onLoad();

  // 挑一场原本排在最后的已结束赛事：置顶后能看出它被提到最前
  const target = page.data.view.events[2];
  assert.ok(target, '演示数据里至少三场赛事');
  assert.strictEqual(target.pinned, false);
  assert.strictEqual(target.canPin, true, '管理员看得到置顶开关');

  calls.toasts.length = 0;
  await page.onToggleEventPin({ currentTarget: { dataset: { eventId: target.id, pinned: false } } });

  assert.ok(calls.toasts.includes('已置顶'), '置顶成功要有提示');
  assert.strictEqual(page.data.view.events[0].id, target.id, '置顶后排到最前');
  assert.strictEqual(page.data.view.events[0].pinned, true);

  // 普通会员：列表照常看到置顶标记，但不给置顶开关
  loginAs();
  const memberPage = instantiate(eventsConfig);
  await memberPage.onLoad();
  for (const row of memberPage.data.view.events) {
    assert.strictEqual(row.canPin, false, '普通会员看不到置顶开关');
  }
});

test('赛事页 —— 管理员点「置顶」把学院赛提到最前', async () => {
  const first = await publishTestCollegeEvent({ startTime: '2026-10-01T09:00:00' });
  const second = await publishTestCollegeEvent({ title: '第二场学院赛', startTime: '2026-11-01T09:00:00' });

  loginAs(ADMIN);
  const page = instantiate(eventsConfig);
  await page.onLoad();

  // 两场都是「报名中」，同状态内按开赛时间升序：先开赛的 first 在前
  assert.strictEqual(page.data.view.collegeEvents[0].eventId, first._id);
  assert.strictEqual(page.data.view.collegeEvents[1].eventId, second._id);
  assert.strictEqual(page.data.view.collegeEvents[1].canPin, true);

  calls.toasts.length = 0;
  await page.onToggleCollegePin({ currentTarget: { dataset: { eventId: second._id, pinned: false } } });

  assert.ok(calls.toasts.includes('已置顶'));
  assert.strictEqual(page.data.view.collegeEvents[0].eventId, second._id, '置顶后排到最前');
});

test('全部赛事页 —— 不截断地列出全部赛事，管理员可在页内置顶', async () => {
  loginAs(ADMIN);
  const allEvents = await facade.getEvents();

  const page = instantiate(eventListConfig);
  await page.onLoad({ type: 'event' });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.type, 'event');
  assert.strictEqual(page.data.title, '全部赛事');
  assert.strictEqual(page.data.view.events.length, allEvents.length, '这一页不截断');
  assert.strictEqual(page.data.view.hasMoreEvents, false, '全摆出来就不再有「查看全部」');

  const target = page.data.view.events[1];
  assert.strictEqual(target.canPin, true, '管理员可在这一页置顶');
  await page.onToggleEventPin({ currentTarget: { dataset: { eventId: target.id, pinned: false } } });
  assert.strictEqual(page.data.view.events[0].id, target.id, '置顶后回到最前');
});

test('全部赛事页 —— type=college 走学院赛口径，点行进对应页面', async () => {
  const event = await publishTestCollegeEvent();

  loginAs(ADMIN);
  const page = instantiate(eventListConfig);
  await page.onLoad({ type: 'college' });

  assert.strictEqual(page.data.type, 'college');
  assert.strictEqual(page.data.title, '全部学院赛');
  assert.strictEqual(page.data.view.collegeEvents.length, 1);
  assert.strictEqual(page.data.view.collegeEvents[0].eventId, event._id);

  calls.navigations.length = 0;
  page.onOpenCollegeEvent({ currentTarget: { dataset: { eventId: event._id, canSubmit: false } } });
  assert.deepStrictEqual(calls.navigations, [
    `/pages/college-event-detail/college-event-detail?eventId=${event._id}`,
  ]);
});

/* ============================================================
 * 实时计分台（横屏）
 * ============================================================
 * 页面的职责是把「点一下」变成一次判球，再把实时态画出来；算分与判权
 * 都不在这里。用例重点看三件事：没身份 / 没权限时挡住、点一下加一分、
 * 打满两局能定稿并退回。种子里的 x_e07_r2_main_0 是 u01 对 u04 的待确认
 * 个人赛，u06 既非参赛者也无职务，正好用来验「无权计分」。
 * ============================================================ */

/** 推一球并把这一球发完（页面把请求排在串行队列里） */
async function tap(page, side) {
  page.onScore({ currentTarget: { dataset: { side } } });
  await page.queue;
}

test('实时计分台 —— 未登录不开台', async () => {
  resetSession();
  const page = instantiate(liveScoreConfig);
  await page.onLoad({ matchId: 'x_e07_r2_main_0' });

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.blockReason, '请先登录后再计分');
});

test('实时计分台 —— 非参赛者且无职务，挡在计分台外', async () => {
  loginAs({ _id: 'u06', nickName: '赵明宇', role: 0 });
  const page = instantiate(liveScoreConfig);
  await page.onLoad({ matchId: 'x_e07_r2_main_0' });

  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.blockReason, '你无权为这场比赛计分');
});

test('实时计分台 —— 管理员开台，逐球计分与撤销', async () => {
  loginAs(ADMIN);
  const page = instantiate(liveScoreConfig);
  await page.onLoad({ matchId: 'x_e07_r2_main_0' });

  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.blockReason, '');
  assert.strictEqual(page.data.view.pointsA, 0, '开台从 0:0 起');
  assert.strictEqual(page.data.canUndo, false, '还没判球，没什么可撤');

  await tap(page, 'A');
  await tap(page, 'A');
  await tap(page, 'B');
  assert.strictEqual(page.data.view.pointsA, 2);
  assert.strictEqual(page.data.view.pointsB, 1);
  assert.strictEqual(page.data.view.leading, 'A', '领先方要能高亮出来');
  assert.strictEqual(page.data.canUndo, true);

  page.onUndo();
  await page.queue;
  assert.strictEqual(page.data.view.pointsB, 0, '撤销弹掉最后一球');
  assert.strictEqual(page.data.view.pointsA, 2);
});

test('实时计分台 —— 打满两局可定稿，定稿后退回上一页', async () => {
  loginAs(ADMIN);
  const page = instantiate(liveScoreConfig);
  await page.onLoad({ matchId: 'x_e07_r2_main_0' });

  // 11 分制三局两胜：连拿两局（各 11:0）即分出胜负
  for (let i = 0; i < 22; i += 1) {
    page.onScore({ currentTarget: { dataset: { side: 'A' } } });
  }
  await page.queue;

  assert.strictEqual(page.data.view.gamesA, 2);
  assert.strictEqual(page.data.view.finished, true);
  assert.strictEqual(page.data.canFinish, true);

  const backBefore = calls.backCount;
  page.onFinish();
  await page.queue;

  assert.strictEqual(calls.backCount, backBefore + 1, '定稿后退回上一页等确认');
  const [record] = await facade.getMatchRecords({ id: 'x_e07_r2_main_0' });
  assert.deepStrictEqual(record.scoreA, [11, 11], '定稿把打完的局写成正式比分');
  assert.deepStrictEqual(record.scoreB, [0, 0]);
  assert.strictEqual(record.status, MATCH_STATUS.PENDING, '定稿只到待确认，确认权仍在裁判 / 对手手上');
});

/* ============================================================
 * 赛季管理
 * ============================================================
 * 页面已从「我的」移除，赛季更新改为在云控制台手动操作；
 * 云端 resetSeason 能力与 mock 数据源的行为仍由 season-reset.test.js 覆盖。
 * ============================================================ */
