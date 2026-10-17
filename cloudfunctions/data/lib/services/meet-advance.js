/**
 * 运动会：预赛晋级与赛制名次（B8a）
 * ============================================================
 * 这里只有纯函数，不碰仓储、不碰事务。原因很直接：晋级与名次是「算数」，
 * 一旦和读写混在一起，就没法用字面量断言「三个人 12.1/12.2/12.3 该谁晋级」。
 * 服务层负责取数、写库，判定全部委托给本模块。
 *
 * 【预赛晋级（D46／D47）】
 * 三种口径都实现，创建项目时逐项选：
 *   per_heat  每组前 N 名晋级；
 *   overall   全部预赛成绩里总排名前 N 名晋级；
 *   hybrid    每组前 n 名直接晋级，再按总成绩补足到 N 名。
 * 晋级边界同分**全部晋级**（D47 已确认），不做抽签、不做加赛：
 *   · 每组前 N 用「组内竞赛排名 ≤ N」判定，并列者名次相同，自然一起进；
 *   · 总成绩前 N 用同样的规则，第 N 与第 N+1 同值时两人都进。
 * 这不是「近似处理」——用竞赛排名（1,2,2,4）表达边界，同分必然同时满足或
 * 同时不满足，不需要额外写一段「扩展并列」的补丁。
 *
 * 【赛制名次（D51）】
 * 单败淘汰的名次由「输在哪一轮」唯一决定：
 *   冠军 1、亚军 2、半决赛负者 3/3、四分之一决赛负者 5/5/5/5……
 * 通式是 `2^(总轮数 - 输的轮次) + 1`，与竞赛排名（1,2,3,3,5,5,5,5）完全一致。
 * 循环赛按胜场排，同胜场先比**组内相互战绩**（小联赛胜场），仍相同才并列。
 *
 * 【为什么不做双败/小组+淘汰】
 * 双败要给每支队伍维护「胜者组/败者组」两条路径，名次还要区分「败者组第几轮
 * 出局」；小组+淘汰要先分组再跨组晋级。两者都不是「加几十行」的量级，而且
 * 学校运动会的拔河几乎都是单败。所以配置时只接受单败与循环，其余赛制当场
 * 拒绝，而不是悄悄按单败跑出一个看起来合理、实际错的名次。
 * ============================================================
 */

const { compareMeasure } = require('./meet-measure.js');

/** 晋级口径。 */
const ADVANCE_MODE = Object.freeze({
  PER_HEAT: 'per_heat',
  OVERALL: 'overall',
  HYBRID: 'hybrid',
});

/** 支持自动名次的赛制（与 utils/constants.js 的 EVENT_FORMAT 同名）。 */
const MEET_FORMAT = Object.freeze({
  SINGLE_ELIM: 'single_elim',
  ROUND_ROBIN: 'round_robin',
});

const FORMAT_LABEL = Object.freeze({
  [MEET_FORMAT.SINGLE_ELIM]: '单败淘汰',
  [MEET_FORMAT.ROUND_ROBIN]: '循环赛',
});

/** 有数值方向的项目（计时/距离/高度/次数/评分）。 */
function rankByValue(rows, order) {
  const sorted = [...rows].sort((a, b) => {
    const compared = compareMeasure(a.value, b.value, order);
    if (compared === null || compared === 0) return 0;
    return compared;
  });
  let lastValue = null;
  let lastRank = 0;
  sorted.forEach((row, index) => {
    if (lastValue !== null && compareMeasure(row.value, lastValue, order) === 0) {
      row.rank = lastRank;
    } else {
      row.rank = index + 1;
      lastValue = row.value;
      lastRank = row.rank;
    }
  });
  return sorted;
}

const isLive = (row) => row && row.status !== 'void' && Number.isFinite(row.value);

/**
 * 由预赛结果算出晋级名单。
 *
 * @param {Object} params
 * @param {Array} params.heats `[{ index, rows: [{ entryKey, value, status }] }]`
 * @param {string} params.mode ADVANCE_MODE
 * @param {number} params.count 晋级总人数（per_heat 时是「每组前 N」）
 * @param {string} params.order 'asc' | 'desc'
 * @returns {{ok:boolean, message?:string, advanced?:Array, perHeat?:Array, heatRanks?:Object}}
 *   advanced 按**总成绩顺序**排列（不是按组），决赛道次可直接用它。
 */
function advanceFromHeats({ heats = [], mode = ADVANCE_MODE.PER_HEAT, count = 1, order } = {}) {
  const target = Number(count);
  if (!Number.isInteger(target) || target < 1) {
    return { ok: false, message: '晋级人数必须是正整数' };
  }
  if (order !== 'asc' && order !== 'desc') {
    return { ok: false, message: '晋级排序方向非法' };
  }
  const list = Array.isArray(heats) ? heats.filter((heat) => heat && Array.isArray(heat.rows)) : [];
  if (list.length === 0) return { ok: false, message: '没有预赛分组' };

  // 组内先排名：并列由竞赛排名自然表达，不需要额外扩展
  const prepared = list.map((heat) => ({
    index: heat.index,
    ranked: rankByValue(heat.rows.filter(isLive).map((row) => ({ ...row })), order),
  }));

  const all = [];
  prepared.forEach((heat) => {
    heat.ranked.forEach((row) => all.push({ ...row, heatIndex: heat.index }));
  });
  if (all.length === 0) return { ok: false, message: '预赛没有任何有效成绩' };

  const globalRanked = rankByValue(all, order);
  const picked = new Set();

  if (mode === ADVANCE_MODE.PER_HEAT) {
    prepared.forEach((heat) => {
      heat.ranked.forEach((row) => {
        if (row.rank <= target) picked.add(row.entryKey);
      });
    });
  } else if (mode === ADVANCE_MODE.OVERALL) {
    globalRanked.forEach((row) => {
      if (row.rank <= target) picked.add(row.entryKey);
    });
  } else if (mode === ADVANCE_MODE.HYBRID) {
    // 每组先取 floor(N / 组数) 人直接晋级，再按总成绩补足到 N。
    // 用 floor 而不是 ceil：ceil 会让「每组前 2」在 N=3、两组时直接进 4 人，
    // 超过约定的晋级人数。N 小于组数时每组一个都不直进，退化成按总成绩取前 N，
    // 这也是「混合晋级」在该情形下唯一说得通的口径。
    const perHeat = Math.floor(target / prepared.length);
    if (perHeat > 0) {
      prepared.forEach((heat) => {
        heat.ranked.forEach((row) => {
          if (row.rank <= perHeat) picked.add(row.entryKey);
        });
      });
    }
    let lastValue;
    for (const row of globalRanked) {
      if (picked.has(row.entryKey)) continue;
      if (picked.size >= target) {
        // 已够人数，但若下一位与刚补进来的人同成绩，仍要一起晋级（D47）
        if (compareMeasure(row.value, lastValue, order) !== 0) break;
      }
      picked.add(row.entryKey);
      lastValue = row.value;
    }
  } else {
    return { ok: false, message: '晋级口径只能是每组前 N、总成绩前 N 或混合晋级' };
  }

  const advanced = globalRanked
    .filter((row) => picked.has(row.entryKey))
    .map((row) => ({
      entryKey: row.entryKey,
      heatIndex: row.heatIndex,
      heatRank: row.rank,
      value: row.value,
    }));

  const perHeat = prepared.map((heat) => ({
    index: heat.index,
    advanced: heat.ranked.filter((row) => picked.has(row.entryKey)).length,
  }));

  return { ok: true, advanced, perHeat, heatRanks: globalRanked };
}

/** 单败淘汰的总轮数：8 人 → 3 轮。 */
function bracketTotalRounds(size) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 2) return 1;
  return Math.max(1, Math.ceil(Math.log2(n)));
}

/** 轮次名称：最后一轮叫决赛，倒数第二轮叫半决赛，其余按序号。 */
function bracketRoundLabel(roundNo, totalRounds) {
  const round = Number(roundNo);
  const total = Number(totalRounds);
  if (round === total) return '决赛';
  if (round === total - 1) return '半决赛';
  return `第 ${round} 轮`;
}

/**
 * 单败淘汰的最终名次。
 *
 * @param {Object} params
 * @param {string[]} params.entries 参赛记录
 * @param {number} params.totalRounds 总轮数
 * @param {Array} params.matches `[{ roundNo, index, entryKeys:[a,b], winnerEntryKey }]`
 * @returns {{ok:boolean, message?:string, rows?:Array, champion?:string, pending?:Array}}
 */
function bracketStandings({ entries = [], totalRounds = 1, matches = [] } = {}) {
  const total = Number(totalRounds) || 1;
  const pending = [];
  const lossRound = new Map();
  let champion = '';

  for (const match of matches) {
    const [a, b] = match.entryKeys || [];
    // 双侧都空是签表补位的空场，不算未决
    if (!a && !b) continue;
    // 有胜负即可判定：轮空场次只有一方（另一方为 null），但它已经有胜者
    if (!match.winnerEntryKey) {
      pending.push({ roundNo: match.roundNo, index: match.index, sessionKey: match.sessionKey || '' });
      continue;
    }
    const loser = match.winnerEntryKey === a ? b : a;
    if (loser) lossRound.set(loser, Number(match.roundNo));
    if (Number(match.roundNo) === total) champion = match.winnerEntryKey;
  }
  if (pending.length > 0) {
    return { ok: false, message: `还有 ${pending.length} 场没有决出胜负`, pending };
  }
  if (!champion) return { ok: false, message: '还没有产生冠军', pending: [] };

  const rows = [];
  for (const entryKey of entries) {
    if (entryKey === champion) {
      rows.push({ entryKey, rank: 1 });
      continue;
    }
    const round = lossRound.get(entryKey);
    // 从未出场（既没赢也没输）不给名次，由调用方按无成绩处理
    if (!round) continue;
    rows.push({ entryKey, rank: Math.pow(2, total - round) + 1 });
  }
  rows.sort((a, b) => a.rank - b.rank || String(a.entryKey).localeCompare(String(b.entryKey)));
  return { ok: true, champion, rows, pending: [] };
}

/**
 * 循环赛对阵表（轮转法）。奇数人补一个空位，轮到空位的人该轮轮空。
 *
 * @param {string[]} entries
 * @returns {Array<Array<[string,string]>>} 每轮的对阵
 */
function roundRobinRounds(entries = []) {
  const list = [...entries];
  if (list.length < 2) return [];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    // 固定第一个位置，其余顺时针轮转
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * 循环赛名次：胜场优先，同胜场比组内相互战绩，仍相同则并列。
 *
 * 只用胜场与相互战绩，不引入净胜局/净胜分——拔河这类项目本来就只有胜负，
 * 引入不存在的指标等于编数据。
 *
 * @returns {{ok:boolean, message?:string, rows?:Array, pending?:Array}}
 */
function roundRobinStandings({ entries = [], matches = [] } = {}) {
  const wins = new Map(entries.map((key) => [key, 0]));
  const beat = new Set();
  const pending = [];

  for (const match of matches) {
    const [a, b] = match.entryKeys || [];
    if (!a && !b) continue;
    if (!match.winnerEntryKey) {
      pending.push({ roundNo: match.roundNo, index: match.index, sessionKey: match.sessionKey || '' });
      continue;
    }
    const loser = match.winnerEntryKey === a ? b : a;
    wins.set(match.winnerEntryKey, (wins.get(match.winnerEntryKey) || 0) + 1);
    if (loser) beat.add(`${match.winnerEntryKey}>${loser}`);
  }
  if (pending.length > 0) {
    return { ok: false, message: `还有 ${pending.length} 场没有决出胜负`, pending };
  }

  const groups = new Map();
  for (const entryKey of entries) {
    const won = wins.get(entryKey) || 0;
    if (!groups.has(won)) groups.set(won, []);
    groups.get(won).push(entryKey);
  }

  const rows = [];
  let position = 1;
  for (const won of [...groups.keys()].sort((a, b) => b - a)) {
    const group = groups.get(won);
    // 组内相互战绩：只统计本组内部谁赢过谁
    const inner = new Map(group.map((key) => [key, 0]));
    for (const a of group) {
      for (const b of group) {
        if (a !== b && beat.has(`${a}>${b}`)) inner.set(a, inner.get(a) + 1);
      }
    }
    const ordered = [...group].sort((a, b) => inner.get(b) - inner.get(a)
      || String(a).localeCompare(String(b)));
    let lastInner = null;
    let lastRank = 0;
    ordered.forEach((entryKey, index) => {
      const rank = lastInner !== null && inner.get(entryKey) === lastInner
        ? lastRank
        : position + index;
      rows.push({ entryKey, rank, wins: won });
      lastInner = inner.get(entryKey);
      lastRank = rank;
    });
    position += group.length;
  }
  return { ok: true, rows, pending: [] };
}

module.exports = {
  ADVANCE_MODE,
  MEET_FORMAT,
  FORMAT_LABEL,
  rankByValue,
  advanceFromHeats,
  bracketTotalRounds,
  bracketRoundLabel,
  bracketStandings,
  roundRobinRounds,
  roundRobinStandings,
};
