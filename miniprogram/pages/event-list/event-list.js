/**
 * 全部赛事 / 全部学院赛
 * ============================================================
 * 赛事页上两个列表各只摆最近 3 条，「查看全部」就到这里。同一页靠
 * `type` 参数分两种口径（event / college），因为两者的行形状、跳转目标
 * 都不同，但装载逻辑、排序与置顶规则完全一样——不必写成两个页面。
 *
 * 【为什么不复用赛事页而是新开一页】
 * 赛事页还要装赛季积分榜、搜索框与「我的排名」，那一整套在这里全是多余的。
 * 这里只要一份不截断的列表：`loadEventsView({ listLimit: Infinity })`。
 *
 * 【登录态为什么由页面传进去】
 * 与赛事页同一理由：mock 的 getCurrentUser() 永远答 u06，视图模型自己去问
 * 会把访客当成熟客。这里把 getApp() 里的登录态明确传下去，传 null 就是访客。
 * ============================================================
 */

const { loadEventsView } = require('../../services/events-view.js');
const {
  setEventPinned,
  setCollegeEventPinned,
  isMock,
} = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/events-view.js */
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock,
    /** 'event' 看全部赛事，'college' 看全部学院赛 */
    type: 'event',
    /** 导航栏与页内标题 */
    title: '全部赛事',
    /** 置顶 / 取消置顶进行中，防止连点 */
    pinning: false,
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    const type = query && query.type === 'college' ? 'college' : 'event';
    const title = type === 'college' ? '全部学院赛' : '全部赛事';
    this.type = type;
    this.setData({ type, title });
    // 测试环境里没有这个 API，做个保护
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title });
    }
    return this.refresh();
  },

  /** 从详情 / 发布页返回时刷新一次 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => {
      if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh();
      }
    });
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 重新装载整页数据。`listLimit: Infinity` 即不截断——这正是本页与
   * 赛事页唯一的区别。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadEventsView({
        user: this.currentUser(),
        isMock,
        listLimit: Infinity,
      });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[event-list] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '列表加载失败，请下拉重试' });
    }
  },

  /**
   * 置顶 / 取消置顶的共用流程：判登录 → 调接口 → 提示 → 整页重载。
   * @param {(actorId:string) => Promise<Object>} write 写接口
   * @param {string} successText 成功后的提示
   * @returns {Promise<void>}
   */
  async runPin(write, successText) {
    if (this.data.pinning) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    this.setData({ pinning: true });
    const result = await write(user._id);
    this.setData({ pinning: false });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '操作失败');
      return undefined;
    }

    this.showToast(successText, 'success');
    return this.refresh();
  },

  /** 管理员置顶 / 取消置顶一场赛事 */
  onToggleEventPin(event) {
    const { eventId, pinned } = event.currentTarget.dataset;
    if (!eventId) return undefined;
    const next = !pinned;
    return this.runPin(
      (actorId) => setEventPinned(eventId, next, actorId),
      next ? '已置顶' : '已取消置顶'
    );
  },

  /** 管理员置顶 / 取消置顶一场学院赛 */
  onToggleCollegePin(event) {
    const { eventId, pinned } = event.currentTarget.dataset;
    if (!eventId) return undefined;
    const next = !pinned;
    return this.runPin(
      (actorId) => setCollegeEventPinned(eventId, next, actorId),
      next ? '已置顶' : '已取消置顶'
    );
  },

  /** 管理员发布赛事。无发布权时按钮根本不会渲染出来 */
  onOpenPublish() {
    wx.navigateTo({ url: '/pages/event-edit/event-edit' });
  },

  /** 管理员发布学院赛。与发布个人赛同一权限门槛 */
  onOpenCollegePublish() {
    wx.navigateTo({ url: '/pages/college-event-edit/college-event-edit' });
  },

  /** 点一场赛事，进详情 */
  onOpenEvent(event) {
    const eventId = event.currentTarget.dataset.eventId;
    if (!eventId) return;
    wx.navigateTo({ url: `/pages/event-detail/event-detail?eventId=${eventId}` });
  },

  /** 点一场学院赛：干事在报名中去名单页，其余人进详情页 */
  onOpenCollegeEvent(event) {
    const { eventId, canSubmit } = event.currentTarget.dataset;
    if (!eventId) return;
    if (canSubmit) {
      wx.navigateTo({ url: `/pages/college-entry/college-entry?eventId=${eventId}` });
      return;
    }
    wx.navigateTo({ url: `/pages/college-event-detail/college-event-detail?eventId=${eventId}` });
  },
});
