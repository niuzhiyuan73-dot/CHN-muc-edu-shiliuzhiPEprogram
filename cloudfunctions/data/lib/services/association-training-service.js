/**
 * 协会空间：训练发布与报名的事务编排
 * ============================================================
 * 「训练」是协会内部的活动：负责人发布，本协会有效会员报名，开始前可取消。
 * 本阶段（P3）只做到「发布 / 编辑 / 取消 / 结束 / 报名 / 取消报名 / 管理移除 /
 * 名单读取」，**不含签到与积分**（签到是 P5，见规划 §12：计划未接积分前不得
 * 出现可用但不计分的「签到成功」入口，故本模块不暴露任何签到动作）。
 *
 * 【职责边界】
 * 本模块注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * 权限在同目录 association-space-permission.js；小组限制的规范化与并集命中在
 * association-audience.js；稳定主键在 utils/school.js。
 *
 * 【资格怎么判（不能只看页面候选）】
 *   1. 基础资格 canParticipateInAssociation：有效平台账号 + 本校有效身份 +
 *      primarySchoolId 匹配 + 协会启用；
 *   2. 小组并集资格：对每个所选小组，按 scope + groupId + userId 的稳定键在
 *      事务内 getById 读关系（**不做整表查询**，事务内不允许），命中任一 active 即通过；
 *   3. 名额：capacity 为空即不限，否则 signupCount < capacity。
 *   最终资格 = 基础资格 AND 小组并集 AND 名额 AND 时间窗口。
 *
 * 【并发与幂等】
 *   · 报名 / 取消 / 移除都在事务内重读训练主记录，人数增减与训练 revision 同步；
 *   · 报名记录用 scope + trainingId + userId 的稳定主键，重复报名是幂等的；
 *   · 若命中小组成员限制，报名事务顺带更新所命中小组的 membershipRevision，
 *     与「移出组员」写同一主记录，形成冲突点（§9.2），避免移除与报名各改一半；
 *   · 发布用 requestId 派生稳定 trainingId，同编号重试返回同一条；
 *   · 编辑 / 取消 / 结束带 expectedRevision。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const {
  canReadAssociationSpace, canManageAssociationSpace, canParticipateInAssociation,
} = require('./association-space-permission.js');
const {
  buildAudience, readAudience, audienceAllows, hitGroupIds, AUDIENCE_MODE,
} = require('./association-audience.js');
const { GROUP_MEMBER_STATUS } = require('./association-group-service.js');
const {
  schoolKey, belongsToSchoolScope, associationTrainingKey, trainingRegistrationKey,
  associationGroupMemberKey,
} = require('../utils/school.js');
const {
  TRAINING_STATUS, TRAINING_STATUS_LABEL, TRAINING_SIGNUP_STATUS,
} = require('../utils/constants.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TITLE_MIN = 2;
const TITLE_MAX = 30;
const DESCRIPTION_MAX = 1000;
const LOCATION_MAX = 100;
/** 人数上限的 UI 上限（§5.4）。超过即为无效，不是「不限」。 */
const CAPACITY_MAX = 1000;
/** 省略结束时间时的默认时长：2 小时 */
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
/** 签到窗口相对开始时间的提前量：30 分钟（本阶段只落库，不开放签到） */
const CHECKIN_LEAD_MS = 30 * 60 * 1000;
const TRAINING_LIST_LIMIT = 20;
const TRAINING_LIST_MAX = 50;
const REGISTRATION_LIST_LIMIT = 20;
const REGISTRATION_LIST_MAX = 50;

/** 展示状态由服务器时间推导，不额外维护可漂移字段（§3.4）。 */
const TRAINING_STATE = Object.freeze({
  OPEN: 'open', ONGOING: 'ongoing', FINISHED: 'finished', CANCELED: 'canceled',
});
const TRAINING_STATE_LABEL = Object.freeze({
  open: '可报名', ongoing: '进行中', finished: '已结束', canceled: '已取消',
});
/** 签到状态：本阶段只写 not_submitted，其余留给 P5 的状态机。 */
const ATTENDANCE_STATUS = Object.freeze({
  NOT_SUBMITTED: 'not_submitted', PENDING: 'pending', REJECTED: 'rejected', CONFIRMED: 'confirmed',
});

const isTrainingDoc = doc => Boolean(doc && doc.title && doc.startAt && doc.status);
const iso = value => new Date(value).toISOString();
const displayName = actor => (actor ? (actor.nickName || actor.realName || actor._id) : '');

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

const trainingAuditKey = (trainingId, action, revision) =>
  schoolKey('atau', trainingId, action, String(revision));
const signupAuditKey = (registrationId, action, revision) =>
  schoolKey('trau', registrationId, action, String(revision));

/* --------------------------------------------------------------- 纯工具 */

/** 解析时间输入（ISO 串 / 时间戳 / Date）为毫秒；无效返回 null */
function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 归一可选文本；超长即拒绝 */
function text(value, max, { required = false, label = '内容' } = {}) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (required && !trimmed) return { ok: false, message: `请填写${label}` };
  if (trimmed.length > max) return { ok: false, message: `${label}最多 ${max} 个字` };
  return { ok: true, value: trimmed };
}

/** 人数上限：空/未传 = 不限（null）；否则必须是 1..CAPACITY_MAX 的整数 */
function normalizeCapacity(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return { ok: false, message: '人数上限需为正整数，留空表示不限' };
  }
  if (num > CAPACITY_MAX) return { ok: false, message: `人数上限最多 ${CAPACITY_MAX} 人` };
  return { ok: true, value: num };
}

/** 展示状态：已取消 / 已结束按状态；其余按服务器时间推导 */
function trainingState(doc, nowMs) {
  if (doc.status === TRAINING_STATUS.CANCELED) return TRAINING_STATE.CANCELED;
  if (doc.status === TRAINING_STATUS.FINISHED) return TRAINING_STATE.FINISHED;
  const startMs = Date.parse(doc.startAt);
  const endMs = Date.parse(doc.endAt);
  if (nowMs < startMs) return TRAINING_STATE.OPEN;
  if (nowMs < endMs) return TRAINING_STATE.ONGOING;
  return TRAINING_STATE.FINISHED;
}

/** 训练摘要 DTO（列表与详情共用）。timeText 留给页面按本地时区渲染，这里只给原始 ISO。 */
function trainingSummary(doc, nowMs) {
  const state = trainingState(doc, nowMs);
  return {
    trainingId: doc._id,
    title: doc.title || '',
    description: doc.description || '',
    location: doc.location || '',
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    capacity: doc.capacity === null || doc.capacity === undefined ? null : Number(doc.capacity),
    signupCount: Number(doc.signupCount || 0),
    audienceMode: doc.audienceMode || AUDIENCE_MODE.ALL,
    audienceGroupIds: Array.isArray(doc.audienceGroupIds) ? doc.audienceGroupIds.slice() : [],
    status: doc.status,
    state,
    stateLabel: TRAINING_STATE_LABEL[state] || '',
    statusLabel: TRAINING_STATUS_LABEL[doc.status] || '',
    signupCloseAt: doc.signupCloseAt || null,
    checkInOpenAt: doc.checkInOpenAt || null,
    checkInCloseAt: doc.checkInCloseAt || null,
    revision: Number(doc.revision || 1),
  };
}

/** 有效报名数：只数 registered（取消/移除不占名额） */
function countRegistered(rows, trainingId) {
  return rows.filter(row => row.trainingId === trainingId &&
    row.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED).length;
}

/** 本人对某训练的一行报名状态（列表用，不下发隐私字段） */
function myRegistrationDTO(reg) {
  if (!reg) return null;
  return {
    signupStatus: reg.signupStatus,
    attendanceStatus: reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED,
    signedAt: reg.signedAt || null,
    canceledAt: reg.canceledAt || null,
  };
}

/* --------------------------------------------------- 小组成员关系的读写 */

/** 事务外：列某人当前 active 的小组 ID（用于详情页算报名资格说明） */
async function activeGroupIdsOf(repo, ctx, userId) {
  const rows = await repo.forScope(ctx).associationGroupMembers.list();
  return rows.filter(row => row.userId === userId && row.status === GROUP_MEMBER_STATUS.ACTIVE)
    .map(row => row.groupId);
}

/**
 * 事务内：按稳定键逐个读取所选小组的本人关系，返回命中的小组 ID。
 * 不做整表查询（事务内不允许），因此循环 getById。
 */
async function hitGroupsInTx(tx, ctx, userId, audience) {
  const normalized = readAudience(audience);
  if (normalized.audienceMode === AUDIENCE_MODE.ALL) return [];
  const hits = [];
  for (const groupId of normalized.audienceGroupIds) {
    const rel = await tx.associationGroupMembers.getById(associationGroupMemberKey(groupId, userId, ctx));
    if (rel && rel.status === GROUP_MEMBER_STATUS.ACTIVE) hits.push(groupId);
  }
  return hits;
}

/** 报名时同步提升命中小组的 membershipRevision，作为与「移出组员」的冲突点（§9.2） */
async function bumpHitGroups(tx, hitIds, nowIso) {
  for (const groupId of hitIds) {
    const group = await tx.associationGroups.getById(groupId);
    if (!group || group.status !== 'active') continue;
    await tx.associationGroups.set(group._id, {
      ...group,
      membershipRevision: Number(group.membershipRevision || 0) + 1,
      updatedAt: nowIso,
    });
  }
}

/* ------------------------------------------------------------------ 读 */

async function listTrainings(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, trainings: [], canManage: false, nextCursor: '', hasMore: false,
      message: '没有读取协会空间的权限' });
  }
  const canManage = canManageAssociationSpace(ctx);
  const nowMs = ctx.now.getTime();
  let rows = (await ctx.repo.forScope(ctx).associationTrainings.list()).filter(isTrainingDoc);
  if (typeof payload.state === 'string' && payload.state) {
    rows = rows.filter(row => trainingState(row, nowMs) === payload.state);
  }

  // 按开始时间升序（最近的排前，过往沉底），同刻按 ID 稳定排序，游标可复现。
  const sorted = rows.slice().sort((a, b) => {
    const sa = Date.parse(a.startAt);
    const sb = Date.parse(b.startAt);
    if (sa !== sb) return sa - sb;
    return a._id < b._id ? -1 : 1;
  });
  const after = typeof payload.cursor === 'string' ? payload.cursor : '';
  let start = 0;
  if (after) {
    const [startAt, id] = after.split('|').map(decodeURIComponent);
    start = sorted.findIndex(row => String(row.startAt || '') > startAt ||
      (String(row.startAt || '') === startAt && row._id > id));
    if (start < 0) start = sorted.length;
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, TRAINING_LIST_MAX) : TRAINING_LIST_LIMIT;
  const page = sorted.slice(start, start + limit);
  const hasMore = sorted.length > start + limit;
  const nextCursor = hasMore && page.length
    ? [encodeURIComponent(String(page[page.length - 1].startAt || '')),
      encodeURIComponent(page[page.length - 1]._id)].join('|')
    : '';

  return ok({ ok: true, canManage, hasMore, nextCursor,
    trainings: page.map(row => trainingSummary(row, nowMs)), message: '' });
}

async function getTraining(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const training = await ctx.repo.associationTrainings.getById(payload.trainingId);
  if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) return ok(refused('训练不存在'));

  const canManage = canManageAssociationSpace(ctx);
  const nowMs = ctx.now.getTime();
  const summary = trainingSummary(training, nowMs);
  const parts = canParticipateInAssociation(ctx);

  let registration = null;
  if (ctx.actorId) {
    registration = await ctx.repo.trainingRegistrations
      .getById(trainingRegistrationKey(training._id, ctx.actorId, ctx));
  }
  const registered = Boolean(registration && registration.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED);
  const attendance = registration ? (registration.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED) : '';
  const state = summary.state;
  const full = training.capacity !== null && Number(training.signupCount || 0) >= Number(training.capacity);

  // 报名资格说明：逐条给出「不能报名的第一条原因」，供详情页原样展示。
  let registerNote = '';
  if (!parts) registerNote = '只有本协会有效会员可以报名';
  else if (state === TRAINING_STATE.CANCELED) registerNote = '训练已取消';
  else if (state !== TRAINING_STATE.OPEN) registerNote = '报名已截止';
  else if (registered) registerNote = '';
  else if (full) registerNote = '名额已满';
  else {
    const activeGroupIds = await activeGroupIdsOf(ctx.repo, ctx, ctx.actorId);
    if (!audienceAllows(training, activeGroupIds)) registerNote = '本次训练仅限指定小组成员报名';
  }
  const canRegister = parts && state === TRAINING_STATE.OPEN && !registered && !full &&
    !registerNote;
  const canCancel = registered && state === TRAINING_STATE.OPEN &&
    attendance !== ATTENDANCE_STATUS.PENDING && attendance !== ATTENDANCE_STATUS.CONFIRMED;

  return ok({
    ok: true, canManage, training: summary, canParticipate: parts,
    myRegistration: myRegistrationDTO(registration),
    canRegister, canCancel, registerNote, message: '',
  });
}

async function listTrainingRegistrations(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const training = await ctx.repo.associationTrainings.getById(payload.trainingId);
  if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) return ok(refused('训练不存在'));

  const canManage = canManageAssociationSpace(ctx);
  const all = (await ctx.repo.forScope(ctx).trainingRegistrations.list())
    .filter(row => row.trainingId === training._id);
  const registeredRows = all.filter(row => row.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED);

  // 普通会员只看有效报名名单（昵称 / 头像），不下发取消记录与任何隐私字段。
  if (!canManage) {
    const members = [];
    for (const row of registeredRows) {
      const user = await ctx.repo.users.getById(row.userId);
      members.push({ userId: row.userId, nickName: (user && user.nickName) || '会员',
        avatarUrl: (user && user.avatarUrl) || '', attendanceStatus: row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED });
    }
    return ok({ ok: true, canManage: false, hasMore: false, nextCursor: '', members,
      registrations: [], message: '' });
  }

  // 管理者：按筛选给全部记录，含取消 / 签到状态，可分页。
  let rows = all;
  const filter = typeof payload.filter === 'string' ? payload.filter : '';
  if (filter === 'registered' || filter === 'canceled') {
    rows = rows.filter(row => row.signupStatus === filter);
  } else if (filter) {
    rows = rows.filter(row => (row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED) === filter);
  }
  const sorted = rows.slice().sort((a, b) => {
    const ta = String(a.signedAt || '');
    const tb = String(b.signedAt || '');
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a._id < b._id ? -1 : 1;
  });
  const after = typeof payload.cursor === 'string' ? payload.cursor : '';
  let start = 0;
  if (after) {
    const [signedAt, id] = after.split('|').map(decodeURIComponent);
    start = sorted.findIndex(row => String(row.signedAt || '') < signedAt ||
      (String(row.signedAt || '') === signedAt && row._id > id));
    if (start < 0) start = sorted.length;
  }
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, REGISTRATION_LIST_MAX) : REGISTRATION_LIST_LIMIT;
  const page = sorted.slice(start, start + limit);
  const hasMore = sorted.length > start + limit;
  const nextCursor = hasMore && page.length
    ? [encodeURIComponent(String(page[page.length - 1].signedAt || '')),
      encodeURIComponent(page[page.length - 1]._id)].join('|')
    : '';

  const registrations = [];
  const colleges = await ctx.repo.forScope(ctx).colleges.list();
  const collegeName = id => (colleges.find(row => row.collegeId === id) || {}).name || '';
  for (const row of page) {
    const [user, member] = await Promise.all([
      ctx.repo.users.getById(row.userId),
      ctx.repo.schoolMembers.getById(schoolKey('sm', ctx.schoolId, row.userId)),
    ]);
    registrations.push({
      userId: row.userId,
      nickName: (user && user.nickName) || '会员',
      avatarUrl: (user && user.avatarUrl) || '',
      collegeName: collegeName(member && member.collegeId),
      signupStatus: row.signupStatus,
      attendanceStatus: row.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED,
      signedAt: row.signedAt || null,
      canceledAt: row.canceledAt || null,
      cancelReason: row.cancelReason || '',
      revision: Number(row.revision || 1),
    });
  }
  return ok({ ok: true, canManage: true, hasMore, nextCursor, members: [], registrations, message: '' });
}

/* ------------------------------------------------- 训练表单校验与组装 */

/**
 * 校验发布 / 编辑共用的训练字段。返回规范化后的字段或第一条错误。
 * @param {Object} payload
 * @param {number} nowMs 服务器当前毫秒
 * @param {boolean} requireFuture 是否要求 startAt 严格在未来（发布时要求）
 */
function buildTrainingFields(payload, nowMs, requireFuture) {
  const title = text(payload.title, TITLE_MAX, { required: true, label: '训练标题' });
  if (!title.ok) return { ok: false, message: title.message };
  if (title.value.length < TITLE_MIN) return { ok: false, message: `训练标题至少 ${TITLE_MIN} 个字` };
  const description = text(payload.description, DESCRIPTION_MAX, { label: '训练说明' });
  if (!description.ok) return { ok: false, message: description.message };
  const location = text(payload.location, LOCATION_MAX, { required: true, label: '训练地点' });
  if (!location.ok) return { ok: false, message: location.message };

  const startMs = parseTime(payload.startAt);
  if (startMs === null) return { ok: false, message: '请填写有效的开始时间' };
  if (requireFuture && startMs <= nowMs) return { ok: false, message: '开始时间必须在未来' };
  let endMs = parseTime(payload.endAt);
  if (endMs === null) endMs = startMs + DEFAULT_DURATION_MS;
  if (endMs <= startMs) return { ok: false, message: '结束时间必须晚于开始时间' };

  const capacity = normalizeCapacity(payload.capacity);
  if (!capacity.ok) return { ok: false, message: capacity.message };

  const audience = buildAudience(payload);
  if (!audience.ok) return { ok: false, message: audience.message };

  return { ok: true, fields: {
    title: title.value, description: description.value, location: location.value,
    startMs, endMs, capacity: capacity.value,
    audienceMode: audience.audienceMode, audienceGroupIds: audience.audienceGroupIds,
  } };
}

/** 由规范化字段组装可落库的训练主记录 */
function buildTrainingDoc(fields, requestId, fresh, at) {
  const trainingId = associationTrainingKey(schoolKey('t', fresh.actorId, requestId), fresh);
  return {
    _id: trainingId, schoolId: fresh.schoolId, association: fresh.association,
    title: fields.title, description: fields.description,
    startAt: iso(fields.startMs), endAt: iso(fields.endMs), location: fields.location,
    capacity: fields.capacity,
    audienceMode: fields.audienceMode, audienceGroupIds: fields.audienceGroupIds,
    status: TRAINING_STATUS.PUBLISHED,
    signupCloseAt: iso(fields.startMs),
    checkInOpenAt: iso(fields.startMs - CHECKIN_LEAD_MS),
    checkInCloseAt: iso(fields.endMs),
    signupCount: 0, audienceLockedAt: null,
    canceledAt: null, canceledBy: '', cancelReason: '',
    fingerprint: JSON.stringify([fields.title, fields.description, fields.startMs, fields.endMs,
      fields.location, fields.capacity, fields.audienceMode, fields.audienceGroupIds]),
    createdBy: fresh.actorId, createdByName: displayName(fresh.actor),
    revision: 1, createdAt: at, updatedAt: at,
  };
}

/* ------------------------------------------------------------------ 写 */

async function publishTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const built = buildTrainingFields(payload, ctx.now.getTime(), true);
  if (!built.ok) return ok(refused(built.message));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以发布训练');
    const doc = buildTrainingDoc(built.fields, token, fresh, iso(fresh.now));
    const existing = await tx.associationTrainings.getById(doc._id);
    if (isTrainingDoc(existing)) {
      return existing.fingerprint === doc.fingerprint
        ? { ok: true, training: trainingSummary(existing, fresh.now.getTime()), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    await tx.associationTrainings.set(doc._id, doc);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'publishTraining', 1),
      action: 'publishTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, at: iso(fresh.now) });
    return { ok: true, training: trainingSummary(doc, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

async function updateTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    return ok(refused('请刷新训练版本后重试'));
  }
  const built = buildTrainingFields(payload, ctx.now.getTime(), false);
  if (!built.ok) return ok(refused(built.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以编辑训练');
    const doc = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('训练不存在');
    if (doc.status === TRAINING_STATUS.CANCELED) return refused('已取消的训练不能再编辑');
    if (doc.revision !== payload.expectedRevision) return refused('训练已修改，请刷新后重试');

    const f = built.fields;
    const locked = Boolean(doc.audienceLockedAt) || Number(doc.signupCount || 0) > 0;
    const audienceUnchanged = f.audienceMode === doc.audienceMode &&
      JSON.stringify(f.audienceGroupIds) === JSON.stringify(Array.isArray(doc.audienceGroupIds) ? doc.audienceGroupIds : []);
    if (locked && (f.startMs !== Date.parse(doc.startAt) || f.endMs !== Date.parse(doc.endAt) || !audienceUnchanged)) {
      return refused('已有报名，开始时间、结束时间与小组范围不能再改');
    }
    if (!locked && f.startMs !== Date.parse(doc.startAt) && f.startMs <= fresh.now.getTime()) {
      return refused('开始时间必须在未来');
    }
    if (f.capacity !== null && f.capacity < Number(doc.signupCount || 0)) {
      return refused(`人数上限不能小于已报名人数（${Number(doc.signupCount || 0)}）`);
    }

    const nowMs = fresh.now.getTime();
    const nowIso = iso(fresh.now);
    const next = {
      ...doc,
      title: f.title, description: f.description, location: f.location,
      capacity: f.capacity, revision: doc.revision + 1, updatedAt: nowIso,
    };
    if (!locked) {
      next.startAt = iso(f.startMs);
      next.endAt = iso(f.endMs);
      next.signupCloseAt = iso(f.startMs);
      next.checkInOpenAt = iso(f.startMs - CHECKIN_LEAD_MS);
      next.checkInCloseAt = iso(f.endMs);
      next.audienceMode = f.audienceMode;
      next.audienceGroupIds = f.audienceGroupIds;
    }
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'updateTraining', next.revision),
      action: 'updateTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, at: nowIso });
    return { ok: true, training: trainingSummary(next, nowMs), message: '' };
  });
  return ok(result);
}

/** 取消训练：整体失效，保留记录留痕；对外不再接受报名（§6.1） */
async function cancelTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const reason = text(payload.reason, 200, { label: '取消原因' });
  if (!reason.ok) return ok(refused(reason.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以取消训练');
    const doc = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('训练不存在');
    if (doc.status === TRAINING_STATUS.CANCELED) {
      return { ok: true, training: trainingSummary(doc, fresh.now.getTime()), message: '' };
    }
    const nowIso = iso(fresh.now);
    const next = { ...doc, status: TRAINING_STATUS.CANCELED, canceledAt: nowIso,
      canceledBy: fresh.actorId, cancelReason: reason.value,
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'cancelTraining', next.revision),
      action: 'cancelTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, reason: reason.value, at: nowIso });
    return { ok: true, training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

/** 结束训练：必须已过结束时间；不自动批量确认任何 pending（§6.2） */
async function finishTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以结束训练');
    const doc = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('训练不存在');
    if (doc.status === TRAINING_STATUS.CANCELED) return refused('已取消的训练不能标记结束');
    if (doc.status === TRAINING_STATUS.FINISHED) {
      return { ok: true, training: trainingSummary(doc, fresh.now.getTime()), message: '' };
    }
    if (fresh.now.getTime() < Date.parse(doc.endAt)) return refused('训练尚未结束，不能提前标记结束');
    const nowIso = iso(fresh.now);
    const next = { ...doc, status: TRAINING_STATUS.FINISHED, revision: doc.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: trainingAuditKey(doc._id, 'finishTraining', next.revision),
      action: 'finishTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: doc._id, at: nowIso });
    return { ok: true, training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

async function registerTraining(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canParticipateInAssociation(fresh)) return refused('只有本协会有效会员可以报名');
    const training = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(training) || !belongsToSchoolScope(training, fresh)) return refused('训练不存在');
    if (training.status !== TRAINING_STATUS.PUBLISHED) return refused('训练已取消或已结束，不能报名');
    if (!(fresh.now.getTime() < Date.parse(training.startAt))) return refused('报名已截止');

    const key = trainingRegistrationKey(training._id, userId, fresh);
    const existing = await tx.trainingRegistrations.getById(key);
    if (existing && existing.signupStatus === TRAINING_SIGNUP_STATUS.REGISTERED) {
      return { ok: true, registration: myRegistrationDTO(existing),
        training: trainingSummary(training, fresh.now.getTime()), message: '' };
    }

    const hits = await hitGroupsInTx(tx, fresh, userId, training);
    if (!audienceAllows(training, hits)) return refused('本次训练仅限指定小组成员报名');
    if (training.capacity !== null && training.capacity !== undefined &&
        Number(training.signupCount || 0) >= Number(training.capacity)) {
      return refused('名额已满');
    }

    const nowIso = iso(fresh.now);
    const registration = {
      _id: key, schoolId: fresh.schoolId, association: fresh.association,
      trainingId: training._id, userId,
      signupStatus: TRAINING_SIGNUP_STATUS.REGISTERED, signedAt: nowIso,
      canceledAt: null, canceledBy: '', cancelReason: '',
      eligibilitySnapshot: {
        audienceMode: readAudience(training).audienceMode,
        hitGroupIds: hitGroupIds(training, hits),
        audienceLockedAt: training.audienceLockedAt || null,
        capturedAt: nowIso,
      },
      attendanceStatus: ATTENDANCE_STATUS.NOT_SUBMITTED,
      requestedAt: null, confirmedAt: null, confirmedBy: '',
      rejectedAt: null, rejectedBy: '', rejectionReason: '',
      pointEffectiveAt: null, revision: 1,
    };
    await tx.trainingRegistrations.set(key, registration);
    await bumpHitGroups(tx, hitGroupIds(training, hits), nowIso);
    const next = { ...training, signupCount: Number(training.signupCount || 0) + 1,
      audienceLockedAt: training.audienceLockedAt || nowIso,
      revision: training.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'registerTraining', 1),
      action: 'registerTraining', schoolId: fresh.schoolId, association: fresh.association,
      actorId: userId, trainingId: training._id, targetUserId: userId, at: nowIso });
    return { ok: true, registration: myRegistrationDTO(registration),
      training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

async function cancelTrainingRegistration(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  const reason = text(payload.reason, 200, { label: '取消原因' });
  if (!reason.ok) return ok(refused(reason.message));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const training = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(training) || !belongsToSchoolScope(training, ctx)) return refused('训练不存在');
    const key = trainingRegistrationKey(training._id, userId, ctx);
    const reg = await tx.trainingRegistrations.getById(key);
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) {
      return { ok: true, training: trainingSummary(training, ctx.now.getTime()), message: '' };
    }
    const attendance = reg.attendanceStatus || ATTENDANCE_STATUS.NOT_SUBMITTED;
    // 待确认 / 已确认不得直接取消报名（§6.1）
    if (attendance === ATTENDANCE_STATUS.PENDING || attendance === ATTENDANCE_STATUS.CONFIRMED) {
      return refused('已提交或已确认签到，不能直接取消报名');
    }
    if (training.status !== TRAINING_STATUS.PUBLISHED) return refused('训练已取消或已结束，不能取消报名');
    if (!(ctx.now.getTime() < Date.parse(training.startAt))) return refused('报名已截止，不能取消');

    const nowIso = iso(ctx.now);
    await tx.trainingRegistrations.set(key, { ...reg, signupStatus: TRAINING_SIGNUP_STATUS.CANCELED,
      canceledAt: nowIso, canceledBy: userId, cancelReason: reason.value, revision: reg.revision + 1 });
    const next = { ...training, signupCount: Math.max(0, Number(training.signupCount || 0) - 1),
      revision: training.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'cancelTrainingRegistration', reg.revision + 1),
      action: 'cancelTrainingRegistration', schoolId: ctx.schoolId, association: ctx.association,
      actorId: userId, trainingId: training._id, targetUserId: userId, reason: reason.value, at: nowIso });
    return { ok: true, training: trainingSummary(next, ctx.now.getTime()), message: '' };
  });
  return ok(result);
}

/** 管理移除报名：占位者按 registered 递减人数；pending/confirmed 一并撤销签到资格（§8.2） */
async function removeTrainingRegistration(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.trainingId !== 'string' || !payload.trainingId) return ok(refused('缺少训练编号'));
  if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标成员'));
  const reason = text(payload.reason, 200, { label: '移除原因' });
  if (!reason.ok) return ok(refused(reason.message));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以移除报名');
    const training = await tx.associationTrainings.getById(payload.trainingId);
    if (!isTrainingDoc(training) || !belongsToSchoolScope(training, fresh)) return refused('训练不存在');
    const key = trainingRegistrationKey(training._id, payload.userId, fresh);
    const reg = await tx.trainingRegistrations.getById(key);
    if (!reg || reg.signupStatus !== TRAINING_SIGNUP_STATUS.REGISTERED) {
      return { ok: true, training: trainingSummary(training, fresh.now.getTime()), message: '' };
    }
    const nowIso = iso(fresh.now);
    await tx.trainingRegistrations.set(key, { ...reg, signupStatus: TRAINING_SIGNUP_STATUS.CANCELED,
      canceledAt: nowIso, canceledBy: fresh.actorId, cancelReason: reason.value,
      attendanceStatus: ATTENDANCE_STATUS.NOT_SUBMITTED, pointEffectiveAt: null,
      revision: reg.revision + 1 });
    const next = { ...training, signupCount: Math.max(0, Number(training.signupCount || 0) - 1),
      revision: training.revision + 1, updatedAt: nowIso };
    await tx.associationTrainings.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(key, 'removeTrainingRegistration', reg.revision + 1),
      action: 'removeTrainingRegistration', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, trainingId: training._id, targetUserId: payload.userId,
      reason: reason.value, at: nowIso });
    return { ok: true, training: trainingSummary(next, fresh.now.getTime()), message: '' };
  });
  return ok(result);
}

module.exports = {
  TITLE_MIN, TITLE_MAX, DESCRIPTION_MAX, LOCATION_MAX, CAPACITY_MAX,
  DEFAULT_DURATION_MS, CHECKIN_LEAD_MS,
  TRAINING_STATE, TRAINING_STATE_LABEL, ATTENDANCE_STATUS,
  parseTime, normalizeCapacity, trainingState, countRegistered,
  listTrainings, getTraining, listTrainingRegistrations,
  publishTraining, updateTraining, cancelTraining, finishTraining,
  registerTraining, cancelTrainingRegistration, removeTrainingRegistration,
};
