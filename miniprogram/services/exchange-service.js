/** S4 跨校邀请赛。独立集合，服务端强制不计校内分。2026-10-16 起支持与普通赛事同样的六种赛制。 */
const { buildSchoolContext } = require('./school-context.js');
const { canSchoolAction } = require('./school-permission.js');
const { schoolKey, schoolAssociationKey, PLATFORM_ROLE, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { planExchangeDraw, planExchangeMatches, placementsFromExchange, findExchangeDependents } = require('./exchange-plan.js');
const { formatOf, normalizeGroupCount, normalizeAdvancePerGroup } = require('./draw.js');
const {
  EVENT_FORMAT, EVENT_FORMAT_LABEL, DEFAULT_EVENT_FORMAT,
  GROUP_COUNT_FORMATS, ADVANCE_FORMATS, KNOCKOUT_FORMATS, DOUBLE_ELIM_FORMATS,
  EVENT_BRONZE_MODE, EVENT_PLACEMENT_MODE, DEFAULT_BRONZE_MODE, DEFAULT_PLACEMENT_MODE,
  DEFAULT_GF_RESET, BRACKET_STAGE, stageOrder,
} = require('../utils/constants.js');

const FORMAT_VALUES = Object.values(EVENT_FORMAT);

/** 阶段文案（对阵列表用；与普通赛事同一套 BRACKET_STAGE） */
const STAGE_TEXT = {
  [BRACKET_STAGE.MAIN]: '正赛',
  [BRACKET_STAGE.BRONZE]: '三四名赛',
  [BRACKET_STAGE.GROUP]: '小组赛',
  [BRACKET_STAGE.WINNERS]: '胜者组',
  [BRACKET_STAGE.LOSERS]: '败者组',
  [BRACKET_STAGE.GRAND_FINAL]: '总决赛',
  [BRACKET_STAGE.PLACEMENT]: '排位赛',
};

/**
 * 赛制参数收敛。
 * 只保留该赛制真正用得到的字段，其余一律落缺省——免得「单败淘汰」的赛事
 * 里躺着一个幽灵般的 gfReset，日后没人说得清它当初为什么在那儿。
 *
 * @param {Object} payload 创建表单
 * @returns {Object} 可直接并进赛事记录的赛制字段
 */
function normalizeExchangeFormat(payload = {}) {
  const format = FORMAT_VALUES.includes(payload.format) ? payload.format : DEFAULT_EVENT_FORMAT;
  const config = {
    format,
    bronzeMode: DEFAULT_BRONZE_MODE,
    placementMode: DEFAULT_PLACEMENT_MODE,
    gfReset: DEFAULT_GF_RESET,
  };
  if (GROUP_COUNT_FORMATS.includes(format)) config.groupCount = normalizeGroupCount(payload.groupCount);
  if (ADVANCE_FORMATS.includes(format)) config.advancePerGroup = normalizeAdvancePerGroup(payload.advancePerGroup);
  if (KNOCKOUT_FORMATS.includes(format)) {
    config.bronzeMode = payload.bronzeMode === EVENT_BRONZE_MODE.PLAYOFF
      ? EVENT_BRONZE_MODE.PLAYOFF : EVENT_BRONZE_MODE.TIED;
    config.placementMode = payload.placementMode === EVENT_PLACEMENT_MODE.TOP8
      ? EVENT_PLACEMENT_MODE.TOP8 : EVENT_PLACEMENT_MODE.NONE;
  }
  if (DOUBLE_ELIM_FORMATS.includes(format)) {
    config.gfReset = payload.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(payload.gfReset);
  }
  return config;
}

const ok = data => ({ ok: true, data });
const refused = message => ({ ok: false, message });
const invitationKey = (eventId, schoolId) => schoolKey('xi', eventId, schoolId);
const signupKey = (eventId, userId) => schoolKey('xs', eventId, userId);
const freshContext = (repo, ctx) => buildSchoolContext({ repo, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
const manages = ctx => canSchoolAction(ctx, 'manageAssociation', ctx);
const participates = ctx => canSchoolAction(ctx, 'participate', ctx);
const eventMatches = (event, ctx) => event && event.eventScope === 'inter_school' &&
  event.ratingPolicy === 'unrated' && event.association === ctx.association &&
  Object.prototype.hasOwnProperty.call(event.invitations, ctx.schoolId);
const canSee = (event, ctx) => eventMatches(event, ctx) &&
  (manages(ctx) || event.invitations[ctx.schoolId] === 'accepted' && participates(ctx));
const isPlatformAdmin = ctx => Boolean(ctx.actor && ctx.actor.platformRole === PLATFORM_ROLE.ADMIN &&
  ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE);
// 抽签、指定裁判、名次确认：平台管理员或参赛双方的校管理员。
const managesExchange = (event, ctx) => Boolean(event && event.eventScope === 'inter_school' &&
  event.ratingPolicy === 'unrated' && event.association === ctx.association &&
  (isPlatformAdmin(ctx) || eventMatches(event, ctx) && manages(ctx)));
const managesParticipant = (event, ctx) => Boolean(eventMatches(event, ctx) && manages(ctx));
// 比分确认：管理员或双方校管理员；设了裁判则限裁判；未设裁判才轮到比赛双方。
const canScoreMatch = (event, match, ctx) => {
  if (!event || !match || event.eventScope !== 'inter_school' || event.ratingPolicy !== 'unrated' ||
      event.association !== ctx.association) return false;
  if (isPlatformAdmin(ctx) || managesParticipant(event, ctx)) return true;
  if (match.referee) return ctx.actorId === match.referee;
  return Boolean(ctx.actorId) && (ctx.actorId === match.playerA || ctx.actorId === match.playerB);
};
const summary = event => ({
  _id: event._id, schoolId: event.schoolId, association: event.association,
  title: event.title, location: event.location, startTime: event.startTime, status: event.status,
  schoolNames: event.schoolNames, participantSchoolIds: event.participantSchoolIds,
  invitations: event.invitations, quota: event.quota, schoolQuotas: event.schoolQuotas,
  signupCount: event.signupCount, schoolCounts: event.schoolCounts,
  ratingPolicy: 'unrated', eventScope: 'inter_school', matchType: 'singles',
  // 赛制与它的参数：读端据此在页面上展示「单败淘汰」「小组赛+淘汰」等
  format: formatOf(event), formatLabel: EVENT_FORMAT_LABEL[formatOf(event)] || '',
  groupCount: event.groupCount || 0, advancePerGroup: event.advancePerGroup || 0,
  bronzeMode: event.bronzeMode || DEFAULT_BRONZE_MODE,
  placementMode: event.placementMode || DEFAULT_PLACEMENT_MODE,
  gfReset: event.gfReset === undefined ? DEFAULT_GF_RESET : Boolean(event.gfReset),
  draw: event.draw || null, results: event.results || [],
  canceledAt: event.canceledAt || null, canceledBy: event.canceledBy || '',
  cancelReason: event.cancelReason || '',
});
async function audit(tx, ctx, event, action) {
  await tx.audit.append({ _id: schoolKey('xa', event._id, String(event.revision)), action,
    eventId: event._id, schoolId: ctx.schoolId, actorId: ctx.actorId, at: ctx.now });
}

async function createExchangeEvent(payload = {}, ctx) {
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const location = typeof payload.location === 'string' ? payload.location.trim() : '';
  const token = payload.requestId;
  const ids = payload.participantSchoolIds;
  if (!title || title.length > 80 || !location || location.length > 120) return ok(refused('请填写赛事名称和地点'));
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(token)) return ok(refused('创建请求编号无效'));
  const start = new Date(payload.startTime);
  if (!Number.isFinite(start.getTime()) || start <= new Date(ctx.now)) return ok(refused('请选择未来的开赛时间'));
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || new Set(ids).size !== ids.length ||
      !ids.includes(ctx.schoolId) || ids.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id))) return ok(refused('请选择含主办校在内的 2 至 8 所学校'));
  const quota = payload.quota;
  const quotas = payload.schoolQuotas || {};
  if (!Number.isInteger(quota) || quota < 2 || quota > 128 || ids.some(id =>
    !Number.isInteger(quotas[id]) || quotas[id] < 1 || quotas[id] > quota) ||
    ids.reduce((sum, id) => sum + quotas[id], 0) < quota) return ok(refused('请设置有效的总名额和各校名额'));
  const schoolIds = [...ids].sort();
  const schoolQuotas = Object.fromEntries(schoolIds.map(id => [id, quotas[id]]));
  // 赛制进指纹：同一请求编号下改了赛制就该被拒绝，而不是静默沿用旧的那一场
  const formatConfig = normalizeExchangeFormat(payload);
  const fingerprint = JSON.stringify([title, location, start.toISOString(), schoolIds, quota, schoolQuotas, formatConfig]);
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!manages(fresh)) return refused('只有本校管理员或协会负责人可以发起邀请赛');
    const id = schoolKey('xe', fresh.schoolId, fresh.association, fresh.actorId, token);
    const existing = await tx.exchangeEvents.getById(id);
    if (existing) return existing.fingerprint === fingerprint
      ? { ok: true, event: summary(existing), message: '' } : refused('请求编号已使用，请重新创建');
    const schoolNames = {};
    for (const schoolId of schoolIds) {
      const school = await tx.schools.getById(schoolId);
      const association = await tx.schoolAssociations.getById(schoolAssociationKey({ schoolId, association: fresh.association }));
      if (!school || school.schoolId !== schoolId || school.status !== 'active' || !association || association.status !== 'active' ||
          association.schoolId !== schoolId || association.association !== fresh.association) return refused('参与学校或项目未启用');
      schoolNames[schoolId] = school.name;
    }
    const event = { _id: id, schoolId: fresh.schoolId, association: fresh.association, title, location,
      startTime: start.toISOString(), participantSchoolIds: schoolIds, schoolNames, quota, schoolQuotas,
      invitations: Object.fromEntries(schoolIds.map(schoolId => [schoolId, schoolId === fresh.schoolId ? 'accepted' : 'pending'])),
      schoolCounts: Object.fromEntries(schoolIds.map(schoolId => [schoolId, 0])), signupCount: 0,
      status: 'signup', eventScope: 'inter_school', ratingPolicy: 'unrated', matchType: 'singles',
      // 赛制与参数（见 normalizeExchangeFormat）：项目仍固定单打，赛制可选
      ...formatConfig,
      revision: 1, fingerprint, createdBy: fresh.actorId, createdAt: fresh.now };
    await tx.exchangeEvents.set(id, event);
    for (const schoolId of schoolIds) await tx.exchangeInvitations.set(invitationKey(id, schoolId), {
      eventId: id, schoolId, association: fresh.association,
    });
    await audit(tx, fresh, event, 'createExchangeEvent');
    return { ok: true, event: summary(event), message: '' };
  });
  return ok(result);
}

async function respondExchangeInvitation(payload = {}, ctx) {
  if (!['accepted', 'declined'].includes(payload.decision)) return ok(refused('邀请决定无效'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!eventMatches(event, fresh) || !manages(fresh) || event.schoolId === fresh.schoolId) return refused('没有此邀请的处理权限');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (event.invitations[fresh.schoolId] === payload.decision) return { ok: true, event: summary(event), message: '' };
    if (event.status !== 'signup' || event.invitations[fresh.schoolId] !== 'pending') return refused('邀请已处理或报名已锁定');
    const next = { ...event, invitations: { ...event.invitations, [fresh.schoolId]: payload.decision }, revision: event.revision + 1 };
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, 'respondExchangeInvitation');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function changeSignup(payload, ctx, cancel) {
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!eventMatches(event, fresh) || !participates(fresh) || event.invitations[fresh.schoolId] !== 'accepted') return refused('仅已接受邀请学校的有效会员可以操作');
    if (event.status !== 'signup' || new Date(event.startTime) <= new Date(fresh.now)) return refused('报名已截止或名单已锁定');
    const id = signupKey(event._id, fresh.actorId);
    const previous = await tx.exchangeSignups.getById(id);
    if (previous && previous.representedSchoolId !== fresh.schoolId) return refused('不能变更本赛事代表学校');
    if (cancel && (!previous || previous.status !== 'signed')) return refused('没有可取消的报名');
    if (!cancel && previous && previous.status === 'signed') return { ok: true, event: summary(event), message: '' };
    if (!cancel && (event.signupCount >= event.quota || event.schoolCounts[fresh.schoolId] >= event.schoolQuotas[fresh.schoolId])) return refused('总名额或本校名额已满');
    const delta = cancel ? -1 : 1;
    const next = { ...event, signupCount: event.signupCount + delta,
      schoolCounts: { ...event.schoolCounts, [fresh.schoolId]: event.schoolCounts[fresh.schoolId] + delta }, revision: event.revision + 1 };
    await tx.exchangeSignups.set(id, { _id: id, eventId: event._id, schoolId: event.schoolId,
      association: event.association, userId: fresh.actorId, representedSchoolId: fresh.schoolId,
      schoolMemberId: fresh.schoolMember._id, nickName: fresh.actor.nickName || '参赛会员',
      schoolName: event.schoolNames[fresh.schoolId], status: cancel ? 'canceled' : 'signed', updatedAt: fresh.now });
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, cancel ? 'cancelExchangeSignup' : 'signUpExchangeEvent');
    return { ok: true, event: summary(next), message: '' };
  }));
}
const signUpExchangeEvent = (payload = {}, ctx) => changeSignup(payload, ctx, false);
const cancelExchangeSignup = (payload = {}, ctx) => changeSignup(payload, ctx, true);

/**
 * 管理员移除一位报名者（退赛处理）。
 * ============================================================
 * 与本人取消报名同一口径：**只在报名阶段**（名单锁定后名单就定了），
 * 释放总名额与本校名额，写审计；重复移除幂等。普通赛事里这条路对应
 * 「管理员把某人从报名名单里去掉」，因此参赛者的代表学校由服务端从报名
 * 记录读取，不接受客户端传学校。
 *
 * @param {Object} payload { eventId, userId, reason? }
 * @param {Object} ctx
 */
async function removeExchangeSignup(payload = {}, ctx) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return ok(refused('请选择要移除的报名者'));
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 200) : '';
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以移除报名'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以移除报名');
    if (event.status !== 'signup') return refused('名单已锁定，不能再移除报名');
    const row = await tx.exchangeSignups.getById(signupKey(event._id, userId));
    if (!row || row.status !== 'signed') return { ok: true, event: summary(event), message: '' };
    if (!isPlatformAdmin(fresh) && row.representedSchoolId !== fresh.schoolId) {
      return refused('只能移除本校的报名者');
    }
    const next = { ...event,
      signupCount: Math.max(0, event.signupCount - 1),
      schoolCounts: { ...event.schoolCounts,
        [row.representedSchoolId]: Math.max(0, (event.schoolCounts[row.representedSchoolId] || 0) - 1) },
      revision: event.revision + 1 };
    await tx.exchangeSignups.set(row._id, { ...row, status: 'removed', removedBy: fresh.actorId,
      removedAt: fresh.now, removeReason: reason, revision: Number(row.revision || 1) + 1 });
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'removeExchangeSignup');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 代签：与普通赛事一样，由管理员在场边替参赛者签到（本人不自助签到）。
 * 只有「名单已锁定（ready / drawn）」到赛事结束之间可签，重复签到幂等。
 *
 * @param {Object} payload { eventId, userId }
 * @param {Object} ctx
 */
async function checkInExchangeSignup(payload = {}, ctx) {
  const userId = String(payload.userId || '').trim();
  if (!userId) return ok(refused('请选择要签到的参赛者'));
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以签到'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以签到');
    if (event.status !== 'ready' && event.status !== 'drawn') return refused('名单锁定后才能签到');
    const row = await tx.exchangeSignups.getById(signupKey(event._id, userId));
    if (!row || row.status !== 'signed') return refused('这位参赛者不在名单里');
    if (!isPlatformAdmin(fresh) && row.representedSchoolId !== fresh.schoolId) {
      return refused('只能为本校参赛者签到');
    }
    if (row.checkInTime) return { ok: true, event: summary(event), message: '' };
    await tx.exchangeSignups.set(row._id, { ...row, checkInTime: fresh.now,
      checkedInBy: fresh.actorId, revision: Number(row.revision || 1) + 1 });
    await audit(tx, fresh, event, 'checkInExchangeSignup');
    return { ok: true, event: summary(event), message: '' };
  }));
}

/**
 * 撤回邀请。
 * ============================================================
 * 主办方可以撤回对某校的邀请；受邀校自己的管理员也可以撤回（等价于「不参加了」，
 * 但它不是婉拒——婉拒是受邀校给主办方的答复，撤回是把这条邀请作废）。
 * 只在报名阶段可撤；该校已经有人报名时先拒绝，要求先把报名清掉——
 * 否则名额计数与参赛名单会对不上。
 *
 * @param {Object} payload { eventId, schoolId? } schoolId 缺省为操作者本校
 */
async function withdrawExchangeInvitation(payload = {}, ctx) {
  const schoolId = String(payload.schoolId || ctx.schoolId || '').trim();
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以撤回邀请'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以撤回邀请');
    // 主办方可以撤任意受邀校；受邀校只能撤自己那一条
    const isOrganizer = event.schoolId === fresh.schoolId || isPlatformAdmin(fresh);
    if (!isOrganizer && schoolId !== fresh.schoolId) return refused('只能撤回本校的邀请');
    if (!Object.prototype.hasOwnProperty.call(event.invitations, schoolId)) return refused('该学校不在这场邀请赛里');
    if (event.schoolId === schoolId) return refused('主办学校不能撤回自己的邀请');
    if (event.status !== 'signup') return refused('名单已锁定，不能再撤回邀请');
    if ((event.schoolCounts[schoolId] || 0) > 0) return refused('该校已有人报名，请先移除报名再撤回邀请');
    if (event.invitations[schoolId] === 'withdrawn') return { ok: true, event: summary(event), message: '' };
    const next = { ...event, invitations: { ...event.invitations, [schoolId]: 'withdrawn' },
      revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'withdrawExchangeInvitation');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 取消整场邀请赛（主办方或平台管理员）。
 * 报名中 / 待开赛 / 已抽签都可取消；结束后不能再取消（名次已定）。
 * 取消后一切写动作停止（报名、抽签、录分、名次确认各自复核状态），
 * 已确认的比分与名单保留作为历史。
 *
 * @param {Object} payload { eventId, reason? }
 */
async function cancelExchangeEvent(payload = {}, ctx) {
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 200) : '';
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!snapshot || !eventMatches(snapshot, ctx) && !isPlatformAdmin(ctx)) return ok(refused('赛事不存在或没有访问权限'));
  const isOrganizer = isPlatformAdmin(ctx) || (snapshot.schoolId === ctx.schoolId && manages(ctx));
  if (!isOrganizer) return ok(refused('只有主办学校的管理员可以取消赛事'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!event || event.eventScope !== 'inter_school') return refused('赛事不存在');
    if (!(isPlatformAdmin(fresh) || (event.schoolId === fresh.schoolId && manages(fresh)))) {
      return refused('只有主办学校的管理员可以取消赛事');
    }
    if (event.status === 'canceled') return { ok: true, event: summary(event), message: '' };
    if (event.status === 'finished') return refused('赛事已结束，不能再取消');
    const next = { ...event, status: 'canceled', canceledAt: fresh.now,
      canceledBy: fresh.actorId, cancelReason: reason, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'cancelExchangeEvent');
    return { ok: true, event: summary(next), message: '' };
  }));
}

/**
 * 撤销一场已经确认的跨校比分（比分修订的第一步）。
 * ============================================================
 * 与普通比赛同一条规则：**后面还有已确认的场次就先撤后面的**（从最后一轮往前撤）。
 * 撤销把这一场退回「待确认」并清掉比分与胜者；下一轮的场次由签表投影重算——
 * 对阵在两侧重新定下来时会自动刷新（见 exchange-plan 的刷新逻辑），因此不会
 * 留下「上一轮的败者还在下一轮里」这种自相矛盾的签表。
 * 权限与录分一致：平台管理员、双方校管理员、或该场指定裁判。
 *
 * @param {Object} payload { eventId, matchId, reason? }
 */
async function revokeExchangeScore(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  const match = await ctx.repo.exchangeMatches.getById(payload.matchId);
  if (!snapshot || !match || match.eventId !== snapshot._id) return ok(refused('比赛不存在'));
  // 见 submitExchangeScore：已结束 / 已取消的赛事不再动比分。
  if (snapshot.status === 'finished') return ok(refused('赛事已结束，不能再撤销比分'));
  if (snapshot.status === 'canceled') return ok(refused('赛事已取消'));
  if (!canScoreMatch(snapshot, match, ctx)) return ok(refused('没有比分撤销权限'));
  // 撤销前的自查：谁排在这场之后。阶段与轮次的先后由 format-plan 判定，
  // 双败的胜者组 / 败者组 / 总决赛、小组赛与淘汰赛之间也分得清。
  // 只有「已确认」的后继会挡路——还没录分的下一轮会在重录后被刷新换人。
  const ledger = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  const laterIds = findExchangeDependents({ match, matches: ledger })
    .filter(id => {
      const row = ledger.find(item => item._id === id);
      return Boolean(row && row.status === 'active');
    });
  if (laterIds.length > 0) return ok(refused('后面轮次已有确认的比分，请从最后一轮往前依次撤销'));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    const current = await tx.exchangeMatches.getById(payload.matchId);
    if (!event || !current || current.eventId !== event._id) return refused('比赛不存在');
    if (!canScoreMatch(event, current, fresh)) return refused('没有比分撤销权限');
    if (event.status === 'finished') return refused('赛事已结束，不能再撤销比分');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (current.status !== 'active') return refused('这场比赛还没有确认的比分');
    // 事务内复查：读到撤销之前，可能刚有人确认了下一轮（整表查询事务里不允许，逐个点读）
    for (const id of laterIds) {
      const row = await tx.exchangeMatches.getById(id);
      if (row && row.status === 'active') return refused('后面轮次已有确认的比分，请从最后一轮往前依次撤销');
    }
    const scored = { ...current, scoreA: null, scoreB: null, winner: '', status: 'pending',
      recordedBy: '', recordedAt: null, revokedBy: fresh.actorId, revokedAt: fresh.now,
      revokeReason: typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 200) : '',
      revision: Number(current.revision || 1) + 1 };
    await tx.exchangeMatches.set(scored._id, scored);
    const next = { ...event, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'revokeExchangeScore');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function lockExchangeRoster(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!eventMatches(snapshot, ctx) || snapshot.schoolId !== ctx.schoolId || !manages(ctx)) return ok(refused('只有主办学校可以锁定名单'));
  const roster = (await ctx.repo.exchangeSignups.listByEvent(snapshot._id)).filter(row => row.status === 'signed');
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!eventMatches(event, fresh) || event.schoolId !== fresh.schoolId || !manages(fresh)) return refused('只有主办学校可以锁定名单');
    if (event.status !== 'signup') return refused('名单已锁定');
    if (event.revision !== snapshot.revision) return refused('报名名单已变化，请刷新后重试');
    if (Object.values(event.invitations).some(value => value === 'pending')) return refused('请等待受邀学校处理邀请');
    if (event.signupCount < 2 || Object.values(event.schoolCounts).filter(count => count > 0).length < 2) return refused('至少需要两校各有一名参赛者');
    if (roster.length !== event.signupCount) return refused('报名计数不一致，请联系管理员');
    // 失效身份处理：报名之后退学 / 转校 / 停用的人已经没有代表该校参赛的资格，
    // 在这里移除并释放名额（与训练「本人失效自动移除报名」同一处理），
    // 否则一场邀请赛会因为某个人退学而永远锁不上名单。
    const pruned = [];
    for (const row of roster) {
      const [member, user, school] = await Promise.all([
        tx.schoolMembers.getById(row.schoolMemberId),
        tx.users.getById(row.userId),
        tx.schools.getById(row.representedSchoolId),
      ]);
      const valid = member && member.userId === row.userId && member.schoolId === row.representedSchoolId &&
        member.status === 'active' && user && user.platformStatus === 'active' &&
        user.primarySchoolId === row.representedSchoolId && school && school.status === 'active';
      if (valid) continue;
      const removed = { ...row, status: 'removed', removedBy: fresh.actorId, removedAt: fresh.now,
        removeReason: '参赛身份已失效', revision: Number(row.revision || 1) + 1 };
      await tx.exchangeSignups.set(removed._id, removed);
      pruned.push({ userId: row.userId, representedSchoolId: row.representedSchoolId });
    }
    const schoolCounts = { ...event.schoolCounts };
    for (const row of pruned) {
      schoolCounts[row.representedSchoolId] = Math.max(0, (schoolCounts[row.representedSchoolId] || 0) - 1);
    }
    const signupCount = event.signupCount - pruned.length;
    if (pruned.length > 0 && (signupCount < 2 ||
        Object.values(schoolCounts).filter(count => count > 0).length < 2)) {
      return refused('清理失效身份后不足两校各一名参赛者，请补充报名');
    }
    const next = { ...event, status: 'ready', lockedAt: fresh.now, lockedBy: fresh.actorId,
      signupCount, schoolCounts, prunedSignups: pruned, revision: event.revision + 1 };
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, 'lockExchangeRoster');
    if (pruned.length > 0) await audit(tx, fresh, next, 'pruneInvalidExchangeSignups');
    return { ok: true, event: summary(next), message: '' };
  }));
}

// 名单锁定后，由报名记录构造参赛者映射；used by draw/score/ranking。
async function entrantsOf(repo, eventId) {
  const rows = (await repo.exchangeSignups.listByEvent(eventId)).filter(row => row.status === 'signed');
  return { rows, map: new Map(rows.map(row => [row.userId, { userId: row.userId, schoolId: row.representedSchoolId }])) };
}

async function drawExchangeEvent(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以抽签'));
  if (snapshot.status === 'canceled') return ok(refused('赛事已取消'));
  if (snapshot.status === 'signup') return ok(refused('请先锁定报名名单'));
  if (snapshot.status === 'finished') return ok(refused('赛事已结束，不能再抽签'));
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  if (existing.some(match => match.status === 'active')) return ok(refused('已有比赛确认生效，不能再抽签'));
  const { rows, map } = await entrantsOf(ctx.repo, snapshot._id);
  if (rows.length < 2) return ok(refused('至少需要两名参赛者才能抽签'));
  const seedValue = Number.isInteger(payload.seedValue) ? payload.seedValue : ctx.now.getTime();
  const planned = planExchangeDraw({ entries: rows, seedValue, format: formatOf(snapshot),
    groupCount: snapshot.groupCount, advancePerGroup: snapshot.advancePerGroup });
  if (!planned.ok) return ok(refused(planned.message));
  // 重抽时按当前签表整体重算，旧对阵的残留记录不会被投影出来。
  const built = planExchangeMatches({ event: snapshot, draw: planned.draw, entrantsById: map, matches: [] });
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以抽签');
    if (event.status !== 'ready' && event.status !== 'drawn') return refused('当前状态不能抽签');
    if (event.revision !== snapshot.revision) return refused('赛事已变化，请刷新后重试');
    const next = { ...event, status: 'drawn',
      draw: { ...planned.draw, createdAt: fresh.now, createdBy: fresh.actorId }, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    for (const match of built.matches) {
      await tx.exchangeMatches.set(match._id, { ...match, schoolId: event.schoolId, association: event.association });
    }
    await audit(tx, fresh, next, 'drawExchangeEvent');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function assignExchangeReferee(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以指定裁判'));
  const match = await ctx.repo.exchangeMatches.getById(payload.matchId);
  if (!match || match.eventId !== snapshot._id) return ok(refused('比赛不存在'));
  if (match.status !== 'pending') return ok(refused('比赛已确认比分，不能再改派裁判'));
  const refereeId = typeof payload.refereeId === 'string' ? payload.refereeId.trim() : '';
  let memberId = '';
  if (refereeId) {
    const members = await ctx.repo.schoolMembers.list();
    const found = members.find(row => row.userId === refereeId && row.status === SCHOOL_MEMBER_STATUS.ACTIVE &&
      snapshot.participantSchoolIds.includes(row.schoolId));
    if (!found) return ok(refused('裁判必须是参赛学校的有效会员'));
    memberId = found._id;
  }
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以指定裁判');
    if (event.status === 'canceled') return refused('赛事已取消');
    const current = await tx.exchangeMatches.getById(payload.matchId);
    if (!current || current.eventId !== event._id) return refused('比赛不存在');
    if (current.status !== 'pending') return refused('比赛已确认比分，不能再改派裁判');
    if (event.revision !== snapshot.revision || current.revision !== match.revision) return refused('赛事已变化，请刷新后重试');
    if (memberId) {
      const member = await tx.schoolMembers.getById(memberId);
      if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE || member.userId !== refereeId ||
          !event.participantSchoolIds.includes(member.schoolId)) return refused('裁判身份已失效，请重新选择');
    }
    const next = { ...current, referee: refereeId, refereeAt: fresh.now, refereeBy: fresh.actorId, revision: current.revision + 1 };
    await tx.exchangeMatches.set(next._id, next);
    const nextEvent = { ...event, revision: event.revision + 1 };
    await tx.exchangeEvents.set(nextEvent._id, nextEvent);
    await audit(tx, fresh, nextEvent, 'assignExchangeReferee');
    return { ok: true, event: summary(nextEvent), message: '' };
  }));
}

async function submitExchangeScore(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  const match = await ctx.repo.exchangeMatches.getById(payload.matchId);
  if (!snapshot || !match || match.eventId !== snapshot._id) return ok(refused('比赛不存在'));
  if (!snapshot.draw) return ok(refused('请先抽签'));
  // 终态不可变（2026-10-16 审计）：名次一旦确认（status='finished'），
  // event.results 就是对外唯一口径，比分台账不能事后被改写——否则「公布的冠军」
  // 与「台账里的冠军」会静默分叉。要更正得走赛事修订，不是改比分。
  if (snapshot.status === 'finished') return ok(refused('赛事已结束，不能再改比分'));
  if (snapshot.status === 'canceled') return ok(refused('赛事已取消'));
  if (!canScoreMatch(snapshot, match, ctx)) return ok(refused('没有比分确认权限'));
  if (match.status !== 'pending') return ok(refused('这场比赛已确认比分'));
  if (!match.playerA || !match.playerB) return ok(refused('对阵尚未确定'));
  const scoreA = payload.scoreA;
  const scoreB = payload.scoreB;
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 ||
      scoreA > 99 || scoreB > 99) return ok(refused('请填写有效的比分'));
  if (scoreA === scoreB) return ok(refused('淘汰赛不能打平'));
  const { map } = await entrantsOf(ctx.repo, snapshot._id);
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  const preview = { ...match, scoreA, scoreB, winner: scoreA > scoreB ? match.playerA : match.playerB, status: 'active' };
  const ledger = existing.map(row => row._id === match._id ? preview : row);
  const built = planExchangeMatches({ event: snapshot, draw: snapshot.draw, entrantsById: map, matches: ledger });
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    const current = await tx.exchangeMatches.getById(payload.matchId);
    if (!current || !event || current.eventId !== event._id) return refused('比赛不存在');
    if (!canScoreMatch(event, current, fresh)) return refused('没有比分确认权限');
    if (event.status === 'finished') return refused('赛事已结束，不能再改比分');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (current.status !== 'pending') return refused('这场比赛已确认比分');
    if (event.revision !== snapshot.revision || current.revision !== match.revision) return refused('赛事已变化，请刷新后重试');
    const scored = { ...current, scoreA, scoreB, winner: scoreA > scoreB ? current.playerA : current.playerB,
      status: 'active', recordedBy: fresh.actorId, recordedAt: fresh.now, revision: current.revision + 1 };
    await tx.exchangeMatches.set(scored._id, scored);
    // 把「此刻应当存在」的比赛补齐 / 刷新：新确定的对阵补进来；撤销后重录导致的
    // 换人（待确认 / 已撤销的下一轮）按新对阵刷新。已生效的比分不动。
    for (const row of built.matches) {
      const clash = await tx.exchangeMatches.getById(row._id);
      if (!clash) {
        await tx.exchangeMatches.set(row._id, { ...row, schoolId: event.schoolId, association: event.association });
        continue;
      }
      if (clash.status === 'active') continue;
      if (clash.playerA === row.playerA && clash.playerB === row.playerB && clash.status === row.status) continue;
      await tx.exchangeMatches.set(row._id, { ...clash, playerA: row.playerA, playerB: row.playerB,
        schoolA: row.schoolA, schoolB: row.schoolB, scoreA: null, scoreB: null, winner: '',
        status: 'pending', revision: Number(clash.revision || 1) + 1 });
    }
    const nextEvent = { ...event, revision: event.revision + 1 };
    await tx.exchangeEvents.set(nextEvent._id, nextEvent);
    await audit(tx, fresh, nextEvent, 'submitExchangeScore');
    return { ok: true, event: summary(nextEvent), message: '' };
  }));
}

async function confirmExchangeRanking(payload = {}, ctx) {
  const snapshot = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!managesExchange(snapshot, ctx)) return ok(refused('只有管理员或双方校管理员可以确认名次'));
  if (!snapshot.draw) return ok(refused('请先抽签'));
  if (snapshot.status === 'finished') return ok(refused('名次已确认'));
  const { rows } = await entrantsOf(ctx.repo, snapshot._id);
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  const placed = placementsFromExchange({ event: snapshot, draw: snapshot.draw, matches: existing });
  if (!placed.ok) return ok(refused(placed.message));
  const byUser = new Map(rows.map(row => [row.userId, row]));
  const results = placed.results.map(row => {
    const entrant = byUser.get(row.userId) || {};
    return { userId: row.userId, placement: row.placement, nickName: entrant.nickName || '',
      representedSchoolId: entrant.representedSchoolId || '', schoolName: entrant.schoolName || snapshot.schoolNames[entrant.representedSchoolId] || '' };
  });
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    if (!managesExchange(event, fresh)) return refused('只有管理员或双方校管理员可以确认名次');
    if (event.status === 'canceled') return refused('赛事已取消');
    if (event.status !== 'drawn') return refused('当前状态不能确认名次');
    if (event.revision !== snapshot.revision) return refused('赛事已变化，请刷新后重试');
    const next = { ...event, status: 'finished', results,
      finishedAt: fresh.now, finishedBy: fresh.actorId, revision: event.revision + 1 };
    await tx.exchangeEvents.set(next._id, next);
    await audit(tx, fresh, next, 'confirmExchangeRanking');
    return { ok: true, event: summary(next), message: '' };
  }));
}

async function getExchangeEvents(_payload, ctx) {
  if (!manages(ctx) && !participates(ctx)) return ok({ ...refused('请使用本校有效身份查看邀请赛'), events: [] });
  const invitations = await ctx.repo.exchangeInvitations.listByScope(ctx);
  const events = [];
  for (const invitation of invitations) {
    const event = await ctx.repo.exchangeEvents.getById(invitation.eventId);
    if (canSee(event, ctx)) events.push(summary(event));
  }
  return ok({ ok: true, events: events.sort((a, b) => a.startTime.localeCompare(b.startTime)), message: '' });
}

async function getExchangeEvent(payload = {}, ctx) {
  const event = await ctx.repo.exchangeEvents.getById(payload.eventId);
  if (!canSee(event, ctx)) return ok(refused('赛事不存在或没有访问权限'));
  const rows = (await ctx.repo.exchangeSignups.listByEvent(event._id)).filter(row => row.status === 'signed');
  const byUser = new Map(rows.map(row => [row.userId, row]));
  const canManage = managesExchange(event, ctx);
  const existingMatches = await ctx.repo.exchangeMatches.listByEvent(event._id);
  // 全量投影：把「此刻应当存在的比赛」摆出来（含还未确定的对阵槽位之外的已定对阵）。
  // 展示用；名次确认用的是台账里已经确认的那份（见下 placement）。
  const matches = event.draw
    ? planExchangeMatches({ event, draw: event.draw, entrantsById: byUser, matches: existingMatches }).matches
    : [];
  // 名次能不能确认，由赛制自己的收官判据说了算（单败看决赛、循环看积分表、双败看总决赛）
  const placement = event.draw
    ? placementsFromExchange({ event, draw: event.draw, matches: existingMatches })
    : { ok: false, message: '' };
  const names = new Map((await ctx.repo.users.list()).map(user => [user._id, user.nickName || '']));
  const referees = (await ctx.repo.schoolMembers.list())
    .filter(row => row.status === SCHOOL_MEMBER_STATUS.ACTIVE && event.participantSchoolIds.includes(row.schoolId))
    .map(row => ({ userId: row.userId, nickName: names.get(row.userId) || '', schoolId: row.schoolId,
      schoolName: event.schoolNames[row.schoolId] || '' }));
  const canceled = event.status === 'canceled';
  const isOrganizer = isPlatformAdmin(ctx) || (event.schoolId === ctx.schoolId && manages(ctx));
  // 签到：名单锁定后到结束前，管理员替参赛者签（与普通赛事的代签同一口径）
  const canCheckIn = !canceled && (event.status === 'ready' || event.status === 'drawn') && managesExchange(event, ctx);
  return ok({ ok: true, event: summary(event), participants: rows.map(row => ({
    userId: row.userId, nickName: row.nickName, representedSchoolId: row.representedSchoolId, schoolName: row.schoolName,
    checkInTime: row.checkInTime || null, checkedIn: Boolean(row.checkInTime),
    canCheckIn: canCheckIn && (isPlatformAdmin(ctx) || row.representedSchoolId === ctx.schoolId),
    canRemove: !canceled && event.status === 'signup' && managesExchange(event, ctx) &&
      (isPlatformAdmin(ctx) || row.representedSchoolId === ctx.schoolId),
  })), referees, canManage, canRespond: event.schoolId !== ctx.schoolId && event.invitations[ctx.schoolId] === 'pending' && manages(ctx),
    canSignup: !canceled && participates(ctx) && event.invitations[ctx.schoolId] === 'accepted' && event.status === 'signup' && new Date(event.startTime) > new Date(ctx.now),
    signed: rows.some(row => row.userId === ctx.actorId),
    canceled, canCheckIn,
    canCancel: !canceled && event.status !== 'finished' && isOrganizer,
    canWithdrawInvitation: !canceled && event.status === 'signup' && Boolean(canManage),
    canDraw: !canceled && canManage && (event.status === 'ready' || event.status === 'drawn') &&
      !matches.some(match => match.status === 'active'),
    canConfirmRanking: !canceled && canManage && event.status === 'drawn' && Boolean(placement.ok),
    rankingHint: canceled || placement.ok ? '' : (placement.message || ''),
    matches: matches
      // 展示次序：先按阶段（小组赛 → 主赛 / 胜者组 → 败者组 → 季军赛 / 总决赛 / 排位），
      // 同阶段再按轮次与签位。双败的交错推进因此也读得顺。
      .slice()
      .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.round - b.round || a.slot - b.slot)
      .map(match => ({
      _id: match._id, round: match.round, slot: match.slot, status: match.status,
      stage: match.stage || BRACKET_STAGE.MAIN, stageText: STAGE_TEXT[match.stage || BRACKET_STAGE.MAIN] || '',
      group: match.group === undefined ? null : match.group,
      groupText: match.group === undefined || match.group === null ? '' : `第 ${match.group + 1} 组 · `,
      nameA: (byUser.get(match.playerA) || {}).nickName || '', nameB: (byUser.get(match.playerB) || {}).nickName || '',
      schoolNameA: event.schoolNames[match.schoolA] || '', schoolNameB: event.schoolNames[match.schoolB] || '',
      scoreA: match.scoreA, scoreB: match.scoreB, winner: match.winner,
      referee: match.referee || '', refereeName: names.get(match.referee) || '',
      canAssignReferee: !canceled && canManage && match.status === 'pending',
      canScore: !canceled && match.status === 'pending' && canScoreMatch(event, match, ctx),
      canRevoke: !canceled && match.status === 'active' && canScoreMatch(event, match, ctx),
    })), message: '' });
}

module.exports = { createExchangeEvent, respondExchangeInvitation, signUpExchangeEvent,
  cancelExchangeSignup, removeExchangeSignup, checkInExchangeSignup, withdrawExchangeInvitation,
  cancelExchangeEvent, revokeExchangeScore,
  lockExchangeRoster, drawExchangeEvent, assignExchangeReferee,
  submitExchangeScore, confirmExchangeRanking, getExchangeEvents, getExchangeEvent };
