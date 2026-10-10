/**
 * 调用上下文
 * ============================================================
 * 【身份只认 OpenID，不认前端传的 actor】
 * cloud.js 的注释写得很明白：前端传上来的 actor 只是个提示，可能是任何
 * 字符串。真正的身份由 wx-server-sdk 的 getWXContext() 给出，服务端拿
 * 它回查 users 集合，查到的才是可信账号。否则改一个 role:2 就能凭空
 * 变成管理员——权限校验在服务端做的意义就没了。
 *
 * 【isMock 恒为 false】
 * mock 数据源为了让演示流程走得通，把确认、审核、发布都放宽成「登录即可」
 * （见 permission.js 的说明）。那是演示口径，云端一律走严格规则：
 * 确认限对手方、审核与公告限 role >= STAFF、管理员才能撤别人的比赛。
 * ============================================================
 */

const { ROLE, USER_STATUS, ASSOC_ROLE } = require('../../lib/utils/constants.js');
const { membershipKey } = require('./idempotency.js');
const { defaultAssociationId } = require('../../lib/utils/associations.js');

/**
 * 由「账号全局角色」与「本协会成员角色」解出本次调用的**有效角色**。
 *
 * 【为什么协会负责人算作 ADMIN】
 * 协会负责人「管理本协会全部内容」，与管理员在本协会内同权。把它的有效角色
 * 直接算成 ADMIN，既有 `canManage(actor, { minRole: ADMIN })` 一行不用改就放行。
 * 真正需要区分「全局管理员 / 协会负责人」的地方（任免协会负责人）只认
 * `ctx.globalRole`，绝不走 `canManage`——见施工方案 §3.4 的安全红线。
 *
 * 【为什么账号上的 STAFF 不再直接生效】
 * 改造后 `users.role` 只承载全局角色（MEMBER / ADMIN）；学院负责人改记在
 * `memberships` 里。改造前的旧账号（role=1）由迁移脚本拆成成员行，拆完之前
 * 它们在云端一律按会员处理——这不会误伤线上，因为 P1–P6 是同批上线。
 *
 * @param {number} globalRole 账号原始全局角色
 * @param {Object|null} membership 本协会成员行（可空）
 * @returns {number} ROLE.MEMBER / ROLE.STAFF / ROLE.ADMIN
 */
function effectiveRole(globalRole, membership) {
  if (Number(globalRole) >= ROLE.ADMIN) return ROLE.ADMIN;
  const role = membership && membership.role;
  if (role === ASSOC_ROLE.LEADER) return ROLE.ADMIN;
  if (role === ASSOC_ROLE.STAFF) return ROLE.STAFF;
  return ROLE.MEMBER;
}

/**
 * 组装一次调用的上下文。
 *
 * @param {Object} params
 * @param {Object} params.repo 仓储
 * @param {string} [params.openId] 微信 OpenID
 * @param {Date} [params.now] 当前时间，便于测试注入
 * @param {string} [params.association] 本次调用的协会 id；缺省取兜底协会
 * @returns {Promise<Object>} 上下文对象
 */
async function buildContext({ repo, openId = '', now = new Date(), association = '' }) {
  const actor = openId ? await repo.users.getByOpenId(openId) : null;
  const assoc = association || defaultAssociationId();

  // 成员行只在「该账号在本协会有高配角色」时存在（见施工方案 §3.2）；
  // 无行 = 普通会员。仓储没有 memberships 时（老夹具）按无行处理。
  let membership = null;
  if (actor && repo.memberships && typeof repo.memberships.get === 'function') {
    membership = (await repo.memberships.get(membershipKey(actor._id, assoc))) || null;
  }

  const globalRole = actor ? Number(actor.role || 0) : ROLE.MEMBER;
  const role = effectiveRole(globalRole, membership);

  return {
    repo,
    openId,
    now,
    association: assoc,
    // 覆盖为有效角色，既有 canManage / managesCollege 调用零改动即按新语义运行
    actor: actor ? { ...actor, role } : null,
    actorId: actor ? actor._id : '',
    role,
    globalRole,
    membership,
    isGlobalAdmin: globalRole >= ROLE.ADMIN,
    // 云端永不放宽权限，这个字段存在是为了让共享的纯逻辑函数能收到一个
    // 明确的值，而不是 undefined
    isMock: false,
  };
}

/**
 * 账号状态不可用时，给用户一句能看懂的说法。
 * 待审核的人还没转正、已禁用的人被停用、已离校的人不该再产生新数据——
 * 三者卡住的原因不同，分开措辞用户才知道下一步该做什么。
 *
 * @param {number} status
 * @returns {string}
 */
function statusMessage(status) {
  if (status === USER_STATUS.PENDING) return '账号还在审核中，通过后才能操作';
  if (status === USER_STATUS.LEFT) return '账号已离校，不能进行此操作';
  return '账号已被停用，请联系管理员';
}

/**
 * 写操作的前置检查：调用者得是个状态正常的账号。
 *
 * 【为什么状态也要在这里挡】
 * 只查「有没有账号」是不够的：账号被驳回、被停用或离校之后，文档还在，
 * 按 OpenID 依然查得到。如果这里放行，一个已被停用的人照样能报名、录分、
 * 发公告——停用就只是一句空话。所有写接口都从这里过一道，堵在这里最稳。
 *
 * 【为什么注册不受影响】
 * 入会申请走 registerMember，它不经过 callerError——没转正的人才正要提交
 * 申请，自然不能用「已激活」来要求他。
 *
 * @param {Object} ctx
 * @returns {string} 出错文案；通过时为空串
 */
function callerError(ctx) {
  if (!ctx.actor) return '请先登录后再操作';
  if (ctx.actor.status !== USER_STATUS.ACTIVE) return statusMessage(ctx.actor.status);
  return '';
}

module.exports = { buildContext, callerError, effectiveRole };
