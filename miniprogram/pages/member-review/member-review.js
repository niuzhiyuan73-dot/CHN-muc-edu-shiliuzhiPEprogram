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
 * 【通过为什么也要过一次面板】
 * 通过本是「资料对得上」，但审核时还可以顺手指定这位新会员的初始等级分
 * ——老队员、外校交流生这类人不必再从初始分慢慢打上来。面板里留一个选填
 * 数字框，不填就直接通过、由回放引擎按前五场自动定级。顺带这也兑现了
 * 「通过不可逆，先确认一句」这件事：以前点一下就直接批了。
 *
 * 【驳回为什么必须填理由】
 * 资料有问题，必须留下问题是什么，否则申请人问起来谁也说不清当初为什么
 * 被拒。所以驳回同样走面板，但理由必填。
 *
 * 【onShow 为什么要带守卫】
 * onLoad 之后紧接着就会来一次 onShow。若不加 this.loaded 判断，首屏会
 * 白算两遍。带守卫又必须保留 onShow——从登录页 navigateBack 回来时
 * 登录态可能变了，不刷新就会拿着旧权限渲染。
 * ============================================================
 */

const { loadMemberReviewView } = require('../../services/member-review-view.js');
const { validateInitialElo, INITIAL_ELO_MIN, INITIAL_ELO_MAX } = require('../../services/member-review.js');
const { approveMember, rejectMember, isMock } = require('../../services/index.js');
const { currentThemeClass } = require('../../services/branding.js');

/** 通过面板的文案。初始分是选填项 */
const APPROVE_TEXT = {
  title: '通过这条入会申请',
  hint: `可为 TA 指定初始等级分（${INITIAL_ELO_MIN}–${INITIAL_ELO_MAX} 的整数）；留空则按前五场对手自动定级。`,
  placeholder: '选填，例如 1500',
};

/** 驳回面板的文案。理由必填 */
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
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 切标签时给个淡淡的反馈，避免点了没反应 */
    switching: false,
    /** 视图模型，形状见 services/member-review-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 审核面板。mode 取 'approve' / 'reject'，决定面板里是数字框还是理由框 */
    action: { open: false, mode: '', applicationId: '', title: '', hint: '', placeholder: '' },
    /** 驳回面板里填的理由 */
    reason: '',
    /** 通过面板里填的初始等级分（字符串，选填） */
    rating: '',
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
      this.setData({ loading: false, error: '', switching: false, view, themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[member-review] 会员审核页加载失败', err);
      this.loaded = true;
      this.setData({
        loading: false,
        switching: false,
        error: '入会申请加载失败，请下拉重试',
        themeClass: currentThemeClass(),
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

  /* ---------- 通过 / 驳回面板 ---------- */

  /**
   * 打开通过面板。
   * 通过不可逆（批了就离开待审列表），所以先弹面板确认一句；面板里还留了
   * 一个选填的初始等级分输入框。
   */
  onOpenApprove(event) {
    const applicationId = event.currentTarget.dataset.applicationId;
    if (!applicationId) return;

    this.setData({
      action: { open: true, mode: 'approve', applicationId, ...APPROVE_TEXT },
      rating: '',
      actionError: '',
    });
  },

  /** 打开驳回面板 */
  onOpenReject(event) {
    const applicationId = event.currentTarget.dataset.applicationId;
    if (!applicationId) return;

    this.setData({
      action: { open: true, mode: 'reject', applicationId, ...REJECT_TEXT },
      reason: '',
      actionError: '',
    });
  },

  onInputReason(event) {
    this.setData({ reason: event.detail.value, actionError: '' });
  },

  onInputRating(event) {
    this.setData({ rating: event.detail.value, actionError: '' });
  },

  /** 关闭面板并清空两个输入框，取消与提交成功共用 */
  closeAction() {
    this.setData({
      action: { ...this.data.action, open: false },
      reason: '',
      rating: '',
      actionError: '',
    });
  },

  onCancelAction() {
    if (this.data.acting) return;
    this.closeAction();
  },

  /**
   * 提交面板里的操作，通过 / 驳回按 mode 分流。
   *
   * 校验都放在页面这一层（驳回理由必填、初始分格式），让用户点下按钮的
   * 当下就看到问题，而不是等一个来回。后端仍会各自再校验一遍。
   */
  async onSubmitAction() {
    if (this.data.acting) return undefined;

    const { mode, applicationId } = this.data.action;
    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    if (mode === 'reject') return this.submitReject(applicationId, user);
    if (mode === 'approve') return this.submitApprove(applicationId, user);
    return undefined;
  },

  /** 提交驳回。理由必填——没有理由的驳回事后说不清 */
  async submitReject(applicationId, user) {
    const reason = String(this.data.reason || '').trim();
    if (!reason) {
      this.setData({ actionError: '请填写驳回理由' });
      return undefined;
    }

    this.setData({ acting: true, actionError: '' });
    const result = await rejectMember(applicationId, user._id, reason);
    this.setData({ acting: false });

    if (!result.ok) {
      this.setData({ actionError: result.message || '操作失败' });
      return undefined;
    }

    this.closeAction();
    this.showToast('已驳回', 'success');
    return this.refresh();
  },

  /** 提交通过。初始分选填，填了先过一遍本地校验 */
  async submitApprove(applicationId, user) {
    const check = validateInitialElo(String(this.data.rating || '').trim());
    if (!check.ok) {
      this.setData({ actionError: check.message });
      return undefined;
    }

    this.setData({ acting: true, actionError: '' });
    const result = await approveMember(applicationId, user._id, check.value);
    this.setData({ acting: false });

    if (!result.ok) {
      this.setData({ actionError: result.message || '操作失败' });
      return undefined;
    }

    this.closeAction();
    this.showToast('已通过，该会员可以录入成绩了', 'success');
    return this.refresh();
  },

  /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
  noop() {},
});
