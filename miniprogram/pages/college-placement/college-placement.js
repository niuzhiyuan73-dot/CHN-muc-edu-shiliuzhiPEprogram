/**
 * 录入学院名次（M5-1）
 * ============================================================
 * 一场学院赛的最后一步：给参赛学院填名次，提交即结束赛事。
 * 取数与权限在 services/college-view.js 的 loadCollegePlacementView，
 * 名次校验在 services/college-event.js 的 validateCollegePlacements，
 * 页面只做交互与 setData。
 *
 * 【为什么行是学院不是人】
 * 学院赛的名次只记给学院（D26）：学院进签表、大场套小场，个人打得再好
 * 也不单独排名。所以候选来自已通过审核的名单里的学院，一行一所学院。
 *
 * 【为什么提交即结束】
 * 与个人赛同一道理：名次是学院赛的句号。让赛事停在「已有名次但未结束」
 * 的中间态，页面就说不清它算不算打完，所以录入与结束合成一个动作。
 *
 * 【为什么失败关闭】
 * 名次直接决定学院赛的名次展示；没有管理权时一条学院名单都不下发。
 * ============================================================
 */

const { loadCollegePlacementView } = require('../../services/college-view.js');
const { finishCollegeEvent, isMock } = require('../../services/index.js');

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

  /** 下拉刷新。会覆盖已填内容，只在用户明确下拉时触发 */
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
      const view = await loadCollegePlacementView(this.eventId, { user, isMock });
      this.setData({ loading: false, error: '', view, errorText: '' });
    } catch (err) {
      console.error('[college-placement] 名次页加载失败', err);
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
   * 把已填的名次收成 [{ college, placement }]。
   * 空着的学院不录入——它可能没到场，不该被硬塞一个名次。
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
      results.push({ college: row.college, placement });
    }

    if (results.length === 0) {
      return { error: '请至少给一所学院录入名次', results: [] };
    }
    return { error: '', results };
  },

  /** 提交名次并结束赛事 */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (!this.data.view.canSubmit) return undefined;

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
    const result = await finishCollegeEvent(this.eventId, collected.results, user._id);

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
