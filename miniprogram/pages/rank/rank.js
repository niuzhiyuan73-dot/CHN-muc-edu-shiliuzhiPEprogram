/**
 * 排行榜
 * ============================================================
 * 页面只做三件事：渲染、切项目/切榜、点人跳转。
 * 取数与整形全在 services/rank-view.js 里，那边可以脱离 wx 测试。
 *
 * 【两个切换维度】
 *   项目：男单 / 女单 / 双打  —— 男单榜与女单榜取自同一个单打池，分数可比
 *   榜单：等级分榜 / 进步榜    —— 因为等级分是零和的，「进步」得另立一把尺子
 * 两者是正交的，可以自由组合，所以状态各自记一个，互不影响。
 * ============================================================
 */

const { loadRankView, describeSearch } = require('../../services/rank-view.js');
const { isMock } = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 切换项目/榜单时给个淡淡的反馈 */
    switching: false,
    // 视图模型，形状见 services/rank-view.js。
    // 初值给空对象而不是 null，WXML 里的 {{view.xxx}} 才不会报错。
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock,

    // ---------- 按名字筛选 ----------
    // 完整榜单留在 this.view 里，页面上只渲染筛选后的结果。这样每敲一个字
    // 都只是本地过一遍数组，不必重新拉数据——搜索框打字不该卡。
    /** 当前搜索词 */
    keyword: '',
    /** 正在显示的榜单行（已筛选） */
    rows: [],
    /** 是否处于搜索状态，用来切换文案口径 */
    searching: false,
    /** 榜单右上角的计数文案 */
    playerCountText: '',
    /** 筛选后一行都没有 */
    empty: false,
    /** 一行都没有时给的原因，可能是「没人打过」也可能是「搜不到」 */
    emptyNote: '',
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心 onLoad 的返回值，
   * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    return this.refresh();
  },

  /** 下拉刷新：数据都在内存里，重算一遍很快 */
  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadRankView({
        project: this.currentProject,
        board: this.currentBoard,
      });
      // 完整榜单另存一份。它不参与渲染，只当筛选的数据源，
      // 所以不用塞进 data——省一次 setData 的开销。
      this.view = view;
      this.setData({ loading: false, error: '', switching: false, view });
      // 切项目/榜单时保留搜索词：搜姓「张」的人，切到女单榜也该还是「张」
      this.applyKeyword(this.data.keyword);
    } catch (err) {
      console.error('[rank] 加载失败', err);
      this.setData({
        loading: false,
        switching: false,
        error: '排行榜加载失败，请下拉重试',
      });
    }
  },

  /**
   * 按搜索词重算页面要显示的榜单与文案。
   * 纯本地计算，不碰数据源，所以能跟着每一次输入即时调用。
   *
   * @param {string} keyword
   */
  applyKeyword(keyword) {
    const search = describeSearch((this.view && this.view.rows) || [], keyword);
    this.setData({
      keyword: search.keyword,
      rows: search.rows,
      searching: search.searching,
      playerCountText: search.countText,
      empty: search.empty,
      emptyNote: search.emptyNote,
    });
  },

  /** 搜索框输入 */
  onInputKeyword(event) {
    this.applyKeyword(event.detail.value);
  },

  /** 清空搜索。清空后回到完整榜单 */
  onClearKeyword() {
    this.applyKeyword('');
  },

  /** 切换项目 */
  onSwitchProject(event) {
    const { project } = event.currentTarget.dataset;
    if (!project || project === this.data.view.activeProject || this.data.switching) {
      return undefined;
    }

    this.currentProject = project;
    this.setData({ switching: true });
    return this.refresh();
  },

  /** 切换榜单类型 */
  onSwitchBoard(event) {
    const { board } = event.currentTarget.dataset;
    if (!board || board === this.data.view.activeBoard || this.data.switching) return undefined;

    this.currentBoard = board;
    this.setData({ switching: true });
    return this.refresh();
  },

  /**
   * 点榜上的任何一行，去看这个人的完整战绩。
   * 这里不排除「我自己」——从榜单进自己主页看曲线，是很自然的动作。
   */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;

    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },
});
