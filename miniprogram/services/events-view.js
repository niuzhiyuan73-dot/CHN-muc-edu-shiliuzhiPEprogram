/**
 * 赛事页的视图模型
 * ============================================================
 * 和 rank-view.js 同样的思路：取数、整形、算文案都在这里，页面只管渲染。
 * 本模块不碰任何 wx API，可以在 Node 里测。
 *
 * 【这一页为什么有两块】
 * 「赛事」tab 是赛事这条线的主界面，要回答两个问题：
 *   1. 近期有哪些赛事、我报了哪一场？—— 赛事闭环的入口；
 *   2. 本赛季谁积分最高？—— 赛季积分榜（决策 14）。
 * 一面是「接下来做什么」，一面是「过去投入了多少」，同属赛事这条线，
 * 用两张卡片分开，互不干扰。
 *
 * 【为什么积分榜只统计本赛季】
 * 积分每赛季清零（2.6）。榜单要跟「这个赛季谁最活跃」对得上，就不能
 * 把上个赛季的分带进来。赛季分界由 replay 引擎在回放时处理，这里拿到的
 * `points` 已经是本赛季口径，直接排即可。
 *
 * 【为什么积分榜没有双打】
 * 决策 3：双打比赛与双打赛事都不计分。分池里根本不会出现双打带来的分，
 * 所以这里不需要专门过滤——但要靠事件计数过滤双打赛事，见 countEvents。
 *
 * 【赛事列表为什么按状态排序】
 * 用户打开这一页首先要知道「现在能报哪一场」。若按开赛时间倒序，已结束
 * 的历史赛事会把还能报名的场次压到屏幕外，所以先按状态分档，见 sortEvents。
 * ============================================================
 */

const {
  MATCH_TYPE,
  EVENT_STATUS,
  EVENT_BRONZE_MODE,
  DEFAULT_BRONZE_MODE,
  BRACKET_STAGE,
  ROLE,
  SIGNUP_STATUS,
  isRankable,
} = require('../utils/constants.js');
const { buildLeaderboard } = require('../utils/leaderboard.js');
const { formatDate, formatDateTime, formatPercent, formatScore } = require('../utils/format.js');
const {
  canManageEvent,
  canCheckIn,
  canFinishEvent,
  buildEventRow,
  buildSignupRow,
  signupStateOf,
} = require('./event.js');
const { canConfirm, isParticipant, needsScore } = require('./match-record.js');
const { statusTagOf } = require('./match-view.js');
// 手工指定种子要凑几位，与真正抽签时同一把尺子（种子数与参赛人数的较小者），
// 免得界面点名点到一个算法并不接受的数量
const { actualSeedCount } = require('./draw.js');
const {
  getCurrentUser,
  getMembers,
  getEvents,
  getEventSignups,
  getMatchRecords,
  getSeasonState,
} = require('./index.js');

/** 前三名的奖牌样式，其余为空字符串（不额外装饰） */
const MEDALS = ['gold', 'silver', 'bronze'];

/** 名次 → 奖牌样式。只有前三名有奖牌，第四名与八强不装饰 */
const PLACEMENT_MEDALS = { 1: 'gold', 2: 'silver', 3: 'bronze' };

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

/** 把任意输入收敛成数组，兼容 undefined / 单个对象 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 时间字段转毫秒。非法值一律当 0 沉底，绝不产生 NaN 比较 */
function timeValue(value) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
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

/* ============================================================
 * 赛季积分榜
 * ============================================================ */

/**
 * 积分榜默认展示多少名。
 *
 * 与排行榜页的等级分榜写死同一个口径：前十足够回答「谁投入最多」。
 * 但同样地，**「我在积分榜的排名」卡不能被截断**，搜索也要能查全量，
 * 所以名次始终在完整榜上算，前 10 只是显示层的截断。
 */
const TOP_LIMIT = 10;

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
    // 离校的人不上榜（决策 8），与等级分榜同一道闸门
    .filter((user) => isRankable(user) && (user.points || 0) > 0)
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

/* ============================================================
 * 赛事列表与详情（赛事闭环）
 * ============================================================ */

/**
 * 赛事列表的排序：报名中 → 进行中 → 已结束，同状态内先比最近的。
 *
 * @param {Array<Object>} events
 * @returns {Array<Object>} 新数组，不改动入参
 */
function sortEvents(events) {
  const priorityOf = (event) => {
    const status = event && event.status;
    if (status === EVENT_STATUS.SIGNUP) return 0;
    if (status === EVENT_STATUS.ONGOING) return 1;
    return 2;
  };

  return asArray(events)
    .slice()
    .sort((a, b) => {
      const diff = priorityOf(a) - priorityOf(b);
      if (diff !== 0) return diff;
      return timeValue(b && b.startTime) - timeValue(a && a.startTime);
    });
}

/** 名次对应的档位文案（冠军 / 亚军 / 季军 / 第四名 / 八强 / 第 N 名） */
function placementLabelOf(placement) {
  const rank = Number(placement);
  if (rank === 1) return '冠军';
  if (rank === 2) return '亚军';
  if (rank === 3) return '季军';
  if (rank === 4) return '第四名';
  if (rank >= 5 && rank <= 8) return '八强';
  return Number.isFinite(rank) ? `第 ${rank} 名` : '';
}

/** 三四名赛口径的说明文案，录入名次时要照着填 */
function bronzeHintOf(event) {
  const mode = (event && event.bronzeMode) || DEFAULT_BRONZE_MODE;
  if (mode === EVENT_BRONZE_MODE.PLAYOFF) {
    return '本场为「打三四名」：第 3 名与第 4 名各一位，成对出现';
  }
  return '本场为「并列季军」：两位半决赛负者都填第 3 名，不要出现第 4 名';
}

/**
 * 把赛事列表整形成页面上的行。
 *
 * @param {Array<Object>} events
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @param {Map<string, Array<Object>>} [ctx.signupMap] 赛事编号 → 报名记录
 * @returns {Array<Object>}
 */
function buildEventListRows(events, ctx = {}) {
  const { actor = null, signupMap = new Map() } = ctx;
  return sortEvents(events).map((event) => {
    const signups = signupMap.get(event._id) || [];
    return buildEventRow(event, { actor, signups });
  });
}

/**
 * 一次取齐所有赛事的报名记录，按赛事编号建索引。
 * 列表要显示「已报几人」「我报没报」，每场各取一次，并发发出。
 *
 * @param {Array<Object>} events
 * @returns {Promise<Map<string, Array<Object>>>}
 */
async function loadSignupMap(events) {
  const list = asArray(events);
  const pairs = await Promise.all(
    list.map(async (event) => [event._id, await getEventSignups(event._id)])
  );
  return new Map(pairs);
}

/**
 * 把报名记录整形成名单行（用于签到与名次录入）。
 * 已取消的不列入——名单是给要来的人看的，退赛的人不该还在上面。
 *
 * @param {Array<Object>} signups
 * @param {Map<string, Object>} memberMap 会员编号 → 档案
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor]
 * @param {Object|null} [ctx.event] 所属赛事，用于判代签权
 * @returns {Array<Object>}
 */
function buildSignupRows(signups, memberMap, ctx = {}) {
  const { actor = null, event = null } = ctx;
  const mayCheckIn = canCheckIn(event, actor);

  return asArray(signups)
    .filter((signup) => signup && signup.status !== SIGNUP_STATUS.CANCELED)
    .slice()
    .sort((a, b) => timeValue(a.signTime) - timeValue(b.signTime))
    .map((signup) => {
      const member = (memberMap && memberMap.get(signup.userId)) || {};
      const state = signupStateOf(signup);
      const row = buildSignupRow(signup, member, { actor });
      return {
        ...row,
        avatarText: avatarOf(row.nickName),
        // 代签按钮只在「进行中 + 已报名未签到」时出现
        canCheckIn: mayCheckIn && state.signed && !state.checkedIn,
      };
    });
}

/**
 * 把已录入的名次整形成成绩行，按名次从高到低（数字从小到大）排。
 *
 * @param {Object} event
 * @param {Map<string, Object>} memberMap
 * @param {Object|null} [actor]
 * @returns {Array<Object>}
 */
function buildResultRows(event, memberMap, actor = null) {
  return asArray(event && event.results)
    .slice()
    .sort((a, b) => Number(a.placement) - Number(b.placement))
    .map((result) => {
      const member = (memberMap && memberMap.get(result.userId)) || {};
      const nickName = member.nickName || result.userId;
      return {
        userId: result.userId,
        nickName,
        avatarUrl: member.avatarUrl || '',
        avatarText: avatarOf(nickName),
        placement: result.placement,
        placementText: placementLabelOf(result.placement),
        medal: PLACEMENT_MEDALS[Number(result.placement)] || '',
        isMe: Boolean(actor && actor._id === result.userId),
      };
    });
}

/* ============================================================
 * 签表（抽签结果）
 * ============================================================ */

/** 阶段排序：正赛在前，季军赛在后 */
function stageOrder(stage) {
  return stage === BRACKET_STAGE.BRONZE ? 1 : 0;
}

/**
 * 一轮叫什么。
 *
 * 从最后一轮倒着数才不会因为签表大小不同而叫错：8 人签的最后一轮是
 * 决赛、倒数第二轮是半决赛、再往前是四分之一决赛。若从第一轮正着数，
 * 4 人签和 8 人签的第一轮都叫「第 1 轮」，看不出哪轮是半决赛。
 *
 * @param {number} round 轮次
 * @param {number} totalRounds 总轮数（由签表大小推得）
 * @param {string} [stage] 见 constants.BRACKET_STAGE
 * @returns {string}
 */
function roundLabelOf(round, totalRounds, stage) {
  if (stage === BRACKET_STAGE.BRONZE) return '季军赛';
  const fromEnd = Number(totalRounds) - Number(round);
  if (fromEnd <= 0) return '决赛';
  if (fromEnd === 1) return '半决赛';
  if (fromEnd === 2) return '四分之一决赛';
  return `第 ${round} 轮`;
}

/** 签表大小的总轮数：2 的几次幂就是几轮。非法值返回 0 */
function totalRoundsOf(draw) {
  const size = draw && Number(draw.size);
  if (!Number.isFinite(size) || size < 2) return 0;
  return Math.round(Math.log2(size));
}

/**
 * 一句话说清这次抽签：第几次、几个签位、几位种子。
 * @param {Object} draw 赛事的 draw 字段
 * @returns {string}
 */
function describeDraw(draw) {
  if (!draw) return '';
  const round = Number(draw.drawCount) || 1;
  const size = Number(draw.size) || 0;
  const seeds = asArray(draw.seeds).length;
  const parts = [`第 ${round} 次抽签`, `${size} 个签位`];
  if (seeds) parts.push(`${seeds} 位种子`);
  return parts.join(' · ');
}

/**
 * 轮空名单的文案。轮空的人不动手就进下一轮，但必须让人看得见，
 * 否则名单上少了两个人会以为抽签漏了。
 *
 * @param {Object} draw
 * @param {Map<string, Object>} memberMap
 * @returns {string}
 */
function byeTextOf(draw, memberMap) {
  const byes = asArray(draw && draw.byes);
  if (byes.length === 0) return '';
  const names = byes.map((id) => (memberMap.get(id) || {}).nickName || id);
  return `轮空直接晋级：${names.join('、')}`;
}

/**
 * 把该赛事的比赛整形成签表行，按轮次 → 阶段 → 签位排。
 *
 * @param {Array<Object>} records getMatchRecords 的结果
 * @param {Object} event 赛事记录（要它的 draw 与编号）
 * @param {Map<string, Object>} memberMap 会员编号 → 档案
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前登录会员
 * @param {boolean} [ctx.isMock=false] 是否放宽「确认」权（与 match-record 同一口径）
 * @returns {Array<Object>}
 */
function buildBracketRows(records, event, memberMap, ctx = {}) {
  const { actor = null, isMock: mock = false } = ctx;
  const eventId = event && event._id;
  const totalRounds = totalRoundsOf(event && event.draw);
  const nameOf = (id) => (id ? (memberMap.get(id) || {}).nickName || id : '待定');

  // 录分的权限要和真正写入时一致：只认参赛者本人，或管理员代录
  // （见 mock.submitMatch 与云端 submitScheduledMatch）。这里不按数据源
  // 放宽——否则普通会员会在签表上看到一列不属于自己的「录分」入口。
  const mayManage = Boolean(actor && actor.role === ROLE.ADMIN);
  const actorId = actor ? actor._id : null;

  return asArray(records)
    .filter((record) => record && record.eventId === eventId)
    .slice()
    .sort(
      (a, b) =>
        timeValue(a.round) - timeValue(b.round) ||
        stageOrder(a.stage) - stageOrder(b.stage) ||
        Number(a.slot) - Number(b.slot)
    )
    .map((record) => {
      const tag = statusTagOf(record.status, record.action);
      // 还没比分的场次不渲染比分占位符——那会和「0:0」混在一起
      const hasScore = asArray(record.scoreA).length > 0;
      const waiting = needsScore(record);
      return {
        matchId: record._id,
        roundText: roundLabelOf(record.round, totalRounds, record.stage),
        teamAText: nameOf(record.teamA && record.teamA[0]),
        teamBText: nameOf(record.teamB && record.teamB[0]),
        timeText: record.matchTime ? formatDateTime(record.matchTime) : '',
        scoreText: hasScore ? formatScore(record.scoreA, record.scoreB) : '',
        winnerSide: record.winner || '',
        statusLabel: tag.label,
        statusClass: tag.className,
        isMine: Boolean(actorId && (isParticipant(record, actorId))),
        // 还没比分的场次先录分，录完才谈得上确认
        canRecord: Boolean(waiting && actorId && (isParticipant(record, actorId) || mayManage)),
        canConfirm: Boolean(
          !waiting && canConfirm(record, actorId, { isMock: mock })
        ),
      };
    });
}


/**
 * 装载赛事页的全部数据（赛事列表 + 赛季积分榜）。
 *
 * 【登录态为什么由页面传进来】
 * mock 的 getCurrentUser() 永远答 u06。若这里自己去问，一个没登录的访客
 * 也会被当成 u06，凭空拿到报名与管理权限。页面把登录态显式传下来，
 * 传 null 就是访客；不传时退回数据源的当前用户（供 Node 测试直接调用）。
 *
 * @param {Object} [options]
 * @param {Object|null} [options.user] 当前登录会员
 * @returns {Promise<Object>}
 */
async function loadEventsView(options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members, events, season] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
    getSeasonState(),
  ]);

  const actor = usesExplicitUser ? options.user : current;
  const myId = actor ? actor._id : null;

  // 名次先在完整榜上算好，再截断显示——顺序不能反，否则前十之外的人
  // 拿不到自己的名次
  const allRows = buildPointsRows(members, countEvents(events), myId);
  const rows = allRows.slice(0, TOP_LIMIT);
  const total = allRows.length;
  const myRow = (myId && allRows.find((row) => row.isMe)) || null;

  const signupMap = await loadSignupMap(events);
  const eventRows = buildEventListRows(events, { actor, signupMap });
  const canPublish = canManageEvent(actor);

  return {
    seasonText: describeSeason(season),
    rows,
    // 完整榜不参与默认渲染，但页面的搜索框要在全量里找人
    allRows,
    total,
    hasMore: total > rows.length,
    // 前十之外还有人就如实交代总数，不能只报 10
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    empty: rows.length === 0,
    emptyNote: '本赛季还没有人拿到积分，参加一次赛事就能上榜',
    me:
      myRow === null
        ? null
        : {
            rank: myRow.rank,
            // 分母用完整榜人数：即使我排在第 15、列表里看不到我，
            // 也该知道自己是第 15 / 20，而不是第 15 / 10
            total,
            beatText: `超过 ${formatPercent((total - myRow.rank) / total)} 的会员`,
          },
    meHint: myRow === null ? '本赛季还没有积分，参加一次赛事就能上榜' : '',

    // 赛事闭环入口：列表 + 发布权
    events: eventRows,
    hasEvents: eventRows.length > 0,
    eventsEmptyNote: '还没有赛事，等管理员发布一场吧',
    canPublish,
  };
}

/**
 * 装载一场赛事的详情。
 *
 * @param {string} eventId
 * @param {Object} [options]
 * @param {Object|null} [options.user]
 * @param {boolean} [options.isMock=false] 是否放宽签表上的「确认」权
 * @returns {Promise<Object>}
 */
async function loadEventDetailView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');
  const { isMock: mock = false } = options;

  const [current, members, events] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
  ]);
  const actor = usesExplicitUser ? options.user : current;

  const event = asArray(events).find((item) => item._id === eventId) || null;
  if (!event) {
    return {
      found: false,
      notFoundText: '这场赛事不存在或已被删除',
      event: null,
      signupRows: [],
      hasSignups: false,
      signupsEmptyNote: '',
      bracketRows: [],
      hasBracket: false,
      drawText: '',
      byeText: '',
      seedCandidates: [],
      manualSeedNeeded: 0,
      resultRows: [],
      hasResults: false,
    };
  }

  // 抽签排出的比赛状态是「待确认」，getMatches 只给已生效的，签表会空，
  // 所以这里必须走台账（getMatchRecords），与「比赛」页同一条口径
  const [signups, ledger] = await Promise.all([
    getEventSignups(eventId),
    getMatchRecords({ eventId }),
  ]);
  const row = buildEventRow(event, { actor, signups });
  const memberMap = new Map(asArray(members).map((member) => [member._id, member]));

  const signupRows = buildSignupRows(signups, memberMap, { actor, event });
  const bracketRows = buildBracketRows(ledger, event, memberMap, { actor, isMock: mock });
  const resultRows = buildResultRows(event, memberMap, actor);

  // 手工指定种子的候选名单就是有效报名者；顺序由管理员在页面上点出来，
  // 这里给的先后不重要——抽签的随机性只该来自 seedValue（见 draw.js）
  const seedCandidates = signupRows.map((signup) => ({
    userId: signup.userId,
    nickName: signup.nickName,
    avatarText: signup.avatarText,
    avatarUrl: signup.avatarUrl || '',
  }));

  return {
    found: true,
    notFoundText: '',
    event: row,
    signupRows,
    hasSignups: signupRows.length > 0,
    signupsEmptyNote: '还没有人报名',
    bracketRows,
    hasBracket: bracketRows.length > 0,
    drawText: describeDraw(event.draw),
    byeText: byeTextOf(event.draw, memberMap),
    // 手工指定种子要凑几位：参赛人数不够种子数时，人人都是种子
    seedCandidates,
    manualSeedNeeded: actualSeedCount(row.seedCount, seedCandidates.length),
    resultRows,
    hasResults: resultRows.length > 0,
  };
}

/**
 * 装载名次录入页。
 *
 * 【为什么失败关闭】
 * 名次直接换成积分，一个错字就凭空多出一位参赛者。没有管理权时一条名单
 * 都不下发，界面上就不可能冒出一个能点的录入框。与 season-view 同一套路数。
 *
 * @param {string} eventId
 * @param {Object} [options]
 * @param {Object|null} [options.user]
 * @returns {Promise<Object>}
 */
async function loadEventPlacementView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members, events] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
  ]);
  const actor = usesExplicitUser ? options.user : current;

  const allowed = canManageEvent(actor);

  // 闸门：没有管理权就到此为止，一个字段都不下发
  if (!allowed) {
    return {
      allowed: false,
      blockedText: actor ? '当前账号没有录入名次的权限，请联系管理员' : '请先登录后再录入名次',
      found: true,
      canEdit: false,
      statusNote: '',
      event: null,
      rows: [],
      hasRows: false,
      emptyNote: '',
      bronzeHint: '',
    };
  }

  const event = asArray(events).find((item) => item._id === eventId) || null;
  if (!event) {
    return {
      allowed: true,
      blockedText: '',
      found: false,
      canEdit: false,
      statusNote: '',
      event: null,
      rows: [],
      hasRows: false,
      emptyNote: '',
      bronzeHint: '',
    };
  }

  const signups = await getEventSignups(eventId);
  const row = buildEventRow(event, { actor, signups });
  const memberMap = new Map(asArray(members).map((member) => [member._id, member]));
  const rows = buildSignupRows(signups, memberMap, { actor, event });
  const canEdit = canFinishEvent(event, actor);

  let statusNote = '';
  if (!canEdit) {
    statusNote = row.isFinished
      ? '这场赛事已经结束，名次不可再改'
      : '赛事开始后才能录入名次，请先在详情页把赛事设为「进行中」';
  }

  return {
    allowed: true,
    blockedText: '',
    found: true,
    canEdit,
    statusNote,
    event: row,
    rows,
    hasRows: rows.length > 0,
    emptyNote: '还没有人报名，录入名次前先让会员报名',
    bronzeHint: bronzeHintOf(event),
  };
}

module.exports = {
  MEDALS,
  PLACEMENT_MEDALS,
  TOP_LIMIT,
  medalOf,
  avatarOf,
  asArray,
  timeValue,
  countEvents,
  describeSeason,
  buildPointsRows,
  sortEvents,
  placementLabelOf,
  bronzeHintOf,
  buildEventListRows,
  loadSignupMap,
  buildSignupRows,
  buildResultRows,
  stageOrder,
  roundLabelOf,
  totalRoundsOf,
  describeDraw,
  byeTextOf,
  buildBracketRows,
  loadEventsView,
  loadEventDetailView,
  loadEventPlacementView,
};
