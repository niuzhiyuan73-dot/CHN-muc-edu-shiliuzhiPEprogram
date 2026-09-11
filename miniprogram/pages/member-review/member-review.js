/**
 * 会员审核页
 * ============================================================
 * 只做一件事：把等待审核的入会申请逐条过一遍，通过或驳回。
 * 取数与权限判定全在 services/member-review-view.js，页面只做渲染与交互
 * ——那一层不碰 wx API，因而「谁能审谁」的规则能在 Node 里逐条测。
 *
 * 【登录态由页面传进去，而且不传就是访客】
 * mock 数据源永远认为当前用户是 u06。若让视图模型自己去问，一个没登录
 * 的访客也会被当成 u06，凭空拿到审核权。所以这里把 getApp() 里的登录态
 * 明确传下去——传 null 就是访客，见 member-review-view 的说明。
 *
 * 【为什么通过只要点一下，驳回却要填理由】
 * 通过是「资料对得上」，没什么可补充的；驳回是「资料有问题」，必须留下
 * 问题是什么，否则申请人问起来谁也说不清当初为什么被拒。所以驳回单独
 * 走一块面板，理由必填。
 *
 * 【onShow 为什么要带守卫】
 * onLoad 之后紧接着就会来一次 onShow。若不加 this.loaded 判断，首屏会
 * 白算两遍。带守卫又必须保留 onShow——从登录页 navigateBack 回来时
 * 登录态可能变了，不刷新就会拿着旧权限渲染。
 * ============================================================
 */

const { loadMemberReviewView } = require('../../services/member-review-view.js');
const { approveMember, rejectMember, isMock } = require('../../services/index.js');

/** 驳回面板的文案。通过不需要面板，只有驳回要填理由 */
const REJECT_TEXT = {
  title: '驳回这条入会申请',
  hint: '驳回后申请人无法使用本小程序，请说明资料哪里有出入。',
  placeholder: '例如：学号与姓名对不上',
};

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 切标签时给个淡淡的反馈，避免点了没反应 */
    switching: false,
    /** 视图模型，形状见 services/member-review-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 驳回面板 */
    action: { open: false, applicationId: '', title: '', hint: '', placeholder: '' },
    /** 面板里填的理由 */
    reason: '',
    /** 提交中，防止连点 */
    acting: false,
    /** 面板内的错误提示 */
    actionError: '',
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心返回值，
   * 但测试需要一个句柄等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    return this.refresh();
  },

  /** 从登录页返回时刷新一次，登录态变了权限也会跟着变 */
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
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();

    try {
      // 能不能看、能看哪些行，全由视图模型判定；这里只把登录态原样递进去
      const view = await loadMemberReviewView({ user, tab: this.currentTab });

      this.loaded = true;
      this.setData({ loading: false, error: '', switching: false, view });
    } catch (err) {
      console.error('[member-review] 会员审核页加载失败', err);
      this.loaded = true;
      this.setData({
        loading: false,
        switching: false,
        error: '入会申请加载失败，请下拉重试',
      });
    }
  },

  /* ---------- 标签 ---------- */

  /** 切换标签（待审核 / 已处理） */
  onSwitchTab(event) {
    const { tab } = event.currentTarget.dataset;
    if (!tab || tab === this.data.view.activeTab || this.data.switching) return undefined;

    this.currentTab = tab;
    this.setData({ switching: true });
    return this.refresh();
  },

  /* ---------- 通过 ---------- */

  /**
   * 通过一条申请。申请人随即成为正式会员。
   * 点错了没有回头路——通过后申请就离开待审列表了，所以先确认一句。
   */
  async onApprove(event) {
    const applicationId = event.currentTarget.dataset.applicationId;
    const user = this.currentUser();
    if (!applicationId) return undefined;
    if (!user) {
      this.showToast('请先登录后再审核');
      return undefined;
    }
    if (this.data.acting) return undefined;

    this.setData({ acting: true });
    const result = await approveMember(applicationId, user._id);
    this.setData({ acting: false });

    if (!result.ok) {
      this.showToast(result.message || '操作失败');
      return undefined;
    }

    this.showToast('已通过，该会员可以录入成绩了', 'success');
    return this.refresh();
  },

  /* ---------- 驳回面板 ---------- */

  /** 打开驳回面板 */
  onOpenReject(event) {
    const applicationId = event.currentTarget.dataset.applicationId;
    if (!applicationId) return;

    this.setData({
      action: { open: true, applicationId, ...REJECT_TEXT },
      reason: '',
      actionError: '',
    });
  },

  onInputReason(event) {
    this.setData({ reason: event.detail.value, actionError: '' });
  },

  onCancelAction() {
    if (this.data.acting) return;
    this.setData({ action: { ...this.data.action, open: false }, reason: '', actionError: '' });
  },

  /**
   * 提交驳回。
   * 理由必填——没有理由的驳回，申请人问起来谁也说不清当初为什么被拒。
   * 校验放在这里而不是只靠后端：让用户在点下按钮的当下就看到问题。
   */
  async onSubmitAction() {
    if (this.data.acting) return undefined;

    const applicationId = this.data.action.applicationId;
    const reason = String(this.data.reason || '').trim();
    const user = this.currentUser();

    if (!reason) {
      this.setData({ actionError: '请填写驳回理由' });
      return undefined;
    }
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    this.setData({ acting: true, actionError: '' });
    const result = await rejectMember(applicationId, user._id, reason);
    this.setData({ acting: false });

    if (!result.ok) {
      this.setData({ actionError: result.message || '操作失败' });
      return undefined;
    }

    this.setData({ action: { ...this.data.action, open: false }, reason: '' });
    this.showToast('已驳回', 'success');
    return this.refresh();
  },

  /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
  noop() {},
});
