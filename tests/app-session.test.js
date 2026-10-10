/**
 * 启动时的会话校正
 * ============================================================
 * 守的是一个真实踩过的坑：登录态在注册那一刻整份写进本地缓存
 * （app.setUserInfo），而所有页面读的都是这份缓存，没有一处会回查服务端。
 * 于是管理员在后台把人审核通过后，那个人的客户端仍然显示「待审核」，
 * 成绩录不了，界面也不提示他要重新登录一次——只能靠自己猜。
 *
 * app.js 之前没有任何测试覆盖（页面测试用的是替身 app，见 tests/page.test.js），
 * 所以这里搭一个最小运行环境，把 onLaunch 真跑一遍。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const facade = require('../miniprogram/services/index.js');
const { resolveAuthState } = require('../miniprogram/services/auth.js');
const { DEFAULT_CURRENT_USER_ID } = require('../miniprogram/services/mock.js');
const { DATA_SOURCE, STORAGE_KEY, ROLE, USER_STATUS } = require('../miniprogram/utils/constants.js');

/* ============================================================
 * 最小小程序运行环境
 * ============================================================ */

/** 假的 wx.setStorageSync / getStorageSync 后端 */
let storage = {};

/** wx.cloud.callFunction 的返回值，以及被调用的次数 */
let cloudResult = null;
let cloudCalls = 0;

global.wx = {
  getWindowInfo: () => ({
    statusBarHeight: 20,
    windowWidth: 375,
    windowHeight: 667,
    screenHeight: 667,
    safeArea: { bottom: 667 },
  }),
  getDeviceInfo: () => ({ platform: 'devtools' }),
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, value) => {
    storage[key] = value;
  },
  removeStorageSync: (key) => {
    delete storage[key];
  },
  cloud: {
    init: () => {},
    callFunction: async () => {
      cloudCalls += 1;
      return { result: cloudResult };
    },
  },
};

/** 收集 app.js 注册的配置 */
let appConfig = null;
global.App = (config) => {
  appConfig = config;
};

require('../miniprogram/app.js');

/* ============================================================
 * 用例脚手架
 * ============================================================ */

/** 一名刚注册、还没通过实名审核的会员 */
function pendingMember() {
  return {
    _id: 'u_3f2a',
    nickName: '马小雨',
    realName: '马小雨',
    role: ROLE.MEMBER,
    status: USER_STATUS.PENDING,
  };
}

/** 同一个人，已被管理员审核通过并提为管理员 */
function approvedMember() {
  return {
    _id: 'u_3f2a',
    nickName: '马小雨',
    realName: '马小雨',
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
  };
}

/** 让 refreshSession 里的 await 链跑完（setImmediate 排在所有微任务之后） */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 模拟一次冷启动。
 *
 * @param {Object} params
 * @param {string} params.envId 环境 ID。空串即 mock 模式
 */
async function launch({ envId }) {
  appConfig.globalData = {
    dataSource: DATA_SOURCE.MOCK,
    cloudEnvId: envId,
    userInfo: null,
    systemInfo: null,
  };

  appConfig.onLaunch();
  // onLaunch 里 refreshSession 是故意不 await 的，这里补上等待
  await flush();
}

beforeEach(() => {
  storage = {};
  cloudCalls = 0;
  cloudResult = { ok: true, data: null };
  // 门面是模块级单例，用例之间必须复位，否则上一条的 cloud 会漏给下一条
  facade.setDataSource(DATA_SOURCE.MOCK);
});

/* ============================================================
 * 校正
 * ============================================================ */

test('启动时会用服务端的最新状态覆盖本地缓存 —— 后台审核通过后不必手动重新登录', async () => {
  // 本地缓存里是注册那一刻的快照：待审核、普通会员
  storage[STORAGE_KEY.USER_INFO] = pendingMember();
  cloudResult = { ok: true, data: approvedMember() };

  await launch({ envId: 'test-env' });

  assert.strictEqual(cloudCalls, 1, '云端模式下启动应当回查一次');
  assert.strictEqual(appConfig.globalData.userInfo.status, USER_STATUS.ACTIVE);
  assert.strictEqual(appConfig.globalData.userInfo.role, ROLE.ADMIN);

  // 缓存也要一起更新：只改内存的话，下次冷启动又退回旧状态
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO].status, USER_STATUS.ACTIVE);

  // 用户看得见的结果：不再被当成待审核，可以录成绩了
  const state = resolveAuthState(appConfig.globalData.userInfo);
  assert.strictEqual(state.isPending, false);
  assert.strictEqual(state.canRecord, true);
});

test('服务端查不到这个账号时清掉本地会话，而不是留着一个幽灵登录态', async () => {
  storage[STORAGE_KEY.USER_INFO] = approvedMember();
  // 账号文档被删掉的情形：接口正常返回，但内容是空
  cloudResult = { ok: true, data: null };

  await launch({ envId: 'test-env' });

  assert.strictEqual(appConfig.globalData.userInfo, null);
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO], undefined, '本地缓存也要清掉');
  assert.strictEqual(resolveAuthState(null).loggedIn, false);
});

test('云端故障时保留本地登录态，不因为一次抖动把人踢下线', async () => {
  const cached = approvedMember();
  storage[STORAGE_KEY.USER_INFO] = cached;
  // 顶层 ok:false 表示基础设施故障，cloud.js 会据此抛错
  cloudResult = { ok: false, message: '数据库连接失败' };

  await launch({ envId: 'test-env' });

  assert.strictEqual(cloudCalls, 1);
  assert.strictEqual(appConfig.globalData.userInfo, cached, '拉取失败应当沿用缓存');
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO], cached);
});

/* ============================================================
 * 不该发生的事
 * ============================================================ */

test('mock 模式一次云端请求都不发，也不拿演示会员覆盖刚注册的账号', async () => {
  const cached = pendingMember();
  storage[STORAGE_KEY.USER_INFO] = cached;
  // mock 的 login() 会返回种子里的演示会员（已通过审核），一旦用它去覆盖，
  // 刚注册的人会莫名其妙变成正式会员。所以 mock 的校正走「按 _id 回查」：
  // 'u_3f2a' 既不在种子里也不在申请里，回查为空，原快照原样留着。
  cloudResult = { ok: true, data: approvedMember() };

  await launch({ envId: '' });

  assert.strictEqual(cloudCalls, 0, 'mock 模式不该请求云端');
  assert.strictEqual(appConfig.globalData.userInfo, cached);
  assert.strictEqual(appConfig.globalData.userInfo.status, USER_STATUS.PENDING);
});

test('mock 模式按 _id 校正角色 —— 数据源把人提为学院负责人，排阵权限不该还停在旧快照', async () => {
  // 登录快照是更早写下的「普通会员」；数据源里同一人已被提为学院负责人。
  // 不回查的话，界面按快照判权限，学院负责人照样进不了排阵。
  const stale = {
    _id: DEFAULT_CURRENT_USER_ID,
    nickName: '赵明宇',
    realName: '赵明宇',
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
  };
  storage[STORAGE_KEY.USER_INFO] = stale;

  await launch({ envId: '' });

  const user = appConfig.globalData.userInfo;
  assert.strictEqual(cloudCalls, 0, 'mock 模式仍然一次云端请求都不发');
  assert.strictEqual(user.role, ROLE.STAFF, '角色应被数据源里的最新值覆盖');
  assert.ok(user.college, '学院也一并带回，排阵判权限要用它');
  assert.strictEqual(storage[STORAGE_KEY.USER_INFO].role, ROLE.STAFF, '缓存同步更新');
});

test('本地没有登录态时不发起校正请求', async () => {
  await launch({ envId: 'test-env' });

  assert.strictEqual(cloudCalls, 0, '没登录就没有可校正的东西');
  assert.strictEqual(appConfig.globalData.userInfo, null);
});

/* ============================================================
 * 云开发初始化失败
 * ============================================================ */

test('wx.cloud.init 抛错时整份退回 mock，onLaunch 不中断', async () => {
  // 环境 ID 填错或基础库残缺时 init 会同步抛错。若任它冒出去，onLaunch
  // 会中断在 setDataSource 之前：门面停在默认 mock、globalData 没写，
  // 两边对不上。这里守住「抛错也退回 mock，且启动继续走完」。
  const originalInit = global.wx.cloud.init;
  global.wx.cloud.init = () => {
    throw new Error('invalid env');
  };
  try {
    await launch({ envId: 'bad-env' });

    assert.strictEqual(appConfig.globalData.dataSource, DATA_SOURCE.MOCK);
    assert.strictEqual(facade.getDataSource(), DATA_SOURCE.MOCK);
    assert.strictEqual(cloudCalls, 0, '退回 mock 后不该再调云函数');
    // 启动流程走完了，后面的步骤（采集系统信息）没被跳过
    assert.ok(appConfig.globalData.systemInfo, 'onLaunch 不该中断在 initDataSource');
  } finally {
    global.wx.cloud.init = originalInit;
  }
});

test('基础库没有 wx.cloud 时退回 mock，不抛错', async () => {
  const originalCloud = global.wx.cloud;
  delete global.wx.cloud;
  try {
    await launch({ envId: 'test-env' });

    assert.strictEqual(appConfig.globalData.dataSource, DATA_SOURCE.MOCK);
    assert.strictEqual(facade.getDataSource(), DATA_SOURCE.MOCK);
  } finally {
    global.wx.cloud = originalCloud;
  }
});
