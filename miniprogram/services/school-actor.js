/**
 * 学校维度：旧栈纯规则模块所需的「角色 / 名单」适配层（协议 2，M1）
 * ============================================================
 * 旧栈的权限纯模块（event.js / match-record.js）认的是**账号**形状：
 * 数值 ROLE、学院全名、性别。S2 的角色分散在 schoolRole / membership 两张表
 * 里，且是字符串。若每个服务各推一遍，口径迟早分叉，所以推导只留这一处：
 *
 *   · legacyRoleOf   —— S2 角色 → 旧栈 ROLE 数值；
 *   · buildDirectory —— 一次读齐本范围的在册名单、会员档案与学院改名表；
 *   · recordOptions  —— 权限判定的公共入参；
 *   · legacyActorOf  —— 组装旧栈纯判定要的「账号」对象。
 *
 * 不含任何业务动作，也不参与处理器注册表，纯做适配。
 *
 * 【为什么 status 一律写 ACTIVE】
 * 只有通过了 S2 的读 / 管理判定（canReadAssociationSpace / canManageAssociationSpace
 * 或本协会会员资格）才会走到这里；platformStatus 与在册状态已由那一层把过关。
 * 这里给旧栈一个「可用账号」的满足值，让 canManageEvent / canCheckIn 这类判定
 * 只看角色，不必再推一遍平台状态。
 * ============================================================
 */

const { permissionOf, isPlatformAdminCtx, PERMISSION } = require('./school-permission.js');
const { ROLE, USER_STATUS } = require('../utils/constants.js');

/**
 * S2 角色 → 旧栈 ROLE 数值，供旧栈纯判定复用。
 * 校级管理员 / 协会负责人 / 平台管理员按「管理员」；学院负责人按「学院职员」。
 * @param {Object} ctx
 * @returns {number}
 */
function legacyRoleOf(ctx) {
  if (isPlatformAdminCtx(ctx)) return ROLE.ADMIN;
  const permission = permissionOf(ctx && ctx.schoolRole, ctx && ctx.membership);
  if (permission === PERMISSION.SCHOOL_ADMIN || permission === PERMISSION.ASSOCIATION_LEADER) return ROLE.ADMIN;
  if (permission === PERMISSION.COLLEGE_LEADER) return ROLE.STAFF;
  return ROLE.MEMBER;
}

/**
 * 一次读齐本范围的在册名单、会员档案与学院改名表，供权限判定、展示与抽签复用。
 *
 * members 是**会员档案**（含 gender），抽签算种子、配对要用；memberIds 是在册编号，
 * 供 match-record 的阵容校验。user 表是全局的，这里只取本范围在册会员那几份。
 *
 * @param {Object} ctx
 * @returns {Promise<{memberIds:string[], members:Array<Object>, actorCollege:string, collegeOf:function(string):string}>}
 */
async function buildDirectory(ctx) {
  const [members, colleges, users] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.forScope(ctx).colleges.list(),
    ctx.repo.users.list(),
  ]);
  const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
  const collegeIdOf = new Map(members.map(item => [item.userId, item.collegeId]));
  const userById = new Map(users.map(item => [item._id, item]));
  const active = members.filter(item => item.status === 'active');
  return {
    memberIds: active.map(item => item.userId),
    members: active.map(item => userById.get(item.userId)).filter(Boolean),
    actorCollege: nameByCollegeId.get(collegeIdOf.get(ctx.actorId)) || '',
    collegeOf: userId => nameByCollegeId.get(collegeIdOf.get(userId)) || '',
  };
}

/** 权限判定的公共入参：角色 + 操作者学院 + 编号→学院。 */
function recordOptions(ctx, dir) {
  return { role: legacyRoleOf(ctx), college: dir.actorCollege, collegeOf: dir.collegeOf };
}

/**
 * 组装旧栈纯规则模块要的「账号」对象（event.js 的 canManage/canCheckIn 等）。
 * role / college / gender 取自 S2 推导；status 恒为 ACTIVE（调用方已把过关）。
 *
 * @param {Object} ctx
 * @param {Object} dir buildDirectory 的返回值
 * @returns {Object}
 */
function legacyActorOf(ctx, dir) {
  const actor = (ctx && ctx.actor) || {};
  return {
    _id: ctx.actorId,
    status: USER_STATUS.ACTIVE,
    role: legacyRoleOf(ctx),
    college: dir.actorCollege,
    gender: actor.gender || '',
    nickName: actor.nickName || '',
    realName: actor.realName || '',
  };
}

module.exports = { legacyRoleOf, buildDirectory, recordOptions, legacyActorOf };
