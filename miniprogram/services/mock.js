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
const collegeStore = require('./college-store.js');
const profileStore = require('./profile-store.js');
const roleStore = require('./role-store.js');
const seasonStore = require('./season-store.js');
const liveStore = require('./live-store.js');
const { installCollegeDemo } = require('./college-demo.js');
const { register: registerAccount } = require('./auth.js');
const { canManage } = require('./permission.js');
const { DEFAULT_RESET_POLICY, canResetSeason } = require('./season.js');
const { REVIEW_ACTION, validateReview, validateCollegeLeader } = require('./member-review.js');
const {
  canConfirm,
  canRevoke,
  canRecordScore,
  canForfeit,
  canAssignReferee,
  buildMatchRecord,
  buildForfeitPatch,
  buildRefereePatch,
  fillScheduledMatch,
} = require('./match-record.js');
// 实时比分：逐球状态机与本地实时台账（与云端共用同一份纯逻辑）
const {
  LIVE_STATUS,
  SIDE,
  createLive,
  applyRally,
  // 与下面 mock 的同名写接口撞名，导入时改个前缀
  undoRally: undoLiveRally,
  hasRally,
  isFinalized,
  liveScoreOf,
  toOfficialScores,
} = require('./live-score.js');
const { canPublish, buildAnnouncementRecord } = require('./announcement.js');
const {
  canManageEvent,
  canStartEvent,
  startBlockedReason,
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
// 学院赛与个人赛并行的另一套：发布与名单的校验同样住在纯模块里
const {
  canManageCollegeEvent,
  buildCollegeEventRecord,
  validateCollegePlacements,
} = require('./college-event.js');
const { buildCollegeEntryRecord, validateEntryReview } = require('./college-entry.js');
const {
  planCollegeDraw,
  buildCollegeDrawRecord,
} = require('./college-draw.js');
const {
  firstRoundPairsOf,
  buildTiesForRound,
  buildLegMatchDrafts,
  legResultOf,
  revertLegResult,
  summarizeTie,
  nextRoundPairsOf,
  isEloEligibleMatch,
  canStartCollegeEvent,
  canStartTie,
  canAssignTieReferee,
  legMatchIdsOf,
} = require('./college-tie.js');
const { buildLineupRecord } = require('./college-lineup.js');
const {
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  TIE_STATUS,
  MATCH_COMPETITION,
  MATCH_OUTCOME,
  TEAM,
} = require('../utils/constants.js');
const {
  planDraw,
  buildDrawRecord,
  buildRoundMatches,
  drawnEntryCount,
  canRedraw,
} = require('./draw.js');
// 赛制阶段派发：循环 / 小组 / 复合赛制的推进与名次推导都在这里
const {
  buildInitialMatches,
  planStageMatches,
  findDependentMatches,
  derivePlacements,
} = require('./format-plan.js');
const { buildProfilePatch } = require('./profile.js');
const { getPoolRating } = require('../utils/rating.js');
const {
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
  RANK_PROJECT_CONFIG,
  MATCH_STATUS,
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
  percentileFromBoard,
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
 * 学院赛演示场景是否还允许自动装载。
 *
 * resetCache() 是测试专用复位：一旦被调用就永久关掉演示场景，让既有用例
 * 拿到干净的 24 人基线，不必每条断言都去减掉演示数据。模拟器里没人调
 * resetCache，所以开机第一次读到数据时场景就会自己装上（见 college-demo.js）。
 */
let collegeDemoEnabled = true;

/** 演示场景只装一次；装上后再读多少遍都不重复，也不重复跑那段回放 */
let collegeDemoInstalled = false;

/**
 * 第一次读到数据前，把学院赛演示场景装进台账。
 *
 * 【为什么在这两个地方调】
 * load() 是所有「会员 / 等级分」读取的必经之路，装了它演示账号 u06 的
 * 干事身份才立得住；学院赛的列表 / 名单 / 大场 / 排阵是直接读台账的
 * （见各 getCollege* 的注释），不经过 load()，所以那几处也要各补一次。
 *
 * 【为什么先置位再装】
 * 装载过程中动作函数会回调 load()，置位后递归调用立即返回，不会死循环。
 * 装完 cache 已被写入失效，调用方的 load() 会再补一次含场景的最终缓存。
 */
function ensureCollegeDemo() {
  if (!collegeDemoEnabled || collegeDemoInstalled) return;
  collegeDemoInstalled = true;
  try {
    installCollegeDemo({
      load,
      actions: {
        registerMember,
        approveMember,
        setCollegeLeader,
        publishCollegeEvent,
        submitCollegeEntry,
        reviewCollegeEntry,
        drawCollegeEvent,
        startCollegeEvent,
        submitLineup,
        startTie,
        submitMatch,
        confirmMatch,
      },
      stores: { collegeStore, matchStore, userStore },
    });
  } catch (err) {
    // 装不上就退回干净种子，绝不让演示数据把整个数据源拖垮；
    // 保留置位，免得每次读取都重试一遍同样的失败。
    console.warn('[mock] 学院赛演示场景装载失败：', err);
  }
}

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

  // 2. 比赛：种子流水接上本次会话新录的，再盖上改判（确认 / 驳回 / 撤销）。
  //    同一编号只留一条：抽签排好却还没打的比赛（如演示赛事的半决赛）本就
  //    以空比分躺在种子里，现场录分走的是「按编号覆盖」，于是 submitted 里
  //    会出现同一个 _id 的第二份。若两份都进台账，findRecord 的 .find() 会
  //    命中排在前面的种子那份（比分仍为空），确认时永远报「还没有比分」，
  //    签表也会同场渲染两行。因此先剔除种子里被覆盖的那些，再让新录的顶上。
  const storeMatches = matchStore.listSubmitted();
  const submittedIds = new Set(storeMatches.map((match) => match._id));
  const afterStore = seed.matches
    .filter((match) => !submittedIds.has(match._id))
    .concat(storeMatches)
    .map((match) => {
      const patch = matchStore.overrideOf(match._id);
      return patch ? { ...match, ...patch } : match;
    });

  // 进回放的只有「计个人等级分」的比赛：已生效、非弃权，且学院赛里只有
  // 单打小场（双打小场只汇总大场，见 college-tie.isEloEligibleMatch）。
  // 台账仍是完整的 afterStore，录分页按编号取小场不受影响。
  const activeOnly = afterStore.filter((match) => isEloEligibleMatch(match));

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

  // 5. 资料补丁 + 角色补丁：昵称头像是会员自己改的，角色是管理员任免的，
  //    两者都盖在回放结果之上。种子会员不在 user-store 里，所以补丁必须
  //    在这里盖。users 与 members 必须是盖过补丁的同一份——否则
  //    getCurrentUser（读 users）与 getMembers（读 members）会在改完角色后
  //    各说各话（一个还是普通会员，一个已能看到干事入口）。分数、场次仍以
  //    回放结果为准，补丁只覆盖昵称 / 头像 / 角色这几个字段。
  //    角色不进回放：等级分怎么算与谁有管理权无关，故盖在回放之后即可。
  const patchAccount = (account) => {
    const profile = profileStore.patchOf(account._id);
    const role = roleStore.patchOf(account._id);
    if (!profile && !role) return account;
    return { ...account, ...(profile || {}), ...(role || {}) };
  };
  const members = replayed.users.map(patchAccount);

  return {
    ...replayed,
    // replayed.users 已经过回放（分数、场次都是最新），再盖上资料补丁
    users: members,
    members,
    // 申请名单同样要盖：审核页要显示申请人改过的昵称头像
    applications: applications.map(patchAccount),
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
  if (!cache) {
    cache = buildCache();
    ensureCollegeDemo();
    // 演示场景的写入已让上面那份缓存失效，这里补一次；补完就是含场景的最终缓存
    if (!cache) cache = buildCache();
  }
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
  // 学院赛同理：新发的学院赛与各学院名单都是临时写入，编号也要一起复位
  collegeStore.reset();
  // 资料补丁同理：改过的昵称头像也是临时写入
  profileStore.reset();
  // 角色任免同理：管理员把谁设成了干事也是临时写入
  roleStore.reset();
  // 赛季重置同理：分界点必须一起清，否则下一轮生成的分数还是被压过的
  seasonStore.reset();
  // 实时比分同理：逐球流水是临时写入，复位后不该再看到上一轮的比分
  liveStore.reset();
  // 学院赛演示场景也一并关掉：复位是测试专用动作，之后各用例要的是干净
  // 基线（24 位会员、0 场学院赛），而不是再把演示数据装回来。
  collegeDemoEnabled = false;
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
 * 学院赛列表。与 getEvents 分开：两者是互不干扰的两套体系（D1），
 * 混在一个列表里会让「这场比赛是个人赛还是学院赛」在展示层反复判断。
 * @returns {Promise<Array<Object>>}
 */
async function getCollegeEvents() {
  ensureCollegeDemo();
  return collegeStore.listEvents();
}

/**
 * 单场学院赛。
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function getCollegeEvent(id) {
  ensureCollegeDemo();
  return collegeStore.findEvent(id);
}

/**
 * 某场学院赛的名单（含待审核 / 已通过 / 已退回）。
 *
 * 【为什么不进 buildCache】
 * 与报名记录同理：名单不参与回放，只被页面直接读来展示与审核。
 *
 * @param {string} [eventId] 缺省取全部
 * @returns {Promise<Array<Object>>}
 */
async function getCollegeEntries(eventId) {
  ensureCollegeDemo();
  return collegeStore.listEntries(eventId);
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
  // board 已经是排好序的榜，直接读百分位，不必再排一遍
  return percentileFromBoard(board, userId);
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
    const stats = percentileFromBoard(board, userId);

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
 * 给台账里的比赛附上「进行中」的实时比分。
 *
 * 【为什么在读接口现挂，而不是进 buildCache】
 * 实时态不参与回放，也不该因为每判一球就让整季缓存失效（§八.5）。
 * 现挂只是一次 map 查找，代价远小于维护一份要与写入同步失效的缓存。
 *
 * 【为什么没有实时态就原样返回】
 * 不产生新对象：既省一次分配，也让「没有实时比分的比赛」与今天逐字节
 * 一致——既有的台账断言不受影响。
 *
 * @param {Array<Object>} records
 * @returns {Array<Object>}
 */
function attachLive(records) {
  const live = liveStore.list();
  if (live.length === 0) return records;
  const byMatch = new Map(live.map((state) => [state.matchId, state]));
  return records.map((record) => {
    const state = byMatch.get(record._id);
    return state ? { ...record, live: liveScoreOf(state) } : record;
  });
}

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
  if (typeof limit === 'number' && limit >= 0) list = list.slice(0, limit);
  return attachLive(list);
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
  const { now, id, actor, ...fields } = params;

  // 抽签生成的比赛已经有主：补录比分，而不是另立一条新记录
  if (id) {
    const target = findRecord(id);
    if (!target) {
      return { ok: false, match: null, errors: {}, scoreErrors: [], firstError: '找不到这场比赛' };
    }
    const actorAccount = accountOf(actor);
    // 抽签比赛的成绩由场上的人补录，管理员代录任意一场，干事只代录本学院
    // 有人上场的比赛——判定与云端 submitScheduledMatch、界面上的「录分」
    // 按钮（events-view.buildBracketRows）同源，三处一旦分叉，就会出现
    // 「看得见按钮、点下去却被拒」。
    const mayRecord = canRecordScore(target, actor, {
      role: roleOf(actor),
      college: (actorAccount && actorAccount.college) || '',
      collegeOf: (id) => (users.find((u) => u._id === id) || {}).college || '',
    });
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

  const result = buildMatchRecord(
    // 录入人按登录者记：前端传的 recorder 不被信任。把录入人填成一个不在
    // 场上的人，就能让确认权对场上所有人开放（见 match-record.canConfirm），
    // 提交者于是能给自己盖章——这条规则与云端 submitMatch 一字不差。
    { ...fields, recorder: actor || fields.recorder },
    {
      // 名单必须来自 getMembers：本地注册账号不在种子里，回放时遇到会直接抛错，
      // 所以「参赛者是否在名单内」要在录入这一步就校验掉
      members: users,
      now: now || new Date(),
      // 时间下界取赛季首场。录到那之前，回放的定级锚点会前移，
      // 全体中途入会者的初始分被静默重算——一个人的笔误变成全站分数漂移
      minMatchTime: meta.firstMatchTime,
    }
  );

  if (!result.ok) {
    return {
      ok: false,
      match: null,
      errors: result.errors,
      scoreErrors: result.scoreErrors,
      firstError: result.firstError,
    };
  }

  // 给了登录者就按同一条规则查权限：只有参赛者、本学院有人上场的干事、
  // 管理员能录这一场。没给 actor 的调用只会来自测试或脚本——本地模拟数据
  // 不是安全边界，真正的边界在云端的 ctx（那里 actor 永远存在）。
  if (actor) {
    const mayRecord = canRecordScore(result.record, actor, {
      role: roleOf(actor),
      college: (accountOf(actor) || {}).college || '',
      collegeOf: (memberId) => (users.find((u) => u._id === memberId) || {}).college || '',
    });
    if (!mayRecord) {
      return {
        ok: false,
        match: null,
        errors: {},
        scoreErrors: [],
        firstError: '只有参赛者、本学院干事或管理员可以录入这场比赛的成绩',
      };
    }
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
  if (!canConfirm(match, actor, { isMock: true, role: roleOf(actor) })) {
    return { ok: false, match: null, message: '你无权确认这场比赛' };
  }

  // 抽签排出来的比赛没有比分，胜方要等录入后才产生。没有胜方就确认，
  // 回放会算不出等级分。
  if (!match.winner) {
    return { ok: false, match: null, message: '这场比赛还没有比分，请先录入成绩' };
  }

  // 返回「改判后的」这一条，而不是改判前从台账里取到的那条：云端就是这么
  // 返的（{ ...current, ...patch }），页面拿 match.status 判断状态时两边才
  // 给得出同一个答案。
  const patch = {
    status: MATCH_STATUS.ACTIVE,
    action: 'confirm',
    actor,
    actedAt: new Date(),
  };
  matchStore.setStatus(id, patch);
  cache = null;
  if (match.competition === MATCH_COMPETITION.COLLEGE) {
    // 学院赛小场：把结果写回大场，本轮打完则排下一轮
    advanceCollegeAfterLeg({ ...match, ...patch });
  } else {
    // 刚打完的若是某一轮的最后一场，把下一轮排出来
    advanceEvent(match.eventId);
  }
  return { ok: true, match: { ...match, ...patch }, message: '' };
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

  // 由赛制决定「下一批该排哪些」：单败排下一轮，循环排下一轮，
  // 小组赛在全部小组打完后转去排淘汰阶段
  const plan = planStageMatches({
    event,
    draw: event.draw,
    matches: ledger.filter((match) => match.eventId === id),
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
  if (!canConfirm(match, actor, { isMock: true, role: roleOf(actor) })) {
    return { ok: false, match: null, message: '你无权驳回这场比赛' };
  }
  if (!String(reason || '').trim()) {
    return { ok: false, match: null, message: '请填写驳回理由' };
  }

  const patch = {
    status: MATCH_STATUS.REVOKED,
    action: 'reject',
    reason: String(reason).trim(),
    actor,
    actedAt: new Date(),
  };
  matchStore.setStatus(id, patch);
  cache = null;
  return { ok: true, match: { ...match, ...patch }, message: '' };
}

/**
 * 撤销一场比赛，分数随之回滚。
 *
 * 【回滚是怎么发生的】
 * 撤销只写一条改判。下一次 load() 读到它，把这场比赛从 activeOnly 里丢掉，
 * replaySeason 从零重算——赛前赛后的每一个分数都重新长出来，不存在
 * 「减去当初加的那几分」这种近似做法。这也是本模块敢让撤销立刻生效的原因。
 *
 * 【分数撤得回，签表撤不回】
 * 回滚只覆盖「算出来的东西」。签表是排出来的：确认一场会让 advanceEvent 把
 * 下一轮存成真实的比赛记录，而这里同样只补不覆盖、也不删除。撤掉第 1 轮后，
 * 第 2 轮那些场次仍留着作废的晋级者，等着被谁录个比分确认掉。所以与云端
 * 一致，撤销前用 findDependentMatches 拦一道，要求从后往前撤。
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
  // 撤销改写已生效的账本，只归管理员；录分错了走驳回（canConfirm）
  if (!canRevoke(match, actor, { role: roleOf(actor) })) {
    return { ok: false, match: null, message: '你无权撤销这场比赛' };
  }
  if (!String(reason || '').trim()) {
    return { ok: false, match: null, message: '请填写撤销理由' };
  }
  const dependent = findDependentMatches({ match, matches: load().ledger });
  if (dependent.length > 0) {
    return {
      ok: false,
      match: null,
      message: `这场比赛已经排进了后面的 ${dependent.length} 场，请从最后一轮往前依次撤销`,
    };
  }
  // 学院赛小场的下游在大场那一侧，findDependentMatches 只看 matches，够不着
  const collegeBlock = collegeLegRevokeBlocker(match);
  if (collegeBlock) return { ok: false, match: null, message: collegeBlock };

  const patch = {
    status: MATCH_STATUS.REVOKED,
    action: 'revoke',
    reason: String(reason).trim(),
    actor,
    actedAt: new Date(),
  };
  matchStore.setStatus(id, patch);
  cache = null;

  // 学院赛小场：把这一场的结果从大场里收回来（清胜负、必要时退回进行中）
  const revoked = { ...match, ...patch };
  if (revoked.competition === MATCH_COMPETITION.COLLEGE) {
    revertCollegeAfterRevoke(revoked);
  }
  return { ok: true, match: revoked, message: '' };
}

/**
 * 个人赛弃权（M5-3）。参赛者本人自选，或管理员代记。
 * 与云端 forfeitMatch 同一套规则，复用同一个纯函数算字段。
 *
 * 【为什么弃权后要调 advanceEvent】
 * 弃权在赛制里就是「这一场有结果了」：单败里对手晋级下一轮，循环 /
 * 小组赛里记对手一胜。晋级靠重排签表实现（见 advanceEvent），所以写完
 * 必须让它跑一次，否则对手会被卡在原地。
 *
 * @param {string} id
 * @param {string} forfeitBy 弃权者编号，必须是场上的人
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, match:Object|null, message:string}>}
 */
async function forfeitMatch(id, forfeitBy, actor) {
  const match = findRecord(id);
  if (!match) return { ok: false, match: null, message: '找不到这场比赛' };

  const by = String(forfeitBy || '').trim();
  if (!canForfeit(match, by, actor, { role: roleOf(actor) })) {
    return { ok: false, match: null, message: '你无权记录这次弃权' };
  }

  const patch = buildForfeitPatch(match, by, { actorId: actor, now: new Date() });
  matchStore.setStatus(id, patch);
  cache = null;

  const patched = { ...match, ...patch };
  advanceEvent(patched.eventId);
  return { ok: true, match: patched, message: '' };
}

/* ---------- 裁判指派 ---------- */
/* 与云端 assignMatchReferee / assignTieReferee 同一套规则。指派权仅管理员
   （Q3）：裁判握有录分与确认权，指派权与「定盘子」同级，不下放给参赛方。 */

/**
 * 找一位可以当裁判的会员。
 *
 * 只认「正常在册」的账号（Q3 的兜底校验）：待审核的还没转正，已禁用 /
 * 已离校的不该再出现在赛场上执法。查不到与状态不对分开报，管理员才知道
 * 是编号填错了还是这个人不能用。
 *
 * @param {string} userId
 * @param {Object} dataset load() 的结果：在册会员与申请名单分开装着
 * @returns {string} 出错文案；通过时为空串
 */
function refereeRejection(userId, dataset) {
  // 两张名单一起查：待审核的人不在「会员」里，只查会员会把他报成「查无此人」，
  // 管理员分不清是编号填错还是这人还没转正
  const accounts = [...((dataset && dataset.members) || []), ...((dataset && dataset.applications) || [])];
  const referee = accounts.find((item) => item._id === userId);
  if (!referee) return '找不到这位会员';
  if (referee.status !== USER_STATUS.ACTIVE) return '该会员不是正常在册状态，不能担任裁判';
  return '';
}

/**
 * 指派 / 改派 / 取消一场比赛的裁判。**仅管理员**，且比赛尚未生效。
 *
 * @param {string} matchId
 * @param {string} refereeId 裁判会员编号；空串 = 取消
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, match:Object|null, message:string}>}
 */
async function assignMatchReferee(matchId, refereeId, actor) {
  const account = accountOf(actor);
  if (!canManage(account, { minRole: ROLE.ADMIN })) {
    return { ok: false, match: null, message: '只有管理员可以指派裁判' };
  }

  const match = findRecord(matchId);
  if (!match) return { ok: false, match: null, message: '找不到这场比赛' };
  if (!canAssignReferee(match)) {
    return { ok: false, match: null, message: '这场比赛已生效或已作废，不能再改派裁判' };
  }

  const id = String(refereeId || '').trim();
  if (id) {
    const refusal = refereeRejection(id, load());
    if (refusal) return { ok: false, match: null, message: refusal };
  }

  const patch = buildRefereePatch(id, { actorId: actor, now: new Date() });
  matchStore.setStatus(matchId, patch);
  cache = null;
  return { ok: true, match: { ...match, ...patch }, message: '' };
}

/**
 * 指派 / 改派 / 取消一个大场的裁判。**仅管理员**，且大场尚未结束。
 *
 * 【为什么要逐个写进小场】
 * 权限判定只看「这一场比赛自己」的 referee（见 match-record.canRecordScore），
 * 录分时不必回查大场。所以指派一次 = 写大场 + 写它下面所有能改派的小场。
 * 已生效 / 已作废的小项不动，避免改历史。
 *
 * @param {string} tieId
 * @param {string} refereeId 裁判会员编号；空串 = 取消
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, record:Object|null, matches:Array<Object>, message:string}>}
 */
async function assignTieReferee(tieId, refereeId, actor) {
  const account = accountOf(actor);
  if (!canManage(account, { minRole: ROLE.ADMIN })) {
    return { ok: false, record: null, matches: [], message: '只有管理员可以指派裁判' };
  }

  const tie = collegeStore.findTie(tieId);
  if (!tie) return { ok: false, record: null, matches: [], message: '找不到这个大场' };
  if (!canAssignTieReferee(tie)) {
    return { ok: false, record: null, matches: [], message: '这个大场已经结束，不能再改派裁判' };
  }

  const id = String(refereeId || '').trim();
  if (id) {
    const refusal = refereeRejection(id, load());
    if (refusal) return { ok: false, record: null, matches: [], message: refusal };
  }

  const patch = buildRefereePatch(id, { actorId: actor, now: new Date() });
  const matches = [];
  for (const legId of legMatchIdsOf(tie)) {
    const leg = findRecord(legId);
    if (!leg || !canAssignReferee(leg)) continue;
    matchStore.setStatus(legId, patch);
    matches.push({ ...leg, ...patch });
  }

  const record = collegeStore.updateTie(tieId, patch);
  cache = null;
  return { ok: true, record, matches, message: '' };
}

/* ---------- 实时比分 ---------- */
/* 逐球计分的四个写接口 + 一个读接口，与云端 live-handlers 同一套纯逻辑。
   权限与录分同源（canRecordScore）：能录这一场的人（裁判 / 管理员 /
   参赛者 / 本学院干事）才能开台、判球、撤销、定稿。每判一球只写实时
   台账，不动赛季缓存；只有定稿走 submitMatch 时才 bumpSeason（§八.5）。 */

/**
 * 这位操作者能不能给这场比赛计分。
 * 判定与 submitMatch 的录分权一字不差，三处一旦分叉就会出现
 * 「看得见计分台、点下去却被拒」。
 *
 * @param {Object} match
 * @param {string} actor
 * @param {Array<Object>} users 用于解析学院（干事代录的边界）
 * @returns {boolean}
 */
function liveMayRecord(match, actor, users) {
  const account = accountOf(actor);
  return canRecordScore(match, actor, {
    role: roleOf(actor),
    college: (account && account.college) || '',
    collegeOf: (id) => (users.find((u) => u._id === id) || {}).college || '',
  });
}

/**
 * 找一场比赛并校验计分权，供四个写接口共用。
 * @param {string} matchId
 * @param {string} actor
 * @returns {{match:Object}|{error:string}}
 */
function liveTarget(matchId, actor) {
  const { users } = load();
  const match = findRecord(matchId);
  if (!match) return { error: '找不到这场比赛' };
  // 已生效 / 已作废的比赛不再开实时台：改历史要走撤销，重录要走录分页
  if (match.status !== MATCH_STATUS.PENDING) {
    return { error: '这场比赛已生效或已作废，不能再计分' };
  }
  if (!liveMayRecord(match, actor, users)) return { error: '你无权为这场比赛计分' };
  return { match };
}

/**
 * 开实时计分台。建 / 取实时态；已存在就原样返回（重开不重置比分）。
 *
 * @param {string} matchId
 * @param {string} actor
 * @returns {Promise<{ok:boolean, live:Object|null, message:string}>}
 */
async function startLiveScore(matchId, actor) {
  const target = liveTarget(matchId, actor);
  if (target.error) return { ok: false, live: null, message: target.error };

  const existing = liveStore.get(matchId);
  if (existing) return { ok: true, live: existing, message: '' };

  const state = liveStore.set(createLive(target.match, { actorId: actor, now: new Date() }));
  return { ok: true, live: state, message: '' };
}

/**
 * 判一球。
 *
 * @param {string} matchId
 * @param {'A'|'B'} side 这一球判给谁
 * @param {string} actor
 * @param {Object} [options]
 * @param {string} [options.rallyId] 客户端生成的一球编号；重发同一个编号不再计一次
 * @returns {Promise<{ok:boolean, live:Object|null, message:string}>}
 */
async function recordRally(matchId, side, actor, options = {}) {
  const target = liveTarget(matchId, actor);
  if (target.error) return { ok: false, live: null, message: target.error };

  const state = liveStore.get(matchId);
  if (!state) return { ok: false, live: null, message: '这场比赛还没开实时计分台' };
  if (state.status !== LIVE_STATUS.LIVE) {
    return { ok: false, live: state, message: '比赛已经结束，不能再判球' };
  }
  if (side !== SIDE.A && side !== SIDE.B) {
    return { ok: false, live: state, message: '判球方不合法' };
  }

  const rallyId = String(options.rallyId || '');
  // 幂等：同一个 rallyId 重发（断线重试 / 连点）不再计一次
  if (hasRally(state, rallyId)) return { ok: true, live: state, message: '' };

  const next = liveStore.set({
    ...applyRally(state, side, { rallyId }),
    updatedBy: actor,
    updatedAt: new Date(),
  });
  return { ok: true, live: next, message: '' };
}

/**
 * 撤销最后一球。若撤的是决定性的那一球，整场退回「进行中」。
 *
 * @param {string} matchId
 * @param {string} actor
 * @returns {Promise<{ok:boolean, live:Object|null, message:string}>}
 */
async function undoRally(matchId, actor) {
  const target = liveTarget(matchId, actor);
  if (target.error) return { ok: false, live: null, message: target.error };

  const state = liveStore.get(matchId);
  if (!state) return { ok: false, live: null, message: '这场比赛还没开实时计分台' };
  // 定稿之后正式比分已经写进比赛记录，此时再撤会让实时态与比赛记录各说各话。
  if (isFinalized(state)) {
    return { ok: false, live: state, message: '比赛已经定稿，不能再撤销判球' };
  }
  if (!state.rallies || state.rallies.length === 0) {
    return { ok: false, live: state, message: '没有可撤销的判球' };
  }

  const next = liveStore.set({
    ...undoLiveRally(state),
    updatedBy: actor,
    updatedAt: new Date(),
  });
  return { ok: true, live: next, message: '' };
}

/**
 * 定稿：把逐球流水转成正式比分，回到现有的录分链路。
 *
 * 定稿只把「打完的局」交出去（见 live-score.toOfficialScores），得到的
 * 仍是一条**待确认**的比赛——确认权照旧落在裁判 / 管理员手上，实时比分
 * 不新开一条计分链路。
 *
 * @param {string} matchId
 * @param {string} actor
 * @returns {Promise<{ok:boolean, live:Object|null, match:Object|null, message:string}>}
 */
async function finishLiveScore(matchId, actor) {
  const target = liveTarget(matchId, actor);
  if (target.error) return { ok: false, live: null, match: null, message: target.error };

  const state = liveStore.get(matchId);
  if (!state) return { ok: false, live: null, match: null, message: '这场比赛还没开实时计分台' };
  // 已经定稿过就别再交一次：正式比分早已写进比赛记录，重交只会白 bump 一次赛季
  if (isFinalized(state)) {
    return { ok: false, live: state, match: null, message: '比赛已经定稿了' };
  }
  // 只有分出胜负才能定稿：半局比分（比如 5:2）不是一场合法比赛
  if (state.status !== LIVE_STATUS.FINISHED) {
    return { ok: false, live: state, match: null, message: '比赛还没打完，不能定稿' };
  }

  const { scoreA, scoreB } = toOfficialScores(state);
  if (scoreA.length === 0) {
    return { ok: false, live: state, match: null, message: '还没有可提交的比分' };
  }

  const submitted = await submitMatch({ id: matchId, scoreA, scoreB, actor });
  if (!submitted.ok) {
    return { ok: false, live: state, match: null, message: submitted.firstError || '提交失败' };
  }

  // 实时态留在台账里（status=finished），查看端据此显示终局；
  // 正式比分已经写进 matches，回放与积分都由那条走。
  // 盖 finalizedAt 章：此后 undoRally 一律拒绝，实时态转只读。
  const now = new Date();
  const done = liveStore.set({ ...state, finalizedAt: now, updatedBy: actor, updatedAt: now });
  return { ok: true, live: done, match: submitted.match, message: '' };
}

/**
 * 批量取实时比分，供查看端轮询。只返回比分相关字段，尽量小。
 * matchIds 为空直接返回空数组——没开赛就不该产生任何读取。
 *
 * @param {string[]} matchIds
 * @returns {Promise<Array<Object>>}
 */
async function getLiveScores(matchIds) {
  const ids = Array.isArray(matchIds) ? matchIds : [];
  if (ids.length === 0) return [];
  return liveStore.byIds(ids).map(liveScoreOf);
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
 * @param {*} [initialElo] 管理员手工指定的初始等级分，留空则按前五场自动定级
 * @returns {Promise<{ok:boolean, account:Object|null, message:string}>}
 */
async function reviewMember(applicationId, actor, action, reason, initialElo) {
  const account = userStore.findAccount(applicationId);
  // 审核权不再按数据源放宽：种子里 u01 巴特尔就是管理员，切到该账号即可演示。
  // 「不能审自己的申请」这条本来就不放宽。
  const verdict = validateReview(accountOf(actor), account, action, reason, { initialElo });
  if (!verdict.ok) return { ok: false, account: null, message: verdict.message };

  const patch = {
    status: action === REVIEW_ACTION.APPROVE ? USER_STATUS.ACTIVE : USER_STATUS.DISABLED,
    action,
    reason: String(reason || '').trim(),
    actor,
    actedAt: new Date(),
  };
  // 只有「通过」且真的填了分数才落这个字段。留空时字段根本不出现，
  // 回放引擎据此判断该走自动定级（见 replay.js）
  if (action === REVIEW_ACTION.APPROVE && verdict.initialElo !== null) {
    patch.initialElo = verdict.initialElo;
  }

  userStore.setStatus(applicationId, patch);
  cache = null;
  return { ok: true, account: userStore.findAccount(applicationId), message: '' };
}

/**
 * 通过一条入会申请，申请人随即成为正式会员并进入回放名单。
 * @param {string} applicationId
 * @param {string} actor
 * @param {*} [initialElo] 选填：直接指定该会员的初始等级分，跳过前五场定级
 */
async function approveMember(applicationId, actor, initialElo) {
  return reviewMember(applicationId, actor, REVIEW_ACTION.APPROVE, '', initialElo);
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
 * 把某位会员设为 / 撤销为干事（学院负责人）。
 *
 * 【为什么与审核分开一条通路】
 * 审核动的是「账号状态」（待审核 → 正常 / 已禁用），任免动的是「角色」，
 * 且只改 role 一个字段。硬塞进 reviewMember 会让那条通路的补丁里多出一个
 * 与入会无关的字段；单独一条，改的是什么、谁有资格，都一目了然。
 *
 * 【为什么被任免者要从 load() 里回查】
 * 干事多半是种子里的老会员（如 u02 张宇轩），不在 user-store 那份申请台账
 * 里。accountOf 会先查回放后的会员名单，再退回申请名单，两处都能找。
 *
 * @param {string} targetId 被任免的会员编号
 * @param {string} actor 操作者编号
 * @param {boolean} makeLeader true 设为干事，false 撤销
 * @returns {Promise<{ok:boolean, account:Object|null, message:string}>}
 */
async function setCollegeLeader(targetId, actor, makeLeader) {
  const target = accountOf(targetId);
  const verdict = validateCollegeLeader(accountOf(actor), target, makeLeader);
  if (!verdict.ok) return { ok: false, account: null, message: verdict.message };

  roleStore.setRole(target._id, verdict.role);
  cache = null;
  // 重新查一遍，拿到的就是盖过角色补丁的新身份
  return { ok: true, account: accountOf(target._id), message: '' };
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
  // 发布权不再按数据源放宽：种子里 u01 巴特尔就是管理员，切到该账号即可演示
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

  // 单打不抽签就没有任何一场比赛可打，且开赛后抽签入口会关闭，
  // 整场赛事会卡死。拦住并说清该做什么。
  const blocked = startBlockedReason(target);
  if (blocked) return { ok: false, record: null, message: blocked };

  eventStore.setStatus(id, { status: EVENT_STATUS.ONGOING, actor, actedAt: new Date() });
  cache = null;
  return { ok: true, record: findEvent(id), message: '' };
}

/**
 * 置顶 / 取消置顶一场赛事。**仅管理员**，与发布同一门槛。
 *
 * 【为什么置顶单独一个动作，而不是混进状态改判】
 * 改判走的是「开始 / 结束」这类有状态机约束的路径；置顶与赛事进行到哪一步
 * 无关——报名中可以置顶，已结束也可以。单独一个动作才不会把「现在能不能
 * 开始」那套判断连累到置顶上。落在 eventStore 的 override 里即可，种子赛事
 * （e01……）也能被置顶。
 *
 * @param {string} id
 * @param {boolean} pinned
 * @param {string} actor
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function setEventPinned(id, pinned, actor) {
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) return { ok: false, record: null, message: '找不到这场赛事' };
  if (!canManageEvent(account)) {
    return { ok: false, record: null, message: '当前账号没有管理赛事的权限' };
  }

  eventStore.setStatus(id, { pinned: Boolean(pinned), actor, actedAt: new Date() });
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
    // 逐条说清是哪一样不满足，别把「已经开赛」混进「没有权限」。
    // 单打双打都可抽签，双打由抽签把报名的个人编成队伍（见 draw.js）
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
  // 首轮（或循环赛第一轮）由赛制决定：单败摆签表，分组摆各组第一轮
  const matches = buildInitialMatches(target, draw).map((draft) => matchStore.saveMatch(draft));

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
  const { users } = load();
  const account = accountOf(actor);
  const target = findEvent(id);
  if (!target) return { ok: false, record: null, message: '找不到这场赛事' };

  if (!userId) return { ok: false, record: null, message: '请指定要签到的会员' };

  // 干事只能签本学院的人；管理员通行（见 event.canCheckIn）
  const member = users.find((u) => u._id === userId) || null;
  if (!canCheckIn(target, account, { target: member || {} })) {
    return { ok: false, record: null, message: '当前账号不能为会员签到' };
  }

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
  // 循环 / 小组赛走「阶梯」口径：名次列为 1..N，不再受三四名成对规则约束
  const checked = validatePlacements(results, {
    bronzeMode: target.bronzeMode,
    entryCount,
    format: target.format,
    // 名次单位随项目变：单打一位 1 人，双打一位 2 人（两人名次相同）
    matchType: target.matchType,
  });
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

/* ---------- 学院赛闭环 ---------- */
/* 发布 → 收名单 → 审核名单。与云端 college-handlers.js 同一套规则，
   校验一律复用 services/college-event.js / college-entry.js 的纯函数，
   这里只管判权、落库与返回形状。学院赛不进回放，因此无需失效缓存。 */

/**
 * 发布一场学院赛。落库即「报名中」。
 *
 * 发布权仅管理员（见 college-event.canManageCollegeEvent）——学院赛要定
 * 小项序列、人数上下限、胜负算法，这些是整场赛事的规则，定错所有学院跟着重来。
 *
 * @param {Object} form 学院赛表单
 * @param {string} actor 发布者编号
 * @returns {Promise<{ok:boolean, record:Object|null, errors:Object, firstError:string}>}
 */
async function publishCollegeEvent(form, actor) {
  const account = accountOf(actor);
  if (!canManageCollegeEvent(account)) {
    return { ok: false, record: null, errors: {}, firstError: '当前账号没有发布学院赛的权限' };
  }

  const built = buildCollegeEventRecord(form, { actor: account });
  if (!built.ok) {
    return { ok: false, record: null, errors: built.errors, firstError: built.firstError };
  }

  const record = collegeStore.addEvent(built.record);
  return { ok: true, record, errors: {}, firstError: '' };
}

/**
 * 提交本学院的参赛名单。**干事（本学院）+ 管理员**，且仅在报名中。
 *
 * 队员身份一律用台账里的会员回查（不信任调用方给的 college），
 * 与 accountOf 同一思路。同一赛事同一学院只有一份名单，重复提交覆盖旧的。
 *
 * @param {Object} payload { eventId, college, memberIds, remark }
 * @param {string} actor 提交人编号
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function submitCollegeEntry(payload = {}, actor) {
  const account = accountOf(actor);
  const event = collegeStore.findEvent(payload.eventId);
  const built = buildCollegeEntryRecord(payload, {
    event,
    actor: account,
    members: load().members,
  });

  if (!built.ok) {
    return { ok: false, record: null, message: built.message };
  }

  const record = collegeStore.saveEntry(built.record);
  return { ok: true, record, message: '' };
}

/**
 * 审核一份名单。**仅管理员**，且只能处理「待审核」的那一份。
 *
 * 退回必须给理由（与入会审核同一条硬规则）：没有理由，学院只知道没过，
 * 不知道该改哪里。通过时清空理由，避免上一轮退回的说明留在通过记录上。
 *
 * @param {string} entryId
 * @param {string} action REVIEW_ACTION.APPROVE / REJECT
 * @param {string} [reason]
 * @param {string} actor 审核人编号
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function reviewCollegeEntry(entryId, action, reason, actor) {
  const account = accountOf(actor);
  const entry = collegeStore.findEntryById(entryId);
  const checked = validateEntryReview(account, entry, action, reason);

  if (!checked.ok) {
    return { ok: false, record: null, message: checked.message };
  }

  const record = collegeStore.updateEntry(entryId, {
    status: checked.status,
    reviewedBy: account ? account._id : '',
    reviewedAt: new Date(),
    reason: action === REVIEW_ACTION.REJECT ? String(reason || '').trim() : '',
  });
  return { ok: true, record, message: '' };
}

/* ---------- 学院赛抽签 / 大场 / 排阵 ---------- */
/* 与云端 college-handlers.js 同一套规则，校验一律复用纯模块。 */

/**
 * 某场学院赛的大场列表。
 * @param {string} [eventId]
 * @returns {Promise<Array<Object>>}
 */
async function getCollegeTies(eventId) {
  ensureCollegeDemo();
  return collegeStore.listTies(eventId);
}

/**
 * 某场学院赛的排阵列表（整批取，供「自动沿用上次」用）。
 * @param {string} [eventId]
 * @returns {Promise<Array<Object>>}
 */
async function getCollegeLineups(eventId) {
  ensureCollegeDemo();
  return collegeStore.listLineups(eventId);
}

/**
 * 抽签：把已通过审核的学院排进签表，赛事转入「待开赛」（即锁定名单）。
 *
 * @param {string} eventId
 * @param {string} actor 操作人编号
 * @param {Object} [options] { seedColleges, seedValue }
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function drawCollegeEvent(eventId, actor, options = {}) {
  const account = accountOf(actor);
  const event = collegeStore.findEvent(eventId);
  if (!event) return { ok: false, record: null, message: '找不到这场学院赛' };

  const entries = collegeStore.listEntries(eventId);
  // seedValue 由调用方给（测试可复现）；没给就现取一个随机值并落库备查
  const seedValue = Number.isFinite(Number(options.seedValue))
    ? Number(options.seedValue)
    : Math.floor(Math.random() * 0x7fffffff);

  const plan = planCollegeDraw({
    event,
    actor: account,
    entries,
    seedColleges: options.seedColleges,
    seedValue,
  });
  if (!plan.ok) return { ok: false, record: null, message: plan.message };

  const draw = buildCollegeDrawRecord(plan, {
    drawnAt: new Date(),
    drawnBy: account ? account._id : '',
  });
  const record = collegeStore.updateEvent(eventId, { draw, status: COLLEGE_EVENT_STATUS.READY });
  return { ok: true, record, message: '' };
}

/**
 * 赛事级「开始」：转入进行中，并生成第一轮全部大场（D35、D36）。
 *
 * @param {string} eventId
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, record:Object|null, ties:Array<Object>, message:string}>}
 */
async function startCollegeEvent(eventId, actor) {
  const account = accountOf(actor);
  const event = collegeStore.findEvent(eventId);
  if (!event) return { ok: false, record: null, ties: [], message: '找不到这场学院赛' };

  if (!canStartCollegeEvent(event, account)) {
    if (event.status !== COLLEGE_EVENT_STATUS.READY) {
      return { ok: false, record: null, ties: [], message: '还没有抽签，不能开始' };
    }
    return { ok: false, record: null, ties: [], message: '只有管理员可以开始赛事' };
  }

  const ties = buildTiesForRound({ event, round: 1, pairs: firstRoundPairsOf(event.draw) });
  collegeStore.saveTies(ties);
  const record = collegeStore.updateEvent(eventId, {
    status: COLLEGE_EVENT_STATUS.ONGOING,
    currentRound: 1,
    startedAt: new Date(),
  });
  return { ok: true, record, ties, message: '' };
}

/**
 * 置顶 / 取消置顶一场学院赛。**仅管理员**，与发布同一门槛。
 *
 * 与个人赛同一口径：置顶与赛事进行到哪一步无关。学院赛不进回放缓存，
 * 改完直接读台账即可，无需失效缓存。
 *
 * @param {string} eventId
 * @param {boolean} pinned
 * @param {string} actor
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function setCollegeEventPinned(eventId, pinned, actor) {
  const account = accountOf(actor);
  const target = collegeStore.findEvent(eventId);
  if (!target) return { ok: false, record: null, message: '找不到这场学院赛' };
  if (!canManageCollegeEvent(account)) {
    return { ok: false, record: null, message: '当前账号没有管理学院赛的权限' };
  }

  const record = collegeStore.updateEvent(eventId, {
    pinned: Boolean(pinned),
    actor,
    actedAt: new Date(),
  });
  return { ok: true, record, message: '' };
}

/**
 * 提交本大场的排阵。**干事（本学院）+ 管理员**，且大场尚未开始（D37）。
 *
 * @param {Object} payload { tieId, college, entries }
 * @param {string} actor 提交人编号
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function submitLineup(payload = {}, actor) {
  const account = accountOf(actor);
  const tie = collegeStore.findTie(payload.tieId);
  if (!tie) return { ok: false, record: null, message: '找不到这个大场' };

  const event = collegeStore.findEvent(tie.eventId);
  const college = String(payload.college || (account && account.college) || '').trim();
  // 排阵的人必须出自本学院已通过审核的名单
  const entry = collegeStore.findEntry(tie.eventId, college);

  const built = buildLineupRecord(
    { ...payload, college },
    { tie, event, actor: account, entry, carriedFrom: payload.carriedFrom, members: load().members }
  );
  if (!built.ok) return { ok: false, record: null, message: built.message };

  const record = collegeStore.saveLineup(built.record);
  // 每次只翻自己那一侧，另一方不受影响
  const side = built.record.college === tie.collegeA ? 'lineupA' : 'lineupB';
  collegeStore.updateTie(tie._id, { [side]: true });
  return { ok: true, record, message: '' };
}

/**
 * 大场级「开始」。**仅管理员**，且双方排阵已齐（D38）。
 *
 * @param {string} tieId
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function startTie(tieId, actor) {
  const account = accountOf(actor);
  const tie = collegeStore.findTie(tieId);
  if (!tie) return { ok: false, record: null, message: '找不到这个大场' };

  if (!canStartTie(tie, account)) {
    if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) {
      return { ok: false, record: null, message: '这个大场已经开始' };
    }
    if (!(tie.lineupA && tie.lineupB)) {
      return { ok: false, record: null, message: '双方排阵还没交齐，不能开始' };
    }
    return { ok: false, record: null, message: '只有管理员可以开始大场' };
  }

  const event = collegeStore.findEvent(tie.eventId);
  const built = buildLegMatchDrafts({
    event,
    tie,
    lineups: collegeStore.listLineups(tie.eventId),
    now: new Date(),
  });
  if (!built.ok) return { ok: false, record: null, message: built.message };

  // 每个小项落一场待确认的比赛，并把编号写回小项，录分页据此取场次
  const byLegNo = new Map(built.drafts.map((draft) => [Number(draft.legNo), draft._id]));
  for (const draft of built.drafts) matchStore.saveMatch(draft);
  const legs = (Array.isArray(tie.legs) ? tie.legs : []).map((leg) => ({
    ...leg,
    matchId: byLegNo.get(Number(leg.legNo)) || leg.matchId || '',
  }));

  const record = collegeStore.updateTie(tieId, {
    status: TIE_STATUS.ONGOING,
    startedAt: new Date(),
    legs,
  });
  cache = null;
  return { ok: true, record, message: '' };
}

/**
 * 小场确认后推进大场：写回小项结果、定出大场胜负，本轮打完则排下一轮。
 * 与云端 college-advance.js 同一套规则，复用同一批纯函数。
 *
 * @param {Object} legMatch 刚生效的小场记录
 */
function advanceCollegeAfterLeg(legMatch) {
  if (!legMatch || !legMatch.tieId) return;
  const tie = collegeStore.findTie(legMatch.tieId);
  if (!tie) return;
  const event = collegeStore.findEvent(tie.eventId);

  const legs = (Array.isArray(tie.legs) ? tie.legs : []).map((leg) =>
    Number(leg.legNo) === Number(legMatch.legNo) ? { ...leg, ...legResultOf(tie, legMatch) } : leg
  );
  const summary = summarizeTie({ tie: { ...tie, legs }, event });

  const patch = { legs };
  if (summary.complete && summary.winnerSide) {
    patch.status = TIE_STATUS.FINISHED;
    patch.winner = summary.winner;
    patch.finishedAt = new Date();
  }
  collegeStore.updateTie(tie._id, patch);

  if (!patch.winner) return;
  const merged = collegeStore
    .listTies(tie.eventId)
    .map((item) => (item._id === tie._id ? { ...item, ...patch } : item));
  const pairs = nextRoundPairsOf({ draw: event.draw, ties: merged, round: tie.round });
  if (pairs.length === 0) return;
  const nextTies = buildTiesForRound({ event, round: Number(tie.round) + 1, pairs });
  // 只补不覆盖：已排过的轮次不重排，免得冲掉已录的比分
  const taken = new Set(collegeStore.listTies(tie.eventId).map((item) => item._id));
  collegeStore.saveTies(nextTies.filter((draft) => !taken.has(draft._id)));
}

/**
 * 撤销一场学院赛小场之前：这道撤销会不会把签表留在悬空状态。
 * 与云端 collegeLegRevokeBlocker 同一套规则。
 *
 * @param {Object} legMatch 待撤销的小场
 * @returns {string} 拒绝理由；可以撤时给空串
 */
function collegeLegRevokeBlocker(legMatch) {
  if (!legMatch || !legMatch.tieId) return '';
  const tie = collegeStore.findTie(legMatch.tieId);
  if (!tie) return '';
  const ahead = collegeStore
    .listTies(tie.eventId)
    .filter((item) => Number(item.round) > Number(tie.round));
  if (ahead.length > 0) {
    return `这场大场的结果已经排进了第 ${ahead[0].round} 轮，请从最后一轮往前依次撤销`;
  }
  // 另一种拦法在大场那一侧：撤的是决定性的那一场时，大场会再也打不完
  const event = collegeStore.findEvent(tie.eventId);
  const reverted = revertLegResult({ tie, event, legNo: legMatch.legNo });
  return reverted && reverted.blocked ? reverted.blocked : '';
}

/**
 * 撤销一场学院赛小场之后：把结果从大场里收回来。
 * 与云端 revertCollegeAfterRevoke 同一套规则，复用同一个纯函数。
 *
 * @param {Object} legMatch 已作废的小场
 */
function revertCollegeAfterRevoke(legMatch) {
  if (!legMatch || !legMatch.tieId) return;
  const tie = collegeStore.findTie(legMatch.tieId);
  if (!tie) return;
  const event = collegeStore.findEvent(tie.eventId);
  const reverted = revertLegResult({ tie, event, legNo: legMatch.legNo });
  // 拦截已经在前置检查里做过；这里再判一次是为了「查到什么就是什么」
  if (!reverted || !reverted.patch) return;
  collegeStore.updateTie(tie._id, reverted.patch);
}

/**
 * 管理员记一次弃权（M4-7）。**仅管理员**，且大场已开始。
 * 与云端 recordForfeit 同一套规则：弃权方丢掉这一小项、对手晋级，且不计 ELO。
 *
 * @param {string} tieId
 * @param {number} legNo
 * @param {string} forfeitBy 弃权学院（必须是本大场参赛学院）
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, match:Object|null, message:string}>}
 */
async function recordForfeit(tieId, legNo, forfeitBy, actor) {
  const account = accountOf(actor);
  if (!canManageCollegeEvent(account)) {
    return { ok: false, match: null, message: '只有管理员可以记录弃权' };
  }

  const tie = collegeStore.findTie(tieId);
  if (!tie) return { ok: false, match: null, message: '找不到这个大场' };
  if (tie.status === TIE_STATUS.FINISHED) {
    return { ok: false, match: null, message: '这个大场已经结束' };
  }
  if (tie.status !== TIE_STATUS.ONGOING) {
    return { ok: false, match: null, message: '大场还没开始，不能记弃权' };
  }

  const leg = (Array.isArray(tie.legs) ? tie.legs : []).find(
    (item) => Number(item.legNo) === Number(legNo)
  );
  if (!leg) return { ok: false, match: null, message: '找不到这个小项' };
  if (!leg.matchId) return { ok: false, match: null, message: '这个小项还没有生成比赛' };
  if (leg.winner) return { ok: false, match: null, message: '这个小项已经有结果了' };

  const college = String(forfeitBy || '').trim();
  if (college !== tie.collegeA && college !== tie.collegeB) {
    return { ok: false, match: null, message: '弃权的必须是本大场的参赛学院' };
  }

  const match = findRecord(leg.matchId);
  if (!match) return { ok: false, match: null, message: '找不到这个小项的比赛' };
  if (match.status === MATCH_STATUS.ACTIVE) {
    return { ok: false, match: null, message: '这个小项已经生效，不能再记弃权' };
  }

  const winner = college === tie.collegeA ? TEAM.B : TEAM.A;
  const patch = {
    outcome: MATCH_OUTCOME.FORFEIT,
    forfeitBy: college,
    winner,
    scoreA: [],
    scoreB: [],
    recorder: actor,
    status: MATCH_STATUS.ACTIVE,
    action: 'forfeit',
    actor,
    actedAt: new Date(),
  };
  matchStore.setStatus(leg.matchId, patch);
  cache = null;

  const patched = { ...match, ...patch };
  advanceCollegeAfterLeg(patched);
  return { ok: true, match: patched, message: '' };
}

/**
 * 录入学院名次并结束赛事（M5-1）。**仅管理员**，且赛事已进入比赛态。
 * 与云端 finishCollegeEvent 同一套规则，复用同一个纯校验。
 *
 * 【为什么不重放缓存】
 * 学院赛名次不产生个人等级分与赛季积分（M5-2）：它写在 college_events
 * 集合里，回放的 events 输入只取个人赛，两者本就不相交。写完即可返回。
 *
 * @param {string} id 学院赛编号
 * @param {Array<{college:string, placement:number|string}>} results
 * @param {string} actor 操作人编号
 * @returns {Promise<{ok:boolean, record:Object|null, message:string}>}
 */
async function finishCollegeEvent(id, results, actor) {
  const account = accountOf(actor);
  if (!canManageCollegeEvent(account)) {
    return { ok: false, record: null, message: '只有管理员可以录入名次' };
  }

  const event = collegeStore.findEvent(id);
  if (!event) return { ok: false, record: null, message: '找不到这场学院赛' };
  if (event.status === COLLEGE_EVENT_STATUS.FINISHED) {
    return { ok: false, record: null, message: '这场学院赛已经结束了' };
  }
  if (event.status !== COLLEGE_EVENT_STATUS.ONGOING) {
    return { ok: false, record: null, message: '学院赛还没开始，不能录入名次' };
  }

  // 只能给「已通过审核」的学院记名次，挡住手滑写进来的学院名
  const colleges = collegeStore
    .listEntries(id)
    .filter((entry) => entry.status === COLLEGE_ENTRY_STATUS.APPROVED)
    .map((entry) => entry.college);

  const checked = validateCollegePlacements(results, { colleges });
  if (!checked.ok) return { ok: false, record: null, message: checked.firstError };

  const patch = {
    status: COLLEGE_EVENT_STATUS.FINISHED,
    results: checked.results,
    finishedAt: new Date(),
    actor,
  };
  const record = collegeStore.updateEvent(id, patch);
  return { ok: true, record, message: '' };
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
  forfeitMatch,
  assignMatchReferee,
  assignTieReferee,
  startLiveScore,
  recordRally,
  undoRally,
  finishLiveScore,
  getLiveScores,
  registerMember,
  approveMember,
  rejectMember,
  setCollegeLeader,
  publishAnnouncement,
  archiveAnnouncement,
  updateProfile,
  resetSeason,
  publishEvent,
  startEvent,
  setEventPinned,
  drawEvent,
  signUpEvent,
  cancelSignupEvent,
  checkInEvent,
  finishEvent,
  publishCollegeEvent,
  submitCollegeEntry,
  reviewCollegeEntry,
  drawCollegeEvent,
  startCollegeEvent,
  setCollegeEventPinned,
  submitLineup,
  startTie,
  recordForfeit,
  finishCollegeEvent,
  getCurrentUser,
  getMembers,
  getMember,
  getMemberApplications,
  getMatches,
  getEvents,
  getEventSignups,
  getCollegeEvents,
  getCollegeEvent,
  getCollegeEntries,
  getCollegeTies,
  getCollegeLineups,
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
