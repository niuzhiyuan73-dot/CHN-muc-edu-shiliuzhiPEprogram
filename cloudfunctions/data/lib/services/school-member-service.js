/**
 * 学校维度：会员档案 / 名录（协议 2，M3-b）
 * ============================================================
 * 旧栈 `getMembers` / `getMember` 的学校维度对应物：一次取齐本校**在册会员**的
 * 展示档案，供赛事报名、比赛录入、学院赛名单等页面的选手选择器使用（即 M1-d
 * 页面改接所需的「会员档案」）。
 *
 * 【与协会空间名录的区别】
 * 协会空间的 `listAssociationMembers` 是「成员页签」的取数口：关键字搜索 + 游标
 * 分页，只给当前页补权限标签（默认 20 / 上限 50）。这里要的是旧栈 `getMembers`
 * 那种**一次取齐的平铺名单**，并附带 `gender`（性别项目报名、单打榜过滤都要用），
 * 不做分页、不补权限标签——两者取数与用途不同，故各留一处，不互相将就。
 *
 * 【隐私口径】只下发 userId / nickName / realName / avatarUrl / gender /
 * collegeId / collegeName。学号、手机号、OpenID、平台角色一律不下发（与
 * getSchoolMembers / listAssociationMembers 一致）。
 *
 * 【读权限】与协会空间同一把锁（canReadAssociationSpace）：本协会有效会员或空间
 * 管理者（含平台管理员）。外校人不能靠名录把别校名单拉走。
 *
 * 【与会员审核的分工】会员审核（入会申请 → 通过 / 驳回）由
 * `school-membership-service` 的 `getSchoolApplications` / `reviewSchoolMembership`
 * 覆盖，本模块只负责审核通过后的**会员档案读取**。
 * ============================================================
 */

const { canReadAssociationSpace } = require('./association-space-permission.js');
const { schoolMemberKey, SCHOOL_MEMBER_STATUS, PLATFORM_STATUS } = require('../utils/school.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 会员档案一行的对外形状：隐私字段（学号 / 手机号 / OpenID / 平台角色）一律不下发。 */
function memberRow(user, member, collegeName) {
  return {
    userId: user._id,
    // 逐层兜底，绝不渲染出 undefined
    nickName: user.nickName || user.realName || user._id,
    realName: user.realName || '',
    avatarUrl: user.avatarUrl || '',
    gender: user.gender || '',
    collegeId: member.collegeId || '',
    collegeName: collegeName(member.collegeId),
  };
}

/**
 * 本校在册会员名录（平铺，一次取齐）。可选 `collegeId` 只取某学院。
 * @param {Object} [payload] { collegeId? }
 * @param {Object} ctx
 */
async function listSchoolMembers(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, members: [], total: 0, message: '没有读取本协会成员名录的权限' });
  }
  const [rows, colleges] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.forScope(ctx).colleges.list(),
  ]);
  const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
  const collegeName = id => nameByCollegeId.get(id) || '';
  const filterCollegeId = typeof payload.collegeId === 'string' && payload.collegeId ? payload.collegeId : '';

  // 名录要按 userId 补昵称 / 头像。**一次取齐本校账号建索引**，而不是在循环里
  // 逐条 getById——一本校 200 人就是 200 次 RPC（见 2026-10-16 只读审计 H3）。
  // buildDirectory（school-actor.js）早就是这个写法，这里照抄。
  const userById = new Map((await ctx.repo.users.list()).map(user => [user._id, user]));

  const members = [];
  for (const row of rows) {
    if (row.status !== SCHOOL_MEMBER_STATUS.ACTIVE) continue;
    if (filterCollegeId && row.collegeId !== filterCollegeId) continue;
    const user = userById.get(row.userId);
    // 平台停用账号、或已归属别校的用户不进本校本册。
    if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) continue;
    members.push(memberRow(user, row, collegeName));
  }
  // 按编号稳定排序；调用方要按学院/姓名排再自排即可。
  members.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return ok({ ok: true, members, total: members.length, message: '' });
}

/**
 * 单个会员档案。仅供名录读权限持有者查看。
 * @param {Object} payload { userId }
 * @param {Object} ctx
 */
async function getSchoolMember(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取本协会成员名录的权限'));
  const userId = typeof payload.userId === 'string' ? payload.userId : '';
  if (!userId) return ok(refused('缺少会员编号'));

  const [member, user] = await Promise.all([
    ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)),
    ctx.repo.users.getById(userId),
  ]);
  if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE) return ok(refused('找不到这位会员'));
  if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) {
    return ok(refused('找不到这位会员'));
  }
  const colleges = await ctx.repo.forScope(ctx).colleges.list();
  const nameByCollegeId = new Map(colleges.map(item => [item.collegeId, item.name]));
  return ok({ ok: true, member: memberRow(user, member, id => nameByCollegeId.get(id) || ''), message: '' });
}

module.exports = { listSchoolMembers, getSchoolMember };
