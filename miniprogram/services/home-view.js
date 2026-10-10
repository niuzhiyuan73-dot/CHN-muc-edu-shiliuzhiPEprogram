/**
 * 首页的视图模型
 * ============================================================
 * 首页自上而下两块内容，全部在这里取数、整形、算文案：
 *   1. 公告——置顶在前，其余按时间倒序（**跨全部协会聚合**）
 *   2. 近期赛事——报名中 / 进行中的赛事，最近要打的排在前面（**跨全部协会聚合**）
 *
 * 【为什么首页是跨协会的】
 * 首页回答的是「最近有什么事」，不该被「我现在在哪个协会」框住。公告与
 * 近期赛事把全部协会的都摆出来，每条标注它属于哪个协会；想看某个协会的
 * 全部，再切过去（见需求整理 §11.3）。
 *
 * 【为什么聚合要串行取】当前协会是模块级单例状态（见 association-scope），
 * 跨协会读只能一个协会一个协会地切过去、取完还原，不能并发。
 *
 * 【为什么近期赛事要另取报名记录】
 * 卡片上要显示「已报几人」「我报没报」。报名记录不在赛事记录里，
 * 得按赛事编号单独取；只对筛选后的少数几场取，不是全量。
 *
 * 【为什么赛事为空也要出卡】
 * 空着不渲染会让首页看起来「少了一块」，也让人以为页面没加载完。
 * 照常出一张卡、里面写一句「近期没有比赛」，语义是完整的。
 * ============================================================
 */

const { EVENT_STATUS } = require('../utils/constants.js');
const { formatDate } = require('../utils/format.js');
const scope = require('./association-scope.js');
// 公告排序与公告列表页共用一份，避免首页和列表页各写一套、慢慢分叉
const { sortAnnouncements } = require('./announcement.js');
// 赛事行与赛事页共用一份整形，配额、报名状态两处的口径保持一致
const { buildEventRow } = require('./event.js');
const { getAnnouncements, getEvents, getEventSignups, getHomeSummary } = require('./index.js');

/** 首页默认展示的公告与赛事条数。太多会把首屏撑得很长。 */
const DEFAULT_ANNOUNCEMENT_LIMIT = 3;
const DEFAULT_EVENT_LIMIT = 3;

/**
 * 整形一条公告。item 上若挂着内部标记 __assoc（聚合时贴上），一并带出协会信息。
 * @param {Object} item
 * @returns {Object}
 */
function buildAnnouncementRow(item) {
  const assoc = item.__assoc || null;
  return {
    id: item._id,
    title: item.title,
    content: item.content,
    category: item.category || '通知',
    pinned: Boolean(item.pinned),
    dateText: formatDate(item.publishTime),
    association: assoc ? assoc.id : '',
    associationName: assoc ? assoc.shortName : '',
    associationGlyph: assoc ? assoc.logoGlyph : '',
  };
}

/** 时间字段转毫秒。非法值一律当 0 沉底，绝不产生 NaN 比较 */
function timeValue(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** 还能参加（报名中）或正在进行的赛事才算「近期」 */
function isUpcomingEvent(event) {
  if (!event) return false;
  return event.status === EVENT_STATUS.SIGNUP || event.status === EVENT_STATUS.ONGOING;
}

/**
 * 近期赛事：只留报名中 / 进行中，按开赛时间升序——最近要打的排在前面。
 * 已结束的不进来，否则历史赛事会把还能报名的场次压到屏幕外。
 *
 * @param {Array<Object>} events
 * @returns {Array<Object>} 新数组，不改动入参
 */
function sortUpcomingEvents(events) {
  return (Array.isArray(events) ? events : [])
    .filter(isUpcomingEvent)
    .slice()
    .sort((a, b) => timeValue(a.startTime) - timeValue(b.startTime));
}

/**
 * 按赛事编号取报名记录，建一张索引。
 * 只对筛选后的少数几场并发发出，不是全量。
 *
 * @param {Array<Object>} events
 * @returns {Promise<Map<string, Array<Object>>>}
 */
async function loadSignupMap(events) {
  const pairs = await Promise.all(
    events.map(async (event) => [event._id, await getEventSignups(event._id)])
  );
  return new Map(pairs);
}

/**
 * 跨协会聚合公告：每个协会各取一份，贴上所属协会，最后统一排序。
 * 返回排序后的完整列表（截断交给调用方）。
 *
 * @returns {Promise<Array<Object>>} 排序后的原始公告（带 __assoc 标记）
 */
async function collectAnnouncements() {
  const grouped = await scope.mapActiveAssociations(async (assoc) => {
    const items = await getAnnouncements();
    return (Array.isArray(items) ? items : []).map((item) => ({ ...item, __assoc: assoc }));
  });
  return sortAnnouncements(grouped.flat());
}

/**
 * 跨协会聚合近期赛事，按开赛时间升序取前 limit 条，每条整形为赛事行并带上协会。
 *
 * @param {Object|null} actor 当前登录会员
 * @param {number} limit
 * @returns {Promise<Array<Object>>}
 */
async function collectUpcomingEvents(actor, limit) {
  const grouped = await scope.mapActiveAssociations(async (assoc) => {
    const events = sortUpcomingEvents(await getEvents());
    const signupMap = await loadSignupMap(events);
    return events.map((event) => ({
      event,
      assoc,
      signups: signupMap.get(event._id) || [],
    }));
  });

  return grouped
    .flat()
    .sort((a, b) => timeValue(a.event.startTime) - timeValue(b.event.startTime))
    .slice(0, limit)
    .map(({ event, assoc, signups }) => ({
      ...buildEventRow(event, { actor, signups }),
      association: assoc.id,
      associationName: assoc.shortName,
      associationGlyph: assoc.logoGlyph,
    }));
}

/**
 * 跨协会汇总页脚数字。
 * 会员是全局的（人人都在全部协会），故 memberCount 取一份即可，不能相加；
 * 比赛与赛事是各协会各自的内容，相加。
 *
 * @returns {Promise<Object>}
 */
async function collectSummary() {
  const list = await scope.mapActiveAssociations(async () => getHomeSummary());
  let memberCount = 0;
  let matchCount = 0;
  let eventCount = 0;
  let from = null;
  let to = null;

  list.forEach((summary, index) => {
    if (!summary) return;
    if (index === 0) memberCount = summary.memberCount || 0;
    matchCount += summary.matchCount || 0;
    eventCount += summary.eventCount || 0;
    const range = summary.seasonRange || {};
    const start = timeValue(range.from);
    const end = timeValue(range.to);
    if (start && (from === null || start < from)) from = start;
    if (end && (to === null || end > to)) to = end;
  });

  return {
    memberCount,
    matchCount,
    eventCount,
    seasonRange: {
      from: from === null ? '' : new Date(from).toISOString(),
      to: to === null ? '' : new Date(to).toISOString(),
    },
  };
}

/**
 * 装载首页数据。
 *
 * @param {Object|null} sessionUser 当前登录会员（app.globalData.userInfo），为空即访客
 * @param {Object} [options]
 * @param {number} [options.announcementLimit]
 * @param {number} [options.eventLimit]
 * @returns {Promise<Object>}
 */
async function loadHomeView(sessionUser, options = {}) {
  const {
    announcementLimit = DEFAULT_ANNOUNCEMENT_LIMIT,
    eventLimit = DEFAULT_EVENT_LIMIT,
  } = options;
  const actor = sessionUser || null;
  const loggedIn = Boolean(actor);

  const ordered = await collectAnnouncements();

  // 游客只看得到公告（需求整理 §11.8），赛事与概况都不取
  const [upcomingEvents, summary] = loggedIn
    ? await Promise.all([collectUpcomingEvents(actor, eventLimit), collectSummary()])
    : [[], null];

  return {
    loggedIn,
    announcements: {
      rows: ordered.slice(0, announcementLimit).map(buildAnnouncementRow),
      total: ordered.length,
      hasMore: ordered.length > announcementLimit,
    },
    // 一场都没有时给空数组，模板照样渲染这张卡，只把内容换成空态文案
    upcomingEvents,
    summary: summary
      ? {
          memberCount: summary.memberCount,
          matchCount: summary.matchCount,
          eventCount: summary.eventCount,
          seasonText: `${formatDate(summary.seasonRange.from)} — ${formatDate(summary.seasonRange.to)}`,
        }
      : null,
  };
}

module.exports = {
  DEFAULT_ANNOUNCEMENT_LIMIT,
  DEFAULT_EVENT_LIMIT,
  sortAnnouncements,
  buildAnnouncementRow,
  timeValue,
  isUpcomingEvent,
  sortUpcomingEvents,
  loadSignupMap,
  collectAnnouncements,
  collectUpcomingEvents,
  collectSummary,
  loadHomeView,
};
