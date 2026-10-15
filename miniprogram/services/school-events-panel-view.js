/** 赛事工作台及全部列表：两个赛事分支、积分和身份使用同一 S2 范围。 */
const space = require('./association-space');
const identity = require('./school-identity');
const { loadSchoolEventListView } = require('./school-event-view');
const { loadCollegeEventListRows } = require('./school-college-view');
const { buildPointsRows, describeSeason } = require('./events-view');
const { formatPercent } = require('../utils/format');
const { USER_STATUS } = require('../utils/constants');

async function loadSchoolEventsPanelView(options) {
  const { schoolId, association, listLimit = 3, includePoints = true } = options;
  const scope = { schoolId, association };
  const api = space.forScope(scope);
  const session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
  const actorId = session.user && session.user.userId;
  const [personal, college, stats, season] = await Promise.all([
    loadSchoolEventListView({ ...scope, actorId, limit: Infinity }),
    loadCollegeEventListRows(scope),
    includePoints ? api.getSchoolMemberStats({}) : { ok: true, members: [] },
    includePoints ? api.getSchoolSeason({}) : { ok: true, season: {} },
  ]);
  if (!stats.ok || !season.ok) throw new Error(stats.message || season.message || '积分读取失败');
  const allRows = buildPointsRows(stats.members.map(row => ({ ...row, _id: row.userId, status: USER_STATUS.ACTIVE })), new Map(), actorId)
    .map(row => ({ ...row, detailText: '赛事与训练积分' }));
  const rows = allRows.slice(0, 10);
  const total = allRows.length;
  const me = allRows.find(row => row.userId === actorId);
  const events = personal.events.slice(0, listLimit);
  const collegeEvents = college.rows.slice(0, listLimit);
  return {
    seasonText: describeSeason(season.season), rows, allRows, total,
    hasMore: total > rows.length, empty: !total,
    playerCountText: total > 10 ? `前 10 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: '本赛季还没有积分记录',
    me: me ? { rank: me.rank, total, beatText: `超过 ${formatPercent((total - me.rank) / total)} 的会员` } : null,
    meHint: me ? '' : '本赛季还没有积分',
    events, hasEvents: events.length > 0, eventTotal: personal.events.length,
    eventsEmptyNote: personal.eventsEmptyNote, hasMoreEvents: personal.events.length > events.length,
    canPublish: personal.canPublish,
    collegeEvents, hasCollegeEvents: collegeEvents.length > 0, collegeEventTotal: college.rows.length,
    collegeEventsEmptyNote: '还没有学院赛，等管理员发布一场吧',
    hasMoreCollegeEvents: college.rows.length > collegeEvents.length, canManageCollege: college.canManage,
  };
}

module.exports = { loadSchoolEventsPanelView };
