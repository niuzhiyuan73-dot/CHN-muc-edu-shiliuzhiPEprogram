/**
 * 学院赛排阵（干事）
 * ============================================================
 * 双方学院各交一份「本大场每个小项谁上」。取数与整形在
 * services/college-view.js 的 loadCollegeLineupView，规则在
 * services/college-lineup.js（纯函数），页面只做交互与 setData。
 *
 * 【为什么默认值直接就是「已交 / 沿用上次」】
 * 干事多半只在上一场的基础上换一两个人。若每次进页面都从空白开始，
 * 双打两个人要靠记忆重选一遍，既慢又容易点错。所以视图模型把默认值
 * 备好（own → carried → empty），页面照单渲染即可；用户改完再交。
 *
 * 【为什么超过人数上限在页面就拦】
 * 数据层一定会兜底（validateLineup），但等他点提交才报「最多 2 人」，
 * 中间那几次多余的点选就白费了。这里一超限就退回并提示，改动立等可见。
 *
 * 【为什么未排满不给提交按钮一点就过】
 * D40：不排人不给提交。按钮不置灰，是怕用户不知道差在哪；点下去由
 * 数据层给出「第 N 场还没排满 X 名队员」，比灰按钮更容易纠正。
 * ============================================================
 */

const { loadCollegeLineupView } = require('../../services/college-view.js');
const { submitLineup } = require('../../services/index.js');

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
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 tieId / eventId
   */
  onLoad(query = {}) {
    this.tieId = query.tieId || '';
    this.eventId = query.eventId || '';
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
      const view = await loadCollegeLineupView(this.tieId, {
        user: this.currentUser(),
        eventId: this.eventId,
      });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[college-lineup] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '排阵页加载失败，请返回重试' });
    }
  },

  /* ---------- 选人 ---------- */

  /**
   * 某小项的选人变化。checkbox-group 给出的就是该小项全部已选项。
   * 超过需要人数时整次改动作废并提示，不做「自动挤掉最早那个」——
   * 那样用户会看到别人莫名消失，不如让他自己先取消。
   */
  onTogglePlayer(event) {
    const legNo = Number(event.currentTarget.dataset.legNo);
    const picked = Array.isArray(event.detail.value) ? [...event.detail.value] : [];

    const legs = this.data.view.legs || [];
    const leg = legs.find((item) => Number(item.legNo) === legNo);
    if (!leg) return;

    if (picked.length > leg.need) {
      this.showToast(`第 ${legNo} 场最多只能排 ${leg.need} 名队员`);
      // 把勾选状态还原成改动前：setData 一个等值副本，强制重渲染
      this.setData({ 'view.legs': legs.map((item) => ({ ...item, options: item.options.map((o) => ({ ...o })) })) });
      return;
    }

    const chosen = new Set(picked);
    const names = leg.options.filter((o) => chosen.has(o.memberId)).map((o) => o.name);

    this.setData({
      'view.legs': legs.map((item) => {
        if (Number(item.legNo) !== legNo) return item;
        return {
          ...item,
          options: item.options.map((o) => ({ ...o, checked: chosen.has(o.memberId) })),
          pickedText: names.length > 0 ? names.join('、') : '未排人',
        };
      }),
    });
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.submitting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再排阵');
      return undefined;
    }

    const view = this.data.view || {};
    const entries = (view.legs || []).map((leg) => ({
      legNo: leg.legNo,
      players: leg.options.filter((o) => o.checked).map((o) => o.memberId),
    }));

    this.setData({ submitting: true });
    const result = await submitLineup(
      { tieId: this.tieId, college: view.college, entries },
      user._id
    );
    this.setData({ submitting: false });

    if (!result.ok) {
      this.showToast(result.message || '提交失败');
      return undefined;
    }

    this.showToast('排阵已提交', 'success');
    // 留在本页刷新一次：用户可以立刻核对刚交的阵容，要换替补就在原地改
    return this.refresh();
  },

  onBack() {
    wx.navigateBack();
  },
});
