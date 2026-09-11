/**
 * 比赛页的视图模型
 * ============================================================
 * 比赛页要做的事比「我的」页更敏感：它不只展示成绩，还让人确认、驳回、
 * 撤销成绩。因此这里的重点是**把权限算在视图模型里**，页面拿到的每一行
 * 都自带 canConfirm / canRevoke，页面只负责照着渲染按钮。
 *
 * 【为什么权限不上页面】
 * 页面上写 `wx:if="{{item.status === 0 && item.side !== 'A'}}"` 这种条件，
 * 一是把业务规则散进了模板（改规则要翻 wxml），二是没法测试——Node 跑不了
 * 模板。规则全部来自 match-record.js，这里只是把结果放进行数据里。
 *
 * 【为什么用台账而不是 getMatches】
 * getMatches 只给已生效的比赛，「待确认」「已撤销」根本不在里面，而这两类
 * 恰恰是比赛页的主角。所以取数是 getMatchRecords（读 mock 的 ledger）。
 *
 * 【确认权的演示口径】
 * mock 下确认权放宽为「参与即可」（见 match-record.canConfirm 的注释）。
 * 放宽这件事必须在界面上说明白，否则会被当成真实规则。视图模型逐行比对
 * 「放宽后的权限」与「严格口径的权限」，只要两者不一致就置 confirmRelaxed，
 * 由 loadMatchView 汇总成一句 demoNotice。这样文案的触发条件是算出来的，
 * 不是靠页面猜的。
 * ============================================================
 */

const { MATCH_STATUS, MATCH_STATUS_LABEL, MATCH_TYPE_LABEL, ROLE, ROLE_LABEL } = require('../utils/constants.js');
const { formatDateTime, formatScore } = require('../utils/format.js');
const { formatMatchFormat } = require('../utils/match-format.js');
const { createNameResolver } = require('../utils/stats.js');
const { canConfirm, canRevoke, needsScore, sideOf } = require('./match-record.js');
const { getCurrentUser, getMember, getMembers, getMatchRecords, isMock } = require('./index.js');

/** 页面上的三个标签页 */
const TAB = {
  ALL: 'all', // 全部比赛
  MINE: 'mine', // 我参与过的
  PENDING: 'pending', // 待我确认的
};

const TAB_LABEL = {
  [TAB.ALL]: '全部比赛',
  [TAB.MINE]: '我参与的',
  [TAB.PENDING]: '待确认',
};

/** 空态文案按标签页区分。「没有比赛」和「没有待确认的比赛」是两回事 */
const TAB_EMPTY = {
  [TAB.ALL]: '还没有任何比赛记录',
  [TAB.MINE]: '你还没有参加过比赛',
  [TAB.PENDING]: '没有待确认的比赛',
};

/**
 * 默认取多少场。
 *
 * 台账里有六百多场，一次全渲染出来会让首屏明显变卡。这里取最近
 * 一批即可，超出部分置 hasMore，由页面如实告知「只显示最近 N 场」，
 * 不假装已经翻到底了。比赛页不做翻页（见计划的「明确不做」）。
 */
const DEFAULT_LIMIT = 100;

/** 兜底的名解析：查不到就原样返回编号，绝不渲染出 undefined */
const DEFAULT_NAME_OF = createNameResolver(null);

/**
 * 状态标签的文案与样式类。
 *
 * 【驳回为什么借「已撤销」的壳】
 * 驳回和撤销的终态一样（成绩作废、分数回滚），区别只在动作和理由。
 * 为驳回单开一个枚举值，会让所有「判断是否作废」的地方都要改，
 * 而 constants.js 规定枚举只增不改，所以靠 action 区分文案即可。
 *
 * @param {number} status 取值见 constants.MATCH_STATUS
 * @param {string} [action] 'confirm' | 'reject' | 'revoke'
 * @returns {{label:string, className:string}}
 */
function statusTagOf(status, action) {
  if (status === MATCH_STATUS.PENDING) return { label: '待确认', className: 'is-pending' };
  if (status === MATCH_STATUS.REVOKED) {
    return action === 'reject'
      ? { label: '已驳回', className: 'is-revoked' }
      : { label: '已撤销', className: 'is-revoked' };
  }
  if (status === MATCH_STATUS.ACTIVE) return { label: '已生效', className: 'is-active' };
  return { label: MATCH_STATUS_LABEL[status] || '未知状态', className: 'is-unknown' };
}

/** 把一串会员编号变成「张三、李四」。空队伍给「待定」，不给空串 */
function joinNames(ids, nameOf) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => nameOf(id));
  return list.length ? list.join('、') : '待定';
}

/**
 * 把一串会员编号变成可点击的条目。
 * 页面上的队名要能点开看主页，所以除了昵称还得带上编号。
 */
function memberList(ids, nameOf) {
  return (Array.isArray(ids) ? ids : []).map((id) => ({ userId: id, nickName: nameOf(id) }));
}

/**
 * 整形比赛台账的一行。
 *
 * @param {Object} record getMatchRecords 的单项
 * @param {Object} [ctx]
 * @param {string} [ctx.userId] 当前看页面的会员
 * @param {number} [ctx.role] 当前会员的角色，决定能不能撤销
 * @param {Function} [ctx.nameOf] 编号转昵称
 * @param {boolean} [ctx.isMock] 是否放宽确认权
 * @returns {Object}
 */
function buildRecordRow(record, ctx = {}) {
  const { userId = null, role, nameOf = DEFAULT_NAME_OF, isMock: mock = isMock } = ctx;

  const tag = statusTagOf(record.status, record.action);
  const side = sideOf(record, userId);
  const isMine = side !== null;
  const winner = record.winner || '';

  // 只有自己参与过、且这场已分出胜负，才谈得上「胜/负」。
  // 旁观者看别人的比赛不该被标一个「负」，所以 resultText 留空由模板挡掉
  const isWin = Boolean(isMine && winner && winner === side);

  // 抽签排出的比赛还没比分，此时谈「确认」为时过早：确认要按胜方计分，
  // 没有胜方就无从计起。先在比赛页给一个「录分」入口。
  const waiting = needsScore(record);
  const relaxedConfirm = !waiting && canConfirm(record, userId, { isMock: mock });
  const strictConfirm = !waiting && canConfirm(record, userId, { isMock: false });

  return {
    matchId: record._id,
    typeLabel: MATCH_TYPE_LABEL[record.matchType] || '',
    // P3 要求的赛制落地：老数据没有这两个字段时返回空串，模板用 wx:if 挡掉
    formatText: formatMatchFormat({ gamePoints: record.gamePoints, bestOf: record.bestOf }),
    dateText: formatDateTime(record.matchTime),
    locationText: record.location || '',
    teamAText: joinNames(record.teamA, nameOf),
    teamBText: joinNames(record.teamB, nameOf),
    teamAList: memberList(record.teamA, nameOf),
    teamBList: memberList(record.teamB, nameOf),
    winnerSide: winner,
    scoreText: formatScore(record.scoreA, record.scoreB),
    isMine,
    isWin,
    resultText: isMine && winner ? (isWin ? '胜' : '负') : '',
    isEvent: Boolean(record.eventId),
    status: record.status,
    statusLabel: tag.label,
    statusClass: tag.className,
    statusReason: record.reason || '',
    action: record.action || '',
    canConfirm: relaxedConfirm,
    // 权限只来自 mock 放宽时置真——界面据此标注「演示口径」
    confirmRelaxed: relaxedConfirm && !strictConfirm,
    // 还没比分的赛事比赛：给「录分」而不是「确认」
    needsScore: waiting,
    // 录分权与写入端一致：参赛者或管理员；演示数据源放宽为登录即可
    canRecord: Boolean(
      waiting && userId && (isMine || role === ROLE.ADMIN || mock)
    ),
    canRevoke: canRevoke(record, userId, { role }),
  };
}

/**
 * 按标签页筛选台账。
 *
 * @param {Array<Object>} records
 * @param {string} tab 取值见 TAB
 * @param {string} userId
 * @returns {Array<Object>}
 */
function filterRecords(records, tab, userId) {
  const list = Array.isArray(records) ? records : [];
  if (tab === TAB.MINE) return list.filter((match) => sideOf(match, userId) !== null);
  if (tab === TAB.PENDING) {
    return list.filter(
      (match) => match.status === MATCH_STATUS.PENDING && sideOf(match, userId) !== null
    );
  }
  return list;
}

/**
 * 装载比赛页。
 *
 * 【调用方为什么要把登录态传进来】
 * 与 loadHomeView(user) 同一套约定：页面手上才有全局登录态。若这里
 * 自己去问数据源「当前用户是谁」，mock 下永远答 u06，于是未登录的
 * 访客也会被当成 u06，凭空获得确认与撤销的权限。所以登录态由调用方
 * 明确传入——传 null 就是「访客」，语义清清楚楚。
 *
 * @param {Object} [options]
 * @param {string} [options.tab] 当前标签页，非法值退回「全部」
 * @param {number} [options.limit] 最多多少行
 * @param {Object|null} [options.user] 当前登录会员，传 null 表示访客。
 *        省略该字段时才回退到 userId / 数据源的当前用户
 * @param {string} [options.userId] 看谁的比赛
 * @returns {Promise<Object>} userId 查无此人时返回 { found: false }
 */
async function loadMatchView(options = {}) {
  const { tab = TAB.ALL, limit = DEFAULT_LIMIT, userId } = options;
  // 必须用 hasOwnProperty：传 null（明确表示访客）与不传是两件事
  const explicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  let user = null;
  if (explicitUser) {
    user = options.user || null;
  } else if (userId) {
    user = await getMember(userId);
    if (!user) return { found: false };
  } else {
    user = await getCurrentUser();
  }

  const viewerId = user ? user._id : null;
  const activeTab = TAB_LABEL[tab] ? tab : TAB.ALL;

  const [members, ledger] = await Promise.all([getMembers(), getMatchRecords()]);
  const nameOf = createNameResolver(members);

  // 访客只看已生效的成绩。待确认与已撤销是流转中的临时状态，
  // 不该进入对外的公示口径（与 getMatches 只给 ACTIVE 是同一条原则）
  const all = viewerId ? ledger : ledger.filter((match) => match.status === MATCH_STATUS.ACTIVE);

  const filtered = filterRecords(all, activeTab, viewerId);
  const size = typeof limit === 'number' && limit >= 0 ? limit : DEFAULT_LIMIT;
  const records = filtered
    .slice(0, size)
    .map((record) =>
      buildRecordRow(record, { userId: viewerId, role: user ? user.role : undefined, nameOf })
    );

  return {
    found: true,
    viewer: {
      userId: viewerId,
      roleLabel: user ? ROLE_LABEL[user.role] || '' : '',
      loggedIn: Boolean(user),
    },
    tabs: Object.values(TAB).map((key) => ({
      tab: key,
      label: TAB_LABEL[key],
      active: key === activeTab,
    })),
    activeTab,
    records,
    total: filtered.length,
    hasMore: filtered.length > records.length,
    emptyText: TAB_EMPTY[activeTab],
    // 待确认的数量放在标签上，不用点进去才知道有没有事要做
    pendingCount: filterRecords(all, TAB.PENDING, viewerId).length,
    demoNotice: records.some((row) => row.confirmRelaxed)
      ? '当前为演示数据源：只要参与过这场比赛就可以确认比分，正式环境需由对手确认'
      : '',
  };
}

module.exports = {
  TAB,
  TAB_LABEL,
  TAB_EMPTY,
  DEFAULT_LIMIT,
  statusTagOf,
  buildRecordRow,
  filterRecords,
  loadMatchView,
};
