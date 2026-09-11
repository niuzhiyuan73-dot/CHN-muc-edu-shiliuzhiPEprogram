/**
 * 本地模拟数据源
 * ============================================================
 * 与 cloud.js 实现同一套接口，但数据来自内存：
 *   generateSeed() 造出比赛流水  →  replaySeason() 推出等级分
 *
 * 有了它，在拿到 AppID、开通云开发之前就能把每一个页面做完并调好，
 * 不必等后端就绪。切到云端时只改 services/index.js 里的一行。
 *
 * 【为什么接口全是 async】
 * 云端请求天然是异步的。如果本地版写成同步的，页面里就会写出
 * 「本地能跑、上云就散」的取值代码。统一成 Promise，两边行为一致。
 *
 * 【惰性加载】
 * 生成 + 回放约 600 场要几十毫秒。放在模块加载时执行会拖慢小程序
 * 冷启动，而首屏未必马上要这些数据，所以推迟到第一次调用时再做。
 * ============================================================
 */

const { generateSeed } = require('./seed.js');
const { replaySeason } = require('./replay.js');
const matchStore = require('./match-store.js');
const userStore = require('./user-store.js');
const announcementStore = require('./announcement-store.js');
const eventStore = require('./event-store.js');
const profileStore = require('./profile-store.js');
const seasonStore = require('./season-store.js');
const { register: registerAccount } = require('./auth.js');
const { DEFAULT_RESET_POLICY, canResetSeason } = require('./season.js');
const { REVIEW_ACTION, validateReview } = require('./member-review.js');
const {
  canConfirm,
  canRevoke,
  buildMatchRecord,
  fillScheduledMatch,
  isParticipant,
} = require('./match-record.js');
const { canPublish, buildAnnouncementRecord } = require('./announcement.js');
const {
  canManageEvent,
  canStartEvent,
  canCheckIn,
  canFinishEvent,
  canDrawEvent,
  canSignUp,
  canCancelSignup,
  // 与 utils/stats.js 的「个人赛事战绩」buildEventRecord 同名，这里改个名字
  buildEventRecord: buildEventDraft,
  buildSignupRecord,
  buildCheckInPatch,
  validatePlacements,
} = require('./event.js');
const {
  planDraw,
  buildDrawRecord,
  buildBracketMatches,
  planNextRound,
  buildRoundMatches,
  drawnEntryCount,
  canRedraw,
} = require('./draw.js');
const { buildProfilePatch } = require('./profile.js');
const { getPoolRating } = require('../utils/rating.js');
const {
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
  RANK_PROJECT_CONFIG,
  MATCH_STATUS,
  MATCH_TYPE,
  USER_STATUS,
  ANNOUNCEMENT_STATUS,
  EVENT_STATUS,
  SIGNUP_STATUS,
  ROLE,
  isMemberStatus,
} = require('../utils/constants.js');
const {
  buildProjectLeaderboard,
  buildProgressLeaderboard,
  calculatePercentile,
  resolveProject,
  selectProjectUsers,
} = require('../utils/leaderboard.js');
const {
  createNameResolver,
  buildHeadToHead,
  buildPartnerRecord,
  buildMatchHistory,
  buildRatingHistory,
  buildEventRecord,
  summarizeEvents,
  summarizeForm,
} = require('../utils/stats.js');

/**
 * 模拟登录时使用的会员编号。
 *
 * 刻意选一位中游会员（赵明宇，男单与双打都排在第 6 名前后），而不是榜首。
 * 榜首的页面上看不到「进步」和「追赶」，两个池的排名也拉不开差距；
 * 用中游选手做默认视角，更容易看出界面有没有把故事讲清楚。
 */
const DEFAULT_CURRENT_USER_ID = 'u06';

/** 生成参数。改这里就能换一整套模拟数据。 */
const SEED_OPTIONS = {
  seed: 20260901,
  startDate: '2026-04-06',
  weeks: 20,
  casualPerWeek: 30,
};

let cache = null;

/**
 * 组装一份完整数据：种子 + 本地写入 → 回放 → 台账。
 *
 * 【顺序是这个函数存在的全部理由】
 *   1. 叠加：种子流水接上本次会话新录的比赛，再盖上改判（确认 / 驳回 / 撤销）。
 *      必须产出新对象——就地改种子会让 seed.test.js 的「全部已生效」断言
 *      随用例执行顺序飘移。
 *   2. 剔除：只有「已生效」的比赛能进回放。
 *   3. 台账：已生效的取回放结果（带 players 逐人明细），未生效的原样保留。
 *
 * 【第 2 步为什么必须是剔除而不是事后过滤】
 * 回放引擎会把每一场无条件改写成 ACTIVE（见 replay.js 的 runReplay），
 * 排序也不看 status。一场待确认的比赛只要进了回放，就会被静默激活并
 * 计入等级分——「对手确认」这道闸门等于没设。所以只能在这里挡住。
 *
 * 【为什么另开一个 ledger 而不是改 matches】
 * matches 的语义是「已生效、已回放」，首页、排行榜、我的、我的主页等
 * 7 处读取点都直接用它，且全都不看 status。只要保持它一成不变，
 * 那些地方就一行都不用改。未生效的比赛只有比赛页关心，走 ledger。
 *
 * 【会员从哪来：种子 + 审核通过的本地账号】
 * 待审核与已驳回的人不进回放名单。他们还没转正，不该拿等级分，也不该
 * 出现在录入页的选手选择器里——getMembers 只给这份名单，于是「待审核
 * 不能当选手」这一条不用在别处再写一遍。审核改判必须在分类之前生效，
 * 否则刚批过的账号这一拍仍会被当成待审核。
 *
 * 【为什么预计算 members / applications】
 * getMembers() 必须每次返回同一个数组引用（见 datasource.test.js 的
 * 「同一份数据被缓存复用」）。现算 filter 会让引用每次都变，所以分类
 * 只能在这里做一次。
 *
 * @returns {{users:Array, members:Array, applications:Array, matches:Array, events:Array, ledger:Array, meta:Object, nameOf:Function}}
 */
function buildCache() {
  const seed = generateSeed(SEED_OPTIONS);

  // 1. 本地账号：演示申请 + 本次会话注册的，逐条叠加审核改判
  const local = userStore.listAccounts();
  // 「在册」= 正常 + 已离校（见 constants.isMemberStatus）：离校的人历史比赛
  // 还在流水里，回放名单里少了他会直接抛错，所以仍要进回放；不上榜由
  // leaderboard.isRankable 把关，不在这里分家。
  const applications = local.filter((account) => !isMemberStatus(account.status));
  const approved = local.filter((account) => isMemberStatus(account.status));

  // 2. 比赛：种子流水接上本次会话新录的，再盖上改判（确认 / 驳回 / 撤销）
  const afterStore = seed.matches
    .concat(matchStore.listSubmitted())
    .map((match) => {
      const patch = matchStore.overrideOf(match._id);
      return patch ? { ...match, ...patch } : match;
    });

  const activeOnly = afterStore.filter((match) => match.status === MATCH_STATUS.ACTIVE);

  // 2.5 赛事：种子接上本次会话新发的，再盖上改判（开始 / 结束与名次）。
  //     与比赛同一套路数——把 override 作用于拼接后的整条数组，于是种子里的
  //     编号（e01……）同样能被改判。赛事是回放的输入：已结束的那些才会发积分
  //     （见 replay.applyEventPoints），所以必须先拼好再交给回放。
  const eventLedger = seed.events
    .concat(eventStore.listSubmitted())
    .map((event) => {
      const patch = eventStore.overrideOf(event._id);
      return patch ? { ...event, ...patch } : event;
    });

  // 2.6 报名记录：种子里的那场「报名中」赛事预置了几位报名者，把它们放进
  //     台账，报名列表才不是空的。台账里已有同一条就跳过——用户取消报名后
  //     记录会以「已取消」留在台账里，不能被种子再翻回「已报名」；而写操作
  //     会让缓存失效、下面这段每轮都会重跑，少了这个判断取消就白点了。
  for (const record of seed.signups || []) {
    if (!eventStore.findSignup(record.eventId, record.userId)) {
      eventStore.saveSignup(record);
    }
  }

  // 3. 回放名单 = 种子会员 + 已通过审核的本地账号。
  //    注意 replaySeason 的参数名是 members（不是 users）：它返回的
  //    replayed.users 才是「回放后的会员」。
  // 本次会话若做过赛季软重置，把分界点交给回放：引擎会在该处统一压分，
  // 并把起点分刷成压分后的值（见 replay.js 的 applySeasonReset）。
  const reset = seasonStore.getReset();

  const replayed = replaySeason({
    ...seed,
    members: seed.members.concat(approved),
    matches: activeOnly,
    // 赛事进回放：等级表决定赛事比赛用哪个 K，积分只发给已结束的那些
    events: eventLedger,
    options: {
      resetTime: reset ? reset.resetTime : null,
      resetPolicy: reset ? reset.policy : null,
    },
  });

  const replayedById = new Map(replayed.matches.map((match) => [match._id, match]));
  const ledger = afterStore.map((match) => replayedById.get(match._id) || match);

  // 4. 公告：种子接上本次会话新发的，再盖上改判（下架）。
  //    与比赛同一套路数——把 override 作用于拼接后的整条数组，
  //    于是种子里的编号（a01……）同样能被下架。
  const announcementLedger = seed.announcements
    .concat(announcementStore.listSubmitted())
    .map((item) => {
      const patch = announcementStore.overrideOf(item._id);
      return patch ? { ...item, ...patch } : item;
    })
    // 「最新的在前」是 getAnnouncements 的公开契约，不能指望新发的恰好
    // 就是最晚的：本地时钟可能落后，测试里也会注入固定的发布时间
    .sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));
  // 公开列表只给未下架的；管理台账要看到全部，包括已下架的。
  // 种子公告没有 status 字段，undefined !== ARCHIVED，天然通过。
  const announcements = announcementLedger.filter(
    (item) => item.status !== ANNOUNCEMENT_STATUS.ARCHIVED
  );

  // 5. 资料补丁：昵称与头像是会员自己改的，盖在回放结果之上。
  //    种子会员不在 user-store 里，所以补丁必须在这里盖。users 与 members
  //    必须是盖过补丁的同一份——否则 getCurrentUser（读 users）与
  //    getMembers（读 members）会在改完昵称后各说各话。分数、场次仍以回放
  //    结果为准，补丁只覆盖这两个字段（见 profile-store.js）。
  const patchProfile = (account) => {
    const patch = profileStore.patchOf(account._id);
    return patch ? { ...account, ...patch } : account;
  };
  const members = replayed.users.map(patchProfile);

  return {
    ...replayed,
    // replayed.users 已经过回放（分数、场次都是最新），再盖上资料补丁
    users: members,
    members,
    // 申请名单同样要盖：审核页要显示申请人改过的昵称头像
    applications: applications.map(patchProfile),
    ledger,
    // 放在 ...replayed 之后，盖掉种子原封不动带来的那份 announcements
    announcements,
    announcementLedger,
    nameOf: createNameResolver(members),
  };
}

/**
 * 加载（并缓存）模拟数据。
 * @returns {{users:Array, matches:Array, events:Array, ledger:Array, meta:Object, nameOf:Function}}
 */
function load() {
  if (!cache) cache = buildCache();
  return cache;
}

/**
 * 仅供测试使用：清掉缓存，让下次调用重新生成。
 *
 * 本地写入也要一并清掉：只清缓存的话，重新生成时会把上一轮录的比赛
 * 又叠回来，「重置」就成了假的。
 */
function resetCache() {
  cache = null;
  matchStore.reset();
  // 本地账号也要清：注册与审核改判同样属于「本次会话的临时写入」
  userStore.reset();
  // 本地公告同理：新发的与下架的改判都属于临时写入
  announcementStore.reset();
  // 本地赛事同理：新发的、开始/结束的改判、报名记录都属于临时写入。
  // 编号也要一起复位，否则测试里「第一场新赛事是 le0001」会随用例顺序飘移
  eventStore.reset();
  // 资料补丁同理：改过的昵称头像也是临时写入
  profileStore.reset();
  // 赛季重置同理：分界点必须一起清，否则下一轮生成的分数还是被压过的
  seasonStore.reset();
}

/**
 * 把某个排行榜项目的分数摊平成进步榜需要的形状。
 * 从未在对应池里出过场的人没有「起点」，直接排除。
 *
 * @param {Array<Object>} users
 * @param {string} project 排行榜项目（男单 / 女单 / 双打）
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

/* ---------- 只读接口 ---------- */

/** 当前登录会员。真实环境下由微信授权与后台审核共同确定。 */
async function getCurrentUser() {
  const { users } = load();
  return users.find((u) => u._id === DEFAULT_CURRENT_USER_ID) || users[0];
}

/**
 * 全部会员。只含审核通过的人——待审核、已驳回的账号不在里面，
 * 因而录入页的选手选择器天然选不到他们。
 */
async function getMembers() {
  return load().members;
}

/**
 * 单个会员。会员名单与申请名单都找一遍：审核页要能解析出申请人的
 * 头像昵称，会员主页也可能被指向一位还没转正的人。
 */
async function getMember(userId) {
  const { members, applications } = load();
  return (
    members.find((u) => u._id === userId) || applications.find((u) => u._id === userId) || null
  );
}

/**
 * 入会申请台账：待审核与已驳回的那些。
 * 审核页取数走它，与 getMembers 刻意分开——「会员」和「申请」是两回事。
 */
async function getMemberApplications() {
  return load().applications;
}

/**
 * 查询比赛流水。
 * @param {Object} [options]
 * @param {string} [options.userId] 只看某位会员参加的
 * @param {string} [options.pool] 只看某个池
 * @param {string} [options.eventId] 只看某场赛事
 * @param {number} [options.limit] 最多返回多少场（按时间倒序截取）
 */
async function getMatches(options = {}) {
  const { userId, pool, eventId, limit } = options;
  const { matches } = load();

  let list = matches;
  if (userId) list = list.filter((m) => [...m.teamA, ...m.teamB].includes(userId));
  if (pool) list = list.filter((m) => m.pool === pool);
  if (eventId) list = list.filter((m) => m.eventId === eventId);

  // 内部按时间升序存，对外给最近的在前，符合浏览习惯
  list = [...list].sort((a, b) => new Date(b.matchTime) - new Date(a.matchTime));

  return typeof limit === 'number' && limit >= 0 ? list.slice(0, limit) : list;
}

async function getEvents() {
  return load().events;
}

/**
 * 报名记录。给出 eventId 就只取那一场的，否则取全部。
 *
 * 【为什么不进 buildCache】
 * 报名不参与回放——它既不算等级分也不算积分，只被赛事页直接读来显示
 * 「报了多少人、我报没报」。放进缓存反而多一处要与写入同步失效的地方，
 * 所以直接从 eventStore 取，与云端 getEventSignups 直接读库一致。
 *
 * @param {string} [eventId]
 * @returns {Promise<Array<Object>>}
 */
async function getEventSignups(eventId) {
  return eventStore.listSignups(eventId);
}

/**
 * 俱乐部公告，最新的在前。只含未下架的。
 *
 * 置顶公告（招新、规则变更）不在此处重排——是否置顶由展示层决定，
 * 数据层只保证时间倒序，这样「置顶」可以随时调整而不动数据。
 */
async function getAnnouncements() {
  return load().announcements;
}

/**
 * 公告台账：含已下架的，与 getAnnouncements 刻意分开。
 *
 * 与 getMatchRecords / getMatches 同一先例：公开读取只给「可见的那些」，
 * 管理侧要看到全量（包括下架的）才好判断「那条通知哪去了」。
 */
async function getAnnouncementRecords() {
  return load().announcementLedger;
}

/* ---------- 榜单 ---------- */

/**
 * 某个排行榜项目的等级分榜。
 *
 * 入参是「项目」而不是「池」：男单榜和女单榜共用单打池，但各自只列
 * 同性会员。要让两张榜的分数可比，就必须取自同一个池——这正是把
 * 男女单打合并计算的目的。
 *
 * @param {string} project 项目名，取值见 constants.RANK_PROJECT
 * @param {Object} [options] 排序选项，透传给 buildLeaderboard
 */
async function getLeaderboard(project, options = {}) {
  return buildProjectLeaderboard(load().users, project, options);
}

async function getProgressLeaderboard(project, options = {}) {
  const { users } = load();
  return buildProgressLeaderboard(progressEntries(users, project), options);
}

async function getPercentile(userId, project) {
  const { users } = load();
  const board = buildProjectLeaderboard(users, project);
  return calculatePercentile(board, userId);
}

/* ---------- 个人战绩 ---------- */

async function getMatchHistory(userId, options = {}) {
  const { matches, nameOf } = load();
  return buildMatchHistory(matches, userId, { nameOf, ...options });
}

async function getHeadToHead(userId, options = {}) {
  const { matches, nameOf } = load();
  return buildHeadToHead(matches, userId, { nameOf, ...options });
}

async function getPartnerRecord(userId, options = {}) {
  const { matches, nameOf } = load();
  return buildPartnerRecord(matches, userId, { nameOf, ...options });
}

async function getEventRecord(userId, options = {}) {
  const { events } = load();
  const records = buildEventRecord(events, userId, options);
  return { records, summary: summarizeEvents(records) };
}

async function getRatingHistory(userId, pool) {
  const { matches } = load();
  return buildRatingHistory(matches, userId, pool);
}

async function getForm(userId, options = {}) {
  const { matches } = load();
  return summarizeForm(matches, userId, options);
}

/**
 * 「我的」页面顶部那张卡片：各项目的分数、排名与百分位。
 *
 * 只返回打过球的项目——从没打过双打的人，展示他的双打初始分
 * 没有意义，反而让人以为自己的双打成绩很差。
 *
 * 【为什么按项目而不是按池列卡片】
 * 单打池是男女共用的，但排名必须分开看：一位女会员在女单榜上的名次
 * 才是她关心的，把她扔进含男生的单打池里排名，名次会毫无意义地靠后。
 * 所以这里按项目输出，而她只会看到与自己性别相符的那个单打项目。
 *
 * @param {string} userId
 * @returns {Promise<Array<Object>>}
 */
async function getMyProjects(userId) {
  const { users } = load();
  const member = users.find((u) => u._id === userId);
  if (!member) return [];

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
      // 池名也要带上：逐场战绩、分数曲线这些是按「比赛属于哪个池」过滤的，
      // 而不是按榜单项目过滤——项目只是展示口径，池才是数据口径。
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

  // 出场多的排前面，最活跃的项目优先展示
  return result.sort((a, b) => b.matchCount - a.matchCount);
}

/** 首页概览：几个数字 + 各项目榜首 */
async function getHomeSummary() {
  const { users, members, matches, events, meta } = load();

  const topByProject = {};
  for (const project of ALL_RANK_PROJECTS) {
    const board = buildProjectLeaderboard(users, project).filter((p) => p.matchCount > 0);
    topByProject[project] = {
      label: RANK_PROJECT_LABEL[project],
      top: board.slice(0, 3),
      playerCount: board.length,
    };
  }

  return {
    // 「会员数」钉死在审核通过的人上：申请中的还没算数，别把 24 撑成 26
    memberCount: members.length,
    matchCount: matches.length,
    eventCount: events.length,
    seasonRange: { from: meta.firstMatchTime, to: meta.lastMatchTime },
    topByProject,
  };
}

/* ---------- 成绩录入与流转 ---------- */
/* 本数据源唯一的写操作入口。真实环境里这些由云函数承担，权限校验也在
   服务端完成；这里只是把同一套规则在本地跑通，好让界面先做完。 */

/**
 * 查询比赛台账（含待确认与已撤销的那些）。
 *
 * 与 getMatches 的区别：getMatches 只给「已生效、已回放」的比赛，是面向
 * 所有人的成绩公示；台账把待确认、已撤销也一并列出，专供比赛页做流转。
 *
 * @param {Object} [options]
 * @param {string} [options.userId] 只看这位会员参加的
 * @param {string} [options.eventId] 只看这场赛事的（抽签生成的待确认比赛也在这里）
 * @param {number} [options.status] 只看某个状态，取值见 constants.MATCH_STATUS
 * @param {number} [options.limit] 最多返回多少场
 * @returns {Promise<Array<Object>>} 按时间倒序
 */
async function getMatchRecords(options = {}) {
  const { id, userId, eventId, status, limit } = options;
  const { ledger } = load();

  // id 用来取单独一场（录入页按编号回填比分）；其余过滤条件可叠加
  let list = id ? ledger.filter((m) => m._id === id) : ledger;
  if (userId) list = list.filter((m) => [...m.teamA, ...m.teamB].includes(userId));
  if (eventId) list = list.filter((m) => m.eventId === eventId);
  // 0（待确认）是合法取值，所以只能判类型，不能用真值判断
  if (typeof status === 'number') list = list.filter((m) => m.status === status);

  list = [...list].sort((a, b) => new Date(b.matchTime) - new Date(a.matchTime));
  return typeof limit === 'number' && limit >= 0 ? list.slice(0, limit) : list;
}

/**
 * 录入一场比赛。记录一律以「待确认」状态入账。
 *
 * @param {Object} params 见 match-record.buildMatchRecord
 * @param {Date|string|number} [params.now] 当前时间，便于测试注入
 * @returns {Promise<{ok:boolean, match:Object|null, errors:Object, scoreErrors:string[], firstError:string}>}
 */
async function submitMatch(params = {}) {
  const { users, meta } = load();
  const { now, id, ...fields } = params;

  // 抽签生成的比赛已经有主：补录比分，而不是另立一条新记录
  if (id) {
    const target = findRecord(id);
    if (!target) {
      return { ok: false, match: null, errors: {}, scoreErrors: [], firstError: '找不到这场比赛' };
    }
    const actor = (params.actor) || null;
    // 抽签比赛的成绩由场上的人补录，或由管理员代录——与云端
    // submitScheduledMatch 一字不差。这里不按数据源放宽：签表上的「录分」
    // 按钮与之同源（见 events-view.buildBracketRows），两处一旦分叉，
    // 就会出现「看得见按钮、点下去却被拒」。
    const mayRecord = isParticipant(target, actor) || roleOf(actor) === ROLE.ADMIN;
    if (!mayRecord) {
      return {
        ok: false,
        match: null,
        errors: {},
        scoreErrors: [],
        firstError: '只有参赛者可以录入这场比赛的成绩',
      };
    }

    const filled = fillScheduledMatch(target, fields, {
      members: users,
      now: now || new Date(),
      minMatchTime: meta.firstMatchTime,
      // 录入人按登录者记：确认权要靠它区分「自己」与「对手」
      recorder: actor,
    });
    if (!filled.ok) {
      return {
        ok: false,
        match: null,
        errors: filled.errors,
        scoreErrors: filled.scoreErrors,
        firstError: filled.firstError,
      };
    }

    const match = matchStore.saveMatch({ ...target, ...filled.patch });
    cache = null;
    return { ok: true, match, errors: {}, scoreErrors: [], firstError: '' };
  }

  const result = buildMatchRecord(fields, {
    // 名单必须来自 getMembers：本地注册账号不在种子里，回放时遇到会直接抛错，
    // 所以「参赛者是否在名单内」要在录入这一步就校验掉
    members: users,
    now: now || new Date(),
    // 时间下界取赛季首场。录到那之前，回放的定级锚点会前移，
    // 全体中途入会者的初始分被静默重算——一个人的笔误变成全站分数漂移
    minMatchTime: meta.firstMatchTime,
  });

  if (!result.ok) {
    return {
      ok: false,
      match: null,
      errors: result.errors,
      scoreErrors: result.scoreErrors,
      firstError: result.firstError,
    };
  }

  const match = matchStore.addMatch(result.record);
  // 写操作之后必须让缓存失效，否则分数变化不会兑现
  cache = null;
  return { ok: true, match, errors: {}, scoreErrors: [], firstError: '' };
}

/** 在台账里找一场比赛 */
function findRecord(id) {
  return load().ledger.find((match) => match._id === id) || null;
}

/** 取某位会员在本数据源里的角色 */
function roleOf(userId) {
  const user = load().users.find((item) => item._id === userId);
  return user ? user.role : ROLE.MEMBER;
}

/**
 * 确认一场待确认的比赛，成绩随即计入等级分。
 *
 * 【为什么是「写一条改判，然后整条重放」】
 * 这里刻意不做增量更新。改判落进台账后，下一次 load() 会把它放进
 * activeOnly，replaySeason 从零重算全场——这正是 replay.js 开头说的
 * 「回滚后重放」。别看它慢就「优化」成只改受影响的那几个人：
 * 定级锚点、连胜奖励都依赖完整时间序，增量更新迟早算错。
 *
 * @param {string} id
 * @param {string} actor 操作者编号
 * @returns {Promise<{ok:boolean, match:Object|null, message:string}>}
 */
async function confirmMatch(id, actor) {
  const match = findRecord(id);
  if (!match) return { ok: false, match: null, message: '找不到这场比赛' };

  // 本数据源就是模拟数据源：确认权按 mock 口径放宽为「参与即可」，
  // 界面上会明确标注这是演示口径（见 match-view 的 demoNotice）
  if (!canConfirm(match, actor, { isMock: true })) {
    return { ok: false, match: null, message: '你无权确认这场比赛' };
  }

  // 抽签排出来的比赛没有比分，胜方要等录入后才产生。没有胜方就确认，
  // 回放会算不出等级分。
  if (!match.winner) {
    return { ok: false, match: null, message: '这场比赛还没有比分，请先录入成绩' };
  }

  matchStore.setStatus(id, {
    status: MATCH_STATUS.ACTIVE,
    action: 'confirm',
    actor,
    actedAt: new Date(),
  });
  cache = null;
  // 刚打完的若是某一轮的最后一场，把下一轮排出来
  advanceEvent(match.eventId);
  return { ok: true, match, message: '' };
}

/**
 * 一轮打完后排出下一轮（决策 5.2）。内部用，不对外暴露。
 *
 * 与重抽不同，这里「只补不覆盖」：下一轮的编号同样是确定的，若覆盖，
 * 会把已经录好的比分冲掉。排不出来（还没打完 / 早排过了）就静默返回。
 *
 * @param {string|undefined} id 赛事编号
 */
function advanceEvent(id) {
  if (!id) return;
  const { events, ledger } = load();
  const event = events.find((item) => item._id === id);
  if (!event || !event.draw) return;

  const plan = planNextRound({
    eventId: id,
    draw: event.draw,
    matches: ledger.filter((match) => match.eventId === id),
    bronzeMode: event.bronzeMode,
  });
  if (!plan.ok) return;

  const taken = new Set(ledger.map((match) => match._id));
  let inserted = false;
  plan.rounds.forEach((roundPlan) => {
    buildRoundMatches(event, roundPlan).forEach((draft) => {
      if (taken.has(draft._id)) return; // 排过的轮次不覆盖
      matchStore.saveMatch(draft);
      inserted = true;
    });
  });
  if (inserted) cache = null;
}

/**
 * 驳回一场待确认的比赛。驳回后成绩作废，与撤销共用「已撤销」状态，
 * 靠 action 区分，避免为它新增一个永不回溯的枚举值。
 *
 * @param {string} id
 * @param {string} actor
 * @param {string} reason 驳回理由，必填
 * @returns {Promise<{ok:boolean, match:Object|null, message:string}>}
 */
async function rejectMatch(id, actor, reason) {
  const match = findRecord(id);
  if (!match) return { ok: false, match: null, message: '找不到这场比赛' };
  if (match.status !== MATCH_STATUS.PENDING) {
    return { ok: false, match: null, message: '只有待确认的比赛可以驳回' };
  }
  if (!canConfirm(match, actor, { isMock: true })) {
    return { ok: false, match: null, message: '你无权驳回这场比赛' };
  }
  if (!String(reason || '').trim()) {
    return { ok: false, match: null, message: '请填写驳回理由' };
  }

  matchStore.setStatus(id, {
    status: MATCH_STATUS.REVOKED,
    action: 'reject',
    reason: String(reason).trim(),
    actor,
    actedAt: new Date(),
  });
  cache = null;
  return { ok: true, match, message: '' };
}

/**
 * 撤销一场比赛，分数随之回滚。
 *
 * 【回滚是怎么发生的】
 * 撤销只写一条改判。下一次 load() 读到它，把这场比赛从 activeOnly 里丢掉，
 * replaySeason 从零重算——赛前赛后的每一个分数都重新长出来，不存在
 * 「减去当初加的那几分」这种近似做法。这也是本模块敢让撤销立刻生效的原因。
 *
 * @param {string} id
 * @param {string} actor
 * @param {string} reason 撤销理由，必填
 * @returns {Promise<{ok:boolean, match:Object|null, message:string}>}
 */
async function revokeMatch(id, actor, reason) {
  const match = findRecord(id);
  if (!match) return { ok: false, match: null, message: '找不到这场比赛' };
  if (match.status === MATCH_STATUS.REVOKED) {
    return { ok: false, match: null, message: '这场比赛已经作废了' };
  }
  // 管理员可撤任意一场；其余人只能撤自己录的
  if (!canRevoke(match, actor, { role: roleOf(actor) })) {
    return { ok: false, match: null, message: '你无权撤销这场比赛' };
  }
  if (!String(reason || '').trim()) {
    return { ok: false, match: null, message: '请填写撤销理由' };
  }

  matchStore.setStatus(id, {
    status: MATCH_STATUS.REVOKED,
    action: 'revoke',
    reason: String(reason).trim(),
    actor,
    actedAt: new Date(),
  });
  cache = null;
  return { ok: true, match, message: '' };
}

/* ---------- 会员注册与审核 ---------- */
/* 入会这条链路的写入口。与上面几个写接口同一纪律：先校验、后写入，
   被拒绝的调用不许在台账里留下任何痕迹。 */

/**
 * 按编号找一位会员，会员名单与申请名单一起找。
 *
 * 【为什么权限判定要重新查一遍】
 * 页面传进来的 actor 只是一个编号，不是它的角色。若相信调用方给的
 * 角色，改一个数字就能自封管理员。这里一律用编号回查台账，
 * 拿到的才是数据源认可的账号。
 */
function accountOf(userId) {
  if (!userId) return null;
  const { members, applications } = load();
  return (
    members.find((item) => item._id === userId) ||
    applications.find((item) => item._id === userId) ||
    null
  );
}

/**
 * 提交入会申请。
 *
 * 校验复用 auth.register（纯函数），本函数只负责落库与失效缓存——
 * 两处各写一套校验，迟早会分叉。
 *
 * @param {Object} profile 实名信息表单
 * @param {Object} [options] 透传给 auth.register（openId、now）
 * @returns {Promise<{ok:boolean, account:Object|null, errors:Object, firstError:string}>}
 */
async function registerMember(profile, options = {}) {
  const result = registerAccount(profile, options);
  // 校验没过就到此为止：不落库，一个字都不留
  if (!result.ok) {
    return { ok: false, account: null, errors: result.errors, firstError: result.firstError };
  }

  const account = userStore.addAccount(result.account);
  cache = null;
  return { ok: true, account, errors: {}, firstError: '' };
}

/**
 * 审核一条入会申请。通过 / 驳回共用这一条通路，只是终态不同。
 *
 * @param {string} applicationId
 * @param {string} actor 操作者编号
 * @param {string} action 取值见 member-review.REVIEW_ACTION
 * @param {string} [reason] 驳回理由，驳回时必填
 * @returns {Promise<{ok:boolean, account:Object|null, message:string}>}
 */
async function reviewMember(applicationId, actor, action, reason) {
  const account = userStore.findAccount(applicationId);
  // 审核权不再按数据源放宽：种子里 u02 张宇轩就是干事，切到该账号即可演示。
  // 「不能审自己的申请」这条本来就不放宽。
  const verdict = validateReview(accountOf(actor), account, action, reason);
  if (!verdict.ok) return { ok: false, account: null, message: verdict.message };

  userStore.setStatus(applicationId, {
    status: action === REVIEW_ACTION.APPROVE ? USER_STATUS.ACTIVE : USER_STATUS.DISABLED,
    action,
    reason: String(reason || '').trim(),
    actor,
    actedAt: new Date(),
  });
  cache = null;
  return { ok: true, account: userStore.findAccount(applicationId), message: '' };
}

/** 通过一条入会申请，申请人随即成为正式会员并进入回放名单 */
async function approveMember(applicationId, actor) {
  return reviewMember(applicationId, actor, REVIEW_ACTION.APPROVE, '');
}

/**
 * 驳回一条入会申请。驳回后账号处于「已禁用」，与 match.rejectMatch
 * 复用「已撤销」状态是同一套路数：靠 action 区分，不新增枚举。
 *
 * @param {string} applicationId
 * @param {string} actor
 * @param {string} reason 驳回理由，必填
 */
async function rejectMember(applicationId, actor, reason) {
  return reviewMember(applicationId, actor, REVIEW_ACTION.REJECT, reason);
}

/**
 * 发布一条公告。
 *
 * 校验复用 announcement.buildAnnouncementRecord（纯函数），本函数只负责
 * 判权、落库与失效缓存——两处各写一套校验，迟早会分叉。
 *
 * 权限判定同样用编号回查台账（accountOf），不信调用方给的 actor 对象：
 * 否则改一个 role: 2 就能凭空发布公告。
 *
 * @param {Object} form 公告表单（标题 / 正文 / 分类 / 置顶）
 * @param {string} actor 发布者编号
 * @returns {Promise<{ok:boolean, record:Object|null, errors:Object, firstError:string}>}
 */
async function publishAnnouncement(form, actor) {
  const account = accountOf(actor);
  // 发布权不再按数据源放宽：种子里 u02 张宇轩就是干事，切到该账号即可演示
  if (!canPublish(account)) {
    return { ok: false, record: null, errors: {}, firstError: '当前账号没有发布公告的权限' };
  }

  const built = buildAnnouncementRecord(form, { actor: account });
  if (!built.ok) {
    return { ok: false, record: null, errors: built.errors, firstError: built.firstError };
  }

  const record = announcementStore.addAnnouncement(built.record);
  cache = null;
  return { ok: true, record, errors: {}, firstError: '' };
}

/**
 * 下架一条公告。只改状态，不删除——公告是发出去给人看过的，直接抹掉会让
 * 「上周那条通知哪去了」无从追溯。下架后公开列表看不见，台账里仍留着。
 *
 * @param {string} id 公告编号
 * @param {string} actor 操作者编号
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function archiveAnnouncement(id, actor) {
  const account = accountOf(actor);
  if (!canPublish(account)) {
    return { ok: false, record: null, message: '当前账号没有管理公告的权限' };
  }

  const target = load().announcementLedger.find((item) => item._id === id);
  if (!target) return { ok: false, record: null, message: '找不到这条公告' };
  if (target.status === ANNOUNCEMENT_STATUS.ARCHIVED) {
    return { ok: false, record: null, message: '这条公告已经下架了' };
  }

  announcementStore.setStatus(id, {
    status: ANNOUNCEMENT_STATUS.ARCHIVED,
    actor,
    actedAt: new Date(),
  });
  cache = null;

  const record = load().announcementLedger.find((item) => item._id === id) || null;
  return { ok: true, record, message: '' };
}

/* ---------- 赛季管理 ---------- */

/**
 * 读取当前赛季状态。
 *
 * mock 没有云端那份赛季文档，锚点直接取回放给出「赛季首场」，
 * 重置记录则来自本次会话的 seasonStore。形状与云端保持一致，
 * 管理页与视图模型两边共用。
 *
 * @returns {Promise<Object>}
 */
async function getSeasonState() {
  const reset = seasonStore.getReset();
  return {
    anchorTime: load().meta.seasonStart || null,
    resetTime: reset ? reset.resetTime : null,
    // 从未重置时也给默认策略，界面照样能说明「重置后会怎么压分」
    policy: reset ? reset.policy : { ...DEFAULT_RESET_POLICY },
    // 赛季编号只由「开始新赛季」递增，与其它写入无关，形状与云端一致
    seasonNumber: seasonStore.getSeasonNumber(),
    version: reset ? 1 : 0,
  };
}

/**
 * 执行一次赛季软重置。
 *
 * 权限判定与云端同源（services/season.js）：只有管理员可以执行。
 * 种子里 u01 巴特尔就是管理员（见 seed.js 的 MEMBER_SEED），演示时把
 * 当前账号切到 u01 即可。只记分界点与策略，压分交给回放引擎。
 *
 * @param {string} actor 操作者编号
 * @returns {Promise<{ok:boolean, season:Object|null, message:string}>}
 */
async function resetSeason(actor) {
  const account = accountOf(actor);
  if (!canResetSeason(account)) {
    return { ok: false, season: null, message: '只有管理员可以执行赛季重置' };
  }

  seasonStore.setReset({ resetTime: new Date(), policy: DEFAULT_RESET_POLICY });
  cache = null;
  return { ok: true, season: await getSeasonState(), message: '' };
}

/* ---------- 个人资料 ---------- */

/**
 * 修改自己的昵称与头像。
 *
 * 【只能改这两项】
 * 真实姓名与学号是实名信息，改不得。白名单写在 profile.js 的
 * EDITABLE_FIELDS 里，校验也走它的 buildProfilePatch（纯函数），
 * 与云端共用同一套规则。
 *
 * 【为什么要回查账号而不是信任页面传来的编号】
 * 与其它写接口同一纪律：页面只递一个编号，身份回台账里查。这样
 * 「改别人的昵称」在本地也做不到。
 *
 * @param {Object} patch 只应含 nickName / avatarUrl
 * @param {string} actor 操作者编号
 * @returns {Promise<{ok:boolean, account:Object|null, errors:Object, firstError:string}>}
 */
async function updateProfile(patch, actor) {
  const account = accountOf(actor);
  if (!account) {
    return { ok: false, account: null, errors: {}, firstError: '请先登录后再修改资料' };
  }

  const built = buildProfilePatch(patch);
  if (!built.ok) {
    return { ok: false, account: null, errors: built.errors, firstError: built.firstError };
  }

  profileStore.setProfile(account._id, built.patch);
  cache = null;
  // 重新查一遍，拿到的就是盖过补丁的新昵称/头像
  return { ok: true, account: accountOf(account._id), errors: {}, firstError: '' };
}

/* ---------- 赛事闭环 ---------- */
/* 发布 → 报名 → 签到 → 录入名次。与云端 event-handlers.js 同一套规则，
   校验一律复用 services/event.js 的纯函数，这里只管判权、落库与失效缓存。 */

/** 在赛事台账里找一场（含种子赛事与本地新发的） */
function findEvent(id) {
  return load().events.find((event) => event._id === id) || null;
}

/**
 * 报名被拒时，给一句说得清的文案（与云端同款）。
 * @param {Object} event
 * @param {Object|null} signup
 * @returns {string}
 */
function signUpRefusal(event, signup) {
  if (event.status !== EVENT_STATUS.SIGNUP) return '报名已经截止了';
  // 抽签后的冻结要单独说（与云端同款文案）
  if (event.draw) return '抽签后报名已锁定，如需变更请联系管理员重抽';
  if (signup && signup.status === SIGNUP_STATUS.CHECKED_IN) return '你已经签过到了';
  if (signup && signup.status === SIGNUP_STATUS.SIGNED) return '你已经报过名了';
  return '当前状态不能报名这场赛事';
}

/**
 * 发布一场赛事。落库即「报名中」。
 *
 * 等级与三四名赛方式必须是用户确认过的值（见 event.validateEvent）——
 * 这两项直接决定积分怎么算，留空取默等于悄悄改分。
 *
 * @param {Object} form 赛事表单
 * @param {string} actor 发布者编号
 * @returns {Promise<{ok:boolean, record:Object|null, errors:Object, firstError:string}>}
 */
async function publishEvent(form, actor) {
  const account = accountOf(actor);
  // 发布权不再按数据源放宽：普通会员看不到、也点不动「发布赛事」
  if (!canManageEvent(account)) {
    return { ok: false, record: null, errors: {}, firstError: '当前账号没有发布赛事的权限' };
  }

  const built = buildEventDraft(form, { actor: account });
  if (!built.ok) {
    return { ok: false, record: null, errors: built.errors, firstError: built.firstError };
  }

  const record = eventStore.addEvent(built.record);
  cache = null;
  return { ok: true, record, errors: {}, firstError: '' };
}

/**
 * 开始一场赛事（报名中 → 进行中）。之后才能签到与录入名次。
 *
 * @param {string} id
 * @param {string} actor
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function startEvent(id, actor) {
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) return { ok: false, record: null, message: '找不到这场赛事' };

  if (!canStartEvent(target, account)) {
    // 状态先判：已经开始了还说「没有权限」会让人以为是自己账号的问题
    if (target.status !== EVENT_STATUS.SIGNUP) {
      return { ok: false, record: null, message: '这场赛事已经开始了' };
    }
    return { ok: false, record: null, message: '当前账号没有管理赛事的权限' };
  }

  eventStore.setStatus(id, { status: EVENT_STATUS.ONGOING, actor, actedAt: new Date() });
  cache = null;
  return { ok: true, record: findEvent(id), message: '' };
}

/**
 * 抽签（含重抽）：把签表写进赛事，并按签表生成首轮比赛。
 *
 * 与云端同一套纯逻辑（services/draw.js）：名单、种子、落位都由它算，
 * 这里只负责读写内存台账。编号用 draw.eventMatchKey 的确定性键，重抽
 * 时覆盖同一批比赛，不会越抽越多。
 *
 * @param {string} id
 * @param {string} actor
 * @param {Object} [options]
 * @param {number} [options.seedValue] 随机种子值，便于测试与复核
 * @param {string[]} [options.manualOrder] 手工指定的种子顺序
 * @returns {Promise<{ok:boolean, record:Object|null, draw:Object|null, matches:Array<Object>, message:string}>}
 */
async function drawEvent(id, actor, options = {}) {
  const { members } = load();
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) {
    return { ok: false, record: null, draw: null, matches: [], message: '找不到这场赛事' };
  }

  if (!canDrawEvent(target, account)) {
    // 逐条说清是哪一样不满足，别把「已经开赛」混进「没有权限」
    if (target.matchType !== MATCH_TYPE.SINGLES) {
      return { ok: false, record: null, draw: null, matches: [], message: '双打赛事暂不支持抽签' };
    }
    if (target.status !== EVENT_STATUS.SIGNUP) {
      return { ok: false, record: null, draw: null, matches: [], message: '只能在报名阶段抽签' };
    }
    return { ok: false, record: null, draw: null, matches: [], message: '当前账号没有抽签的权限' };
  }

  const signups = eventStore.listSignups(id);
  // 重抽前置：已有比赛被确认生效过就禁止重抽（决策 9.5）
  const existing = load().ledger.filter((match) => match.eventId === id);
  if (target.draw && !canRedraw(existing)) {
    return {
      ok: false,
      record: null,
      draw: null,
      matches: [],
      message: '该赛事已有比赛确认生效，不能再重抽',
    };
  }

  const { seedValue, manualOrder } = options || {};
  const value = seedValue === undefined || seedValue === null ? Date.now() : Number(seedValue);

  const plan = planDraw({ event: target, signups, members, seedValue: value, manualOrder });
  if (!plan.ok) {
    return { ok: false, record: null, draw: null, matches: [], message: plan.message };
  }

  const draw = buildDrawRecord(plan, {
    drawnAt: new Date(),
    drawnBy: actor,
    drawCount: (target.draw && target.draw.drawCount ? target.draw.drawCount : 0) + 1,
  });
  const matches = buildBracketMatches(plan, { event: target }).map((draft) =>
    matchStore.saveMatch(draft)
  );

  eventStore.setStatus(id, { draw });
  cache = null;
  return { ok: true, record: findEvent(id), draw, matches, message: '' };
}

/**
 * 报名一场赛事。报名人就是调用者本人——不接受别的编号，
 * 否则谁都能替别人报名。
 *
 * @param {string} id
 * @param {string} actor
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function signUpEvent(id, actor) {
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) return { ok: false, record: null, message: '找不到这场赛事' };

  const signups = eventStore.listSignups(id);
  const signup = signups.find((item) => item.userId === actor) || null;

  if (!canSignUp(target, account, { signup, signups })) {
    return { ok: false, record: null, message: signUpRefusal(target, signup) };
  }

  const built = buildSignupRecord(target, account, { now: new Date() });
  if (!built.ok) return { ok: false, record: null, message: built.message };

  // 报名不进回放，无需让缓存失效（与云端一致）
  const record = eventStore.saveSignup(built.record);
  return { ok: true, record, message: '' };
}

/**
 * 取消报名。只置状态，不删记录——报了多少人、退了多少人都留痕，
 * 重新报名也落回同一条。
 *
 * @param {string} id
 * @param {string} actor
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function cancelSignupEvent(id, actor) {
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) return { ok: false, record: null, message: '找不到这场赛事' };

  const signup = eventStore.findSignup(id, actor);
  if (!signup) return { ok: false, record: null, message: '你还没有报名这场赛事' };

  if (!canCancelSignup(target, account, { signup })) {
    return { ok: false, record: null, message: '现在不能取消报名' };
  }

  const record = eventStore.saveSignup({
    ...signup,
    status: SIGNUP_STATUS.CANCELED,
    actorId: actor,
    actedAt: new Date(),
  });
  return { ok: true, record, message: '' };
}

/**
 * 代某位会员签到。只有干事以上能签（决策 4：不做自助签到）。
 *
 * @param {string} id
 * @param {string} userId 要签到的会员
 * @param {string} actor 代签的干事
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function checkInEvent(id, userId, actor) {
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) return { ok: false, record: null, message: '找不到这场赛事' };

  if (!canCheckIn(target, account)) {
    return { ok: false, record: null, message: '当前账号不能为会员签到' };
  }
  if (!userId) return { ok: false, record: null, message: '请指定要签到的会员' };

  const signup = eventStore.findSignup(id, userId);
  const built = buildCheckInPatch(signup, account, { now: new Date() });
  if (!built.ok) return { ok: false, record: null, message: built.message };

  const record = eventStore.saveSignup({ ...signup, ...built.patch });
  return { ok: true, record, message: '' };
}

/**
 * 录入名次并结束赛事。这是全赛事闭环里唯一会改动积分的动作。
 *
 * 【为什么要校验「名次对应的人都报过名」】
 * 名次直接换成积分，一个错字的 userId 就会凭空多出一位参赛者，还带着
 * 名次分。所以只接受这场比赛里有效报名的人。
 *
 * @param {string} id
 * @param {Array<Object>} results [{ userId, placement }]
 * @param {string} actor
 * @returns {Promise<{ok:boolean, record:Object|null, errors:Object, firstError:string}>}
 */
async function finishEvent(id, results, actor) {
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) {
    return { ok: false, record: null, errors: {}, firstError: '找不到这场赛事' };
  }

  if (!canFinishEvent(target, account)) {
    const firstError =
      target.status !== EVENT_STATUS.ONGOING ? '只有进行中的赛事可以录入名次' : '当前账号没有管理赛事的权限';
    return { ok: false, record: null, errors: {}, firstError };
  }

  const signups = eventStore.listSignups(id);
  const validUsers = new Set(
    signups.filter((item) => item.status !== SIGNUP_STATUS.CANCELED).map((item) => item.userId)
  );

  // 以签表人数为准判「打不打得出三四名赛」；没抽签时退回报名人数
  const entryCount = drawnEntryCount(target.draw) || validUsers.size;
  const checked = validatePlacements(results, { bronzeMode: target.bronzeMode, entryCount });
  if (!checked.ok) {
    return { ok: false, record: null, errors: checked.errors, firstError: checked.firstError };
  }

  const stranger = checked.results.find((row) => !validUsers.has(row.userId));
  if (stranger) {
    const firstError = '名次里出现了没有报名这场赛事的会员';
    return { ok: false, record: null, errors: { results: firstError }, firstError };
  }

  eventStore.setStatus(id, {
    status: EVENT_STATUS.FINISHED,
    results: checked.results,
    actor,
    finishedAt: new Date(),
  });
  // 名次落定就要重算积分，缓存必须失效
  cache = null;
  return { ok: true, record: findEvent(id), errors: {}, firstError: '' };
}

module.exports = {
  DEFAULT_CURRENT_USER_ID,
  SEED_OPTIONS,
  load,
  resetCache,
  getMatchRecords,
  getSeasonState,
  submitMatch,
  confirmMatch,
  rejectMatch,
  revokeMatch,
  registerMember,
  approveMember,
  rejectMember,
  publishAnnouncement,
  archiveAnnouncement,
  updateProfile,
  resetSeason,
  publishEvent,
  startEvent,
  drawEvent,
  signUpEvent,
  cancelSignupEvent,
  checkInEvent,
  finishEvent,
  getCurrentUser,
  getMembers,
  getMember,
  getMemberApplications,
  getMatches,
  getEvents,
  getEventSignups,
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
};
