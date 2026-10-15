/**
 * 公告页的视图模型
 * ============================================================
 * 两个装载器，对应两种页面：
 *   loadAnnouncementListView    公开列表：所有人可见，只看未下架的
 *   loadAnnouncementManageView  管理台账：有发布权才可见，含已下架
 *
 * 【为什么分成两个而不是一个带 flag 的】
 * 两者的取数口径（公开只给未下架 / 台账给全量）、空态文案、失败关闭的
 * 条件都不一样。合成一个会立刻退化成一堆 if，而且最危险的差别——
 * 「谁才看得到已下架的」——会藏在分支里，改错一处就把下架内容推给了
 * 公开列表。分开之后，每一条边界都摆在明面上。
 *
 * 【管理页为什么按会员审核页那样失败关闭】
 * 没有发布权时直接返回 rows: [] 与一句 blockedText，一条公告都不下发。
 * mock 的 getCurrentUser() 永远答 u06，若这里自己去问，一个没登录的访客
 * 也会被当成 u06，凭空拿到管理权限。所以登录态由页面明确传入——传 null
 * 是访客，干脆不传也按访客处理。
 *
 * 【公开列表为什么不分权限】
 * 公告本就是公开内容，访客也能看。这里给每一行传 actor: null，
 * 于是 canArchive 恒为假，页面上不会冒出管理按钮。
 *
 * 【公开列表为什么跨协会、按协会标签切换】
 * 公告页回答的是「最近各协会都发了什么」，与首页公告栏同一口径——把全部
 * 启用协会的公告都取出来。之前是竖着一栏栏叠下来，协会一多，下面的就被
 * 压在很下面、要一直滑才看得到；现在顶部横着一栏协会标签，选哪个协会就
 * 只看哪个协会，谁的公告都不会被藏住（§11.3）。取数沿用与首页
 * collectAnnouncements 同一套聚合思路：串行逐协会取（见
 * association-scope.mapActiveAssociations）。
 * ============================================================
 */

const { ANNOUNCEMENT_CATEGORIES } = require('../utils/constants.js');
const { activeAssociations } = require('../utils/associations.js');
const { formatDateTime } = require('../utils/format.js');
const {
  sortAnnouncements, buildAnnouncementRow, canPublish, DEFAULT_CATEGORY,
} = require('./announcement.js');
const { getAnnouncementRecords } = require('./index.js');
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
 * 装载公开公告列表——跨全部启用协会聚合，顶部一栏协会标签切换。
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
 * @param {string} [options.tab] 当前分类，非法值退回「全部」
 * @param {string} [options.association] 当前协会，非法值退回全局所在协会
 * @returns {Promise<Object>}
 */
async function loadAnnouncementListView(options = {}) {
  const { tab = ALL_TAB, association } = options;
  const activeTab = VALID_TABS.includes(tab) ? tab : ALL_TAB;

  // 记录本次加载的默认标签；聚合请求不修改全局选择。
  const fallback = scope.getAssociation();

  const groups = await scope.mapActiveAssociations(async (assoc, api) => {
    const items = await api.getAnnouncements();
    // actor 传 null：公开页不给任何管理按钮
    const rows = sortAnnouncements(items).map((item) => ({
      ...buildAnnouncementRow(item, { actor: null }),
      association: assoc.id,
      associationName: assoc.shortName,
      associationGlyph: assoc.logoGlyph,
    }));
    return {
      associationId: assoc.id,
      label: assoc.sportName,
      glyph: assoc.logoGlyph,
      themeClass: brandOf(assoc.id).rootClass,
      rows,
    };
  });

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
 * 装载公告管理台账。
 *
 * @param {Object} [options]
 * @param {Object|null} [options.user] 当前登录会员；传 null 或不传都算访客
 * @returns {Promise<Object>}
 */
async function loadAnnouncementManageView(options = {}) {
  const { user = null } = options;

  const allowed = canPublish(user);

  const viewer = {
    userId: user ? user._id : null,
    loggedIn: Boolean(user),
  };

  // 闸门：没有管理权就到此为止，绝不把已下架的公告发出去
  if (!allowed) {
    return {
      allowed: false,
      blockedText: user
        ? '当前账号没有管理公告的权限，请联系管理员'
        : '请先登录后再管理公告',
      viewer,
      rows: [],
      total: 0,
      publishedCount: 0,
      archivedCount: 0,
    };
  }

  const items = await getAnnouncementRecords();
  const rows = sortAnnouncements(items)
    .map((item) => buildAnnouncementRow(item, { actor: user }))
    // 已下架的沉到底部，好让「还能操作的那些」先被看到。
    // sort 是稳定的，所以组内仍保持「置顶在前、其余按时间倒序」。
    .sort((a, b) => Number(a.archived) - Number(b.archived));

  return {
    allowed: true,
    blockedText: '',
    viewer,
    rows,
    total: rows.length,
    publishedCount: rows.filter((row) => !row.archived).length,
    archivedCount: rows.filter((row) => row.archived).length,
  };
}

/* ============================================================
 * 学校维度装载器（协议 2）
 * ============================================================
 * 与上面的旧栈装载器并存一段过渡期：页面改接后只用下面这两个，旧栈装载器
 * 留到旧门面下线（M5）时一并移除。数据来自 association-space 的 forScope
 * （本地演示与云端跑同一份服务实现），按 (schoolId, association) 取公告。
 *
 * 与旧栈的两点差别，都是学校维度带来的、必须显式的：
 *   1. 取数按「学校 + 协会」——列表页跨协会聚合时逐个协会各取一次；
 *   2. 管理台账只覆盖**当前**学校 + 协会（旧栈是跨协会的大台账）。
 * ============================================================
 */

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
 * 学校维度：公开公告列表——跨全部启用协会聚合，顶部一栏协会标签切换。
 * 输出形状与旧栈 loadAnnouncementListView 对齐，页面 WXML 基本不动。
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
    const result = await api.listSchoolAnnouncements({});
    // 服务端已按「置顶优先 → 发布时间倒序」排好（复用旧栈 sortAnnouncements），这里不再重排
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
 * 学校维度：公告管理台账——单「学校 + 协会」范围。
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
  loadAnnouncementListView,
  loadAnnouncementManageView,
  schoolAnnouncementRow,
  loadSchoolAnnouncementListView,
  loadSchoolAnnouncementManageView,
};
