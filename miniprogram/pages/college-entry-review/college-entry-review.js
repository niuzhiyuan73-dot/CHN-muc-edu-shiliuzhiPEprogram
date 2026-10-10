/**
 * 学院名单审核（管理员）
 * ============================================================
 * 把各学院提交的名单逐份过一遍：通过或退回。取数与整形在
 * services/college-view.js，权限与校验在 services/college-entry.js（纯函数），
 * 页面只做渲染与交互。
 *
 * 【为什么退回要弹面板、通过不用】
 * 退回必须带理由（与入会审核同一条硬规则）：没有理由，学院只知道「没过」，
 * 不知道该改哪里，只能原样再交一遍。所以退回走面板、理由必填；通过则是
 * 「资料对得上」，点一下即可，不额外加一道点击。
 *
 * 【通过之后名单还能不能改】
 * 通过只表示这份名单有效，名单仍锁定在「报名中」——学院负责人可以继续改并重交，
 * 重交会退回「待审核」。真正锁死名单的是管理员抽签（状态转「待开赛」），
 * 那是下一页的事。因此这里不做「通过即锁定」的暗示。
 * ============================================================
 */

const { loadCollegeEntryReviewView } = require('../../services/college-view.js');
const { reviewCollegeEntry, isMock } = require('../../services/index.js');
// 审核动作与入会审核共用同一套取值，直接复用，免得两处各写一份字符串
const { REVIEW_ACTION } = require('../../services/member-review.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 正在处理的名单编号，防止连点 */
    acting: '',
    /** 退回面板。open 为 false 时不渲染 */
    reject: { open: false, entryId: '', college: '' },
    /** 退回面板里填的理由 */
    reason: '',
    /** 面板内的错误提示 */
    actionError: '',
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 eventId
   */
  onLoad(query = {}) {
    this.eventId = query.eventId || '';
    return this.refresh();
  },

  /** 从名单页返回时刷新一次，刚提交的名单才会出现在待审列表 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
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
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadCollegeEntryReviewView(this.eventId, { user: this.currentUser() });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[college-entry-review] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '名单审核页加载失败，请返回重试' });
    }
  },

  /* ---------- 通过 ---------- */

  /**
   * 直接通过。名单没有额外的审核字段，不必再弹一个面板；
   * 后端仍会校验「是否管理员」「是否待审核」。
   */
  async onApprove(event) {
    const entryId = event.currentTarget.dataset.entryId;
    if (!entryId || this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再审核');
      return undefined;
    }

    this.setData({ acting: entryId });
    const result = await reviewCollegeEntry(entryId, REVIEW_ACTION.APPROVE, '', user._id);
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '操作失败');
      return undefined;
    }

    this.showToast('已通过', 'success');
    return this.refresh();
  },

  /* ---------- 退回 ---------- */

  onOpenReject(event) {
    const { entryId, college } = event.currentTarget.dataset;
    if (!entryId) return;

    this.setData({ reject: { open: true, entryId, college: college || '' }, reason: '', actionError: '' });
  },

  onInputReason(event) {
    this.setData({ reason: event.detail.value, actionError: '' });
  },

  onCancelReject() {
    if (this.data.acting) return;
    this.setData({ reject: { open: false, entryId: '', college: '' }, reason: '', actionError: '' });
  },

  /** 提交退回。理由必填——没有理由的退回，学院无从改起 */
  async onSubmitReject() {
    if (this.data.acting) return undefined;

    const reason = String(this.data.reason || '').trim();
    if (!reason) {
      this.setData({ actionError: '请填写退回理由' });
      return undefined;
    }

    const user = this.currentUser();
    if (!user) {
      this.setData({ actionError: '请先登录后再审核' });
      return undefined;
    }

    const { entryId } = this.data.reject;
    this.setData({ acting: entryId, actionError: '' });
    const result = await reviewCollegeEntry(entryId, REVIEW_ACTION.REJECT, reason, user._id);
    this.setData({ acting: '' });

    if (!result.ok) {
      this.setData({ actionError: result.message || '操作失败' });
      return undefined;
    }

    this.setData({ reject: { open: false, entryId: '', college: '' }, reason: '' });
    this.showToast('已退回', 'success');
    return this.refresh();
  },

  /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
  noop() {},
});
