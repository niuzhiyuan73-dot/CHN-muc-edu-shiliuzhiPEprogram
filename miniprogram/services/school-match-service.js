/**
 * 学校维度：比赛记录 —— 录入 / 确认 / 驳回 / 撤销 / 弃权 / 指派裁判（协议 2，M1）
 * ============================================================
 * 与旧栈 `match-record.js` 同一把尺子（权限判定与字段组装全部复用该纯模块），
 * 区别只在**归属**与**角色来源**：
 *   · 每条比赛记录同时绑定 `schoolId + association`，读写先过 `belongsToSchoolScope`；
 *   · 旧栈的 ROLE 数值由 S2 的校级 / 协会 / 学院角色推导（见 legacyRoleOf），
 *     学院代录的边界按「本学院有人上场」判定，与旧栈 involvesCollege 一致。
 *
 * 【签表晋级什么时候补排】
 * confirm / forfeit 在旧栈会触发 `advanceEvent` 排下一轮。本轮补排依赖抽签签表，
 * 由 `school-event-service.advanceSchoolEvent` 提供，确认 / 弃权生效后调用它
 * （「只补不覆盖」，见 format-plan.js）。日常约球没有 eventId，自然跳过。
 *
 * 【既有赛程比赛的补录】
 * 抽签排定的比赛（个人赛签表场次、学院赛小场）在库里已有主：补录只补比分与
 * 录入人，对阵 / 赛制 / 时间一律取自那条记录本身，绝不另立新记录（否则签表里
 * 写的是一组对阵、比赛页里却是另一组）。见 `submitScheduledMatch`，与旧栈
 * `submitMatch` 的 id 分支同一把尺子（`fillScheduledMatch`）。
 *
 * 【确认口径为什么分 mock / 云端】
 * 沿用旧栈：生产是「对手确认」，本地演示只有一个账号，mock 下放宽为「参与即可」。
 * 由 mock 端在 ctx 上打 `isMock: true`，云端不设该字段（默认严格）。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const {
  canReadAssociationSpace, canManageAssociationSpace, canParticipateInAssociation,
} = require('./association-space-permission.js');
// 角色 / 名单的推导收在 school-actor，两套栈只有一份口径。
const { legacyRoleOf, buildDirectory, recordOptions } = require('./school-actor.js');
const {
  schoolKey, schoolMemberKey, belongsToSchoolScope, schoolMatchKey, schoolLiveKey,
  PLATFORM_STATUS, SCHOOL_MEMBER_STATUS,
} = require('../utils/school.js');
const {
  MATCH_TYPE, MATCH_TYPE_LABEL,
  MATCH_STATUS, MATCH_STATUS_LABEL, MATCH_COMPETITION, MATCH_OUTCOME,
} = require('../utils/constants.js');
const {
  canRecordScore, canConfirm, canRevoke, canAssignReferee, canForfeit, needsScore,
  isParticipant, buildMatchRecord, fillScheduledMatch, buildRefereePatch, buildForfeitPatch,
} = require('./match-record.js');
const { checkSubmitAllowed, seasonPairCounts } = require('./rating-cap.js');
const { loadSeason } = require('./school-rank-service.js');
const { RATED_PAIR_LIMIT } = require('../utils/constants.js');
const { liveScoreOf } = require('./live-score.js');
const { advanceSchoolEvent } = require('./school-event-service.js');
// 学院赛小场生效 / 撤销后的收尾：把结果写回大场、必要时排出下一轮（M2-c2）。
const {
  advanceCollegeAfterLeg, collegeLegRevokeBlocker, revertCollegeAfterRevoke,
} = require('./school-college-advance.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MATCH_LIST_LIMIT = 100;

const iso = value => new Date(value).toISOString();
const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});
const matchAuditKey = (matchId, action, revision) =>
  schoolKey('mau', matchId, action, String(revision));

const isMatchDoc = doc => Boolean(doc && Array.isArray(doc.teamA) && Array.isArray(doc.teamB) &&
  typeof doc.status === 'number' && doc.matchTime);

/** 比赛记录 DTO：数据 + 权限旗标，展示交给页面。 */
function matchSummary(doc, ctx, dir) {
  const options = recordOptions(ctx, dir);
  const self = ctx.actorId;
  const pending = doc.status === MATCH_STATUS.PENDING;
  return {
    matchId: doc._id,
    matchType: doc.matchType,
    matchTypeLabel: MATCH_TYPE_LABEL[doc.matchType] || '',
    pool: doc.pool,
    isDoubles: doc.matchType === MATCH_TYPE.DOUBLES,
    teamA: [...(doc.teamA || [])],
    teamB: [...(doc.teamB || [])],
    scoreA: [...(doc.scoreA || [])],
    scoreB: [...(doc.scoreB || [])],
    winner: doc.winner || '',
    gamePoints: doc.gamePoints,
    bestOf: doc.bestOf,
    matchTime: doc.matchTime || null,
    location: doc.location || '',
    eventId: doc.eventId || null,
    competition: doc.competition || MATCH_COMPETITION.PERSONAL,
    // 学院赛小场专属：小项、所属大场与轮次、所属学院赛、对阵双方学院。个人赛这几项
    // 为空，展示端据 competition 分流（学院赛录分页用它们回查大场与赛事）。
    discipline: doc.discipline || '',
    tieId: doc.tieId || '',
    legNo: doc.legNo === undefined ? null : Number(doc.legNo),
    collegeEventId: doc.collegeEventId || '',
    collegeA: doc.collegeA || '',
    collegeB: doc.collegeB || '',
    // 比赛编排字段：签表、分组与场地展示共享同一契约，页面不必从别处反查。
    // 非签表生成（自由录入）的比赛这几项为空，展示端退化为「无轮次 / 无场号」。
    round: doc.round === undefined ? null : Number(doc.round),
    stage: doc.stage || '',
    group: doc.group === undefined ? null : Number(doc.group),
    slot: doc.slot === undefined ? null : Number(doc.slot),
    courtNo: doc.courtNo === undefined ? null : Number(doc.courtNo),
    status: doc.status,
    statusLabel: MATCH_STATUS_LABEL[doc.status] || '',
    action: doc.action || '',
    reason: doc.reason || '',
    outcome: doc.outcome || MATCH_OUTCOME.NORMAL,
    recorder: doc.recorder || '',
    referee: doc.referee || '',
    hasReferee: Boolean(String(doc.referee || '').trim()),
    isMine: Boolean(self && isParticipant(doc, self)),
    needsScore: needsScore(doc),
    canRecord: pending && needsScore(doc) && canRecordScore(doc, self, options),
    canSubmitScore: pending && canRecordScore(doc, self, options),
    confirmRelaxed: ctx.isMock === true && canConfirm(doc, self, { isMock: true, role: options.role }) &&
      !canConfirm(doc, self, { isMock: false, role: options.role }),
    canConfirm: canConfirm(doc, self, { isMock: ctx.isMock === true, role: options.role }),
    canRevoke: canRevoke(doc, self, { role: options.role }),
    canForfeit: canForfeit(doc, self, self, { role: options.role }),
    canAssignReferee: canManageAssociationSpace(ctx) && canAssignReferee(doc),
    revision: Number(doc.revision || 1),
  };
}

/* ------------------------------------------------------------------ 读 */

/**
 * 给比赛 DTO 补上实时比分（只有开过计分台的才有）。
 *
 * 【为什么读端要带 live】
 * 查看端首屏就得是实时值，不能「先 0:0 再跳」；页面据 `live` 判断哪几场要挂
 * 轮询取增量（见 live-watch）。轮询本身只回比分字段，这条是首帧的来源。
 * 实时态按 `matchId` 索引、随归属隔离——别校 / 别协会的读不到。
 */
async function withLive(summary, ctx) {
  const state = await ctx.repo.liveScores.getById(schoolLiveKey(summary.matchId, ctx));
  if (!state || !belongsToSchoolScope(state, ctx)) return summary;
  return { ...summary, live: liveScoreOf(state) };
}

async function listSchoolMatches(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, matches: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildDirectory(ctx);
  let rows = (await ctx.repo.forScope(ctx).matches.list()).filter(isMatchDoc);
  if (typeof payload.pool === 'number') rows = rows.filter(row => row.pool === payload.pool);
  if (typeof payload.eventId === 'string' && payload.eventId) {
    rows = rows.filter(row => row.eventId === payload.eventId);
  }
  if (typeof payload.userId === 'string' && payload.userId) {
    rows = rows.filter(row => isParticipant(row, payload.userId));
  }
  const pendingCount = rows.filter(row => row.status === MATCH_STATUS.PENDING).length;
  if (typeof payload.status === 'number') rows = rows.filter(row => row.status === payload.status);
  rows.sort((a, b) => (Date.parse(b.matchTime) || 0) - (Date.parse(a.matchTime) || 0));
  const limit = Number.isInteger(payload.limit) && payload.limit >= 0
    ? payload.limit : MATCH_LIST_LIMIT;
  const matches = [];
  for (const doc of rows.slice(0, limit)) {
    matches.push(await withLive(matchSummary(doc, ctx, dir), ctx));
  }
  return ok({ ok: true, canManage: canManageAssociationSpace(ctx), matches,
    total: rows.length, hasMore: rows.length > matches.length, pendingCount, message: '' });
}

/** 录入页所需的本人、有效成员及本赛季交手次数；不暴露数字角色。 */
async function getSchoolMatchEntryContext(_payload, ctx) {
  const viewer = ctx.actor && ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE
    ? { userId: ctx.actorId, nickName: ctx.actor.nickName || '' } : null;
  if (!canReadAssociationSpace(ctx)) return ok({ ok: true, viewer, canRecord: false,
    members: [], pairInfo: null, seasonStart: null, message: viewer ? '当前账号没有本协会有效身份，暂时不能录入成绩' : '请先登录后再录入比赛成绩' });
  const [dir, season, ledger] = await Promise.all([buildDirectory(ctx), loadSeason(ctx), ctx.repo.forScope(ctx).matches.list()]);
  return ok({ ok: true, viewer, canRecord: canParticipateInAssociation(ctx),
    members: dir.members.filter(user => user.platformStatus === PLATFORM_STATUS.ACTIVE).map(user => ({
      userId: user._id, nickName: user.nickName || '', realName: user.realName || '',
    })), seasonStart: season.resetTime || season.anchorTime || null,
    pairInfo: { counts: seasonPairCounts(ctx.actorId, ledger, { seasonStart: season.resetTime }), limit: RATED_PAIR_LIMIT }, message: '' });
}

async function getSchoolMatch(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));
  const doc = await ctx.repo.matches.getById(payload.matchId);
  if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('找不到这场比赛'));
  const dir = await buildDirectory(ctx);
  return ok({ ok: true, match: await withLive(matchSummary(doc, ctx, dir), ctx), message: '' });
}

/* ------------------------------------------------------------------ 写 */

async function submitSchoolMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));

  const dir = await buildDirectory(ctx);

  // 既有赛程比赛（个人赛签表 / 学院赛小场）的补录：只补比分，对阵 / 赛制 / 时间
  // 一律取自那条记录本身，走独立通路、不另立新记录（见 submitScheduledMatch）。
  if (payload.matchId) return ok(await submitScheduledMatch(payload, ctx, dir));

  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('录入请求编号无效'));

  const roster = dir.memberIds;
  const built = buildMatchRecord(
    { ...payload, recorder: ctx.actorId },
    { members: roster, now: ctx.now }
  );
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors, scoreErrors: built.scoreErrors }));
  if (!canRecordScore(built.record, ctx.actorId, recordOptions(ctx, dir))) {
    return ok(refused('只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩'));
  }

  // 防刷分闸门要读本范围完整台账；事务内不允许整表查询，故在事务外先取好。
  const ledger = await ctx.repo.forScope(ctx).matches.list();
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('没有读取协会空间的权限');
    const matchId = schoolMatchKey(schoolKey('m', fresh.actorId, token), fresh);
    const existing = await tx.matches.getById(matchId);
    if (isMatchDoc(existing)) {
      return existing.fingerprint === fingerprintOf(built.record)
        ? { ok: true, match: matchSummary(existing, fresh, dir), message: '' }
        : refused('请求编号已使用，请重新录入');
    }
    // 一对会员本赛季打满上限后不再让录（判据取本范围完整台账）。
    const gate = checkSubmitAllowed(built.record, ledger, {
      seasonStart: (await loadSeason(fresh)).resetTime, nameOf: null,
    });
    if (!gate.ok) return refused(gate.message);

    const doc = matchDocFromRecord(built.record, matchId, fresh, fingerprintOf(built.record));
    await tx.matches.set(matchId, doc);
    await tx.audit.append({ _id: matchAuditKey(matchId, 'submitMatch', 1),
      action: 'submitMatch', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, matchId, at: iso(fresh.now) });
    return { ok: true, match: matchSummary(doc, fresh, dir), message: '' };
  });
  return ok(result);
}

/**
 * 既有赛程比赛的补录（带 matchId）：个人赛签表场次与学院赛小场都走这条。
 * ============================================================
 * 抽签已把「谁打谁、第几轮、哪个签位」定死，补录只该补比分与录入人——对阵 /
 * 赛制 / 时间全部取自那条待确认记录（`fillScheduledMatch` 只收比分、不改阵容），
 * 与旧栈 `submitMatch` 的 id 分支、云端 `submitScheduledMatch` 是同一把尺子。
 * 录分权限同样复用 `canRecordScore`：场上的人、本学院有人上场的负责人、管理员。
 *
 * 【为什么不另立记录】赛程比赛在签表 / 大场里占着位置，另立一条会让签表与比赛页
 * 各认一份，签表就自相矛盾了（见 fillScheduledMatch 头注）。
 * 【为什么不用 requestId 键】这条记录的编号本身就是稳定键；待确认时重复补录是
 * 允许的（改错比分），确认生效后由 `fillScheduledMatch` 挡下（非「待确认」）。
 * 【比赛时间为什么回填 doc.matchTime】签表钉死的时间不因补录而变，原样保留 ISO
 * 字符串，避免把 Date 对象写进库（各处按字符串解析）。
 *
 * @param {Object} payload { matchId, scoreA, scoreB }
 * @param {Object} ctx
 * @param {Object} dir buildDirectory 的结果（权限判定与阵容校验共用）
 * @returns {Promise<Object>} {ok, match, message}
 */
async function submitScheduledMatch(payload, ctx, dir) {
  return ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    if (!canReadAssociationSpace(fresh)) return refused('没有读取协会空间的权限');
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, fresh)) return refused('找不到这场比赛');
    if (!canRecordScore(doc, fresh.actorId, recordOptions(fresh, dir))) {
      return refused('只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩');
    }

    const filled = fillScheduledMatch(doc, { scoreA: payload.scoreA, scoreB: payload.scoreB }, {
      // 阵容校验取在册名单；时间下界不设（与日常约球同口径，S2 赛季锚点归 M4）。
      members: dir.memberIds, now: fresh.now, recorder: fresh.actorId,
    });
    if (!filled.ok) {
      return refused(filled.firstError, { errors: filled.errors, scoreErrors: filled.scoreErrors });
    }

    const nowIso = iso(fresh.now);
    const next = {
      ...doc, ...filled.patch,
      // 赛程时间由签表钉死，补录不改；范围与版本显式盖回。
      matchTime: doc.matchTime,
      schoolId: fresh.schoolId, association: fresh.association,
      status: MATCH_STATUS.PENDING, action: 'submit', actor: fresh.actorId, actedAt: nowIso,
      revision: Number(doc.revision || 1) + 1,
    };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, 'submitScheduledMatch', next.revision),
      action: 'submitScheduledMatch', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, matchId: doc._id, at: nowIso });
    return { ok: true, match: matchSummary(next, fresh, dir), message: '' };
  });
}

async function confirmSchoolMatch(payload = {}, ctx) {
  const result = await transition(payload, ctx, {
    action: 'confirm',
    auditAction: 'confirmMatch',
    message: '你无权确认这场比赛',
    allow: (doc, opts) => canConfirm(doc, ctx.actorId, opts),
    requireWinner: true,
    patch: () => ({ status: MATCH_STATUS.ACTIVE }),
  });
  const resolved = await advanceAfterResolved(ctx, result.data);
  return ok(await advanceCollegeAfterResolved(ctx, resolved));
}

/** 一场签表比赛确认 / 弃权生效后补排下一轮；日常约球（无 eventId）跳过。 */
async function advanceAfterResolved(ctx, result) {
  if (result && result.ok && result.match && result.match.eventId) {
    await advanceSchoolEvent(ctx, result.match.eventId);
  }
  return result;
}

/**
 * 学院赛小场生效后的收尾：把结果写回大场、定出大场胜负，并在本轮打完时排出下一轮。
 * 走的是与个人赛不同的一条链路（小场 `eventId` 留空，`advanceAfterResolved` 会跳过）。
 * 按编号重读一次原始文档再交给 `advanceCollegeAfterLeg`——推进读的是台账最终态。
 */
async function advanceCollegeAfterResolved(ctx, result) {
  if (!result || !result.ok || !result.match) return result;
  if (result.match.competition !== MATCH_COMPETITION.COLLEGE) return result;
  const doc = await ctx.repo.matches.getById(result.match.matchId);
  if (doc) await advanceCollegeAfterLeg(ctx, doc);
  return result;
}

/** 撤销学院赛小场后的收尾：把结果从大场里收回来。 */
async function revertCollegeAfterRevoked(ctx, result) {
  if (!result || !result.ok || !result.match) return result;
  if (result.match.competition !== MATCH_COMPETITION.COLLEGE) return result;
  const doc = await ctx.repo.matches.getById(result.match.matchId);
  if (doc) await revertCollegeAfterRevoke(ctx, doc);
  return result;
}

async function rejectSchoolMatch(payload = {}, ctx) {
  const reason = String(payload.reason || '').trim();
  if (!reason) return ok(refused('请填写驳回理由'));
  return transition(payload, ctx, {
    action: 'reject',
    auditAction: 'rejectMatch',
    message: '你无权驳回这场比赛',
    allow: (doc, opts) => canConfirm(doc, ctx.actorId, opts),
    requirePending: true,
    patch: () => ({ status: MATCH_STATUS.REVOKED, reason }),
  });
}

async function revokeSchoolMatch(payload = {}, ctx) {
  const reason = String(payload.reason || '').trim();
  if (!reason) return ok(refused('请填写撤销理由'));
  // 学院赛小场的下游在大场那一侧（下一轮按胜者落成真实记录），matches 表里的依赖检查
  // 够不着，先单独拦一道（与云端 revokeMatch 的 collegeLegRevokeBlocker 同源）。
  const blocked = await collegeRevokeBlockerFor(ctx, payload.matchId);
  if (blocked) return ok(refused(blocked));
  const result = await transition(payload, ctx, {
    action: 'revoke',
    auditAction: 'revokeMatch',
    message: '你无权撤销这场比赛',
    allow: (doc, opts) => canRevoke(doc, ctx.actorId, opts),
    notRevoked: true,
    patch: () => ({ status: MATCH_STATUS.REVOKED, reason }),
  });
  return ok(await revertCollegeAfterRevoked(ctx, result.data));
}

/** 待撤销的若是学院赛小场，先问一句「撤得动吗」；其余比赛不拦。 */
async function collegeRevokeBlockerFor(ctx, matchId) {
  if (typeof matchId !== 'string' || !matchId) return '';
  const doc = await ctx.repo.matches.getById(matchId);
  if (!doc || doc.competition !== MATCH_COMPETITION.COLLEGE) return '';
  return collegeLegRevokeBlocker(ctx, doc);
}

/** confirm / reject / revoke 共用的状态机：取记录 → 判权 → 写状态 + 审计。 */
async function transition(payload, ctx, spec) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));

  const dir = await buildDirectory(ctx);
  const roleOptions = { isMock: ctx.isMock === true, role: legacyRoleOf(ctx) };
  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('找不到这场比赛');
    if (spec.requirePending && doc.status !== MATCH_STATUS.PENDING) {
      return refused('只有待确认的比赛可以驳回');
    }
    if (spec.notRevoked && doc.status === MATCH_STATUS.REVOKED) return refused('这场比赛已经作废了');
    if (spec.requireWinner && !doc.winner) {
      return refused('这场比赛还没有比分，请先录入成绩');
    }
    if (!spec.allow(doc, roleOptions)) return refused(spec.message);

    const nowIso = iso(ctx.now);
    const patch = { ...spec.patch(), action: spec.action, actor: ctx.actorId, actedAt: nowIso };
    const next = { ...doc, ...patch, revision: doc.revision + 1 };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, spec.auditAction, next.revision),
      action: spec.auditAction, schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, matchId: doc._id, at: nowIso });
    return { ok: true, match: matchSummary(next, ctx, dir), message: '' };
  });
  return ok(result);
}

async function forfeitSchoolMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));
  const forfeitBy = String(payload.forfeitBy || ctx.actorId).trim();

  const dir = await buildDirectory(ctx);
  const role = legacyRoleOf(ctx);
  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('找不到这场比赛');
    if (!canForfeit(doc, forfeitBy, ctx.actorId, { role })) return refused('你无权记录这次弃权');

    const nowIso = iso(ctx.now);
    const patch = buildForfeitPatch(doc, forfeitBy, { actorId: ctx.actorId, now: ctx.now });
    const next = { ...doc, ...patch, actedAt: nowIso, revision: doc.revision + 1 };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, 'forfeitMatch', next.revision),
      action: 'forfeitMatch', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, matchId: doc._id, targetUserId: forfeitBy, at: nowIso });
    return { ok: true, match: matchSummary(next, ctx, dir), message: '' };
  });
  const resolved = await advanceAfterResolved(ctx, result);
  return ok(await advanceCollegeAfterResolved(ctx, resolved));
}

async function assignSchoolMatchReferee(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.matchId !== 'string' || !payload.matchId) return ok(refused('缺少比赛编号'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有管理员可以指派裁判'));

  const refereeId = String(payload.refereeId || '').trim();
  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.matches.getById(payload.matchId);
    if (!isMatchDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('找不到这场比赛');
    if (!canAssignReferee(doc)) return refused('这场比赛已生效或已作废，不能再改派裁判');

    if (refereeId) {
      const refusal = await refereeRejection(tx, ctx, refereeId);
      if (refusal) return refused(refusal);
    }
    const nowIso = iso(ctx.now);
    const patch = buildRefereePatch(refereeId, { actorId: ctx.actorId, now: ctx.now });
    const next = { ...doc, ...patch, refereeAt: nowIso, revision: doc.revision + 1 };
    await tx.matches.set(doc._id, next);
    await tx.audit.append({ _id: matchAuditKey(doc._id, 'assignMatchReferee', next.revision),
      action: 'assignMatchReferee', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, matchId: doc._id, refereeId, at: nowIso });
    const dir = await buildDirectory(ctx);
    return { ok: true, match: matchSummary(next, ctx, dir), message: '' };
  });
  return ok(result);
}

/** 裁判必须是本范围正常在册的会员：查不到与状态不对分开报。 */
async function refereeRejection(tx, ctx, refereeId) {
  const user = await tx.users.getById(refereeId);
  if (!user) return '找不到这位会员';
  const member = await tx.schoolMembers.getById(schoolMemberKey(refereeId, ctx.schoolId));
  if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE ||
    user.platformStatus !== PLATFORM_STATUS.ACTIVE || user.primarySchoolId !== ctx.schoolId) {
    return '该会员不是正常在册状态，不能担任裁判';
  }
  return '';
}

/** 由规范化记录组装可落库的比赛记录：补范围、稳定主键、ISO 时间与版本。 */
function matchDocFromRecord(record, matchId, ctx, fingerprint) {
  return {
    ...record,
    _id: matchId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    competition: MATCH_COMPETITION.PERSONAL,
    status: MATCH_STATUS.PENDING,
    action: 'submit',
    actor: ctx.actorId,
    actedAt: iso(ctx.now),
    matchTime: iso(record.matchTime),
    fingerprint,
    revision: 1,
  };
}

const fingerprintOf = record => JSON.stringify([
  record.matchType, record.teamA, record.teamB, record.scoreA, record.scoreB,
  record.gamePoints, record.bestOf, record.location, new Date(record.matchTime).getTime(),
]);

module.exports = {
  MATCH_LIST_LIMIT, legacyRoleOf, isMatchDoc, matchSummary,
  buildDirectory, recordOptions,
  listSchoolMatches, getSchoolMatch, getSchoolMatchEntryContext, submitSchoolMatch,
  confirmSchoolMatch, rejectSchoolMatch, revokeSchoolMatch,
  forfeitSchoolMatch, assignSchoolMatchReferee,
};
