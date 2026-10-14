/**
 * 赛季回放引擎
 * ============================================================
 * 【它解决什么问题】
 * 比赛流水是「因」，等级分是「果」。这个模块把一段时间内的全部比赛
 * 按时间顺序重放一遍，从零开始逐场累加，让等级分自己「长出来」。
 *
 * 【为什么不让数据库直接存分数】
 * 分数是派生数据。只要比赛流水和算法确定，分数就唯一确定。反过来，
 * 一旦算法调参（比如把 K 值从 24 改成 20），只要重放一遍，历史分数
 * 立刻整体同步。这避免了「改了算法，老数据却停留在旧规则」的长期顽疾，
 * 也让「撤销一场比赛」这种操作有了严谨的实现方式——回滚后重放即可。
 *
 * 【同一套代码，两个用途】
 *   1. 本地：生成模拟数据，顺带验证生产算法（如果回放出的分数不收敛，
 *      说明参数有问题，立马就能发现）
 *   2. 云端：管理员撤销某场比赛后，重算受影响会员的分数
 *
 * 【为什么新人要「定级」而不是一律从初始分开始】
 * 老会员的分数已经散开（有人 1900，有人 1200）。一个真实水平 1900 的
 * 新人若从统一初始分起步，前几十场都在「收割」对手的分数，既让他自己长期
 * 显示错误分数，也让老会员莫名其妙掉分。所以中途入会的人要按他前
 * 几场打过的对手水平先定一个初始分，再往后正常累加。
 *
 * 【纯函数】
 * 不修改传入的 members / matches，全部在内部副本上运算。
 * 同一份输入永远得到同一份输出。
 * ============================================================
 */

const {
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  DEFAULT_EVENT_LEVEL,
  RATING_POOL,
  BRACKET_STAGE,
  ALL_RATING_POOLS,
} = require('../utils/constants.js');
const {
  calculateMatchRatings,
  calculatePlacementRating,
  initialRatingFor,
  DEFAULT_CONFIG,
} = require('../utils/elo.js');
const { createEmptyRatings, applyMatchResult } = require('../utils/rating.js');
const { calculateEventPoints, DEFAULT_POINT_CONFIG } = require('../utils/points.js');
const { applyTrainingPointFacts } = require('./training-points.js');

/**
 * 仅用于模拟、不对外暴露的字段。
 * trueSkill 是隐藏的真实水平，joinWeek 是模拟用的入会周次，
 * 两者都属于「造数据的手段」，不应出现在小程序能读到的数据里。
 */
const INTERNAL_FIELDS = ['trueSkill', 'joinWeek'];

/**
 * 阶段在同一时刻内的先后。
 * 只用于「同一轮」的比较：胜者组先于败者组（败者组接的是胜者组掉下来
 * 的人），总决赛最后。
 */
const STAGE_TIEBREAK = {
  [BRACKET_STAGE.WINNERS]: 0,
  [BRACKET_STAGE.MAIN]: 0,
  [BRACKET_STAGE.BRONZE]: 0,
  [BRACKET_STAGE.PLACEMENT]: 0,
  [BRACKET_STAGE.LOSERS]: 1,
  [BRACKET_STAGE.GRAND_FINAL]: 2,
};

/** 取一个可比较的数字，缺失 / 非法一律给 fallback */
function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 回放的排序比较器：先按时间，再把「同一时刻」排出一个确定的先后。
 *
 * 【为什么不能只比时间】
 * 一场赛事的全部签表比赛共用同一个 matchTime（抽签时统一取 event.startTime），
 * 所以「时刻相同」是常态而不是边角。而 Array#sort 只保证稳定——平局时保留
 * 入参顺序。入参顺序从哪来？云端是数据库的翻页扫描，没有任何顺序保证。
 * 于是同一批数据、两次读取可能给出不同的等级分：八进四的胜者若排在半决赛
 * 之后，那位选手就是按赛前分而不是八进四之后的分去打半决赛，期望胜率不同。
 * 这是「查不出来」的一类错误，必须堵死。
 *
 * 【平局时按什么排】
 *   1. 同一张签表内先比轮次——下一轮的人正是本轮打上来的，顺序反了分就错；
 *   2. 小组赛整段排在淘汰赛之前（小组赛喂出淘汰赛的对阵）；
 *   3. 同轮内先胜者组、后败者组、最后总决赛，让双败的轮次正确交错；
 *   4. 还平就比签位、比编号，保证任意两条记录都有确定的先后（全序）。
 *
 * 【为什么不比较「谁先被创建」】
 * 台账里没有可靠的创建序（云端翻页顺序本身就不稳，撤销又是就地改状态），
 * 拿它当依据等于把不确定性再引回来。签位与编号都是确定性的，够用。
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function compareForReplay(a, b) {
  const timeA = new Date(a && a.matchTime).getTime();
  const timeB = new Date(b && b.matchTime).getTime();
  // 时间缺失 / 非法的排到最后，且彼此之间仍由后面的字段定序
  const ta = Number.isFinite(timeA) ? timeA : Infinity;
  const tb = Number.isFinite(timeB) ? timeB : Infinity;
  if (ta !== tb) return ta - tb;

  // 不属于同一张签表的（含日常约球）互不依赖，给一个确定的次序即可
  const scopeA = (a && (a.eventId || a.collegeEventId)) || '';
  const scopeB = (b && (b.eventId || b.collegeEventId)) || '';
  if (scopeA !== scopeB) return scopeA < scopeB ? -1 : 1;

  const groupA = a && a.stage === BRACKET_STAGE.GROUP ? 0 : 1;
  const groupB = b && b.stage === BRACKET_STAGE.GROUP ? 0 : 1;
  if (groupA !== groupB) return groupA - groupB;

  const roundA = numOr(a && a.round, -1);
  const roundB = numOr(b && b.round, -1);
  if (roundA !== roundB) return roundA - roundB;

  const stageA = STAGE_TIEBREAK[a && a.stage];
  const stageB = STAGE_TIEBREAK[b && b.stage];
  const sa = stageA === undefined ? 0 : stageA;
  const sb = stageB === undefined ? 0 : stageB;
  if (sa !== sb) return sa - sb;

  const slotA = numOr(a && a.slot, -1);
  const slotB = numOr(b && b.slot, -1);
  if (slotA !== slotB) return slotA - slotB;

  const idA = String((a && a._id) || '');
  const idB = String((b && b._id) || '');
  if (idA === idB) return 0;
  return idA < idB ? -1 : 1;
}

/**
 * 把比赛按时间升序排列。
 *
 * 回放的正确性完全依赖这个顺序：先算后发生的比赛会让分数时序错乱，
 * 出现「赛前分数」对不上「上一场赛后分数」的诡异数据。同一时刻的先后
 * 见 compareForReplay——那里才是这个函数真正的难点。
 *
 * @param {Array<Object>} matches
 * @returns {Array<Object>} 升序排列的新数组
 */
function sortByTime(matches) {
  return [...matches].sort(compareForReplay);
}

/**
 * 判断某位会员是否属于「赛季开始后才入会」。
 *
 * 创始会员从他参加的第一场起就按性别拿到初始分（男 1450 / 女 1300），
 * 不需要定级；只有中途入会的人才适用「按前五场对手定级」的规则。
 * 判据用入会日期而不是「第几场出场」：一个人可能入会两周后才第一次上场，
 * 若按出场顺序判断，他会被误判成创始会员，从而错误地拿到按性别的初始分。
 *
 * @param {Object} member 会员记录，需含 joinDate
 * @param {number} seasonStartTime 赛季首场比赛的时间戳
 * @returns {boolean}
 */
function isLateJoiner(member, seasonStartTime) {
  if (!member.joinDate || !Number.isFinite(seasonStartTime)) {
    return false;
  }
  const joinTime = new Date(member.joinDate).getTime();
  if (!Number.isFinite(joinTime)) {
    return false;
  }
  // 严格大于：与赛季首场同时入会的人（含正好同一天的）算创始会员
  return joinTime > seasonStartTime;
}

/**
 * 管理员手工指定的初始等级分，没有则为 null。
 *
 * 【为什么它优先级最高】
 * 审核时填了分数，就等于管理员对这位会员的水平下了判断（老队员、外校
 * 交流生等）。此时再按「前五场对手」去猜一遍是多余的，而且头几场往往
 * 会把他定低。所以只要字段存在且是有限数值，就直接以它起步，
 * 完全跳过定级——男女初始分差异、对手水平一概不再参与。
 *
 * @param {Object} member 会员记录
 * @returns {number|null}
 */
function overriddenInitialElo(member) {
  const value = member && member.initialElo;
  return Number.isFinite(value) ? value : null;
}

/**
 * 按「定级期对手水平」为中途入会的会员算出初始分。
 *
 * 规则详见 elo.calculatePlacementRating：赢过谁就以谁为标杆，全败则以
 * 最弱的对手为标杆并封顶。这里负责的是「取哪些比赛、算哪些对手」。
 *
 * 【只看定级期内的比赛】
 * 取该会员在每个池里最早的前 placementMatchCount 场。之后的比赛发生在
 * 定级之后，不在定级依据之内——否则一个打了半年的新人会被重新定级，
 * 逻辑上说不通。
 *
 * 【对手分数取「当时」的值】
 * 用的是对手在那场比赛开打之前的分数，而不是回放结束后的分数。
 * 定级是对「入场时点」的估计，用未来数据定过去的级会造成穿越。
 *
 * 【被手工指定初始分的人直接跳过】
 * 见 overriddenInitialElo：管理员已经给了分数，这里再算一遍只会覆盖他的判断。
 *
 * @param {Object} params
 * @param {Array<Object>} params.members 会员列表
 * @param {Map<string, Map<string, Array<{opponentRating:number, won:boolean}>>>} params.observations
 *        第一遍回放采集到的定级观察：会员 → 池 → 定级期逐场记录
 * @param {string|Date} params.seasonStart 赛季首场比赛时间
 * @param {Object} [params.config] ELO 配置
 * @returns {Map<string, Map<string, number>>} 会员 → 池 → 定出的初始分
 */
function planInitialRatings({ members, observations, seasonStart, config = DEFAULT_CONFIG }) {
  const startTime = seasonStart ? new Date(seasonStart).getTime() : NaN;
  const presets = new Map();

  if (!Number.isFinite(startTime) || !observations) {
    return presets;
  }

  for (const member of members) {
    // 已被手工指定初始分的人不参与定级：既不必算，也不该出现在
    // meta.placements 里被误读成「按对手定出来的」
    if (overriddenInitialElo(member) !== null) continue;
    if (!isLateJoiner(member, startTime)) continue;

    const byPool = observations.get(member._id);
    if (!byPool) continue;

    const pools = new Map();
    for (const [poolName, entries] of byPool) {
      const within = entries.slice(0, config.placementMatchCount);
      const rating = calculatePlacementRating({
        opponentRatings: within.map((entry) => entry.opponentRating),
        beatenRatings: within
          .filter((entry) => entry.won)
          .map((entry) => entry.opponentRating),
        step: config.placementStep,
        // 全败者的封顶线是「他本人性别的初始分」，而不是全池统一的男会员初始分。
        // 否则一位一场未胜的女会员会被定到女会员初始分以上，反倒比同性别、
        // 同为新人的队友起点还高，规则就自相矛盾了。
        cap: initialRatingFor(member.gender, config),
      });

      if (rating !== null) {
        pools.set(poolName, rating);
      }
    }

    if (pools.size > 0) {
      presets.set(member._id, pools);
    }
  }

  return presets;
}

/**
 * 结算赛事积分：按赛事计一次，记在参赛者该赛事的最后一场上。
 *
 * 【积分不跟着每场比赛走】
 * 决策 9 把日常比赛的积分整个去掉了，赛事只剩「名次」这一个结算口径；
 * 而一场赛事要打好几轮，名次却是赛完才知道的。若逐轮给分，等于按
 * 「赢了几场」发钱，与「拿了第几名」脱钩。所以统一在赛事这一层结账，
 * 只认最终名次（2.5）。
 *
 * 【这里只管赛事积分】
 * 另一类积分来源——训练签到的积分事实——不在这里结算：它由
 * training-points.js 归一成事实，在 replaySeason 的两遍回放都跑完后
 * 对最终结果统一叠加一次（见该文件顶部注释）。
 *
 * 【为什么记在最后一场】
 * 页面上的「本场 +N 分」需要一个落脚点。参赛者在该赛事的最后一场，正是
 * 他的名次被决定的时刻——半决赛输的人记在半决赛，冠军记在决赛。这样
 * 「逐场明细之和 == 个人总分」这条不变式仍然成立。
 *
 * 【为什么跳过双打与往届赛事】
 *   双打 —— 决策 3：双打赛事不计分。
 *   往届 —— 2.6：积分每个赛季清零，只统计本赛季内已结束的赛事。
 * @param {Object} params
 * @param {Map<string, Object>} params.roster 会员工作副本
 * @param {Array<Object>} params.replayed 已回放的比赛（时间升序，带逐人明细）
 * @param {Array<Object>} params.events 赛事列表
 * @param {Object} params.config 积分配置
 * @param {number} params.resetMs 赛季分界时间戳；NaN 表示从未重置
 * @param {boolean} params.resetApplies 是否真的有分界点
 */
function applyEventPoints({ roster, replayed, events, config, resetMs, resetApplies }) {
  // 「会员 + 赛事」→ 该赛事最后一场在 replayed 里的下标
  const lastMatchIndex = new Map();
  replayed.forEach((match, index) => {
    if (!match.eventId) return;
    for (const player of match.players) {
      lastMatchIndex.set(`${player.userId}|${match.eventId}`, index);
    }
  });

  for (const event of events) {
    if (event.status !== EVENT_STATUS.FINISHED) continue;
    // 双打赛事不计分（决策 3）
    const isDoubles =
      event.matchType === MATCH_TYPE.DOUBLES || event.pool === RATING_POOL.DOUBLES;
    if (isDoubles) continue;

    // 赛季分界之前的赛事属于上一个赛季，不计入本赛季积分。
    // 「赛事什么时候结束」以录入名次那一刻（finishedAt）为准：app 里发布的
    // 赛事只有计划开赛时间 startTime，拿它当结束时间会把赛程与赛季对错——
    // 恰好跨在分界点两边的赛事会算进错误的赛季。历史 / 种子赛事没有
    // finishedAt，退回它的 endTime，再退回 startTime。
    const endedAt = new Date(event.finishedAt || event.endTime || event.startTime).getTime();
    if (resetApplies && Number.isFinite(endedAt) && endedAt < resetMs) continue;

    for (const result of event.results || []) {
      const user = roster.get(result.userId);
      if (!user) continue;

      const points = calculateEventPoints({
        placement: result.placement,
        level: event.level,
        config,
      });
      user.points += points.total;

      // 找不到落脚点也要发分：赛事分认的是「名次」这件事本身，而不是某一场
      // 已生效的比赛。赛事可以在一部分小场还没确认时就录名次收尾，这时冠军
      // 照样该拿分。上面那句「明细之和 == 总分」只在有比赛可挂时成立，别为了
      // 迁就它把没有明细的这笔分砍掉（tests/replay.test.js 守着这条）。
      const index = lastMatchIndex.get(`${result.userId}|${event._id}`);
      if (index === undefined) continue;

      const player = replayed[index].players.find((p) => p.userId === result.userId);
      if (player) player.pointDelta += points.total;
    }
  }
}

/**
 * 按时间顺序把比赛回放一遍。
 *
 * 这是被 replaySeason 调用两次的内部函数：
 *   第一遍不知道新人该定多少分，只能让所有人从初始分起步，顺便记下
 *   每个新人定级期遇到的对手分数；第二遍带着定好的初始分重算，
 *   让新人的分数从第一场起就是对的。
 *
 * @param {Object} params
 * @param {Object} params.elo 已合并默认值的 ELO 配置
 * @param {Map<string, Map<string, number>>} params.presets 预先定好的初始分
 * @param {boolean} params.collectPlacement 是否采集定级观察
 * @param {string|Date|null} [params.resetTime] 赛季分界点，只用来切积分；不传表示从未重置
 * @param {Array<{userId:string,pool:string,value:number,at:number|string|Date}>} [params.eloOverrides]
 *        手工改分时间线。每条表示「在 at 时刻把该会员该池的分数置为 value」，
 *        在回放途中按时间点插入，改分之后的比赛从 value 继续累加。
 * @returns {{users:Array, matches:Array, events:Array, meta:Object, observations:Map}}
 */
function runReplay({
  members,
  matches,
  events,
  elo,
  pointConfig,
  presets,
  collectPlacement,
  resetTime = null,
  eloOverrides = [],
}) {
  // ---------- 1. 准备工作副本 ----------
  // 所有运算都在副本上进行，调用方的数据一个字节都不会被改动。
  const roster = new Map();
  for (const member of members) {
    // 手工指定的初始分优先；没有才按性别取（男 1450 / 女 1300）。
    // 这一步和 settleInitial 必须用同一套判断，否则「尚未出场的档案分」
    // 与「首次登场后的真实起点」会对不上。
    const overridden = overriddenInitialElo(member);
    const baseElo = overridden !== null ? overridden : initialRatingFor(member.gender, elo);
    roster.set(member._id, {
      ...member,
      points: 0,
      ratings: createEmptyRatings({ initialElo: baseElo }),
      settled: {}, // 记录各池是否已经完成「定级」
    });
  }

  const resetMs = resetTime ? new Date(resetTime).getTime() : NaN;
  const resetApplies = Number.isFinite(resetMs);

  /**
   * 赛事等级表：eventId → level，供逐场回放时取赛事的固定 K（决策 13）。
   *
   * 历史赛事没有 level 字段，一律按三级补齐。三级 K 恰好等于常规 K（24），
   * 所以老数据的行为与加这条规则之前一致，不会出现「改个算法全站分数漂移」。
   */
  const eventLevelOf = new Map();
  for (const event of events || []) {
    const level = event.level === undefined || event.level === null
      ? DEFAULT_EVENT_LEVEL
      : event.level;
    eventLevelOf.set(event._id, level);
  }

  /** 定级观察：会员 → 池 → 定级期逐场记录 */
  const observations = new Map();

  /** 取某位会员在某个池的定级观察列表，没有就新建 */
  function observes(userId, poolName) {
    let byPool = observations.get(userId);
    if (!byPool) {
      byPool = new Map();
      observations.set(userId, byPool);
    }
    let slots = byPool.get(poolName);
    if (!slots) {
      slots = [];
      byPool.set(poolName, slots);
    }
    return slots;
  }

  /**
   * 会员首次在某个池登场时确定他的初始分。
   *
   * 有三种可能，优先级从高到低：
   *   1. 管理员手工指定的初始分——审核通过时填了 initialElo 的人，直接采用；
   *   2. 预设定级分——中途入会者按「前五场对手」规则定出来的分数；
   *   3. 按性别取的初始分——其余所有人（含创始会员、以及打过比赛但对手
   *      全是空缺、没能定出分数的极少数情况）。男会员 1450，女会员 1300。
   *
   * 这里刻意不再退回「当时池内会员的中位数」。定级规则的基准是初始分，
   * 若创始会员各自按首场时的池内中位数起步，每人起点会浮动十几分，
   * 既不满足「全员从统一初始分起步」的口径，也给分数比较平白添了一层噪声。
   *
   * 【为什么按池分别定级】
   * 一个人可能打了半年双打才第一次打单打。双打的经验不能直接折算成
   * 单打分数，所以单打仍应按「他首次打单打时」的单打池水平定级。
   *
   * @param {Object} user 会员工作副本
   * @param {string} poolName 等级分池
   */
  function settleInitial(user, poolName) {
    if (user.settled[poolName]) return;

    const memberPresets = presets.get(user._id);
    const placed = memberPresets ? memberPresets.get(poolName) : undefined;
    // 按优先级依次覆盖：性别初始分 < 按对手定级 < 管理员手工指定
    let initial = initialRatingFor(user.gender, elo);
    if (placed !== undefined) initial = placed;
    const overridden = overriddenInitialElo(user);
    if (overridden !== null) initial = overridden;

    user.ratings = {
      ...user.ratings,
      [poolName]: {
        ...user.ratings[poolName],
        elo: initial,
        // 记下入池起点，进步榜要用它算「涨了多少分」
        startElo: initial,
      },
    };
    user.settled[poolName] = true;
  }

  // ---------- 1.5 当前等级分覆盖（管理员 / 协会负责人手工改分）----------
  // 每条形如 {userId, pool, value, at}：在 at 时刻把该会员该池的分数直接置为 value。
  // 按 at 升序插入时间线——这样「改分之后的比赛」从 value 继续累加，而「改分
  // 之前已经打完的比赛」不受影响。若不按时间线（比如一律在最后覆盖），改分
  // 之后新录的比赛就会被无声地抹掉。
  const overrides = [...eloOverrides]
    .filter(
      (o) =>
        o &&
        roster.has(o.userId) &&
        ALL_RATING_POOLS.includes(o.pool) &&
        Number.isFinite(o.value)
    )
    .sort((a, b) => numOr(a.at, Infinity) - numOr(b.at, Infinity));
  let nextOverride = 0;

  /** 把一条覆盖落到会员工作副本上 */
  function applyEloOverride(user, override) {
    const current = user.ratings[override.pool];
    // 还没在该池出场过的人，起点分一并改掉——否则界面「入池 X 分」仍显示
    // 性别初始分，与看到的当前分对不上。
    const fresh = !user.settled[override.pool];
    user.ratings = {
      ...user.ratings,
      [override.pool]: {
        ...current,
        elo: override.value,
        startElo: fresh ? override.value : current.startElo,
      },
    };
    // 标记为已定级：否则该会员首次登场时 settleInitial 会把分数重置回
    // 性别初始分，这次改分就被悄悄抹掉了。
    user.settled[override.pool] = true;
  }

  /** 应用所有生效时刻 <= time 的覆盖 */
  function applyOverridesUpTo(time) {
    while (
      nextOverride < overrides.length &&
      numOr(overrides[nextOverride].at, Infinity) <= time
    ) {
      applyEloOverride(roster.get(overrides[nextOverride].userId), overrides[nextOverride]);
      nextOverride += 1;
    }
  }

  // ---------- 2. 按时间顺序逐场回放 ----------
  const ordered = sortByTime(matches);
  const replayed = [];

  for (const match of ordered) {
    const matchTime = new Date(match.matchTime).getTime();
    // 先应用「在本场之前生效」的改分，再算这场——顺序反了分数就错。
    // 时间缺失 / 非法的比赛排在最末（与 compareForReplay 一致），视为
    // 晚于一切改分。
    applyOverridesUpTo(Number.isFinite(matchTime) ? matchTime : Infinity);

    const poolName = MATCH_TYPE_TO_POOL[match.matchType];
    if (!poolName) {
      throw new Error(`比赛 ${match._id} 的比赛类型 ${match.matchType} 无法映射到等级分池`);
    }

    const teamA = match.teamA.map((id) => roster.get(id));
    const teamB = match.teamB.map((id) => roster.get(id));

    for (const [label, team] of [['A', teamA], ['B', teamB]]) {
      team.forEach((user, index) => {
        if (!user) {
          throw new Error(
            `比赛 ${match._id} 的 ${label} 队第 ${index + 1} 名会员不在会员名单中`
          );
        }
      });
    }

    // 首次登场者先定级，再参与本场计算
    for (const user of [...teamA, ...teamB]) {
      settleInitial(user, poolName);
    }

    // 赛前快照：必须在使用 applyMatchResult 之前取，否则会被覆盖
    const snapshot = (team) =>
      team.map((user) => ({
        rating: user.ratings[poolName].elo,
        matchCount: user.ratings[poolName].matchCount,
      }));

    const snapA = snapshot(teamA);
    const snapB = snapshot(teamB);

    // 定级观察必须在比赛结果落下去之前采集，否则拿到的是赛后分数
    if (collectPlacement) {
      const average = (items) =>
        items.reduce((sum, item) => sum + item.rating, 0) / items.length;

      // 双打时「对手的水平」用对方两人的平均分衡量：
      // 单打退化成对手本人的分数，双打则代表这一队的整体实力。
      const averageB = average(snapB);
      const averageA = average(snapA);

      const collect = (team, opponentAverage, side) => {
        const won = match.winner === side;
        for (const user of team) {
          // 已被手工指定初始分的人不需要定级样本，连采集都省掉
          if (overriddenInitialElo(user) !== null) continue;
          const slots = observes(user._id, poolName);
          if (slots.length >= elo.placementMatchCount) continue;
          slots.push({ opponentRating: opponentAverage, won });
        }
      };

      collect(teamA, averageB, 'A');
      collect(teamB, averageA, 'B');
    }

    const result = calculateMatchRatings({
      teamA: snapA,
      teamB: snapB,
      winner: match.winner,
      config: elo,
      // 赛事比赛按等级取固定 K；日常比赛没有 eventId，走统一 kStandard。
      // 学院赛的小场不属于个人赛的 events，等级直接写在记录上（一级 K=32），
      // 因此记录自带的 level 优先——它才是「这场比赛按几级算」的第一手依据。
      eventLevel:
        match.level !== undefined && match.level !== null
          ? match.level
          : match.eventId
            ? eventLevelOf.get(match.eventId)
            : undefined,
    });

    const players = [];

    /**
     * 把一支队伍的分数变动落实下去，并生成逐人明细。
     *
     * 【积分为什么是 0】
     * 日常比赛不产生积分（决策 9），赛事积分在全部比赛回放完后按名次
     * 统一结算（见 applyEventPoints），这里只先把明细的落脚点铺好。
     *
     * @param {Array<Object>} team 该队会员副本
     * @param {Array<Object>} deltas calculateMatchRatings 给出的变动量
     * @param {'A'|'B'} side 队伍标识
     */
    const settleTeam = (team, deltas, side) => {
      const isWin = match.winner === side;

      team.forEach((user, index) => {
        const eloBefore = user.ratings[poolName].elo;
        const delta = deltas[index].delta;

        user.ratings = applyMatchResult({
          user,
          pool: poolName,
          delta,
          isWin,
          matchTime: match.matchTime,
        });

        players.push({
          userId: user._id,
          side,
          pool: poolName,
          isWin,
          eloBefore,
          eloAfter: user.ratings[poolName].elo,
          eloDelta: delta,
          pointDelta: 0,
        });
      });
    };

    settleTeam(teamA, result.teamA, 'A');
    settleTeam(teamB, result.teamB, 'B');

    replayed.push({
      ...match,
      status: MATCH_STATUS.ACTIVE,
      pool: poolName,
      players,
      expectedA: result.expectedA,
      expectedB: result.expectedB,
    });
  }

  // 收尾：把「生效时刻晚于最后一场」的改分补上。改分往往发生在一场比赛
  // 之后（比如刚在外部打完比赛回来改分），若只靠循环内的调用，这类改分会
  // 被遗漏，导致改完分再刷新页面时分数又弹回旧值。
  applyOverridesUpTo(Infinity);

  // ---------- 2.5 结算赛事积分 ----------
  // 积分只能等所有比赛回放完才结：名次是赛事的最终结果，不逐场发（2.5）。
  applyEventPoints({ roster, replayed, events, config: pointConfig, resetMs, resetApplies });

  // ---------- 3. 整理输出 ----------
  // 内部模拟字段不进对外数据，否则「隐藏实力」就白藏了。
  const users = [...roster.values()].map((user) => {
    const clean = { ...user };
    for (const field of INTERNAL_FIELDS) {
      delete clean[field];
    }
    delete clean.settled;
    return clean;
  });

  const last = replayed.length > 0 ? replayed[replayed.length - 1] : null;

  return {
    users,
    matches: replayed,
    events: events.map((event) => ({ ...event })),
    observations,
    meta: {
      matchCount: replayed.length,
      userCount: users.length,
      eventCount: events.length,
      firstMatchTime: replayed.length > 0 ? replayed[0].matchTime : null,
      lastMatchTime: last ? last.matchTime : null,
    },
  };
}

/**
 * 回放整个赛季，逐场重算等级分与积分。
 *
 * 跑两遍：第一遍摸清每位中途入会者定级期遇到了哪些对手，据此定出
 * 初始分；第二遍带着定好的初始分正式回放。两遍之间比赛结果完全不变，
 * 变的只是新人的入场分数，因此不会出现「第一遍赢了第二遍输了」的错乱。
 *
 * @param {Object} params
 * @param {Array<Object>} params.members 会员列表，需含 _id
 * @param {Array<Object>} params.matches 比赛列表，含 matchType/teamA/teamB/winner/matchTime
 * @param {Array<Object>} [params.events] 赛事列表，原样透传
 * @param {Array<Object>} [params.announcements] 公告列表，原样透传
 * @param {Object} [params.options]
 * @param {Object} [params.options.eloConfig] 覆盖 ELO 参数（K 值、初始分等）
 * @param {Object} [params.options.pointConfig] 覆盖积分规则
 * @param {string|Date} [params.options.seasonStart] 钉死的赛季锚点；不传则取流水里最早一场
 * @param {string|Date|null} [params.options.resetTime] 赛季分界点，用来切积分；不传表示从未重置
 * @param {Array<Object>} [params.options.trainingPointFacts] 训练积分事实（training-points.buildTrainingPointFacts 的产物）
 * @param {Array<Object>} [params.options.eloOverrides] 手工改分时间线
 * @returns {{
 *   users: Array<Object>,
 *   matches: Array<Object>,
 *   events: Array<Object>,
 *   announcements: Array<Object>,
 *   meta: Object
 * }}
 *
 * @example
 * const { users, matches, meta } = replaySeason({ members, matches, events });
 * users[0].ratings.doubles.elo;   // 回放结束后的双打等级分
 * matches[0].players;             // 该场每位参赛者的赛前/赛后分数
 * meta.placements['u24'];         // 中途入会者定级时拿到的初始分
 */
function replaySeason({ members, matches, events = [], announcements = [], options = {} }) {
  if (!Array.isArray(members)) {
    throw new Error('replaySeason 的 members 必须是数组');
  }
  if (!Array.isArray(matches)) {
    throw new Error('replaySeason 的 matches 必须是数组');
  }

  const {
    eloConfig,
    pointConfig = DEFAULT_POINT_CONFIG,
    seasonStart,
    resetTime = null,
    eloOverrides = [],
    // 训练积分事实（见 training-points.js）。默认空数组，旧调用行为不变。
    trainingPointFacts = [],
  } = options;

  // 先把 ELO 参数合并成一份完整配置再使用。
  // 否则 initialRating 这类「只在别处被读一次」的参数会被悄悄忽略——
  // 调用方以为改了初始分，实际上所有人还是从默认值起步。
  const elo = { ...DEFAULT_CONFIG, ...(eloConfig || {}) };

  const base = { members, matches, events, elo, pointConfig, resetTime, eloOverrides };

  // 第一遍：所有人从初始分起步，采集新人的定级依据
  const probe = runReplay({ ...base, presets: new Map(), collectPlacement: true });

  // 赛季锚点。默认取本次流水里最早的一场；云端会传入一个钉死的值。
  //
  // 为什么非要能钉死：锚点决定谁是「创始会员」、谁是「中途入会者」。
  // 若它跟着流水浮动，撤销最早那场比赛就会让锚点后移，把原本的创始会员
  // 重新判定成中途入会者，于是多人被全新定级、分数静默改变。
  const resolvedSeasonStart =
    seasonStart !== undefined && seasonStart !== null
      ? new Date(seasonStart)
      : probe.meta.firstMatchTime;

  // 按「前五场对手」规则定出中途入会者的初始分
  const presets = planInitialRatings({
    members,
    observations: probe.observations,
    seasonStart: resolvedSeasonStart,
    config: elo,
  });

  // 第二遍：带着定好的初始分正式回放
  const final = runReplay({ ...base, presets, collectPlacement: false });

  // 训练积分：只在两遍回放都完成后，对最终结果统一叠加一次。
  // 不放进 runReplay 内部——那里每遍都会跑到，训练分会被重复累加。
  // 叠加只改 points，不碰等级分 / 场数 / 胜率（见 training-points.js）。
  const users = applyTrainingPointFacts(final.users, trainingPointFacts, { resetTime });

  return {
    users,
    matches: final.matches,
    events: final.events,
    // 公告与计分无关，回放不碰它，只原样透传，避免在门面这一层被丢掉
    announcements: announcements.map((item) => ({ ...item })),
    meta: {
      ...final.meta,
      // 实际使用的赛季锚点，可能是调用方钉死的，也可能是流水里最早一场
      seasonStart: resolvedSeasonStart,
      // 赛季分界点，界面据此说明「本赛季从哪一刻起算」
      resetTime: resetTime || null,
      // 定级结果对外公开，界面可以解释「你的初始分是怎么来的」
      placements: Object.fromEntries(
        [...presets].map(([userId, pools]) => [userId, Object.fromEntries(pools)])
      ),
    },
  };
}

module.exports = {
  INTERNAL_FIELDS,
  compareForReplay,
  sortByTime,
  isLateJoiner,
  planInitialRatings,
  replaySeason,
};
