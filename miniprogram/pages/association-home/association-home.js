/**
 * 协会工作台（单页工作台）
 * ============================================================
 * 这是「协会」页点进来之后的下一层：一个页面里装着协会空间 / 排行榜 / 比赛 /
 * 赛事四块内容，靠顶部的四个页签切换。每块各自是独立的自定义组件
 * （components/association-space-panel、rank-panel、match-panel、events-panel），
 * 数据互不干扰；后三块是把原来那三页的逻辑与 WXML 原样搬了过来，协会空间是本阶段
 * 新落的（见规划 §12）。
 *
 * 【当前协会从哪来】
 * 进来时带一个 association 查询参数（由「协会」页点按钮时写入），本页把它
 * 写回全局 association-scope——各面板都按「全局当前协会」取数，写完就一致。
 * 若没带参数（例如首页「看全部赛事」直接跳进来），就用全局里已有的那个。
 *
 * 【为什么页签懒挂载】
 * 各面板一次全挂上会同时取多份数据（比赛面板还会起实时比分的轮询）。
 * 这里只挂当前页签，其余等首次切过去再挂；挂过的保持挂载，来回切页签不丢状态。
 *
 * 【下拉刷新】
 * 工作台挂在 tabBar 之外的普通页上才能带参数，所以页面本身开
 * enablePullDownRefresh，再把下拉事件转给「当前页签」的面板。
 * ============================================================
 */

const {
  getAssociation, isKnownAssociation, workbenchTabsOf,
} = require('../../utils/associations.js');
const { applyBranding } = require('../../services/branding.js');
const scope = require('../../services/association-scope.js');

/**
 * 页签不再写死。球拍运动是「协会空间 / 排行榜 / 比赛 / 赛事」，
 * 团队运动（篮球）是「协会空间 / 组队 / 赛事」——由注册表的 capabilities
 * 生成，见 utils/associations.js 的 workbenchTabsOf。
 */
/** 进入工作台的默认页签（每个协会的第一个页签都是协会空间） */
const DEFAULT_TAB = 'space';

/** 是否是合法的页签名（按当前协会可用的页签判断） */
function isKnownTab(tabs, tab) {
  return (Array.isArray(tabs) ? tabs : []).some((def) => def.tab === tab);
}

Page({
  data: {
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 当前协会 id 与显示名（如「民大匹克球」/「北航匹克球」） */
    associationId: '',
    associationName: '',
    associationGlyph: '',
    /** 协会运动图标（白色 PNG）；为空时名头退回文字徽标 */
    associationIcon: '',
    /** 顶部页签：[{ tab, label, active }]，按当前协会的能力生成 */
    tabs: [],
    /** 当前页签 */
    activeTab: DEFAULT_TAB,
    /**
     * 哪些面板已经挂载过。默认只挂协会空间；切到别的页签时才挂上它，
     * 之后保持挂载——来回切页签不丢搜索词与滚动位置。
     */
    mounted: { space: true, rank: false, match: false, events: false },
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

    const meta = this.resolveMeta(id);
    // 页签按协会能力生成：团队运动没有排行榜与个人比赛入口，多一个「组队」。
    const definitions = workbenchTabsOf(id);
    // 旧链接可能带着当前协会不再提供的页签（如切到篮球后的 tab=match），
    // 按第一个可用页签落地，不白屏也不报错。
    const active = isKnownTab(definitions, options.tab)
      ? options.tab
      : (definitions[0] || { tab: DEFAULT_TAB }).tab;
    const mounted = {};
    definitions.forEach((def) => { mounted[def.tab] = def.tab === active; });

    this.setData({
      associationId: id,
      associationName: meta.name,
      associationGlyph: meta.glyph,
      associationIcon: meta.icon,
      themeClass: `assoc-${id}`,
      activeTab: active,
      tabs: definitions.map((def) => ({ ...def, active: def.tab === active })),
      mounted,
    });
    this.paintNav();
  },

  onShow() {
    this.paintNav();
  },

  /**
   * 协会显示名。外校（北航）用演示名（带学校前缀），本校用注册表简称。
   * 演示协会沿用注册表 id，图标同源；未知 id 回退空串（wxml 退回文字徽标）。
   * @param {string} id
   * @returns {{name: string, glyph: string, icon: string}}
   */
  resolveMeta(id) {
    const session = require('../../services/school-session.js');
    const schoolId = session.getSchoolId();
    const demo = require('../../services/school-demo.js').schoolAssociations(schoolId);
    const found = demo && demo.find((item) => item.id === id);
    const icon = this.iconOf(id);
    if (found) return { name: found.name, glyph: found.glyph, icon };

    const assoc = getAssociation(id);
    return { name: assoc.shortName, glyph: assoc.logoGlyph, icon };
  },

  /**
   * 协会的运动图标路径（注册表 logoIcon）。
   * @param {string} id
   * @returns {string}
   */
  iconOf(id) {
    try {
      return getAssociation(id).logoIcon || '';
    } catch (err) {
      return '';
    }
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
    if (!isKnownTab(this.data.tabs, tab) || tab === this.data.activeTab) return undefined;

    this.setData({
      activeTab: tab,
      tabs: this.data.tabs.map((def) => ({ ...def, active: def.tab === tab })),
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
