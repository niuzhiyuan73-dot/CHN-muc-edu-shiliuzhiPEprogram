/** 校级能力独立于旧 ROLE.ADMIN 数值。资源归属校验始终先于局部角色。 */
const { PLATFORM_STATUS, PLATFORM_ROLE, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');

function canSchoolAction(ctx, action, resource) {
  if (!ctx || !ctx.actor || ctx.actor.platformStatus !== PLATFORM_STATUS.ACTIVE) return false;
  if (!resource || resource.schoolId !== ctx.schoolId) return false;
  if (resource.association && resource.association !== ctx.association) return false;
  if (!ctx.school || ctx.school.status !== 'active' || !ctx.schoolAssociation || ctx.schoolAssociation.status !== 'active') return false;
  const known = ['readMembers', 'participate', 'reviewMembers', 'manageSchool', 'manageAssociation', 'manageCollege'];
  if (!known.includes(action)) return false;
  const memberActive = ctx.schoolMember && ctx.schoolMember.status === SCHOOL_MEMBER_STATUS.ACTIVE &&
    ctx.actor.primarySchoolId === ctx.schoolId;
  // 管理授权不自动赋予参赛身份，平台管理员也必须具备本校有效身份。
  if (action === 'participate') return Boolean(memberActive);
  if (ctx.actor.platformRole === PLATFORM_ROLE.ADMIN) return true;
  if (!memberActive) return false;
  const schoolAdmin = ctx.schoolRole && ctx.schoolRole.status === 'active' && ctx.schoolRole.role === 'admin';
  const membership = ctx.membership && ctx.membership.status === 'active' ? ctx.membership : null;
  if (action === 'readMembers') return true;
  if (action === 'reviewMembers' || action === 'manageSchool') return Boolean(schoolAdmin);
  if (action === 'manageAssociation') return Boolean(schoolAdmin || membership && membership.role === 'leader');
  return Boolean(schoolAdmin || membership && (membership.role === 'leader' ||
    membership.role === 'staff' && resource.collegeId && membership.collegeId === resource.collegeId));
}

module.exports = { canSchoolAction };
