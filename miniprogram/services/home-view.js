/**
 * 首页的视图模型
 * ============================================================
 * 首页自上而下两块内容，全部在这里取数、整形、算文案：
 *   1. 俱乐部公告——置顶在前，其余按时间倒序
 *   2. 近期赛事——报名中 / 进行中的赛事，最近要打的排在前面
 *
 * 【为什么不再有「我的分数」卡】
 * 首页要回答的是「俱乐部最近有什么事」，而不是「我第几名」。
 * 个人排名在排行榜页与「我的」页各有一处，首页再摆一份只会把
 * 真正需要动手的事（报名、看公告）挤下去。
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
// 公告排序与公告列表页共用一份，避免首页和列表页各写一套、慢慢分叉
const { sortAnnouncements } = require('./announcement.js');
// 赛事行与赛事页共用一份整形，配额、报名状态两处的口径保持一致
const { buildEventRow } = require('./event.js');
const { getAnnouncements, getEvents, getEventSignups, getHomeSummary } = require('./index.js');

/** 首页默认展示的公告与赛事条数。太多会把首屏撑得很长。 */
const DEFAULT_ANNOUNCEMENT_LIMIT = 3;
const DEFAULT_EVENT_LIMIT = 3;

/**
 * 整形一条公告。
 * @param {Object} item
 * @returns {Object}
 */
function buildAnnouncementRow(item) {
  return {
    id: item._id,
    title: item.title,
    content: item.content,
    category: item.category || '通知',
    pinned: Boolean(item.pinned),
    dateText: formatDate(item.publishTime),
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

  const [announcements, events, summary] = await Promise.all([
    getAnnouncements(),
    getEvents(),
    getHomeSummary(),
  ]);

  const ordered = sortAnnouncements(announcements);
  const upcoming = sortUpcomingEvents(events).slice(0, eventLimit);
  const signupMap = await loadSignupMap(upcoming);
  const actor = sessionUser || null;

  return {
    announcements: {
      rows: ordered.slice(0, announcementLimit).map(buildAnnouncementRow),
      total: announcements.length,
      hasMore: announcements.length > announcementLimit,
    },
    // 一场都没有时给空数组，模板照样渲染这张卡，只把内容换成空态文案
    upcomingEvents: upcoming.map((event) =>
      buildEventRow(event, { actor, signups: signupMap.get(event._id) || [] })
    ),
    summary: {
      memberCount: summary.memberCount,
      matchCount: summary.matchCount,
      eventCount: summary.eventCount,
      seasonText: `${formatDate(summary.seasonRange.from)} — ${formatDate(summary.seasonRange.to)}`,
    },
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
  loadHomeView,
};
