/**
 * 学校维度：计分 / 赛季 / 排行榜（协议 2，M4）
 * ============================================================
 * 旧栈的等级分从比赛流水重放而来（见 mock.buildCache / 云端 derive.js），
 * 本模块是这套管线在**学校维度**下的对应物：读的是本范围（`schoolId +
 * association`）的流水与会员，算出的分数按学校 / 协会天然分开——同一名
 * 会员在两所学校各持一份等级分，互不相干。
 *
 * 【复用同一把尺子，只换数据边界】
 *   流水筛选  → isEloEligibleMatch + findCappedMatchIds（与 mock / derive 一致）
 *   计分回放  → replaySeason（纯模块，逐字节镜像上云）
 *   榜单排序  → buildProjectLeaderboard（纯模块）
 *   赛季权限  → canResetSeason（纯模块，与旧栈同一门槛）
 * 这里只做「取数 + 组形状 + 判权」，一行计分逻辑都不重写。学校维度止步于
 * `ctx.repo.forScope(ctx)` 与按范围派生的赛季键。
 *
 * 【为什么不落排行榜快照】
 * 旧栈云端为了省掉冷启动时的全表读 + 两遍回放，把结果另存一份 rankings
 * 快照。本模块当前每次都现算：mock 与测试的数据量下这最快也最不会出错，
 * 而「分数以流水为唯一事实来源」这条纪律因此少一个可能不一致的副本。
 * 云端真要上量时，再按 derive.js 的办法加一层按范围的快照即可——那是
 * 性能优化，不影响这里的接口形状。
 *
 * 【赛季键为什么带学校与协会】
 * 赛季锚点 / 分界点 / 编号都是「每校每协会各一份」。若共用一个键，一个
 * 协会开新赛季会把另一个协会的分界一起改掉。键由 scopeKey 组成，天然隔离。
 * ============================================================
 */

const { canReadAssociationSpace } = require('./association-space-permission.js');
const { legacyActorOf, legacyRoleOf, buildDirectory } = require('./school-actor.js');
const { permissionOf, permissionLabelOf } = require('./school-permission.js');
const { replaySeason } = require('./replay.js');
const { isEloEligibleMatch } = require('./college-tie.js');
const { findCappedMatchIds } = require('./rating-cap.js');
const { buildProjectLeaderboard, percentileFromBoard } = require('../utils/leaderboard.js');
const { getPoolRating } = require('../utils/rating.js');
const { buildTrainingPointFacts } = require('./training-points.js');
const {
  buildEventRecord, summarizeEvents, buildRatingHistory, buildHeadToHead,
  buildPartnerRecord, buildMatchHistory, summarizeForm,
} = require('../utils/stats.js');
const { isEventDoc } = require('./school-event-service.js');
const { canResetSeason } = require('./season.js');
const { formatElo, formatPercent } = require('../utils/format.js');
const {
  ALL_RATING_POOLS, ALL_RANK_PROJECTS, RANK_PROJECT_LABEL, RANK_PROJECT_CONFIG, USER_STATUS,
} = require('../utils/constants.js');
const {
  scopeKey, belongsToSchoolScope, SCHOOL_MEMBER_STATUS, PLATFORM_STATUS,
  schoolMemberKey, schoolRoleKey, schoolMembershipKey,
} = require('../utils/school.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 榜单标题。与旧栈 rank-view.BOARD_LABEL 同一口径：只剩等级分这一把尺子。 */
const BOARD_LABEL = '等级分榜';

/** 榜单页最多展示多少名。与旧栈 rank-view.TOP_LIMIT 一致，是界面口径不是可调参数。 */
const TOP_LIMIT = 10;

/** 前三名的奖牌样式，其余为空串（与 rank-view.MEDALS 一致）。 */
const MEDALS = ['gold', 'silver', 'bronze'];

/** 名次对应的奖牌。 */
function medalOf(rank) {
  return MEDALS[rank - 1] || '';
}

/** 没有头像时用昵称首字占位。 */
function avatarOf(nickName) {
  return (nickName || '?').slice(0, 1);
}

/** 「定级中」「不活跃」在等级分榜上有意义，其余状态不装饰。 */
function badgeOf(status) {
  if (status === 'provisional') return '定级中';
  if (status === 'inactive') return '不活跃';
  return '';
}

/**
 * 赛季文档在仓储里的键。一个范围一份，编号自带 schoolId 与 association，
 * 跨范围读不到也改不掉（与 ratingKey 同一路数，只是赛季是范围级单例）。
 *
 * @param {Object} ctx
 * @returns {string}
 */
function seasonKeyOf(ctx) {
  return scopeKey({ schoolId: ctx.schoolId, association: ctx.association });
}

/**
 * 缺省赛季文档。仓储里还没有时用它顶上，读接口不必先写库就能工作。
 * @returns {Object}
 */
function defaultSeason(ctx) {
  return {
    _id: seasonKeyOf(ctx),
    schoolId: ctx.schoolId,
    association: ctx.association,
    anchorTime: null, // 赛季锚点，首次写入后钉死，不在本模块内改动
    resetTime: null, // 赛季分界点，null 表示从未开始过新赛季
    seasonNumber: 1, // 只有 resetSchoolSeason 能 +1
    version: 0, // 写计数器，留给将来的读缓存失效用
  };
}

/**
 * 读本范围的赛季文档（缺省返回默认值，不写库）。
 * @param {Object} ctx
 * @returns {Promise<Object>}
 */
async function loadSeason(ctx) {
  const doc = await ctx.repo.seasons.getById(seasonKeyOf(ctx));
  if (!doc || !belongsToSchoolScope(doc, ctx)) return defaultSeason(ctx);
  return doc;
}

/**
 * 把本范围在册会员组装成回放引擎要的会员记录。
 *
 * 只有「正常在册 + 平台账号启用 + 归属本校」的人才进回放名单；离校者
 * （status !== active）不上榜，其历史流水仍会被回放按 roster 忽略。
 * 补 `status: ACTIVE` 供 leaderboard.isRankable 使用——旧栈会员记录带数字
 * status，S2 在册名单不带，缺了它所有人都被判成可上榜（虽然这里本就都
 * 是 active，但显式给出免得日后加离校名单时忘掉）。
 *
 * @param {Object} ctx
 * @returns {Promise<Array<Object>>}
 */
async function replayMembersOf(ctx) {
  const [rows, users] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.users.list(),
  ]);
  const userById = new Map(users.map(user => [user._id, user]));
  return rows
    .filter(row => row.status === SCHOOL_MEMBER_STATUS.ACTIVE)
    .map(row => {
      const user = userById.get(row.userId);
      if (!user) return null;
      if (user.platformStatus !== PLATFORM_STATUS.ACTIVE) return null;
      if (user.primarySchoolId !== ctx.schoolId) return null;
      return { ...user, status: USER_STATUS.ACTIVE };
    })
    .filter(Boolean);
}

/**
 * 本范围的比赛流水：先筛「计个人等级分」的（已生效 / 非弃权 / 学院赛仅单打），
 * 再排除防刷分超限的场次（与 mock.buildCache / derive.buildDataset 同一路数）。
 *
 * @param {Object} ctx
 * @param {Object} season
 * @returns {Promise<Array<Object>>}
 */
async function replayMatchesOf(ctx, season) {
  const all = (await ctx.repo.forScope(ctx).matches.list())
    .map(match => ({ ...match }));
  const cappedIds = findCappedMatchIds(all, { seasonStart: season.resetTime });
  return all.filter(match => isEloEligibleMatch(match) && !cappedIds.has(String(match._id)));
}

/**
 * 本范围的训练积分事实（P5 接入）：已确认的签到归一成事实，交回放统一叠加。
 *
 * @param {Object} ctx
 * @returns {Promise<Array<Object>>}
 */
async function trainingFactsOf(ctx) {
  const [trainings, registrations] = await Promise.all([
    ctx.repo.forScope(ctx).associationTrainings.list(),
    ctx.repo.forScope(ctx).trainingRegistrations.list(),
  ]);
  return buildTrainingPointFacts({ trainings, registrations });
}

/**
 * 重放本范围的赛季，产出「回放后的会员」（含 ratings / points）与
 * 回放后的比赛流水（每场带 players 的赛前 / 赛后分数，供个人战绩构建器用）。
 *
 * 与旧栈一致：等级分不落库，每次由流水重放得出。返回的 members 已按
 * 本范围初始分与改分时间线重放——初始分 / 改分这些按范围存的字段，
 * 旧栈由 derive.withScopedInitialElo 摊平，S2 里本就按范围分桶，直接透传。
 *
 * @param {Object} ctx
 * @returns {Promise<{season:Object, members:Array<Object>, matches:Array<Object>}>}
 */
async function replayScope(ctx) {
  const season = await loadSeason(ctx);
  const [members, matches, trainingPointFacts, events] = await Promise.all([
    replayMembersOf(ctx),
    replayMatchesOf(ctx, season),
    trainingFactsOf(ctx),
    ctx.repo.forScope(ctx).events.list(),
  ]);
  const replayed = replaySeason({
    members,
    matches,
    events,
    options: {
      // 锚点由赛季文档钉死；尚未定下时传 null，回放退回「流水里最早一场」。
      seasonStart: season.anchorTime,
      resetTime: season.resetTime || null,
      trainingPointFacts,
    },
  });
  return { season, members: replayed.users, matches: replayed.matches };
}

/* ------------------------------------------------------------------ 排行榜 */

/**
 * 把某个项目的回放会员排成榜单行（形状与旧栈 rank-view.buildEloRows 一致）。
 *
 * 展示层只保留出场数 > 0 的人（见 rank-view 头部：否则榜首下挂一排起点分的
 * 僵尸账号），过滤后按现有次序重新编号。
 *
 * @param {Array<Object>} users 回放后的会员
 * @param {string} project 榜单项目
 * @param {string} myId 当前登录会员编号
 * @returns {Array<Object>}
 */
function buildRows(users, project, myId) {
  const board = buildProjectLeaderboard(users, project)
    .filter(row => (row.matchCount || 0) > 0)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const realNameById = new Map(users.map(user => [user._id, user.realName || '']));
  return board.map(row => ({
    userId: row._id,
    rank: row.rank,
    medal: medalOf(row.rank),
    isMe: Boolean(myId) && row._id === myId,
    nickName: row.nickName,
    // 只参与搜索，不渲染；页面上显示的一律是昵称
    realName: realNameById.get(row._id) || '',
    avatarText: avatarOf(row.nickName),
    avatarUrl: row.avatarUrl || '',
    detailText: `${row.wins} 胜 ${row.losses} 负`,
    valueText: String(formatElo(row.elo)),
    valueClass: '',
    noteText: `胜率 ${formatPercent(row.winRate)}`,
    badge: badgeOf(row.status),
  }));
}

/**
 * 空视图。没有读权限时下发它——一行榜单都不带。
 * @param {string} activeProject
 * @param {string} activeProjectLabel
 * @returns {Object}
 */
function emptyRanking(activeProject, activeProjectLabel) {
  return {
    projectTabs: projectTabs(activeProject),
    activeProject,
    activeProjectLabel,
    activeBoardLabel: BOARD_LABEL,
    rows: [],
    allRows: [],
    total: 0,
    hasMore: false,
    empty: true,
    playerCountText: '',
    emptyNote: '',
    me: null,
    meHint: '',
  };
}

/** 项目标签页：每个项目一个标签，标出当前选中的那个。 */
function projectTabs(activeProject) {
  return ALL_RANK_PROJECTS.map(project => ({
    project,
    label: RANK_PROJECT_LABEL[project],
    active: project === activeProject,
  }));
}

/**
 * 取本范围的等级分榜。形状与旧栈 rank-view.loadRankView 一致（多一个
 * `schoolName`，与 school-demo.schoolRank 对齐）。
 *
 * @param {Object} [payload] { project? }
 * @param {Object} ctx
 */
async function getSchoolRanking(payload = {}, ctx) {
  const activeProject = ALL_RANK_PROJECTS.includes(payload.project)
    ? payload.project
    : ALL_RANK_PROJECTS[0];
  const activeProjectLabel = RANK_PROJECT_LABEL[activeProject];

  // 闸门：没有读权限就到此为止，一行榜单都不发（与名录同口径）
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, schoolName: '', message: '没有读取本协会排行榜的权限',
      ...emptyRanking(activeProject, activeProjectLabel) });
  }

  const { members } = await replayScope(ctx);
  const myId = ctx.actorId || '';
  const allRows = buildRows(members, activeProject, myId);
  const rows = allRows.slice(0, TOP_LIMIT);
  const total = allRows.length;

  // 我的名次从完整榜单里找，不能只在截断后的前十行里找
  const myRow = (myId && allRows.find(row => row.isMe)) || null;

  return ok({
    ok: true,
    schoolName: (ctx.school && ctx.school.shortName) || '',
    message: '',
    projectTabs: projectTabs(activeProject),
    activeProject,
    activeProjectLabel,
    activeBoardLabel: BOARD_LABEL,
    rows,
    allRows,
    total,
    hasMore: total > rows.length,
    empty: rows.length === 0,
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: rows.length === 0 ? '这个项目还没有人打过' : '',
    me: myRow === null
      ? null
      : {
          rank: myRow.rank,
          total,
          beatText: `超过 ${formatPercent((total - myRow.rank) / total)} 的会员`,
        },
    meHint: myRow !== null ? '' : '你还没有参加过这个项目',
  });
}

/**
 * 指定会员的评级与赛季积分（供赛事名单 / 详情等展示端按人取数）。
 * ============================================================
 * 【为什么不从榜单反查】
 * 等级分榜会截断（只留前十）且过滤掉「没出过场」的人（见 buildRows），拿它当
 * 数据源会让榜外的报名者显示空白，甚至名次对不上。这里直接回放本范围流水，
 * 按编号取人——榜内榜外一个口径。
 *
 * 【与榜单同源】
 * 回放走 replayScope（同一把尺子），因此这里给出的等级分与积分必然与榜单
 * 一致；等级分不落库、每次重放这条纪律也照旧。
 *
 * 【跨范围只读得到本范围的人】
 * replayScope 只回放 primarySchoolId 匹配本范围、且正常在册的会员，请求里
 * 夹带外校编号也取不到——隔离在取数层完成，不靠调用方自觉。
 *
 * @param {Object} [payload] { userIds?: string[] } 省略则返回本范围全部在册会员
 * @param {Object} ctx
 */
async function getSchoolMemberStats(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok({ ok: false, members: [], message: '没有读取本协会成绩的权限' });
  const wanted = new Set((Array.isArray(payload.userIds) ? payload.userIds : [])
    .filter(id => typeof id === 'string' && id));

  const { members } = await replayScope(ctx);
  const rows = members
    .filter(member => wanted.size === 0 || wanted.has(member._id))
    .map(member => ({
      userId: member._id,
      nickName: member.nickName || '',
      realName: member.realName || '',
      avatarUrl: member.avatarUrl || '',
      points: Number(member.points || 0),
      ratings: ALL_RATING_POOLS.reduce((acc, pool) => {
        const rating = getPoolRating(member, pool);
        acc[pool] = {
          elo: Number(rating.elo),
          matchCount: Number(rating.matchCount || 0),
          wins: Number(rating.wins || 0),
          losses: Number(rating.losses || 0),
        };
        return acc;
      }, {}),
    }));
  return ok({ ok: true, members: rows, message: '' });
}

/**
 * 指定会员在本范围的赛事名次（「我的」页荣誉与个人详情页共用的读端，B4-c）。
 * ============================================================
 * 【为什么是独立读端】
 * 赛事列表 DTO（eventSummary）刻意保持精简、不带 results；名次是另一类
 * 展示需求（荣誉汇总 + 分组列表）。这里只读本范围已结束赛事的结果，复用
 * 旧栈纯构建器 buildEventRecord / summarizeEvents（同一把尺子），只回
 * 展示字段，不把报名、抽签、内部状态透出去。
 *
 * @param {Object} [payload] { userId } 看谁的名次；本协会成绩读权限持有者可用
 * @param {Object} ctx
 */
async function getSchoolMemberHonors(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会成绩的权限'));
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return ok(refused('缺少会员编号'));
  const events = (await ctx.repo.forScope(ctx).events.list()).filter(isEventDoc);
  const records = buildEventRecord(events, userId).map((row) => ({
    eventId: row.eventId,
    title: row.title || '',
    startTime: row.startTime || '',
    placement: Number(row.placement),
    participantCount: Number(row.participantCount),
  }));
  return ok({ ok: true, honors: { summary: summarizeEvents(records), records }, message: '' });
}

/* ------------------------------------------------------------------ 赛季 */

/**
 * 个人主页的全部数据（B4-c 的取数口）：卡片 + 项目 + 走势 / 交锋 / 搭档 /
 * 逐场战绩 / 近期状态 + 本范围赛事荣誉。
 * ============================================================
 * 【为什么一次取齐】个人页的七个板块（走势、交锋、搭档、荣誉、逐场……）全部
 * 依赖同一份「本范围回放后的流水」，客户端逐块取会重放七遍，还容易各拿一份
 * 时点不一致的数据。这里回放一次，七个纯构建器（utils/stats.js，同一把尺子）
 * 各取所需。
 *
 * 【口径】流水用计等级分的场次（与榜单一致：isEloEligibleMatch + 防刷分上限），
 * 所以逐场战绩与等级分榜的走势严格一致；已撤销 / 待确认的比赛不进个人战绩。
 * 项目 / 名次口径与旧栈 getMyProjects 一致（出场过的项目、分池、分性别）。
 *
 * @param {Object} [payload] { userId?, historyLimit? } 不传 userId 即本人
 * @param {Object} ctx
 */
async function getSchoolMemberProfile(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会成绩的权限'));
  const userId = typeof payload.userId === 'string' && payload.userId ? payload.userId : ctx.actorId;
  if (!userId) return ok(refused('缺少会员编号'));
  const historyLimit = Number.isInteger(payload.historyLimit) && payload.historyLimit > 0
    ? Math.min(payload.historyLimit, 200) : 20;

  const { members, matches } = await replayScope(ctx);
  const member = members.find(row => row._id === userId);
  if (!member) return ok({ ok: false, found: false, message: '没有找到这位会员' });

  const [memberDoc, role, membership, colleges, events] = await Promise.all([
    ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)),
    ctx.repo.schoolRoles.getById(schoolRoleKey(userId, ctx.schoolId)),
    ctx.repo.memberships.get(schoolMembershipKey(userId, ctx)),
    ctx.repo.forScope(ctx).colleges.list(),
    ctx.repo.forScope(ctx).events.list(),
  ]);
  const collegeName = id => (colleges.find(row => row.collegeId === id) || {}).name || '';
  const nameOf = id => (members.find(row => row._id === id) || {}).nickName || id;

  // 项目（与旧栈 getMyProjects 同口径）：出场过的、按性别过滤的单打 + 双打
  const projects = [];
  for (const project of ALL_RANK_PROJECTS) {
    const { pool, gender } = RANK_PROJECT_CONFIG[project];
    if (gender && member.gender !== gender) continue;
    const bucket = getPoolRating(member, pool);
    if (!bucket || bucket.matchCount === 0) continue;
    const board = buildProjectLeaderboard(members, project);
    const stats = percentileFromBoard(board, userId);
    projects.push({
      project, pool, label: RANK_PROJECT_LABEL[project],
      elo: bucket.elo, startElo: bucket.startElo, delta: bucket.elo - bucket.startElo,
      matchCount: bucket.matchCount, wins: bucket.wins, losses: bucket.losses,
      rank: stats ? stats.rank : null, total: stats ? stats.total : board.length,
      beatPercent: stats ? stats.beatPercent : 0,
    });
  }
  projects.sort((a, b) => b.matchCount - a.matchCount);
  const active = projects[0] || null;
  const poolFilter = active ? active.pool : null;

  const ratingHistory = active ? buildRatingHistory(matches, userId, active.pool) : [];
  const headToHead = buildHeadToHead(matches, userId, { nameOf, pool: poolFilter });
  const partners = buildPartnerRecord(matches, userId, { nameOf, pool: poolFilter });
  const history = buildMatchHistory(matches, userId, { nameOf, pool: poolFilter, limit: historyLimit });
  const form = summarizeForm(matches, userId, { limit: 5 });
  const eventRecords = buildEventRecord(events.filter(isEventDoc), userId);

  return ok({
    ok: true, found: true, message: '',
    // 本人账号 / 档案展示字段；权限档只作展示，服务端写路径另行判权。
    user: {
      userId,
      nickName: member.nickName || '',
      realName: member.realName || '',
      avatarUrl: member.avatarUrl || '',
      gender: member.gender || '',
      collegeId: (memberDoc && memberDoc.collegeId) || '',
      college: collegeName((memberDoc && memberDoc.collegeId) || ''),
      studentId: (memberDoc && memberDoc.studentId) || '',
      points: Number(member.points || 0),
      permissionLabel: permissionLabelOf(role, membership),
      role: legacyRoleOf({ schoolRole: role, membership, actor: member, isPlatformAdmin: member.platformRole === 'admin' }),
    },
    projects,
    active: active ? active.project : null,
    ratingHistory,
    headToHead,
    partners,
    history,
    form,
    honors: {
      summary: summarizeEvents(eventRecords),
      records: eventRecords.map(row => ({
        eventId: row.eventId, title: row.title || '', startTime: row.startTime || '',
        placement: Number(row.placement), participantCount: Number(row.participantCount),
      })),
    },
  });
}

/* ------------------------------------------------------------------ 赛季 */

/**
 * 读本范围的赛季状态。任何有读权限的会员都能看。
 * @param {Object} [payload]
 * @param {Object} ctx
 */
async function getSchoolSeason(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会赛季的权限'));
  const season = await loadSeason(ctx);
  return ok({
    ok: true,
    message: '',
    season: {
      seasonNumber: Number(season.seasonNumber || 1),
      anchorTime: season.anchorTime || null,
      resetTime: season.resetTime || null,
      version: Number(season.version || 0),
    },
  });
}

/**
 * 开始新赛季：写下分界点，赛季编号 +1。
 *
 * 【权限】与旧栈同一门槛（canResetSeason → canManage({minRole: ADMIN})）：
 * 平台管理员、校管理员、协会负责人可开新赛季，普通会员与学院负责人不行。
 *
 * 【只做两件事】记分界时间、编号 +1。等级分不参与重置，跨赛季连续累计；
 * 分界点之前的赛事 / 训练积分不计入本赛季（回放据此过滤）。锚点已定则不动。
 *
 * @param {Object} [payload] { resetTime? }
 * @param {Object} ctx
 */
async function resetSchoolSeason(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const dir = await buildDirectory(ctx);
  if (!canResetSeason(legacyActorOf(ctx, dir))) return ok(refused('只有管理员可以开始新赛季'));

  const id = seasonKeyOf(ctx);
  const result = await ctx.repo.transaction(async tx => {
    const existing = await tx.seasons.getById(id);
    const base = existing && belongsToSchoolScope(existing, ctx) ? existing : defaultSeason(ctx);
    const resetTime = payload.resetTime ? new Date(payload.resetTime) : ctx.now;
    const next = {
      ...base,
      _id: id,
      schoolId: ctx.schoolId,
      association: ctx.association,
      anchorTime: base.anchorTime || null,
      resetTime,
      seasonNumber: Number(base.seasonNumber || 1) + 1,
      version: Number(base.version || 0) + 1,
      updatedAt: new Date(ctx.now),
    };
    await tx.seasons.set(id, next);
    return {
      ok: true,
      message: '',
      season: {
        seasonNumber: next.seasonNumber,
        anchorTime: next.anchorTime,
        resetTime: next.resetTime,
        version: next.version,
      },
    };
  });
  return ok(result);
}

module.exports = {
  BOARD_LABEL,
  TOP_LIMIT,
  medalOf,
  badgeOf,
  defaultSeason,
  loadSeason,
  seasonKeyOf,
  buildRows,
  getSchoolRanking,
  getSchoolMemberStats,
  getSchoolMemberHonors,
  getSchoolMemberProfile,
  getSchoolSeason,
  resetSchoolSeason,
};
