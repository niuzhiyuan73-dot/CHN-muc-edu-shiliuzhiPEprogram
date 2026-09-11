/**
 * 赛事详情
 * ============================================================
 * 一场赛事的全部动作都收在这一页：
 *   会员：报名 / 取消报名；
 *   管理：开始赛事 / 代签 / 进名次录入页。
 * 取数与权限判定全在 services/events-view.js，页面只做交互与 setData。
 *
 * 【为什么按钮由数据决定、不在这里判权限】
 * 视图模型已经把 canSignUp / canStart / canCheckIn / canFinish 算进每一行，
 * 页面照着渲染即可。页面里写 `user.role >= 1` 这种判断，Node 跑不了，
 * 等于没法测——与 announcement / season-manage 同一纪律。
 *
 * 【每次写操作后为什么整页重载】
 * 报名人数、签到状态、按钮可用性都会随之变化。局部改 setData 要维护
 * 一整套本地状态，越改越容易和真值分叉；重载一次数据都在内存里，很快。
 * ============================================================
 */

const { loadEventDetailView } = require('../../services/events-view.js');
const {
  signUpEvent,
  cancelSignupEvent,
  startEvent,
  checkInEvent,
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
    /** 开发期标注模拟数据 */
    isMock,
    /** 写操作进行中，防止连点 */
    acting: false,
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    this.eventId = (query && query.eventId) || '';
    return this.refresh();
  },

  /** 从名次录入页返回时刷新一次，刚录的名次才在页面上 */
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
   */
  confirm(content, title = '请确认') {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(true);
        return;
      }
      wx.showModal({
        title,
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
      const view = await loadEventDetailView(this.eventId, { user, isMock });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[event-detail] 赛事详情加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '赛事详情加载失败，请下拉重试' });
    }
  },

  /**
   * 写操作的统一收口：判登录 → 调接口 → 提示 → 整页刷新。
   * 接口只认登录会员的编号，页面递不出别人的身份。
   *
   * @param {(actorId:string) => Promise<Object>} write 写接口
   * @param {string} successText 成功后的提示
   * @returns {Promise<void>}
   */
  async runWrite(write, successText) {
    if (this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    this.setData({ acting: true });
    const result = await write(user._id);
    this.setData({ acting: false });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '操作失败');
      return undefined;
    }

    this.showToast(successText, 'success');
    return this.refresh();
  },

  /** 报名这一场 */
  onSignUp() {
    return this.runWrite((actorId) => signUpEvent(this.eventId, actorId), '报名成功');
  },

  /** 取消报名 */
  onCancelSignup() {
    return this.runWrite((actorId) => cancelSignupEvent(this.eventId, actorId), '已取消报名');
  },

  /** 开始赛事。报名会在这一刻截止，先确认一道 */
  async onStart() {
    const confirmed = await this.confirm('开始后报名就截止了，确定现在开始这场赛事吗？', '开始赛事');
    if (!confirmed) return undefined;
    return this.runWrite((actorId) => startEvent(this.eventId, actorId), '赛事已开始');
  },

  /** 代某位会员签到。只有干事以上能点，按钮与否由视图模型决定 */
  onCheckIn(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return undefined;
    return this.runWrite((actorId) => checkInEvent(this.eventId, userId, actorId), '已签到');
  },

  /** 进名次录入页 */
  onOpenPlacement() {
    wx.navigateTo({ url: `/pages/event-placement/event-placement?eventId=${this.eventId}` });
  },

  /** 点名单上的人，去看他的主页 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;

    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },
});
