/**
 * 比赛页
 * ============================================================
 * 三件事：看比赛台账、确认对手录入的比分、撤销（或驳回）一场。
 * 取数与权限判定全在 services/match-view.js，页面只做渲染与交互
 * ——那一层不碰 wx API，因而权限规则能在 Node 里逐条测。
 *
 * 【登录态由页面传进去，不让数据源自己猜】
 * mock 数据源永远认为当前用户是 u06。若让视图模型自己去问，
 * 一个没登录的访客也会被当成 u06，凭空拿到确认与撤销的权限。
 * 所以这里把 getApp() 里的登录态明确传下去，传 null 就是访客。
 *
 * 【为什么不用 wx.showModal】
 * 撤销要填理由，而 showModal 的 editable 版本只能收一行文本、
 * 也没法做「不填不给提交」的校验；驳回与撤销的文案还不一样。
 * 与其和模态框的脾气较劲，不如在页面内做一块面板，行为完全可控。
 *
 * 【onShow 为什么要带守卫】
 * onLoad 之后紧接着就会来一次 onShow。若不加 this.loaded 判断，
 * 首屏会白算两遍。而带守卫又必须保留 onShow——从录入页 navigateBack
 * 回来时 onLoad 不会再触发，不刷新就看不到刚提交的那一场。
 * ============================================================
 */

const { loadMatchView } = require('../../services/match-view.js');
const { resolveAuthState } = require('../../services/auth.js');
const { confirmMatch, rejectMatch, revokeMatch, isMock } = require('../../services/index.js');

/** 撤销与驳回的面板文案。两者的终态相同，但要说清楚各自是干什么的 */
const ACTION_TEXT = {
  reject: {
    title: '驳回这场比分',
    hint: '驳回后这场成绩作废，不会计入等级分。请说明哪里不对。',
    placeholder: '例如：第二局比分录反了',
  },
  revoke: {
    title: '撤销这场比分',
    hint: '撤销后这场成绩作废，等级分与积分会立刻回滚。',
    placeholder: '例如：这局其实没打完',
  },
};

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 切标签时给个淡淡的反馈，避免点了没反应 */
    switching: false,
    /** 视图模型，形状见 services/match-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /** 当前登录态（能否录入取决于 auth.canRecord） */
    auth: { loggedIn: false },
    /** 录入按钮上方的说明。不能录入时，把原因写在这里 */
    entryHint: '',
    /** 开发期标注模拟数据 */
    isMock,
    /** 撤销 / 驳回面板 */
    action: { open: false, matchId: '', kind: 'revoke', title: '', hint: '', placeholder: '' },
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

  /** 从录入页返回时刷新一次，刚提交的比赛才能立刻出现在待确认里 */
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
    const auth = resolveAuthState(user);

    try {
      const view = await loadMatchView({ user, tab: this.currentTab });

      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        switching: false,
        view,
        auth,
        entryHint: this.describeEntry(auth),
      });
    } catch (err) {
      console.error('[match] 比赛页加载失败', err);
      this.loaded = true;
      this.setData({
        loading: false,
        switching: false,
        error: '比赛数据加载失败，请下拉重试',
      });
    }
  },

  /**
   * 录入按钮上方的说明。
   * 三种情况各说各的：能录、登录了但不能录（待审核 / 被禁用）、没登录。
   * 比笼统写一句「暂不可录入」有用得多。
   */
  describeEntry(auth) {
    if (auth.canRecord) return '打完了？把比分记下来，对手确认后计入等级分';
    if (auth.loggedIn) return auth.notice || '当前账号暂时不能录入成绩';
    return '登录后才能录入比赛成绩';
  },

  /* ---------- 标签与入口 ---------- */

  /** 切换标签（全部 / 我参与的 / 待确认） */
  onSwitchTab(event) {
    const { tab } = event.currentTarget.dataset;
    if (!tab || tab === this.data.view.activeTab || this.data.switching) return undefined;

    this.currentTab = tab;
    this.setData({ switching: true });
    return this.refresh();
  },

  /**
   * 去录入页。
   * 未登录、或账号还在待审核，都不该进录入页——那里需要选中自己当选手，
   * 没有身份就没法录。宁可在这里拦住并说清楚原因，也不要进去之后报错。
   */
  onGoEntry() {
    const auth = this.data.auth;
    if (!auth.loggedIn) {
      this.showToast('请先登录后再录入成绩');
      return;
    }
    if (!auth.canRecord) {
      this.showToast(auth.notice || '当前账号暂时不能录入成绩');
      return;
    }

    wx.navigateTo({ url: '/pages/match-entry/match-entry' });
  },

  /** 点队名去看这位会员的主页 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;
    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },

  /* ---------- 确认 ---------- */

  /** 确认对手录入的比分，成绩随即计入等级分 */
  async onConfirm(event) {
    const matchId = event.currentTarget.dataset.matchId;
    const user = this.currentUser();
    if (!matchId) return undefined;
    if (!user) {
      this.showToast('请先登录后再确认比分');
      return undefined;
    }

    const result = await confirmMatch(matchId, user._id);
    if (!result.ok) {
      this.showToast(result.message || '确认失败');
      return undefined;
    }

    this.showToast('已确认，成绩已计入等级分', 'success');
    return this.refresh();
  },

  /* ---------- 撤销 / 驳回面板 ---------- */

  /** 打开面板。撤销与驳回共用一块，只是文案不同 */
  onOpenAction(event) {
    const { matchId, kind } = event.currentTarget.dataset;
    const text = ACTION_TEXT[kind];
    if (!matchId || !text) return;

    this.setData({
      action: { open: true, matchId, kind, ...text },
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
   * 提交撤销 / 驳回。
   * 理由必填——没有理由的作废记录，事后谁也说不清当初为什么撤。
   * 校验放在这里而不是只靠后端：让用户在点下按钮的当下就看到问题。
   */
  async onSubmitAction() {
    if (this.data.acting) return undefined;

    const { matchId, kind } = this.data.action;
    const reason = String(this.data.reason || '').trim();
    const user = this.currentUser();

    if (!reason) {
      this.setData({ actionError: '请填写理由' });
      return undefined;
    }
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    this.setData({ acting: true, actionError: '' });
    const result =
      kind === 'reject'
        ? await rejectMatch(matchId, user._id, reason)
        : await revokeMatch(matchId, user._id, reason);
    this.setData({ acting: false });

    if (!result.ok) {
      this.setData({ actionError: result.message || '操作失败' });
      return undefined;
    }

    this.setData({ action: { ...this.data.action, open: false }, reason: '' });
    this.showToast(kind === 'reject' ? '已驳回' : '已撤销，分数已回滚', 'success');
    return this.refresh();
  },

  /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
  noop() {},
});
