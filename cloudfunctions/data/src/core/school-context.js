/** S1 专用上下文，S2 接入 dispatcher 前不替换旧的单校入口。 */
const {
  schoolScope, schoolAssociationKey, schoolMemberKey, schoolRoleKey, schoolMembershipKey,
} = require('../../lib/utils/school.js');

async function buildSchoolContext({ repo, openId = '', scope, now = new Date() }) {
  const target = schoolScope(scope);
  const [school, schoolAssociation, actor] = await Promise.all([
    repo.schools.getById(target.schoolId),
    repo.schoolAssociations.getById(schoolAssociationKey(target)),
    openId ? repo.users.getByOpenId(openId) : null,
  ]);
  if (!school || school.schoolId !== target.schoolId || school.status !== 'active') throw new Error('学校不存在或已停用');
  if (!schoolAssociation || schoolAssociation.schoolId !== target.schoolId ||
      schoolAssociation.association !== target.association || schoolAssociation.status !== 'active') {
    throw new Error('该校尚未启用此协会');
  }
  const [member, role, membership] = actor ? await Promise.all([
    repo.schoolMembers.getById(schoolMemberKey(actor._id, target.schoolId)),
    repo.schoolRoles.getById(schoolRoleKey(actor._id, target.schoolId)),
    repo.memberships.get(schoolMembershipKey(actor._id, target)),
  ]) : [null, null, null];
  const owned = (doc) => doc && doc.schoolId === target.schoolId && doc.userId === actor._id ? doc : null;
  return Object.freeze({ repo, ...target, now, actor, actorId: actor ? actor._id : '', school, schoolAssociation,
    schoolMember: owned(member), schoolRole: owned(role),
    membership: owned(membership) && membership.association === target.association ? membership : null });
}

module.exports = { buildSchoolContext };
