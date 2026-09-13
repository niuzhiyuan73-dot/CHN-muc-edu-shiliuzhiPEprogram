/**
 * 小程序入口文件
 * ============================================================
 * 职责：
 *   1. 初始化云开发环境（仅在使用云端数据源时需要）
 *   2. 提供全局数据与全局方法
 *   3. 处理全局错误与未捕获的 Promise 异常
 * ============================================================
 */

const { STORAGE_KEY, DATA_SOURCE } = require('./utils/constants.js');
const { CLOUD_ENV_ID } = require('./config.js');
const facade = require('./services/index.js');

App({
  /**
   * 全局数据。页面通过 getApp().globalData 访问。
   * 注意：globalData 仅在内存中，小程序被销毁后清空。
   * 需要持久化的数据请使用 wx.setStorageSync。
   */
  globalData: {
    /** 当前数据源模式：'mock' 或 'cloud' */
    dataSource: DATA_SOURCE.MOCK,

    /** 云开发环境 ID。来源见 config.js，启动时由 initDataSource 填入 */
    cloudEnvId: CLOUD_ENV_ID,

    /** 当前登录用户信息，未登录时为 null */
    userInfo: null,

    /** 系统信息（状态栏高度等），在 onLaunch 中采集 */
    systemInfo: null,
  },

  onLaunch() {
    this.initSystemInfo();
    this.initDataSource();
    this.restoreUserInfo();
    // 故意不 await：启动流程不该被一次网络往返拖住。校正结果落在
    // globalData 上，下一次页面 onShow 读全局登录态时就会体现出来
    this.refreshSession();
  },

  /**
   * 采集设备与窗口信息。
   * 用于自定义导航栏、适配刘海屏等场景，后续页面会用到。
   */
  initSystemInfo() {
    try {
      const windowInfo = wx.getWindowInfo();
      const deviceInfo = wx.getDeviceInfo();
      this.globalData.systemInfo = {
        statusBarHeight: windowInfo.statusBarHeight,
        windowWidth: windowInfo.windowWidth,
        windowHeight: windowInfo.windowHeight,
        safeAreaBottom: windowInfo.screenHeight - windowInfo.safeArea.bottom,
        platform: deviceInfo.platform,
      };
    } catch (err) {
      console.error('[app] 获取系统信息失败', err);
    }
  },

  /**
   * 初始化数据源。
   *
   * 【设计意图】开发初期尚未申请 AppID / 开通云开发时，使用 mock 模式，
   * 全部功能依靠本地模拟数据即可完整跑通，便于界面开发与演示。
   * 拿到环境 ID 填进 config.js 之后，启动即走云端，业务代码无需任何改动。
   *
   * 【为什么要在这里调门面】数据源只有一个开关，就是门面的 setDataSource。
   * 早先这里只改 globalData.dataSource，而门面在模块加载时就把实现绑死了，
   * 于是「切到云端」这件事根本传不到取数路径上——开关看着有，其实没接线。
   * 现在云环境就绪与否在这里判定，判定结果亲手交给门面。
   *
   * 【失败为什么退回 mock 而不是硬走云端】环境 ID 填错或基础库太旧时，
   * 走云端会让每个页面都报「云函数调用失败」。退回模拟数据至少界面是活的，
   * 且控制台留下了明确的错误——比一片白屏好定位得多。
   *
   * 【init 为什么也包一层】init 在参数非法或基础库残缺时会同步抛错。若任它
   * 冒出去，onLaunch 会中断在 setDataSource 之前：门面停在默认的 mock，而
   * globalData 也来不及写——两边对不上，比老老实实退回 mock 更难查。
   */
  initDataSource() {
    const envId = this.globalData.cloudEnvId;
    let target = DATA_SOURCE.MOCK;

    if (envId) {
      if (!wx.cloud) {
        console.error('[app] 当前基础库不支持云开发，请升级至 2.2.3 以上');
      } else {
        try {
          wx.cloud.init({
            env: envId,
            // traceUser 会在云开发控制台的「用户管理」中记录访问用户
            traceUser: true,
          });
          target = DATA_SOURCE.CLOUD;
          console.info('[app] 云开发已初始化，环境：', envId);
        } catch (err) {
          console.error('[app] 云开发初始化失败，退回本地模拟数据', err);
        }
      }
    }

    facade.setDataSource(target);
    this.globalData.dataSource = target;

    if (target === DATA_SOURCE.MOCK) {
      console.info('[app] 当前使用本地模拟数据模式，功能可完整预览');
    }
  },

  /**
   * 从本地缓存恢复登录态。
   * 冷启动时避免用户重复授权，提升体验。
   */
  restoreUserInfo() {
    try {
      const cached = wx.getStorageSync(STORAGE_KEY.USER_INFO);
      if (cached && cached._id) {
        this.globalData.userInfo = cached;
      }
    } catch (err) {
      console.error('[app] 读取本地登录态失败', err);
    }
  },

  /**
   * 拿权威数据校正本地登录态。
   *
   * 【为什么必须有这一步】登录态是在注册/登录那一刻整份写进本地缓存的
   * （见 setUserInfo），而所有页面读的都是这份缓存，没有一处会主动回查。
   * 于是管理员在后台把人审核通过、或调整了角色，客户端并不知道：那个人
   * 会一直卡在「待审核」，模板上写着「通过后即可录入成绩」，可他怎么点都
   * 不行，也没有任何提示告诉他「重新登录一次」。启动时静默校正一次，
   * 就把这个死结解开了。
   *
   * 【两条来源，各按各的规矩】云端按微信身份重新取一次账号（login）。
   * mock 没有服务端，但数据源里的人是可以就地读的——按缓存里的 _id 回查
   * 本人。刻意不在 mock 下调 login()：那等于「以演示会员身份登录」，会把
   * 刚注册的账号顶掉；按 _id 回查只校正同一个人，改不到别人头上。
   *
   * 【mock 为什么也要校正】演示场景会把当前用户提为某学院干事
   * （见 college-demo.js），而登录快照是更早写下的「普通会员」。不回查的话，
   * 界面按快照判权限，干事照样进不了排阵——正是这一步要防的不同步。
   *
   * 【失败/none 为什么一律保留缓存】拉取失败多半是网络抖动或云函数偶发
   * 故障；mock 下回查不到，意味着这个 _id 既不在种子也不在申请里。无论
   * 哪种，把人踢回未登录都比让他多看一会儿旧状态糟糕得多。只有云端明确
   * 回答「没有这个账号」（例如账号文档被删）才清本地——那种情况下留着
   * 一份账号，会让每次写操作都报「请先登录」，反而更难排查。
   *
   * @returns {Promise<void>}
   */
  async refreshSession() {
    const cached = this.getUserInfo();
    if (!cached) return;

    if (this.globalData.dataSource === DATA_SOURCE.CLOUD) {
      try {
        // 延迟取用：与 services/auth.js 里 login() 的写法一致，
        // 避免 app → auth → 门面 → mock 的加载期环
        const { login } = require('./services/auth.js');
        const { ok, user } = await login();

        if (ok && user) this.setUserInfo(user);
        else this.clearUserInfo();
      } catch (err) {
        console.error('[app] 校正登录态失败，继续沿用本地缓存', err);
      }
      return;
    }

    try {
      const fresh = await facade.getMember(cached._id);
      if (fresh) this.setUserInfo(fresh);
    } catch (err) {
      console.error('[app] 校正本地登录态失败，继续沿用缓存', err);
    }
  },

  /**
   * 保存登录态到内存与本地缓存。
   * @param {Object} userInfo 用户信息对象
   */
  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
    try {
      wx.setStorageSync(STORAGE_KEY.USER_INFO, userInfo);
    } catch (err) {
      console.error('[app] 写入本地登录态失败', err);
    }
  },

  /**
   * 当前登录会员，未登录时为 null。
   * 页面一律通过它读取登录态，不要去翻 wx.getStorageSync——
   * 内存与缓存的同步只发生在 setUserInfo / clearUserInfo 两处。
   * @returns {Object|null}
   */
  getUserInfo() {
    return this.globalData.userInfo || null;
  },

  /** 是否已登录 */
  isLoggedIn() {
    return Boolean(this.globalData.userInfo);
  },

  /**
   * 清除登录态。用户退出登录或账号被禁用时调用。
   */
  clearUserInfo() {
    this.globalData.userInfo = null;
    try {
      wx.removeStorageSync(STORAGE_KEY.USER_INFO);
    } catch (err) {
      console.error('[app] 清除本地登录态失败', err);
    }
  },

  /**
   * 全局错误处理。
   * 上线后可在此处接入错误上报，便于发现线上问题。
   */
  onError(err) {
    console.error('[app] 未捕获的错误：', err);
  },

  /**
   * 未处理的 Promise 异常。
   * 云函数调用返回 Promise，若不 catch 会走到这里。
   */
  onUnhandledRejection({ reason }) {
    console.error('[app] 未处理的 Promise 异常：', reason);
  },
});
