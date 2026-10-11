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
const { canManage } = require('../../lib/services/permission.js');
const { liveKey, liveScoreOf } = require('../../lib/services/live-score.js');
const { seasonPairCounts } = require('../../lib/services/rating-cap.js');
const { getPoolRating } = require('../../lib/utils/rating.js');
const {
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
  RANK_PROJECT_CONFIG,
  MATCH_STATUS,
  RATED_PAIR_LIMIT,
} = require('../../lib/utils/constants.js');
const {
  buildProjectLeaderboard,
  buildProgressLeaderboard,
  percentileFromBoard,
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

/**
 * 名单里不带账号凭据与联系方式。
 *
 * 【为什么必须摘掉】
 * 会员名单是任何人都能拉取的公开数据。openId 是账号的唯一识别凭证，
 * phone 是联系方式——它们对榜单、选手选择器、会员主页都没有用处，一旦
 * 随名单下发，等于把全俱乐部的联系方式与账号标识交到任何人手里。摘掉
 * 之后页面用到的字段（昵称、头像、学院、性别、分数）一个不少。
 */
const PRIVATE_MEMBER_FIELDS = ['openId', 'phone'];

/**
 * 复制一份会员记录并摘掉隐私字段。
 * @param {Object} user
 * @returns {Object}
 */
function publicMember(user) {
  const copy = { ...user };
  for (const field of PRIVATE_MEMBER_FIELDS) delete copy[field];
  return copy;
}

/**
 * 当前登录会员。云端就是 OpenID 对应的那一位。
 *
 * 【为什么额外下发 isGlobalAdmin】ctx.actor.role 已被换成**本协会的有效
 * 角色**（协会负责人在本协会内也算 ADMIN），前端据此分不清「全局管理员」
 * 与「协会负责人」。而任免协会负责人只认全局管理员（见 role-handlers），
 * 前端要决定那个入口显不显示，就必须知道这个身份。故把 ctx.isGlobalAdmin
 * 一并下发；它是账号的全局属性，不随协会变化。
 */
async function getCurrentUser(payload, ctx) {
  if (!ctx.actor) return ok(null);
  return ok({ ...ctx.actor, isGlobalAdmin: Boolean(ctx.isGlobalAdmin) });
}

async function getMembers(payload, ctx) {
  const { members } = await getDataset(ctx);
  return ok(members.map(publicMember));
}

/**
 * 单个会员。
 *
 * 【申请为什么要分权限】
 * 会员主页与审核页都会按编号取一个人。正式会员的资料对所有人可见，
 * 但「申请」里带着学号与手机号：干部要审，申请人本人要确认审核结果，
 * 其余人没有理由拿到——所以只有干部与本人能取到申请，别人一律得到
 * 「查无此人」，与真的不存在表现一致，不泄露「这里有个申请人」。
 */
async function getMember(payload, ctx) {
  const { members, applications } = await getDataset(ctx);
  const { userId } = payload;

  const member = members.find((user) => user._id === userId);
  if (member) return ok(publicMember(member));

  const application = applications.find((user) => user._id === userId);
  if (!application) return ok(null);
  // 「是不是本人」认 OpenID，而不是 ctx.actorId：后者是在这次调用开始时
  // 按 OpenID 查出来的快照，刚提交申请的人当时还没有账号。
  const isSelf =
    (ctx.actorId && ctx.actorId === userId) ||
    (ctx.openId && application.openId === ctx.openId);
  if (canManage(ctx.actor) || isSelf) return ok(application);
  return ok(null);
}

/**
 * 入会申请名单。
 *
 * 【为什么非干部只看到自己那一条】
 * 申请里是实名、学号、手机号。审核页早在取数之前就挡住了没权限的人
 * （见 member-review-view），但接口不能只靠调用方自觉：普通会员直接调
 * 这个 action 就能把全俱乐部的申请人资料拉走。干部看全部，非干部只看
 * 自己的一条——申请人确认「我的申请到哪一步了」要用它。
 */
async function getMemberApplications(payload, ctx) {
  const { applications } = await getDataset(ctx);
  if (canManage(ctx.actor)) return ok(applications);
  // 同上：认 OpenID 而不是 ctx.actorId，刚提交申请的人才拿得到自己那一条
  if (!ctx.openId) return ok([]);
  return ok(applications.filter((item) => item.openId && item.openId === ctx.openId));
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
  // buildProjectLeaderboard 已经排好序，直接读百分位，不必再排一遍
  return ok(percentileFromBoard(buildProjectLeaderboard(users, project), userId));
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
 * 某位会员本赛季与每个人的交手场次，给录分页的选对手面板用。
 *
 * 【为什么读台账而不是 matches】
 * 面板上的数字必须与提交闸门数的同一个口径，否则用户会「按显示的数字录到
 * 第 15 场却被拦下」。闸门按完整台账算（待确认的场次也占名额），这里
 * 就也得按台账算——matches 是已生效的流水，会少算待确认的那几场。
 *
 * 【为什么不像 getHeadToHead 那样顺手给名字】
 * 面板手里本来就有完整会员名单（它按名单渲染），再来一份名称只是多一处
 * 可能对不上的副本。这里只给数字。
 */
async function getSeasonPairCounts(payload = {}, ctx) {
  const { userId } = payload;
  const { ledger, meta } = await getDataset(ctx);
  return ok({
    counts: seasonPairCounts(userId, ledger, { seasonStart: meta.resetTime }),
    limit: RATED_PAIR_LIMIT,
  });
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
    const stats = percentileFromBoard(board, userId);

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
 * 给台账记录并入实时比分（正在逐球计分的那一场）。
 *
 * 与 mock.js 的 attachLive 同一形状：没有实时态就原样返回，不凭空多出
 * 字段——既有的台账断言逐字节不受影响。
 *
 * 【为什么只查待确认的那些】
 * 实时台只在待确认的比赛上开（见 live-handlers.liveTarget），已生效 /
 * 已作废的根本不会有实时态。于是按状态先筛一遍，读取次数就跟着「正在
 * 打的那几场」走，而不是跟着整份台账的长度走。
 *
 * @param {Array<Object>} records
 * @param {Object} ctx
 * @returns {Promise<Array<Object>>}
 */
async function attachLive(records, ctx) {
  const candidates = records.filter((record) => record.status === MATCH_STATUS.PENDING);
  if (candidates.length === 0) return records;

  const states = await Promise.all(
    candidates.map((record) => ctx.repo.liveScores.getById(liveKey(record._id)))
  );
  if (!states.some(Boolean)) return records;

  const byMatch = new Map(
    states.filter(Boolean).map((state) => [state.matchId, state])
  );
  return records.map((record) => {
    const state = byMatch.get(record._id);
    return state ? { ...record, live: liveScoreOf(state) } : record;
  });
}

/**
 * 比赛台账，含待确认与已撤销的那些，专供比赛页做流转。
 * 抽签生成的待确认比赛只在这里出现——getMatches 是成绩公示，不收未生效的。
 *
 * id 用来取单独一场：录入页要按编号把比分写回抽签排好的那条，得先读到它。
 * 走这个接口而不是另开一个「取一场」，是为了让鉴权与取数口径只有一处。
 *
 * @param {Object} payload { id, userId, eventId, status, limit }
 */
async function getMatchRecords(payload = {}, ctx) {
  const { id, userId, eventId, status, limit } = payload;
  const { ledger } = await getDataset(ctx);

  let list = id ? ledger.filter((m) => m._id === id) : ledger;
  if (userId) list = list.filter((m) => [...m.teamA, ...m.teamB].includes(userId));
  if (eventId) list = list.filter((m) => m.eventId === eventId);
  // 0（待确认）是合法取值，只能判类型，不能用真值判断
  if (typeof status === 'number') list = list.filter((m) => m.status === status);

  list = [...list].sort((a, b) => new Date(b.matchTime) - new Date(a.matchTime));
  if (typeof limit === 'number' && limit >= 0) list = list.slice(0, limit);
  return ok(await attachLive(list, ctx));
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
  getSeasonPairCounts,
  getMyProjects,
  getHomeSummary,
  getMatchRecords,
};
