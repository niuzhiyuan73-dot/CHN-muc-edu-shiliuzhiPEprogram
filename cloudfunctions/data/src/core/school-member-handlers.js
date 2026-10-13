const crypto = require('crypto');
const { ok } = require('../envelope.js');
const { buildSchoolContext } = require('./school-context.js');
const { canSchoolAction } = require('../../lib/services/school-permission.js');
const { buildSchoolApplication } = require('../../lib/services/school-member.js');
const { schoolMemberKey, collegeKey } = require('../../lib/utils/school.js');

const refused = (message) => ({ ok: false, account: null, message });
const claimKey = (schoolId, studentId) => `sid_${crypto.createHash('sha256').update(JSON.stringify([schoolId, studentId])).digest('hex')}`;
const freshContext = (tx, ctx) => buildSchoolContext({ repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });

async function applySchoolMembership(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!fresh.actor || fresh.actor.platformStatus !== 'active') return refused('账号不可用');
    if (fresh.actor.primarySchoolId && fresh.actor.primarySchoolId !== fresh.schoolId) return refused('已有其他学校身份，转校流程尚未开放');
    const previous = fresh.schoolMember;
    if (previous && ['active', 'left', 'disabled'].includes(previous.status)) return refused('当前学校身份不能重新申请，请联系管理员');
    const college = typeof payload.collegeId === 'string' && payload.collegeId
      ? await tx.colleges.getById(collegeKey(fresh.schoolId, payload.collegeId)) : null;
    let application;
    try {
      application = buildSchoolApplication({ userId: fresh.actorId, school: fresh.school,
        college, studentId: payload.studentId, now: fresh.now });
    } catch (err) { return refused(err.message); }
    if (previous && previous.status === 'pending' && previous.collegeId === application.collegeId && previous.studentId === application.studentId) {
      return { ok: true, account: previous, message: '' };
    }
    application.revision = Number(previous && previous.revision || 0) + 1;
    await tx.schoolMembers.set(application._id, application);
    await tx.audit.append({ _id: `apply_${application._id}_${application.revision}`, action: 'applySchoolMembership', schoolId: fresh.schoolId,
      actorId: fresh.actorId, userId: fresh.actorId, revision: application.revision, at: fresh.now });
    return { ok: true, account: application, message: '' };
  });
  return ok(result);
}

async function reviewSchoolMembership(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canSchoolAction(ctx, 'reviewMembers', ctx)) return ok(refused('没有本校审核权限'));
  if (!['approve', 'reject'].includes(payload.decision)) return ok(refused('审核决定无效'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少申请人'));
  if (!Number.isInteger(payload.revision) || payload.revision < 1) return ok(refused('请刷新申请版本后重试'));
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (payload.decision === 'reject' && !reason) return ok(refused('驳回必须填写理由'));
  if (reason.length > 500) return ok(refused('审核理由过长'));
  // 兼容尚未生成学号占用文档的 S1 种子/存量身份。新审批统一写 claim，
  // 因而读取后的并发审批仍由事务中的共享 claim 文档阻止重复占用。
  const priorMembers = payload.decision === 'approve'
    ? await ctx.repo.forScope(ctx).schoolMembers.list() : [];
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canSchoolAction(fresh, 'reviewMembers', fresh)) return refused('没有本校审核权限');
    if (payload.userId === fresh.actorId) return refused('不能审核自己的申请');
    const id = schoolMemberKey(payload.userId, fresh.schoolId);
    const application = await tx.schoolMembers.getById(id);
    if (!application || application.userId !== payload.userId || application.schoolId !== fresh.schoolId || application.status !== 'pending') return refused('申请不存在或已处理');
    if (application.revision !== payload.revision) return refused('申请已修改，请刷新后重新审核');
    const user = await tx.users.getById(payload.userId);
    if (!user || user.platformStatus !== 'active') return refused('申请人账号不可用');
    const approved = payload.decision === 'approve';
    if (approved) {
      if (user.primarySchoolId && user.primarySchoolId !== fresh.schoolId) return refused('申请人已有其他学校身份');
      if (priorMembers.some(row => row.userId !== user._id && row.studentId === application.studentId &&
          ['active', 'left', 'disabled'].includes(row.status))) return refused('该学号已被其他账号使用');
      const college = await tx.colleges.getById(collegeKey(fresh.schoolId, application.collegeId));
      if (!college || college.schoolId !== fresh.schoolId || college.status !== 'active') return refused('申请学院已失效');
      const claimId = claimKey(fresh.schoolId, application.studentId);
      const claim = await tx.studentIdClaims.getById(claimId);
      if (claim && (claim.userId !== user._id || claim.schoolId !== fresh.schoolId)) return refused('该学号已被其他账号使用');
      await tx.studentIdClaims.set(claimId, { schoolId: fresh.schoolId, userId: user._id, claimedAt: fresh.now });
      // 共享用户文档使不同学校同时审批同一用户时产生事务写冲突。
      await tx.users.set(user._id, { ...user, primarySchoolId: fresh.schoolId,
        schoolIdentityVersion: Number(user.schoolIdentityVersion || 0) + 1 });
    }
    const next = { ...application, status: approved ? 'active' : 'rejected', reviewedBy: fresh.actorId,
      reviewedAt: fresh.now, reviewReason: reason, revision: application.revision + 1 };
    await tx.schoolMembers.set(id, next);
    await tx.audit.append({ _id: `review_${id}_${next.revision}`, action: 'reviewSchoolMembership', schoolId: fresh.schoolId,
      actorId: fresh.actorId, userId: user._id, decision: payload.decision, reason,
      revision: next.revision, at: fresh.now });
    return { ok: true, account: next, message: '' };
  });
  return ok(result);
}

async function getMySchoolMembership(_payload, ctx) {
  if (!ctx.actor || ctx.actor.platformStatus !== 'active') return ok(refused('请使用有效账号登录'));
  return ok({ ok: true, account: ctx.schoolMember, message: '' });
}

async function getSchoolApplications(_payload, ctx) {
  if (!canSchoolAction(ctx, 'reviewMembers', ctx)) return ok({ ok: false, applications: [], message: '没有本校审核权限' });
  const rows = await ctx.repo.forScope(ctx).schoolMembers.list();
  return ok({ ok: true, applications: rows.filter(row => row.status === 'pending'), message: '' });
}

module.exports = { applySchoolMembership, reviewSchoolMembership, getMySchoolMembership, getSchoolApplications };
