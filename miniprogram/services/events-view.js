/**
 * 赛事页的视图模型
 * ============================================================
 * 和 rank-view.js 同样的思路：取数、整形、算文案都在这里，页面只管渲染。
 * 本模块不碰任何 wx API，可以在 Node 里测。
 *
 * 【这一页为什么只有一张积分榜】
 * 策划书把两把尺子分到了两个界面：
 *   「排行榜」tab —— 等级分榜，谁强谁在前
 *   「赛事」tab   —— 赛季积分榜，谁投入谁在前
 * 分开是因为两者回答的是不同的问题。等级分是零和的，一场比赛有人涨就
 * 有人跌；积分却是只增不减的投入记录。混在一页里，用户会拿积分去比实力。
 *
 * 【为什么只统计本赛季】
 * 积分每赛季清零（2.6）。榜单要跟「这个赛季谁最活跃」对得上，就不能
 * 把上个赛季的分带进来。赛季分界由 replay 引擎在回放时处理，这里拿到的
 * `points` 已经是本赛季口径，直接排即可。
 *
 * 【为什么没有双打】
 * 决策 3：双打比赛与双打赛事都不计分。分池里根本不会出现双打带来的分，
 * 所以这里不需要专门过滤——但要靠事件计数过滤双打赛事，见 countEvents。
 * ============================================================
 */

const { MATCH_TYPE, EVENT_STATUS } = require('../utils/constants.js');
const { buildLeaderboard } = require('../utils/leaderboard.js');
const { formatDate, formatPercent } = require('../utils/format.js');
const { getCurrentUser, getMembers, getEvents, getSeasonState } = require('./index.js');

/** 前三名的奖牌样式，其余为空字符串（不额外装饰） */
const MEDALS = ['gold', 'silver', 'bronze'];

/**
 * 名次对应的奖牌。
 * @param {number} rank
 * @returns {string} 'gold' | 'silver' | 'bronze' | ''
 */
function medalOf(rank) {
  return MEDALS[rank - 1] || '';
}

/** 没有头像时用昵称首字占位 */
function avatarOf(nickName) {
  return (nickName || '?').slice(0, 1);
}

/**
 * 统计每位会员参加过几场「计入积分」的赛事。
 *
 * 计入积分 = 单打 + 已结束（决策 3、9）。双打赛事与没结束的赛事都不算，
 * 免得榜单上一行写「打了 3 场」却只对应 2 分的怪账。
 *
 * @param {Array<Object>} events 赛事列表
 * @returns {Map<string, number>} 会员编号 → 场次
 */
function countEvents(events) {
  const counts = new Map();
  for (const event of events || []) {
    if (event.matchType === MATCH_TYPE.DOUBLES) continue;
    if (event.status !== EVENT_STATUS.FINISHED) continue;
    for (const result of event.results || []) {
      counts.set(result.userId, (counts.get(result.userId) || 0) + 1);
    }
  }
  return counts;
}

/**
 * 一句话说清当前赛季的起止。
 *
 * @param {Object} season getSeasonState 的结果
 * @returns {string}
 */
function describeSeason(season = {}) {
  const parts = [];
  if (season.anchorTime) parts.push(`自 ${formatDate(season.anchorTime)} 起`);
  if (season.resetTime) parts.push(`${formatDate(season.resetTime)} 已重置`);
  if (parts.length === 0) return '当前赛季';
  return `本赛季${parts.join('，')}`;
}

/**
 * 把会员列表排成积分榜并整形成页面上的行。
 *
 * 【为什么在这里过滤掉没积分的会员】
 * 一场没打过的人积分是 0，直接展示会让榜尾挂着一排 0 分的账号。
 * 积分榜问的是「谁投入」，0 分的人答不上这个问题，榜上不该有他们。
 * 过滤后名次会空档，所以重新编号。
 *
 * @param {Array<Object>} users 会员列表，需含 _id / nickName / points
 * @param {Map<string, number>} eventCounts 会员编号 → 参赛场次
 * @param {string|null} myId 当前登录会员，用于高亮「我」那一行
 * @returns {Array<Object>} 已排序、已编号、已整形的行
 */
function buildPointsRows(users, eventCounts, myId) {
  const entries = (Array.isArray(users) ? users : [])
    .filter((user) => (user.points || 0) > 0)
    .map((user) => ({
      _id: user._id,
      nickName: user.nickName,
      avatarUrl: user.avatarUrl || '',
      points: user.points || 0,
    }));

  // sortBy: 'points' 这条路 leaderboard.js 早就写好了，只是从没接上线
  return buildLeaderboard(entries, { sortBy: 'points' }).map((row) => {
    const count = eventCounts.get(row._id) || 0;
    return {
      userId: row._id,
      rank: row.rank,
      medal: medalOf(row.rank),
      isMe: row._id === myId,
      nickName: row.nickName,
      avatarText: avatarOf(row.nickName),
      avatarUrl: row.avatarUrl || '',
      detailText: `${count} 场赛事`,
      valueText: String(row.points),
      noteText: '赛季积分',
    };
  });
}

/**
 * 装载赛事页的全部数据。
 *
 * @returns {Promise<Object>}
 */
async function loadEventsView() {
  const [me, members, events, season] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
    getSeasonState(),
  ]);

  const myId = me ? me._id : null;
  const rows = buildPointsRows(members, countEvents(events), myId);
  const myRow = (myId && rows.find((row) => row.isMe)) || null;

  return {
    seasonText: describeSeason(season),
    rows,
    playerCountText: `${rows.length} 人上榜`,
    empty: rows.length === 0,
    emptyNote: '本赛季还没有人拿到积分，参加一次赛事就能上榜',
    me:
      myRow === null
        ? null
        : {
            rank: myRow.rank,
            total: rows.length,
            beatText: `超过 ${formatPercent((rows.length - myRow.rank) / rows.length)} 的会员`,
          },
    meHint: myRow === null ? '本赛季还没有积分，参加一次赛事就能上榜' : '',
  };
}

module.exports = {
  MEDALS,
  medalOf,
  avatarOf,
  countEvents,
  describeSeason,
  buildPointsRows,
  loadEventsView,
};
