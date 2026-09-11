/**
 * 赛季管理页
 * ============================================================
 * 只做一件事：执行一次赛季软重置。
 * 取数与权限判定全在 services/season-view.js，页面只做渲染与交互
 * ——那一层不碰 wx API，因而权限规则能在 Node 里逐条测。
 *
 * 【登录态由页面传进去，不让数据源自己猜】
 * mock 数据源永远认为当前用户是 u06。若让视图模型自己去问，一个没登录
 * 的访客也会被当成 u06，凭空拿到重置赛季的权限。所以这里把 getApp() 里的
 * 登录态明确传下去，传 null 就是访客。
 *
 * 【重置为什么只写分界点、不直接改分数】
 * 分数是派生数据，由回放引擎统一重算。重置只把「从这一刻起新赛季」这个
 * 事实与服务端此刻落库，下一次读取时引擎在该分界处统一压分，并把进步榜
 * 依赖的起点分一起刷新（见 services/replay.js 的 applySeasonReset）。
 * 这样每台设备算出来的结果必然一致。
 *
 * 【为什么必须失败关闭】
 * 重置影响的是全俱乐部每个人的分数，不可撤销。没有权限时视图模型一条
 * 数据都不下发，页面上就不可能冒出一个能点的重置按钮。
 * ============================================================
 */

const { loadSeasonManageView } = require('../../services/season-view.js');
const { resetSeason, isMock } = require('../../services/index.js');

/** 重置前的二次确认文案。说清影响面与不可撤销，别让人手滑 */
const RESET_CONFIRM =
  '重置后全俱乐部所有人的等级分都会按既定策略压向锚点，本操作不可撤销。确定现在开始新赛季吗？';

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/season-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 重置请求进行中，防止连点 */
    acting: false,
  },

  /** 返回 Promise 是有意为之：测试需要句柄等首屏加载完 */
  onLoad() {
    return this.refresh();
  },

  /** 从别处返回时刷新一次状态（例如管理员在别处刚重置过） */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 二次确认。测试环境里没有 wx.showModal，直接放行——
   * 测试要验证的是「确认之后做了什么」，不是弹窗本身。
   * @param {string} content
   * @returns {Promise<boolean>}
   */
  confirm(content) {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(true);
        return;
      }
      wx.showModal({
        title: '赛季重置',
        content,
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      });
    });
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();

    try {
      const view = await loadSeasonManageView({ user, isMock });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[season-manage] 赛季状态加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '赛季状态加载失败，请下拉重试' });
    }
  },

  /** 执行一次赛季重置。先确认，再动手 */
  async onReset() {
    if (this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    const confirmed = await this.confirm(RESET_CONFIRM);
    if (!confirmed) return undefined;

    this.setData({ acting: true });
    const result = await resetSeason(user._id);
    this.setData({ acting: false });

    if (!result || !result.ok) {
      this.showToast((result && result.message) || '赛季重置失败');
      return undefined;
    }

    this.showToast('新赛季已开始', 'success');
    return this.refresh();
  },
});
