/**
 * 全部赛事
 * ============================================================
 * 赛事页的「查看全部」落点，只保留个人赛事分支。
 *
 * 【学院赛分支已下线】
 * 学院赛整体迁入「石榴籽杯」，列表由 `pages/cup-home` 按项目承载。
 * 旧链接 `?type=college` 仍可能从聊天记录或收藏进入，这里直接重定向，
 * 不再维护第二套学院赛列表。
 * ============================================================
 */

const { loadSchoolEventsPanelView } = require('../../services/school-events-panel-view.js');
const { isMock } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
// 赛事读取与置顶走同一 S2 范围。
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 视图模型，形状见 services/school-events-panel-view.js */
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock,
    /** 固定为全部赛事；保留字段是为了兼容旧模板与测试 */
    type: 'event',
    /** 导航栏与页内标题 */
    title: '全部赛事',
    /** 置顶 / 取消置顶进行中，防止连点 */
    pinning: false,
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    // 学院赛已迁入石榴籽杯：旧链接不报错，直接换页
    if (query && query.type === 'college') {
      this.redirected = true;
      if (typeof wx !== 'undefined' && typeof wx.redirectTo === 'function') {
        wx.redirectTo({ url: '/pages/cup-home/cup-home' });
      }
      return undefined;
    }

    this.setData({ type: 'event', title: '全部赛事' });
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title: '全部赛事' });
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
    const scope = { schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID, association: associationScope.getAssociation() };
    this.scope = scope;
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    try {
      const view = await loadSchoolEventsPanelView({ ...scope, listLimit: Infinity, includePoints: false });
      if (request !== this.loadRequest) return;
      this.loaded = true;
      this.setData({ loading: false, error: '', view, themeClass: currentThemeClass() });
    } catch (err) {
      if (request !== this.loadRequest) return;
      console.error('[event-list] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, view: {}, error: err.message || '列表加载失败，请下拉重试', themeClass: currentThemeClass() });
    }
  },

  /**
   * 置顶 / 取消置顶的共用流程：调用 S2 接口判权 → 提示 → 整页重载。
   * @param {() => Promise<Object>} write 写接口
   * @param {string} successText 成功后的提示
   * @returns {Promise<void>}
   */
  async runPin(write, successText) {
    if (this.data.pinning) return undefined;

    this.setData({ pinning: true });
    let result;
    try { result = await write(); } catch (error) { result = { ok: false, message: error.message || '操作失败，请重试' }; }
    finally { this.setData({ pinning: false }); }

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
      () => space.forScope(this.scope).setSchoolEventPinned({ eventId, pinned: next }),
      next ? '已置顶' : '已取消置顶'
    );
  },

  /** 管理员发布赛事。无发布权时按钮根本不会渲染出来 */
  onOpenPublish() {
    wx.navigateTo({ url: '/pages/event-edit/event-edit' });
  },

  /** 点一场赛事，进详情 */
  onOpenEvent(event) {
    const eventId = event.currentTarget.dataset.eventId;
    if (!eventId) return;
    wx.navigateTo({ url: `/pages/event-detail/event-detail?eventId=${encodeURIComponent(eventId)}` });
  },
});
