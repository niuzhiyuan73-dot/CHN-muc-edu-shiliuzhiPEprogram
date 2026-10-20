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
const { PLATFORM_STATUS } = require('../utils/school.js');

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
 * 【memberIds 与 activeMemberIds 为什么要分开（2026-10-16 独立验收 F4）】
 * 「在册」与「账号还能用」是两件事：
 *   · `memberIds` 只按学籍行状态过滤——离校 / 被拒的人不在里面，但**平台账号被停用**
 *     的人还在。它记录的是「这个人在本校有学籍」这个事实，展示与历史口径要用；
 *   · `activeMemberIds` 再叠一层 `platformStatus === active`，与录分页可选名单
 *     同一口径。**新比赛 / 新阵容**的资格校验用它——否则界面上看不见的人，改个
 *     请求体直接传 ID 就能录进来。
 * 已排定的赛程（签表场次、学院赛小场）不在此列：对阵是抽签定死的既成事实，
 * 一方事后被停用不该把对手卡住，那条通路按记录本身校验（见 submitScheduledMatch）。
 *
 * @param {Object} ctx
 * @returns {Promise<{memberIds:string[], activeMemberIds:string[], members:Array<Object>, actorCollege:string, collegeIdOf:function(string):string, collegeNameById:function(string):string, collegeOf:function(string):string}>}
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
  const activeUsers = active.filter(item => {
    const user = userById.get(item.userId);
    return Boolean(user && user.platformStatus === PLATFORM_STATUS.ACTIVE);
  });
  return {
    memberIds: active.map(item => item.userId),
    activeMemberIds: activeUsers.map(item => item.userId),
    members: active.map(item => userById.get(item.userId)).filter(Boolean),
    // 学院目录：院队按它派生（一个学院一支，编号确定性），读路径不必等 teams 集合里有记录
    colleges: colleges
      .map(item => ({ collegeId: item.collegeId, name: item.name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')),
    actorCollege: nameByCollegeId.get(collegeIdOf.get(ctx.actorId)) || '',
    collegeIdOf: userId => collegeIdOf.get(userId) || '',
    collegeNameById: collegeId => nameByCollegeId.get(collegeId) || '',
    collegeOf: userId => nameByCollegeId.get(collegeIdOf.get(userId)) || '',
  };
}

/**
 * 一次读齐本校的**学院目录**与在册会员，供学院赛（名单制）复用旧栈纯校验。
 * ============================================================
 * 旧栈学院赛认「学院全名」，且有效学院写死在全局 `COLLEGES`。学校维度要求
 * 每校一份独立目录（改为稳定 `collegeId`），所以这里把本校 colleges 表读出来，
 * 同时提供「编号 ↔ 全名」的互查，并给在册会员补上 `college` 全名与数字
 * `status`——正是 `college-entry.validateCollegeEntry` 校验队员身份所需。
 *
 * 【为什么同时给编号与全名】
 * 对外主键用**稳定编号**（`collegeEntryKey` 以 collegeId 组成），显示与旧栈
 * 校验仍按**全名**（`managesCollege` / `member.college` 都是全名比对）。两者
 * 一次读齐、就地互查，页面与服务不必各转一遍。
 *
 * @param {Object} ctx
 * @returns {Promise<{
 *   colleges:Array<Object>, collegeNames:Array<string>,
 *   collegeIdOf:function(string):string, collegeOf:function(string):string,
 *   collegeNameById:function(string):string, collegeIdByName:function(string):string,
 *   memberIds:Array<string>, members:Array<Object>,
 *   actorCollege:string, actorCollegeId:string,
 * }>}
 */
async function buildCollegeDirectory(ctx) {
  const [members, colleges, users] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.forScope(ctx).colleges.list(),
    ctx.repo.users.list(),
  ]);
  const nameById = new Map(colleges.map(item => [item.collegeId, item.name]));
  const idByName = new Map(colleges.map(item => [item.name, item.collegeId]));
  const collegeIdOfMember = new Map(members.map(item => [item.userId, item.collegeId]));
  const userById = new Map(users.map(item => [item._id, item]));
  const active = members.filter(item => item.status === 'active');
  const collegeIdOf = userId => collegeIdOfMember.get(userId) || '';
  const collegeOf = userId => nameById.get(collegeIdOfMember.get(userId)) || '';
  return {
    colleges: colleges.slice(),
    collegeNames: colleges.map(item => item.name),
    collegeIdOf,
    collegeOf,
    collegeNameById: collegeId => nameById.get(collegeId) || '',
    collegeIdByName: name => idByName.get(name) || '',
    memberIds: active.map(item => item.userId),
    // 会员档案补「学院全名 + 可用状态」，与旧栈校验所需形状对齐（status 恒 ACTIVE：
    // 离校 / 停用者已被 active 过滤掉，走不到这里）。
    members: active.map(item => {
      const user = userById.get(item.userId);
      if (!user) return null;
      return { ...user, college: nameById.get(item.collegeId) || '', status: USER_STATUS.ACTIVE };
    }).filter(Boolean),
    actorCollege: collegeOf(ctx.actorId),
    actorCollegeId: collegeIdOf(ctx.actorId),
  };
}

/**
 * 权限判定的公共入参：角色 + 操作者学院 + 编号→学院。
 *
 * 学院取**传进来的 ctx 自己的学籍**（而不是调用方在事务外缓存的快照）：
 * 撤权、调学院、离校都可能发生在一个请求飞在路上的时候，事务内用 `fresh`
 * 再算一次，学院关系才不会过期（2026-10-16 独立验收 F2）。
 *
 * @param {Object} ctx 事务内 fresh 上下文或事务外上下文
 * @param {Object} dir buildDirectory 的结果（只用到「学院编号 → 全名」的静态映射）
 */
function recordOptions(ctx, dir) {
  const collegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) ||
    (dir && typeof dir.collegeIdOf === 'function' ? dir.collegeIdOf(ctx.actorId) : '');
  const college = (dir && typeof dir.collegeNameById === 'function' ? dir.collegeNameById(collegeId) : '') ||
    (dir && dir.actorCollege) || '';
  return { role: legacyRoleOf(ctx), college, collegeOf: dir.collegeOf };
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

module.exports = {
  legacyRoleOf, buildDirectory, buildCollegeDirectory, recordOptions, legacyActorOf,
};
