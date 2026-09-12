/**
 * 学院赛小场录分
 * ============================================================
 * 一场小场就是「某个大场里的第 N 项」。对阵、赛制、上场人都已由排阵锁定，
 * 本页只收一组局分，再按对手确认（M4-2）生效；管理员还可在这里记弃权（M4-7）。
 * 取数与整形在 services/college-view.js 的 loadCollegeMatchView，页面只做
 * 交互与 setData。
 *
 * 【为什么赛制写死 11 分制一局一胜】
 * COLLEGE_LEG_FORMAT 定的就是学院赛小场的赛制，不允许现场改——若这里能改，
 * 同一届学院赛的小场就会按不同分制计净胜，大场汇总失去可比性。
 *
 * 【为什么确认按钮要等录完分】
 * 抽签生成的小场没有比分、也没有胜方。没有胜方就确认，回放读到一个空 win
 * 会直接崩（见 match-record.needsScore）。所以只有录出胜方后才给确认入口。
 *
 * 【弃权为什么按学院点，而不是选「谁赢」】
 * 弃权改变的是大场走向：弃权方丢掉这一小项，对手拿分。让管理员直接选「谁赢」
 * 容易把弃权与胜场混为一谈，所以入口写成「XX 学院弃权」，胜方由数据层推。
 * ============================================================
 */

const { loadCollegeMatchView } = require('../../services/college-view.js');
const {
  submitMatch,
  confirmMatch,
  recordForfeit,
  revokeMatch,
} = require('../../services/index.js');
const { winnerOf, toScoreRows } = require('../../services/match-entry-view.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 正在处理的按钮标识，防止连点 */
    acting: '',
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 比分输入行 */
    scoreRows: [],
    /** 实时推出来的胜方文案 */
    winnerText: '',
    /** 待提交的比分 */
    form: { scoreA: [''], scoreB: [''] },
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 matchId
   */
  onLoad(query = {}) {
    this.matchId = query.matchId || '';
    return this.refresh();
  },

  /** 从详情页返回时刷新一次，刚录的分与刚确认的结果才在页面上 */
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
   * 装载整页数据，并把记录里已有的比分回填到输入框。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadCollegeMatchView(this.matchId, { user: this.currentUser() });
      // 赛制行数由视图模型定（bestOf），旧的比分按行对齐，缺的补空串
      const bestOf = view.bestOf || 1;
      const scoreA = [];
      const scoreB = [];
      for (let i = 0; i < bestOf; i += 1) {
        scoreA.push(view.scoreA[i] === undefined || view.scoreA[i] === null ? '' : view.scoreA[i]);
        scoreB.push(view.scoreB[i] === undefined || view.scoreB[i] === null ? '' : view.scoreB[i]);
      }
      this.loaded = true;
      this.setData({ loading: false, error: '', view, form: { scoreA, scoreB } }, () =>
        this.applyScores()
      );
    } catch (err) {
      console.error('[college-match] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '小场录分页加载失败，请返回重试' });
    }
  },

  /** 按当前比分推胜方并刷新展示。比分一变就要走这里 */
  applyScores() {
    const { scoreA, scoreB } = this.data.form;
    const { gamePoints, bestOf, collegeA, collegeB } = this.data.view || {};
    const winner = winnerOf(scoreA, scoreB, gamePoints, bestOf);
    const winnerText =
      winner === 'A' ? `${collegeA || 'A 队'} 胜` : winner === 'B' ? `${collegeB || 'B 队'} 胜` : '';
    this.setData({ scoreRows: toScoreRows(scoreA, scoreB), winnerText });
  },

  /* ---------- 录分 ---------- */

  onInputScore(event) {
    const { side, slot } = event.currentTarget.dataset;
    const key = side === 'A' ? 'scoreA' : 'scoreB';
    const scores = [...this.data.form[key]];
    scores[Number(slot)] = event.detail.value;

    this.setData({ form: { ...this.data.form, [key]: scores } }, () => this.applyScores());
  },

  async onSubmit() {
    if (this.data.submitting || !this.data.view.canRecord) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再录入成绩');
      return undefined;
    }

    const { scoreA, scoreB } = this.data.form;
    this.setData({ submitting: true });
    const result = await submitMatch({
      id: this.matchId,
      scoreA,
      scoreB,
      actor: user._id,
    });
    this.setData({ submitting: false });

    if (!result.ok) {
      this.showToast(result.firstError || (result.scoreErrors || [])[0] || '提交失败');
      return undefined;
    }

    this.showToast('已录入，等待对手确认', 'success');
    return this.refresh();
  },

  /* ---------- 确认 / 撤销 ---------- */

  async onConfirm() {
    if (this.data.acting || !this.data.view.canConfirm) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再确认');
      return undefined;
    }

    this.setData({ acting: 'confirm' });
    const result = await confirmMatch(this.matchId, user._id);
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '确认失败');
      return undefined;
    }

    this.showToast('已确认，成绩已生效', 'success');
    return this.refresh();
  },

  async onRevoke() {
    if (this.data.acting || !this.data.view.canRevoke) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再撤销');
      return undefined;
    }
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '撤销这场比赛',
        content: '撤销后成绩作废，个人等级分随之回滚。确定撤销吗？',
        success: (res) => resolve(Boolean(res && res.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return undefined;

    this.setData({ acting: 'revoke' });
    const result = await revokeMatch(this.matchId, user._id, '学院赛小场撤销');
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '撤销失败');
      return undefined;
    }

    this.showToast('已撤销', 'success');
    return this.refresh();
  },

  /* ---------- 弃权（管理员） ---------- */

  async onForfeit(event) {
    const college = event.currentTarget.dataset.college;
    if (!college || this.data.acting || !this.data.view.canForfeit) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再记录弃权');
      return undefined;
    }
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '记录弃权',
        content: `确认由「${college}」弃权？对手将直接拿到这一小项，且不计个人等级分。`,
        success: (res) => resolve(Boolean(res && res.confirm)),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return undefined;

    this.setData({ acting: 'forfeit' });
    const result = await recordForfeit(this.data.view.tieId, this.data.view.legNo, college, user._id);
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '记录弃权失败');
      return undefined;
    }

    this.showToast('已记录弃权', 'success');
    return this.refresh();
  },

  onBack() {
    wx.navigateBack();
  },
});
