/**
 * 赛事
 * ============================================================
 * 页面只做三件事：渲染、点人跳转、点赛事跳详情。取数与整形全在
 * services/events-view.js 里。
 *
 * 【这一页现在有什么】
 *   1. 赛事列表：近期有哪些赛事、我报了哪一场，是赛事闭环的入口；
 *   2. 赛季积分榜：按本赛季积分排序，谁投入谁在前（决策 14）。
 * 积分榜是「积分」这把尺子的展示面；「等级分」那把尺子在「排行榜」tab。
 *
 * 【为什么单独占一个 tab】
 * 决策 14。两个榜回答的是不同的问题（实力 vs 投入），挤在一页里，
 * 用户会拿积分去比实力。
 *
 * 【登录态为什么由页面传进去】
 * mock 的 getCurrentUser() 永远答 u06。若让视图模型自己去问，一个没登录
 * 的访客也会被当成 u06，凭空拿到报名与管理权限。所以这里把 getApp() 里的
 * 登录态明确传下去，传 null 就是访客。
 * ============================================================
 */

const { loadEventsView } = require('../../services/events-view.js');
const { isMock } = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    // 视图模型，形状见 services/events-view.js。
    // 初值给空对象而不是 null，WXML 里的 {{view.xxx}} 才不会报错。
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock,
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心 onLoad 的返回值，
   * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    return this.refresh();
  },

  /** 从详情 / 发布页返回时刷新一次，刚报的名、刚发的赛事才在列表里 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新：数据都在内存里，重算一遍很快 */
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
      const view = await loadEventsView({ user: this.currentUser(), isMock });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[events] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '赛事页加载失败，请下拉重试' });
    }
  },

  /** 点榜上的任何一行，去看这个人的完整战绩 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;

    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },

  /** 点一场赛事，进详情看报名名单或录入名次 */
  onOpenEvent(event) {
    const eventId = event.currentTarget.dataset.eventId;
    if (!eventId) return;

    wx.navigateTo({ url: `/pages/event-detail/event-detail?eventId=${eventId}` });
  },

  /** 管理员发布赛事。无发布权时按钮根本不会渲染出来 */
  onOpenPublish() {
    wx.navigateTo({ url: '/pages/event-edit/event-edit' });
  },
});
