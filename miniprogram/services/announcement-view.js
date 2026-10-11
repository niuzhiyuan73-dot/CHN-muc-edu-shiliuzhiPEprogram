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
const { sortAnnouncements, buildAnnouncementRow, canPublish } = require('./announcement.js');
const { getAnnouncements, getAnnouncementRecords } = require('./index.js');
const { brandOf } = require('./branding.js');
const scope = require('./association-scope.js');

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

  // 串行逐协会取：当前协会是模块级单例，只能一个协会一个协会地切过去取。
  // 取完 mapActiveAssociations 会把全局协会还原，故先记下它，供「没指定协会时」兜底。
  const fallback = scope.getAssociation();

  const groups = await scope.mapActiveAssociations(async (assoc) => {
    const items = await getAnnouncements();
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

module.exports = {
  ALL_TAB,
  VALID_TABS,
  categoryTabs,
  loadAnnouncementListView,
  loadAnnouncementManageView,
};
