/**
 * 首页的视图模型
 * ============================================================
 * 首页要做三块内容，全部在这里取数、整形、算文案：
 *   1. 公告栏——置顶在前，其余按时间倒序
 *   2. 最近比赛——把队里的会员编号换成昵称，比分按局配对
 *   3. 我的分数卡片——当前登录会员的各项目分数与排名（单打在前）
 *
 * 【为什么要传 sessionUser 而不是自己去取】
 * 「我登录了没有」这件事由页面层从全局登录态判断（app.globalData）。
 * 这里只负责把传进来的那个人渲染好；传空对象就渲染「未登录」引导。
 * 这样一来，这个模块不碰 wx API，可以在 Node 里完整测试。
 *
 * 【为什么最近比赛要另取会员名单】
 * 比赛记录里存的是 teamA / teamB 的会员编号，不是昵称。直接显示
 * 「u03 战胜 u07」没法看。这里一次性取回全体会员建一张编号到昵称的
 * 映射表，避免每场比赛各查一次。
 * ============================================================
 */

const { RATING_POOL_LABEL } = require('../utils/constants.js');
const {
  formatDate,
  formatSigned,
  formatElo,
  formatPercent,
  formatRank,
  formatScore,
} = require('../utils/format.js');
const { sortProjectsForDisplay } = require('../utils/leaderboard.js');
// 公告排序与公告列表页共用一份，避免首页和列表页各写一套、慢慢分叉
const { sortAnnouncements } = require('./announcement.js');
const {
  getAnnouncements,
  getMatches,
  getMembers,
  getMyProjects,
  getForm,
  getHomeSummary,
} = require('./index.js');

/** 首页默认展示的公告与比赛条数。太多会把首屏撑得很长。 */
const DEFAULT_ANNOUNCEMENT_LIMIT = 3;
const DEFAULT_MATCH_LIMIT = 5;
/** 近期状态的圆点个数 */
const FORM_LIMIT = 5;

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

/**
 * 整形一场最近比赛。
 *
 * @param {Object} match 比赛记录
 * @param {Function} nameOf 会员编号 → 昵称
 * @returns {Object}
 */
function buildMatchRow(match, nameOf) {
  const namesOf = (team) => team.map((id) => nameOf(id)).join(' / ');
  const teamAName = namesOf(match.teamA);
  const teamBName = namesOf(match.teamB);

  return {
    matchId: match._id,
    dateText: formatDate(match.matchTime),
    poolLabel: RATING_POOL_LABEL[match.pool] || '',
    isEvent: Boolean(match.eventId),
    teamAName,
    teamBName,
    teamAWon: match.winner === 'A',
    // 逐局比分，如「11:9  12:10」；并列两排数字很难读，配对后才像比分
    scoreText: formatScore(match.scoreA, match.scoreB),
  };
}

/**
 * 整形我的一项分数。
 * @param {Object} item getMyProjects 的单项
 * @returns {Object}
 */
function buildScoreRow(item) {
  return {
    project: item.project,
    label: item.label,
    elo: formatElo(item.elo),
    deltaText: formatSigned(item.delta),
    deltaUp: item.delta >= 0,
    matchCount: item.matchCount,
    recordText: `${item.wins} 胜 ${item.losses} 负`,
    rankText: formatRank(item.rank, item.total),
    beatText: `超过 ${formatPercent(item.beatPercent / 100)} 的会员`,
  };
}

/**
 * 装载首页数据。
 *
 * @param {Object|null} sessionUser 当前登录会员（app.globalData.userInfo）
 * @param {Object} [options]
 * @param {number} [options.announcementLimit]
 * @param {number} [options.matchLimit]
 * @returns {Promise<Object>}
 */
async function loadHomeView(sessionUser, options = {}) {
  const {
    announcementLimit = DEFAULT_ANNOUNCEMENT_LIMIT,
    matchLimit = DEFAULT_MATCH_LIMIT,
  } = options;

  const [announcements, matches, members, summary] = await Promise.all([
    getAnnouncements(),
    getMatches({ limit: matchLimit }),
    getMembers(),
    getHomeSummary(),
  ]);

  const nameById = Object.create(null);
  for (const member of members) {
    nameById[member._id] = member.nickName;
  }
  // 查不到昵称时退回编号本身，宁可显示 u07 也不要显示 undefined
  const nameOf = (id) => nameById[id] || id;

  const ordered = sortAnnouncements(announcements);

  return {
    announcements: {
      rows: ordered.slice(0, announcementLimit).map(buildAnnouncementRow),
      total: announcements.length,
      hasMore: announcements.length > announcementLimit,
    },
    recentMatches: matches.map((match) => buildMatchRow(match, nameOf)),
    summary: {
      memberCount: summary.memberCount,
      matchCount: summary.matchCount,
      eventCount: summary.eventCount,
      seasonText: `${formatDate(summary.seasonRange.from)} — ${formatDate(summary.seasonRange.to)}`,
    },
    scoreCard: await buildScoreCard(sessionUser),
  };
}

/**
 * 组装「我的分数卡片」。
 *
 * 未登录时返回 { hasUser:false }，页面据此显示登录引导，而不是
 * 拿演示会员的数据冒充「我的」。
 *
 * @param {Object|null} sessionUser
 * @returns {Promise<Object>}
 */
async function buildScoreCard(sessionUser) {
  if (!sessionUser || !sessionUser._id) {
    return { hasUser: false };
  }

  const [projects, form] = await Promise.all([
    getMyProjects(sessionUser._id).then(sortProjectsForDisplay),
    getForm(sessionUser._id, { limit: FORM_LIMIT }),
  ]);

  return {
    hasUser: true,
    user: {
      userId: sessionUser._id,
      nickName: sessionUser.nickName || '会员',
      avatarUrl: sessionUser.avatarUrl || '',
      avatarText: (sessionUser.nickName || '会').slice(0, 1),
    },
    projects: projects.map(buildScoreRow),
    // 新注册、尚未打过球的人没有任何项目，给一句说明比空白卡片友好
    hasProjects: projects.length > 0,
    form: {
      dots: form.results.map((isWin) => (isWin ? 'W' : 'L')),
      streakText: form.streak > 0 ? `${form.streak} 连胜` : '暂无连胜',
    },
  };
}

module.exports = {
  DEFAULT_ANNOUNCEMENT_LIMIT,
  DEFAULT_MATCH_LIMIT,
  FORM_LIMIT,
  sortAnnouncements,
  buildAnnouncementRow,
  buildMatchRow,
  buildScoreRow,
  buildScoreCard,
  loadHomeView,
};
