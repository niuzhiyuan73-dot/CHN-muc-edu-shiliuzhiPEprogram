/**
 * 管理权限的公共判定
 * ============================================================
 * 「谁能管这件事」在项目里已经出现两处：审核入会申请、发布与管理公告。
 * 两处的规则一字不差，只是管的事不同，所以把判定抽到这里，各业务模块
 * 只声明自己需要的门槛。
 *
 * 【为什么不再为演示数据源放宽】
 * 早先种子里 24 位会员的 role 全是普通会员，严格判定会让本地任何一次审核、
 * 任何一条公告都做不了，于是 mock 下放宽成「是会员就能管」。代价是本地看到
 * 的权限规则与云端不是一套：普通会员在自己手机上也看得见审核、公告管理、
 * 赛季重置、发布赛事这些入口，而线上他们一个都点不到。
 * 现在种子里已经有干事（张宇轩 u02）与管理员（巴特尔 u01），放宽就没有
 * 存在的理由了——判定只剩角色一条，本地与云端完全一致。要在本地演示管理
 * 功能，把 mock.js 的 DEFAULT_CURRENT_USER_ID 换成 'u01' / 'u02' 即可。
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
 * 判定只看角色，与数据源无关——本地与云端走的是同一条规则。
 *
 * @param {Object|null} actor 操作者
 * @param {Object} [options]
 * @param {number} [options.minRole=ROLE.STAFF] 要求的角色门槛
 * @returns {boolean}
 */
function canManage(actor, options = {}) {
  const { minRole = ROLE.STAFF } = options;

  if (!isActive(actor)) return false;

  return Number(actor.role || 0) >= minRole;
}

/**
 * 有没有资格管理某个学院。
 *
 * 干事即「学院负责人」，其权限是有范围的：只能管自己所属的那个学院。
 * 管理员没有范围限制，全校通行。判定同时在两处成立才放行：
 *   1. 账号本身可用（已激活）；
 *   2. 角色够，且——干事的 college 与目标学院一致。
 *
 * 【为什么学院名必须精确相等】
 * 学院全名同时是学院团体赛的对阵主键（见 constants.COLLEGES 的说明）。
 * 若做成「包含」「前缀」之类的宽松匹配，「体育学院」的干事就可能被放进
 * 「体育学院附属体校」，这类越权在赛场上没有明显的报错，只会悄悄改错名单。
 * 所以这里要求两边都取自同一份常量名单后的严格相等。
 *
 * @param {Object|null} actor 操作者
 * @param {string} college 目标学院全名
 * @returns {boolean}
 */
function managesCollege(actor, college) {
  if (!isActive(actor)) return false;

  const role = Number(actor.role || 0);
  if (role >= ROLE.ADMIN) return true;

  return role >= ROLE.STAFF && Boolean(college) && actor.college === college;
}

module.exports = {
  isActive,
  canManage,
  managesCollege,
};
