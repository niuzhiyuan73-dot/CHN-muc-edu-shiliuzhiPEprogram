/**
 * 全部赛事 / 全部学院赛
 * ============================================================
 * 赛事页上两个列表各只摆最近 3 条，「查看全部」就到这里。同一页靠
 * `type` 参数分两种口径（event / college），因为两者的行形状、跳转目标
 * 都不同，但装载逻辑、排序与置顶规则完全一样——不必写成两个页面。
 *
 * 【为什么不复用赛事页而是新开一页】
 * 赛事页还要装赛季积分榜、搜索框与「我的排名」，那一整套在这里全是多余的。
 * 这里只要一份不截断的列表：`loadSchoolEventsPanelView({ listLimit: Infinity, includePoints: false })`。
 *
 * 身份与权限来自 S2 会话及读端能力，列表、积分和置顶使用相同学校 / 协会范围。
 * ============================================================
 */

const { loadSchoolEventsPanelView } = require('../../services/school-events-panel-view.js');
const { isMock } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
// 两类赛事的读取与置顶均走同一 S2 范围。
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

  /**
   * 管理员置顶 / 取消置顶一场学院赛。
   *
   * 与个人赛一致，这一步走学校维度：列表已按 S2 读，置顶也得写回 S2 的学院赛
   * 主记录（见 school-college-service.setCollegeEventPinned）。权限与登录都由
   * 服务端判，未登录 / 无管理权时读端返回 ok:false，页面只负责把话说清楚。
   */
  onToggleCollegePin(event) {
    const { eventId, pinned } = event.currentTarget.dataset;
    if (!eventId) return undefined;
    const next = !pinned;
    const scope = {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: associationScope.getAssociation(),
    };
    return this.runPin(
      () => space.forScope(this.scope || scope).setCollegeEventPinned({ eventId, pinned: next }),
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
    wx.navigateTo({ url: `/pages/event-detail/event-detail?eventId=${encodeURIComponent(eventId)}` });
  },

  /** 点一场学院赛：学院负责人在报名中去名单页，其余人进详情页 */
  onOpenCollegeEvent(event) {
    const { eventId, canSubmit } = event.currentTarget.dataset;
    if (!eventId) return;
    if (canSubmit) {
      wx.navigateTo({ url: `/pages/college-entry/college-entry?eventId=${encodeURIComponent(eventId)}` });
      return;
    }
    wx.navigateTo({ url: `/pages/college-event-detail/college-event-detail?eventId=${encodeURIComponent(eventId)}` });
  },
});
