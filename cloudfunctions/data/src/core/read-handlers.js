/**
 * 只读接口
 * ============================================================
 * 每个处理器都是 mock.js 里同名函数的云端翻版：同样的筛选、同样的排序、
 * 同样的返回形状。页面只认形状，形状一致，切数据源才不用改页面。
 *
 * 所有读操作都建立在 derive.getDataset() 给出的数据集上——等级分与积分
 * 已经在那一层由回放算好了。
 * ============================================================
 */

const { ok } = require('../envelope.js');
const { getDataset } = require('./derive.js');
const { getPoolRating } = require('../../lib/utils/rating.js');
const {
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
  RANK_PROJECT_CONFIG,
} = require('../../lib/utils/constants.js');
const {
  buildProjectLeaderboard,
  buildProgressLeaderboard,
  calculatePercentile,
  resolveProject,
  selectProjectUsers,
} = require('../../lib/utils/leaderboard.js');
const {
  buildHeadToHead,
  buildPartnerRecord,
  buildMatchHistory,
  buildRatingHistory,
  buildEventRecord,
  summarizeEvents,
  summarizeForm,
} = require('../../lib/utils/stats.js');

/**
 * 把某个榜单项目的分数摊平成进步榜需要的形状。
 * 从未在对应池里出过场的人没有「起点」，直接排除。
 * @param {Array<Object>} users
 * @param {string} project
 * @returns {Array<Object>}
 */
function progressEntries(users, project) {
  const { pool } = resolveProject(project);

  return selectProjectUsers(users, project)
    .map((user) => {
      const bucket = getPoolRating(user, pool);
      return {
        _id: user._id,
        nickName: user.nickName,
        avatarUrl: user.avatarUrl,
        startElo: bucket.startElo,
        currentElo: bucket.elo,
        matchCount: bucket.matchCount,
      };
    })
    .filter((entry) => entry.matchCount > 0);
}

/* ---------- 会员 ---------- */

/** 当前登录会员。云端就是 OpenID 对应的那一位。 */
async function getCurrentUser(payload, ctx) {
  return ok(ctx.actor || null);
}

async function getMembers(payload, ctx) {
  const { members } = await getDataset(ctx);
  return ok(members);
}

/**
 * 单个会员。会员名单与申请名单都找一遍：审核页要解析申请人的头像昵称，
 * 会员主页也可能指向一位还没转正的人。
 */
async function getMember(payload, ctx) {
  const { members, applications } = await getDataset(ctx);
  const { userId } = payload;
  return ok(
    members.find((user) => user._id === userId) ||
      applications.find((user) => user._id === userId) ||
      null
  );
}

async function getMemberApplications(payload, ctx) {
  const { applications } = await getDataset(ctx);
  return ok(applications);
}

/* ---------- 比赛与赛事 ---------- */

/**
 * 比赛流水。只含「已生效、已回放」的比赛，是面向所有人的成绩公示。
 * @param {Object} payload { userId, pool, eventId, limit }
 */
async function getMatches(payload = {}, ctx) {
  const { userId, pool, eventId, limit } = payload;
  const { matches } = await getDataset(ctx);

  let list = matches;
  if (userId) list = list.filter((m) => [...m.teamA, ...m.teamB].includes(userId));
  if (pool) list = list.filter((m) => m.pool === pool);
  if (eventId) list = list.filter((m) => m.eventId === eventId);

  list = [...list].sort((a, b) => new Date(b.matchTime) - new Date(a.matchTime));
  return ok(typeof limit === 'number' && limit >= 0 ? list.slice(0, limit) : list);
}

async function getEvents(payload, ctx) {
  const { events } = await getDataset(ctx);
  return ok(events);
}

/* ---------- 公告 ---------- */

async function getAnnouncements(payload, ctx) {
  const { announcements } = await getDataset(ctx);
  return ok(announcements);
}

/** 公告台账，含已下架的。与 getAnnouncements 刻意分开。 */
async function getAnnouncementRecords(payload, ctx) {
  const { announcementLedger } = await getDataset(ctx);
  return ok(announcementLedger);
}

/* ---------- 榜单 ---------- */

async function getLeaderboard(payload = {}, ctx) {
  const { project, options = {} } = payload;
  const { users } = await getDataset(ctx);
  return ok(buildProjectLeaderboard(users, project, options));
}

async function getProgressLeaderboard(payload = {}, ctx) {
  const { project, options = {} } = payload;
  const { users } = await getDataset(ctx);
  return ok(buildProgressLeaderboard(progressEntries(users, project), options));
}

async function getPercentile(payload = {}, ctx) {
  const { userId, project } = payload;
  const { users } = await getDataset(ctx);
  return ok(calculatePercentile(buildProjectLeaderboard(users, project), userId));
}

/* ---------- 个人战绩 ---------- */

async function getMatchHistory(payload = {}, ctx) {
  const { userId, options = {} } = payload;
  const { matches, nameOf } = await getDataset(ctx);
  return ok(buildMatchHistory(matches, userId, { nameOf, ...options }));
}

async function getHeadToHead(payload = {}, ctx) {
  const { userId, options = {} } = payload;
  const { matches, nameOf } = await getDataset(ctx);
  return ok(buildHeadToHead(matches, userId, { nameOf, ...options }));
}

async function getPartnerRecord(payload = {}, ctx) {
  const { userId, options = {} } = payload;
  const { matches, nameOf } = await getDataset(ctx);
  return ok(buildPartnerRecord(matches, userId, { nameOf, ...options }));
}

async function getEventRecord(payload = {}, ctx) {
  const { userId, options = {} } = payload;
  const { events } = await getDataset(ctx);
  const records = buildEventRecord(events, userId, options);
  return ok({ records, summary: summarizeEvents(records) });
}

async function getRatingHistory(payload = {}, ctx) {
  const { userId, pool } = payload;
  const { matches } = await getDataset(ctx);
  return ok(buildRatingHistory(matches, userId, pool));
}

async function getForm(payload = {}, ctx) {
  const { userId, options = {} } = payload;
  const { matches } = await getDataset(ctx);
  return ok(summarizeForm(matches, userId, options));
}

/**
 * 「我的」顶部卡片：各项目的分数、排名与百分位。
 * 只返回打过球的项目——没打过就展示初始分，只会让人误以为自己很差。
 */
async function getMyProjects(payload = {}, ctx) {
  const { userId } = payload;
  const { users } = await getDataset(ctx);
  const member = users.find((user) => user._id === userId);
  if (!member) return ok([]);

  const result = [];
  for (const project of ALL_RANK_PROJECTS) {
    const { pool, gender } = RANK_PROJECT_CONFIG[project];
    if (gender && member.gender !== gender) continue;

    const bucket = getPoolRating(member, pool);
    if (bucket.matchCount === 0) continue;

    const board = buildProjectLeaderboard(users, project);
    const stats = calculatePercentile(board, userId);

    result.push({
      project,
      pool,
      label: RANK_PROJECT_LABEL[project],
      elo: bucket.elo,
      startElo: bucket.startElo,
      delta: bucket.elo - bucket.startElo,
      matchCount: bucket.matchCount,
      wins: bucket.wins,
      losses: bucket.losses,
      rank: stats ? stats.rank : null,
      total: stats ? stats.total : board.length,
      beatPercent: stats ? stats.beatPercent : 0,
    });
  }

  return ok(result.sort((a, b) => b.matchCount - a.matchCount));
}

/** 首页概览：几个数字 + 各项目榜首 */
async function getHomeSummary(payload, ctx) {
  const { users, members, matches, events, meta } = await getDataset(ctx);

  const topByProject = {};
  for (const project of ALL_RANK_PROJECTS) {
    const board = buildProjectLeaderboard(users, project).filter((row) => row.matchCount > 0);
    topByProject[project] = {
      label: RANK_PROJECT_LABEL[project],
      top: board.slice(0, 3),
      playerCount: board.length,
    };
  }

  return ok({
    // 会员数钉在审核通过的人上：申请中的还没算数
    memberCount: members.length,
    matchCount: matches.length,
    eventCount: events.length,
    seasonRange: { from: meta.firstMatchTime, to: meta.lastMatchTime },
    topByProject,
  });
}

/* ---------- 比赛台账 ---------- */

/**
 * 比赛台账，含待确认与已撤销的那些，专供比赛页做流转。
 * @param {Object} payload { userId, status, limit }
 */
async function getMatchRecords(payload = {}, ctx) {
  const { userId, status, limit } = payload;
  const { ledger } = await getDataset(ctx);

  let list = ledger;
  if (userId) list = list.filter((m) => [...m.teamA, ...m.teamB].includes(userId));
  // 0（待确认）是合法取值，只能判类型，不能用真值判断
  if (typeof status === 'number') list = list.filter((m) => m.status === status);

  list = [...list].sort((a, b) => new Date(b.matchTime) - new Date(a.matchTime));
  return ok(typeof limit === 'number' && limit >= 0 ? list.slice(0, limit) : list);
}

module.exports = {
  getCurrentUser,
  getMembers,
  getMember,
  getMemberApplications,
  getMatches,
  getEvents,
  getAnnouncements,
  getAnnouncementRecords,
  getLeaderboard,
  getProgressLeaderboard,
  getPercentile,
  getMatchHistory,
  getHeadToHead,
  getPartnerRecord,
  getEventRecord,
  getRatingHistory,
  getForm,
  getMyProjects,
  getHomeSummary,
  getMatchRecords,
};
