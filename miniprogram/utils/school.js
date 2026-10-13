/** S0/S1 学校模型。严格范围不兼容缺省学校；历史回填由迁移工具处理。 */
const { isKnownAssociation } = require('./associations.js');

const SCHOOL_STATUS = Object.freeze({ ACTIVE: 'active', DISABLED: 'disabled' });
const SCHOOL_MEMBER_STATUS = Object.freeze({
  PENDING: 'pending', ACTIVE: 'active', REJECTED: 'rejected', LEFT: 'left', DISABLED: 'disabled',
});
const PLATFORM_STATUS = Object.freeze({ ACTIVE: 'active', DISABLED: 'disabled' });
const PLATFORM_ROLE = Object.freeze({ MEMBER: 'member', ADMIN: 'admin' });
const SCHOOL_ROLE = Object.freeze({ ADMIN: 'admin' });
const LEGACY_SCHOOL_ID = 'muc';

function requireSchoolId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id)) {
    throw new Error('必须提供有效的 schoolId');
  }
  return id;
}

function schoolScope(input = {}) {
  const schoolId = requireSchoolId(input.schoolId);
  if (!isKnownAssociation(input.association)) throw new Error('必须提供有效的 association');
  return Object.freeze({ schoolId, association: input.association });
}

function schoolKey(kind, ...parts) {
  if (!kind || parts.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('学校记录键缺少组成字段');
  }
  return [kind, ...parts].map(encodeURIComponent).join(':');
}

const schoolMemberKey = (userId, schoolId) => schoolKey('sm', requireSchoolId(schoolId), userId);
const schoolRoleKey = (userId, schoolId) => schoolKey('sr', requireSchoolId(schoolId), userId);
const schoolAssociationKey = (scope) => {
  const s = schoolScope(scope);
  return schoolKey('sa', s.schoolId, s.association);
};
const schoolMembershipKey = (userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('mb', s.schoolId, s.association, userId);
};
const collegeKey = (schoolId, collegeId) => schoolKey('co', requireSchoolId(schoolId), collegeId);
const ratingKey = (userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('mr', s.schoolId, s.association, userId);
};
const scopeKey = (scope) => {
  const s = schoolScope(scope);
  return schoolKey('scope', s.schoolId, s.association);
};
function belongsToSchoolScope(doc, scope) {
  const s = schoolScope(scope);
  return Boolean(doc && doc.schoolId === s.schoolId && doc.association === s.association);
}

module.exports = {
  SCHOOL_STATUS, SCHOOL_MEMBER_STATUS, PLATFORM_STATUS, PLATFORM_ROLE, SCHOOL_ROLE,
  LEGACY_SCHOOL_ID, requireSchoolId, schoolScope, schoolKey, schoolMemberKey,
  schoolRoleKey, schoolAssociationKey, schoolMembershipKey, collegeKey, ratingKey,
  scopeKey, belongsToSchoolScope,
};
