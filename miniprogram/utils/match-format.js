/**
 * 比赛赛制与比分校验
 * ============================================================
 * 一场比赛要记两件事：每局打到多少分、几局定胜负。
 *
 *   分制 gamePoints：11 / 15 / 21
 *   局制 bestOf：    1 / 3 / 5（一局一胜 / 三局两胜 / 五局三胜）
 *
 * 【胜负判定：先到目标分且领先 2 分，不封顶】
 * 这是匹克球的标准规则，也是本项目的口径。因此校验时绝不能写
 * 「胜方必须正好等于 11」——11 分制本来就可以打成 13:11、15:13，
 * 21 分制能出现 23:21。正确判据只有两条：
 *   1. 胜方分数 >= 目标分
 *   2. 胜方领先至少 2 分
 * 于是 11:9、12:10、13:11、17:15 都合法，而 11:10 和 10:8 都不合法。
 *
 * 【为什么校验要写这么细】
 * 比分是唯一的事实来源，等级分、积分、排名全部由它推导。
 * 一个录错的比分（比如 11:10 这种没打完的局）会污染整条链路，
 * 而且事后很难发现。宁可在录入时被拦下来。
 * ============================================================
 */

/** 可选分制 */
const GAME_POINTS_OPTIONS = [11, 15, 21];

/** 可选局制 */
const BEST_OF_OPTIONS = [1, 3, 5];

/** 局制文案 */
const BEST_OF_LABEL = {
  1: '一局一胜',
  3: '三局两胜',
  5: '五局三胜',
};

/** 默认赛制：11 分制三局两胜，业余比赛最常用 */
const DEFAULT_FORMAT = { gamePoints: 11, bestOf: 3 };

/**
 * 赢下整场需要拿下的局数。
 * 单数局制取一半向上取整：3 局需 2 胜，5 局需 3 胜，1 局需 1 胜。
 *
 * @param {number} bestOf
 * @returns {number}
 */
function gamesToWin(bestOf) {
  return Math.ceil(bestOf / 2);
}

/**
 * 赛制是否受支持。
 * @param {Object} format
 * @returns {boolean}
 */
function isValidFormat(format) {
  return Boolean(
    format &&
      GAME_POINTS_OPTIONS.includes(format.gamePoints) &&
      BEST_OF_OPTIONS.includes(format.bestOf)
  );
}

/**
 * 组装一个赛制对象，顺带校验。
 * @param {number} gamePoints
 * @param {number} bestOf
 * @returns {{gamePoints:number, bestOf:number, gamesToWin:number}}
 * @throws {Error} 分制或局制不受支持时抛出
 */
function createMatchFormat(gamePoints = DEFAULT_FORMAT.gamePoints, bestOf = DEFAULT_FORMAT.bestOf) {
  const format = { gamePoints, bestOf };
  if (!isValidFormat(format)) {
    throw new Error(
      `不支持的赛制：${gamePoints} 分制 / ${bestOf} 局制。` +
        `分制只能是 ${GAME_POINTS_OPTIONS.join('、')}，局制只能是 ${BEST_OF_OPTIONS.join('、')}`
    );
  }
  return { ...format, gamesToWin: gamesToWin(bestOf) };
}

/**
 * 赛制文案：11 分制 · 三局两胜
 * @param {Object} format
 * @returns {string}
 */
function formatMatchFormat(format) {
  if (!isValidFormat(format)) return '';
  return `${format.gamePoints} 分制 · ${BEST_OF_LABEL[format.bestOf]}`;
}

/**
 * 校验单独一局的比分。
 *
 * @param {number} mine
 * @param {number} theirs
 * @param {number} gamePoints
 * @param {number} index 局序号（从 0 开始），仅用于错误提示
 * @returns {string[]} 错误信息，空数组表示合法
 */
function validateGame(mine, theirs, gamePoints, index) {
  const label = `第 ${index + 1} 局`;

  if (!Number.isInteger(mine) || !Number.isInteger(theirs)) {
    return [`${label}的比分必须是整数`];
  }
  if (mine < 0 || theirs < 0) {
    return [`${label}的比分不能是负数`];
  }
  if (mine === theirs) {
    return [`${label}必须分出胜负，不能打平（${mine}:${theirs}）`];
  }

  const high = Math.max(mine, theirs);
  const low = Math.min(mine, theirs);

  // 先判有没有人够分，再判分差。反过来的话，「10:8」会被报成
  // 「领先不足 2 分」，而真正的问题是这局根本没打到 11 分。
  if (high < gamePoints) {
    return [`${label}没有人打到 ${gamePoints} 分（${mine}:${theirs}）`];
  }
  if (high - low < 2) {
    return [`${label}胜方必须领先 2 分（${mine}:${theirs}）`];
  }

  return [];
}

/**
 * 逐局比对，判断每局谁赢。
 * @param {number[]} scoreA
 * @param {number[]} scoreB
 * @returns {Array<boolean|null>} true 表示 A 队赢下该局，null 表示比分为平（非法）
 */
function gameWinners(scoreA, scoreB) {
  return scoreA.map((value, index) => {
    if (value === scoreB[index]) return null;
    return value > scoreB[index];
  });
}

/**
 * 校验整场比分，并给出胜方。
 *
 * @param {number[]} scoreA A 队逐局得分
 * @param {number[]} scoreB B 队逐局得分
 * @param {Object} format { gamePoints, bestOf }
 * @returns {{valid:boolean, errors:string[], winner:'A'|'B'|null, gamesA:number, gamesB:number}}
 *
 * @example
 * validateMatchScore([11, 9, 11], [9, 11, 9], { gamePoints: 11, bestOf: 3 });
 * // => { valid: true, errors: [], winner: 'A', gamesA: 2, gamesB: 1 }
 */
function validateMatchScore(scoreA, scoreB, format) {
  const empty = { valid: false, errors: [], winner: null, gamesA: 0, gamesB: 0 };

  if (!isValidFormat(format)) {
    return { ...empty, errors: ['赛制不合法，无法校验比分'] };
  }
  if (!Array.isArray(scoreA) || !Array.isArray(scoreB)) {
    return { ...empty, errors: ['比分必须是数组'] };
  }
  if (scoreA.length === 0) {
    return { ...empty, errors: ['至少要录入 1 局比分'] };
  }
  if (scoreA.length !== scoreB.length) {
    return { ...empty, errors: [`两队局数不一致（${scoreA.length} 局对 ${scoreB.length} 局）`] };
  }

  const need = gamesToWin(format.bestOf);
  const errors = [];

  if (scoreA.length > format.bestOf) {
    errors.push(`${BEST_OF_LABEL[format.bestOf]}最多打 ${format.bestOf} 局，当前录了 ${scoreA.length} 局`);
  }

  // 每局单独校验
  scoreA.forEach((value, index) => {
    errors.push(...validateGame(value, scoreB[index], format.gamePoints, index));
  });

  const winners = gameWinners(scoreA, scoreB);
  const gamesA = winners.filter((w) => w === true).length;
  const gamesB = winners.filter((w) => w === false).length;

  if (gamesA !== need && gamesB !== need) {
    errors.push(
      `${BEST_OF_LABEL[format.bestOf]}需要有一方赢下 ${need} 局才能结束，当前 ${gamesA} : ${gamesB}`
    );
  } else {
    // 已经分出胜负，那么决定性的那一局必须是最后一局。
    // 否则就是录多了——比如三局两胜录成 11:9 11:9 11:9，
    // 第三局开打前比赛其实已经结束了。
    let reachedA = 0;
    let reachedB = 0;
    let decisive = -1;
    for (let i = 0; i < winners.length; i += 1) {
      if (winners[i] === true) reachedA += 1;
      if (winners[i] === false) reachedB += 1;
      if (reachedA === need || reachedB === need) {
        decisive = i;
        break;
      }
    }

    if (decisive !== winners.length - 1) {
      const extra = winners.length - decisive - 1;
      errors.push(
        `比赛在第 ${decisive + 1} 局就已分出胜负，多录了 ${extra} 局`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    winner: gamesA > gamesB ? 'A' : gamesB > gamesA ? 'B' : null,
    gamesA,
    gamesB,
  };
}

module.exports = {
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  BEST_OF_LABEL,
  DEFAULT_FORMAT,
  gamesToWin,
  isValidFormat,
  createMatchFormat,
  formatMatchFormat,
  validateGame,
  gameWinners,
  validateMatchScore,
};
