/**
 * 防刷分：同一对会员每赛季计入等级分的场次上限
 * ============================================================
 * 【要解决什么】
 * 日常约球没有门槛，两个人可以一周内互录二十场。赢的那个的等级分会被
 * 同一份对阵反复推高——分数反映的不再是水平，而是约球次数。赛事刷不出来
 * （有名次、有赛程、有裁判），所以这条上限只管日常。
 *
 * 【规则】
 *   - 一对会员、一个赛季，最多 RATED_PAIR_LIMIT 场自行录入的比赛计入等级分；
 *   - 「自行录入」= 没有 eventId / collegeEventId / tieId（见 isCasualMatch）；
 *   - 双打按**跨队无序对**算：一队两人对对手两人，四组组合各记一场，
 *     且 (甲,乙) 与 (乙,甲) 是同一个人对，不重复计数；
 *   - 超限的比赛**照常记在台账里**（比赛记录页仍查得到），但不进等级分，
 *     也不出现在成绩公示与逐场战绩里——与弃权同一路数。防刷分要防的是分数
 *     被刷高，不是否认这场球发生过；可只要进了流水就会带出一条分数变化，
 *     所以「不计分」与「不入流水」在这里是同一件事。
 *
 * 【为什么是「整个赛季」】
 * 赛季分界点（season.resetTime）之前的场次属于上一个赛季，不占本赛季名额。
 * 从未开始过新赛季时，全部流水都算本赛季。等级分本身不随赛季重置，
 * 这里的计数却是按赛季重来的——两件事互不影响。
 *
 * 【为什么待确认的场次也要占名额】
 * 只数已生效的话，两个人可以连录 15 场等对手逐一确认，全部生效后上限就被
 * 绕过去了。因此提交即占名额，被驳回或撤销（REVOKED）才释放。
 *
 * 【为什么在回放之前算，而不是边回放边算】
 * 「哪些比赛算数」这一类判断全部集中在数据层（derive.js / mock.js 的
 * activeOnly），与 isEloEligibleMatch 并列。回放引擎只管拿到比赛算分数，
 * 不必知道防刷分这件事，改规则也不会碰算法代码。
 *
 * 【纯函数】
 * 不碰 wx、不读数据库、不看当前时间；同样的输入永远给同样的输出。
 * 因此可以在 Node 里用字面量把每一条边界钉死。
 * ============================================================
 */

const { MATCH_STATUS, RATED_PAIR_LIMIT } = require('../utils/constants.js');
const { compareForReplay } = require('./replay.js');

/**
 * 一场比赛是不是「自行录入的」（日常约球）。
 *
 * 赛事比赛带 eventId，学院赛小场带 collegeEventId + tieId。三者全空才是
 * 会员自己录的日常球。这三种身份任一存在都说明它在某个组织框架内进行，
 * 有赛程与名次兜底，刷不出来，因此不设上限。
 *
 * @param {Object} match
 * @returns {boolean}
 */
function isCasualMatch(match) {
  if (!match) return false;
  return !match.eventId && !match.collegeEventId && !match.tieId;
}

/**
 * 两个人对的无序键。甲乙与乙甲必须是同一个键，否则同一对会被算成两对。
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 一场比赛的跨队无序对。
 *
 * 单打（1 对 1）：一组。
 * 双打（2 对 2）：四组——甲丙、甲丁、乙丙、乙丁。
 *
 * 同队两人之间不算对：他们没交手，不会因为配合得好坏影响彼此的分数关系。
 *
 * @param {Object} match
 * @returns {string[]} 无序对键列表；队伍数据不完整时返回空数组
 */
function crossPairs(match) {
  const teamA = (match && match.teamA) || [];
  const teamB = (match && match.teamB) || [];
  const keys = [];
  for (const a of teamA) {
    for (const b of teamB) {
      if (a === undefined || a === null || b === undefined || b === null) continue;
      keys.push(pairKey(String(a), String(b)));
    }
  }
  return keys;
}

/**
 * 找出所有「超出对阵上限、不计入等级分」的比赛。
 *
 * 按回放同款顺序逐场推进（compareForReplay）：每一场先看它涉及的各对新名额
 * 是否还有剩余，还有就正常记账并扣名额，没有就判为超限。
 * 顺序必须与回放一致——否则「哪一场是被挤掉的那一场」会随排序抖动，
 * 同一天的先后会不稳定。
 *
 * 【双打为什么整场作废】
 * 四组对里只要有一组已经打满，这场就不能计分：一队的分数变动是四人共用
 * 同一个 delta（策划书 4.2 节的公平性要求），没法只给其中几对记账。
 * 与其造一个「半算半不算」的口径，不如整场不计——规则简单，解释得清。
 *
 * @param {Array<Object>} matches 全量比赛流水（含待确认与已撤销）
 * @param {Object} [options]
 * @param {string|Date|null} [options.seasonStart] 本赛季分界点；不传表示从未开始过新赛季
 * @param {number} [options.limit=RATED_PAIR_LIMIT] 每对每赛季的上限
 * @returns {Set<string>} 超限比赛的 _id 集合
 */
function findCappedMatchIds(matches, { seasonStart = null, limit = RATED_PAIR_LIMIT } = {}) {
  const capped = new Set();
  if (!Array.isArray(matches) || matches.length === 0) return capped;
  if (!Number.isFinite(limit) || limit <= 0) return capped;

  const startMs =
    seasonStart === null || seasonStart === undefined ? NaN : new Date(seasonStart).getTime();
  const hasSeasonStart = Number.isFinite(startMs);

  /** 无序对键 → 本赛季已占用的名额 */
  const used = new Map();

  for (const match of [...matches].sort(compareForReplay)) {
    // 撤销 / 驳回的场次不占名额，也不参与计数——名额被释放出来给后来的场次
    if (!match || match.status === MATCH_STATUS.REVOKED) continue;

    // 赛事不设上限，也不占日常的名额
    if (!isCasualMatch(match)) continue;

    const timeMs = new Date(match.matchTime).getTime();
    if (!Number.isFinite(timeMs)) continue;
    // 分界点之前的场次属于上一个赛季
    if (hasSeasonStart && timeMs < startMs) continue;

    const pairs = crossPairs(match);
    if (pairs.length === 0) continue;

    const exceeded = pairs.some((key) => (used.get(key) || 0) >= limit);
    if (exceeded) {
      capped.add(String(match._id));
      continue;
    }

    for (const key of pairs) used.set(key, (used.get(key) || 0) + 1);
  }

  return capped;
}

module.exports = {
  isCasualMatch,
  pairKey,
  crossPairs,
  findCappedMatchIds,
};
