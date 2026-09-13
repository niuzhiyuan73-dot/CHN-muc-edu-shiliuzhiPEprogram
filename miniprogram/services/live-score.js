/**
 * 实时比分状态机
 * ============================================================
 * 一场比赛从「逐球累计」到「整场定稿」的全部纯逻辑都住在这里：
 * 判一球、撤一球、重算进度、转正式比分。不碰 wx、不碰数据源，
 * 因此三端共用同一份实现（经 lib/ 镜像被云端复用）。
 *
 * 【逐球流水是唯一事实】
 * 与「比分是唯一事实来源」同一纪律：整场的当前分、局数、第几局，
 * 全部由 rallies 现算出来，绝不单独维护一份可漂移的计数。写库时
 * 也把这些派生字段一起存下来，只是为了轮询时读得轻——真出了分歧，
 * rallies 说了算（derive 一遍即回到一致）。
 *
 * 【一球怎么算一局】
 * 沿用 utils/match-format.js 的口径：够分且领先 2 分才算赢下一局，
 * 不封顶。11 分制可以是 13:11，也可以一直打到 17:15。局数过半
 * （gamesToWin）即整场结束。
 *
 * 【为什么每球不 bumpSeason】
 * 实时态是录分过程的中间态，不是回放的输入。只有定稿（finishLiveScore）
 * 转成正式比分走 submitMatch 时才让赛季版本号 +1，整季才重放一次。
 * ============================================================
 */

const { MATCH_COMPETITION } = require('../utils/constants.js');
const { gamesToWin, isValidFormat, DEFAULT_FORMAT } = require('../utils/match-format.js');

/** 实时态状态 */
const LIVE_STATUS = {
  LIVE: 'live',
  FINISHED: 'finished',
};

/** 判球方向 */
const SIDE = {
  A: 'A',
  B: 'B',
};

/**
 * 实时态的主键。一场比赛恒一条，重启不堆记录。
 * @param {string} matchId
 * @returns {string}
 */
function liveKey(matchId) {
  return `ls_${matchId}`;
}

/**
 * 归一赛制。比赛记录上的赛制理应是合法的，但历史数据 / 脏数据兜一层，
 * 免得一局都算不出来。
 * @param {Object} match
 * @returns {{gamePoints:number, bestOf:number}}
 */
function formatOf(match) {
  const format = { gamePoints: match && match.gamePoints, bestOf: match && match.bestOf };
  if (!isValidFormat(format)) return { ...DEFAULT_FORMAT };
  return format;
}

/**
 * 由一场比赛生成初始实时态。
 *
 * @param {Object} match 比赛记录（含 teamA / teamB / 赛制；学院赛小场另带学院等）
 * @param {Object} [ctx]
 * @param {string} [ctx.actorId] 开台人
 * @param {Date} [ctx.now]
 * @returns {Object} 初始实时态
 */
function createLive(match, ctx = {}) {
  const { actorId = '', now = new Date() } = ctx;
  const format = formatOf(match);
  const isCollege = Boolean(match) && match.competition === MATCH_COMPETITION.COLLEGE;

  return {
    _id: liveKey(match._id),
    matchId: match._id,
    // personal | college —— 查看端据此决定显示学院名还是队员姓名
    competition: isCollege ? 'college' : 'personal',
    eventId: match.eventId || '',
    collegeEventId: match.collegeEventId || '',
    tieId: match.tieId || '',
    legNo: match.legNo === undefined || match.legNo === null ? null : match.legNo,
    discipline: match.discipline || '',
    collegeA: match.collegeA || '',
    collegeB: match.collegeB || '',
    // 查看端要显示姓名，这里只存编号，由调用方解析
    teamA: Array.isArray(match.teamA) ? [...match.teamA] : [],
    teamB: Array.isArray(match.teamB) ? [...match.teamB] : [],
    gamePoints: format.gamePoints,
    bestOf: format.bestOf,
    status: LIVE_STATUS.LIVE,
    gameIndex: 0,
    pointsA: 0,
    pointsB: 0,
    gamesA: 0,
    gamesB: 0,
    // 逐球流水：既是撤销依据，也是审计。id 用于幂等去重（可空）
    rallies: [],
    updatedBy: actorId,
    updatedAt: now,
    startedAt: now,
  };
}

/**
 * 一局是否已经分出胜负：够分且领先 2 分。
 * @param {number} points
 * @param {number} other
 * @param {number} gamePoints
 * @returns {boolean}
 */
function gameWon(points, other, gamePoints) {
  return points >= gamePoints && points - other >= 2;
}

/**
 * 从逐球流水重算整场进度。
 *
 * 【为什么每次判球都整条重算】
 * 流水很短（一场至多一两百球），重算比维护一堆增量计数更不容易错。
 * 更关键的是：撤销一球之后，状态必须与「从没判过那一球」完全一致——
 * 重算天然满足，增量更新迟早会留下残影。
 *
 * @param {Array<Object>} rallies 逐球流水 [{ g, side, id? }]
 * @param {Object} format { gamePoints, bestOf }
 * @returns {{gameIndex:number, pointsA:number, pointsB:number, gamesA:number, gamesB:number, games:Array<{a:number,b:number}>, finished:boolean}}
 */
function replayRallies(rallies, format) {
  const list = Array.isArray(rallies) ? rallies : [];
  const gamePoints = format.gamePoints;
  const need = gamesToWin(format.bestOf);

  let pointsA = 0;
  let pointsB = 0;
  let gamesA = 0;
  let gamesB = 0;
  let gameIndex = 0;
  let finished = false;
  const games = [];

  for (const rally of list) {
    // 分出胜负之后的球不再计（脏数据 / 连点兜底），避免出现「赢完还在加分」
    if (finished) break;
    const side = rally && rally.side;
    if (side !== SIDE.A && side !== SIDE.B) continue;
    if (side === SIDE.A) pointsA += 1;
    else pointsB += 1;

    const aWon = gameWon(pointsA, pointsB, gamePoints);
    const bWon = gameWon(pointsB, pointsA, gamePoints);
    if (!aWon && !bWon) continue;

    if (aWon) gamesA += 1;
    else gamesB += 1;
    games.push({ a: pointsA, b: pointsB });
    // 记一局、进下一局
    pointsA = 0;
    pointsB = 0;
    gameIndex += 1;

    if (gamesA >= need || gamesB >= need) finished = true;
  }

  return { gameIndex, pointsA, pointsB, gamesA, gamesB, games, finished };
}

/** 把重算结果摊成实时态里的派生字段 */
function derivedFields(progress) {
  return {
    gameIndex: progress.gameIndex,
    pointsA: progress.pointsA,
    pointsB: progress.pointsB,
    gamesA: progress.gamesA,
    gamesB: progress.gamesB,
    status: progress.finished ? LIVE_STATUS.FINISHED : LIVE_STATUS.LIVE,
  };
}

/**
 * 判一球：+1 分；够分且领先 2 → 记一局、进下一局；局数过半 → finished。
 *
 * @param {Object} state 当前实时态
 * @param {'A'|'B'} side 这一球判给谁
 * @param {Object} [options]
 * @param {string} [options.rallyId] 客户端生成的一球编号，用于服务端幂等去重
 * @returns {Object} 新的实时态（不改原对象）
 */
function applyRally(state, side, options = {}) {
  if (!state || (side !== SIDE.A && side !== SIDE.B)) return state;
  const rallyId = options.rallyId ? String(options.rallyId) : '';
  const rally = { g: state.gameIndex, side };
  if (rallyId) rally.id = rallyId;

  const rallies = [...(state.rallies || []), rally];
  return { ...state, rallies, ...derivedFields(replayRallies(rallies, state)) };
}

/**
 * 撤销最后一球（弹 rallies 尾部并重算）。
 * 若撤销的是决定性的那一球，整场随即退回「进行中」。
 *
 * @param {Object} state 当前实时态
 * @returns {Object} 新的实时态；没有可撤销的球时原样返回
 */
function undoRally(state) {
  const rallies = state && Array.isArray(state.rallies) ? state.rallies : [];
  if (rallies.length === 0) return state;
  const next = rallies.slice(0, -1);
  return { ...state, rallies: next, ...derivedFields(replayRallies(next, state)) };
}

/**
 * 这一球是不是已经记过（幂等去重）。
 * 断线重发 / 连点会给同一个 rallyId 发两次，服务端据此判重。
 *
 * @param {Object} state
 * @param {string} rallyId
 * @returns {boolean}
 */
function hasRally(state, rallyId) {
  const id = rallyId ? String(rallyId) : '';
  if (!id || !state) return false;
  return (state.rallies || []).some((rally) => rally && rally.id === id);
}

/**
 * 给查看端的视图模型。
 *
 * 只给「看比分」需要的字段：当前局比分、局数、第几局、谁领先、是否结束。
 * 不吐逐球流水——查看端不需要，也省流量（轮询每 2 秒一次）。
 *
 * @param {Object} state
 * @returns {Object|null}
 */
function liveScoreOf(state) {
  if (!state) return null;
  const finished = state.status === LIVE_STATUS.FINISHED;
  return {
    matchId: state.matchId,
    pointsA: state.pointsA,
    pointsB: state.pointsB,
    gamesA: state.gamesA,
    gamesB: state.gamesB,
    gameIndex: state.gameIndex,
    status: state.status,
    finished,
    // 谁领先，供查看端高亮；平局为 ''
    leading: state.pointsA === state.pointsB ? '' : state.pointsA > state.pointsB ? SIDE.A : SIDE.B,
    gamePoints: state.gamePoints,
    bestOf: state.bestOf,
    // 定稿后写回正式比分，查看端可据此显示终局
    updatedAt: state.updatedAt || null,
  };
}

/**
 * 定稿：把逐球流水转成正式比分数组，交给现有的 fillScheduledMatch / submitMatch。
 *
 * 只取「打完的局」——进行中的那一局（还有分没打完）不该进正式比分，
 * 否则 11:9 11:5 会被写成 11:9 5:2 这种没有胜负的半局。
 *
 * @param {Object} state
 * @returns {{scoreA:number[], scoreB:number[]}}
 */
function toOfficialScores(state) {
  if (!state) return { scoreA: [], scoreB: [] };
  const { games } = replayRallies(state.rallies, state);
  return {
    scoreA: games.map((game) => game.a),
    scoreB: games.map((game) => game.b),
  };
}

module.exports = {
  LIVE_STATUS,
  SIDE,
  liveKey,
  createLive,
  gameWon,
  replayRallies,
  applyRally,
  undoRally,
  hasRally,
  liveScoreOf,
  toOfficialScores,
};
