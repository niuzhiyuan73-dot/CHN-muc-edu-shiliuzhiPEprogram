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
const { PLATFORM_STATUS, collegeKey, schoolMemberKey } = require('../utils/school.js');

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
  const [members, colleges] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.forScope(ctx).colleges.list(),
  ]);
  // 账号按在册成员的编号批量取。原先是 ctx.repo.users.list()——users 是平台级
  // 集合（不带 schoolId），一次要把**全平台所有学校**的账号读回来建 Map，
  // 而本函数是每个协会页面的必经之路（2026-10-21 审查 P0-1）。
  const users = await ctx.repo.users.listByIds(members.map(item => item.userId));
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
  const [members, colleges] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.forScope(ctx).colleges.list(),
  ]);
  // 账号按在册成员编号批量取（原先是 users.list()，会把全平台账号读进来，
  // 2026-10-21 审查 P0-1）。
  const users = await ctx.repo.users.listByIds(members.map(item => item.userId));
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

/** 没有学院归属时的空目录：`involvesCollege` 的两个条件必然不成立。 */
const EMPTY_RECORD_DIR = Object.freeze({
  actorCollege: '',
  collegeIdOf: () => '',
  collegeNameById: () => '',
  collegeOf: () => '',
});

/**
 * 只取「这场比赛用得上」的那几个学院，而不是全院名单（2026-10-23 H-4）。
 *
 * 【为什么不能直接用 buildDirectory】（2026-10-22 第二轮审查 P-1）
 * `buildDirectory` 会读全校在册名单 + 这批人的账号：2000 人的学校是
 * 20 + 20 = 40 次 RPC。判球路径上**每一球**都要判一次权限，一场 50 球的比赛
 * 光"确认你有没有权限"就要 2000 次 RPC，同场多个场地并行时直接打空全校
 * 每日读配额。
 *
 * 真正需要的信息只有：操作者自己的学院名，加上**这场比赛的两队选手**各自
 * 属于哪个学院。单人赛 2 人、双人赛 4 人，最多 4 次点读 + 2 次学院名点读。
 *
 * 【为什么现在放到这里】原来只服务实时比分（school-live-service），赛事 /
 * 比赛详情同样只需要这一小块——两处各写一份必然分叉，因此上收到适配层。
 *
 * @param {Object} ctx 请求上下文（含 schoolMember）
 * @param {Object} doc 比赛或赛事文档（读 teamA / teamB）
 * @returns {Promise<Object>} 与 recordOptions 兼容的目录形状
 */
async function recordDirOf(ctx, doc) {
  const memberCollegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) || '';
  // 没有学院归属 ⇒ involvesCollege 的两个条件（college 非空、collegeOf 是函数）
  // 必然不成立，与"全院目录里查不到他的学院"是同一个结论，读都不用读。
  if (!memberCollegeId) return EMPTY_RECORD_DIR;

  const participants = [...new Set([...((doc && doc.teamA) || []), ...((doc && doc.teamB) || [])])];
  const [actorCollege, rows] = await Promise.all([
    ctx.repo.colleges.getById(collegeKey(ctx.schoolId, memberCollegeId)),
    Promise.all(participants.map(userId =>
      ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)))),
  ]);
  const actorCollegeName = (actorCollege && actorCollege.name) || '';

  const collegeIdByUser = new Map();
  rows.forEach((row, index) => {
    if (row && row.collegeId) collegeIdByUser.set(participants[index], row.collegeId);
  });

  // 一张「学院编号 → 全名」表，先放操作者自己的学院，再补参赛者涉及的学院。
  // 两边必须走同一张表：involvesCollege 比较的是"操作者学院名 === 参赛者学院名"，
  // 若操作者的学院没有登记进来，同一学院也会被判成不同学院（越权拦截误伤）。
  const nameById = new Map();
  if (memberCollegeId && actorCollegeName) nameById.set(memberCollegeId, actorCollegeName);
  const missingIds = [...new Set([...collegeIdByUser.values()])].filter(id => !nameById.has(id));
  const missing = await Promise.all(missingIds.map(id =>
    ctx.repo.colleges.getById(collegeKey(ctx.schoolId, id))));
  missing.forEach((doc2) => {
    if (doc2 && doc2.collegeId) nameById.set(doc2.collegeId, doc2.name || '');
  });

  return {
    actorCollege: actorCollegeName,
    collegeIdOf: userId => collegeIdByUser.get(userId) || '',
    collegeNameById: id => nameById.get(id) || '',
    collegeOf: userId => nameById.get(collegeIdByUser.get(userId)) || '',
  };
}

/**
 * 只取「操作者自己的学院名」——一次点读，而不是全院目录（2026-10-23 H-4）。
 *
 * 【为什么够用】`legacyActorOf` 组装旧栈账号时，从目录里唯一取的就是
 * `dir.actorCollege`。为这一个字符串去读全校在册名单 + 这批人的账号（2000 人
 * 是 40 次 RPC），在赛事详情这种每次打开都走的读接口上尤其不划算。
 *
 * 不能直接用 `ctx.actor.college`：账号上的学院是历史遗留字段，权威值是
 * `school_members.collegeId`（转学院只改名册）。所以这里按 schoolMember 的
 * collegeId 点读学院目录取全名，与 buildDirectory 同一口径。
 *
 * @param {Object} ctx
 * @returns {Promise<string>} 学院全名；没有学院归属时为空串
 */
async function actorCollegeNameOf(ctx) {
  const collegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) || '';
  if (!collegeId) return '';
  const doc = await ctx.repo.colleges.getById(collegeKey(ctx.schoolId, collegeId));
  return (doc && doc.name) || '';
}

module.exports = {
  legacyRoleOf, buildDirectory, buildCollegeDirectory, recordOptions, legacyActorOf,
  actorCollegeNameOf, recordDirOf, EMPTY_RECORD_DIR,
};
