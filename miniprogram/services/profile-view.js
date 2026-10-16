/**
 * 个人主页的视图模型
 * ============================================================
 * 「我的」页面要展示的东西很多：分数卡、分数曲线、交锋记录、
 * 搭档记录、赛事名次、逐场战绩。如果全在页面里拼装，会有两个问题：
 *
 *   1. 页面文件会膨胀到几百行，且几乎无法测试（wx 环境跑不了 Node 测试）；
 *   2. 「查看他人主页」要做一模一样的事，只能整段复制，改一处漏一处。
 *
 * 所以把「取数 + 整形 + 算文案」集中到这里，页面只剩渲染和交互。
 * 这个模块不碰任何 wx API，因而可以在 Node 里完整测试。
 *
 * 【分项目约定】
 * 页面上的项目切换（男单 / 女单 / 双打）作用范围是整页：
 * 分数、曲线、排名、交锋、搭档、赛事、逐场战绩，全部跟着当前项目走。
 * 这样「看双打」看到的就是纯粹的双打数据，不会混进单打场次。
 * 默认停在单打上（见 sortProjectsForDisplay）。
 *
 * 【项目与池的配合】
 * 项目决定「看哪张榜」（女单榜只列女生），池决定「取哪些比赛」
 * （单打的比赛流水）。所以筛选比赛时用的是 item.pool，
 * 取榜单名次时用的是 item.project，两者都从 getMyProjects 拿。
 * ============================================================
 */

const {
  ROLE,
  ROLE_LABEL,
  ASSOC_ROLE,
  ASSOC_ROLE_LABEL,
  USER_STATUS_LABEL,
  RATING_POOL_LABEL,
} = require('../utils/constants.js');
const {
  formatDate,
  formatSigned,
  formatElo,
  formatPercent,
  formatPlacement,
  formatRank,
  formatScore,
} = require('../utils/format.js');
const { sortProjectsForDisplay } = require('../utils/leaderboard.js');
const { allAssociations } = require('../utils/associations.js');
const { formatMatchFormat } = require('../utils/match-format.js');
const { resolveNameDisplay } = require('./profile.js');
const {
  validateCollegeLeader,
  validateAssociationLeader,
  canEditCurrentElo,
  isGlobalAdminMember,
} = require('./member-review.js');
const scope = require('./association-scope.js');
const { getCurrentUser } = require('./index.js');

/** 默认取多少场逐场战绩。太多会拖慢首屏，剩下的靠「加载更多」。 */
const DEFAULT_HISTORY_LIMIT = 20;

/** 近期状态的小圆点个数 */
const FORM_LIMIT = 5;

/**
 * 选出当前要展示的项目。
 *
 * 优先用调用方指定的项目（用户点了某个 tab）；指定的项目不存在时
 * 退回第一个——此时传进来的 projects 已经过 sortProjectsForDisplay，
 * 第一个也就是单打（没有单打成绩的人才会落到双打）。
 *
 * @param {Array<Object>} projects getMyProjects 的结果（建议先过一遍排序）
 * @param {string} [preferred] 项目名
 * @returns {Object|null}
 */
function pickProject(projects, preferred) {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  if (preferred) {
    const hit = projects.find((item) => item.project === preferred);
    if (hit) return hit;
  }
  return projects[0];
}

/**
 * 把分数曲线加工成页面需要的形状。
 *
 * 序列首部补一个「入池起点分」，这样曲线从进池那天开始画，
 * 和图上那条虚线（起点）自然衔接，一眼能看出「这一路涨了多少」。
 *
 * @param {Array<Object>} ratingHistory buildRatingHistory 的结果（时间升序）
 * @param {number} startElo 入池起点分
 * @returns {Object}
 */
function buildChart(ratingHistory, startElo) {
  const list = Array.isArray(ratingHistory) ? ratingHistory : [];
  const values = [startElo, ...list.map((point) => point.eloAfter)];
  const deltas = list.map((point) => ({
    value: point.eloDelta,
    matchTime: point.matchTime,
  }));

  // 单场最大涨幅：这是「加减分情况」里最值得单独拎出来的一条
  let best = null;
  let worst = null;
  for (const item of deltas) {
    if (best === null || item.value > best.value) best = item;
    if (worst === null || item.value < worst.value) worst = item;
  }

  const decorate = (item) =>
    item === null
      ? null
      : { deltaText: formatSigned(item.value), dateText: formatDate(item.matchTime) };

  return {
    empty: list.length === 0,
    values,
    pointCount: list.length,
    startElo,
    currentElo: values[values.length - 1],
    maxElo: Math.max(...values),
    minElo: Math.min(...values),
    best: decorate(best),
    worst: decorate(worst),
  };
}

/**
 * 整形逐场战绩的一行。
 * @param {Object} row getMatchHistory 的单项
 * @returns {Object}
 */
function buildHistoryRow(row) {
  return {
    matchId: row.matchId,
    dateText: formatDate(row.matchTime),
    isWin: row.isWin,
    resultText: row.isWin ? '胜' : '负',
    // 双打对手有两人，用顿号连起来读起来更顺
    rivalText: row.opponentNames.join('、'),
    partnerText: row.partnerNames.length ? `搭档 ${row.partnerNames.join('、')}` : '单打',
    scoreText: formatScore(row.score.mine, row.score.theirs),
    eloDeltaText: formatSigned(row.eloDelta),
    eloDeltaUp: row.eloDelta >= 0,
    pointDeltaText: formatSigned(row.pointDelta),
    // 日常比赛不再产生积分（决策 9），大多数场次的分差是 0。
    // 一行一行地写「积分 0」既占地方又像没算对，索性只在真有积分时显示。
    hasPointDelta: Number(row.pointDelta) !== 0,
    isEvent: Boolean(row.eventId),
    poolLabel: RATING_POOL_LABEL[row.pool] || '',
    // 赛制文案。老数据没有这两个字段时 formatMatchFormat 返回空串，
    // 模板那边用 wx:if 挡住，免得留下一截悬空的分隔符
    formatText: formatMatchFormat({ gamePoints: row.gamePoints, bestOf: row.bestOf }),
  };
}

/**
 * 会员头上的角色徽标。
 *
 * 【为什么 ADMIN 要再分两种】协会负责人的**有效角色**也是 ADMIN（见
 * context.effectiveRole），但它其实是「本协会」给的身份，与账号级的全局
 * 管理员不是一回事。只看 role 会把协会负责人显示成「管理员」，在本协会里
 * 看着像是跨协会的权限。用 isGlobalAdminMember 区分：全局管理员显「管理员」，
 * 本协会的 leader 显「协会负责人」。学院负责人（STAFF）沿用角色表的说法。
 *
 * @param {Object} user 会员记录（带有效 role 与 isGlobalAdmin）
 * @returns {string}
 */
function roleLabelOf(user) {
  if (isGlobalAdminMember(user)) return ROLE_LABEL[ROLE.ADMIN];
  if (Number(user.role || 0) >= ROLE.ADMIN) return ASSOC_ROLE_LABEL[ASSOC_ROLE.LEADER];
  return ROLE_LABEL[user.role] || '';
}

/**
 * 装载个人主页的全部数据。
 *
 * @param {string} [userId] 想看谁的页面。不传则看当前登录会员（即「我的」）。
 * @param {Object} [options]
 * @param {string} [options.project] 初始选中的项目
 * @param {number} [options.historyLimit] 逐场战绩取多少条
 * @param {Object|null} [options.viewer] 当前看页面的人（任免学院负责人要判权限）。
 *        与 loadMatchView 同一约定：由调用方从本地登录态传入，传 null 就是访客；
 *        不传则视为「没有旁观者」，任免入口一律不出现。
 * @returns {Promise<Object>} 查无此人时返回 { found: false }
 */
async function loadMemberView(userId, options = {}) {
  const { project, historyLimit = DEFAULT_HISTORY_LIMIT, viewer = null, association } = options;

  // 页面局部的协会切换（个人详情页 / 他人主页）：只想让这一页按另一个协会取数，
  // 不改变全局的当前协会。递归一次即可——第二次不再带 association，取完由
  // withAssociation 还原全局作用域。
  const api = require('./index.js').forAssociation(association || scope.getAssociation());

  const user = userId ? await api.getMember(userId) : await api.getCurrentUser();
  if (!user) {
    return { found: false };
  }

  // 入口判定（学院负责人 / 协会负责人 / 初始等级分）要读「本人是否已出场」，
  // 这只有派生数据集里的会员才带 ratings（见 rating.summarizeCareer）。云端
  // getCurrentUser 给的是账号原始文档（含手机号等本人字段）但不含 ratings，
  // 故本人场景补取一份派生记录专供判定；「看的是谁」仍用 user，展示字段不变。
  const target = user.ratings ? user : (await api.getMember(user._id)) || user;

  const projects = sortProjectsForDisplay(await api.getMyProjects(user._id));
  const active = pickProject(projects, project);
  // 没打过任何比赛的人没有项目，此时不能拿 null 去查池相关的接口
  const poolFilter = active ? { pool: active.pool } : {};

  const [ratingHistory, headToHead, partners, eventRecord, history, form] = await Promise.all([
    active ? api.getRatingHistory(user._id, active.pool) : Promise.resolve([]),
    api.getHeadToHead(user._id, poolFilter),
    api.getPartnerRecord(user._id, poolFilter),
    api.getEventRecord(user._id, poolFilter),
    api.getMatchHistory(user._id, { ...poolFilter, limit: historyLimit }),
    api.getForm(user._id, { limit: FORM_LIMIT }),
  ]);

  const eventRecords = eventRecord.records.map((row) => ({
    eventId: row.eventId,
    title: row.title,
    dateText: formatDate(row.startTime),
    placement: row.placement,
    placementText: formatPlacement(row.placement),
    // 前三名值得在界面上高亮，其余不强调
    isTop: row.placement <= 3,
    participantCount: row.participantCount,
  }));

  // 昵称与真名一起给：昵称占主位，真名小一号缀在旁边。
  // 两者相同时不重复显示（见 profile.resolveNameDisplay）。
  const nameDisplay = resolveNameDisplay(user);

  // 管理员在别人的主页上可以任免学院负责人。四条边界（是管理员、不是自己、对方
  // 状态正常且有确定学院、对方不是管理员）全部交给 validateCollegeLeader 判定，
  // 与写入端一字不差；这里只据结果决定按钮显不显示、写什么字，不另写一套规则。
  // 当前不是学院负责人时动作为「设为学院负责人」，已经是学院负责人则是「撤销学院负责人」。
  const makeLeader = Number(target.role || 0) < ROLE.STAFF;
  const leaderCheck = validateCollegeLeader(viewer, target, makeLeader);

  // 协会负责人任免入口：仅**全局管理员**可见并生效（协会负责人的有效角色也是
  // ADMIN，故用 isGlobalAdmin 区分）。目标是全局管理员或自己时整张卡不出现。
  // 目标当前已是本协会协会负责人时，按钮转为「撤销」。
  const targetIsAssocLeader =
    !isGlobalAdminMember(target) && Number(target.role || 0) >= ROLE.ADMIN;
  const makeAssocLeader = !targetIsAssocLeader;
  const assocLeaderCheck = validateAssociationLeader(viewer, target, makeAssocLeader, {
    isGlobalAdmin: Boolean(viewer && viewer.isGlobalAdmin),
  });

  // 当前等级分调整入口。不限出场与否——用来处理「在外打完比赛、对手不在本
  // 程序里」的同步（也是手工改分的唯一入口）。权限交给 canEditCurrentElo
  // （与写入端一字不差）；改分作用在**当前显示的项目**对应的池上，所以没有
  // 项目时不出现。
  const currentEloCheck = canEditCurrentElo(viewer, target);

  return {
    found: true,
    user: {
      userId: user._id,
      nickName: nameDisplay.nickName,
      realName: nameDisplay.realName,
      showRealName: nameDisplay.showRealName,
      // 没有头像时用昵称首字当占位。整串名字塞进圆形头像里会溢出。
      avatarText: (nameDisplay.nickName || '?').slice(0, 1),
      avatarUrl: user.avatarUrl || '',
      college: user.college || '',
      // 实名信息，个人资料页只读展示
      studentId: user.studentId || '',
      roleLabel: roleLabelOf(user),
      statusLabel: USER_STATUS_LABEL[user.status] || '',
      joinDateText: formatDate(user.joinDate),
      points: user.points || 0,
      // 赛季积分各协会不同。「我的」页不套协会，故那里显式关掉这个标签
      // （见 loadProfileSummary）；详情页与他人主页按协会取数，照常显示。
      showPoints: true,
    },
    // 项目切换标签。只有出过场的项目才会出现——展示一个从没打过的项目的
    // 初始分没有意义，反而会让人以为自己在那个项目上很差。
    projectTabs: projects.map((item) => ({
      project: item.project,
      label: item.label,
      elo: formatElo(item.elo),
      active: Boolean(active) && item.project === active.project,
    })),
    activeProject: active ? active.project : null,
    activeProjectLabel: active ? active.label : '',
    hasProject: Boolean(active),
    summary: active
      ? {
          elo: formatElo(active.elo),
          startElo: formatElo(active.startElo),
          delta: active.delta,
          deltaText: formatSigned(active.delta),
          deltaUp: active.delta >= 0,
          matchCount: active.matchCount,
          wins: active.wins,
          losses: active.losses,
          recordText: `${active.wins} 胜 ${active.losses} 负`,
          winRateText: formatPercent(active.wins / Math.max(active.matchCount, 1)),
          rank: active.rank,
          total: active.total,
          rankText: formatRank(active.rank, active.total),
          beatText: `超过 ${formatPercent(active.beatPercent / 100)} 的会员`,
        }
      : null,
    chart: buildChart(ratingHistory, active ? active.startElo : 0),
    form: {
      dots: form.results.map((isWin) => (isWin ? 'W' : 'L')),
      wins: form.wins,
      losses: form.losses,
      streakText: form.streak > 0 ? `${form.streak} 连胜` : '暂无连胜',
    },
    events: {
      records: eventRecords,
      summary: {
        eventCount: eventRecord.summary.eventCount,
        championCount: eventRecord.summary.championCount,
        topThreeCount: eventRecord.summary.topThreeCount,
        bestPlacementText: formatPlacement(eventRecord.summary.bestPlacement),
      },
    },
    headToHead: headToHead.map((row) => ({
      opponentId: row.opponentId,
      nickName: row.nickName,
      matchCount: row.matchCount,
      recordText: `${row.wins} 胜 ${row.losses} 负`,
      winRateText: formatPercent(row.winRate),
      // 领先为正、落后为负：直接从分数上看「跟这个人打我是赚是亏」
      deltaText: formatSigned(row.eloDeltaSum),
      deltaUp: row.eloDeltaSum >= 0,
    })),
    partners: partners.map((row) => ({
      partnerId: row.partnerId,
      nickName: row.nickName,
      matchCount: row.matchCount,
      recordText: `${row.wins} 胜 ${row.losses} 负`,
      winRateText: formatPercent(row.winRate),
    })),
    history: history.map(buildHistoryRow),
    // 任免学院负责人的入口。没有权限时整张卡不渲染，而不是给一个点下去被拒的按钮
    leader: {
      visible: leaderCheck.ok,
      makeLeader,
      label: makeLeader ? '设为学院负责人' : '撤销学院负责人',
      hint: makeLeader ? '代签、代录本学院的比赛' : '收回本学院的管理权限',
    },
    // 协会负责人任免入口（仅全局管理员）。与学院负责人同一位置并排出现。
    associationLeader: {
      visible: assocLeaderCheck.ok,
      makeLeader: makeAssocLeader,
      label: makeAssocLeader ? '设为协会负责人' : '撤销协会负责人',
      hint: makeAssocLeader ? '管理本协会的赛事、会员与公告' : '收回本协会的管理权限',
    },
    // 当前等级分调整入口：有权限、且当前有可展示的项目时才出现。改的是当前
    // 项目对应的池，所以带上 label / pool / project 让页面知道改的是哪一项。
    currentElo: {
      visible: currentEloCheck.ok && Boolean(active),
      project: active ? active.project : '',
      pool: active ? active.pool : '',
      label: active ? active.label : '',
      current: active ? active.elo : null,
    },
  };
}

/**
 * 装载「我的」页的视图模型。
 *
 * 【与 loadMemberView 的分工】「我的」页不套任何协会，因此：
 *   · 头卡只给全局信息（角色只到「会员 / 管理员」，赛季积分标签关掉）；
 *   · 赛事荣誉**跨全部协会聚合**——汇总数字各协会相加，下面按协会分组列出名次，
 *     没参加过赛事的协会不出现。
 * 等级分、走势、逐场战绩这些「随协会变化」的内容都搬去了个人详情页，
 * 因此这里一概不算（见需求整理 §11.4）。
 *
 * @returns {Promise<Object>} 未登录时返回 { found: false }
 */
async function loadProfileSummary() {
  const user = await getCurrentUser();
  if (!user) return { found: false };

  const nameDisplay = resolveNameDisplay(user);

  const loaded = await scope.mapActiveAssociations(async (assoc, api) => ({
    assoc,
    record: await api.getEventRecord(user._id, {}),
  }));

  let eventCount = 0;
  let championCount = 0;
  let topThreeCount = 0;
  let bestPlacement = 0;
  const groups = [];

  for (const { assoc, record } of loaded) {
    if (!record || !Array.isArray(record.records) || record.records.length === 0) continue;

    const records = record.records.map((row) => ({
      eventId: row.eventId,
      title: row.title,
      dateText: formatDate(row.startTime),
      placement: row.placement,
      placementText: formatPlacement(row.placement),
      isTop: row.placement <= 3,
      participantCount: row.participantCount,
    }));

    eventCount += record.summary.eventCount;
    championCount += record.summary.championCount;
    topThreeCount += record.summary.topThreeCount;
    const best = record.summary.bestPlacement;
    if (best > 0 && (bestPlacement === 0 || best < bestPlacement)) bestPlacement = best;

    groups.push({
      associationId: assoc.id,
      associationName: assoc.shortName,
      associationGlyph: assoc.logoGlyph,
      records,
    });
  }

  // 角色徽标只显示全局身份：协会角色（学院负责人 / 协会负责人）按协会各异，
  // 不属于这一页。全局角色只有会员与管理员两档（STAFF 是协会角色叠加出来的）。
  const globalRoleLabel =
    Number(user.role) === ROLE.ADMIN ? ROLE_LABEL[ROLE.ADMIN] : ROLE_LABEL[ROLE.MEMBER];

  return {
    found: true,
    user: {
      userId: user._id,
      nickName: nameDisplay.nickName,
      realName: nameDisplay.realName,
      showRealName: nameDisplay.showRealName,
      avatarText: (nameDisplay.nickName || '?').slice(0, 1),
      avatarUrl: user.avatarUrl || '',
      college: user.college || '',
      studentId: user.studentId || '',
      roleLabel: globalRoleLabel,
      statusLabel: USER_STATUS_LABEL[user.status] || '',
      joinDateText: formatDate(user.joinDate),
      points: user.points || 0,
      showPoints: false,
    },
    honors: {
      summary: {
        eventCount,
        championCount,
        topThreeCount,
        bestPlacementText: eventCount > 0 ? formatPlacement(bestPlacement) : '',
      },
      groups,
      total: eventCount,
    },
  };
}

/**
 * 学校维度的个人主页装载器（B4-c）。
 *
 * 取数走绑定范围的 S2 客户端（getSchoolMemberProfile：一次回放取齐卡片、
 * 项目、走势、交锋、搭档、逐场战绩、近期状态与本范围荣誉），整形与旧栈
 * loadMemberView 共用同一套纯函数（buildChart / buildHistoryRow / format*），
 * 页面与模板因此不需要改形状。
 *
 * 【任免 / 改分入口为什么在这里关掉】S2 下「指定权限」统一走学校身份页的
 * grantSchoolPermission（一个入口、权限不同），改分收尾属 B5；个人主页不再
 * 提供旧栈写入口，避免读 S2、写旧栈的混用。
 *
 * @param {Object} api 绑定学校 / 协会的协会空间客户端
 * @param {Object} [options]
 * @param {string} [options.userId] 想看谁；不传即本人
 * @param {string} [options.project] 初始选中的项目
 * @param {number} [options.historyLimit] 逐场战绩取多少条
 * @returns {Promise<Object>} 与 loadMemberView 同形状；查无此人时 { found: false }
 */
async function loadSchoolMemberView(api, options = {}) {
  const { project, historyLimit = DEFAULT_HISTORY_LIMIT } = options;
  const data = await api.getSchoolMemberProfile({
    userId: options.userId || '',
    historyLimit,
  });
  if (!data || !data.found) return { found: false };

  const projects = sortProjectsForDisplay(data.projects);
  const active = pickProject(projects, project);

  const eventRecords = (data.honors.records || []).map((row) => ({
    eventId: row.eventId,
    title: row.title,
    dateText: formatDate(row.startTime),
    placement: row.placement,
    placementText: formatPlacement(row.placement),
    isTop: row.placement <= 3,
    participantCount: row.participantCount,
  }));

  const nameDisplay = resolveNameDisplay(data.user);
  const honorSummary = data.honors.summary || {};

  return {
    found: true,
    user: {
      userId: data.user.userId,
      nickName: nameDisplay.nickName,
      realName: nameDisplay.realName,
      showRealName: nameDisplay.showRealName,
      avatarText: (nameDisplay.nickName || '?').slice(0, 1),
      avatarUrl: data.user.avatarUrl || '',
      college: data.user.college || '',
      studentId: data.user.studentId || '',
      roleLabel: data.user.permissionLabel || '',
      statusLabel: '正常',
      joinDateText: '',
      points: data.user.points || 0,
      showPoints: true,
    },
    projectTabs: projects.map((item) => ({
      project: item.project,
      label: item.label,
      elo: formatElo(item.elo),
      active: Boolean(active) && item.project === active.project,
    })),
    activeProject: active ? active.project : null,
    activeProjectLabel: active ? active.label : '',
    hasProject: Boolean(active),
    summary: active
      ? {
          elo: formatElo(active.elo),
          startElo: formatElo(active.startElo),
          delta: active.delta,
          deltaText: formatSigned(active.delta),
          deltaUp: active.delta >= 0,
          matchCount: active.matchCount,
          wins: active.wins,
          losses: active.losses,
          recordText: `${active.wins} 胜 ${active.losses} 负`,
          winRateText: formatPercent(active.wins / Math.max(active.matchCount, 1)),
          rank: active.rank,
          total: active.total,
          rankText: formatRank(active.rank, active.total),
          beatText: `超过 ${formatPercent(active.beatPercent / 100)} 的会员`,
        }
      : null,
    chart: buildChart(data.ratingHistory || [], active ? active.startElo : 0),
    form: {
      dots: (data.form.results || []).map((isWin) => (isWin ? 'W' : 'L')),
      wins: data.form.wins,
      losses: data.form.losses,
      streakText: data.form.streak > 0 ? `${data.form.streak} 连胜` : '暂无连胜',
    },
    events: {
      records: eventRecords,
      summary: {
        eventCount: honorSummary.eventCount || 0,
        championCount: honorSummary.championCount || 0,
        topThreeCount: honorSummary.topThreeCount || 0,
        bestPlacementText: formatPlacement(honorSummary.bestPlacement),
      },
    },
    headToHead: (data.headToHead || []).map((row) => ({
      opponentId: row.opponentId,
      nickName: row.nickName,
      matchCount: row.matchCount,
      recordText: `${row.wins} 胜 ${row.losses} 负`,
      winRateText: formatPercent(row.winRate),
      deltaText: formatSigned(row.eloDeltaSum),
      deltaUp: row.eloDeltaSum >= 0,
    })),
    partners: (data.partners || []).map((row) => ({
      partnerId: row.partnerId,
      nickName: row.nickName,
      matchCount: row.matchCount,
      recordText: `${row.wins} 胜 ${row.losses} 负`,
      winRateText: formatPercent(row.winRate),
    })),
    history: (data.history || []).map(buildHistoryRow),
    // S2 下任免 / 改分统一走学校身份页，个人主页不再提供旧栈写入口（B4 边界）
    leader: { visible: false },
    associationLeader: { visible: false },
    currentElo: { visible: false },
  };
}

/**
 * 学校维度的「我的」页装载器（B4-c）：头卡来自 S2 会话，荣誉跨该校协会聚合
 * （与旧栈 loadProfileSummary 同形状）。
 *
 * @param {Object} options
 * @param {string} options.schoolId 当前浏览学校
 * @param {Object} options.session getSchoolIdentitySession 的返回（本人会话）
 * @param {Object} [options.client] 协会空间门面（测试可注入替身）
 * @returns {Promise<Object>} 未登录时 { found: false }
 */
async function loadSchoolProfileSummaryView({ schoolId, session, client }) {
  if (!session || !session.user) return { found: false };
  const user = session.user;
  const space = client || require('./association-space.js');

  // 会员档案（学院全名）：第一个读得到的协会里取；都读不到时降级为空。
  let profile = null;
  for (const assoc of allAssociations()) {
    try {
      const result = await space.forScope({ schoolId, association: assoc.id }).getSchoolMember({ userId: user.userId });
      if (result && result.member) { profile = result.member; break; }
    } catch (err) { /* 下一个协会 */ }
  }

  const groups = [];
  let eventCount = 0;
  let championCount = 0;
  let topThreeCount = 0;
  let bestPlacement = null;

  await Promise.all(allAssociations().map(async (assoc) => {
    try {
      const api = space.forScope({ schoolId, association: assoc.id });
      const result = await api.getSchoolMemberHonors({ userId: user.userId });
      if (!result || !result.ok || !result.honors) return;
      const records = (result.honors.records || []).map((row) => ({
        eventId: row.eventId,
        title: row.title,
        dateText: formatDate(row.startTime),
        placement: row.placement,
        placementText: formatPlacement(row.placement),
        isTop: row.placement <= 3,
        participantCount: row.participantCount,
      }));
      if (records.length === 0) return;
      const summary = result.honors.summary || {};
      eventCount += summary.eventCount || 0;
      championCount += summary.championCount || 0;
      topThreeCount += summary.topThreeCount || 0;
      if (summary.bestPlacement != null &&
          (bestPlacement === null || summary.bestPlacement < bestPlacement)) {
        bestPlacement = summary.bestPlacement;
      }
      groups.push({
        associationId: assoc.id,
        associationName: assoc.shortName,
        associationGlyph: assoc.logoGlyph,
        records,
      });
    } catch (err) {
      // 该协会读不到（未启用 / 无权限）：跳过，不拖垮整页
    }
  }));

  const nameDisplay = resolveNameDisplay(user);
  const account = session.account || {};
  const statusLabel = ({ pending: '待审核', active: '正常', rejected: '已驳回', left: '已离校', disabled: '已停用' })[account.status] || '未入会';

  return {
    found: true,
    user: {
      userId: user.userId,
      nickName: nameDisplay.nickName,
      realName: nameDisplay.realName,
      showRealName: nameDisplay.showRealName,
      avatarText: (nameDisplay.nickName || '?').slice(0, 1),
      avatarUrl: user.avatarUrl || '',
      college: (profile && profile.collegeName) || '',
      studentId: (account && account.studentId) || '',
      roleLabel: session.isPlatformAdmin ? '管理员' : (session.permissionLabel || '会员'),
      statusLabel,
      joinDateText: '',
      points: 0,
      showPoints: false,
    },
    honors: {
      summary: {
        eventCount,
        championCount,
        topThreeCount,
        bestPlacementText: formatPlacement(bestPlacement),
      },
      groups,
      total: eventCount,
    },
  };
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  FORM_LIMIT,
  pickProject,
  buildChart,
  buildHistoryRow,
  loadMemberView,
  loadSchoolMemberView,
  loadProfileSummary,
  loadSchoolProfileSummaryView,
};
