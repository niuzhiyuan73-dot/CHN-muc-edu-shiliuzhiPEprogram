/**
 * 赛季重置 —— 权限与参数
 * ============================================================
 * 「做一次赛季软重置」要回答两个问题，答案都在这里：
 *   1. 我有没有资格做？（权限）
 *   2. 按什么参数做？（重置策略）
 *
 * 【为什么单独成模块】
 * 与 announcement.js / member-review.js 同一套路数：纯判断，不碰 wx、
 * 不碰数据源，于是每一条边界都能用字面量在 Node 里钉死。云端与本地
 * 共用同一份，免得两边的重置参数各写各的、分数对不上。
 *
 * 【为什么门槛比发布公告高】
 * 发布公告错了，撤下来即可；软重置会把全俱乐部所有人的分数按公式压
 * 一遍，影响面大且不易察觉。因此这里要求 ROLE.ADMIN，而不是公告用的
 * ROLE.STAFF。
 * ============================================================
 */

const { ROLE } = require('../utils/constants.js');
const { DEFAULT_CONFIG } = require('../utils/elo.js');
const { canManage } = require('./permission.js');

/**
 * 默认软重置策略。
 *
 * 保留系数 0.75、锚定分取 ELO 的初始分（默认 1450）：
 * 1900 → 1788，1200 → 1263。全员向 1450 靠拢，但强弱相对顺序不变。
 * 锚定分从 elo.js 取，而不是在这里再抄一个 1450——两边分叉过一次，
 * 重置出来的分数就会与算法基准对不上。
 */
const DEFAULT_RESET_POLICY = {
  retentionFactor: 0.75,
  anchorRating: DEFAULT_CONFIG.initialRating,
};

/**
 * 有没有执行赛季重置的资格。
 *
 * 与审核、公告共用 permission.canManage，只把门槛抬到 ADMIN——
 * 不另写一套判定，免得某天权限规则改了这两处还各说各话。
 *
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false] mock 下放宽为「已登录的正常会员即可」
 * @returns {boolean}
 */
function canResetSeason(actor, options = {}) {
  return canManage(actor, { ...options, minRole: ROLE.ADMIN });
}

module.exports = {
  DEFAULT_RESET_POLICY,
  canResetSeason,
};
