/**
 * 公告页的视图模型（学校维度 / 协议 2）
 * ============================================================
 * 两个装载器，对应两种页面：
 *   loadSchoolAnnouncementListView    公开列表：所有人可见，只看未下架的
 *   loadSchoolAnnouncementManageView  管理台账：有发布权才可见，含已下架
 *
 * 【为什么分成两个而不是一个带 flag 的】
 * 两者的取数口径（公开只给未下架 / 台账给全量）、空态文案、失败关闭的
 * 条件都不一样。合成一个会立刻退化成一堆 if，而且最危险的差别——
 * 「谁才看得到已下架的」——会藏在分支里，改错一处就把下架内容推给了
 * 公开列表。分开之后，每一条边界都摆在明面上。
 *
 * 【管理页为什么失败关闭】
 * 没有发布权时直接返回 rows: [] 与一句 blockedText，一条公告都不下发。
 * 是否已登录由页面传入（loggedIn），用来区分「去登录」与「没这个权限」——
 * 服务端只回答「能不能管」（canManage），回答不了「为什么不能管」。
 *
 * 【公开列表为什么不分权限】
 * 公告本就是公开内容，访客也能看。schoolAnnouncementRow 的 withManage 缺省
 * 为 false，公开列表恒不下发管理按钮——公开页不该因为看的人恰好是管理员
 * 就冒出下架按钮。
 *
 * 【公开列表为什么跨协会、按协会标签切换】
 * 公告页回答的是「最近各协会都发了什么」——把全部启用协会的公告都取出来，
 * 顶部横着一栏协会标签，选哪个协会就只看哪个协会，谁的公告都不会被藏住
 * （§11.3）。取数按「学校 + 协会」逐个范围各取一次（association-space 的
 * forScope），不在异步等待期间读全局当前协会。
 * ============================================================
 */

const { ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_STATUS } = require('../utils/constants.js');
const { activeAssociations } = require('../utils/associations.js');
const { formatDateTime } = require('../utils/format.js');
const { DEFAULT_CATEGORY } = require('./announcement.js');
const { brandOf } = require('./branding.js');
const scope = require('./association-scope.js');
const space = require('./association-space.js');

/** 「全部」标签：不分分类 */
const ALL_TAB = 'all';

/** 合法的分类标签，用来把非法入参挡回「全部」 */
const VALID_TABS = [ALL_TAB, ...ANNOUNCEMENT_CATEGORIES];

/**
 * 组装分类标签栏，并给每个标签标上条数。
 * 条数是按「全部公告」算的，不随当前标签变化——否则切一次标签，
 * 别的分类就全变成 0，看着像数据丢了。
 *
 * @param {Array<Object>} rows 全部公告行
 * @param {string} activeTab
 * @returns {Array<Object>}
 */
function categoryTabs(rows, activeTab) {
  const countOf = (category) => rows.filter((row) => row.category === category).length;
  const tabs = [{ tab: ALL_TAB, label: '全部', count: rows.length }];
  for (const category of ANNOUNCEMENT_CATEGORIES) {
    tabs.push({ tab: category, label: category, count: countOf(category) });
  }
  return tabs.map((tab) => ({ ...tab, active: tab.tab === activeTab }));
}

/**
 * 学校维度公告摘要（school-announcement-service.announcementSummary）→ 页面行。
 *
 * 权限布尔量随 withManage 决定：公开列表恒不下发管理按钮（withManage 缺省 false），
 * 只有管理台账才照服务端判好的 canArchive 下发——公开页不该因为看的人恰好是
 * 管理员就冒出下架按钮。状态与文案由服务端算好，这里只做字段名与展示格式的适配。
 *
 * @param {Object} summary 服务端公告摘要
 * @param {boolean} [withManage] 是否下发管理按钮
 * @returns {Object}
 */
function schoolAnnouncementRow(summary, withManage = false) {
  return {
    id: summary.announcementId,
    title: summary.title || '（无标题）',
    content: summary.content || '',
    category: summary.category || DEFAULT_CATEGORY,
    pinned: Boolean(summary.pinned),
    publishText: summary.publishTime ? formatDateTime(summary.publishTime) : '',
    statusLabel: summary.statusLabel || '',
    archived: Boolean(summary.archived),
    publisherName: summary.publisherName || '',
    canArchive: Boolean(withManage && summary.canArchive),
  };
}

/**
 * 公开公告列表——跨全部启用协会聚合，顶部一栏协会标签切换。
 *
 * 【返回值形状】
 *   activeAssociation 当前选中的协会 id
 *   themeClass        当前协会的主题类（挂到根容器，标签与内容随协会上色）
 *   associationTabs   协会标签（每个启用协会一个），
 *                     带 associationId / label / glyph / count / active
 *   tabs              分类标签（计数按当前协会算，不随当前分类变化）
 *   rows              当前协会、当前分类下的公告
 *   total             当前协会的公告总数（不随当前分类变化）
 *   visibleCount      当前分类下实际展示的条数
 *
 * @param {Object} [options]
 * @param {string} options.schoolId 当前学校
 * @param {string} [options.tab] 当前分类，非法值退回「全部」
 * @param {string} [options.association] 当前协会，非法值退回全局所在协会
 * @returns {Promise<Object>}
 */
async function loadSchoolAnnouncementListView(options = {}) {
  const { schoolId, tab = ALL_TAB, association } = options;
  const activeTab = VALID_TABS.includes(tab) ? tab : ALL_TAB;
  const fallback = scope.getAssociation();

  const groups = [];
  for (const assoc of activeAssociations()) {
    const api = space.forScope({ schoolId, association: assoc.id });
    // 显式只要「已发布」：listSchoolAnnouncements 对有管理权的人返回全量
    // （含已下架，供审计），而公开列表不该因为看的人恰好是管理员就把已下架的
    // 内容摆出来——范围由这里收口，不靠查看者身份碰巧不是管理员。
    const result = await api.listSchoolAnnouncements({ status: ANNOUNCEMENT_STATUS.PUBLISHED });
    // 服务端已按「置顶优先 → 发布时间倒序」排好（复用 sortAnnouncements），这里不再重排
    const rows = (result.announcements || []).map((summary) => ({
      ...schoolAnnouncementRow(summary),
      association: assoc.id,
      associationName: assoc.shortName,
      associationGlyph: assoc.logoGlyph,
    }));
    groups.push({
      associationId: assoc.id,
      label: assoc.sportName,
      glyph: assoc.logoGlyph,
      themeClass: brandOf(assoc.id).rootClass,
      rows,
    });
  }

  // 选中的协会：入参合法就用它；否则跟随全局所在协会；再不行退回第一个。
  const has = (id) => groups.some((group) => group.associationId === id);
  const activeAssociation = has(association)
    ? association
    : has(fallback)
      ? fallback
      : groups[0]
        ? groups[0].associationId
        : '';

  const current = groups.find((group) => group.associationId === activeAssociation) || null;
  const scopedRows = current ? current.rows : [];
  const rows =
    activeTab === ALL_TAB
      ? scopedRows
      : scopedRows.filter((row) => row.category === activeTab);

  const associationTabs = groups.map((group) => ({
    associationId: group.associationId,
    label: group.label,
    glyph: group.glyph,
    count: group.rows.length,
    active: group.associationId === activeAssociation,
  }));

  return {
    activeAssociation,
    themeClass: current ? current.themeClass : '',
    associationTabs,
    activeTab,
    tabs: categoryTabs(scopedRows, activeTab),
    rows,
    total: scopedRows.length,
    visibleCount: rows.length,
    emptyText:
      activeTab === ALL_TAB ? '这个协会暂时还没有公告' : `「${activeTab}」分类下暂时没有公告`,
  };
}

/**
 * 公告管理台账——单「学校 + 协会」范围。
 *
 * 闸门来自服务端：`canManage` 为假时一条都不下发（尤其是已下架的）。
 * 是否已登录由页面传入，用来区分「去登录」与「没这个权限」——服务端只回答
 * 「能不能管」，回答不了「为什么不能管」。
 *
 * @param {Object} [options]
 * @param {string} options.schoolId 当前学校
 * @param {string} options.association 当前协会
 * @param {boolean} [options.loggedIn] 是否已登录
 * @returns {Promise<Object>}
 */
async function loadSchoolAnnouncementManageView(options = {}) {
  const { schoolId, association, loggedIn = false } = options;
  const api = space.forScope({ schoolId, association });
  const result = await api.listSchoolAnnouncements({});

  if (!result.canManage) {
    return {
      allowed: false,
      blockedText: loggedIn
        ? '当前账号没有管理公告的权限，请联系管理员'
        : '请先登录后再管理公告',
      viewer: { userId: '', loggedIn },
      rows: [],
      total: 0,
      publishedCount: 0,
      archivedCount: 0,
    };
  }

  const rows = (result.announcements || [])
    .map((summary) => schoolAnnouncementRow(summary, true))
    // 已下架的沉到底部，好让「还能操作的那些」先被看到（sort 稳定，组内保持原序）
    .sort((a, b) => Number(a.archived) - Number(b.archived));

  return {
    allowed: true,
    blockedText: '',
    viewer: { userId: '', loggedIn: true },
    rows,
    total: rows.length,
    publishedCount: rows.filter((row) => !row.archived).length,
    archivedCount: rows.filter((row) => row.archived).length,
  };
}

module.exports = {
  ALL_TAB,
  VALID_TABS,
  categoryTabs,
  schoolAnnouncementRow,
  loadSchoolAnnouncementListView,
  loadSchoolAnnouncementManageView,
};
