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
} = require('../utils/constants.js');
const {
  calculateMatchRatings,
  calculatePlacementRating,
  applySeasonalReset,
  initialRatingFor,
  DEFAULT_CONFIG,
} = require('../utils/elo.js');
const { createEmptyRatings, applyMatchResult } = require('../utils/rating.js');
const { calculateEventPoints, DEFAULT_POINT_CONFIG } = require('../utils/points.js');

/**
 * 仅用于模拟、不对外暴露的字段。
 * trueSkill 是隐藏的真实水平，joinWeek 是模拟用的入会周次，
 * 两者都属于「造数据的手段」，不应出现在小程序能读到的数据里。
 */
const INTERNAL_FIELDS = ['trueSkill', 'joinWeek'];

/**
 * 把比赛按时间升序排列。
 *
 * 回放的正确性完全依赖这个顺序：先算后发生的比赛会让分数时序错乱，
 * 出现「赛前分数」对不上「上一场赛后分数」的诡异数据。
 *
 * @param {Array<Object>} matches
 * @returns {Array<Object>} 升序排列的新数组
 */
function sortByTime(matches) {
  return [...matches].sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime));
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
 * 【为什么积分不跟着每场比赛走】
 * 决策 9 把日常比赛的积分整个去掉了，积分只剩赛事一个来源；而一场赛事
 * 要打好几轮，名次却是赛完才知道的。若逐轮给分，等于按「赢了几场」发钱，
 * 与「拿了第几名」脱钩。所以统一在赛事这一层结账，只认最终名次（2.5）。
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
 * @param {string|Date|null} [params.resetTime] 赛季软重置的分界点；不传表示从未重置
 * @param {Object|null} [params.resetPolicy] 软重置参数 {anchorRating, retentionFactor}
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
  resetPolicy = null,
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
      settledAt: {}, // 各池首次登场的时刻，用来判断是否在软重置之前就已入池
      resetApplied: {}, // 各池是否已经跨过软重置的分界
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
   * @param {string|Date} matchTime 本场时间，用来判断入池发生在软重置之前还是之后
   */
  function settleInitial(user, poolName, matchTime) {
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
    user.settledAt[poolName] = new Date(matchTime).getTime();
  }

  /**
   * 在赛季分界处对某个池做软重置：分数向锚定分回归，且**起点分同步刷新**。
   *
   * 【为什么起点分也要刷新】
   * 进步榜比的是「相对赛季初涨了多少分」。重置后若起点分还停在入池时的
   * 老分数，涨幅就会把上一个赛季的积累一并算进去——赛季初人人"暴涨"。
   * 把起点刷成重置后的分数，新赛季的进步才从这一刻重新起算。
   *
   * 【为什么要挡住两类人】
   *   - 从没在这个池出过场：分数就是初始分，重置它没有意义；
   *   - 分界之后才首次入池：他的起点本来就是本赛季的分数，再压一次等于扣分。
   *
   * @param {Object} user 会员工作副本
   * @param {string} poolName 等级分池
   */
  function applySeasonReset(user, poolName) {
    if (!resetApplies) return;
    if (user.resetApplied[poolName]) return;
    user.resetApplied[poolName] = true;

    const rating = user.ratings[poolName];
    if (!rating || rating.matchCount === 0) return;
    if (!(user.settledAt[poolName] < resetMs)) return;

    const squashed = applySeasonalReset(rating.elo, {
      anchorRating: resetPolicy ? resetPolicy.anchorRating : undefined,
      retentionFactor: resetPolicy ? resetPolicy.retentionFactor : undefined,
    });

    user.ratings = {
      ...user.ratings,
      [poolName]: { ...rating, elo: squashed, startElo: squashed },
    };
  }

  // ---------- 2. 按时间顺序逐场回放 ----------
  const ordered = sortByTime(matches);
  const replayed = [];

  for (const match of ordered) {
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
      settleInitial(user, poolName, match.matchTime);
    }

    // 跨过赛季分界的第一场：先做软重置，再算本场。
    // 顺序不能反——必须等 settleInitial 记下入池时刻，才能分清谁是
    // 「重置前就在打」的老会员，谁是「本赛季才入池」的新人。
    if (resetApplies && new Date(match.matchTime).getTime() >= resetMs) {
      for (const user of [...teamA, ...teamB]) applySeasonReset(user, poolName);
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

  // 重置之后一场没打的人也要压分：否则「赛季初人人回归锚定分」这条规则
  // 只对继续参赛的人生效，停了几个月的老会员反倒躲过了重置。
  if (resetApplies) {
    for (const user of roster.values()) {
      for (const poolName of Object.keys(user.ratings)) {
        applySeasonReset(user, poolName);
      }
    }
  }

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
    delete clean.settledAt;
    delete clean.resetApplied;
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
 * @param {string|Date|null} [params.options.resetTime] 赛季软重置分界点；不传表示从未重置
 * @param {Object|null} [params.options.resetPolicy] 软重置参数 {anchorRating, retentionFactor}
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
    resetPolicy = null,
  } = options;

  // 先把 ELO 参数合并成一份完整配置再使用。
  // 否则 initialRating 这类「只在别处被读一次」的参数会被悄悄忽略——
  // 调用方以为改了初始分，实际上所有人还是从默认值起步。
  const elo = { ...DEFAULT_CONFIG, ...(eloConfig || {}) };

  const base = { members, matches, events, elo, pointConfig, resetTime, resetPolicy };

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

  return {
    users: final.users,
    matches: final.matches,
    events: final.events,
    // 公告与计分无关，回放不碰它，只原样透传，避免在门面这一层被丢掉
    announcements: announcements.map((item) => ({ ...item })),
    meta: {
      ...final.meta,
      // 实际使用的赛季锚点，可能是调用方钉死的，也可能是流水里最早一场
      seasonStart: resolvedSeasonStart,
      // 软重置分界点，界面据此说明「本赛季从哪一刻起算」
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
  sortByTime,
  isLateJoiner,
  planInitialRatings,
  replaySeason,
};
