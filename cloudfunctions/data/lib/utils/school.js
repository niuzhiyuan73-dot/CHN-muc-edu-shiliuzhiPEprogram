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

/**
 * 把任意字符串折叠成固定长度（128 位 / 32 个十六进制字符）的确定性摘要。
 * 纯 JS，不依赖 Node 或云 SDK，miniprogram 与云端跑同一份。仅用于生成对外
 * 可见的短编号（如协会小组 _id 要能进 audienceGroupIds 受形态约束），
 * **不是**密码学散列，不得用于安全用途。
 */
function keyDigest(input) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < input.length; i += 1) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
    .map((word) => word.toString(16).padStart(8, '0')).join('');
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
// 协会空间小组：_id 由服务端按 scope + 创建者 + 请求编号生成，翻不出别的学校/协会。
// 小组编号会作为 audienceGroupIds 对外提交，受 GROUP_ID_PATTERN（[A-Za-z0-9_-]{1,64}）
// 约束，而 schoolKey 复合键含 ':' 与 '%'。故这里保留同样的输入组成与幂等语义，只把
// 完整、规范化的复合键折叠成固定长度、URL 安全的摘要。schoolKey 仍是内部键工具，
// 其余记录的键规则不受影响。
const associationGroupKey = (groupId, scope) => {
  const s = schoolScope(scope);
  return `ag_${keyDigest(schoolKey('ag', s.schoolId, s.association, groupId))}`;
};
// 组内成员关系：scope + groupId + userId，稳定唯一，重复加入走同一键。
const associationGroupMemberKey = (groupId, userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('agm', s.schoolId, s.association, groupId, userId);
};
// 同范围组名占位键：把「组名不重名」变成对同一文档的写冲突，而不是先查重再插入。
const associationGroupNameKey = (name, scope) => {
  const s = schoolScope(scope);
  return schoolKey('agn', s.schoolId, s.association, name);
};
// 空间通知：_id 由服务端按 scope + 服务端生成的请求编号构成，翻不出别的学校/协会。
const associationNoticeKey = (noticeId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('an', s.schoolId, s.association, noticeId);
};
// 空间训练：_id 由服务端按 scope + 服务端生成的请求编号构成。
const associationTrainingKey = (trainingId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('at', s.schoolId, s.association, trainingId);
};
// 训练报名：scope + trainingId + userId，稳定唯一，重复报名走同一键，无法跨范围伪造。
const trainingRegistrationKey = (trainingId, userId, scope) => {
  const s = schoolScope(scope);
  return schoolKey('tr', s.schoolId, s.association, trainingId, userId);
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
  associationGroupKey, associationGroupMemberKey, associationGroupNameKey,
  associationNoticeKey, associationTrainingKey, trainingRegistrationKey,
};
