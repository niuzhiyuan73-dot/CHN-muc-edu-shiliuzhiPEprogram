/**
 * 团队运动：球队与队员（篮球/足球/排球共用）
 * ============================================================
 * 球队不是「一次填几个名字」，而是长期存在、有人进出、有队长的实体。三份名单
 * 必须分开（见 docs/篮球协会-需求与实施规划.md §4.2）：
 *
 *   长期球队成员   teams / team_members        —— 本文件负责
 *   赛事报名名单   team_event_entries.roster   —— 赛事批次负责，锁定后成快照
 *   单场出场名单   team_matches.rosters        —— 录分批负责
 *
 * 本文件只管第一份。历史成绩只认快照，所以队员退队、改名、换号都不会回写
 * 已经发生的比赛——这也是「不要拿球队成员表当报名表」的原因。
 *
 * 【权限】
 *   · 建队：在册会员申请，协会负责人及以上审核（学生不能自助开队）；
 *   · 入队：本人申请 / 队长审批；邀请方式首版不做；
 *   · 队长：只能管自己这支队的队员与交接，**不因此获得协会管理权限**；
 *   · 协会负责人 / 校级管理员：可审核建队、可接管任何一支队、可归档。
 *
 * 【并发与幂等】
 *   · 建队用「创建人 + 请求编号」派生稳定 teamId，重试同一请求返回同一支队；
 *   · 队员关系主键是 teamId + userId，重复申请是幂等的，人数最多变一次；
 *   · 同范围不允许重名：写入前比对现有队名。并发建同名队仍可能同时通过，
 *     校园规模下接受这个窗口（不引入队名占位文档，避免把占位混进球队列表）。
 * ============================================================
 */

const { canManageAssociationSpace, canParticipateInAssociation } = require('./association-space-permission.js');
const { buildDirectory } = require('./school-actor.js');
const { teamKey, teamMemberKey } = require('../utils/school.js');
const {
  TEAM_STATUS, TEAM_STATUS_LABEL, TEAM_MEMBER_STATUS, TEAM_MEMBER_STATUS_LABEL,
} = require('../utils/constants.js');
const { sportTypeOf } = require('../utils/associations.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const NAME_MIN = 2;
const NAME_MAX = 20;
const TEAM_LIST_LIMIT = 100;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 是否为团队项目协会。个人赛协会不该被这套接口服务。 */
function assertTeamSport(ctx) {
  return sportTypeOf(ctx.association) === 'team';
}

/** 文本字段裁剪：去空白 + 长度检查 */
function textOf(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, message: '请填写球队名称' };
  if (text.length > max) return { ok: false, message: `球队名称不超过 ${max} 个字` };
  return { ok: true, value: text };
}

/** 只认本范围的球队文档；跨校/跨协会读到也当不存在 */
function inScope(doc, ctx) {
  return Boolean(doc) && doc.schoolId === ctx.schoolId && doc.association === ctx.association;
}

/** 从目录里取昵称，取不到退回编号（宁可显示编号，也不要 undefined） */
function nameOf(dir, userId) {
  const found = (dir.members || []).find(user => user._id === userId);
  return (found && (found.nickName || found.realName)) || userId || '';
}

/** 队员是否在队（ACTIVE） */
function isActiveMember(row) {
  return Boolean(row) && row.status === TEAM_MEMBER_STATUS.ACTIVE;
}

/** 队长或协会管理者 */
function canManageTeam(ctx, team, actorId) {
  if (!team) return false;
  if (team.captainId === actorId) return true;
  return canManageAssociationSpace(ctx);
}

/** 列表行 / 详情用的球队视图。布尔量在这里算好，模板不写业务判断。 */
function teamView(team, { dir, actorId, manage, membership }) {
  const active = isActiveMember(membership);
  return {
    teamId: team._id,
    name: team.name,
    sport: team.sport || 'basketball',
    college: team.college || '',
    status: team.status,
    statusLabel: TEAM_STATUS_LABEL[team.status] || team.status,
    captainId: team.captainId,
    captainName: nameOf(dir, team.captainId),
    memberCount: Number(team.memberCount) || 0,
    createdAt: team.createdAt || null,
    isMine: active,
    isCaptain: team.captainId === actorId,
    canManage: manage,
    /** 能不能点「申请加入」：正常状态、非本队成员、也没有待审申请 */
    canApply: team.status === TEAM_STATUS.ACTIVE && !active
      && !(membership && membership.status === TEAM_MEMBER_STATUS.PENDING),
    /** 待审申请标记：队长/管理员在详情里要能看到并审批 */
    pending: Boolean(membership) && membership.status === TEAM_MEMBER_STATUS.PENDING,
    membershipStatus: membership ? membership.status : '',
    membershipLabel: membership ? (TEAM_MEMBER_STATUS_LABEL[membership.status] || '') : '',
  };
}

/** 队员行（详情页名单） */
function memberRow(row, dir) {
  return {
    userId: row.userId,
    name: nameOf(dir, row.userId),
    role: row.role,
    roleLabel: row.role === 'captain' ? '队长' : '队员',
    status: row.status,
    statusLabel: TEAM_MEMBER_STATUS_LABEL[row.status] || '',
    joinedAt: row.joinedAt || null,
  };
}

/** 读一支队并过范围校验 */
async function loadTeam(repo, ctx, teamId) {
  if (!teamId || typeof teamId !== 'string') return null;
  const team = await repo.teams.getById(teamId);
  return inScope(team, ctx) ? team : null;
}

/** 本范围的队员关系，按队分组，避免 N 次点读 */
async function membershipMap(repo) {
  const rows = await repo.teamMembers.list();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.teamId)) map.set(row.teamId, []);
    map.get(row.teamId).push(row);
  }
  return map;
}

/* ============================================================
 * 读
 * ============================================================ */

/**
 * 球队列表。
 * @param {Object} payload { keyword?, mine? }
 * @param {Object} ctx
 */
async function listTeams(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const dir = await buildDirectory(ctx);
  const manage = canManageAssociationSpace(ctx);
  const repo = ctx.repo.forScope(ctx);
  const [teams, members] = await Promise.all([repo.teams.list(), repo.teamMembers.list()]);

  const keyword = String(payload.keyword || '').trim().toLowerCase();
  const mineOnly = payload.mine === true;
  const byTeam = new Map();
  for (const row of members) {
    if (!byTeam.has(row.teamId)) byTeam.set(row.teamId, []);
    byTeam.get(row.teamId).push(row);
  }

  const rows = teams
    .filter(team => team.status !== TEAM_STATUS.ARCHIVED || manage)
    // 待审/未通过的队只给管理者看，学生看不到别人还没过审的申请
    .filter(team => team.status === TEAM_STATUS.ACTIVE || manage)
    .filter(team => !keyword || String(team.name || '').toLowerCase().includes(keyword))
    .map(team => {
      const rowsOfTeam = byTeam.get(team._id) || [];
      const membership = rowsOfTeam.find(row => row.userId === ctx.actorId);
      return teamView(team, { dir, actorId: ctx.actorId, manage, membership });
    })
    .filter(view => !mineOnly || view.isMine || view.isCaptain)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
    .slice(0, TEAM_LIST_LIMIT);

  return ok({ ok: true, teams: rows, canManage: manage, message: '' });
}

/**
 * 球队详情：球队信息 + 队员名单。
 * 待审申请只有队长与管理者看得到；普通队员只看到在队的人。
 */
async function getTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const team = await loadTeam(ctx.repo.forScope(ctx), ctx, payload.teamId);
  if (!team) return ok(refused('球队不存在，或不在本协会'));

  const dir = await buildDirectory(ctx);
  const manage = canManageTeam(ctx, team, ctx.actorId);
  const rows = (await ctx.repo.forScope(ctx).teamMembers.list()).filter(row => row.teamId === team._id);
  const membership = rows.find(row => row.userId === ctx.actorId);

  const visible = rows
    .filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE
      || (manage && row.status !== TEAM_MEMBER_STATUS.LEFT))
    .map(row => memberRow(row, dir))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'captain' ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });

  return ok({
    ok: true,
    team: teamView(team, { dir, actorId: ctx.actorId, manage, membership }),
    members: visible,
    pendingCount: rows.filter(row => row.status === TEAM_MEMBER_STATUS.PENDING).length,
    message: '',
  });
}

/* ============================================================
 * 写
 * ============================================================ */

/**
 * 学生申请建队。
 * 队名同范围唯一；创建人自动成为队长；队伍初始为「待审核」。
 */
async function createTeamApplication(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canParticipateInAssociation(ctx)) return ok(refused('只有本协会在册会员可以申请建队'));

  const name = textOf(payload.name, NAME_MAX);
  if (!name.ok) return ok(refused(name.message));
  if (name.value.length < NAME_MIN) return ok(refused(`球队名称至少 ${NAME_MIN} 个字`));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('建队请求编号无效'));
  const college = String(payload.college || '').trim();

  const teamId = teamKey(`${ctx.actorId}|${token}`, ctx);
  // 重名检查放在事务外：内存仓储与云端仓储都不允许事务内整表查询。
  // 代价是两个人同时提交同名队可能都通过（校园规模下接受这个窗口，
  // 见文件头「并发与幂等」）。
  const existingTeam = await ctx.repo.forScope(ctx).teams.getById(teamId);
  if (inScope(existingTeam, ctx)) {
    return ok({ ok: true, teamId, message: '' });
  }
  const teams = await ctx.repo.forScope(ctx).teams.list();
  if (teams.some(team => inScope(team, ctx)
    && team.status !== TEAM_STATUS.ARCHIVED
    && String(team.name || '').trim() === name.value)) {
    return ok(refused('同协会已有同名球队，请换一个名字'));
  }

  const result = await ctx.repo.transaction(async tx => {
    // 事务内只写：先点读确认没有被并发请求抢先建出来（同编号重试的幂等）
    const again = await tx.teams.getById(teamId);
    if (inScope(again, ctx)) return { ok: true, teamId, message: '' };

    const now = ctx.now;
    await tx.teams.set(teamId, {
      _id: teamId, schoolId: ctx.schoolId, association: ctx.association,
      sport: 'basketball', name: name.value, college,
      captainId: ctx.actorId, status: TEAM_STATUS.PENDING,
      memberCount: 1, revision: 1, requestId: token,
      createdBy: ctx.actorId, createdAt: now, updatedAt: now,
    });
    await tx.teamMembers.set(teamMemberKey(teamId, ctx.actorId), {
      _id: teamMemberKey(teamId, ctx.actorId),
      schoolId: ctx.schoolId, association: ctx.association,
      teamId, userId: ctx.actorId, role: 'captain', status: TEAM_MEMBER_STATUS.ACTIVE,
      joinedAt: now, updatedAt: now,
    });
    return { ok: true, teamId, message: '' };
  });
  return ok(result);
}

/**
 * 审核建队申请。
 * 通过 → ACTIVE；退回 → REJECTED（可改名后重新申请，不物理删除）。
 */
async function reviewTeamApplication(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以审核建队'));

  const approve = payload.approve === true;
  const result = await ctx.repo.transaction(async tx => {
    const team = await loadTeam(tx, ctx, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (team.status !== TEAM_STATUS.PENDING) return refused('这支球队不在待审核状态');

    const now = ctx.now;
    await tx.teams.set(team._id, {
      ...team,
      status: approve ? TEAM_STATUS.ACTIVE : TEAM_STATUS.REJECTED,
      reason: approve ? '' : String(payload.reason || '').trim().slice(0, 100),
      revision: Number(team.revision || 1) + 1,
      reviewedBy: ctx.actorId, reviewedAt: now, updatedAt: now,
    });
    return { ok: true, teamId: team._id, status: approve ? TEAM_STATUS.ACTIVE : TEAM_STATUS.REJECTED, message: '' };
  });
  return ok(result);
}

/** 本人申请入队。重复申请幂等；被拒/离队后可重新申请。 */
async function applyToJoinTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canParticipateInAssociation(ctx)) return ok(refused('只有本协会在册会员可以加入球队'));

  const result = await ctx.repo.transaction(async tx => {
    const team = await loadTeam(tx, ctx, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (team.status !== TEAM_STATUS.ACTIVE) return refused('这支球队当前不接受入队申请');

    const key = teamMemberKey(team._id, ctx.actorId);
    const existing = await tx.teamMembers.getById(key);
    if (isActiveMember(existing)) return { ok: true, status: TEAM_MEMBER_STATUS.ACTIVE, message: '你已在这支球队中' };
    if (existing && existing.status === TEAM_MEMBER_STATUS.PENDING) {
      return { ok: true, status: TEAM_MEMBER_STATUS.PENDING, message: '' };
    }
    const now = ctx.now;
    await tx.teamMembers.set(key, {
      _id: key, schoolId: ctx.schoolId, association: ctx.association,
      teamId: team._id, userId: ctx.actorId, role: 'member',
      status: TEAM_MEMBER_STATUS.PENDING, note: String(payload.note || '').trim().slice(0, 60),
      joinedAt: existing && existing.joinedAt ? existing.joinedAt : null,
      updatedAt: now,
    });
    return { ok: true, status: TEAM_MEMBER_STATUS.PENDING, message: '' };
  });
  return ok(result);
}

/**
 * 审批入队申请（队长 / 协会管理者）。
 * 通过时人数 +1；退回不改人数。
 */
async function reviewTeamMember(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const approve = payload.approve === true;
  const result = await ctx.repo.transaction(async tx => {
    const team = await loadTeam(tx, ctx, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (!canManageTeam(ctx, team, ctx.actorId)) return refused('只有队长或协会负责人可以审批入队');

    const key = teamMemberKey(team._id, payload.userId);
    const row = await tx.teamMembers.getById(key);
    if (!row || row.teamId !== team._id) return refused('找不到这条入队申请');
    if (row.status !== TEAM_MEMBER_STATUS.PENDING) return refused('这条申请已经处理过了');

    const now = ctx.now;
    await tx.teamMembers.set(key, {
      ...row,
      status: approve ? TEAM_MEMBER_STATUS.ACTIVE : TEAM_MEMBER_STATUS.REJECTED,
      joinedAt: approve ? now : null,
      reviewedBy: ctx.actorId, reviewedAt: now, updatedAt: now,
    });
    if (approve) {
      await tx.teams.set(team._id, {
        ...team, memberCount: (Number(team.memberCount) || 0) + 1,
        updatedAt: now,
      });
    }
    return { ok: true, userId: payload.userId, status: approve ? 'active' : 'rejected', message: '' };
  });
  return ok(result);
}

/**
 * 本人退队。
 * 队长不能直接退：队里还有人时必须先交接，只剩自己时可以归档。
 */
async function leaveTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async tx => {
    const team = await loadTeam(tx, ctx, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (team.captainId === ctx.actorId) {
      return refused('队长不能直接退队：请先转让队长，或直接归档这支球队');
    }
    const key = teamMemberKey(team._id, ctx.actorId);
    const row = await tx.teamMembers.getById(key);
    if (!isActiveMember(row)) return refused('你不在队中');

    const now = ctx.now;
    await tx.teamMembers.set(key, { ...row, status: TEAM_MEMBER_STATUS.LEFT, leftAt: now, updatedAt: now });
    await tx.teams.set(team._id, {
      ...team, memberCount: Math.max(0, (Number(team.memberCount) || 1) - 1), updatedAt: now,
    });
    return { ok: true, message: '' };
  });
  return ok(result);
}

/** 转让队长（队长本人或协会管理者）。目标必须是在队成员。 */
async function transferTeamCaptain(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async tx => {
    const team = await loadTeam(tx, ctx, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (!canManageTeam(ctx, team, ctx.actorId)) return refused('只有队长或协会负责人可以转让队长');
    if (team.status === TEAM_STATUS.ARCHIVED) return refused('已归档的球队不能转让队长');

    const targetKey = teamMemberKey(team._id, payload.userId);
    const target = await tx.teamMembers.getById(targetKey);
    if (!isActiveMember(target)) return refused('只能把队长转给在队队员');
    if (target.userId === team.captainId) return refused('他已经是队长了');

    const now = ctx.now;
    const currentKey = teamMemberKey(team._id, team.captainId);
    const current = await tx.teamMembers.getById(currentKey);
    if (current) {
      await tx.teamMembers.set(currentKey, { ...current, role: 'member', updatedAt: now });
    }
    await tx.teamMembers.set(targetKey, { ...target, role: 'captain', updatedAt: now });
    await tx.teams.set(team._id, {
      ...team, captainId: target.userId, revision: Number(team.revision || 1) + 1, updatedAt: now,
    });
    return { ok: true, captainId: target.userId, message: '' };
  });
  return ok(result);
}

/** 归档球队（= 解散，不物理删除）。历史比赛与统计仍可查。 */
async function archiveTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async tx => {
    const team = await loadTeam(tx, ctx, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (!canManageTeam(ctx, team, ctx.actorId)) return refused('只有队长或协会负责人可以归档球队');
    if (team.status === TEAM_STATUS.ARCHIVED) return { ok: true, message: '' };

    const now = ctx.now;
    await tx.teams.set(team._id, {
      ...team, status: TEAM_STATUS.ARCHIVED,
      archivedBy: ctx.actorId, archivedAt: now,
      revision: Number(team.revision || 1) + 1, updatedAt: now,
    });
    return { ok: true, message: '' };
  });
  return ok(result);
}

module.exports = {
  listTeams,
  getTeam,
  createTeamApplication,
  reviewTeamApplication,
  applyToJoinTeam,
  reviewTeamMember,
  leaveTeam,
  transferTeamCaptain,
  archiveTeam,
};
