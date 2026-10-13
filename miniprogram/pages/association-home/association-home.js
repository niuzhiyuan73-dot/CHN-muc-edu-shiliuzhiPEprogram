/**
 * 协会工作台（单页工作台）
 * ============================================================
 * 这是「协会」页点进来之后的下一层：一个页面里装着原来排行榜 / 比赛 / 赛事
 * 三页的内容，靠顶部的三个页签切换。三个板块各自是独立的自定义组件
 * （components/rank-panel、match-panel、events-panel），数据互不干扰，
 * 原来那三页的逻辑与 WXML 原样搬了过去。
 *
 * 【当前协会从哪来】
 * 进来时带一个 association 查询参数（由「协会」页点按钮时写入），本页把它
 * 写回全局 association-scope——三个面板都按「全局当前协会」取数，写完就一致。
 * 若没带参数（例如首页「看全部赛事」直接跳进来），就用全局里已有的那个。
 *
 * 【为什么页签懒挂载】
 * 三个面板一次全挂上会同时取三份数据（比赛面板还会起实时比分的轮询）。
 * 这里只挂当前页签，其余等首次切过去再挂；挂过的保持挂载，来回切页签不丢状态。
 *
 * 【下拉刷新】
 * 工作台挂在 tabBar 之外的普通页上才能带参数，所以页面本身开
 * enablePullDownRefresh，再把下拉事件转给「当前页签」的面板。
 * ============================================================
 */

const { getAssociation, isKnownAssociation } = require('../../utils/associations.js');
const { applyBranding } = require('../../services/branding.js');
const scope = require('../../services/association-scope.js');

/** 页签定义。顺序即页面上的先后 */
const TAB_DEFS = [
  { tab: 'rank', label: '排行榜' },
  { tab: 'match', label: '比赛' },
  { tab: 'events', label: '赛事' },
];

/** 是否是合法的页签名 */
function isKnownTab(tab) {
  return TAB_DEFS.some((def) => def.tab === tab);
}

Page({
  data: {
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 当前协会 id 与显示名（如「民大匹克球」/「北航匹克球」） */
    associationId: '',
    associationName: '',
    associationGlyph: '',
    /** 顶部页签：[{ tab, label, active }] */
    tabs: TAB_DEFS.map((def) => ({ ...def, active: def.tab === 'rank' })),
    /** 当前页签 */
    activeTab: 'rank',
    /**
     * 哪些面板已经挂载过。默认只挂排行榜；切到别的页签时才挂上它，
     * 之后保持挂载——来回切页签不丢搜索词与滚动位置。
     */
    mounted: { rank: true, match: false, events: false },
  },

  /**
   * 进来先定「当前协会」：优先用查询参数，其次用全局已选中的。
   * 再按参数决定初始页签。三个面板会在自己 attached 时按全局协会取数。
   */
  onLoad(options = {}) {
    const requested = options.association;
    const id = isKnownAssociation(requested) ? requested : scope.getAssociation();
    try {
      scope.setAssociation(id);
    } catch (err) {
      console.error('[association-home] 切换协会失败', err);
    }

    const tab = isKnownTab(options.tab) ? options.tab : 'rank';
    const meta = this.resolveMeta(id);

    this.setData({
      associationId: id,
      associationName: meta.name,
      associationGlyph: meta.glyph,
      themeClass: `assoc-${id}`,
      activeTab: tab,
      tabs: TAB_DEFS.map((def) => ({ ...def, active: def.tab === tab })),
      mounted: { rank: tab === 'rank', match: tab === 'match', events: tab === 'events' },
    });
    this.paintNav();
  },

  onShow() {
    this.paintNav();
  },

  /**
   * 协会显示名。外校（北航）用演示名（带学校前缀），本校用注册表简称。
   * @param {string} id
   * @returns {{name: string, glyph: string}}
   */
  resolveMeta(id) {
    const session = require('../../services/school-session.js');
    const schoolId = session.getSchoolId();
    const demo = require('../../services/school-demo.js').schoolAssociations(schoolId);
    const found = demo && demo.find((item) => item.id === id);
    if (found) return { name: found.name, glyph: found.glyph };

    const assoc = getAssociation(id);
    return { name: assoc.shortName, glyph: assoc.logoGlyph };
  },

  /** 导航栏套当前协会的品牌色，标题用协会显示名 */
  paintNav() {
    applyBranding(this.data.associationId);
    if (typeof wx !== 'undefined' && typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title: this.data.associationName || '协会' });
    }
  },

  /** 切页签。首次切到某个页签时把它挂上 */
  onSwitchTab(event) {
    const { tab } = event.currentTarget.dataset;
    if (!isKnownTab(tab) || tab === this.data.activeTab) return undefined;

    this.setData({
      activeTab: tab,
      tabs: TAB_DEFS.map((def) => ({ ...def, active: def.tab === tab })),
      [`mounted.${tab}`]: true,
    });
  },

  /**
   * 下拉刷新转给当前页签的面板。面板未挂载或环境不支持 selectComponent 时静默跳过。
   */
  onPullDownRefresh() {
    const panel = typeof this.selectComponent === 'function'
      ? this.selectComponent(`#${this.data.activeTab}`)
      : null;
    if (panel && typeof panel.onPullDownRefresh === 'function') {
      return panel.onPullDownRefresh();
    }
    if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
    return undefined;
  },
});
