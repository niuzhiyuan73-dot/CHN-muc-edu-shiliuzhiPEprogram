/**
 * 协会空间：成员名录（成员页签的取数接口）
 * ============================================================
 * 只取 `schoolId` 范围内的**在册会员**（school_members.status === active 且
 * primarySchoolId 匹配），交给纯模块 association-member.js 做匹配、排序与分页。
 * 不复用跨校只读的 canReadSchool——外校人不能靠成员页把别校名单拉走。
 *
 * 【隐私口径】只下发 userId / nickName / realName / avatarUrl / collegeId /
 * collegeName / permissionLabel。realName 只参与搜索匹配、不作为主渲染字段；
 * 学号、手机号、OpenID、平台角色一律不下发（与 getSchoolMembers 一致）。
 * ============================================================
 */

const { searchMemberPage } = require('./association-member.js');
const { canReadAssociationSpace } = require('./association-space-permission.js');
const { permissionLabelOf } = require('./school-permission.js');
const {
  schoolMemberKey, schoolRoleKey, schoolMembershipKey,
  SCHOOL_MEMBER_STATUS, PLATFORM_STATUS,
} = require('../utils/school.js');

const ok = data => ({ ok: true, data });
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

async function listAssociationMembers(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, members: [], nextCursor: '', hasMore: false,
      message: '没有读取本协会成员名录的权限' });
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, MAX_LIMIT) : DEFAULT_LIMIT;

  const [rows, colleges] = await Promise.all([
    ctx.repo.forScope(ctx).schoolMembers.list(),
    ctx.repo.forScope(ctx).colleges.list(),
  ]);
  const collegeName = id => (colleges.find(row => row.collegeId === id) || {}).name || '';

  // 一次取齐本校账号建索引，避免在循环里逐条 getById（一本校 200 人 = 200 次
  // RPC）。见 2026-10-16 只读审计 H3。
  const userById = new Map((await ctx.repo.users.list()).map(user => [user._id, user]));

  const base = [];
  for (const row of rows) {
    if (row.status !== SCHOOL_MEMBER_STATUS.ACTIVE) continue;
    const user = userById.get(row.userId);
    if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) continue;
    base.push({ userId: row.userId, nickName: user.nickName || '',
      realName: user.realName || '', avatarUrl: user.avatarUrl || '',
      collegeId: row.collegeId || '', collegeName: collegeName(row.collegeId) });
  }

  const page = searchMemberPage(base, { keyword: payload.keyword, cursor: payload.cursor, limit });
  // 权限标签只为当前这一页补算，避免对整份名录做 2×N 次读。
  const members = await Promise.all(page.members.map(async member => {
    const [role, membership] = await Promise.all([
      ctx.repo.schoolRoles.getById(schoolRoleKey(member.userId, ctx.schoolId)),
      ctx.repo.memberships.get(schoolMembershipKey(member.userId, ctx)),
    ]);
    return { ...member, permissionLabel: permissionLabelOf(role, membership) };
  }));

  return ok({ ok: true, members, nextCursor: page.nextCursor, hasMore: page.hasMore,
    keyword: page.keyword, message: '' });
}

module.exports = { listAssociationMembers };
