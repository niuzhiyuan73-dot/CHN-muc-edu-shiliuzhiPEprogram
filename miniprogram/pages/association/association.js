/**
 * 协会（tabBar 的第 2 个页签）
 * ============================================================
 * 中间三个页签（排行榜 / 比赛 / 赛事）收进「协会工作台」之后，这里替代它们
 * 占据 tabBar：列出当前学校有哪些协会，每个协会一个按钮，点进去进入工作台，
 * 在工作台里再按「排行榜 / 比赛 / 赛事」切换。
 *
 * 【为什么是「当前学校」的协会】
 * 学校维度在首页切换，结果存进 school-session。本页跟着它走：本校（民大）
 * 列注册表里的协会，外校（北航）列它的演示协会——名称各自带学校前缀
 * （民大匹克球 / 北航匹克球），一眼看得出在逛哪所学校。
 *
 * 【为什么点了要先写全局协会再跳】
 * 工作台的面板（排行榜 / 比赛 / 赛事）一律按「全局当前协会」取数。这里先把
 * 选中的协会写进 association-scope，再 navigateTo 工作台，面板自然取到的是
 * 这个协会的内容——不必给工作台再传一套「当前协会」的状态。
 * ============================================================
 */

const { activeAssociations } = require('../../utils/associations.js');
const { resetBranding } = require('../../services/branding.js');
const facade = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 页面根节点主题类。本页跨协会，固定用中性外观 */
    themeClass: 'assoc-neutral',
    /** 当前浏览的学校简称，供只读提示条显示 */
    schoolName: '',
    /** 是否在浏览外校（只读）。true 时提示条说明内容是演示 */
    readOnlySchool: false,
    /** 协会清单：[{ id, name, glyph, sportName, active }] */
    associations: [],
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心返回值，
   * 但测试需要一个句柄等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    return this.refresh();
  },

  onShow() {
    this.paintNav();
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 本页跨协会，导航栏套中性品牌，标题固定为「协会」 */
  paintNav() {
    resetBranding();
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title: '协会' });
    }
  },

  /** 当前全局协会。真机上由 app 持有，测试环境下回落到门面 */
  currentAssociation() {
    const app = getApp();
    if (app && typeof app.getAssociation === 'function') return app.getAssociation();
    return facade.getAssociation();
  },

  /** 切全局协会：优先走 app（它把结果同步进 globalData），否则直接改门面 */
  setAssociation(id) {
    const app = getApp();
    if (app && typeof app.setAssociation === 'function') return app.setAssociation(id);
    return facade.setAssociation(id);
  },

  /**
   * 装载协会清单。本校取注册表，外校取演示协会；当前全局协会标为 active。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const session = require('../../services/school-session.js');
      const schoolId = session.getSchoolId();
      const currentId = this.currentAssociation();

      const demo = facade.isMockNow()
        ? require('../../services/school-demo.js').schoolAssociations(schoolId)
        : null;
      const base = demo || activeAssociations().map((assoc) => ({
        id: assoc.id,
        name: assoc.shortName,
        glyph: assoc.logoGlyph,
        sportName: assoc.sportName,
      }));

      // 演示学校的简称用于只读提示；本校没有演示，就留空
      const schoolName = demo
        ? require('../../services/school-demo.js').schoolShortName(schoolId)
        : '';

      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        readOnlySchool: session.isReadOnly(),
        schoolName,
        associations: base.map((assoc) => ({ ...assoc, active: assoc.id === currentId })),
      });
    } catch (err) {
      console.error('[association] 协会清单加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '协会列表加载失败，请下拉重试' });
    }
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /** 点某个协会：先写全局当前协会，再进它的工作台（默认落在排行榜页签） */
  onChooseAssociation(event) {
    const id = event.currentTarget.dataset.association;
    if (!id) return undefined;
    try {
      this.setAssociation(id);
    } catch (err) {
      console.error('[association] 切换协会失败', err);
    }
    wx.navigateTo({
      url: `/pages/association-home/association-home?association=${id}&tab=rank`,
    });
  },
});
