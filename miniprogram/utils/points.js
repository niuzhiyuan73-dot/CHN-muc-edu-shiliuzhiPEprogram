/**
 * 积分算法
 * ============================================================
 * 等级分（elo.js）回答「你有多强」，积分回答「你有多投入」。
 * 两者并行展示：等级分用于实力排名，积分用于激励持续参与。
 *
 * 与等级分不同，积分是「非零和」的——每个人都能通过参赛累积积分，
 * 这正是设计意图：让水平一般的会员也有持续参与的动力。
 * ============================================================
 */

/**
 * 默认积分规则，对应策划书表 4-2。
 * 所有数值均可通过参数覆盖，便于运营期调整。
 */
const DEFAULT_POINT_CONFIG = {
  /** 获胜基础分 */
  win: 3,
  /** 落败基础分：不为 0，鼓励参与 */
  loss: 1,
  /** 报名并现场签到参加正式赛事 */
  eventParticipate: 2,
  /** 连胜奖励：达到触发场次后，每场额外加分 */
  streakBonusPerWin: 1,
  /** 连胜奖励的触发场次 */
  streakBonusThreshold: 3,
  /** 连胜奖励上限 */
  streakBonusMax: 3,
  /** 无故缺席已报名赛事 */
  absencePenalty: -2,
};

/**
 * 计算连胜奖励。
 *
 * 规则：连胜达到 3 场后开始触发，第 3 场 +1，第 4 场 +2，第 5 场及以后 +3（封顶）。
 * 连胜中断后重新计数。
 *
 * @param {number} currentStreak 含本场在内的当前连胜数
 * @param {Object} config 积分配置
 * @returns {number} 本场连胜奖励分
 */
function calculateStreakBonus(currentStreak, config = DEFAULT_POINT_CONFIG) {
  if (currentStreak < config.streakBonusThreshold) {
    return 0;
  }
  const bonus = (currentStreak - config.streakBonusThreshold + 1) * config.streakBonusPerWin;
  return Math.min(bonus, config.streakBonusMax);
}

/**
 * 计算一场比赛带来的积分变动。
 *
 * @param {Object} params
 * @param {boolean} params.isWin 本场是否获胜
 * @param {number} [params.currentStreak=0] 含本场在内的连胜场次（仅胜场有效）
 * @param {boolean} [params.isEvent=false] 是否为正式赛事（而非日常约球）
 * @param {Object} [params.config] 可选配置覆盖
 * @returns {{base: number, streakBonus: number, eventBonus: number, total: number}}
 *
 * @example
 * // 日常约球，3 连胜中的第 3 场
 * calculateMatchPoints({ isWin: true, currentStreak: 3 });
 * // => { base: 3, streakBonus: 1, eventBonus: 0, total: 4 }
 */
function calculateMatchPoints({
  isWin,
  currentStreak = 0,
  isEvent = false,
  config: userConfig,
}) {
  const config = { ...DEFAULT_POINT_CONFIG, ...(userConfig || {}) };

  const base = isWin ? config.win : config.loss;
  // 连胜奖励只在获胜时计算，输球不扣连胜奖励（连胜本身已中断）
  const streakBonus = isWin ? calculateStreakBonus(currentStreak, config) : 0;
  const eventBonus = isEvent ? config.eventParticipate : 0;

  return {
    base,
    streakBonus,
    eventBonus,
    total: base + streakBonus + eventBonus,
  };
}

/**
 * 计算连胜场次。
 *
 * 传入按时间倒序（最近的在前）排列的胜负记录，从最近一场开始数，
 * 连续获胜的场次数即为当前连胜。遇到第一场失利立即停止。
 *
 * @param {Array<{isWin: boolean}>} recentMatchesDesc 按时间倒序的最近战绩
 * @returns {number} 当前连胜场次
 *
 * @example
 * calculateStreak([{isWin:true},{isWin:true},{isWin:false}]) // => 2
 */
function calculateStreak(recentMatchesDesc) {
  let streak = 0;
  for (const match of recentMatchesDesc) {
    if (!match.isWin) break;
    streak += 1;
  }
  return streak;
}

module.exports = {
  DEFAULT_POINT_CONFIG,
  calculateStreakBonus,
  calculateMatchPoints,
  calculateStreak,
};
