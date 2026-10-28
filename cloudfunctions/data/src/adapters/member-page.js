const { COLLECTIONS } = require('../repository.js');
const { normalizeKeyword, decodeCursor, encodeCursor, sortKey } = require('../../lib/services/association-member.js');
const { directorySortText } = require('../../lib/services/account-directory.js');

/** Database-side join and pagination. Only the current page leaves the database. */
async function readMemberPage(db, command, scope, query = {}) {
  const $ = command.aggregate;
  const keyword = normalizeKeyword(query.keyword);
  const limit = Math.max(1, Math.min(Number(query.limit) || 20, 50));
  const cursor = decodeCursor(query.cursor);
  const after = cursor && [cursor[0], directorySortText(cursor[1]), directorySortText(cursor[2]), cursor[3]];
  const rowsOf = result => result.list || result.data || [];
  const base = () => db.collection(COLLECTIONS.schoolMembers).aggregate()
    .match({ schoolId: scope.schoolId, status: 'active',
      ...(typeof query.collegeId === 'string' && query.collegeId ? { collegeId: query.collegeId } : {}) })
    .lookup({ from: COLLECTIONS.users, localField: 'userId', foreignField: '_id', as: 'account' })
    .unwind('$account')
    .match({ 'account.platformStatus': 'active', 'account.primarySchoolId': scope.schoolId });
  // Bring an invalid legacy row to the front of the SAME query; no second full-school join.
  const ready = $.and([$.eq(['$account.directoryVersion', 1]), ...[
    'directoryNickName', 'directoryRealName', 'directoryNickSort', 'directoryRealSort',
  ].map(field => $.neq([$.ifNull([`$account.${field}`, null]), null]))]);
  let page = base().project({ _id: 0, userId: 1, collegeId: $.ifNull(['$collegeId', '']),
    nickName: $.ifNull(['$account.nickName', '']), realName: $.ifNull(['$account.realName', '']),
    avatarUrl: $.ifNull(['$account.avatarUrl', '']),
    invalid: $.cond({ if: ready, then: 0, else: 1 }),
    searchNick: $.ifNull(['$account.directoryNickName', '']), searchReal: $.ifNull(['$account.directoryRealName', '']),
    sortNick: $.ifNull(['$account.directoryNickSort', '']), sortReal: $.ifNull(['$account.directoryRealSort', '']) });
  if (keyword) {
    page = page.addFields({ nickIndex: $.indexOfCP(['$searchNick', $.literal(keyword)]),
      realIndex: $.indexOfCP(['$searchReal', $.literal(keyword)]) })
      .match({ $or: [{ invalid: 1 }, { nickIndex: { $gte: 0 } }, { realIndex: { $gte: 0 } }] })
      .addFields({ prefixRank: $.cond({ if: $.or([$.eq(['$nickIndex', 0]), $.eq(['$realIndex', 0])]), then: 0, else: 1 }) });
  } else page = page.addFields({ prefixRank: $.literal(0) });
  const fields = ['prefixRank', 'sortNick', 'sortReal', 'userId'];
  if (after) page = page.match({ $or: [{ invalid: 1 }, ...fields.map((field, index) => Object.fromEntries([
    ...fields.slice(0, index).map((earlier, i) => [earlier, after[i]]), [field, { $gt: after[index] }],
  ]))] });
  const rows = rowsOf(await page.sort({ invalid: -1, prefixRank: 1, sortNick: 1, sortReal: 1, userId: 1 })
    .limit(limit + 1).project({ _id: 0, invalid: 1, userId: 1, nickName: 1, realName: 1, avatarUrl: 1, collegeId: 1 }).end());
  if (rows.some(row => row.invalid)) throw new Error('会员搜索字段未回填，请先完成账号目录迁移');
  const members = rows.slice(0, limit).map(({ invalid, ...member }) => member);
  const hasMore = rows.length > limit;
  return { members, hasMore, keyword,
    nextCursor: hasMore ? encodeCursor(sortKey(members[members.length - 1], keyword)) : '' };
}
module.exports = { readMemberPage };
