/**
 * 学校维度首页装载器（B4-b）
 * ============================================================
 * 首页自上而下两块内容：公告 + 近期赛事，以及登录后的概况数字。
 * 学校维度下这两块都按「当前浏览学校」取数，**跨该校的协会聚合**：
 *
 *   · 公告  —— 各协会 listSchoolAnnouncements 聚合，置顶优先、时间倒序；
 *   · 赛事  —— 各协会 listSchoolEvents 聚合，只留报名中 / 进行中，开赛时间升序；
 *   · 概况  —— 会员数（学校级，取一份）、比赛数 / 赛事数（按协会相加）、赛季编号。
 *
 * 每个协会单独建客户端、单独容错：某协会未启用 / 无读取权限时跳过该协会，
 * 不把整页拖垮；一个协会都读不到时给真实空态（游客与跨校只读浏览同理），
 * 不再用外校静态演示内容顶替（指南 §8）。
 *
 * 游客（无 viewerId）只看公告（需求整理 §11.8），赛事与概况不取。
 * ============================================================
 */

const { allAssociations, getAssociation } = require('../utils/associations.js');
const { formatDate, formatDateTime } = require('../utils/format.js');

/** 首页默认展示的公告与赛事条数。太多会把首屏撑得很长。 */
const DEFAULT_ANNOUNCEMENT_LIMIT = 3;
const DEFAULT_EVENT_LIMIT = 3;

/** 单次列表页大小。协会内容超过一页时循环取完，不把第一页当全集。 */
const PAGE_LIMIT = 50;

/** 时间字段转毫秒。非法值一律当 0 沉底，绝不产生 NaN 比较 */
function timeValue(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** 还能参加（报名中）或正在进行的赛事才算「近期」 */
function isUpcomingEvent(event) {
  if (!event) return false;
  return event.isSignup === true || event.isOngoing === true;
}

/**
 * 按开赛时间升序（最近要打的在前）排序并截断。
 * @param {Array<Object>} rows
 * @param {number} limit
 * @returns {Array<Object>}
 */
function sortUpcoming(rows, limit) {
  return rows
    .filter(isUpcomingEvent)
    .sort((a, b) => timeValue(a.startTime) - timeValue(b.startTime))
    .slice(0, limit);
}

/** 整形一条公告（与旧栈 home-view.buildAnnouncementRow 同形状）。 */
function announcementRow(item, assoc) {
  return {
    id: item.announcementId,
    title: item.title || '',
    content: item.content || '',
    category: item.category || '通知',
    pinned: Boolean(item.pinned),
    dateText: formatDate(item.publishTime),
    association: assoc.id,
    associationName: assoc.shortName,
    associationGlyph: assoc.logoGlyph,
  };
}

/** 整形一条近期赛事（字段供 index.wxml 的赛事卡直接渲染）。 */
function eventRow(event, assoc) {
  return {
    id: event.eventId,
    title: event.title || '',
    statusLabel: event.statusLabel || '',
    isOngoing: Boolean(event.isOngoing),
    timeText: formatDateTime(event.startTime),
    location: event.location || '',
    quotaText: event.quotaText || '',
    signedUp: Boolean(event.mySignup && event.mySignup.signed),
    association: assoc.id,
    associationName: assoc.shortName,
    associationGlyph: assoc.logoGlyph,
  };
}

/**
 * 取某协会的公告首页（服务端每页限量 50、无 offset，首页展示只需第一页）。
 * 返回排序后的首页与是否还有更多；协会空间读不到时抛错，由调用方跳过该协会。
 */
async function collectAnnouncements(api) {
  const page = await api.listSchoolAnnouncements({ limit: PAGE_LIMIT });
  if (!page.ok) throw new Error(page.message || '公告读取失败');
  return { announcements: page.announcements || [], hasMore: Boolean(page.hasMore) };
}

/**
 * 循环取完某协会的赛事，返回全部事件 DTO 与赛事总数（分页循环取完，不截断）。
 */
async function collectEvents(api) {
  const collected = [];
  let offset = 0;
  for (;;) {
    const page = await api.listSchoolEvents({ limit: PAGE_LIMIT, offset });
    if (!page.ok) throw new Error(page.message || '赛事读取失败');
    collected.push(...(page.events || []));
    if (!page.hasMore) return collected;
    offset = page.nextOffset;
  }
}

/**
 * 一次聚合：遍历客户端注册表里的协会，逐个建绑定范围客户端并取数。
 * 单协会读失败（未启用 / 无权限）跳过，不拖垮整页。
 *
 * @param {Object} options
 * @param {string} options.schoolId
 * @param {string} options.viewerId 当前登录人编号；空串即访客
 * @param {number} [options.announcementLimit]
 * @param {number} [options.eventLimit]
 * @param {Object} [options.client] 协会空间门面（测试可注入替身）
 * @returns {Promise<Object>} 首页视图模型
 */
async function loadSchoolHomeView(options = {}) {
  const schoolId = options.schoolId || '';
  const viewerId = options.viewerId || '';
  const announcementLimit = Number.isInteger(options.announcementLimit)
    ? options.announcementLimit : DEFAULT_ANNOUNCEMENT_LIMIT;
  const eventLimit = Number.isInteger(options.eventLimit) ? options.eventLimit : DEFAULT_EVENT_LIMIT;
  const client = options.client || require('./association-space.js');

  const perAssociation = await Promise.all(allAssociations().map(async (assoc) => {
    const scope = { schoolId, association: assoc.id };
    const api = client.forScope(scope);
    try {
      const announcementPage = await collectAnnouncements(api);
      let events = [];
      let matchTotal = 0;
      let seasonText = '';
      let memberCount = 0;
      if (viewerId) {
        const [eventDocs, matches, season, members] = await Promise.all([
          collectEvents(api),
          api.listSchoolMatches({ limit: 1 }),
          api.getSchoolSeason(),
          api.listSchoolMembers({}),
        ]);
        events = eventDocs;
        matchTotal = Number((matches && matches.total) || 0);
        seasonText = `第 ${Number((season && season.season && season.season.seasonNumber) || 1)} 赛季`;
        memberCount = Number((members && members.total) || 0);
      }
      return {
        assoc: getAssociation(assoc.id),
        announcements: announcementPage.announcements.map((item) => ({ item, assoc: getAssociation(assoc.id) })),
        announcementsHasMore: announcementPage.hasMore,
        events,
        matchTotal,
        seasonText,
        memberCount,
      };
    } catch (err) {
      // 该校未启用此协会 / 无读取权限：该协会视为空，不冒充成功
      console.warn(`[home] 读取 ${schoolId}/${assoc.id} 首页数据失败`, err);
      return { assoc: null, announcements: [], announcementsHasMore: false, events: [], matchTotal: 0, seasonText: '', memberCount: 0 };
    }
  }));

  const readable = perAssociation.filter((row) => row.assoc !== null);
  // 公告聚合：置顶优先、发布时间倒序（与各协会列表同口径）
  const announcementDocs = readable
    .flatMap((row) => row.announcements)
    .sort((a, b) => {
      const pin = Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned));
      if (pin !== 0) return pin;
      return timeValue(b.item.publishTime) - timeValue(a.item.publishTime);
    })
    .map(({ item, assoc }) => announcementRow(item, assoc));
  // 任一协会还有更多公告（服务端单页限量 50，跨协会取并集后如实带上标记）
  const announcementsHasMore = readable.some((row) => row.announcementsHasMore);

  // 近期赛事聚合：报名中 / 进行中，开赛时间升序。筛选在整形前做——
  // eventRow 只带展示字段（isOngoing），isSignup 判据来自原始 DTO。
  const upcomingEvents = viewerId
    ? sortUpcoming(
      readable.flatMap((row) => row.events.map((event) => ({ ...event, __assoc: row.assoc }))),
      eventLimit
    ).map((event) => eventRow(event, event.__assoc))
    : [];

  // 概况：会员数取第一份（学校级，不按协会相加）；比赛 / 赛事按协会相加。
  // 一个协会都读不到时概况给 null（与访客同口径），不编数字。
  let summary = null;
  if (viewerId && readable.length > 0) {
    const memberCount = readable[0].memberCount;
    const matchCount = readable.reduce((sum, row) => sum + row.matchTotal, 0);
    const eventCount = readable.reduce((sum, row) => sum + row.events.length, 0);
    summary = {
      memberCount,
      matchCount,
      eventCount,
      seasonText: readable[0].seasonText,
    };
  }

  return {
    loggedIn: Boolean(viewerId),
    announcements: {
      rows: announcementDocs.slice(0, announcementLimit),
      total: announcementDocs.length,
      hasMore: announcementsHasMore || announcementDocs.length > announcementLimit,
    },
    upcomingEvents,
    summary,
  };
}

module.exports = {
  DEFAULT_ANNOUNCEMENT_LIMIT,
  DEFAULT_EVENT_LIMIT,
  PAGE_LIMIT,
  timeValue,
  isUpcomingEvent,
  sortUpcoming,
  announcementRow,
  eventRow,
  loadSchoolHomeView,
};
