/**
 * 赛事抽签 —— 名单口径、种子排序、签表生成
 * ============================================================
 * 抽签这一步要回答三件事，答案全在这里：
 *   1. 谁参赛？（未取消的报名者，不看签到）
 *   2. 谁当种子、按什么顺序？（手工指定 / 按等级分 / 按赛季积分）
 *   3. 谁落在哪个签位？（由 utils/bracket.js 的落位算法说了算）
 *
 * 【为什么与 event.js 分开】
 * event.js 管的是「赛事本身」的表单与权限；抽签是赛事之上的一个动作，
 * 依赖报名记录与会员名单两份数据。混进 event.js 会让那个模块既管发布
 * 又管抽签，边界就糊了。这里只做纯计算，不碰 wx、不碰数据源，因而每条
 * 规则都能在 Node 里用字面量钉死（见 tests/draw.test.js）。
 *
 * 【为什么随机源要由 seedValue 现算，而不是传进来】
 * 决策 4.4：抽签结果必须可复核——把 seedValue 落库，任何人拿同一个值
 * 重跑一遍就能得到同一张签表。若允许外部塞进一个 random 函数，复核者
 * 就无从复现。所以这里只收 seedValue，随机序列由它确定性地导出。
 *
 * 【为什么时间与操作人不在这一层】
 * drawnAt / drawnBy / drawCount 是「什么时候、谁、第几次」的台账信息，
 * 与算法无关；由调用方（云函数或 mock）填。这一层只产出确定性内容，
 * 测试时也就不必伪造时钟。
 * ============================================================
 */

const {
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_BRONZE_MODE,
  BRACKET_STAGE,
  SEED_MODE,
  SEED_COUNTS,
  DEFAULT_SEED_COUNT,
  SIGNUP_STATUS,
  RATING_POOL,
} = require('../utils/constants.js');
const { getPoolRating } = require('../utils/rating.js');
const { createSeededRandom } = require('../utils/random.js');
const { drawBracket, bracketSizeOf } = require('../utils/bracket.js');
const { DEFAULT_FORMAT } = require('../utils/match-format.js');

/** 合法的种子来源集合 */
const VALID_SEED_MODES = Object.values(SEED_MODE);

/**
 * 未取消报名者的编号列表（决策：参赛者不看签到）。
 *
 * 报名记录一旦产生就不删除，取消了只是 status 置为 CANCELED，因此这里
 * 必须显式过滤掉已取消的人——否则退赛的人还会被抽进签表。
 * 结果按编号排序，与报名先后无关，抽签的随机性只来自 seedValue。
 *
 * @param {Array<Object>} [signups]
 * @returns {string[]}
 */
function entryIdsOf(signups) {
  const list = Array.isArray(signups) ? signups : [];
  const ids = list
    .filter((item) => item && item.status !== SIGNUP_STATUS.CANCELED)
    .map((item) => item.userId)
    .filter((id) => typeof id === 'string' && id);
  return Array.from(new Set(ids)).sort();
}

/**
 * 一个人的种子排序依据。
 *
 * elo 取单打池的等级分——抽签只对单打开放（决策 1），用双打分排序毫无
 * 意义；points 取当前赛季积分，与排行榜同一口径。
 *
 * @param {Object} [member]
 * @param {'elo'|'points'} mode
 * @returns {number}
 */
function seedRankOf(member, mode) {
  if (!member) return mode === 'points' ? 0 : -Infinity;
  if (mode === SEED_MODE.POINTS) {
    const value = Number(member.points);
    return Number.isFinite(value) ? value : 0;
  }
  return getPoolRating(member, RATING_POOL.SINGLES).elo;
}

/**
 * 实际种子数（决策 9.3）：取「选定数量」与「参赛人数」的较小者。
 * 参赛人数不超过种子数时人人按来源顺序排位，不再随机。
 *
 * @param {number} seedCount
 * @param {number} entryCount
 * @returns {number}
 */
function actualSeedCount(seedCount, entryCount) {
  const wanted = Number(seedCount);
  const size = Number(entryCount);
  if (!Number.isFinite(wanted) || wanted < 0) return 0;
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.min(Math.floor(wanted), Math.floor(size));
}

/**
 * 排出有序的种子名单。
 *
 * 【手工指定为什么不由系统代排】
 * 决策 9.4：管理员逐个指定 1 号、2 号种子。等级分高不代表他要被摆成
 * 一号种子——可能有伤病、可能上赛季分数虚高，排序权在管理员手里。
 * 因此 manual 模式原样采用传进来的顺序，只做归属与去重校验。
 *
 * @param {Object} params
 * @param {string[]} params.entries 参赛者编号
 * @param {Array<Object>} params.members 全量会员名单
 * @param {string} params.mode 种子来源
 * @param {number} params.seedCount 选定种子数
 * @param {string[]} [params.manualOrder] 手工指定的顺序（仅 manual 模式）
 * @returns {{seeds:string[], errors:Object, firstError:string}}
 */
function resolveSeeds({ entries, members, mode, seedCount, manualOrder } = {}) {
  const errors = {};
  const list = Array.isArray(entries) ? entries : [];
  const wanted = actualSeedCount(seedCount, list.length);

  if (!VALID_SEED_MODES.includes(mode)) {
    errors.mode = '请选择种子来源';
  }
  if (!SEED_COUNTS.includes(Number(seedCount))) {
    errors.seedCount = '种子数量必须是 2 / 4 / 8';
  }

  if (errors.mode || errors.seedCount) {
    return { seeds: [], errors, firstError: errors.mode || errors.seedCount };
  }

  if (mode === SEED_MODE.MANUAL) {
    const order = Array.isArray(manualOrder) ? manualOrder : [];
    const unique = Array.from(new Set(order));
    if (unique.some((id) => !list.includes(id))) {
      errors.manualOrder = '种子必须是参赛者之一';
    } else if (unique.length < wanted) {
      errors.manualOrder = `请指定 ${wanted} 位种子（已指定 ${unique.length} 位）`;
    }
    if (errors.manualOrder) {
      return { seeds: [], errors, firstError: errors.manualOrder };
    }
    return { seeds: unique.slice(0, wanted), errors: {}, firstError: '' };
  }

  const memberMap = new Map(
    (Array.isArray(members) ? members : []).map((member) => [member._id, member])
  );
  const ranked = list
    .map((id) => ({ id, rank: seedRankOf(memberMap.get(id), mode) }))
    // 同分时按编号定序：抽签的随机性只该来自 seedValue，
    // 否则同分者的先后会随名单顺序漂移，复核时对不上
    .sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : 1));

  return { seeds: ranked.slice(0, wanted).map((item) => item.id), errors: {}, firstError: '' };
}

/**
 * 计划一次抽签：算名单、排种子、落签位。
 *
 * 纯函数。调用方负责把 seedValue 记下来，抽签参数与结果一同落库，
 * 这样结果永远可被同一个 seedValue 复核出来。
 *
 * @param {Object} params
 * @param {Object} params.event 赛事记录
 * @param {Array<Object>} params.signups 报名记录
 * @param {Array<Object>} params.members 会员名单
 * @param {number} params.seedValue 随机种子值（落库备查）
 * @param {string[]} [params.manualOrder] 手工指定的种子顺序
 * @returns {Object} 见下方返回结构注释
 */
function planDraw({ event, signups, members, seedValue, manualOrder } = {}) {
  if (!event) {
    return fail('赛事不存在');
  }
  // 决策 1：本期只做单打抽签，双打赛事连入口都不该有
  if (event.matchType !== MATCH_TYPE.SINGLES) {
    return fail('双打赛事暂不支持抽签');
  }
  // 决策 7：只有报名阶段（尚未开赛）可以抽签
  if (event.status !== EVENT_STATUS.SIGNUP) {
    return fail('只能在报名阶段抽签');
  }

  const entries = entryIdsOf(signups);
  if (entries.length < 2) {
    return fail('参赛人数不足 2 人，无法抽签');
  }

  const mode = event.seedMode;
  const seedCount = Number.isFinite(Number(event.seedCount))
    ? Number(event.seedCount)
    : DEFAULT_SEED_COUNT;

  const resolved = resolveSeeds({ entries, members, mode, seedCount, manualOrder });
  if (resolved.firstError) {
    return fail(resolved.firstError);
  }

  const value = Number(seedValue);
  if (!Number.isFinite(value)) {
    return fail('缺少随机种子值，无法抽签');
  }

  const bracket = drawBracket({
    entries,
    seeds: resolved.seeds,
    random: createSeededRandom(value),
  });
  if (!bracket.ok) {
    return fail(bracket.firstError);
  }

  return {
    ok: true,
    message: '',
    seedValue: value,
    seedMode: mode,
    seedCount,
    size: bracket.size,
    slots: bracket.slots,
    seeds: bracket.seeds,
    byes: bracket.byes,
    pairs: bracket.pairs,
    entries,
  };
}

/**
 * 抽签落库的形状（决策 5.1）。
 *
 * 与算法内容分开：drawnAt / drawnBy / drawCount 是台账信息，由调用方给，
 * 这一层不造时间也不认人。
 *
 * @param {Object} plan planDraw 的返回值
 * @param {Object} params
 * @param {Date|string} params.drawnAt
 * @param {string} params.drawnBy
 * @param {number} [params.drawCount=1]
 * @returns {Object}
 */
function buildDrawRecord(plan, { drawnAt, drawnBy, drawCount = 1 } = {}) {
  return {
    seedMode: plan.seedMode,
    seedCount: plan.seedCount,
    seedValue: plan.seedValue,
    drawnAt: drawnAt ? new Date(drawnAt) : null,
    drawnBy: drawnBy || null,
    drawCount: Number(drawCount) || 1,
    size: plan.size,
    slots: plan.slots.slice(),
    seeds: plan.seeds.slice(),
    byes: plan.byes.slice(),
  };
}

/**
 * 赛事比赛的自然键：轮次 + 阶段 + 签位唯一确定一场比赛。
 *
 * 【为什么要一个确定性编号，而不是随手生成】
 * 重抽时要「作废旧的首轮、换上新的首轮」。若每场都用随机编号，重抽就
 * 变成不断追加，签表里会同时留着两批首轮比赛，谁也说不清哪批才算数。
 * 用这个键当 _id，新首轮会覆盖在同一批编号上，抽多少次都只有一批。
 *
 * 键里不含时间也不含人：这些恰恰是抽签会变的东西。签位是「位置」，
 * 位置不变，坐在位置上的人变。
 *
 * @param {string} eventId
 * @param {number} round 轮次，从 1 开始
 * @param {string} [stage] 见 constants.BRACKET_STAGE
 * @param {number} slot 该轮内的签位序号，从 0 开始
 * @returns {string} 可直接用作比赛 _id
 */
function eventMatchKey(eventId, round, stage, slot) {
  return `x_${eventId}_r${round}_${stage || BRACKET_STAGE.MAIN}_${slot}`;
}

/**
 * 按抽签结果生成首轮比赛记录（决策 5）。
 *
 * 【为什么不用 buildMatchRecord】
 * 那个函数是「录一场已经打完的比赛」用的，会把空比分判成非法。而抽签
 * 生成的是「还没开打的对阵」——比分、胜方、录入人都应当是空的，等比赛
 * 打完再经录入通路补上。两者的校验口径根本不同，硬塞进去只会把
 * 「还没打」误报成「比分不合法」。
 *
 * 【轮空为什么不生成比赛】
 * 决策 6 / §5.2：轮空者不动手就进下一轮，没有对手可打。这里跳过任何
 * 有一方为空的签位，轮空者只出现在 draw.byes 里。
 *
 * @param {Object} plan planDraw 的返回值
 * @param {Object} params
 * @param {Object} params.event 赛事记录（取主办地、开赛时间）
 * @param {Object} [params.format] 赛制，缺省用业余最常用的一档
 * @param {number} [params.round=1] 轮次，首轮为 1
 * @param {string} [params.stage] 见 constants.BRACKET_STAGE
 * @returns {Array<Object>} 比赛草稿数组（每场都带确定性的 _id）
 */
function buildBracketMatches(plan, { event, format = DEFAULT_FORMAT, round = 1, stage = BRACKET_STAGE.MAIN } = {}) {
  if (!plan || plan.ok !== true || !event || !event._id) return [];
  return draftsFromPairs(event, plan.pairs, { round, stage, format });
}

/**
 * 逐轮生成比赛（决策 5.2）。
 *
 * 与首轮不同，后续轮次的对阵要靠上一轮的结果推出来：某一轮每一场都
 * 「已确认生效」后，才能把胜者排进下一轮。这里从签表逐轮推演，直到
 * 撞上一个还没打完的轮次为止，把「还没排过的」那些轮次返回给调用方。
 *
 * 【为什么由这一层判断「排过没有」】
 * 编号由轮次 + 阶段 + 签位确定，所以「这一轮排过没有」只需查一下编号
 * 在不在已有比赛里。若等调用方去重，它就得把 eventMatchKey 的拼法再抄
 * 一遍——签位重排的口子往往就是这么开出来的。已有记录（哪怕还只是待
 * 确认）一律视为排过，绝不重排，免得把已经录好的比分抹掉。
 *
 * 【轮空不产生比赛，但要占一个晋级名额】
 * 首轮里轮空的一方不动手就进下一轮；到了决定冠军之后的半决赛，负者
 * 按 bronzeMode 决定打不打三四名赛（决策 4）。
 *
 * @param {Object} params
 * @param {string} params.eventId
 * @param {Object} params.draw 赛事的 draw 字段
 * @param {Array<Object>} [params.matches] 该赛事已有的全部比赛
 * @param {string} [params.bronzeMode] 见 constants.EVENT_BRONZE_MODE
 * @returns {{ok:boolean, rounds:Array<{round:number, stage:string, pairs:Array<Array<string>>}>}}
 */
function planNextRound({ eventId, draw, matches, bronzeMode } = {}) {
  if (!eventId || !draw || !Array.isArray(draw.slots) || draw.slots.length < 2) {
    return { ok: false, rounds: [] };
  }

  const size = Number(draw.size) || draw.slots.length;
  const totalRounds = Math.round(Math.log2(size));
  const byId = new Map((Array.isArray(matches) ? matches : []).map((m) => [m && m._id, m]));

  const rounds = [];
  let entrants = draw.slots.slice();

  for (let round = 1; round <= totalRounds; round += 1) {
    const pairs = chunkPairs(entrants);
    const winners = [];
    const losers = [];
    let resolved = true;

    pairs.forEach((pair, slot) => {
      const [a, b] = pair;
      if (!a && !b) return;
      // 轮空：一方不动手就晋级
      if (!a || !b) {
        winners.push(a || b);
        return;
      }
      const match = byId.get(eventMatchKey(eventId, round, BRACKET_STAGE.MAIN, slot));
      // 只有「已生效且判明了胜负」才算打完；待确认、被撤销都还悬着
      if (!match || match.status !== MATCH_STATUS.ACTIVE || !match.winner) {
        resolved = false;
        return;
      }
      winners.push(match.winner === 'A' ? a : b);
      losers.push(match.winner === 'A' ? b : a);
    });

    // 这一轮没打完，后面几个轮次无从谈起
    if (!resolved) break;
    // 决赛打完，签表到头了
    if (round === totalRounds) break;

    const nextPairs = chunkPairs(winners);
    const missing = nextPairs.some(
      (pair, slot) => !byId.has(eventMatchKey(eventId, round + 1, BRACKET_STAGE.MAIN, slot))
    );
    if (missing) {
      rounds.push({ round: round + 1, stage: BRACKET_STAGE.MAIN, pairs: nextPairs });
    }

    // 半决赛打完（下一轮只剩两人）→ 打三四名模式下补一场季军赛
    if (winners.length === 2 && bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && losers.length === 2) {
      const bronzeKey = eventMatchKey(eventId, round + 1, BRACKET_STAGE.BRONZE, 0);
      if (!byId.has(bronzeKey)) {
        rounds.push({ round: round + 1, stage: BRACKET_STAGE.BRONZE, pairs: [[losers[0], losers[1]]] });
      }
    }

    entrants = winners;
  }

  return { ok: rounds.length > 0, rounds };
}

/**
 * 由指定的对阵生成某几场比赛的草稿（逐轮推进用）。
 *
 * @param {Object} event 赛事记录
 * @param {Object} params
 * @param {number} params.round 轮次
 * @param {string} [params.stage] 见 constants.BRACKET_STAGE
 * @param {Array<Array<string>>} params.pairs 对阵
 * @param {Object} [params.format] 赛制
 * @returns {Array<Object>}
 */
function buildRoundMatches(event, { round, stage = BRACKET_STAGE.MAIN, pairs, format = DEFAULT_FORMAT } = {}) {
  if (!event || !event._id || !Array.isArray(pairs)) return [];
  return draftsFromPairs(event, pairs, { round, stage, format });
}

/** 有序数组两两分组：['a','b','c','d'] → [['a','b'],['c','d']]；落单的补 null */
function chunkPairs(list) {
  const source = Array.isArray(list) ? list : [];
  const pairs = [];
  for (let i = 0; i < source.length; i += 2) {
    pairs.push([source[i], source[i + 1] === undefined ? null : source[i + 1]]);
  }
  return pairs;
}

/** 由一堆对阵生成比赛草稿；一方为空的签位（轮空）跳过 */
function draftsFromPairs(event, pairs, { round, stage, format }) {
  const drafts = [];
  (Array.isArray(pairs) ? pairs : []).forEach((pair, slot) => {
    const teamA = pair && pair[0];
    const teamB = pair && pair[1];
    if (!teamA || !teamB) return;
    drafts.push({
      _id: eventMatchKey(event._id, round, stage, slot),
      matchType: MATCH_TYPE.SINGLES,
      // 池必须跟着记录写死，否则按池过滤时会被静默漏掉
      pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
      teamA: [teamA],
      teamB: [teamB],
      // 还没开打：比分留空，胜方未知，录入人待赛后补
      scoreA: [],
      scoreB: [],
      gamePoints: format.gamePoints,
      bestOf: format.bestOf,
      winner: null,
      location: event.location || '',
      matchTime: event.startTime,
      recorder: null,
      eventId: event._id,
      round,
      stage,
      slot,
    });
  });
  return drafts;
}

/**
 * 一张签表里的实际参赛人数（轮空位不算人）。
 *
 * 名次校验要判断「这届打不打得出三四名赛」，而这个由签表结构决定，不由
 * 报名人数决定：抽签后再补报名、或报名后又有人退赛，两者就会对不上。
 * 谁真正站上了签位是签表说了算，所以以它为准。
 *
 * @param {Object} [draw] 赛事的 draw 字段
 * @returns {number} 参赛人数；没有签表时返回 0
 */
function drawnEntryCount(draw) {
  const slots = draw && Array.isArray(draw.slots) ? draw.slots : [];
  return slots.filter((id) => !!id).length;
}

/**
 * 能不能重抽（决策 9.5）。
 *
 * 只要该赛事已有比赛被确认生效（已计入 elo），就禁止重抽——分数已经
 * 发出去，再换一张签表会让已生效的比赛与名次对不上。仅「已生成但全部
 * 未确认」时允许推倒重来。
 *
 * @param {Array<Object>} [matches] 该赛事的比赛记录
 * @returns {boolean}
 */
function canRedraw(matches) {
  const list = Array.isArray(matches) ? matches : [];
  return !list.some((match) => match && match.status === MATCH_STATUS.ACTIVE);
}

/** 统一构造失败返回，免得每个分支各拼一遍 */
function fail(message) {
  return {
    ok: false,
    message,
    seedValue: null,
    seedMode: null,
    seedCount: 0,
    size: 0,
    slots: [],
    seeds: [],
    byes: [],
    pairs: [],
    entries: [],
  };
}

module.exports = {
  VALID_SEED_MODES,
  entryIdsOf,
  seedRankOf,
  actualSeedCount,
  resolveSeeds,
  planDraw,
  buildDrawRecord,
  eventMatchKey,
  buildBracketMatches,
  planNextRound,
  buildRoundMatches,
  drawnEntryCount,
  canRedraw,
  bracketSizeOf,
};
