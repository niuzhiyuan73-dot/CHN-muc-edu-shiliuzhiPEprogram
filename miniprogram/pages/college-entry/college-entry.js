/**
 * 提交学院名单（学院负责人）
 * ============================================================
 * 学院负责人从本学院在册会员里勾选队员，凑够管理员设定的人数后提交。
 * 取数与整形在 services/college-view.js，校验与组装在
 * services/college-entry.js（纯函数），这里只管交互与 setData。
 *
 * 【为什么名单页面只给学院负责人与管理员】
 * 名单是学院的报名凭据，普通会员既不提交也不审核。没有权限时整页顶掉，
 * 不给「填完再被拒」的机会——与发布赛事页同一处理。
 *
 * 【重交为什么不做二次确认】
 * 同一赛事同一学院只有一份名单，重交覆盖旧的（D10）。管理员尚未审核时，
 * 学院负责人本来就需要改完再交；已通过 / 已退回时页面会显示状态与退回理由，
 * 让学院负责人知道为什么还要再交一次。
 * ============================================================
 */

const { loadCollegeEntryView } = require('../../services/college-view.js');
const { submitCollegeEntry } = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 已勾选的队员编号。勾选状态以它为准，视图模型只作渲染初值 */
    memberIds: [],
    /** 备注（选填） */
    remark: '',
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
   * @param {Object} [query] 路由参数，带 eventId
   */
  onLoad(query = {}) {
    this.eventId = query.eventId || '';
    return this.refresh();
  },

  /** 从审核页返回时刷新一次，刚被退回的名单状态才在页面上 */
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
      const view = await loadCollegeEntryView(this.eventId, { user: this.currentUser() });
      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        view,
        memberIds: view.candidates.filter((item) => item.checked).map((item) => item.memberId),
        remark: view.remark,
      });
    } catch (err) {
      console.error('[college-entry] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '名单页加载失败，请返回重试' });
    }
  },

  /* ---------- 交互 ---------- */

  /** 勾选 / 取消勾选队员。checkbox-group 给出的就是全部已选项 */
  onToggleMember(event) {
    const memberIds = Array.isArray(event.detail.value) ? [...event.detail.value] : [];
    const picked = new Set(memberIds);
    this.setData({
      memberIds,
      'view.candidates': this.data.view.candidates.map((item) => ({
        ...item,
        checked: picked.has(item.memberId),
      })),
      'view.selectedCount': memberIds.length,
    });
  },

  onInputRemark(event) {
    this.setData({ remark: event.detail.value });
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.submitting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再提交名单');
      return undefined;
    }

    this.setData({ submitting: true });
    const result = await submitCollegeEntry(
      {
        eventId: this.eventId,
        college: this.data.view.college,
        memberIds: this.data.memberIds,
        remark: this.data.remark,
      },
      user._id
    );

    if (!result.ok) {
      this.setData({ submitting: false });
      this.showToast(result.message || '提交失败');
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已提交，等待管理员审核', 'success');
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
});
