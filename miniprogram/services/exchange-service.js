/** S4 跨校单打邀请赛。独立集合，服务端强制不计校内分。 */
const { buildSchoolContext } = require('./school-context.js');
const { canSchoolAction } = require('./school-permission.js');
const { schoolKey, schoolAssociationKey, PLATFORM_ROLE, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { planExchangeDraw, planExchangeMatches, placementsFromExchange } = require('./exchange-plan.js');
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
  draw: event.draw || null, results: event.results || [],
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
  const fingerprint = JSON.stringify([title, location, start.toISOString(), schoolIds, quota, schoolQuotas]);
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
    for (const row of roster) {
      const member = await tx.schoolMembers.getById(row.schoolMemberId);
      const user = await tx.users.getById(row.userId);
      const school = await tx.schools.getById(row.representedSchoolId);
      if (!member || member.userId !== row.userId || member.schoolId !== row.representedSchoolId || member.status !== 'active' ||
          !user || user.platformStatus !== 'active' || user.primarySchoolId !== row.representedSchoolId ||
          !school || school.status !== 'active') return refused('有参赛者或学校身份已失效，请先处理参赛资格');
    }
    const next = { ...event, status: 'ready', lockedAt: fresh.now, lockedBy: fresh.actorId, revision: event.revision + 1 };
    await tx.exchangeEvents.set(event._id, next);
    await audit(tx, fresh, next, 'lockExchangeRoster');
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
  if (snapshot.status === 'signup') return ok(refused('请先锁定报名名单'));
  if (snapshot.status === 'finished') return ok(refused('赛事已结束，不能再抽签'));
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  if (existing.some(match => match.status === 'active')) return ok(refused('已有比赛确认生效，不能再抽签'));
  const { rows, map } = await entrantsOf(ctx.repo, snapshot._id);
  if (rows.length < 2) return ok(refused('至少需要两名参赛者才能抽签'));
  const seedValue = Number.isInteger(payload.seedValue) ? payload.seedValue : ctx.now.getTime();
  const planned = planExchangeDraw({ entries: rows, seedValue });
  if (!planned.ok) return ok(refused(planned.message));
  // 重抽时按当前签表整体重算，旧对阵的残留记录不会被投影出来。
  const built = planExchangeMatches({ eventId: snapshot._id, draw: planned.draw, entrantsById: map, matches: [] });
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
  const built = planExchangeMatches({ eventId: snapshot._id, draw: snapshot.draw, entrantsById: map, matches: ledger });
  const known = new Set(existing.map(row => row._id));
  const additions = built.matches.filter(row => !known.has(row._id));
  return ok(await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    const event = await tx.exchangeEvents.getById(payload.eventId);
    const current = await tx.exchangeMatches.getById(payload.matchId);
    if (!current || !event || current.eventId !== event._id) return refused('比赛不存在');
    if (!canScoreMatch(event, current, fresh)) return refused('没有比分确认权限');
    if (current.status !== 'pending') return refused('这场比赛已确认比分');
    if (event.revision !== snapshot.revision || current.revision !== match.revision) return refused('赛事已变化，请刷新后重试');
    const scored = { ...current, scoreA, scoreB, winner: scoreA > scoreB ? current.playerA : current.playerB,
      status: 'active', recordedBy: fresh.actorId, recordedAt: fresh.now, revision: current.revision + 1 };
    await tx.exchangeMatches.set(scored._id, scored);
    // 比分确认后，下一轮对阵可能首次确定，补齐新生成的比赛。
    for (const row of additions) {
      const clash = await tx.exchangeMatches.getById(row._id);
      if (clash) continue;
      await tx.exchangeMatches.set(row._id, { ...row, schoolId: event.schoolId, association: event.association });
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
  const { rows, map } = await entrantsOf(ctx.repo, snapshot._id);
  const existing = await ctx.repo.exchangeMatches.listByEvent(snapshot._id);
  const built = planExchangeMatches({ eventId: snapshot._id, draw: snapshot.draw, entrantsById: map, matches: existing });
  const placed = placementsFromExchange({ draw: snapshot.draw, matches: built.matches });
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
  const matches = event.draw
    ? planExchangeMatches({ eventId: event._id, draw: event.draw, entrantsById: byUser,
      matches: await ctx.repo.exchangeMatches.listByEvent(event._id) }).matches
    : [];
  const names = new Map((await ctx.repo.users.list()).map(user => [user._id, user.nickName || '']));
  const referees = (await ctx.repo.schoolMembers.list())
    .filter(row => row.status === SCHOOL_MEMBER_STATUS.ACTIVE && event.participantSchoolIds.includes(row.schoolId))
    .map(row => ({ userId: row.userId, nickName: names.get(row.userId) || '', schoolId: row.schoolId,
      schoolName: event.schoolNames[row.schoolId] || '' }));
  return ok({ ok: true, event: summary(event), participants: rows.map(row => ({
    userId: row.userId, nickName: row.nickName, representedSchoolId: row.representedSchoolId, schoolName: row.schoolName,
  })), referees, canManage, canRespond: event.schoolId !== ctx.schoolId && event.invitations[ctx.schoolId] === 'pending' && manages(ctx),
    canSignup: participates(ctx) && event.invitations[ctx.schoolId] === 'accepted' && event.status === 'signup' && new Date(event.startTime) > new Date(ctx.now),
    signed: rows.some(row => row.userId === ctx.actorId),
    canDraw: canManage && (event.status === 'ready' || event.status === 'drawn') &&
      !matches.some(match => match.status === 'active'),
    canConfirmRanking: canManage && event.status === 'drawn' && matches.length > 0 &&
      matches.every(match => match.status === 'active'),
    matches: matches.map(match => ({
      _id: match._id, round: match.round, slot: match.slot, status: match.status,
      nameA: (byUser.get(match.playerA) || {}).nickName || '', nameB: (byUser.get(match.playerB) || {}).nickName || '',
      schoolNameA: event.schoolNames[match.schoolA] || '', schoolNameB: event.schoolNames[match.schoolB] || '',
      scoreA: match.scoreA, scoreB: match.scoreB, winner: match.winner,
      referee: match.referee || '', refereeName: names.get(match.referee) || '',
      canAssignReferee: canManage && match.status === 'pending',
      canScore: match.status === 'pending' && canScoreMatch(event, match, ctx),
    })), message: '' });
}

module.exports = { createExchangeEvent, respondExchangeInvitation, signUpExchangeEvent,
  cancelExchangeSignup, lockExchangeRoster, drawExchangeEvent, assignExchangeReferee,
  submitExchangeScore, confirmExchangeRanking, getExchangeEvents, getExchangeEvent };
