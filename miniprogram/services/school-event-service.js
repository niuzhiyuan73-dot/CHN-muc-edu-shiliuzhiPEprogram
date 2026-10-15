/**
 * 学校维度：个人赛事 —— 发布 / 报名 / 开赛 / 抽签 / 代签 / 结束（协议 2，M1）
 * ============================================================
 * 「个人赛事」是协会内部办的比赛：协会负责人以上发布，本协会有效会员报名。
 * 全生命周期一条线：
 *   发布 → 列表 → 详情 → 报名 → 取消报名
 *        → 抽签（生成签表与首轮比赛）→ 开赛 → 代签 → 录名次结束。
 * 抽签与推进的纯规则一字不改地复用旧栈（`event.js` / `draw.js` / `format-plan.js`，
 * 同一把尺子）；本模块只管**归属**与**权限来源**：
 *   · 主记录与生成的比赛都绑定 `schoolId + association`，读写先过 `belongsToSchoolScope`；
 *   · 旧栈 ROLE 由 S2 角色推导（见 school-actor.js），与比赛 / 实时比分同源。
 *
 * 【签表比赛的编号为什么不另包一层范围前缀】
 * 抽签生成的比赛编号是 `eventMatchKey(event._id, ...)`，而 eventId 本身已带
 * `schoolId + association`，因此它天然全局唯一、不可伪造，无需再裹一层范围键；
 * 且 format-plan 逐轮推进时按这个确定键找下一轮，包了反而对不上。比赛记录上
 * 仍写 schoolId / association，归属判定不放松。
 *
 * 【advanceSchoolEvent 是内部动作】
 * confirm / forfeit 之后补排下一轮由它负责（见 school-match-service）。它虽从
 * 本模块导出（供比赛服务调用），但入参是 (ctx, eventId) 而非 (payload, ctx)，
 * 被当成客户端 action 误调时首行即判空返回，不产生任何写入。
 *
 * 【与旧栈的区别】
 * 旧栈的赛事只按 `association` 分桶，没有 `schoolId`；本模块把每条主记录同时
 * 绑定 `schoolId + association`，主键由 `utils/school.js` 按范围生成，读写一律
 * 先过 `belongsToSchoolScope`，从入口堵死跨校串数据。
 *
 * 【职责边界】
 * 注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * 表单校验复用旧栈纯规则 `event.js`（同一把尺子），不另抄一遍。
 *
 * 【并发与幂等】
 *   · 发布用 requestId 派生稳定 eventId，同编号重试返回同一条；
 *   · 报名用 scope + eventId + userId 的稳定主键，重复报名幂等；
 *   · 名额靠主记录上的 signupCount 计数（报名 / 取消在同一事务内增减），
 *     与训练同一口径，避免事务内整表查询。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const {
  canReadAssociationSpace, canManageAssociationSpace, canParticipateInAssociation,
} = require('./association-space-permission.js');
// 角色 / 名单的推导收在 school-actor，两套栈只有一份口径。
const { buildDirectory, legacyActorOf } = require('./school-actor.js');
const {
  schoolKey, belongsToSchoolScope, schoolEventKey, schoolEventSignupKey,
} = require('../utils/school.js');
const {
  EVENT_STATUS, EVENT_STATUS_LABEL, SIGNUP_STATUS, SIGNUP_STATUS_LABEL,
  MATCH_TYPE, MATCH_TYPE_LABEL, EVENT_LEVEL_LABEL, EVENT_FORMAT_LABEL,
  MATCH_STATUS, MATCH_COMPETITION,
  DEFAULT_EVENT_FORMAT, GENDER_LABEL, singleGenderOf, disciplineLabelOf,
} = require('../utils/constants.js');
// 表单校验与生命周期判定复用旧栈纯规则：赛事该怎么走，两套栈只有一份口径。
const {
  buildEventRecord, signupOf, signupStateOf,
  canStartEvent, startBlockedReason, canDrawEvent, canCheckIn, canFinishEvent,
  buildCheckInPatch, validatePlacements,
} = require('./event.js');
const { planDraw, buildDrawRecord, canRedraw, drawnEntryCount } = require('./draw.js');
const { buildInitialMatches, buildPlannedDrafts, planStageMatches } = require('./format-plan.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const EVENT_LIST_LIMIT = 20;
const EVENT_LIST_MAX = 50;

const iso = value => new Date(value).toISOString();
const formatOf = doc => (doc && doc.format) || DEFAULT_EVENT_FORMAT;

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

const eventAuditKey = (eventId, action, revision) =>
  schoolKey('evau', eventId, action, String(revision));
const signupAuditKey = (eventId, actorId, action, revision) =>
  schoolKey('evsu', eventId, actorId, action, String(revision));

/** 一条赛事主记录。status 可以是 0（报名中，falsy），所以不能用真值判断。 */
const isEventDoc = doc => Boolean(doc && doc.title && typeof doc.status === 'number' && doc.startTime);

/** 有效报名数：已取消的不占名额。 */
const activeSignupCount = rows => (Array.isArray(rows) ? rows : [])
  .filter(row => row.status !== SIGNUP_STATUS.CANCELED).length;

/** 报名记录 DTO（本人视角，不下发隐私字段）。 */
const signupDTO = row => (row ? {
  userId: row.userId,
  status: row.status,
  label: SIGNUP_STATUS_LABEL[row.status] || '',
  signTime: row.signTime || null,
  checkInTime: row.checkInTime || null,
  revision: Number(row.revision || 1),
} : null);

/**
 * 签表 DTO：只投影展示与重抽要用的字段，不透传整条库记录。
 * 名单列表（eventSummary）不带它——只有详情响应才下发。
 */
function drawDTO(draw) {
  if (!draw) return null;
  const groups = (draw.groups || []).map(group => ({
    group: group.group,
    entries: (group.entries || []).slice(),
  }));
  return {
    format: draw.format || null,
    seedMode: draw.seedMode || null,
    seedCount: Number(draw.seedCount || 0),
    seedValue: Number(draw.seedValue),
    drawCount: Number(draw.drawCount || 1),
    drawnAt: draw.drawnAt || null,
    drawnBy: draw.drawnBy || null,
    size: Number(draw.size || 0),
    slots: (draw.slots || []).slice(),
    seeds: (draw.seeds || []).slice(),
    byes: (draw.byes || []).slice(),
    groupCount: groups.length > 0 ? groups.length : null,
    groups,
  };
}

/** 名次 DTO：只保留「谁、第几名」两个字段，其余留库。 */
const resultsDTO = results => (Array.isArray(results) ? results : [])
  .map(row => ({ userId: row.userId, placement: Number(row.placement) }));

/**
 * 赛事摘要 DTO（列表与详情共用）。时间一律给原始 ISO，本地时区渲染交给页面。
 * @param {Object} doc 赛事主记录
 * @param {Object|null} [mySignup] 当前登录人在本场的报名记录
 */
function eventSummary(doc, mySignup = null) {
  const state = signupStateOf(mySignup);
  const count = Number(doc.signupCount || 0);
  const quota = Number(doc.quota) || 0;
  return {
    eventId: doc._id,
    title: doc.title || '',
    description: doc.description || '',
    matchType: doc.matchType,
    matchTypeLabel: MATCH_TYPE_LABEL[doc.matchType] || '',
    discipline: doc.discipline || '',
    disciplineLabel: disciplineLabelOf(doc.discipline),
    isDoubles: doc.matchType === MATCH_TYPE.DOUBLES,
    level: doc.level,
    levelLabel: EVENT_LEVEL_LABEL[doc.level] || '',
    format: formatOf(doc),
    formatLabel: EVENT_FORMAT_LABEL[formatOf(doc)] || '',
    bronzeMode: doc.bronzeMode || null,
    placementMode: doc.placementMode || null,
    // 小组参数与总决赛重赛只在对应赛制下有意义，其余赛制建记录时即落 null；
    // 原样透出（含 false），页面与用例才能核对「选了什么、落库成了什么」。
    groupCount: doc.groupCount === undefined ? null : doc.groupCount,
    advancePerGroup: doc.advancePerGroup === undefined ? null : doc.advancePerGroup,
    gfReset: doc.gfReset === undefined ? null : doc.gfReset,
    seedMode: doc.seedMode || '',
    seedCount: Number(doc.seedCount) || 0,
    location: doc.location || '',
    startTime: doc.startTime || null,
    courtCount: Number(doc.courtCount) || 0,
    quota,
    quotaText: quota > 0 ? `${count}/${quota} 人` : `${count} 人`,
    status: doc.status,
    statusLabel: EVENT_STATUS_LABEL[doc.status] || '',
    isSignup: doc.status === EVENT_STATUS.SIGNUP,
    isOngoing: doc.status === EVENT_STATUS.ONGOING,
    isFinished: doc.status === EVENT_STATUS.FINISHED,
    pinned: Boolean(doc.pinned),
    drawn: Boolean(doc.draw),
    signupCount: count,
    publisherId: doc.publisherId || '',
    publisherName: doc.publisherName || '',
    revision: Number(doc.revision || 1),
    mySignup: state.status === null ? null : { ...state, ...signupDTO(mySignup) },
  };
}

/** 由规范化记录组装可落库的赛事主记录：补范围、稳定主键、ISO 时间与版本。 */
function eventDocFromRecord(record, eventId, ctx, fingerprint) {
  return {
    ...record,
    _id: eventId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    startTime: iso(record.startTime),
    publishTime: iso(record.publishTime),
    pinned: false,
    signupCount: 0,
    fingerprint,
    revision: 1,
    updatedAt: iso(record.publishTime),
  };
}

/** 幂等指纹：同编号重发同样的单子返回同一条，改过内容则拒绝。 */
const fingerprintOf = record => JSON.stringify([
  record.title, record.description, record.matchType, record.discipline,
  record.format, record.level, record.bronzeMode, record.placementMode,
  record.seedMode, record.seedCount, record.location, record.quota, record.courtCount,
  new Date(record.startTime).getTime(),
]);

/* ------------------------------------------------------------------ 读 */

async function listSchoolEvents(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, events: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const canManage = canManageAssociationSpace(ctx);
  let rows = (await ctx.repo.forScope(ctx).events.list()).filter(isEventDoc);
  if (typeof payload.status === 'number') rows = rows.filter(row => row.status === payload.status);

  const signups = await ctx.repo.forScope(ctx).eventSignups.list();
  const myId = ctx.actorId;
  const sorted = rows.slice().sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    const pri = row => (row.status === EVENT_STATUS.SIGNUP ? 0 : row.status === EVENT_STATUS.ONGOING ? 1 : 2);
    const byStatus = pri(a) - pri(b);
    if (byStatus !== 0) return byStatus;
    const ta = Date.parse(a.startTime) || 0;
    const tb = Date.parse(b.startTime) || 0;
    if (tb !== ta) return tb - ta;
    return a._id < b._id ? -1 : 1;
  });
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, EVENT_LIST_MAX) : EVENT_LIST_LIMIT;
  const page = sorted.slice(0, limit);
  return ok({
    ok: true, canManage,
    hasMore: sorted.length > page.length,
    events: page.map(doc => eventSummary(doc, signupOf(signups.filter(s => s.eventId === doc._id), myId))),
    message: '',
  });
}

async function getSchoolEvent(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const doc = await ctx.repo.events.getById(payload.eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('赛事不存在'));

  const canManage = canManageAssociationSpace(ctx);
  const canParticipate = canParticipateInAssociation(ctx);
  const mySignup = ctx.actorId
    ? await ctx.repo.eventSignups.getById(schoolEventSignupKey(doc._id, ctx.actorId, ctx))
    : null;
  const signups = (await ctx.repo.forScope(ctx).eventSignups.list()).filter(row => row.eventId === doc._id);

  const state = signupStateOf(mySignup);
  const full = Number(doc.quota) > 0 && Number(doc.signupCount || 0) >= Number(doc.quota);
  const genderLimit = singleGenderOf(doc.discipline);
  const genderOk = !genderLimit || (ctx.actor && ctx.actor.gender === genderLimit);

  let signupNote = '';
  if (!canParticipate) signupNote = '只有本协会有效会员可以报名';
  else if (doc.status !== EVENT_STATUS.SIGNUP) signupNote = '报名已截止';
  else if (doc.draw) signupNote = '已抽签，报名名单已定';
  else if (!genderOk) signupNote = `本赛事为${disciplineLabelOf(doc.discipline)}，仅限${GENDER_LABEL[genderLimit]}会员报名`;
  else if (state.signed) signupNote = '';
  else if (full) signupNote = '名额已满';

  const canSignUp = canParticipate && doc.status === EVENT_STATUS.SIGNUP && !doc.draw &&
    genderOk && !state.signed && !full;
  const canCancelSignup = doc.status === EVENT_STATUS.SIGNUP && !doc.draw &&
    Boolean(mySignup && mySignup.status === SIGNUP_STATUS.SIGNED);

  // 管理动作的按钮可见性由服务端算好，页面照着渲染。
  // 判据复用写入端同一把尺子（canStartEvent / canDrawEvent / canFinishEvent）；
  // 写入时仍会再校验一遍——能力只说明「这一刻理论上可不可以」，不是写入许可。
  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);

  return ok({
    ok: true, canManage, canParticipate,
    // 详情才带 draw / results（列表保持精简）；字段经投影，不透传整条库记录。
    event: {
      ...eventSummary(doc, mySignup),
      draw: drawDTO(doc.draw),
      results: resultsDTO(doc.results),
    },
    mySignup: signupDTO(mySignup),
    signupCount: activeSignupCount(signups),
    capabilities: {
      canSignUp,
      canCancelSignup,
      canStart: canStartEvent(doc, actor),
      canDraw: canDrawEvent(doc, actor),
      canFinish: canFinishEvent(doc, actor),
    },
    signupNote, message: '',
  });
}

/**
 * 某场赛事的报名名单（含展示所需的会员字段）。
 * ============================================================
 * 【为什么是独立读端，而不是让客户端拉全校名录自己拼】
 * 名单要的昵称 / 学院只有服务端一次读齐最省，也最不容易把别处的隐私字段
 * 顺带漏出去；且「谁能看这份名单」与赛事读取同一条锁（本协会有效会员）。
 *
 * 【不下发的字段】
 * 学号、手机号一律不带（与名录同一隐私口径）；等级分与赛季积分也不在这里——
 * 那是计分服务的读端（school-rank-service.getSchoolMemberStats），
 * 避免任何一个读端被撑成全量快照。
 *
 * 【代签到能力为什么挂在记录上】
 * 「能不能替这位会员签到」取决于赛事状态、操作者角色与目标学院（见 event.canCheckIn），
 * 是逐条报名的判断，因此放在每一行 signups 上，而不是赛事级的 capabilities。
 *
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 */
async function listSchoolEventSignups(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok({ ok: false, signups: [], message: '没有读取协会空间的权限' });
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const doc = await ctx.repo.events.getById(payload.eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('赛事不存在'));

  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const memberById = new Map(dir.members.map(member => [member._id, member]));

  const rows = (await ctx.repo.forScope(ctx).eventSignups.list())
    .filter(row => row.eventId === doc._id && row.status !== SIGNUP_STATUS.CANCELED)
    .sort((a, b) => (String(a.signTime || '') < String(b.signTime || '') ? -1 : 1));

  const signups = rows.map(row => {
    const member = memberById.get(row.userId) || {};
    const college = dir.collegeOf(row.userId);
    return {
      userId: row.userId,
      nickName: member.nickName || row.userId,
      realName: member.realName || '',
      avatarUrl: member.avatarUrl || '',
      gender: member.gender || '',
      college,
      status: row.status,
      statusLabel: SIGNUP_STATUS_LABEL[row.status] || '',
      signTime: row.signTime || null,
      checkInTime: row.checkInTime || null,
      canCheckIn: canCheckIn(doc, actor, { target: { college } }),
    };
  });
  return ok({ ok: true, signups, message: '' });
}

/* ------------------------------------------------------------------ 写 */

async function publishSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const built = buildEventRecord(payload, { actor: ctx.actor, now: ctx.now });
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors }));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canManageAssociationSpace(fresh)) return refused('只有协会负责人及以上可以发布赛事');
    const eventId = schoolEventKey(schoolKey('e', fresh.actorId, token), fresh);
    const doc = eventDocFromRecord(built.record, eventId, fresh, fingerprintOf(built.record));
    const existing = await tx.events.getById(eventId);
    if (isEventDoc(existing)) {
      return existing.fingerprint === doc.fingerprint
        ? { ok: true, event: eventSummary(existing), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    await tx.events.set(eventId, doc);
    await tx.audit.append({ _id: eventAuditKey(eventId, 'publishEvent', 1),
      action: 'publishEvent', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, eventId, at: iso(fresh.now) });
    return { ok: true, event: eventSummary(doc), message: '' };
  });
  return ok(result);
}

async function signUpSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canParticipateInAssociation(fresh)) return refused('只有本协会有效会员可以报名');
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('赛事不存在');
    if (doc.status !== EVENT_STATUS.SIGNUP) return refused('报名已经截止了');
    if (doc.draw) return refused('已抽签，报名名单已定');

    const genderLimit = singleGenderOf(doc.discipline);
    if (genderLimit && (!fresh.actor || fresh.actor.gender !== genderLimit)) {
      return refused(`本赛事为${disciplineLabelOf(doc.discipline)}，仅限${GENDER_LABEL[genderLimit]}会员报名`);
    }

    const key = schoolEventSignupKey(doc._id, userId, fresh);
    const existing = await tx.eventSignups.getById(key);
    if (existing && existing.status !== SIGNUP_STATUS.CANCELED) {
      return { ok: true, signup: signupDTO(existing), event: eventSummary(doc, existing), message: '' };
    }
    if (Number(doc.quota) > 0 && Number(doc.signupCount || 0) >= Number(doc.quota)) {
      return refused('名额已满');
    }

    const nowIso = iso(fresh.now);
    const signup = existing
      ? { ...existing, status: SIGNUP_STATUS.SIGNED, signTime: nowIso, checkInTime: null,
        actorId: userId, cancelTime: null, revision: existing.revision + 1 }
      : { _id: key, schoolId: fresh.schoolId, association: fresh.association,
        eventId: doc._id, userId, status: SIGNUP_STATUS.SIGNED, signTime: nowIso,
        checkInTime: null, actorId: userId, cancelTime: null, revision: 1 };
    await tx.eventSignups.set(key, signup);
    const next = { ...doc, signupCount: Number(doc.signupCount || 0) + 1,
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(doc._id, userId, 'signUpEvent', next.revision - 1),
      action: 'signUpEvent', schoolId: fresh.schoolId, association: fresh.association,
      actorId: userId, eventId: doc._id, targetUserId: userId, at: nowIso });
    return { ok: true, signup: signupDTO(signup), event: eventSummary(next, signup), message: '' };
  });
  return ok(result);
}

async function cancelSchoolEventSignup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const userId = ctx.actorId;

  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    const key = schoolEventSignupKey(doc._id, userId, ctx);
    const reg = await tx.eventSignups.getById(key);
    if (!reg || reg.status === SIGNUP_STATUS.CANCELED) {
      return { ok: true, event: eventSummary(doc, reg), message: '' };
    }
    if (doc.status !== EVENT_STATUS.SIGNUP || doc.draw) return refused('报名已经截止，不能取消');

    const nowIso = iso(ctx.now);
    const canceled = { ...reg, status: SIGNUP_STATUS.CANCELED, cancelTime: nowIso,
      revision: reg.revision + 1 };
    await tx.eventSignups.set(key, canceled);
    const next = { ...doc, signupCount: Math.max(0, Number(doc.signupCount || 0) - 1),
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: signupAuditKey(doc._id, userId, 'cancelSignupEvent', canceled.revision),
      action: 'cancelSignupEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: userId, eventId: doc._id, targetUserId: userId, at: nowIso });
    return { ok: true, event: eventSummary(next, canceled), message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------- 生命周期 */

/**
 * 由抽签 / 推进产出的比赛草稿组装可落库的比赛记录。
 * 草稿的 _id 已是确定性签位键（含范围化的 eventId），此处只补范围与初始状态。
 */
function scopedMatchDoc(draft, ctx, action) {
  return {
    ...draft,
    schoolId: ctx.schoolId,
    association: ctx.association,
    competition: MATCH_COMPETITION.PERSONAL,
    status: MATCH_STATUS.PENDING,
    action,
    actor: ctx.actorId,
    actedAt: iso(ctx.now),
    revision: 1,
  };
}

/**
 * 开始赛事（报名中 → 进行中）。开始后才能代签与录名次。
 * 与旧栈 mock.startEvent 同一口径：仅管理员；未抽签则拦下并说明原因。
 */
async function startSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    if (!canStartEvent(doc, actor)) {
      return refused(doc.status !== EVENT_STATUS.SIGNUP
        ? '这场赛事已经开始了' : '只有协会负责人及以上可以开始赛事');
    }
    // 未抽签就没有任何比赛可打，先抽签再开赛（与旧栈 startBlockedReason 同一句提示）。
    const blocked = startBlockedReason(doc);
    if (blocked) return refused(blocked);

    const nowIso = iso(ctx.now);
    const next = { ...doc, status: EVENT_STATUS.ONGOING, action: 'start',
      actor: ctx.actorId, actedAt: nowIso, revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: eventAuditKey(doc._id, 'startEvent', next.revision),
      action: 'startEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, at: nowIso });
    return { ok: true, event: eventSummary(next), message: '' };
  });
  return ok(result);
}

/**
 * 抽签 / 重抽：算出签表与首轮比赛，落库。
 * 抽签只是报名阶段的管理动作；已有比赛确认生效后禁止重抽（分数已发出去）。
 * 重抽覆盖同一批签位编号（确定性键），不会堆出两批首轮。
 */
async function drawSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const scoped = ctx.repo.forScope(ctx);
  const doc = await ctx.repo.events.getById(payload.eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('赛事不存在'));
  if (!canDrawEvent(doc, actor)) {
    return ok(refused(doc.status !== EVENT_STATUS.SIGNUP
      ? '只能在报名阶段抽签' : '只有协会负责人及以上可以抽签'));
  }

  const signups = (await scoped.eventSignups.list()).filter(row => row.eventId === doc._id);
  const existing = (await scoped.matches.list()).filter(row => row.eventId === doc._id);
  if (doc.draw && !canRedraw(existing)) return ok(refused('该赛事已有比赛确认生效，不能再重抽'));

  const value = payload.seedValue === undefined || payload.seedValue === null
    ? Date.now() : Number(payload.seedValue);
  const plan = planDraw({ event: doc, signups, members: dir.members,
    seedValue: value, manualOrder: payload.manualOrder });
  if (!plan.ok) return ok(refused(plan.message));

  const draw = buildDrawRecord(plan, {
    drawnAt: ctx.now, drawnBy: ctx.actorId,
    drawCount: (doc.draw && doc.draw.drawCount ? doc.draw.drawCount : 0) + 1,
  });
  const drafts = buildInitialMatches(doc, draw).map(draft => scopedMatchDoc(draft, ctx, 'draw'));
  // 场号在 buildInitialMatches 内已由 court.js 统一排好，结果落库备查。

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await tx.events.getById(payload.eventId);
    if (!isEventDoc(fresh) || !belongsToSchoolScope(fresh, ctx)) return refused('赛事不存在');
    if (!canDrawEvent(fresh, actor)) return refused('只能在报名阶段抽签');

    const nowIso = iso(ctx.now);
    for (const draft of drafts) {
      await tx.matches.set(draft._id, draft);
    }
    const next = { ...fresh, draw, action: 'draw', actor: ctx.actorId,
      actedAt: nowIso, revision: fresh.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: eventAuditKey(fresh._id, 'drawEvent', next.revision),
      action: 'drawEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: fresh._id, at: nowIso });
    return { ok: true, event: eventSummary(next), draw,
      matchIds: drafts.map(draft => draft._id), message: '' };
  });
  return ok(result);
}

/**
 * 代签（管理端）：把某位报名者的报名记录置为已签到。
 * 只有进行中的赛事可签；学院负责人只能签本学院的人，管理员不限。
 */
async function checkInSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  const userId = String(payload.userId || '').trim();
  if (!userId) return ok(refused('请指定要签到的会员'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  // 始终带上目标学院，避免「未指定目标」的短路把学院边界放行（见 event.canCheckIn）。
  const target = { college: dir.collegeOf(userId) };

  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    if (!canCheckIn(doc, actor, { target })) {
      return refused(doc.status !== EVENT_STATUS.ONGOING
        ? '只有进行中的赛事可以签到' : '你无权为这位会员签到');
    }

    const key = schoolEventSignupKey(doc._id, userId, ctx);
    const signup = await tx.eventSignups.getById(key);
    const built = buildCheckInPatch(signup, actor, { now: ctx.now });
    if (!built.ok) return refused(built.message);

    const nowIso = iso(ctx.now);
    const next = { ...signup, ...built.patch, checkInTime: nowIso, revision: signup.revision + 1 };
    await tx.eventSignups.set(key, next);
    await tx.audit.append({ _id: signupAuditKey(doc._id, userId, 'checkInEvent', next.revision),
      action: 'checkInEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, targetUserId: userId, at: nowIso });
    return { ok: true, signup: signupDTO(next), message: '' };
  });
  return ok(result);
}

/**
 * 录入名次并结束赛事（进行中 → 已结束）。仅管理员。
 * 名次必须落在实际报名者身上，且按赛制的成对规则校验（validatePlacements）。
 */
async function finishSchoolEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少赛事编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const signups = (await ctx.repo.forScope(ctx).eventSignups.list())
    .filter(row => row.eventId === payload.eventId);

  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.events.getById(payload.eventId);
    if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('赛事不存在');
    if (!canFinishEvent(doc, actor)) {
      return refused(doc.status !== EVENT_STATUS.ONGOING
        ? '只有进行中的赛事可以录入名次' : '只有协会负责人及以上可以录入名次');
    }

    const validUsers = new Set(signups
      .filter(row => row.status !== SIGNUP_STATUS.CANCELED).map(row => row.userId));
    const entryCount = drawnEntryCount(doc.draw) || validUsers.size;
    const checked = validatePlacements(payload.results, {
      bronzeMode: doc.bronzeMode, entryCount, format: doc.format, matchType: doc.matchType,
    });
    if (!checked.ok) return refused(checked.firstError, { errors: checked.errors });
    if (checked.results.some(row => !validUsers.has(row.userId))) {
      return refused('名次里出现了没有报名这场赛事的会员');
    }

    const nowIso = iso(ctx.now);
    const next = { ...doc, status: EVENT_STATUS.FINISHED, results: checked.results,
      action: 'finish', actor: ctx.actorId, finishedAt: nowIso, actedAt: nowIso,
      revision: doc.revision + 1, updatedAt: nowIso };
    await tx.events.set(next._id, next);
    await tx.audit.append({ _id: eventAuditKey(doc._id, 'finishEvent', next.revision),
      action: 'finishEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, at: nowIso });
    return { ok: true, event: eventSummary(next), results: checked.results, message: '' };
  });
  return ok(result);
}

/**
 * 签表推进（内部动作，非客户端入口）：一轮全部打完 / 有弃权后，把下一轮补排出来。
 * 「只补不覆盖」——已有编号（含待确认）一律跳过，绝不抹掉已录的比分。
 * 由 school-match-service 在 confirm / forfeit 生效后调用。
 *
 * @param {Object} ctx
 * @param {string} eventId
 * @returns {Promise<{ok:boolean, inserted:number}>}
 */
async function advanceSchoolEvent(ctx, eventId) {
  // 误当成客户端 action 调用时（payload 顶到 ctx 位）在此立刻收手。
  if (!ctx || !ctx.repo || typeof eventId !== 'string' || !eventId) {
    return { ok: true, inserted: 0 };
  }
  const doc = await ctx.repo.events.getById(eventId);
  if (!isEventDoc(doc) || !belongsToSchoolScope(doc, ctx) || !doc.draw) {
    return { ok: true, inserted: 0 };
  }

  const matches = (await ctx.repo.forScope(ctx).matches.list())
    .filter(row => row.eventId === eventId);
  const plan = planStageMatches({ event: doc, draw: doc.draw, matches });
  if (!plan.ok) return { ok: true, inserted: 0 };

  const taken = new Set(matches.map(row => row._id));
  const drafts = buildPlannedDrafts(doc, plan.rounds)
    .filter(draft => !taken.has(draft._id))
    .map(draft => scopedMatchDoc(draft, ctx, 'advance'));
  if (drafts.length === 0) return { ok: true, inserted: 0 };

  await ctx.repo.transaction(async tx => {
    for (const draft of drafts) {
      // 并发下两次确认可能同时推进：已有编号就不再写。
      const existing = await tx.matches.getById(draft._id);
      if (existing) continue;
      await tx.matches.set(draft._id, draft);
    }
  });
  return { ok: true, inserted: drafts.length };
}

module.exports = {
  EVENT_LIST_LIMIT, EVENT_LIST_MAX,
  isEventDoc, eventSummary, activeSignupCount,
  listSchoolEvents, getSchoolEvent, listSchoolEventSignups, publishSchoolEvent,
  signUpSchoolEvent, cancelSchoolEventSignup,
  startSchoolEvent, drawSchoolEvent, checkInSchoolEvent, finishSchoolEvent,
  // 内部动作：供 school-match-service 在 confirm / forfeit 后补排下一轮。
  advanceSchoolEvent,
};
