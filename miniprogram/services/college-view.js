/**
 * 学院赛页面的视图模型（名单提交 / 名单审核）
 * ============================================================
 * 与 events-view.js 同一思路：取数、整形、算文案都在这里，页面只管渲染。
 * 本模块不碰任何 wx API，可以在 Node 里测。
 *
 * 【为什么权限布尔量在这里算好】
 * 模板里写 `wx:if="{{role>=1}}"` 既无法单测，也容易漏改一处就留下越权入口。
 * 判定一律回到 services/college-entry.js 的纯函数，本模块只负责把结果
 * 摊平成模板好用的形状（blockReason / canSubmit / canReview）。
 *
 * 【为什么队员候选只按「本学院 + 在册」过滤】
 * 名单成员必须是本学院在册会员（设计 doc 5.3），从源头杜绝跨院凑人。
 * getMembers() 给的已是审核通过的会员，再按学院精确相等筛一道即可。
 * ============================================================
 */

const {
  COLLEGE_EVENT_STATUS,
  COLLEGE_EVENT_STATUS_LABEL,
  COLLEGE_ENTRY_STATUS,
  GENDER_LABEL,
  LEG_DISCIPLINE_LABEL,
  MATCH_STATUS,
  MATCH_OUTCOME,
  MATCH_TYPE_LABEL,
  TIE_STATUS,
  requiredGendersOf,
} = require('../utils/constants.js');
const { formatDate, formatDateTime, formatScore, formatPlacement } = require('../utils/format.js');
const { formatMatchFormat } = require('../utils/match-format.js');
const {
  getCurrentUser,
  getMembers,
  getCollegeEvent,
  getCollegeEntries,
  getCollegeTies,
  getCollegeLineups,
  getMatchRecords,
  getLiveScores,
  isMockNow,
} = require('./index.js');
const {
  canSubmitCollegeEntry,
  canReviewCollegeEntry,
  buildCollegeEntryRow,
  entryStateOf,
  remainingMemberIds,
} = require('./college-entry.js');
const {
  buildCollegeEventRow,
  buildCollegeResultRows,
  legPlanTextOf,
  rosterRangeTextOf,
  canManageCollegeEvent,
  canFinishCollegeEvent,
} = require('./college-event.js');
const { canDrawCollegeEvent, approvedCollegesOf } = require('./college-draw.js');
const {
  buildTieRow,
  canStartCollegeEvent,
  tieStatusLabelOf,
  firstRoundPairsOf,
  isDoublesDiscipline,
} = require('./college-tie.js');
const { canConfirm, canRecordScore, canRevoke, hasReferee, needsScore } = require('./match-record.js');
const { statusTagOf } = require('./match-view.js');
const { describeLive } = require('./live-view.js');
const {
  canSubmitLineup,
  defaultLineupEntries,
  playersPerLeg,
} = require('./college-lineup.js');

/** 取名字，逐层兜底，绝不渲染出 undefined */
function nameOf(member) {
  if (!member) return '';
  return member.nickName || member.realName || member._id || '';
}

/** 头像占位字：取名字最后一个字，与其它页面一致 */
function avatarTextOf(name) {
  return name ? name.slice(-1) : '?';
}

/**
 * 小项的性别提示：男单 / 男双 → 「限男」；女单 / 女双 → 「限女」；
 * 混双 → 「一男一女」。未知小项返回空串。与校验同源（requiredGendersOf），
 * 页面上写「限男」而校验按别的规则拦人这种事不会发生。
 */
function genderHintOf(discipline) {
  const required = requiredGendersOf(discipline);
  if (!required || required.length === 0) return '';
  const kinds = Array.from(new Set(required));
  if (kinds.length > 1) return '一男一女';
  return `限${GENDER_LABEL[kinds[0]] || ''}`;
}

/**
 * 名单提交页的视图模型。
 *
 * @param {string} eventId
 * @param {Object} [options]
 * @param {Object|null} [options.user] 当前登录会员（页面显式传入，传 null 即访客）
 * @param {string} [options.college] 指定学院；缺省取登录者所属学院
 * @returns {Promise<Object>}
 */
async function loadCollegeEntryView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members, event, entries] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getCollegeEvent(eventId),
    getCollegeEntries(eventId),
  ]);

  const actor = usesExplicitUser ? options.user : current;
  const college = options.college || (actor ? actor.college || '' : '');

  // 权限与拦截文案：先判登录，再判赛事存在与状态，最后判学院范围。
  // 顺序即提示顺序——先说的那条最该被用户先看到。
  let blockReason = '';
  if (!actor) blockReason = '请先登录后再提交名单';
  else if (!event) blockReason = '找不到这场学院赛';
  else if (event.status !== COLLEGE_EVENT_STATUS.SIGNUP) blockReason = '名单已经锁定，不能再修改';
  else if (!canSubmitCollegeEntry(event, actor, { college })) blockReason = '只能提交本学院的名单';

  const canSubmit = !blockReason;
  const existing = entries.find((item) => item.college === college) || null;
  const picked = new Set(existing && Array.isArray(existing.members) ? existing.members : []);

  // 候选队员：本学院在册会员。已提交的名单里的人预勾选，便于改后重交
  const candidates = members
    .filter((member) => member.college === college)
    .map((member) => {
      const name = nameOf(member);
      return {
        memberId: member._id,
        nickName: name,
        avatarUrl: member.avatarUrl || '',
        avatarText: avatarTextOf(name),
        gender: member.gender || '',
        genderLabel: GENDER_LABEL[member.gender] || '',
        checked: picked.has(member._id),
      };
    });

  const eventRow = event ? buildCollegeEventRow(event, { actor }) : null;
  const state = entryStateOf(existing);

  return {
    found: Boolean(event),
    canSubmit,
    blockReason,
    eventId: event ? event._id : eventId || '',
    title: event ? event.title || '' : '',
    status: event ? event.status : null,
    statusLabel: event ? COLLEGE_EVENT_STATUS_LABEL[event.status] || '未知状态' : '',
    college,
    legPlanText: event ? legPlanTextOf(event) : '',
    rosterText: event ? rosterRangeTextOf(event) : '',
    allowMultiEntry: event ? event.allowMultiEntry !== false : false,
    startTimeText: event ? formatDate(event.startTime) : '',
    location: event ? event.location || '' : '',
    tieAlgoLabel: eventRow ? eventRow.tieAlgoLabel : '',
    tieNetModeLabel: eventRow ? eventRow.tieNetModeLabel : '',
    // 已提交的名单本身：页面据此显示「已通过 / 已退回」与退回理由
    entryStatus: state.status,
    entryStatusLabel: state.label,
    entryPending: state.pending,
    entryApproved: state.approved,
    entryReturned: state.returned,
    entryReason: existing ? existing.reason || '' : '',
    existingCount: existing && Array.isArray(existing.members) ? existing.members.length : 0,
    candidates,
    // 需求是全选后的人数校验由数据层兜底，页面只显示已选人数
    selectedCount: candidates.filter((item) => item.checked).length,
    remark: existing ? existing.remark || '' : '',
  };
}

/**
 * 名单审核页的视图模型。
 *
 * @param {string} eventId
 * @param {Object} [options]
 * @param {Object|null} [options.user]
 * @returns {Promise<Object>}
 */
async function loadCollegeEntryReviewView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members, event, entries] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getCollegeEvent(eventId),
    getCollegeEntries(eventId),
  ]);

  const actor = usesExplicitUser ? options.user : current;
  const canReview = canReviewCollegeEntry(actor);
  const byId = new Map(members.map((member) => [member._id, member]));

  let blockReason = '';
  if (!actor) blockReason = '请先登录后再审核名单';
  else if (!canReview) blockReason = '只有管理员可以审核名单';
  else if (!event) blockReason = '找不到这场学院赛';

  const rows = entries
    .map((entry) => buildCollegeEntryRow(entry, { actor, event, members: byId }))
    // 队员姓名拼成一串，模板里不必再嵌一层 wx:for 去渲染数组
    .map((row) => ({ ...row, memberNamesText: row.memberNames.join('、') }));

  return {
    found: Boolean(event),
    canReview,
    blockReason,
    eventId: event ? event._id : eventId || '',
    title: event ? event.title || '' : '',
    statusLabel: event ? COLLEGE_EVENT_STATUS_LABEL[event.status] || '未知状态' : '',
    legPlanText: event ? legPlanTextOf(event) : '',
    rosterText: event ? rosterRangeTextOf(event) : '',
    startTimeText: event ? formatDate(event.startTime) : '',
    location: event ? event.location || '' : '',
    rows,
    hasRows: rows.length > 0,
    emptyNote: '还没有学院提交名单',
    pendingCount: rows.filter((row) => row.isPending).length,
    // 已提交名单里的替补口径：名单总是全部人；未上场者即替补，
    // 这里是「名单人数」而不是「上场人数」的提醒文案
    substituteHint: '名单内未上场的队员即为替补，无需单独维护替补栏',
  };
}

/**
 * 种子行的显示整形：按已选顺序标出「种子 N」。
 *
 * 【为什么放在视图层而不是纯模块】
 * 这是「管理员点了第几个」的即时显示，随页面交互变化，不属于赛事规则。
 * 抽签的规则（种子必须来自已通过名单、不能重复）在 college-draw.js。
 *
 * @param {Array<string>} colleges 已通过审核的学院
 * @param {Array<string>} [seedColleges] 当前选中的种子顺序
 * @returns {Array<Object>}
 */
function buildSeedRows(colleges, seedColleges) {
  const order = Array.isArray(seedColleges) ? seedColleges : [];
  return (Array.isArray(colleges) ? colleges : []).map((college) => {
    const index = order.indexOf(college);
    return {
      college,
      isSeed: index >= 0,
      seedOrder: index >= 0 ? index + 1 : 0,
      seedOrderText: index >= 0 ? `种子 ${index + 1}` : '',
    };
  });
}

/** 首轮对阵的文字预览，例如「1. 体育学院 vs 信息工程学院」 */
function firstRoundPairsTextOf(draw) {
  return firstRoundPairsOf(draw)
    .filter((pair) => pair && pair[0] && pair[1])
    .map((pair, index) => `${index + 1}. ${pair[0]} vs ${pair[1]}`)
    .join('　');
}

/**
 * 学院赛详情页的视图模型：赛事信息 + 抽签入口 + 赛事级开赛 + 大场列表。
 *
 * 【为什么抽签与大场放在同一页】
 * 三件事在时间上首尾相接：报名中抽签 → 待开赛点开始 → 进行中打大场。分成
 * 三个页面，管理员每走一步都要回上一页再点进来；合成一页，状态一推，页面上
 * 该出现的入口自然就换了一批。名单审核仍留在独立的审核页。
 *
 * @param {string} eventId
 * @param {Object} [options]
 * @param {Object|null} [options.user] 显式传入当前用户（传 null 即访客）
 * @returns {Promise<Object>}
 */
async function loadCollegeEventDetailView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members, event, entries, ties, lineups] = await Promise.all([
    getCurrentUser(),
    getMembers(),
    getCollegeEvent(eventId),
    getCollegeEntries(eventId),
    getCollegeTies(eventId),
    getCollegeLineups(eventId),
  ]);

  const actor = usesExplicitUser ? options.user : current;
  const eventRow = event ? buildCollegeEventRow(event, { actor }) : null;

  let blockReason = '';
  if (!actor) blockReason = '请先登录后再查看学院赛';
  else if (!event) blockReason = '找不到这场学院赛';

  const approvedColleges = approvedCollegesOf(entries);
  const canDraw = canDrawCollegeEvent(event, actor);
  // 干事在本页也能直接去交名单：赛事列表把干事直接送进名单页，但若从
  // 别的路径进了详情页，这里仍要给一个入口，否则报名期干事无处可去。
  const canSubmitEntry = canSubmitCollegeEntry(event, actor);

  // 大场行：在共用的 buildTieRow 之上补「我能不能排阵 / 该显示什么按钮」
  const memberById = new Map((members || []).map((member) => [member._id, member]));
  // 指派大场裁判只给管理员，且只在大场未结束时开。这里用不带状态门槛的
  // canManageCollegeEvent：开赛后仍要能改派（见 canAssignTieReferee）
  const mayAssignReferee = canManageCollegeEvent(actor);

  // 大场行先出底座：每行的 legRows 已经带 matchId，实时比分的对齐靠它
  const baseTieRows = ties.map((tie) => {
    const refereeName = tie.referee ? nameOf(memberById.get(tie.referee)) || tie.referee : '';
    const row = buildTieRow(tie, { actor, refereeName });
    const myLineup = actor
      ? lineups.find((item) => item.tieId === tie._id && item.college === actor.college)
      : null;
    const canLineup = canSubmitLineup(tie, actor, { college: actor && actor.college, event });
    return {
      ...row,
      // buildTieRow 只判「这一场还能不能改派」，管理员与否在这里合上
      canAssignReferee: Boolean(row.canAssignReferee && mayAssignReferee),
      canSubmitLineup: canLineup,
      lineupActionText: canLineup ? (myLineup ? '修改排阵' : '提交排阵') : '',
      myLineupSubmitted: Boolean(myLineup),
    };
  });

  // 小场的实时比分：小场的 matches 把 eventId 留空（个人赛事读路径不认它们），
  // 所以不能按 eventId 查台账。改为把这一场所有小场的 matchId 收齐，一次批量
  // 取实时比分——与轮询适配器同一个读接口，首屏与增量同源。
  const legIds = [];
  for (const row of baseTieRows) {
    for (const leg of row.legRows) {
      if (leg.matchId) legIds.push(leg.matchId);
    }
  }
  const liveViews = legIds.length > 0 ? await getLiveScores(legIds) : [];
  const liveByMatch = new Map(
    (Array.isArray(liveViews) ? liveViews : []).map((view) => [view.matchId, view])
  );
  const tieRows = baseTieRows.map((row) => ({
    ...row,
    // 每个小项各自贴实时比分（按 matchId 对齐）；没有的保持原引用
    legRows: row.legRows.map((leg) => {
      const live = describeLive(liveByMatch.get(leg.matchId));
      return live ? { ...leg, live, liveActive: true } : leg;
    }),
  }));

  const draw = event && event.draw ? event.draw : null;
  const resultRows = buildCollegeResultRows(event);

  return {
    found: Boolean(event),
    blockReason,
    eventId: event ? event._id : eventId || '',
    title: event ? event.title || '' : '',
    status: event ? event.status : null,
    statusLabel: event ? COLLEGE_EVENT_STATUS_LABEL[event.status] || '未知状态' : '',
    isSignup: Boolean(event) && event.status === COLLEGE_EVENT_STATUS.SIGNUP,
    isReady: Boolean(event) && event.status === COLLEGE_EVENT_STATUS.READY,
    isOngoing: Boolean(event) && event.status === COLLEGE_EVENT_STATUS.ONGOING,
    isFinished: Boolean(event) && event.status === COLLEGE_EVENT_STATUS.FINISHED,
    legPlanText: event ? legPlanTextOf(event) : '',
    rosterText: event ? rosterRangeTextOf(event) : '',
    startTimeText: event ? formatDate(event.startTime) : '',
    location: event ? event.location || '' : '',
    tieAlgoLabel: eventRow ? eventRow.tieAlgoLabel : '',
    tieNetModeLabel: eventRow ? eventRow.tieNetModeLabel : '',
    // 抽签与开赛同门槛（管理员），共用一个布尔量给模板用
    canManage: canDraw,
    canDraw,
    canSubmitEntry,
    approvedColleges,
    hasApprovedColleges: approvedColleges.length > 0,
    drawHint: '按顺序点选种子学院：先点的排 1 号，再点一次取消',
    hasDraw: Boolean(draw),
    drawPairsText: draw ? firstRoundPairsTextOf(draw) : '',
    drawSeedsText: draw && draw.seeds.length > 0 ? draw.seeds.join('、') : '未指定种子',
    drawByesText: draw && draw.byes.length > 0 ? `轮空：${draw.byes.join('、')}` : '',
    canStartEvent: canStartCollegeEvent(event, actor),
    ties: tieRows,
    hasTies: tieRows.length > 0,
    tiesEmptyNote: '本轮还没有大场',
    currentRound: event ? event.currentRound || 0 : 0,
    // 已通过名单的学院数，抽签按钮据此给出「不足 2 个」的提示
    approvedCount: approvedColleges.length,
    // 名次：录入入口与已录结果（M5-1）
    canFinish: canFinishCollegeEvent(event, actor),
    resultRows,
    hasResults: resultRows.length > 0,
  };
}

/**
 * 学院名次录入页的视图模型（M5-1）。
 *
 * 与个人赛的名次页同一范式：列出参赛学院，一行一个名次输入框，管理员
 * 填完提交即结束赛事。差别只在「行是人还是学院」——学院赛里一行是一所
 * 学院（D26），因此候选来自已通过审核的名单，而不是报名记录。
 *
 * 【为什么不做「按签表自动推导」】
 * 个人赛的循环 / 小组赛能自动推名次，是因为名额由积分表算得出来；学院赛
 * 只有学院进签表，冠亚军虽由大场决出，但三、四名的并列口径要由管理员
 * 拍板（大场是打完了还是弃权了，观感上不是一回事）。先手工录入，规则
 * 收紧在 validateCollegePlacements 里（唯一冠军、每院一次）。
 *
 * @param {string} eventId
 * @param {Object} [options]
 * @param {Object|null} [options.user] 显式传入当前用户（传 null 即访客）
 * @returns {Promise<Object>}
 */
async function loadCollegePlacementView(eventId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, event, entries] = await Promise.all([
    getCurrentUser(),
    getCollegeEvent(eventId),
    getCollegeEntries(eventId),
  ]);

  const actor = usesExplicitUser ? options.user : current;

  let blockReason = '';
  if (!actor) blockReason = '请先登录后再录入名次';
  else if (!event) blockReason = '找不到这场学院赛';
  else if (event.status === COLLEGE_EVENT_STATUS.FINISHED) blockReason = '这场学院赛已经结束了';
  else if (event.status !== COLLEGE_EVENT_STATUS.ONGOING) blockReason = '学院赛还没开始，不能录入名次';
  else if (!canFinishCollegeEvent(event, actor)) blockReason = '只有管理员可以录入名次';

  const eventFields = {
    found: Boolean(event),
    eventId: event ? event._id : eventId || '',
    title: event ? event.title || '' : '',
    statusLabel: event ? COLLEGE_EVENT_STATUS_LABEL[event.status] || '未知状态' : '',
    isFinished: Boolean(event) && event.status === COLLEGE_EVENT_STATUS.FINISHED,
    startTimeText: event ? formatDate(event.startTime) : '',
    location: event ? event.location || '' : '',
    legPlanText: event ? legPlanTextOf(event) : '',
  };

  // 闸门：没有录入资格就到此为止，一条学院名单都不下发（与个人赛名次页同一口径）。
  // 名单里的队员是实名信息，能拦住就别让它进到不该看的人的视图里
  if (blockReason) {
    return {
      ...eventFields,
      blockReason,
      canSubmit: false,
      rows: [],
      hasRows: false,
      emptyNote: '',
      hint: '',
    };
  }

  // 已录过的名次回填，免得管理员重开页面时从零再填一遍
  const recorded = new Map(
    buildCollegeResultRows(event).map((row) => [row.college, String(row.placement)])
  );
  const rows = entries
    .filter((entry) => entry.status === COLLEGE_ENTRY_STATUS.APPROVED)
    .map((entry) => ({
      college: entry.college,
      placementText: recorded.get(entry.college) || '',
    }));

  return {
    ...eventFields,
    blockReason: '',
    canSubmit: true,
    rows,
    hasRows: rows.length > 0,
    emptyNote: '还没有已通过审核的学院，先收齐名单再来录名次',
    hint: '每所参赛学院一行：名次为不小于 1 的整数，冠军有且只有一位；没到场的学院可以不填',
  };
}

/**
 * 排阵页的视图模型：本大场逐个小项的出场人。
 *
 * 【为什么把「沿用上次」算在这里】
 * 沿用是给页面填默认值的，属于展示层决策：真正落库前用户还能改。放在这里
 * 一次算好，页面不必自己去找「上一次是哪一份」。规则（谁能排、排几个人、
 * 能不能兼项）仍回到 college-lineup.js 的纯函数。
 *
 * @param {string} tieId
 * @param {Object} [options]
 * @param {string} [options.eventId] 大场所属赛事（有则按赛事取，省一次全表读）
 * @param {string} [options.college] 指定学院；缺省取登录者所属学院
 * @param {Object|null} [options.user]
 * @returns {Promise<Object>}
 */
async function loadCollegeLineupView(tieId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members] = await Promise.all([getCurrentUser(), getMembers()]);
  const actor = usesExplicitUser ? options.user : current;

  const tieList = options.eventId ? await getCollegeTies(options.eventId) : await getCollegeTies();
  const tie = tieList.find((item) => item._id === tieId) || null;
  const eventId = tie ? tie.eventId : options.eventId || '';

  const [event, entries, lineups] = await Promise.all([
    eventId ? getCollegeEvent(eventId) : Promise.resolve(null),
    eventId ? getCollegeEntries(eventId) : Promise.resolve([]),
    eventId ? getCollegeLineups(eventId) : Promise.resolve([]),
  ]);

  const college = String(options.college || (actor ? actor.college || '' : '')).trim();
  const entry = entries.find((item) => item.college === college) || null;
  const byId = new Map(members.map((member) => [member._id, member]));

  const defaults = defaultLineupEntries({ tie, college, lineups });
  const defaultMap = new Map(
    (defaults.entries || []).map((row) => [Number(row.legNo), (row.players || []).map(String)])
  );
  const roster = entry && Array.isArray(entry.members) ? entry.members : [];
  const existing = lineups.find((item) => item.tieId === tieId && item.college === college) || null;

  // 拦截顺序即提示顺序：登录 → 大场存在 → 参赛学院 → 赛事态 → 名单状态
  let blockReason = '';
  if (!actor) {
    blockReason = '请先登录后再排阵';
  } else if (!tie) {
    blockReason = '找不到这个大场';
  } else if (college !== tie.collegeA && college !== tie.collegeB) {
    blockReason = '你不在本大场的参赛学院内';
  } else if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) {
    blockReason = '大场已经开始，不能再改排阵';
  } else if (event && event.status !== COLLEGE_EVENT_STATUS.ONGOING) {
    blockReason = '赛事还没开始，不能排阵';
  } else if (!canSubmitLineup(tie, actor, { college, event })) {
    blockReason = '只有本学院干事或管理员可以排阵';
  } else if (!entry || entry.status !== COLLEGE_ENTRY_STATUS.APPROVED) {
    blockReason = '本学院的名单尚未通过审核，不能排阵';
  }

  const legs = (tie && Array.isArray(tie.legs) ? tie.legs : []).map((leg) => {
    const picked = defaultMap.get(Number(leg.legNo)) || [];
    const need = playersPerLeg(leg.discipline);
    // 候选按小项性别过滤：男单只列男队员、混双列男女；不符合的人压根不出现，
    // 用户点不出一个必被校验拒绝的组合（校验仍在数据层兜底）
    const allowed = requiredGendersOf(leg.discipline);
    const optionsOf = roster
      .filter((id) => {
        if (!allowed) return true;
        const member = byId.get(id);
        return Boolean(member) && allowed.includes(member.gender);
      })
      .map((id) => {
        const member = byId.get(id);
        return {
          memberId: id,
          name: nameOf(member) || id,
          gender: (member && member.gender) || '',
          genderLabel: (member && GENDER_LABEL[member.gender]) || '',
          checked: picked.includes(String(id)),
        };
      });
    return {
      legNo: leg.legNo,
      discipline: leg.discipline,
      disciplineLabel: LEG_DISCIPLINE_LABEL[leg.discipline] || leg.discipline || '',
      genderHint: genderHintOf(leg.discipline),
      need,
      needText: `${need} 人`,
      pickedText: picked.length > 0 ? picked.map((id) => nameOf(byId.get(id))).join('、') : '未排人',
      options: optionsOf,
    };
  });

  return {
    found: Boolean(tie),
    blockReason,
    canSubmit: !blockReason,
    tieId: tie ? tie._id : tieId || '',
    eventId,
    title: event ? event.title || '' : '',
    roundText: tie ? `第 ${tie.round} 轮` : '',
    collegeA: tie ? tie.collegeA || '' : '',
    collegeB: tie ? tie.collegeB || '' : '',
    college,
    isCollegeA: Boolean(tie) && college === tie.collegeA,
    isCollegeB: Boolean(tie) && college === tie.collegeB,
    statusLabel: tieStatusLabelOf(tie),
    legs,
    hasLegs: legs.length > 0,
    carryHint:
      defaults.source === 'carried'
        ? '已自动沿用上次提交的排阵，可直接提交或调整'
        : defaults.source === 'own'
          ? '你已提交过本场排阵，下面是已交的内容'
          : '还没有可沿用的排阵，请逐项选择队员',
    rosterCount: roster.length,
    rosterEmpty: roster.length === 0,
    hasLineup: Boolean(existing),
  };
}

/**
 * 小场录分页的视图模型（M4-2 / M4-7）。
 *
 * 【为什么单独一页而不是复用 match-entry】
 * 小场的对阵、赛制、参赛人都已由排阵锁定，页面只收一组局分——match-entry
 * 那一整套换项目 / 换局制 / 找人面板在这里全是多余的，还容易让用户改出
 * 与排阵不符的阵容。所以这里只做「一个 11:? 的比分行 + 确认 + 弃权」。
 *
 * 【弃权为什么由管理员在页面上点】
 * 弃权改变大场走向（对手直接拿这一小项），且不计 ELO，属于管理判断。
 * 权限回到 college-event.canManageCollegeEvent，页面只把布尔量摊平。
 *
 * @param {string} matchId 小场比赛编号
 * @param {Object} [options]
 * @param {Object|null} [options.user] 显式传入当前用户（传 null 即访客）
 * @returns {Promise<Object>}
 */
async function loadCollegeMatchView(matchId, options = {}) {
  const usesExplicitUser = Object.prototype.hasOwnProperty.call(options, 'user');

  const [current, members] = await Promise.all([getCurrentUser(), getMembers()]);
  const actor = usesExplicitUser ? options.user : current;

  const records = matchId ? await getMatchRecords({ id: matchId }) : [];
  const record = records && records[0] ? records[0] : null;

  if (!record) {
    // 找不到比赛也要给全「比分行」所需的形状：页面 refresh 会按 bestOf 逐行读
    // scoreA/scoreB 回填输入框，缺了字段会在读下标时抛错，把「找不到」这个
    // 本可以好好展示的提示变成一句「加载失败」。
    return {
      found: false,
      blockReason: '找不到这场比赛',
      matchId: matchId || '',
      teamARows: [],
      teamBRows: [],
      scoreA: [],
      scoreB: [],
      gamePoints: 11,
      bestOf: 1,
    };
  }

  const eventId = record.collegeEventId || '';
  const [event, tieList] = await Promise.all([
    eventId ? getCollegeEvent(eventId) : Promise.resolve(null),
    eventId ? getCollegeTies(eventId) : getCollegeTies(),
  ]);
  const tie = tieList.find((item) => item._id === record.tieId) || null;

  const byId = new Map(members.map((member) => [member._id, member]));
  const nameOfId = (id) => {
    const member = byId.get(id);
    if (!member) return id || '';
    return member.nickName || member.realName || id || '';
  };
  const collegeOf = (id) => (byId.get(id) || {}).college || '';
  const rowsOf = (team) =>
    (Array.isArray(team) ? team : []).map((id) => {
      const name = nameOfId(id);
      return { userId: id, nickName: name, avatarText: name ? name.slice(-1) : '?' };
    });

  const role = actor ? actor.role : undefined;
  const college = (actor && actor.college) || '';
  const tag = statusTagOf(record.status, record.action);

  // 待确认时才有「录入 / 确认」可言；生效后要改先撤销（与比赛页同口径）
  const pending = record.status === MATCH_STATUS.PENDING;
  const canRecord = Boolean(pending && actor && canRecordScore(record, actor._id, { role, college, collegeOf }));
  // 【变量名为什么不能叫 canConfirm / canRevoke】它们与上面从 match-record.js
  // 导入的函数同名。同名 const 在自己的初始化表达式里会撞上暂时性死区：闸门
  // 一旦为真（待确认、有胜方、已登录），求值到 canConfirm(...) 时就抛
  // ReferenceError，整页加载失败。换个名字，调用才是调用。
  const canConfirmNow = Boolean(pending && record.winner && actor && canConfirm(record, actor._id, { isMock: isMockNow(), role }));
  const canRevokeNow = Boolean(actor && canRevoke(record, actor._id, { role }));

  const leg = tie ? (Array.isArray(tie.legs) ? tie.legs : []).find((item) => Number(item.legNo) === Number(record.legNo)) : null;
  const legSettled = Boolean(leg && leg.winner);
  const canForfeit = Boolean(
    actor &&
      canManageCollegeEvent(actor) &&
      tie &&
      tie.status === TIE_STATUS.ONGOING &&
      !legSettled &&
      record.status !== MATCH_STATUS.ACTIVE
  );

  // 大场指派的裁判会随开赛铺到小场（见 college-tie.buildLegMatchDrafts），
  // 权限判定只看小场自己，所以这里能直接把「谁执法」摊平给页面
  const officiated = hasReferee(record);
  const refereeName = officiated ? nameOfId(record.referee) : '';
  const isRefereeSelf = Boolean(officiated && actor && actor._id === record.referee);
  const refereeRestricted = Boolean(officiated && !isRefereeSelf && !canManageCollegeEvent(actor));

  const doubles = isDoublesDiscipline(record.discipline);
  const winnerSide = record.winner || null;
  // 只有 mock 放宽才能确认、严格口径却不行时，才需要提示「这是演示口径」
  const relaxed =
    Boolean(canConfirmNow && actor) &&
    !canConfirm(record, actor._id, { isMock: false, role });

  return {
    found: true,
    blockReason: '',
    matchId: record._id,
    tieId: record.tieId || '',
    legNo: Number(record.legNo) || 0,
    eventId,
    title: event ? event.title || '' : '',
    roundText: tie ? `第 ${tie.round} 轮` : '',
    legNoText: record.legNo ? `第 ${record.legNo} 场` : '',
    disciplineLabel: LEG_DISCIPLINE_LABEL[record.discipline] || record.discipline || '',
    matchTypeLabel: MATCH_TYPE_LABEL[record.matchType] || '',
    collegeA: tie ? tie.collegeA || '' : '',
    collegeB: tie ? tie.collegeB || '' : '',
    teamARows: rowsOf(record.teamA),
    teamBRows: rowsOf(record.teamB),
    scoreText: formatScore(record.scoreA, record.scoreB),
    scoreA: Array.isArray(record.scoreA) ? record.scoreA.map((v) => (v === null || v === undefined ? '' : String(v))) : [],
    scoreB: Array.isArray(record.scoreB) ? record.scoreB.map((v) => (v === null || v === undefined ? '' : String(v))) : [],
    gamePoints: Number(record.gamePoints) || 11,
    bestOf: Number(record.bestOf) || 1,
    formatText: formatMatchFormat({ gamePoints: record.gamePoints, bestOf: record.bestOf }),
    matchTimeText: formatDateTime(record.matchTime),
    location: record.location || '',
    status: record.status,
    statusLabel: tag.label,
    statusClass: tag.className,
    // 模板里的标签样式（app.wxss 的 .tag-*），与 is-* 状态类分开命名
    statusTagClass:
      record.status === MATCH_STATUS.PENDING
        ? 'tag-warning'
        : record.status === MATCH_STATUS.ACTIVE
          ? 'tag-success'
          : 'tag-gray',
    statusReason: record.reason || '',
    isForfeit: record.outcome === MATCH_OUTCOME.FORFEIT,
    forfeitBy: record.forfeitBy || '',
    forfeitText: record.outcome === MATCH_OUTCOME.FORFEIT ? `${record.forfeitBy || '一方'} 弃权` : '',
    winnerSide,
    winnerText:
      winnerSide === 'A'
        ? `${tie ? tie.collegeA : 'A 队'} 胜`
        : winnerSide === 'B'
          ? `${tie ? tie.collegeB : 'B 队'} 胜`
          : '',
    needsScore: needsScore(record),
    canRecord,
    canConfirm: canConfirmNow,
    canRevoke: canRevokeNow,
    canForfeit,
    isDoubles: doubles,
    // 裁判：本小场由谁执法；不是他本人、又不是管理员时，录入被收口，得说清
    hasReferee: officiated,
    refereeName,
    refereeRestricted,
    refereeNotice: refereeRestricted
      ? `本场由 ${refereeName} 裁判执法，仅裁判与管理员可录入比分`
      : '',
    // 单打小场立刻计个人 ELO（一级 K）；双打小场只汇总大场，不动个人分
    eloHint: doubles
      ? '双打小场只决定大场胜负，不改变任何人的个人等级分'
      : '单打小场确认后，个人等级分立刻更新',
    demoNotice: relaxed
      ? '当前为演示数据源：只要参与过这场比赛就可以确认比分，正式环境需由对手确认'
      : '',
  };
}

module.exports = {
  loadCollegeEntryView,
  loadCollegeEntryReviewView,
  loadCollegeEventDetailView,
  loadCollegeLineupView,
  loadCollegeMatchView,
  loadCollegePlacementView,
  buildSeedRows,
  // 供页面展示替补口径时复用，避免页面各自去 require 纯模块
  remainingMemberIds,
};
