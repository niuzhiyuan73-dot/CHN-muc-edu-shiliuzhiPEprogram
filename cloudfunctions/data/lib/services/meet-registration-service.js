/**
 * 运动会报名主链（B5）
 * ============================================================
 * 学生提交参赛意向 → 学院部长从申请人里选人 → 按项目组别提交正式名单 →
 * 校管理员审核生效。四条裁决贯穿全文件：
 *
 *   D10 双层：意向不是正式报名，绝不占正式名额；
 *   D14 只能从已提交意向的人里选（部长不能凭空加人）；
 *   D16 学院取学籍快照，提交时冻结，客户端传什么都不采信；
 *   D25 一旦本院本项目提交了正式名单，该院该项目的意向入口关闭。
 *
 * 【为什么每个提交都要占「预占」而不是「已用」】
 * D21 要求校级审核。若提交时不预占，两个学院（或同一学院的两次提交）可以
 * 同时越过上限，等审核时才发现超额。所以提交即 pending+1，通过时 pending-1
 * 且 used+1，驳回/撤回只回退 pending。上限判断看 used+pending。
 *
 * 【为什么兼项要一份计数文档】
 * 云开发事务内不能查询，「这个人已经报了几个个人项目」无法用集合扫描回答。
 * 于是每人每届一份计数文档（在 claims 集合里以 kind='counter' 区分），
 * 提交时点读、写入时递增，并发提交会撞在同一份文档上，天然串行。
 *
 * 【为什么整院提交不是一次事务】
 * 一个学院可能报 120 个项目组别，单事务写不完（仓内预算 200 写）。
 * 本模块**按项目组别**提交：一次调用只写一个项目组别的一条名单，
 * 页面负责逐项调用并把失败项列出来——不做「整批要么全成」的假承诺。
 * ============================================================
 */

const {
  MEET_STATUS, MEET_INTEREST_STATUS, MEET_ENTRY_STATUS,
  meetEventKey, meetInterestKey, meetEntryKey, meetQuotaKey, meetClaimKey,
  meetParticipantCounterKey, meetEntrySlot,
} = require('../utils/meet-scope.js');
const { schoolMemberKey, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const {
  meetReadable, canManageMeet, canLeadCollegeMeet, isActiveMeetLead,
} = require('./meet-permission.js');
const { meetCollegeLeadKey } = require('../utils/meet-scope.js');
const { countsTowardPersonalQuota } = require('./meet-measure.js');

const ok = (data) => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 4.2 默认：个人项目每人最多 2 项（D35），团体与接力不计入 */
const PERSONAL_LIMIT = 2;

const isActiveInterest = (doc) => Boolean(doc && doc.status === MEET_INTEREST_STATUS.PENDING);
/**
 * 可以进入正式名单的意向：待选拔，或已经被选入（后者用于给出「已报名」这种准确提示，
 * 而不是把它误报成「没交过意向」）。
 */
const isPendingOrSelected = (doc) => Boolean(doc && (
  doc.status === MEET_INTEREST_STATUS.PENDING || doc.status === MEET_INTEREST_STATUS.SELECTED));
const isLiveEntry = (doc) => Boolean(doc && (
  doc.status === MEET_ENTRY_STATUS.PENDING_REVIEW || doc.status === MEET_ENTRY_STATUS.APPROVED));

function toIso(now) {
  return now instanceof Date ? now.toISOString() : String(now);
}

/**
 * 此刻允许报名吗？
 * 正常窗口：meet.status=registration 且 now 落在 registration 区间内。
 * 补报窗口（D27）：校管理员开的 lateWindow 覆盖同一判断，仍由部长提交。
 */
function registrationWindow(meet, now) {
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  const within = (window) => {
    if (!window || !window.openAt || !window.closeAt) return false;
    const open = Date.parse(window.openAt);
    const close = Date.parse(window.closeAt);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return false;
    return at >= open && at <= close;
  };
  if (within(meet.lateWindow)) return { open: true, late: true };
  if (meet.status !== MEET_STATUS.REGISTRATION) return { open: false, late: false };
  return { open: within(meet.registration), late: false };
}

/** 该学院在本次项目组别上的额度（缺省视为 0/0） */
async function quotaOf(tx, meetId, eventKey, collegeId) {
  const doc = await tx.sportsMeetQuotaUsage.getById(meetQuotaKey(meetId, eventKey, collegeId));
  return { used: Number((doc && doc.used) || 0), pending: Number((doc && doc.pending) || 0), doc };
}

/** 兼项计数（每人每届一份） */
async function counterOf(tx, meetId, userId) {
  const doc = await tx.sportsMeetParticipantClaims.getById(meetParticipantCounterKey(meetId, userId));
  return { personal: Number((doc && doc.personal) || 0), team: Number((doc && doc.team) || 0), doc };
}

/** 取学院部长（用于判定操作者能管哪个学院） */
async function leadOf(ctx, collegeId) {
  if (!collegeId) return null;
  return ctx.repo.sportsMeetCollegeLeads.getById(meetCollegeLeadKey(ctx.schoolId, collegeId));
}

/** 当前操作者在某届运动会里负责的学院：部长取授权学院，管理员可代报指定学院（D13）。 */
async function resolveCollege(ctx, payload) {
  const member = ctx.schoolMember;
  const ownCollege = member && member.collegeId ? member.collegeId : '';
  if (ownCollege) {
    const lead = await leadOf(ctx, ownCollege);
    if (isActiveMeetLead(lead) && lead.userId === ctx.actorId) {
      return { ok: true, collegeId: ownCollege, byAdmin: false };
    }
  }
  if (canManageMeet(ctx)) {
    const target = String(payload.collegeId || '').trim();
    if (!target) return { ok: false, message: '请指定要代报的学院' };
    return { ok: true, collegeId: target, byAdmin: true };
  }
  return { ok: false, message: '只有学院部长可以提交正式报名' };
}

/** 项目组别文档：必须属于本届 */
async function loadEvent(tx, ctx, eventKey) {
  const key = String(eventKey || '').trim();
  if (!key) return { ok: false, message: '请选择项目组别' };
  const doc = await tx.sportsMeetEvents.getById(key);
  if (!doc || doc.meetId !== ctx.meetId || doc.schoolId !== ctx.schoolId) {
    return { ok: false, message: '项目组别不存在或不属于本届运动会' };
  }
  return { ok: true, doc };
}

// ---------------------------------------------------------------- 学生端

/** 学生提交参赛意向（不占名额，D10） */
async function submitMeetInterest(payload = {}, ctx) {
  if (!meetReadable(ctx)) return refused('请先登录');
  if (!ctx.meetId) return refused('请指定运动会');
  if (!ctx.actorId) return refused('请先登录');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.schoolId !== fresh.schoolId || meet.status === MEET_STATUS.DELETED) {
      return refused('运动会不存在或已删除');
    }
    const window = registrationWindow(meet, fresh.now);
    if (!window.open) return refused('当前不在报名时间内');

    const event = await loadEvent(tx, fresh, payload.eventKey);
    if (!event.ok) return refused(event.message);

    // D17：没有本院学籍不能报名
    const member = fresh.schoolMember;
    if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE || !member.collegeId) {
      return refused('请先完善学院归属后再报名');
    }

    // D25：本院本项目已提交正式名单后，意向入口关闭
    const quota = await quotaOf(tx, fresh.meetId, event.doc._id, member.collegeId);
    if (quota.used + quota.pending > 0) return refused('本院该项目已提交正式名单，不能再提交意向');

    const key = meetInterestKey(fresh.meetId, event.doc._id, fresh.actorId);
    const current = await tx.sportsMeetInterests.getById(key);
    if (isActiveInterest(current)) {
      return ok({ interest: current, created: false }); // 重复提交幂等
    }

    const now = toIso(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey: event.doc._id,
      userId: fresh.actorId,
      collegeId: member.collegeId, // D16：提交时冻结学院
      status: MEET_INTEREST_STATUS.PENDING,
      createdAt: current ? (current.createdAt || now) : now,
      updatedAt: now,
    };
    await tx.sportsMeetInterests.set(key, doc);
    return ok({ interest: doc, created: true });
  });
}

/** 学生撤回意向（D19：正式入选前可撤回） */
async function withdrawMeetInterest(payload = {}, ctx) {
  if (!ctx.meetId || !ctx.actorId) return refused('请指定运动会');

  return ctx.repo.transaction(async (tx) => {
    const event = await loadEvent(tx, ctx, payload.eventKey);
    if (!event.ok) return refused(event.message);

    const key = meetInterestKey(ctx.meetId, event.doc._id, ctx.actorId);
    const current = await tx.sportsMeetInterests.getById(key);
    // 先判「已入选」：这类意向状态是 selected，若先判 pending 会误报成「没有意向」
    if (current && current.entryKey) return refused('已被选入正式名单，请联系学院部长');
    if (!isActiveInterest(current)) return refused('没有可撤回的参赛意向');

    await tx.sportsMeetInterests.set(key, {
      ...current, status: MEET_INTEREST_STATUS.WITHDRAWN, updatedAt: toIso(ctx.now),
    });
    return ok({ eventKey: event.doc._id });
  });
}

/** 我的参与情况：意向状态 + 正式名单状态（页面区分「待选拔/已入选/已报名」） */
async function getMyMeetParticipation(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');

  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };
  const [interests, entries, events] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetInterests.list(),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetEvents.list(),
  ]);
  const eventOf = new Map(events.map((doc) => [doc._id, doc]));
  const describe = (eventKey) => {
    const event = eventOf.get(eventKey);
    return event ? { name: event.name, group: event.group } : { name: '', group: '' };
  };

  const mine = interests
    .filter((doc) => doc.userId === ctx.actorId)
    .map((doc) => ({
      eventKey: doc.eventKey,
      ...describe(doc.eventKey),
      status: doc.status,
      collegeId: doc.collegeId,
    }));

  const joined = entries
    .filter((doc) => Array.isArray(doc.userIds) && doc.userIds.includes(ctx.actorId))
    .filter((doc) => doc.status !== MEET_ENTRY_STATUS.WITHDRAWN)
    .map((doc) => ({
      entryKey: doc._id,
      eventKey: doc.eventKey,
      ...describe(doc.eventKey),
      status: doc.status,
      collegeId: doc.collegeId,
    }));

  return ok({ interests: mine, entries: joined });
}

// ---------------------------------------------------------------- 学院端

/**
 * 学院报名工作台：每个项目组别的「已报 / 上限 / 待审 / 意向人数」。
 * 只给部长或管理员；学生看不到别院进度。
 */
async function listMeetCollegeEvents(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };

  const resolved = await resolveCollege(ctx, payload);
  if (!resolved.ok) return refused(resolved.message);
  const collegeId = resolved.collegeId;

  const [events, entries, interests] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.list(),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetInterests.list(),
  ]);

  const rows = events.map((event) => {
    const mine = entries.filter((row) => row.eventKey === event._id
      && row.collegeId === collegeId && row.status !== MEET_ENTRY_STATUS.WITHDRAWN);
    const applicants = interests.filter((doc) => doc.eventKey === event._id
      && doc.collegeId === collegeId && isActiveInterest(doc));
    return {
      eventKey: event._id,
      name: event.name,
      group: event.group,
      entryForm: event.entryForm,
      members: event.members,
      limit: event.perCollegeLimit,
      used: mine.filter((row) => row.status === MEET_ENTRY_STATUS.APPROVED).length,
      pending: mine.filter((row) => row.status === MEET_ENTRY_STATUS.PENDING_REVIEW).length,
      applicants: applicants.length,
      closed: mine.length > 0,
      scored: event.scored,
    };
  });

  return ok({ collegeId, byAdmin: resolved.byAdmin, items: rows });
}

/** 某项目组别的申请人（D14：只能从这里选人） */
async function getMeetApplicantPool(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };

  const event = await loadEvent(ctx.repo.forMeet(scope), ctx, payload.eventKey);
  if (!event.ok) return refused(event.message);

  const resolved = await resolveCollege(ctx, payload);
  if (!resolved.ok) return refused(resolved.message);

  const interests = (await ctx.repo.forMeet(scope).sportsMeetInterests.list())
    .filter((doc) => doc.eventKey === event.doc._id && doc.collegeId === resolved.collegeId
      && isActiveInterest(doc));

  const members = await Promise.all(interests.map(async (doc) => {
    const member = await ctx.repo.schoolMembers.getById(schoolMemberKey(doc.userId, ctx.schoolId));
    const user = await ctx.repo.users.getById(doc.userId);
    return {
      userId: doc.userId,
      name: (user && (user.name || user.nickName)) || '未命名',
      gender: (member && member.gender) || '',
    };
  }));

  return ok({ collegeId: resolved.collegeId, event: { eventKey: event.doc._id, name: event.doc.name, group: event.doc.group, members: event.doc.members, entryForm: event.doc.entryForm }, items: members });
}

/**
 * 提交一条正式名单（一个项目组别一条）。
 *
 * 入参：`{ eventKey, userIds, collegeId? }`。collegeId 仅管理员代报时使用（D13）。
 */
async function submitMeetCollegeEntry(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const userIds = Array.isArray(payload.userIds) ? payload.userIds.map((id) => String(id).trim()).filter(Boolean) : [];
  if (userIds.length === 0) return refused('请选择参赛学生');
  if (new Set(userIds).size !== userIds.length) return refused('同一名学生不能重复选择');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.schoolId !== fresh.schoolId || meet.status === MEET_STATUS.DELETED) {
      return refused('运动会不存在或已删除');
    }
    const window = registrationWindow(meet, fresh.now);
    if (!window.open) return refused('当前不在报名时间内');

    const event = await loadEvent(tx, fresh, payload.eventKey);
    if (!event.ok) return refused(event.message);

    const resolved = await resolveCollege(fresh, payload);
    if (!resolved.ok) return refused(resolved.message);
    const collegeId = resolved.collegeId;

    // 人数：单人 1 人；多人协作组/队伍必须与创建时设定的人数一致（D39，无替补 D40）
    const expected = event.doc.entryForm === 'single' ? 1 : Number(event.doc.members || 0);
    if (userIds.length !== expected) {
      return refused(`该项目每组需 ${expected} 人，当前选了 ${userIds.length} 人`);
    }

    // 成员资格：必须本学院在册，且提交过意向（D14／D16）
    for (const userId of userIds) {
      const member = await tx.schoolMembers.getById(schoolMemberKey(userId, fresh.schoolId));
      if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE) {
        return refused('名单包含非本校在册学生');
      }
      if (member.collegeId !== collegeId) return refused('名单包含其他学院的学生');
      // D37：同一项目组别只报一次。先判重、再判意向——否则重复提交会被
      // 「未提交意向」误导（入选后意向状态已变成 selected）。
      const claim = await tx.sportsMeetParticipantClaims.getById(meetClaimKey(fresh.meetId, event.doc._id, userId));
      if (claim && claim.status === 'active') return refused('名单中有学生已在本项目报名');
      const interest = await tx.sportsMeetInterests.getById(meetInterestKey(fresh.meetId, event.doc._id, userId));
      if (!isPendingOrSelected(interest)) return refused('名单中有学生未提交参赛意向，不能直接选入');
    }

    // 额度（D29／D32）：used + pending 不能达到上限
    const quota = await quotaOf(tx, fresh.meetId, event.doc._id, collegeId);
    if (quota.used + quota.pending >= Number(event.doc.perCollegeLimit || 0)) {
      return refused('本院该项目名额已满');
    }

    // 兼项（D35）：个人项与多人协作组计入个人额度，团体/接力不计
    if (countsTowardPersonalQuota(event.doc.entryForm)) {
      for (const userId of userIds) {
        const counter = await counterOf(tx, fresh.meetId, userId);
        if (counter.personal >= PERSONAL_LIMIT) return refused(`名单中有学生已达到个人项目 ${PERSONAL_LIMIT} 项上限`);
      }
    }

    const slot = meetEntrySlot(event.doc.entryForm, quota.used + quota.pending + 1);
    const key = meetEntryKey(fresh.meetId, event.doc._id, collegeId, slot);
    const now = toIso(fresh.now);

    const entry = {
      _id: key, // 与主键一致：返回值要能直接拿去审核/撤回，而不是让页面再猜
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey: event.doc._id,
      collegeId,
      slot,
      userIds,
      members: userIds.length,
      status: MEET_ENTRY_STATUS.PENDING_REVIEW,
      submittedBy: fresh.actorId,
      submittedByAdmin: resolved.byAdmin,
      submittedAt: now,
      reviewedBy: '',
      reviewedAt: '',
      rejectReason: '',
      updatedAt: now,
    };
    await tx.sportsMeetEntries.set(key, entry);
    await tx.sportsMeetQuotaUsage.set(meetQuotaKey(fresh.meetId, event.doc._id, collegeId), {
      schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: event.doc._id, collegeId,
      used: quota.used, pending: quota.pending + 1, updatedAt: now,
    });

    for (const userId of userIds) {
      await tx.sportsMeetParticipantClaims.set(meetClaimKey(fresh.meetId, event.doc._id, userId), {
        kind: 'claim',
        schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: event.doc._id,
        userId, entryKey: key, collegeId, status: 'active', updatedAt: now,
      });
      const counter = await counterOf(tx, fresh.meetId, userId);
      await tx.sportsMeetParticipantClaims.set(meetParticipantCounterKey(fresh.meetId, userId), {
        kind: 'counter',
        schoolId: fresh.schoolId, meetId: fresh.meetId, userId,
        personal: counter.personal + (countsTowardPersonalQuota(event.doc.entryForm) ? 1 : 0),
        team: counter.team + (countsTowardPersonalQuota(event.doc.entryForm) ? 0 : 1),
        updatedAt: now,
      });
      const interest = await tx.sportsMeetInterests.getById(meetInterestKey(fresh.meetId, event.doc._id, userId));
      if (interest) {
        await tx.sportsMeetInterests.set(meetInterestKey(fresh.meetId, event.doc._id, userId), {
          ...interest, status: MEET_INTEREST_STATUS.SELECTED, entryKey: key, updatedAt: now,
        });
      }
    }

    return ok({ entry, collegeId, byAdmin: resolved.byAdmin });
  });
}

/** 撤回/取消一条名单（截止前部长可改，D26；截止后需管理员窗口，D27） */
async function withdrawMeetCollegeEntry(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    const key = String(payload.entryKey || '').trim();
    if (!key) return refused('请指定要撤回的名单');
    const entry = await tx.sportsMeetEntries.getById(key);
    if (!entry || entry.meetId !== fresh.meetId || entry.schoolId !== fresh.schoolId) {
      return refused('名单不存在或不属于本届运动会');
    }
    if (entry.status === MEET_ENTRY_STATUS.WITHDRAWN) return refused('该名单已撤回');

    const resolved = await resolveCollege(fresh, { collegeId: entry.collegeId });
    if (!resolved.ok) return refused(resolved.message);
    if (resolved.collegeId !== entry.collegeId) return refused('只能撤回本学院的名单');

    const meet = await tx.sportsMeets.getById(fresh.meetId);
    const window = registrationWindow(meet, fresh.now);
    if (!window.open) return refused('当前不在报名时间内');

    await releaseEntry(tx, fresh, entry, MEET_ENTRY_STATUS.WITHDRAWN);
    return ok({ entryKey: key });
  });
}

/**
 * 释放一条名单占用的额度、声明与兼项计数。
 * 撤回与驳回共用一份逻辑：两处各写一遍必然漏掉其中一项（最常见是漏减 personal）。
 */
async function releaseEntry(tx, ctx, entry, nextStatus) {
  const now = toIso(ctx.now);
  await tx.sportsMeetEntries.set(entry._id, {
    ...entry, status: nextStatus, updatedAt: now,
  });

  const quota = await quotaOf(tx, ctx.meetId, entry.eventKey, entry.collegeId);
  const wasApproved = entry.status === MEET_ENTRY_STATUS.APPROVED;
  await tx.sportsMeetQuotaUsage.set(meetQuotaKey(ctx.meetId, entry.eventKey, entry.collegeId), {
    schoolId: ctx.schoolId, meetId: ctx.meetId, eventKey: entry.eventKey, collegeId: entry.collegeId,
    used: Math.max(0, quota.used - (wasApproved ? 1 : 0)),
    pending: Math.max(0, quota.pending - (wasApproved ? 0 : 1)),
    updatedAt: now,
  });

  const event = await tx.sportsMeetEvents.getById(entry.eventKey);
  const personal = event ? countsTowardPersonalQuota(event.entryForm) : true;
  for (const userId of entry.userIds || []) {
    await tx.sportsMeetParticipantClaims.set(meetClaimKey(ctx.meetId, entry.eventKey, userId), {
      kind: 'claim', schoolId: ctx.schoolId, meetId: ctx.meetId, eventKey: entry.eventKey,
      userId, entryKey: entry._id, collegeId: entry.collegeId, status: 'released', updatedAt: now,
    });
    const counter = await counterOf(tx, ctx.meetId, userId);
    await tx.sportsMeetParticipantClaims.set(meetParticipantCounterKey(ctx.meetId, userId), {
      kind: 'counter', schoolId: ctx.schoolId, meetId: ctx.meetId, userId,
      personal: Math.max(0, counter.personal - (personal ? 1 : 0)),
      team: Math.max(0, counter.team - (personal ? 0 : 1)),
      updatedAt: now,
    });
    const interest = await tx.sportsMeetInterests.getById(meetInterestKey(ctx.meetId, entry.eventKey, userId));
    if (interest) {
      // 驳回/撤回落回「待选拔」，该院该项目的意向入口随之重新打开（B5）
      await tx.sportsMeetInterests.set(meetInterestKey(ctx.meetId, entry.eventKey, userId), {
        ...interest, status: MEET_INTEREST_STATUS.PENDING, entryKey: '', updatedAt: now,
      });
    }
  }
}

// ---------------------------------------------------------------- 管理员端

/** 审核：通过则 pending→used；驳回则释放（D21／D26／B5） */
async function reviewMeetEntry(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  const decision = String(payload.decision || '');
  if (!['approve', 'reject'].includes(decision)) return refused('请选择通过或驳回');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以审核名单');

    const key = String(payload.entryKey || '').trim();
    const entry = await tx.sportsMeetEntries.getById(key);
    if (!entry || entry.meetId !== fresh.meetId || entry.schoolId !== fresh.schoolId) {
      return refused('名单不存在或不属于本届运动会');
    }
    if (entry.status !== MEET_ENTRY_STATUS.PENDING_REVIEW) return refused('该名单不在待审核状态');

    const now = toIso(fresh.now);
    if (decision === 'reject') {
      await releaseEntry(tx, fresh, entry, MEET_ENTRY_STATUS.REJECTED);
      const rejected = await tx.sportsMeetEntries.getById(key);
      await tx.sportsMeetEntries.set(key, {
        ...rejected, rejectReason: String(payload.reason || '').slice(0, 100), reviewedBy: fresh.actorId, reviewedAt: now,
      });
      return ok({ entryKey: key, status: MEET_ENTRY_STATUS.REJECTED });
    }

    const quota = await quotaOf(tx, fresh.meetId, entry.eventKey, entry.collegeId);
    await tx.sportsMeetQuotaUsage.set(meetQuotaKey(fresh.meetId, entry.eventKey, entry.collegeId), {
      schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey: entry.eventKey, collegeId: entry.collegeId,
      used: quota.used + 1, pending: Math.max(0, quota.pending - 1), updatedAt: now,
    });
    await tx.sportsMeetEntries.set(key, {
      ...entry, status: MEET_ENTRY_STATUS.APPROVED, reviewedBy: fresh.actorId, reviewedAt: now, updatedAt: now,
    });
    return ok({ entryKey: key, status: MEET_ENTRY_STATUS.APPROVED });
  });
}

/** 管理员开补报窗口（D27）：覆盖报名时间判断，仍由部长提交 */
async function openMeetLateWindow(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以开放补报');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!meet || meet.status === MEET_STATUS.DELETED) return refused('运动会不存在或已删除');

    const openAt = String(payload.openAt || '').trim();
    const closeAt = String(payload.closeAt || '').trim();
    if (!openAt || !closeAt) return refused('请填写补报窗口的开始与结束时间');
    if (Date.parse(closeAt) <= Date.parse(openAt)) return refused('补报结束必须晚于开始');

    const now = toIso(fresh.now);
    await tx.sportsMeets.set(fresh.meetId, {
      ...meet, lateWindow: { openAt, closeAt, openedBy: fresh.actorId, openedAt: now }, updatedAt: now,
    });
    return ok({ lateWindow: { openAt, closeAt } });
  });
}

/** 名单列表：管理员看全届进度；部长只看本院 */
async function listMeetEntries(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };
  const isAdmin = canManageMeet(ctx);
  if (!isAdmin) {
    const resolved = await resolveCollege(ctx, payload);
    if (!resolved.ok) return refused(resolved.message);
    payload = { ...payload, collegeId: resolved.collegeId };
  }
  const collegeId = isAdmin ? String(payload.collegeId || '').trim() : payload.collegeId;

  const [entries, events] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetEvents.list(),
  ]);
  const eventOf = new Map(events.map((doc) => [doc._id, doc]));

  const items = entries
    .filter((doc) => (collegeId ? doc.collegeId === collegeId : true))
    .filter((doc) => doc.status !== MEET_ENTRY_STATUS.WITHDRAWN)
    .map((doc) => {
      const event = eventOf.get(doc.eventKey);
      return {
        entryKey: doc._id,
        eventKey: doc.eventKey,
        name: event ? event.name : '',
        group: event ? event.group : '',
        collegeId: doc.collegeId,
        slot: doc.slot,
        userIds: doc.userIds,
        members: doc.members,
        status: doc.status,
        submittedByAdmin: Boolean(doc.submittedByAdmin),
        submittedAt: doc.submittedAt,
      };
    });

  return ok({ items });
}

module.exports = {
  submitMeetInterest,
  withdrawMeetInterest,
  getMyMeetParticipation,
  listMeetCollegeEvents,
  getMeetApplicantPool,
  submitMeetCollegeEntry,
  withdrawMeetCollegeEntry,
  reviewMeetEntry,
  openMeetLateWindow,
  listMeetEntries,
};
