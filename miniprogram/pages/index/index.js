/**
 * 首页
 * ============================================================
 * 三块内容，自上而下：
 *   1. 我的分数卡片——当前登录会员的各项目等级分与排名
 *   2. 最近比赛——最近打完的几场，胜方、比分、项目一目了然
 *   3. 俱乐部公告——置顶在前，其余按时间倒序
 *
 * 【为什么取数全在 home-view.js】
 * 页面只做渲染与跳转。取数、把会员编号换成昵称、算文案，都在
 * services/home-view.js 里，那边不碰 wx API，能在 Node 里测试。
 *
 * 【登录态变化后为什么要刷新】
 * 用户去登录页转一圈回来，分数卡片就该从「请登录」变成真实数据。
 * 所以 onShow 里再刷一次——但首屏 onLoad 之后紧跟着的 onShow 要跳过，
 * 否则同一份数据会白算两遍。
 * ============================================================
 */

const { loadHomeView } = require('../../services/home-view.js');
const { resolveAuthState } = require('../../services/auth.js');
const facade = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/home-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /** 当前登录态（是否登录、状态标签、能否录成绩） */
    auth: { loggedIn: false },
    /** 当前数据源，用于页脚提示 */
    dataSourceLabel: '',
    /** 开发期标注模拟数据（onLoad 时按门面实际状态刷新） */
    isMock: false,
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心返回值，
   * 但测试需要一个句柄等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    this.showDataSource();
    return this.refresh();
  },

  /** 从别的页面返回时刷新一次，登录/退出后才能立刻看到变化 */
  onShow() {
    // 首次进入时 onLoad 已经加载过，这个紧随其后的 onShow 直接跳过
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const user = this.currentUser();
      const view = await loadHomeView(user);

      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        view,
        auth: resolveAuthState(user),
      });
    } catch (err) {
      console.error('[index] 首页加载失败', err);
      this.loaded = true;
      this.setData({
        loading: false,
        error: '首页数据加载失败，请下拉重试',
      });
    }
  },

  /**
   * 在界面上标注当前数据源，避免开发期把模拟数据当成真实成绩。
   * 直接问门面，而不是读 getApp().globalData——数据源只有一个真源，
   * 两处各存一份迟早会对不上（曾经就出现过开关拨了、界面还显示模拟数据）。
   */
  showDataSource() {
    const mock = facade.isMockNow();
    this.setData({
      dataSourceLabel: mock ? '本地模拟数据' : '云端数据',
      isMock: mock,
    });
  },

  /** 去登录/注册 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /** 去排行榜 */
  onGoRank() {
    wx.switchTab({ url: '/pages/rank/rank' });
  },

  /** 看全部公告。首页只放得下三条，其余的去列表页看 */
  onGoAnnouncements() {
    wx.navigateTo({ url: '/pages/announcements/announcements' });
  },

  /** 去看某个会员的主页 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;
    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },
});
