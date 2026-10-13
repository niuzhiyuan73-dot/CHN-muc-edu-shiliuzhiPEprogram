/** 学校申请记录的纯构造器。实际审批、学号占用与转校事务在 S2 接入。 */
const { SCHOOL_MEMBER_STATUS, schoolMemberKey } = require('../utils/school.js');

function buildSchoolApplication({ userId, school, college, studentId, now = new Date() } = {}) {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('缺少用户身份');
  if (!school || school.status !== 'active') throw new Error('学校不可申请');
  if (!college || college.status !== 'active' || college.schoolId !== school.schoolId || !college.collegeId) {
    throw new Error('请选择本校有效学院');
  }
  const normalized = typeof studentId === 'string' ? studentId.trim() : '';
  if (!normalized || normalized.length > 64 || /\s/.test(normalized)) throw new Error('学号格式不正确');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('申请时间无效');
  return {
    _id: schoolMemberKey(userId, school.schoolId), userId, schoolId: school.schoolId,
    collegeId: college.collegeId, studentId: normalized,
    status: SCHOOL_MEMBER_STATUS.PENDING, appliedAt: date.toISOString(),
  };
}

module.exports = { buildSchoolApplication };
