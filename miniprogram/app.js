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
   */
  initDataSource() {
    const envId = this.globalData.cloudEnvId;
    let target = DATA_SOURCE.MOCK;

    if (envId) {
      if (!wx.cloud) {
        console.error('[app] 当前基础库不支持云开发，请升级至 2.2.3 以上');
      } else {
        wx.cloud.init({
          env: envId,
          // traceUser 会在云开发控制台的「用户管理」中记录访问用户
          traceUser: true,
        });
        target = DATA_SOURCE.CLOUD;
        console.info('[app] 云开发已初始化，环境：', envId);
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
