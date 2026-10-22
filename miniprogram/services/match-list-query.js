/** 比赛列表的受控查询规格；云端只取一页，内存端保持同一筛选与排序口径。 */
const { MATCH_STATUS } = require('../utils/constants');

const isListMatch = doc => Boolean(doc && Array.isArray(doc.teamA) && Array.isArray(doc.teamB) &&
  typeof doc.status === 'number' && doc.matchTime);
const compareId = (a, b) => a === b ? 0 : a < b ? -1 : 1;
const compareMatches = (a, b) => ((Date.parse(b.matchTime) || 0) - (Date.parse(a.matchTime) || 0)) ||
  compareId(String(b._id), String(a._id));

function listFilter(payload = {}) {
  const filter = {};
  for (const key of ['pool', 'status']) {
    if (typeof payload[key] === 'number') filter[key] = payload[key];
  }
  for (const key of ['eventId', 'userId']) {
    if (typeof payload[key] === 'string' && payload[key]) filter[key] = payload[key];
  }
  return filter;
}

/** 聚合 match 使用原生查询操作符；范围来自服务上下文，客户端不能覆盖。 */
function matchListWhere(scope, filter, cursor) {
  const where = {
    schoolId: scope.schoolId, association: scope.association,
    teamA: { $type: 'array' }, teamB: { $type: 'array' },
    // 查询 $type 会检查数组元素，必须排除 status:[0] 这类畸形数据。
    status: { $type: 'number', $not: { $type: 'array' } },
    matchTime: { $exists: true, $nin: ['', null, false, 0] },
  };
  for (const key of ['pool', 'eventId']) {
    if (filter[key] !== undefined) where[key] = filter[key];
  }
  const and = [where];
  if (filter.status !== undefined) and.push({ status: filter.status });
  if (filter.userId) and.push({ $or: [{ teamA: filter.userId }, { teamB: filter.userId }] });
  if (cursor) and.push({ $or: [
    { matchTime: { $lt: cursor.matchTime } },
    { matchTime: cursor.matchTime, _id: { $lt: cursor.id } },
  ] });
  return and.length === 1 ? where : { $and: and };
}

function memoryMatchPage(docs, scope, { filter = {}, limit, offset = 0, cursor = null }) {
  const base = docs.filter(doc => isListMatch(doc) && doc.schoolId === scope.schoolId &&
    doc.association === scope.association &&
    (filter.pool === undefined || doc.pool === filter.pool) &&
    (!filter.eventId || doc.eventId === filter.eventId) &&
    (!filter.userId || doc.teamA.includes(filter.userId) || doc.teamB.includes(filter.userId)));
  const pendingCount = base.filter(doc => doc.status === MATCH_STATUS.PENDING).length;
  const rows = base.filter(doc => filter.status === undefined || doc.status === filter.status).sort(compareMatches);
  const remaining = cursor ? rows.filter(doc => compareMatches(doc, { matchTime: cursor.matchTime, _id: cursor.id }) > 0) : rows;
  const start = cursor ? 0 : offset;
  return { rows: remaining.slice(start, start + limit), total: rows.length, pendingCount,
    hasMore: remaining.length > start + limit };
}

module.exports = { isListMatch, listFilter, matchListWhere, memoryMatchPage };
