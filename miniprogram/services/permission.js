/**
 * 管理权限的公共判定
 * ============================================================
 * 「谁能管这件事」在项目里已经出现两处：审核入会申请、发布与管理公告。
 * 两处的规则一字不差，只是管的事不同，所以把判定抽到这里，各业务模块
 * 只声明自己需要的门槛。
 *
 * 【为什么 isMock 要放宽】
 * 种子里 24 位会员的 role 全是普通会员（seed.js 里写死为 0），没有干事、
 * 没有管理员。严格按 role >= STAFF 判定的话，本地任何一次审核、任何一条
 * 公告都永远做不了，这两条链路在演示数据源里就是死的。
 * 所以 mock 下放宽为「已登录且审核通过的会员即可」，但界面必须把这一点
 * 明示出来（见各视图模型的 demoNotice），免得把演示口径当成正式规则。
 *
 * 【为什么不在页面里判】
 * 页面里写 `user.role >= 1` 这种判断，Node 跑不了，等于没法测；而且
 * 权限判断一旦散到多个页面，漏改一处就是一个越权漏洞。集中在这里，
 * 每一条边界都能用字面量钉死。
 * ============================================================
 */

const { ROLE, USER_STATUS } = require('../utils/constants.js');

/**
 * 账号是否处于可用状态。
 * 待审核的账号自己还没转正，不能去管别人——否则刚注册的人就能盖章。
 *
 * @param {Object|null} actor
 * @returns {boolean}
 */
function isActive(actor) {
  return Boolean(actor) && actor.status === USER_STATUS.ACTIVE;
}

/**
 * 有没有管理资格。
 *
 * @param {Object|null} actor 操作者
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false] 演示数据源下放宽为「是会员即可」
 * @param {number} [options.minRole=ROLE.STAFF] 正式环境要求的角色门槛
 * @returns {boolean}
 */
function canManage(actor, options = {}) {
  const { isMock = false, minRole = ROLE.STAFF } = options;

  if (!isActive(actor)) return false;
  if (isMock) return true;

  return Number(actor.role || 0) >= minRole;
}

module.exports = {
  isActive,
  canManage,
};
