/**
 * 录入名次
 * ============================================================
 * 一场赛事的最后一步：给参赛者填名次，提交即结束赛事。
 * 取数与权限判定在 services/events-view.js，名次校验在 services/event.js，
 * 页面只做交互与 setData。
 *
 * 【为什么名次录入与签到不在一页】
 * 签到在赛事当天做，人来一个点一个，要的是快；名次在赛后做，要对着成绩
 * 仔细填，还要判「打三四名」的名次成不成对。两件事的节奏与风险都不同，
 * 分开两页，各自把事情说清楚。
 *
 * 【为什么提交即结束】
 * 名次是积分的唯一依据（决策 9）。让赛事停在「已有名次但未结束」的中间态，
 * 积分就不知道该不该算，会出现「名次录了、榜上却没分」的怪象。所以录入
 * 与结束合成一个动作，落库那一刻名次与积分同时定下来。
 *
 * 【没有管理权为什么不让进】
 * 名次直接换成积分，一个错字就凭空多出一位参赛者。所以失败关闭：
 * 没有管理权时一条名单都不下发。
 * ============================================================
 */

const { loadEventPlacementView } = require('../../services/events-view.js');
const { finishEvent, isMock } = require('../../services/index.js');

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
    /** 提交中，防止连点 */
    submitting: false,
    /** 整体错误提示 */
    errorText: '',
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    this.eventId = (query && query.eventId) || '';
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
   * 会覆盖已填的名次——所以只在下拉刷新与首次进入时调用。
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();

    try {
      const view = await loadEventPlacementView(this.eventId, { user, isMock });
      this.setData({ loading: false, error: '', view, errorText: '' });
    } catch (err) {
      console.error('[event-placement] 名次页加载失败', err);
      this.setData({ loading: false, error: '名次录入页加载失败，请下拉重试' });
    }
  },

  /**
   * 改写某一行已填的名次。
   * 整块重写 rows 而不是用 rows[0].x 这样的路径键：路径键的写法在测试环境
   * 里跑不通，而整块替换两边行为一致。
   */
  onInputPlacement(event) {
    const index = Number(event.currentTarget.dataset.index);
    const rows = (this.data.view.rows || []).slice();
    if (!rows[index]) return;

    rows[index] = { ...rows[index], placementText: event.detail.value };
    this.setData({ view: { ...this.data.view, rows }, errorText: '' });
  },

  /**
   * 把已填的名次收成 [{ userId, placement }]。
   * 空着的人不录入——他可能报了名却没到场，不该被硬塞一个名次。
   *
   * 【双打为什么一行摊成两条】
   * 名次页在双打下按队伍给行（一人填一次就够），但名次最终要记在每个人
   * 头上（两人的名次相同），后续积分才按人结算。所以这里把一行的名次
   * 摊到该队两名成员，页面看到的是一行，落库的是两条。
   *
   * @returns {{error:string, results:Array<Object>}}
   */
  collectResults() {
    const rows = (this.data.view && this.data.view.rows) || [];
    const results = [];

    for (const row of rows) {
      const raw = row.placementText;
      const text = raw === null || raw === undefined ? '' : String(raw).trim();
      if (!text) continue;

      const placement = Number(text);
      if (!Number.isInteger(placement) || placement < 1) {
        return { error: '名次必须是不小于 1 的整数', results: [] };
      }
      // 单打的行只有 userId；双打的行带 userIds（两人），逐人落下同名次
      const members =
        Array.isArray(row.userIds) && row.userIds.length > 0 ? row.userIds : [row.userId];
      for (const userId of members) {
        results.push({ userId, placement });
      }
    }

    if (results.length === 0) {
      return { error: '请至少给一位参赛者录入名次', results: [] };
    }
    return { error: '', results };
  },

  /** 提交名次并结束赛事 */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (!this.data.view.canEdit) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再录入名次');
      return undefined;
    }

    const collected = this.collectResults();
    if (collected.error) {
      this.setData({ errorText: collected.error });
      return undefined;
    }

    this.setData({ submitting: true, errorText: '' });
    const result = await finishEvent(this.eventId, collected.results, user._id);

    if (!result || !result.ok) {
      this.setData({
        submitting: false,
        errorText: (result && (result.firstError || result.message)) || '录入失败',
      });
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('名次已录入，赛事结束', 'success');
    wx.navigateBack();
    return undefined;
  },

  /** 放弃录入，回详情页 */
  onCancel() {
    wx.navigateBack();
  },
});
