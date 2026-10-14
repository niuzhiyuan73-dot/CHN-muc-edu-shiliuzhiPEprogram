/** 已迁移的学校业务使用的上下文；旧单校业务保持独立入口。 */
const {
  schoolScope, schoolAssociationKey, schoolMemberKey, schoolRoleKey, schoolMembershipKey,
} = require('../utils/school.js');

// actorId 仅供已认证的内部事务重读使用，网络入口只能传微信 OPENID。
async function buildSchoolContext({ repo, openId = '', actorId = '', scope, now = new Date() }) {
  const target = schoolScope(scope);
  const [school, schoolAssociation, actor] = await Promise.all([
    repo.schools.getById(target.schoolId),
    repo.schoolAssociations.getById(schoolAssociationKey(target)),
    actorId ? repo.users.getById(actorId) : openId ? repo.users.getByOpenId(openId) : null,
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
  // openId 供注册平台账号（M3-d）取用：尚无账号时只能凭微信身份开户，actorId 还不存在。
  // 云端按 OpenID 解析 actor；模拟端按 actorId 解析，回填该账号的 openId 以对齐语义。
  const resolvedOpenId = openId || (actor && actor.openId) || '';
  return Object.freeze({ repo, ...target, now, actor, openId: resolvedOpenId, actorId: actor ? actor._id : '',
    school, schoolAssociation, schoolMember: owned(member), schoolRole: owned(role),
    membership: owned(membership) && membership.association === target.association ? membership : null });
}

module.exports = { buildSchoolContext };
