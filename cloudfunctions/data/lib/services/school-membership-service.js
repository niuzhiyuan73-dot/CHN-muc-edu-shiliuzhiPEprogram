const ok = data => ({ ok: true, data });
const { buildSchoolContext } = require('./school-context.js');
const {
  canSchoolAction, canReadSchool, canGrantPermission, grantablePermissions,
  isPlatformAdminCtx, permissionOf, permissionLabelOf, PERMISSION, PERMISSION_LABEL,
} = require('./school-permission.js');
const { buildSchoolApplication } = require('./school-member.js');
const {
  schoolMemberKey, schoolRoleKey, schoolMembershipKey, collegeKey,
  PLATFORM_ROLE, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS, SCHOOL_ROLE,
} = require('../utils/school.js');

/** 可授予的三档权限，顺序从高到低；界面选项与校验共用这一份。 */
const GRANT_PERMISSIONS = Object.freeze([PERMISSION.SCHOOL_ADMIN, PERMISSION.ASSOCIATION_LEADER, PERMISSION.COLLEGE_LEADER]);
const grantOptions = ctx => grantablePermissions(ctx).map(permission => ({
  permission, label: PERMISSION_LABEL[permission],
}));

function createSchoolHandlers({ claimKey }) {
  const refused = (message) => ({ ok: false, account: null, message });
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
    const applications = await Promise.all(rows.filter(row => row.status === 'pending').map(async row => {
      const user = await ctx.repo.users.getById(row.userId);
      return { userId: row.userId, schoolId: row.schoolId, collegeId: row.collegeId,
        studentId: row.studentId, revision: row.revision, appliedAt: row.appliedAt,
        nickName: user && user.nickName || '申请人' };
    }));
    return ok({ ok: true, applications, message: '' });
  }

  async function getSchoolDirectory(_payload, ctx) {
    const schools = (await ctx.repo.schools.list()).filter(row => row.status === 'active').map(row => ({
      schoolId: row.schoolId, name: row.name, shortName: row.shortName,
    }));
    const colleges = (await ctx.repo.forScope(ctx).colleges.list()).filter(row => row.status === 'active').map(row => ({
      collegeId: row.collegeId, name: row.name,
    }));
    return ok({ ok: true, schools, colleges, message: '' });
  }

  async function getSchoolIdentitySession(_payload, ctx) {
    const active = ctx.actor && ctx.actor.platformStatus === 'active';
    // 浏览的是不是外校：本校身份只在 primarySchoolId 上，当前范围与它不一致即只读。
    const readOnly = Boolean(active && ctx.actor.primarySchoolId && ctx.actor.primarySchoolId !== ctx.schoolId);
    return ok({ ok: true, user: active ? { userId: ctx.actorId, nickName: ctx.actor.nickName || '',
      primarySchoolId: ctx.actor.primarySchoolId || '' } : null,
      account: active ? ctx.schoolMember : null,
      isPlatformAdmin: isPlatformAdminCtx(ctx),
      canReview: canSchoolAction(ctx, 'reviewMembers', ctx),
      canManageAssociation: canSchoolAction(ctx, 'manageAssociation', ctx),
      readOnly,
      grants: active && !readOnly ? grantOptions(ctx) : [],
      message: active ? '' : '当前账号尚未开通学校身份，请联系管理员' });
  }

  /**
   * 本校成员与权限。**任何有效平台账号都能读任意启用学校**（跨校只读），
   * 因此这里不放管理角色门槛，只要求学校与协会可用；返回里不带学号、手机号，
   * 与跨校参赛名单同一隐私口径。
   *
   * @param {Object} _payload
   * @param {Object} ctx
   */
  async function getSchoolMembers(_payload, ctx) {
    if (!canReadSchool(ctx)) return ok({ ok: false, members: [], grants: [], readOnly: false, message: '没有读取该校成员的权限' });
    const readOnly = Boolean(ctx.actor.primarySchoolId && ctx.actor.primarySchoolId !== ctx.schoolId);
    const colleges = await ctx.repo.forScope(ctx).colleges.list();
    const collegeName = id => (colleges.find(row => row.collegeId === id) || {}).name || '';
    const rows = (await ctx.repo.forScope(ctx).schoolMembers.list()).filter(row => row.status === SCHOOL_MEMBER_STATUS.ACTIVE);
    const members = await Promise.all(rows.map(async row => {
      const [user, role, membership] = await Promise.all([
        ctx.repo.users.getById(row.userId),
        ctx.repo.schoolRoles.getById(schoolRoleKey(row.userId, ctx.schoolId)),
        ctx.repo.memberships.get(schoolMembershipKey(row.userId, ctx)),
      ]);
      return {
        userId: row.userId,
        nickName: (user && user.nickName) || '会员',
        collegeId: row.collegeId || '',
        collegeName: collegeName(row.collegeId),
        permission: permissionOf(role, membership),
        permissionLabel: permissionLabelOf(role, membership),
      };
    }));
    members.sort((a, b) => (a.userId < b.userId ? -1 : 1));
    return ok({ ok: true, members, grants: readOnly ? [] : grantOptions(ctx), readOnly, message: '' });
  }

  /**
   * 统一「指定权限」入口：一次只改一档，写什么由 permission 决定。
   *   schoolAdmin       → school_roles（校级管理员）
   *   associationLeader → memberships.role='leader'
   *   collegeLeader     → memberships.role='staff' + collegeId
   *
   * 谁能授哪一档由 grantablePermissions 一处决定（平台管理员 / 校级管理员 / 协会
   * 负责人三档，逐级收窄）；跨校浏览一律拒绝——只读不给授权入口。
   *
   * @param {Object} payload { userId, permission, make, collegeId }
   * @param {Object} ctx
   */
  async function grantSchoolPermission(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    if (!GRANT_PERMISSIONS.includes(payload.permission)) return ok(refused('未知的权限类型'));
    if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标会员'));
    if (payload.userId === ctx.actorId) return ok(refused('不能给自己指定权限'));
    if (!canGrantPermission(ctx, payload.permission)) return ok(refused('没有指定该权限的资格'));
    const make = Boolean(payload.make);
    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      if (!canGrantPermission(fresh, payload.permission)) return refused('没有指定该权限的资格');
      const user = await tx.users.getById(payload.userId);
      if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE) return refused('目标账号不可用');
      if (user.platformRole === PLATFORM_ROLE.ADMIN) return refused('不能改变平台管理员的权限');
      const member = await tx.schoolMembers.getById(schoolMemberKey(user._id, fresh.schoolId));
      if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE) return refused('对方没有本校有效身份');

      if (payload.permission === PERMISSION.SCHOOL_ADMIN) {
        const key = schoolRoleKey(user._id, fresh.schoolId);
        await tx.schoolRoles.set(key, {
          _id: key, userId: user._id, schoolId: fresh.schoolId,
          role: SCHOOL_ROLE.ADMIN, status: make ? 'active' : 'disabled',
          updatedBy: fresh.actorId, updatedAt: fresh.now,
        });
      } else if (payload.permission === PERMISSION.ASSOCIATION_LEADER) {
        const key = schoolMembershipKey(user._id, fresh);
        const existing = await tx.memberships.get(key);
        const base = existing && existing.role === 'leader' ? existing : {};
        await tx.memberships.set(key, {
          ...base, _id: key, userId: user._id, schoolId: fresh.schoolId, association: fresh.association,
          role: make ? 'leader' : 'member', collegeId: '', status: make ? 'active' : 'revoked',
          updatedBy: fresh.actorId, updatedAt: fresh.now,
        });
      } else {
        // 学院负责人：必须落到本校一个有效学院，且协会负责人无需再指定学院
        const current = await tx.memberships.get(schoolMembershipKey(user._id, fresh));
        if (current && current.status === 'active' && current.role === 'leader') return refused('对方已是协会负责人，无需再指定学院');
        const collegeId = make ? String(payload.collegeId || '') : '';
        if (make) {
          if (!collegeId) return refused('请选择本校有效学院');
          const college = await tx.colleges.getById(collegeKey(fresh.schoolId, collegeId));
          if (!college || college.status !== 'active' || college.schoolId !== fresh.schoolId) return refused('请选择本校有效学院');
        }
        const key = schoolMembershipKey(user._id, fresh);
        await tx.memberships.set(key, {
          _id: key, userId: user._id, schoolId: fresh.schoolId, association: fresh.association,
          role: make ? 'staff' : 'member', collegeId, status: make ? 'active' : 'revoked',
          updatedBy: fresh.actorId, updatedAt: fresh.now,
        });
      }

      await tx.audit.append({
        _id: `grant_${payload.permission}_${user._id}_${make ? 'grant' : 'revoke'}`,
        action: 'grantSchoolPermission', schoolId: fresh.schoolId, association: fresh.association,
        actorId: fresh.actorId, userId: user._id, permission: payload.permission, make, at: fresh.now,
      });
      return { ok: true, account: { userId: user._id, nickName: user.nickName || '' }, message: '' };
    });
    return ok(result);
  }

  return { applySchoolMembership, reviewSchoolMembership, getMySchoolMembership, getSchoolApplications,
    getSchoolDirectory, getSchoolIdentitySession, getSchoolMembers, grantSchoolPermission };
}

module.exports = { createSchoolHandlers };
