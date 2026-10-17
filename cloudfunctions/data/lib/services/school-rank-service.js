/**
 * 学校维度：计分 / 赛季 / 排行榜（协议 2，M4）
 * ============================================================
 * 【Elo 逐场结算改造后的读取口径】
 * 等级分不再由比赛流水重放：当前评级落库在 member_ratings（确认比赛时
 * 逐场结算，见 school-rating-service），读取端直接**点读评级表**；个人
 * 历史与走势读比赛上的**结算快照**（settlement），绝不由当前评级反推。
 * 本模块只做「取数 + 组形状 + 判权」，一行计分逻辑都不重写。
 *
 *   评级      → member_ratings（缺档按性别展示值兜底，读请求不写库）
 *   积分      → school-points-service（赛事名次分 + 训练签到分，独立聚合）
 *   个人历史  → settlement.players（只取计分场；走势按结算序号连链）
 *   榜单排序  → buildProjectLeaderboard（纯模块）
 *   赛季权限  → canResetSeason（纯模块，与旧栈同一门槛）
 *
 * 【为什么不落排行榜快照】
 * 每次读 = 一次范围评级列表 + 一次范围比赛列表（只挑带快照的），数据量
 * 下这最快也最不会出错；云端真要上量时再加按范围的快照——那是性能优化，
 * 不影响这里的接口形状。
 *
 * 【赛季键为什么带学校与协会】
 * 赛季锚点 / 分界点 / 编号都是「每校每协会各一份」。若共用一个键，一个
 * 协会开新赛季会把另一个协会的分界一起改掉。键由 scopeKey 组成，天然隔离。
 * ============================================================
 */

const { canReadAssociationSpace } = require('./association-space-permission.js');
const { legacyActorOf, legacyRoleOf, buildDirectory } = require('./school-actor.js');
const { permissionOf, permissionLabelOf } = require('./school-permission.js');
const { displayRating } = require('./school-rating-service.js');
const { aggregatePoints, collectEventPointFacts, mountEventPointDeltas } = require('./school-points-service.js');
const { buildTrainingPointFacts } = require('./training-points.js');
const { buildProjectLeaderboard, percentileFromBoard } = require('../utils/leaderboard.js');
const { getPoolRating } = require('../utils/rating.js');
const {
  buildEventRecord, summarizeEvents, buildRatingHistory, buildHeadToHead,
  buildPartnerRecord, buildMatchHistory, summarizeForm,
} = require('../utils/stats.js');
const { isEventDoc } = require('./school-event-service.js');
const { canResetSeason } = require('./season.js');
const { formatElo, formatPercent } = require('../utils/format.js');
const {
  ALL_RATING_POOLS, ALL_RANK_PROJECTS, RANK_PROJECT_LABEL, RANK_PROJECT_CONFIG,
  USER_STATUS, SETTLEMENT_STATUS,
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
 * 本范围的训练积分事实（P5 接入）：已确认的签到归一成事实。
 * 【Elo 逐场结算改造后】训练事实交给 school-points-service 统一聚合，
 * 这里保留导出供需要事实明细的调用方（测试）使用。
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
 * 装载本范围的读取视图：在册会员 + 落库评级 + 计分比赛 + 赛季积分。
 * ============================================================
 * 这是三个读接口（榜单 / 会员成绩 / 个人主页）共用的取数层，取代旧的
 * 旧的 replayScope——**不再有全量回放**：
 *   · 评级来自 member_ratings 列表（按 scope 查询一次），缺档的会员用
 *     displayRating 兜底（按性别的起点展示值，不写库）；
 *   · 计分比赛取带「计分结算快照」的已生效比赛，players 取自快照
 *     （赛前/赛后分是结算那一刻的事实），并按 settlementSeq 升序排列
 *     ——这正是 Elo 变化链的顺序；
 *   · 积分由 school-points-service 从赛事结果与训练事实独立聚合，
 *     赛事分按「结算序号最大的那场」挂载 pointDelta。
 *
 * @param {Object} ctx
 * @returns {Promise<{season:Object, members:Array<Object>, matches:Array<Object>, pointFacts:Array<Object>}>}
 */
async function loadScopeView(ctx) {
  const season = await loadSeason(ctx);
  const [members, matches, ratingDocs, events, trainings, trainingRegistrations] = await Promise.all([
    replayMembersOf(ctx),
    ctx.repo.forScope(ctx).matches.list(),
    ctx.repo.forScope(ctx).memberRatings.list(),
    ctx.repo.forScope(ctx).events.list(),
    ctx.repo.forScope(ctx).associationTrainings.list(),
    ctx.repo.forScope(ctx).trainingRegistrations.list(),
  ]);

  // ── 评级：按「userId|pool」建索引；缺档按性别兜底，读请求不写库 ──
  const ratingByKey = new Map(ratingDocs.map(doc => [`${doc.userId}|${doc.pool}`, doc]));
  const viewMembers = members.map((user) => ({
    ...user,
    ratings: ALL_RATING_POOLS.reduce((acc, pool) => {
      const doc = ratingByKey.get(`${user._id}|${pool}`);
      acc[pool] = doc || displayRating(user, pool);
      return acc;
    }, {}),
  }));

  // ── 计分比赛：带「计分」结算快照的已生效比赛，按结算序号连成 Elo 链 ──
  const pointFacts = collectEventPointFacts({ events, resetTime: season.resetTime });
  const ratedMatches = matches
    .filter(match => match.status === 1 && match.settlement
      && match.settlement.status === SETTLEMENT_STATUS.RATED)
    .map(match => ({
      ...match,
      // players 取自快照并补 pointDelta 槽位：赛事分挂载由下面完成
      players: (match.settlement.players || []).map(player => ({ ...player, pointDelta: 0 })),
    }))
    .sort((a, b) => Number(a.settlement.settlementSeq || 0) - Number(b.settlement.settlementSeq || 0));

  // ── 积分：独立聚合（赛事 + 训练），赛事分挂到各人最后一场 ──
  const pointsByUser = aggregatePoints({
    events,
    trainings,
    trainingRegistrations,
    resetTime: season.resetTime,
    members: viewMembers.map(m => ({ userId: m._id })),
  });
  mountEventPointDeltas(ratedMatches, pointFacts);
  for (const member of viewMembers) {
    member.points = pointsByUser.get(member._id) || 0;
  }

  return { season, members: viewMembers, matches: ratedMatches, pointFacts };
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

  const { members } = await loadScopeView(ctx);
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
 * 取数走 loadScopeView（与榜单同一份视图），因此这里给出的等级分与积分必然
 * 与榜单一致；评级已落库、读请求不写库。
 *
 * 【跨范围只读得到本范围的人】
 * loadScopeView 只装载 primarySchoolId 匹配本范围、且正常在册的会员，请求里
 * 夹带外校编号也取不到——隔离在取数层完成，不靠调用方自觉。
 *
 * @param {Object} [payload] { userIds?: string[] } 省略则返回本范围全部在册会员
 * @param {Object} ctx
 */
async function getSchoolMemberStats(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok({ ok: false, members: [], message: '没有读取本协会成绩的权限' });
  const wanted = new Set((Array.isArray(payload.userIds) ? payload.userIds : [])
    .filter(id => typeof id === 'string' && id));

  const { members } = await loadScopeView(ctx);
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

  const { members, matches } = await loadScopeView(ctx);
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

  const ratingHistory = active ? buildRatingHistory(matches, userId, active.pool, { order: "settlement" }) : [];
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

  // 分界点由客户端传入，但必须是个能解析的时间。NaN 会顺着 resetTime 流进
  // 积分切分与交手名额计数，报错点离现场很远（2026-10-17 只读审计 C6）。
  // 校验放在事务外：明显非法的请求不必占一个事务。
  const requested = payload.resetTime === undefined || payload.resetTime === null
    ? null : new Date(payload.resetTime);
  if (requested && !Number.isFinite(requested.getTime())) {
    return ok(refused('赛季分界时间无效'));
  }

  const id = seasonKeyOf(ctx);
  const result = await ctx.repo.transaction(async tx => {
    const existing = await tx.seasons.getById(id);
    const base = existing && belongsToSchoolScope(existing, ctx) ? existing : defaultSeason(ctx);
    const resetTime = requested || ctx.now;
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
