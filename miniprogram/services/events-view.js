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
  SIGNUP_STATUS,
  isRankable,
} = require('../utils/constants.js');
const { buildLeaderboard } = require('../utils/leaderboard.js');
const { formatDate, formatPercent } = require('../utils/format.js');
const {
  canManageEvent,
  canCheckIn,
  canFinishEvent,
  buildEventRow,
  buildSignupRow,
  signupStateOf,
} = require('./event.js');
const {
  getCurrentUser,
  getMembers,
  getEvents,
  getEventSignups,
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
 * @param {boolean} [ctx.isMock=false] 演示数据源下放宽管理权
 * @returns {Array<Object>}
 */
function buildEventListRows(events, ctx = {}) {
  const { actor = null, signupMap = new Map(), isMock: mock = false } = ctx;
  return sortEvents(events).map((event) => {
    const signups = signupMap.get(event._id) || [];
    return buildEventRow(event, { actor, signups, isMock: mock });
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
 * @param {boolean} [ctx.isMock=false]
 * @returns {Array<Object>}
 */
function buildSignupRows(signups, memberMap, ctx = {}) {
  const { actor = null, event = null, isMock: mock = false } = ctx;
  const mayCheckIn = canCheckIn(event, actor, { isMock: mock });

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

/** 演示口径的说明。只有「数据源放宽了权限、正式规则不允许」时才提示 */
function demoNoticeOf(mock, actor) {
  const relaxed = canManageEvent(actor, { isMock: true });
  const strict = canManageEvent(actor, { isMock: false });
  if (!mock || !relaxed || strict) return '';
  return '当前为演示数据源：任何已登录会员都可以管理赛事，正式环境需由管理员操作';
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
 * @param {boolean} [options.isMock=false] 是否演示数据源
 * @returns {Promise<Object>}
 */
async function loadEventsView(options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');
  const { isMock: mock = false } = options;

  const [current, members, events, season] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
    getSeasonState(),
  ]);

  const actor = usesExplicitUser ? options.user : current;
  const myId = actor ? actor._id : null;

  const rows = buildPointsRows(members, countEvents(events), myId);
  const myRow = (myId && rows.find((row) => row.isMe)) || null;

  const signupMap = await loadSignupMap(events);
  const eventRows = buildEventListRows(events, { actor, signupMap, isMock: mock });
  const canPublish = canManageEvent(actor, { isMock: mock });

  return {
    seasonText: describeSeason(season),
    rows,
    playerCountText: `${rows.length} 人上榜`,
    empty: rows.length === 0,
    emptyNote: '本赛季还没有人拿到积分，参加一次赛事就能上榜',
    me:
      myRow === null
        ? null
        : {
            rank: myRow.rank,
            total: rows.length,
            beatText: `超过 ${formatPercent((rows.length - myRow.rank) / rows.length)} 的会员`,
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
 * @param {boolean} [options.isMock=false]
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
      resultRows: [],
      hasResults: false,
      demoNotice: '',
    };
  }

  const signups = await getEventSignups(eventId);
  const row = buildEventRow(event, { actor, signups, isMock: mock });
  const memberMap = new Map(asArray(members).map((member) => [member._id, member]));

  const signupRows = buildSignupRows(signups, memberMap, { actor, event, isMock: mock });
  const resultRows = buildResultRows(event, memberMap, actor);

  return {
    found: true,
    notFoundText: '',
    event: row,
    signupRows,
    hasSignups: signupRows.length > 0,
    signupsEmptyNote: '还没有人报名',
    resultRows,
    hasResults: resultRows.length > 0,
    demoNotice: demoNoticeOf(mock, actor),
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
 * @param {boolean} [options.isMock=false]
 * @returns {Promise<Object>}
 */
async function loadEventPlacementView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');
  const { isMock: mock = false } = options;

  const [current, members, events] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getEvents(),
  ]);
  const actor = usesExplicitUser ? options.user : current;

  const allowed = canManageEvent(actor, { isMock: mock });

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
      demoNotice: '',
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
      demoNotice: demoNoticeOf(mock, actor),
    };
  }

  const signups = await getEventSignups(eventId);
  const row = buildEventRow(event, { actor, signups, isMock: mock });
  const memberMap = new Map(asArray(members).map((member) => [member._id, member]));
  const rows = buildSignupRows(signups, memberMap, { actor, event, isMock: mock });
  const canEdit = canFinishEvent(event, actor, { isMock: mock });

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
    demoNotice: demoNoticeOf(mock, actor),
  };
}

module.exports = {
  MEDALS,
  PLACEMENT_MEDALS,
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
  loadEventsView,
  loadEventDetailView,
  loadEventPlacementView,
};
