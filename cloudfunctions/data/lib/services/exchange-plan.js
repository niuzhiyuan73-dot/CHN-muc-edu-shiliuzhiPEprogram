/**
 * S4 跨校单打邀请赛：抽签落位、签表推进与名次推导
 * ============================================================
 * 【为什么单独一个模块】
 * 这三件事都是「只跟签表和比分有关」的纯计算：给定报名者与随机种子，
 * 应当落出什么对阵；给定已确认的比分，下一轮该出现哪一场；全部打完后，
 * 谁第几名。它们不该知道仓储、页面或身份，因此放在这里，供服务编排调用，
 * 也便于直接单测。
 *
 * 【为什么复用 utils/bracket.js 而不是另写一套】
 * 正式抽签要用与校内赛同一套「标准种子排位」算法（强手分处半区、轮空给
 * 强手）。各抄一份迟早分叉，所以这里只做「无种子纯随机」的薄封装：跨校
 * 交流赛当前不设种子，随机洗牌后按同一张表落位。
 *
 * 【轮空与晋级】
 * 签表规模取不小于报名人数的最小 2 的幂，多出的位置即轮空。轮空不生成
 * 比赛，该选手直接进入下一轮。下一轮比赛只在「两侧都已定下来」时才生成，
 * 于是无需占位记录，也不会出现双方待定的空比赛。
 *
 * 【名次怎么来】
 * 单败淘汰里每名非冠军恰好输一场，输在第 r 轮者的名次为 size/2^r + 1，
 * 同轮落败者并列；决赛胜者为第 1 名。名次完全由已确认比分推出，不由客户端填写。
 * ============================================================
 */

const { schoolKey } = require('../utils/school.js');
const { drawBracket } = require('../utils/bracket.js');
const { createSeededRandom } = require('../utils/random.js');

/**
 * 单场跨校比赛的记录键。round 从 1 起、slot 从 0 起，同一签表可稳定复算。
 * @param {string} eventId
 * @param {number} round
 * @param {number} slot
 * @returns {string}
 */
const exchangeMatchKey = (eventId, round, slot) =>
  schoolKey('xm', eventId, String(round), String(slot));

/** 签表轮数：规模为 2 的幂，轮数即 log2(size)。 */
const exchangeRoundCount = (size) => Math.round(Math.log2(size));

/**
 * 抽签：把报名者随机落进签表，保留种子值以便复核。
 *
 * @param {{entries?: Array<{userId:string}>, seedValue?:number}} params
 * @returns {{ok:true, draw:Object}|{ok:false, message:string}}
 */
function planExchangeDraw({ entries, seedValue } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const seed = Number(seedValue);
  if (!Number.isFinite(seed)) return { ok: false, message: '缺少随机种子值，无法抽签' };
  // 先按 userId 排序，落位只由种子值决定，与报名先后无关。
  const ids = list.map((entry) => entry.userId).sort();
  const draw = drawBracket({ entries: ids, seeds: [], random: createSeededRandom(seed) });
  if (!draw.ok) return { ok: false, message: draw.firstError };
  return { ok: true, draw: { seedValue: seed, size: draw.size, slots: draw.slots, byes: draw.byes } };
}

/**
 * 依当前比分推进签表，返回「此刻应当存在」的全部比赛。
 * 轮空自动晋级、不生成比赛；两侧都定下来才生成下一轮比赛。
 *
 * @param {{eventId:string, draw:Object, entrantsById:Map, matches:Array}} params
 * @returns {{ok:boolean, totalRounds:number, matches:Array}}
 */
function planExchangeMatches({ eventId, draw, entrantsById, matches } = {}) {
  const lookup = entrantsById instanceof Map ? entrantsById : new Map();
  const byId = new Map((matches || []).map((match) => [match._id, match]));
  const totalRounds = exchangeRoundCount(draw.size);
  // 叶子：位置 → 参赛者，null 记为轮空（decided 表示这一格不需要再等别人）
  let nodes = draw.slots.map((entry) => ({ entry: entry || '', decided: true }));
  const planned = [];
  for (let round = 1; round <= totalRounds; round += 1) {
    const next = [];
    for (let slot = 0; slot < nodes.length / 2; slot += 1) {
      const left = nodes[slot * 2];
      const right = nodes[slot * 2 + 1];
      if (!left.decided || !right.decided) {
        // 有一侧还在等上轮结果，这一场暂不生成
        next.push({ entry: '', decided: false });
      } else if (left.entry && right.entry) {
        const id = exchangeMatchKey(eventId, round, slot);
        const existing = byId.get(id);
        if (!existing) {
          const entrantOf = (userId) => lookup.get(userId) || {};
          planned.push({
            _id: id, eventId, round, slot,
            playerA: left.entry, playerB: right.entry,
            schoolA: entrantOf(left.entry).schoolId || '', schoolB: entrantOf(right.entry).schoolId || '',
            scoreA: null, scoreB: null, winner: '', status: 'pending',
            referee: '', refereeAt: null, refereeBy: '', recordedBy: '', recordedAt: null, revision: 1,
          });
        } else {
          planned.push(existing);
        }
        const advanced = existing && existing.status === 'active' && existing.winner ? existing.winner : '';
        next.push({ entry: advanced, decided: Boolean(advanced) });
      } else {
        // 至少一侧轮空：有人的一方直接晋级，不生成比赛
        next.push({ entry: left.entry || right.entry, decided: true });
      }
    }
    nodes = next;
  }
  return { ok: true, totalRounds, matches: planned };
}

/**
 * 由已确认比分推出名次。要求每一场都已生效。
 *
 * @param {{draw:Object, matches:Array}} params
 * @returns {{ok:true, results:Array<{userId:string, placement:number}>}|{ok:false, message:string}}
 */
function placementsFromExchange({ draw, matches } = {}) {
  const totalRounds = exchangeRoundCount(draw.size);
  const list = Array.isArray(matches) ? matches : [];
  for (const match of list) {
    if (match.status !== 'active' || !match.winner) return { ok: false, message: '还有比赛未确认比分' };
  }
  const finalMatch = list.find((match) => match.round === totalRounds && match.winner);
  if (!finalMatch) return { ok: false, message: '决赛尚未产生' };
  const table = new Map();
  for (const match of list) {
    const loser = match.winner === match.playerA ? match.playerB : match.playerA;
    if (!loser) return { ok: false, message: '比赛结果不完整' };
    table.set(loser, draw.size / Math.pow(2, match.round) + 1);
  }
  table.set(finalMatch.winner, 1);
  const results = [...table.entries()]
    .map(([userId, placement]) => ({ userId, placement }))
    .sort((a, b) => a.placement - b.placement || (a.userId < b.userId ? -1 : 1));
  return { ok: true, results };
}

module.exports = { exchangeMatchKey, exchangeRoundCount, planExchangeDraw, planExchangeMatches, placementsFromExchange };
