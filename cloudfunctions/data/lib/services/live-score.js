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
const {
  gamesToWin,
  scoringOf,
  normalizeTennisFormat,
  formatOfRecord,
  tennisGameWon,
  tennisSetWon,
  SCORING,
  DEFAULT_FORMAT,
  DEFAULT_TENNIS_FORMAT,
} = require('../utils/match-format.js');

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
 *
 * 网球记录没有 gamePoints（一局恒定 4 分），硬套 11 分制会把 6:4 读成
 * 「没人打到 11 分」，一场都算不出来——所以必须按 scoring 分开兜。
 *
 * @param {Object} match
 * @returns {Object} point：{gamePoints,bestOf}；tennis：{scoring:'tennis',bestOf,setGames,…}
 */
function formatOf(match) {
  // 计分台必须有确定的赛制才能推进（不像展示层可以把「没记赛制」显示成空）。
  // formatOfRecord 对老数据返回 null，这里按个人赛默认赛制 11 分制 / 三局两胜兜底。
  if (match && match.scoring === SCORING.TENNIS) {
    return formatOfRecord(match) || { ...DEFAULT_TENNIS_FORMAT };
  }
  return formatOfRecord(match) || { ...DEFAULT_FORMAT };
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
    // 赛制整块落在实时态上：重算只看这一份，不必再回查比赛记录
    ...(scoringOf(format) === 'tennis'
      ? {
          scoring: 'tennis',
          bestOf: format.bestOf,
          setGames: format.setGames,
          tiebreakAt: format.tiebreakAt,
          tiebreakPoints: format.tiebreakPoints,
          noAd: format.noAd === true,
        }
      : { gamePoints: format.gamePoints, bestOf: format.bestOf }),
    status: LIVE_STATUS.LIVE,
    gameIndex: 0,
    // 网球的盘序号与盘数；其余项目恒 0，展示端不看它们
    setIndex: 0,
    setsA: 0,
    setsB: 0,
    inTiebreak: false,
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
 * 一局是否已经分出胜负（point 体系）：够分且领先 2 分。
 * @param {number} points
 * @param {number} other
 * @param {number} gamePoints
 * @returns {boolean}
 */
function gameWon(points, other, gamePoints) {
  return points >= gamePoints && points - other >= 2;
}

/**
 * point 体系（匹克球 / 乒乓 / 羽毛球）的重算：分 → 局 → 场，两级。
 *
 * 【为什么每次判球都整条重算】
 * 流水很短（一场至多一两百球），重算比维护一堆增量计数更不容易错。
 * 更关键的是：撤销一球之后，状态必须与「从没判过那一球」完全一致——
 * 重算天然满足，增量更新迟早会留下残影。
 *
 * 【为什么「打完最后一局」与「打完中间某一局」要分开处理】
 * 中间某一局打完，确实该清零并进下一局。最后一局打完却不同：没有「下一局」
 * 可进，那一局就是终局。若不分青红皂白地清零 +1，定稿前后的查看端会看到
 * 「已结束 · 第 4 局 · 0 : 0」——比分归零、局数凭空多一局，真正的终局比分
 * 反而被抹掉。所以整场结束时就停在末局：分数不清、局数不增。
 *
 * @param {Array<Object>} rallies 逐球流水 [{ g, side, id? }]
 * @param {Object} format { gamePoints, bestOf }
 * @returns {{gameIndex:number, pointsA:number, pointsB:number, gamesA:number, gamesB:number, games:Array<{a:number,b:number}>, finished:boolean}}
 */
function replayPointRallies(rallies, format) {
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

    // 整场打完就收手：停在末局（分数不清零、局数不再 +1，见上面说明），
    // 后面的球一律不再计——脏数据 / 连点会往流水里塞进「赢完还在加分」的球。
    if (gamesA >= need || gamesB >= need) {
      finished = true;
      break;
    }

    // 记一局、进下一局
    pointsA = 0;
    pointsB = 0;
    gameIndex += 1;
  }

  return { gameIndex, pointsA, pointsB, gamesA, gamesB, games, finished };
}

/**
 * 网球的重算：分 → 局 → 盘 → 场，三级。
 *
 * 与 point 体系的两处关键差异：
 *   1. 一局恒定 4 分（40:40 需连得 2；noAd 时下一分直接定胜负）；
 *   2. 一盘到 6 局且领先 2 局，6:6 进抢七（短盘 4:4），抢七胜者以 7:6 拿下该盘。
 * 抢七那一路必须单独判：它一结束就直接是一盘的终点，不会再回到普通的「局」。
 *
 * 返回的 gamesA / gamesB 是**当前盘**的局数，setsA / setsB 才是赢下的盘数。
 * 展示端要的是「盘分 + 本盘局分 + 本局分」，三者分别对应 sets / games / points。
 *
 * @param {Array<Object>} rallies
 * @param {Object} format 网球赛制
 * @returns {{gameIndex:number, setIndex:number, pointsA:number, pointsB:number,
 *            gamesA:number, gamesB:number, setsA:number, setsB:number,
 *            games:Array<Object>, sets:Array<Object>, tiebreaks:Array<Object>,
 *            inTiebreak:boolean, finished:boolean}}
 */
function replayTennisRallies(rallies, format) {
  const list = Array.isArray(rallies) ? rallies : [];
  const cfg = normalizeTennisFormat(format) || { ...DEFAULT_TENNIS_FORMAT };
  const need = gamesToWin(cfg.bestOf);

  let pointsA = 0;
  let pointsB = 0;
  let gamesA = 0;
  let gamesB = 0;
  let setsA = 0;
  let setsB = 0;
  let gameIndex = 0;
  let setIndex = 0;
  let inTiebreak = false;
  let finished = false;
  const games = [];
  const sets = [];
  const tiebreaks = [];

  /** 收下一盘：记盘比分、盘数 +1，并判断整场是否结束 */
  const closeSet = () => {
    sets.push({ a: gamesA, b: gamesB });
    if (gamesA > gamesB) setsA += 1;
    else setsB += 1;
    return setsA >= need || setsB >= need;
  };

  for (const rally of list) {
    const side = rally && rally.side;
    if (side !== SIDE.A && side !== SIDE.B) continue;
    if (side === SIDE.A) pointsA += 1;
    else pointsB += 1;

    // —— 抢七：分先到 7 且领先 2，胜者直接拿下这一局与这一盘 ——
    if (inTiebreak) {
      const aWon = pointsA >= cfg.tiebreakPoints && pointsA - pointsB >= 2;
      const bWon = pointsB >= cfg.tiebreakPoints && pointsB - pointsA >= 2;
      if (!aWon && !bWon) continue;

      if (aWon) gamesA += 1;
      else gamesB += 1;
      tiebreaks.push({ setIndex, a: pointsA, b: pointsB });
      games.push({ a: pointsA, b: pointsB, tiebreak: true });
      inTiebreak = false;
      pointsA = 0;
      pointsB = 0;

      finished = closeSet();
      if (finished) break;
      gamesA = 0;
      gamesB = 0;
      gameIndex = 0;
      setIndex += 1;
      continue;
    }

    const aWon = tennisGameWon(pointsA, pointsB, cfg.noAd);
    const bWon = tennisGameWon(pointsB, pointsA, cfg.noAd);
    if (!aWon && !bWon) continue;

    games.push({ a: pointsA, b: pointsB });
    if (aWon) gamesA += 1;
    else gamesB += 1;
    pointsA = 0;
    pointsB = 0;

    // 6:6（短盘 4:4）进抢七：这一局先不计入盘比分，抢七打完直接定盘
    if (gamesA === cfg.setGames && gamesB === cfg.setGames) {
      inTiebreak = true;
      continue;
    }

    const setDone = tennisSetWon(gamesA, gamesB, cfg.setGames) || tennisSetWon(gamesB, gamesA, cfg.setGames);
    if (!setDone) {
      gameIndex += 1;
      continue;
    }

    finished = closeSet();
    if (finished) break;
    gamesA = 0;
    gamesB = 0;
    gameIndex = 0;
    setIndex += 1;
  }

  return {
    gameIndex,
    setIndex,
    pointsA,
    pointsB,
    gamesA,
    gamesB,
    setsA,
    setsB,
    games,
    sets,
    tiebreaks,
    inTiebreak,
    finished,
  };
}

/**
 * 从逐球流水重算整场进度。按实时态自带的赛制分派到两套体系。
 *
 * @param {Array<Object>} rallies
 * @param {Object} format 实时态本身（含 gamePoints 或 scoring）
 * @returns {Object} 见 replayPointRallies / replayTennisRallies
 */
function replayRallies(rallies, format) {
  if (scoringOf(format) === 'tennis') return replayTennisRallies(rallies, format);
  return replayPointRallies(rallies, format);
}

/** 把重算结果摊成实时态里的派生字段 */
function derivedFields(progress) {
  const fields = {
    gameIndex: progress.gameIndex,
    pointsA: progress.pointsA,
    pointsB: progress.pointsB,
    gamesA: progress.gamesA,
    gamesB: progress.gamesB,
    status: progress.finished ? LIVE_STATUS.FINISHED : LIVE_STATUS.LIVE,
  };
  // 网球多两级：盘数与本盘序号。point 体系不写这些字段，
  // 免得老记录上凭空多出几个恒为 0 的键。
  if (progress.sets) {
    fields.setIndex = progress.setIndex;
    fields.setsA = progress.setsA;
    fields.setsB = progress.setsB;
    fields.inTiebreak = progress.inTiebreak === true;
  }
  return fields;
}

/** 一局之内 0/15/30/40 的文案（网球） */
const TENNIS_POINT_TEXT = ['0', '15', '30', '40'];

/**
 * 把一局之内的原始球数翻成网球分数。
 *
 * 40:40 之后是占先（AD）：一方领先 1 分显示 AD，另一方仍显示 40；
 * 无占先（noAd）没有占先态，双方都显示 40，下一分直接定胜负。
 * 抢七不做这个换算——抢七就是数分，7:5、9:7 直接显示数字。
 *
 * @param {number} points
 * @param {number} other
 * @param {Object} [options]
 * @param {boolean} [options.noAd]
 * @param {boolean} [options.tiebreak]
 * @returns {string}
 */
function tennisPointText(points, other, options = {}) {
  if (options.tiebreak) return String(points);
  if (points >= 3 && other >= 3) {
    if (points === other) return '40';
    if (points === other + 1) return options.noAd ? '40' : 'AD';
    return '40';
  }
  return TENNIS_POINT_TEXT[Math.min(points, 3)];
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
 * 这份实时态是不是已经定稿（正式比分已经交出去了）。
 *
 * 【为什么需要一个标记，而不是看状态】
 * 「整场打完」（status = finished）与「定稿交分」隔着一段时间：打完还能
 * 撤掉制胜那一球重来，这是正常的临场更正。定稿之后再撤就不同了——正式
 * 比分已经写进比赛记录，此时把实时态退回「进行中」，查看端会看到一场
 * 还没打完的比赛，而备战表里它已经有成绩了。两者各说各话，且比赛一旦
 * 被对手确认（status 转已生效），实时台就永远停在「进行中」再也定不了稿。
 * 所以定稿那一刻在实时态上盖个章，之后只读。
 *
 * @param {Object} state
 * @returns {boolean}
 */
function isFinalized(state) {
  return Boolean(state && state.finalizedAt);
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
  const isTennis = state.scoring === 'tennis';
  const tiebreak = isTennis && state.inTiebreak === true;
  const noAd = state.noAd === true;

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
    // —— 网球专属 ——
    // 大比分是「盘」，gamesA/gamesB 退化为「本盘局分」，points 退化为「本局分」
    scoring: isTennis ? 'tennis' : 'point',
    setsA: isTennis ? state.setsA || 0 : 0,
    setsB: isTennis ? state.setsB || 0 : 0,
    setIndex: isTennis ? state.setIndex || 0 : 0,
    inTiebreak: tiebreak,
    noAd,
    pointTextA: isTennis ? tennisPointText(state.pointsA, state.pointsB, { noAd, tiebreak }) : String(state.pointsA),
    pointTextB: isTennis ? tennisPointText(state.pointsB, state.pointsA, { noAd, tiebreak }) : String(state.pointsB),
    // 定稿后写回正式比分，查看端可据此显示终局
    updatedAt: state.updatedAt || null,
  };
}

/**
 * 定稿：把逐球流水转成正式比分，交给现有的 fillScheduledMatch / submitMatch。
 *
 * 只取「打完的单元」——进行中的那一局（还有分没打完）不该进正式比分，
 * 否则 11:9 11:5 会被写成 11:9 5:2 这种没有胜负的半局。
 *
 * 网球取的是**盘**（不是局）：scoreA = [6, 7] 这样的每盘局数。
 * 抢七小分另出一份 tiebreaks，用来还原 7:6(5) 里的括号。
 *
 * @param {Object} state
 * @returns {{scoreA:number[], scoreB:number[], tiebreaks?:Array<Object>}}
 */
function toOfficialScores(state) {
  if (!state) return { scoreA: [], scoreB: [] };
  const progress = replayRallies(state.rallies, state);

  if (state.scoring === 'tennis') {
    return {
      scoreA: progress.sets.map((set) => set.a),
      scoreB: progress.sets.map((set) => set.b),
      tiebreaks: progress.tiebreaks.map((item) => ({ ...item })),
    };
  }

  return {
    scoreA: progress.games.map((game) => game.a),
    scoreB: progress.games.map((game) => game.b),
  };
}

module.exports = {
  LIVE_STATUS,
  SIDE,
  liveKey,
  createLive,
  formatOf,
  gameWon,
  replayRallies,
  replayPointRallies,
  replayTennisRallies,
  applyRally,
  undoRally,
  hasRally,
  isFinalized,
  liveScoreOf,
  tennisPointText,
  toOfficialScores,
};
