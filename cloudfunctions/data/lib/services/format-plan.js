/**
 * 赛制阶段派发器
 * ============================================================
 * 现在的抽签引擎原先只认单败淘汰：一轮打完排下一轮，决赛完就结束。
 * 循环赛、小组赛、双败淘汰、以及「小组打完接着淘汰」这样的复合赛制，
 * 若各写一套推进逻辑，分支很快就理不清了。
 *
 * 这里的做法是把任何一种赛制看成**有序的阶段序列**：
 *
 *   单败：淘汰
 *   循环：循环（单组）
 *   小组：分组循环 → 淘汰
 *   双败：胜者组 → 败者组 → 总决赛（第二批实现）
 *
 * 于是「以上所有形式的复合」不是靠穷举组合，而是阶段序列自然串联的
 * 结果；加一种预设就是加一条分支。
 *
 * 【为什么读操作要能凭空重推】
 * 比赛记录只存「事实」，阶段该排到哪一轮是从事实推出来的。这样：
 *   - 断点续跑天然成立：中途关掉小程序，回来照着已有比赛接着推；
 *   - 管理员删掉/撤销一场，状态自动回退，不会留下排错的下一轮。
 * 因此本模块全部是纯函数：只读赛事、签表与比赛，产出「还缺哪些轮次」。
 *
 * 【为什么名次也从这里推】
 * 循环赛的名次是算出来的，不是打出来的（淘汰赛恰恰相反）。名次页的
 * 预填值因此由 derivePlacements 给出，管理员再在上面微调。
 * ============================================================
 */

const {
  MATCH_STATUS,
  BRACKET_STAGE,
  EVENT_FORMAT,
  EVENT_BRONZE_MODE,
  EVENT_PLACEMENT_MODE,
  DEFAULT_PLACEMENT_MODE,
} = require('../utils/constants.js');
const { standardSeedOrder, bracketSizeOf } = require('../utils/bracket.js');
const { DEFAULT_FORMAT } = require('../utils/match-format.js');
const { computeStandings, allDecided, roundRobinRounds } = require('../utils/standings.js');
const {
  eventMatchKey,
  chunkPairs,
  buildRoundMatches,
  planNextRound,
  formatOf,
  normalizeAdvancePerGroup,
} = require('./draw.js');

/**
 * 抽签后生成第一批比赛。
 *
 * 单败淘汰一次把首轮摆好（后续轮次由 planStageMatches 逐轮补）；
 * 循环 / 小组赛只摆出每个小组的第一轮，其余轮次按「上一轮全打完」再排，
 * 免得一次把整张循环表的几十场都堆到界面上。
 *
 * @param {Object} event 赛事记录
 * @param {Object} draw 赛事的 draw 字段
 * @returns {Array<Object>} 比赛草稿
 */
function buildInitialMatches(event, draw) {
  if (!event || !event._id || !draw) return [];
  const format = formatOf(event);

  if (Array.isArray(draw.groups) && draw.groups.length > 0) {
    return draw.groups.flatMap((item) => groupRoundDrafts(event, item, 1));
  }

  const slots = Array.isArray(draw.slots) ? draw.slots : [];
  return buildRoundMatches(event, {
    round: 1,
    stage: BRACKET_STAGE.MAIN,
    pairs: chunkPairs(slots),
    format: DEFAULT_FORMAT,
  });
}

/**
 * 阶段派发：算出「还缺哪些轮次的比赛」。
 *
 * @param {Object} params
 * @param {Object} params.event 赛事记录
 * @param {Object} params.draw 赛事的 draw 字段
 * @param {Array<Object>} [params.matches] 该赛事已有的全部比赛
 * @returns {{ok:boolean, rounds:Array<{group?:number, round:number, stage:string, pairs:Array<Array<string>>}>}}
 */
function planStageMatches({ event, draw, matches } = {}) {
  if (!event || !event._id || !draw) return { ok: false, rounds: [] };
  const list = Array.isArray(matches) ? matches : [];
  const format = formatOf(event);

  if (format === EVENT_FORMAT.ROUND_ROBIN) {
    const rounds = planGroupPhase(event, draw, list);
    return { ok: rounds.length > 0, rounds };
  }

  if (format === EVENT_FORMAT.GROUP_KNOCKOUT) {
    const groupRounds = planGroupPhase(event, draw, list);
    if (groupRounds.length > 0) return { ok: true, rounds: groupRounds };

    const bracket = knockoutBracket(event, draw, list);
    if (!bracket) return { ok: false, rounds: [] };

    // 淘汰签表是推出来的，首轮尚未落到台账里；planNextRound 只管
    // 「当前轮打完排下一轮」，所以首轮要在这里补出来
    const byId = new Set(list.map((match) => match && match._id));
    const firstPairs = chunkPairs(bracket.slots);
    const missingFirst = firstPairs.some(
      (pair, slot) =>
        pair[0] && pair[1] && !byId.has(eventMatchKey(event._id, 1, BRACKET_STAGE.MAIN, slot))
    );
    if (missingFirst) {
      return { ok: true, rounds: [{ round: 1, stage: BRACKET_STAGE.MAIN, pairs: firstPairs }] };
    }

    return planNextRound({
      eventId: event._id,
      draw: bracket,
      matches: list,
      bronzeMode: event.bronzeMode,
      placementMode: event.placementMode,
    });
  }

  // 单败淘汰（双败淘汰在第二批接入前按单败处理其主签表）
  return planNextRound({
    eventId: event._id,
    draw,
    matches: list,
    bronzeMode: event.bronzeMode,
    placementMode: event.placementMode,
  });
}

/**
 * 循环赛 / 小组赛阶段：逐组推算还缺哪一轮。
 *
 * 【闸门为什么是「上一轮全部打完」】
 * 循环表的对局虽然提前就确定，但一轮没打完就冒下一轮，界面会同时铺开
 * 好几轮的比赛，签到与录分的人分不清先后。所以每组的第 r 轮只在第 r−1
 * 轮全部生效后才放出来。
 *
 * @param {Object} event
 * @param {Object} draw
 * @param {Array<Object>} matches
 * @returns {Array<Object>}
 */
function planGroupPhase(event, draw, matches) {
  const rounds = [];
  (Array.isArray(draw.groups) ? draw.groups : []).forEach((item) => {
    const schedule = scheduleOf(item);
    const byId = groupMatchIndex(matches, item.group);

    for (let index = 0; index < schedule.length; index += 1) {
      const roundNo = index + 1;
      const pairs = schedule[index];
      const allExist = pairs.every((pair, slot) =>
        byId.has(eventMatchKey(event._id, roundNo, BRACKET_STAGE.GROUP, slot, item.group))
      );

      if (!allExist) {
        const previousDone =
          index === 0 ||
          roundDecided(schedule[index - 1], roundNo - 1, byId, event._id, item.group);
        if (previousDone) {
          rounds.push({ group: item.group, round: roundNo, stage: BRACKET_STAGE.GROUP, pairs });
        }
        break;
      }

      if (!roundDecided(pairs, roundNo, byId, event._id, item.group)) break;
    }
  });

  return rounds;
}

/**
 * 小组赛出线后的淘汰签表。
 *
 * 【跨组交叉怎么保证】
 * 出线者先按「组内名次优先、组号其次」排成一列（各组第 1 名在最前），
 * 再套标准种子排位表落位。这样同组两人第一轮必不相遇，且 A1 天然对上
 * 别组的第二档——正是「A1 对 B2」那种交叉。
 *
 * 签位不落库：小组一有风吹草动（改判一场），下一次调用就重推一遍，
 * 不会留下一张与结果对不上的旧签表。
 *
 * @param {Object} event
 * @param {Object} draw
 * @param {Array<Object>} matches
 * @returns {{size:number, slots:Array<string|null>, qualifiers:string[], ranked:Array}|null}
 */
function knockoutBracket(event, draw, matches) {
  const groups = Array.isArray(draw.groups) ? draw.groups : [];
  if (groups.length === 0) return null;

  const advance = normalizeAdvancePerGroup(event.advancePerGroup);
  const ranked = [];

  for (const item of groups) {
    const groupMatches = (Array.isArray(matches) ? matches : []).filter(
      (match) => match && match.group === item.group
    );
    // 只要有一个小组没打完，出线名单就没定，淘汰签表无从谈起
    if (scheduleOf(item).length > 0 && !allDecided(groupMatches)) return null;
    ranked.push({
      group: item.group,
      rows: computeStandings({ entries: item.entries || [], matches: groupMatches }),
    });
  }

  const qualifiers = [];
  for (let rank = 0; rank < advance; rank += 1) {
    ranked.forEach((item) => {
      const row = item.rows[rank];
      if (row) qualifiers.push(row.id);
    });
  }
  if (qualifiers.length < 2) return null;

  const size = bracketSizeOf(qualifiers.length);
  const order = standardSeedOrder(size);
  const slots = order.map((rank) => qualifiers[rank - 1] || null);

  return { size, slots, qualifiers, ranked };
}

/**
 * 按赛制推导名次表（名次页预填用）。
 *
 * 【循环赛的名次是算出来的】
 * 淘汰赛的名次由「输了第几轮」决定，循环赛由积分表决定。两者口径不同，
 * 所以这里按赛制分支：循环 / 小组赛返回确定的名次；单败淘汰仍交给管理员
 * 手工录入（倒三角排位赛在场次上已经打出来了，名次在这里一并算好）。
 *
 * @param {Object} params
 * @param {Object} params.event
 * @param {Object} params.draw
 * @param {Array<Object>} [params.matches]
 * @returns {{ok:boolean, results:Array<{userId:string, placement:number}>, message:string}}
 */
function derivePlacements({ event, draw, matches } = {}) {
  if (!event || !draw) {
    return { ok: false, results: [], message: '还没有可推导的赛程' };
  }
  const list = Array.isArray(matches) ? matches : [];
  const format = formatOf(event);

  if (format === EVENT_FORMAT.ROUND_ROBIN) {
    const item = (draw.groups || [])[0];
    if (!item) return { ok: false, results: [], message: '还没有分组信息' };
    const groupMatches = list.filter((match) => match && match.group === item.group);
    if (!allDecided(groupMatches)) {
      return { ok: false, results: [], message: '循环赛还没打完，名次尚未确定' };
    }
    const rows = computeStandings({ entries: item.entries || [], matches: groupMatches });
    return { ok: true, results: rows.map((row) => ({ userId: row.id, placement: row.rank })), message: '' };
  }

  if (format === EVENT_FORMAT.GROUP_KNOCKOUT) {
    return deriveGroupedPlacements(event, draw, list);
  }

  if (format === EVENT_FORMAT.SINGLE_ELIM) {
    const placements = placementsFromBracket(event, draw, list);
    if (!placements) {
      return { ok: false, results: [], message: '比赛还没打完，名次尚未确定' };
    }
    const results = Array.from(placements, ([userId, placement]) => ({ userId, placement }));
    results.sort((a, b) => a.placement - b.placement);
    return { ok: true, results, message: '' };
  }

  return { ok: false, results: [], message: '该赛制的名次请手工录入' };
}

/**
 * 小组赛 + 淘汰：出线者按淘汰成绩、未出线者按小组名次续排。
 *
 * @param {Object} event
 * @param {Object} draw
 * @param {Array<Object>} matches
 * @returns {{ok:boolean, results:Array<Object>, message:string}}
 */
function deriveGroupedPlacements(event, draw, matches) {
  const bracket = knockoutBracket(event, draw, matches);
  if (!bracket) {
    return { ok: false, results: [], message: '小组赛还没打完，名次尚未确定' };
  }

  const knockout = placementsFromBracket(event, bracket, matches);
  if (!knockout) {
    return { ok: false, results: [], message: '淘汰赛还没打完，名次尚未确定' };
  }

  const advance = normalizeAdvancePerGroup(event.advancePerGroup);
  const results = [];
  knockout.forEach((placement, userId) => results.push({ userId, placement }));

  // 未出线者：组内名次越靠前，总名次越靠前；同名义次按组号定序
  const rest = [];
  bracket.ranked.forEach((item) => {
    item.rows.forEach((row, index) => {
      if (index + 1 > advance) rest.push({ userId: row.id, rank: index + 1, group: item.group });
    });
  });
  rest.sort((a, b) => a.rank - b.rank || a.group - b.group);

  let next = bracket.qualifiers.length + 1;
  rest.forEach((item) => {
    results.push({ userId: item.userId, placement: next });
    next += 1;
  });

  results.sort((a, b) => a.placement - b.placement);
  return { ok: true, results, message: '' };
}

/**
 * 从淘汰签表逐轮推算每个人的名次。
 *
 * 并列口径：半决赛负者在「打三四名」时分成 3 / 4，并列季军时同为 3；
 * 八强负者在开了排位赛时分出 5–8，否则并列第 5。这与 points.js 的
 * 档位表一一对应（5–8 名同档），所以并列不会让积分算错。
 *
 * 任何一场该定而未定（含季军赛、排位赛）就返回 null——名次表宁可
 * 晚一点出，也不能出一个半截的。
 *
 * @param {Object} event
 * @param {{size:number, slots:Array<string|null>}} bracket
 * @param {Array<Object>} matches
 * @returns {Map<string, number>|null}
 */
function placementsFromBracket(event, bracket, matches) {
  const eventId = event._id;
  const byId = new Map((Array.isArray(matches) ? matches : []).map((match) => [match && match._id, match]));
  const slots = Array.isArray(bracket.slots) ? bracket.slots : [];
  const size = Number(bracket.size) || slots.length;
  const totalRounds = Math.round(Math.log2(size));
  if (totalRounds < 1) return null;

  const placements = new Map();
  const decided = (key) => {
    const match = byId.get(key);
    return match && match.status === MATCH_STATUS.ACTIVE && match.winner ? match : null;
  };

  let entrants = slots.slice();

  for (let round = 1; round <= totalRounds; round += 1) {
    const pairs = chunkPairs(entrants);
    const winners = [];
    const losers = [];
    let complete = true;

    pairs.forEach((pair, slot) => {
      const a = pair[0];
      const b = pair[1];
      if (!a && !b) return;
      if (!a || !b) {
        winners.push(a || b);
        return;
      }
      const match = decided(eventMatchKey(eventId, round, BRACKET_STAGE.MAIN, slot));
      if (!match) {
        complete = false;
        return;
      }
      winners.push(match.winner === 'A' ? a : b);
      losers.push(match.winner === 'A' ? b : a);
    });

    if (!complete) return null;

    if (round === totalRounds) {
      placements.set(winners[0], 1);
      placements.set(losers[0], 2);
      break;
    }

    // 半决赛的两名负者
    if (round === totalRounds - 1 && losers.length === 2) {
      const [x, y] = losers;
      if (event.bronzeMode === EVENT_BRONZE_MODE.PLAYOFF) {
        const bronze = decided(eventMatchKey(eventId, round + 1, BRACKET_STAGE.BRONZE, 0));
        if (!bronze) return null;
        placements.set(bronze.winner === 'A' ? x : y, 3);
        placements.set(bronze.winner === 'A' ? y : x, 4);
      } else {
        placements.set(x, 3);
        placements.set(y, 3);
      }
      entrants = winners;
      continue;
    }

    // 八强战的四名负者
    if (losers.length === 4) {
      if (event.placementMode === EVENT_PLACEMENT_MODE.TOP8) {
        const first = [
          decided(eventMatchKey(eventId, round + 1, BRACKET_STAGE.PLACEMENT, 0)),
          decided(eventMatchKey(eventId, round + 1, BRACKET_STAGE.PLACEMENT, 1)),
        ];
        const finals = [
          decided(eventMatchKey(eventId, round + 2, BRACKET_STAGE.PLACEMENT, 0)),
          decided(eventMatchKey(eventId, round + 2, BRACKET_STAGE.PLACEMENT, 1)),
        ];
        if (first.some((match) => !match) || finals.some((match) => !match)) return null;
        // 排位半决的两场：胜者去争 5/6，负者去争 7/8
        const upper = [0, 1].map((slot) =>
          first[slot].winner === 'A' ? losers[slot * 2] : losers[slot * 2 + 1]
        );
        const lower = [0, 1].map((slot) =>
          first[slot].winner === 'A' ? losers[slot * 2 + 1] : losers[slot * 2]
        );
        assignments(finals[0], upper, placements, 5, 6);
        assignments(finals[1], lower, placements, 7, 8);
      } else {
        losers.forEach((id) => placements.set(id, 5));
      }
      entrants = winners;
      continue;
    }

    // 更早轮次的负者：并列在 2^k + 1 名（与 5–8 同档的旧口径一致）
    const base = Math.pow(2, totalRounds - round) + 1;
    losers.forEach((id) => placements.set(id, base));
    entrants = winners;
  }

  return placements;
}

/** 把一场排位赛的胜者与负者分别写到两个名次上 */
function assignments(match, pair, placements, winnerPlacement, loserPlacement) {
  placements.set(match.winner === 'A' ? pair[0] : pair[1], winnerPlacement);
  placements.set(match.winner === 'A' ? pair[1] : pair[0], loserPlacement);
}

/* ------------------------------------------------------------
 * 小组辅助
 * ---------------------------------------------------------- */

/** 某组已有的比赛，按编号索引 */
function groupMatchIndex(matches, group) {
  return new Map(
    (Array.isArray(matches) ? matches : [])
      .filter((match) => match && match.group === group)
      .map((match) => [match._id, match])
  );
}

/** 一组某轮是否全部生效并分出胜负 */
function roundDecided(pairs, roundNo, byId, eventId, group) {
  return pairs.every((pair, slot) => {
    const match = byId.get(eventMatchKey(eventId, roundNo, BRACKET_STAGE.GROUP, slot, group));
    return Boolean(match && match.status === MATCH_STATUS.ACTIVE && match.winner);
  });
}

/** 从 draw 的分组条目重排该组全部轮次（确定性，无需落库） */
function scheduleOf(item) {
  return roundRobinRounds(item.entries || []);
}

/** 某组某一轮的比赛草稿 */
function groupRoundDrafts(event, item, roundNo) {
  const schedule = scheduleOf(item);
  const pairs = schedule[roundNo - 1];
  if (!pairs) return [];
  return buildRoundMatches(event, {
    round: roundNo,
    stage: BRACKET_STAGE.GROUP,
    pairs,
    format: DEFAULT_FORMAT,
    group: item.group,
  });
}

module.exports = {
  buildInitialMatches,
  planStageMatches,
  planGroupPhase,
  knockoutBracket,
  derivePlacements,
  placementsFromBracket,
};
