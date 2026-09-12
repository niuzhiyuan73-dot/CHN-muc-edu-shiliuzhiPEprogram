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
  EVENT_FORMAT,
  DEFAULT_EVENT_FORMAT,
  GROUPED_FORMATS,
  RATING_POOL,
  ROLE,
  SIGNUP_STATUS,
  COLLEGE_EVENT_STATUS,
  isRankable,
} = require('../utils/constants.js');
const { computeStandings } = require('../utils/standings.js');
const { derivePlacements, hasDoubleKnockout } = require('./format-plan.js');
const { getPoolRating } = require('../utils/rating.js');
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
const { canConfirm, canRecordScore, isParticipant, needsScore } = require('./match-record.js');
// 学院赛的发布入口与名单入口也摆在赛事页：两套体系虽互不干扰，入口却该在一处
const { canManageCollegeEvent, buildCollegeEventRow } = require('./college-event.js');
const { canSubmitCollegeEntry, canReviewCollegeEntry } = require('./college-entry.js');
const { statusTagOf } = require('./match-view.js');
// 手工指定种子要凑几位，与真正抽签时同一把尺子（种子数与参赛人数的较小者）；
// 双打每两位参赛者编成一队，人数是组数的两倍，见 manualPlayersNeeded
const { actualSeedCount, manualPlayersNeeded, splitTeamId } = require('./draw.js');
const {
  getCurrentUser,
  getMembers,
  getEvents,
  getEventSignups,
  getMatchRecords,
  getSeasonState,
  getCollegeEvents,
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

/** 赛事赛制。老赛事没有这个字段，按单败淘汰处理（与 event.js 同一口径） */
function formatOf(event) {
  return (event && event.format) || DEFAULT_EVENT_FORMAT;
}

/** 是否循环 / 小组这类「先打小组、名次由战绩算」的赛制 */
function isGroupedFormat(event) {
  return GROUPED_FORMATS.includes(formatOf(event));
}

/** 主淘汰阶段是不是双败（要分区显示胜者组 / 败者组 / 总决赛） */
function isDoubleElimFormat(event) {
  return hasDoubleKnockout(formatOf(event));
}

/**
 * 名次能不能由赛制自动推出来。
 *
 * 循环 / 小组按积分表排，双败按淘汰轮次排，两类都能预填；单败淘汰要
 * 管理员手工录。这个判断在名次页有几处用途，统一在这里说一次。
 */
function hasAutoPlacements(event) {
  return isGroupedFormat(event) || isDoubleElimFormat(event);
}

/**
 * 组号 → 组名。
 *
 * 组号自 0 起（见 draw.planGroupDraw），所以 0 号要叫「A 组」而不是
 * 「小组」——若按 1 起处理，第一组会没有名字，后面的组又整体错位一格。
 * 循环赛只有一组，直接叫「循环赛」，免得出现孤零零的 A 组。
 *
 * @param {number} group
 * @param {string} format
 * @returns {string}
 */
function groupLabelOf(group, format) {
  if (format === EVENT_FORMAT.ROUND_ROBIN) return '循环赛';
  const index = Number(group);
  if (!Number.isFinite(index) || index < 0) return '小组';
  return `${String.fromCharCode(65 + index)} 组`;
}

/** 组号是否有效。0 号也是有效小组，不能用真值判断把它漏掉 */
function hasGroup(group) {
  return group !== undefined && group !== null && group !== '';
}

/** 净胜分带正负号，让 +3 / -2 一眼可辨；0 不带号 */
function signedText(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
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

/**
 * 三四名赛口径的说明文案，录入名次时要照着填。
 * 双打一个名次对应一整支队伍（两人），量词与人数都要跟着换。
 */
function bronzeHintOf(event) {
  const mode = (event && event.bronzeMode) || DEFAULT_BRONZE_MODE;
  const doubles = Boolean(event && event.matchType === MATCH_TYPE.DOUBLES);
  const unit = doubles ? '一组（2 人）' : '一位';
  const pairWord = doubles ? '两组' : '两位';
  if (mode === EVENT_BRONZE_MODE.PLAYOFF) {
    return `本场为「打三四名」：第 3 名与第 4 名各${unit}，成对出现`;
  }
  return `本场为「并列季军」：${pairWord}半决赛负者都填第 3 名，不要出现第 4 名`;
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
 * 学院赛列表排序：报名中 → 待开赛 → 进行中 → 已结束。
 *
 * 【为什么不复用 sortEvents】
 * 学院赛在「报名中」与「进行中」之间多一个「待开赛」，状态号与个人赛
 * 并不对齐。硬套个人赛的状态号会把「待开赛」当成「进行中」，又把真正的
 * 「进行中」沉到已结束那一档，两场都排错。这里按学院赛自己的状态排。
 *
 * @param {Array<Object>} events
 * @returns {Array<Object>} 新数组，不改动入参
 */
function sortCollegeEvents(events) {
  const priorityOf = (event) => {
    const status = event && event.status;
    if (status === COLLEGE_EVENT_STATUS.SIGNUP) return 0;
    if (status === COLLEGE_EVENT_STATUS.READY) return 1;
    if (status === COLLEGE_EVENT_STATUS.ONGOING) return 2;
    return 3;
  };

  return asArray(events)
    .slice()
    .sort((a, b) => {
      const diff = priorityOf(a) - priorityOf(b);
      if (diff !== 0) return diff;
      return timeValue(a && a.startTime) - timeValue(b && b.startTime);
    });
}

/**
 * 把学院赛列表整形成页面上的行。
 *
 * 【一行的入口为什么按人分】
 * 学院赛的报名不是个人点「报名」，而是学院负责人交名单。所以同一行对
 * 不同的人指向不同页面：管理员进详情页（抽签、开赛、大场都在那里，审核
 * 名单在详情页里有入口），干事在报名中直接进本学院的名单页（少走一步），
 * 其余人进详情页看签表与对阵。入口布尔量与文案在这里算好，模板不写
 * 业务判断。
 *
 * @param {Array<Object>} events
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的人
 * @returns {Array<Object>}
 */
function buildCollegeEventListRows(events, ctx = {}) {
  const { actor = null } = ctx;
  // 审核权与具体哪一场无关，算一次即可
  const canReview = canReviewCollegeEntry(actor);

  return sortCollegeEvents(events).map((event) => {
    const row = buildCollegeEventRow(event, { actor });
    // 干事在报名中直接去名单页；管理员与其余人都进详情页，这里只影响文案
    const canSubmit = !canReview && canSubmitCollegeEntry(event, actor);
    return {
      ...row,
      canReview,
      canSubmit,
      actionText: canReview ? '管理' : canSubmit ? '提交名单' : '查看',
      // 报名中用成功色、进行中用警示色，待开赛与已结束用灰色
      statusClass: row.isSignup ? 'tag-success' : row.isOngoing ? 'tag-warning' : 'tag-gray',
    };
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
  // 名单上带的是「这场比赛所属池」的等级分：单打赛事看单打分，双打赛事
  // 看双打分。用错池会给出一个和本场毫不相干的数字。
  const pool = (event && event.pool) || RATING_POOL.SINGLES;

  return asArray(signups)
    .filter((signup) => signup && signup.status !== SIGNUP_STATUS.CANCELED)
    .slice()
    .sort((a, b) => timeValue(a.signTime) - timeValue(b.signTime))
    .map((signup) => {
      const member = (memberMap && memberMap.get(signup.userId)) || null;
      const state = signupStateOf(signup);
      const row = buildSignupRow(signup, member || {}, { actor });
      // 档案查不到时不硬凑一个默认分——那会让「查无此人」看起来像 1450 分
      const stats = member
        ? `等级分 ${getPoolRating(member, pool).elo} · 积分 ${Number(member.points) || 0}`
        : '';
      // 干事只能代签本学院的人；档案查不到时传个空对象，让干事被挡下、
      // 管理员仍可通过（见 event.canCheckIn 的三种取值）
      const mayCheckInThis = mayCheckIn && canCheckIn(event, actor, { target: member || {} });
      return {
        ...row,
        avatarText: avatarOf(row.nickName),
        // 代签按钮只在「进行中 + 已报名未签到」时出现
        canCheckIn: mayCheckInThis && state.signed && !state.checkedIn,
        statText: stats,
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

/**
 * 阶段排序：小组赛在前，正赛次之，季军赛 / 败者组再次之，排位赛与总决赛最后。
 * main 与 bronze 的相对先后与此前一致（正赛在前、季军赛在后），只是整体
 * 让位给新增的 group 阶段。
 */
function stageOrder(stage) {
  if (stage === BRACKET_STAGE.GROUP) return 0;
  if (stage === BRACKET_STAGE.WINNERS) return 1;
  if (stage === BRACKET_STAGE.LOSERS) return 2;
  if (stage === BRACKET_STAGE.BRONZE) return 2;
  if (stage === BRACKET_STAGE.PLACEMENT) return 3;
  if (stage === BRACKET_STAGE.GRAND_FINAL) return 3;
  return 1; // 正赛 / 未标注阶段
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
  if (stage === BRACKET_STAGE.GRAND_FINAL) return '总决赛';
  if (stage === BRACKET_STAGE.PLACEMENT) return '5–8 名排位赛';
  const value = Number(round);
  // 胜者组 / 败者组各自从第 1 轮数起，两边的「第 1 轮」是两轮不同的比赛，
  // 必须带区名，否则签表上会出现两个一模一样的「第 1 轮」
  if (stage === BRACKET_STAGE.WINNERS || stage === BRACKET_STAGE.LOSERS) {
    const zone = stage === BRACKET_STAGE.WINNERS ? '胜者组' : '败者组';
    if (!Number.isFinite(value) || value < 1) return `${zone} · 轮次待定`;
    return `${zone} · 第 ${value} 轮`;
  }
  // 循环 / 小组的「第几轮」没有「离决赛还有几轮」的含义，只看数字叫；
  // 正赛仍按原口径从最后一轮倒着数
  if (stage === BRACKET_STAGE.GROUP) {
    if (!Number.isFinite(value) || value < 1) return '轮次待定';
    return `第 ${value} 轮`;
  }
  // 轮次从 1 起。缺失或不是正整数时不能落进模板字符串——那正是
  // 「第 undefined 轮」的来源；null / '' 会被 Number 转成 0，也要一并挡住
  if (!Number.isFinite(value) || value < 1) return '轮次待定';
  const total = Number(totalRounds);
  // 算不出总轮数（没有 draw）时只能老实报第几轮，不假装知道倒数第几
  if (!Number.isFinite(total) || total < 1) return `第 ${value} 轮`;
  const fromEnd = total - value;
  if (fromEnd <= 0) return '决赛';
  if (fromEnd === 1) return '半决赛';
  if (fromEnd === 2) return '四分之一决赛';
  return `第 ${value} 轮`;
}

/** 签表大小的总轮数：2 的几次幂就是几轮。非法值返回 0 */
function totalRoundsOf(draw) {
  const size = draw && Number(draw.size);
  if (!Number.isFinite(size) || size < 2) return 0;
  return Math.round(Math.log2(size));
}

/**
 * 从比赛记录反推总轮数，作为没有 draw 时的兜底。
 *
 * 【为什么需要兜底】
 * 种子里的历史赛事是直接模拟出来的，没有走抽签，因此没有 draw 字段。
 * 只知道「最大轮次是 3」，就能按「8 人签共 3 轮」把每轮叫对名字——
 * 否则这些赛事的轮次会一路退化成「第 N 轮」甚至 undefined。
 * 只适用于「各轮都已排完」的赛事；进行中的赛事有 draw，走不到这里。
 *
 * @param {Array<Object>} records 该赛事的比赛记录
 * @returns {number} 最大轮次；没有可用轮次时返回 0
 */
function maxRoundOf(records) {
  let max = 0;
  for (const record of asArray(records)) {
    const value = Number(record && record.round);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
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
 * 一方的显示名：把该方成员的名字用顿号连起来。
 *
 * 单打一方只有一人，得到的就是昵称；双打一方两人，会显示「甲、乙」。
 * 查不到档案时退回编号——宁可露出一个编号，也不能显示空白。
 *
 * @param {Array<string>} members 该方成员编号（单打一人、双打两人）
 * @param {Map<string, Object>} memberMap
 * @returns {string}
 */
function teamTextOf(members, memberMap) {
  const ids = asArray(members).filter(Boolean);
  if (ids.length === 0) return '待定';
  return ids.map((id) => (memberMap.get(id) || {}).nickName || id).join('、');
}

/**
 * 一个签位编号的显示名。签位编号单打是人、双打是两人拼成的队号
 * （见 draw.teamIdOf），拆开后再交给 teamTextOf。
 *
 * @param {string} id
 * @param {Map<string, Object>} memberMap
 * @returns {string}
 */
function entryTextOf(id, memberMap) {
  return teamTextOf(splitTeamId(id), memberMap);
}

/**
 * 轮空名单的文案。轮空的人不动手就进下一轮，但必须让人看得见，
 * 否则名单上少了两个人会以为抽签漏了。双打轮空的是整支队伍，两人一起显示。
 *
 * @param {Object} draw
 * @param {Map<string, Object>} memberMap
 * @returns {string}
 */
function byeTextOf(draw, memberMap) {
  const byes = asArray(draw && draw.byes);
  if (byes.length === 0) return '';
  const names = byes.map((id) => entryTextOf(id, memberMap));
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
  const eventRecords = asArray(records).filter((record) => record && record.eventId === eventId);
  const grouped = isGroupedFormat(event);
  const doubleElim = isDoubleElimFormat(event);
  const format = formatOf(event);
  // 有 draw 就以签表大小为准；种子里的老赛事没有 draw，退而按最大轮次反推。
  // 小组 / 循环赛的 draw 没有签表大小，淘汰阶段的轮次得从主签表的比赛反推
  const totalRounds = grouped
    ? maxRoundOf(eventRecords.filter((record) => record && record.stage !== BRACKET_STAGE.GROUP))
    : totalRoundsOf(event && event.draw) || maxRoundOf(eventRecords);
  // 多阶段赛制（分组、双败）要按「阶段优先」排：否则双败的总决赛轮次是 1，
  // 会排到第 2 轮的胜者组之前；小组赛的各组也会和淘汰赛同轮号交错
  const stageFirst = grouped || doubleElim;

  // 录分的权限要和真正写入时一致：参赛者本人、管理员，或干事代录本学院
  // 有人上场的比赛（见 match-record.canRecordScore 与 mock.submitMatch）。
  // 这里不按数据源放宽——否则普通会员会在签表上看到一列不属于自己的
  // 「录分」入口。collegeOf 从会员档案里取，干事因此只能管到本院。
  const actorId = actor ? actor._id : null;
  const collegeOf = (id) => (id ? (memberMap.get(id) || {}).college || '' : '');
  const recordOptions = {
    role: actor ? actor.role : ROLE.MEMBER,
    college: (actor && actor.college) || '',
    collegeOf,
  };
  // 确认要带上角色：管理员可确认任意一场（见 match-record.canConfirm）
  const confirmOptions = { isMock: mock, role: actor ? actor.role : undefined };

  return eventRecords
    .slice()
    .sort((a, b) => {
      // 多阶段赛制先按阶段分区（小组赛全部排完再排淘汰赛、胜者组→败者组→
      // 总决赛），否则各组的第 1 轮会和淘汰赛第 1 轮按同一个 round 值交错
      if (stageFirst) {
        return (
          stageOrder(a.stage) - stageOrder(b.stage) ||
          Number(a.group || 0) - Number(b.group || 0) ||
          timeValue(a.round) - timeValue(b.round) ||
          Number(a.slot) - Number(b.slot)
        );
      }
      return (
        timeValue(a.round) - timeValue(b.round) ||
        stageOrder(a.stage) - stageOrder(b.stage) ||
        Number(a.slot) - Number(b.slot)
      );
    })
    .map((record) => {
      const tag = statusTagOf(record.status, record.action);
      // 还没比分的场次不渲染比分占位符——那会和「0:0」混在一起
      const hasScore = asArray(record.scoreA).length > 0;
      const waiting = needsScore(record);
      return {
        matchId: record._id,
        roundText: roundLabelOf(record.round, totalRounds, record.stage),
        // 小组赛的比赛带 group 段，界面上要标出是哪一组；0 号组也要标
        groupText: hasGroup(record.group) ? groupLabelOf(record.group, format) : '',
        // 双打两边各两人：两名成员的名字一起显示，不再只露第一人
        teamAText: teamTextOf(record.teamA, memberMap),
        teamBText: teamTextOf(record.teamB, memberMap),
        timeText: record.matchTime ? formatDateTime(record.matchTime) : '',
        scoreText: hasScore ? formatScore(record.scoreA, record.scoreB) : '',
        winnerSide: record.winner || '',
        statusLabel: tag.label,
        statusClass: tag.className,
        isMine: Boolean(actorId && (isParticipant(record, actorId))),
        // 还没比分的场次先录分，录完才谈得上确认
        canRecord: Boolean(waiting && actorId && canRecordScore(record, actorId, recordOptions)),
        canConfirm: Boolean(!waiting && canConfirm(record, actorId, confirmOptions)),
      };
    });
}


/**
 * 把分组信息与比赛整形成积分表（循环赛 / 小组赛用）。
 *
 * 【为什么名次也由这里算】
 * 循环赛的名次是算出来的，不是打出来的（见 format-plan.derivePlacements）。
 * 积分表要把「胜场 → 相互战绩 → 净胜局 → 净胜分」这条链展示出来，
 * 管理员才好在名次页对着它微调。算法本身在 utils/standings.js。
 *
 * @param {Object} event
 * @param {Array<Object>} records 该赛事的比赛台账
 * @param {Map<string, Object>} memberMap
 * @param {Object|null} [actor]
 * @returns {Array<Object>} 每组一张积分表
 */
function buildStandings(event, records, memberMap, actor = null) {
  const draw = event && event.draw;
  const groups = asArray(draw && draw.groups);
  if (groups.length === 0) return [];

  const eventId = event && event._id;
  const format = formatOf(event);
  const actorId = actor ? actor._id : null;

  return groups.map((item) => {
    const groupMatches = asArray(records).filter(
      (record) => record && record.eventId === eventId && record.group === item.group
    );
    const rows = computeStandings({ entries: asArray(item.entries), matches: groupMatches });

    return {
      group: item.group,
      groupLabel: groupLabelOf(item.group, format),
      rows: rows.map((row) => {
        // 双打的积分表一行是一支队伍，编号拆开是两名成员；单打拆出本人
        const ids = splitTeamId(row.id);
        const first = memberMap.get(ids[0]) || {};
        return {
          userId: row.id,
          rank: row.rank,
          rankText: row.rank === 1 ? '1' : String(row.rank),
          nickName: teamTextOf(ids, memberMap),
          avatarText: avatarOf(first.nickName || row.id),
          avatarUrl: first.avatarUrl || '',
          played: row.played,
          wins: row.wins,
          losses: row.losses,
          gameDiffText: signedText(row.gameDiff),
          pointDiffText: signedText(row.pointDiff),
          // 双打里「我」是队里的一员：任一人是我就高亮整行
          isMe: Boolean(actorId && ids.includes(actorId)),
        };
      }),
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

  const [current, members, events, season, collegeEvents] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
    getSeasonState(),
    getCollegeEvents(),
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
  const collegeRows = buildCollegeEventListRows(collegeEvents, { actor });
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
    // 学院赛入口：列表按人给出不同去向（管理员审核 / 干事交名单），
    // 发布入口与个人赛同权限门槛（仅管理员）
    collegeEvents: collegeRows,
    hasCollegeEvents: collegeRows.length > 0,
    collegeEventsEmptyNote: '还没有学院赛，等管理员发布一场吧',
    canManageCollege: canManageCollegeEvent(actor),
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
      standings: [],
      hasStandings: false,
      drawText: '',
      byeText: '',
      seedCandidates: [],
      manualSeedNeeded: 0,
      seedUnit: '位种子',
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
  const standings = buildStandings(event, ledger, memberMap, actor);
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
    standings,
    hasStandings: standings.some((group) => group.rows.length > 0),
    drawText: describeDraw(event.draw),
    byeText: byeTextOf(event.draw, memberMap),
    // 手工指定种子要凑几位：参赛人数不够种子数时，人人都是种子。
    // 双打每两位参赛者编成一队，管理员要点的人数是一样两倍（每组 2 人）
    seedCandidates,
    manualSeedNeeded: row.isDoubles
      ? manualPlayersNeeded(row.seedCount, seedCandidates.length)
      : actualSeedCount(row.seedCount, seedCandidates.length),
    // 点名单位：单打点的是种子本人，双打点的是参赛者（每 2 人合成 1 组种子）。
    // 放在视图模型里，界面文案与页面提示就同一份口径，不必各自判断项目
    seedUnit: row.isDoubles ? '位参赛者' : '位种子',
    resultRows,
    hasResults: resultRows.length > 0,
  };
}

/**
 * 抽签结果里出现过的队伍编号（去重、保序）。
 * 单败淘汰看签位 slots，循环 / 小组看各组名单；两处都空时返回空数组。
 *
 * @param {Object} draw
 * @returns {string[]}
 */
function drawnTeamIds(draw) {
  const groups = asArray(draw && draw.groups);
  const source =
    groups.length > 0 ? groups.flatMap((item) => asArray(item.entries)) : asArray(draw && draw.slots);
  return Array.from(new Set(source.filter(Boolean)));
}

/**
 * 双打名次录入的名单行：一行一支队伍，两人一起显示。
 *
 * 【为什么按队而不按人】
 * 名次记在个人头上，但双打的名次天然属于一支队伍——两人同一次考核。
 * 让人各填一遍既容易填出不一样的数，也会被成对校验挡下。这里按队给行，
 * 提交时再由页面把一行的名次摊到两名成员身上。
 *
 * @param {string[]} teamIds
 * @param {Map<string, Object>} memberMap
 * @returns {Array<Object>}
 */
function buildTeamRows(teamIds, memberMap) {
  return asArray(teamIds).map((teamId) => {
    const ids = splitTeamId(teamId);
    const first = memberMap.get(ids[0]) || {};
    return {
      userId: teamId,
      // 提交时要据它把一行的名次摊到两名成员头上
      userIds: ids,
      nickName: teamTextOf(ids, memberMap),
      avatarText: avatarOf(first.nickName || teamId),
      avatarUrl: first.avatarUrl || '',
      statusLabel: '',
      checkedIn: false,
      isMe: false,
      canCheckIn: false,
      statText: '',
    };
  });
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
      hintText: '',
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
      hintText: '',
    };
  }

  const [signups, ledger] = await Promise.all([
    getEventSignups(eventId),
    getMatchRecords({ eventId }),
  ]);
  const row = buildEventRow(event, { actor, signups });
  const memberMap = new Map(asArray(members).map((member) => [member._id, member]));
  // 双打按队伍录入名次（一行两人），单打按人。双打一旦抽过签，队伍就由
  // 签表定了；极端情况下没有签表时退回按人，至少不挡住录入
  const teamIds = row.isDoubles ? drawnTeamIds(event.draw) : [];
  const rows =
    teamIds.length > 0
      ? buildTeamRows(teamIds, memberMap)
      : buildSignupRows(signups, memberMap, { actor, event });
  const canEdit = canFinishEvent(event, actor);

  let statusNote = '';
  if (!canEdit) {
    statusNote = row.isFinished
      ? '这场赛事已经结束，名次不可再改'
      : '赛事开始后才能录入名次，请先在详情页把赛事设为「进行中」';
  }

  // 循环 / 小组 / 双败的名次是算出来的：把推导结果预填进输入框，管理员在
  // 上面微调即可。没打完时推导失败，输入框留空，由提示文案说明原因。
  const derived = hasAutoPlacements(event)
    ? derivePlacements({ event, draw: event.draw, matches: ledger })
    : { ok: false, results: [], message: '' };
  const autoPlacement = new Map(
    derived.ok ? derived.results.map((item) => [item.userId, item.placement]) : []
  );
  const filled = rows.map((item) => {
    const placement = autoPlacement.get(item.userId);
    return placement === undefined ? item : { ...item, placementText: String(placement) };
  });

  return {
    allowed: true,
    blockedText: '',
    found: true,
    canEdit,
    statusNote,
    event: row,
    rows: filled,
    hasRows: filled.length > 0,
    emptyNote: '还没有人报名，录入名次前先让会员报名',
    bronzeHint: bronzeHintOf(event),
    hintText: hasAutoPlacements(event) ? groupedPlacementHint(event, row, derived) : bronzeHintOf(event),
  };
}

/**
 * 循环 / 小组赛名次页的提示文案。
 *
 * 打完的就说明名次已自动排出、可微调；没打完的分两种：赛事根本没开始
 * （还没抽签）与赛事刚开始（比赛没打完），说的是同一件事，文案要能各自说清。
 *
 * @param {Object} event
 * @param {Object} row buildEventRow 的结果
 * @param {Object} derived derivePlacements 的结果
 * @returns {string}
 */
function groupedPlacementHint(event, row, derived) {
  if (derived.ok) {
    if (formatOf(event) === EVENT_FORMAT.ROUND_ROBIN) {
      return '循环赛名次已按战绩自动排出，可直接微调后提交';
    }
    if (isDoubleElimFormat(event)) {
      return '双败名次已按淘汰轮次自动排出，可直接微调后提交';
    }
    return '出线者按淘汰成绩、未出线者按小组名次自动排出，可直接微调后提交';
  }
  if (!event.draw) return '还没有抽签，抽签并打完比赛后才能自动排名';
  if (row.isFinished) return '';
  return derived.message || '比赛还没打完，名次尚未确定';
}

module.exports = {
  MEDALS,
  PLACEMENT_MEDALS,
  TOP_LIMIT,
  medalOf,
  avatarOf,
  asArray,
  timeValue,
  formatOf,
  isGroupedFormat,
  isDoubleElimFormat,
  hasAutoPlacements,
  groupLabelOf,
  countEvents,
  describeSeason,
  buildPointsRows,
  sortEvents,
  placementLabelOf,
  bronzeHintOf,
  buildEventListRows,
  sortCollegeEvents,
  buildCollegeEventListRows,
  loadSignupMap,
  buildSignupRows,
  buildResultRows,
  stageOrder,
  roundLabelOf,
  totalRoundsOf,
  maxRoundOf,
  describeDraw,
  teamTextOf,
  entryTextOf,
  byeTextOf,
  buildBracketRows,
  buildStandings,
  drawnTeamIds,
  buildTeamRows,
  loadEventsView,
  loadEventDetailView,
  loadEventPlacementView,
};
