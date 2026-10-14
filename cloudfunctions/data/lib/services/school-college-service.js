/**
 * 学校维度：学院赛 —— 发布 / 名单 / 抽签 / 开赛 / 排阵 / 名次结束（协议 2，M2-a / M2-b / M2-c）
 * ============================================================
 * 学院赛与个人赛并行，是两套互不干扰的体系（D1）：学院赛不靠个人报名，而由
 * 学院负责人提交一份本学院名单（D10），管理员审核通过后进入抽签；抽签把已
 * 通过的学院排进签表，赛事级「开始」再铺出第一轮全部大场（D35 / D36）。
 *
 * 本模块只管**归属**与**权限来源**，规则一字不改复用旧栈纯模块
 * （`college-event.js` / `college-entry.js` / `college-draw.js` /
 * `college-tie.js`，同一把尺子）：
 *   · 学院赛主记录绑定 `schoolId + association`，读写先过 `belongsToSchoolScope`；
 *   · 名单按 `scope + eventId + collegeId` 稳定成键，跨校跨协会无法伪造；
 *   · 大场主键由签位决定（`college-tie.collegeTieKey`），重抽 / 重开按 _id
 *     覆盖，不堆出两批首轮；大场记录补 `schoolId + association`，跨校读不到；
 *   · 旧栈 ROLE 由 S2 角色推导（见 school-actor.js），与比赛 / 实时比分同源。
 *
 * 【学院目录：每校独立】
 * 旧栈把有效学院写死在全局 `COLLEGES`，且判权 / 校验都按学院**全名**。学校
 * 维度改为每校一份目录，对外主键用**稳定编号** `collegeId`（见 `collegeEntryKey`），
 * 显示与旧栈校验仍按全名。两者的互查收在 `school-actor.buildCollegeDirectory`，
 * 校验时把本校学院全名清单注入旧栈纯模块（`ctx.colleges`），不另抄一遍规则。
 *
 * 【名单：不删只改】
 * 提交后查得到、管理员退回也保留记录——同一「赛事 + 学院」只有一份，重复提交
 * 覆盖同一条（键稳定），谁在什么时候交过、为什么被退回，都有据可查。
 *
 * 【并发与幂等】
 *   · 发布用 requestId 派生稳定 eventId，同编号重试返回同一条，改内容则拒绝；
 *   · 提交 / 审核在同一事务内读改，键由范围派生，重复提交只改不重。
 *
 * 【职责边界】
 * 注入 repo 与上下文（ctx），不引用 wx、不引用云 SDK——mock 与云端跑同一份。
 * ============================================================
 */

const { buildSchoolContext } = require('./school-context.js');
const { canReadAssociationSpace } = require('./association-space-permission.js');
// 学院目录（编号 ↔ 全名）与旧栈「账号」的推导收在 school-actor，两套栈只有一份口径。
const { buildCollegeDirectory, legacyActorOf } = require('./school-actor.js');
const {
  schoolKey, schoolMemberKey, belongsToSchoolScope, collegeEventKey, collegeEntryKey,
  collegeLineupKey, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS,
} = require('../utils/school.js');
const {
  COLLEGE_EVENT_STATUS, COLLEGE_ENTRY_STATUS, TIE_STATUS,
} = require('../utils/constants.js');
// 发布表单 / 状态文案 / 名次与名单的校验一律复用旧栈纯规则。
const {
  buildCollegeEventRecord, buildCollegeEventRow, canManageCollegeEvent,
  validateCollegePlacements, canFinishCollegeEvent,
} = require('./college-event.js');
const { buildCollegeEntryRecord, buildCollegeEntryRow, validateEntryReview } = require('./college-entry.js');
// 抽签 / 大场 / 排阵：同样是旧栈纯模块，落位算法与个人赛同宗（utils/bracket.js）。
const { canDrawCollegeEvent, planCollegeDraw, buildCollegeDrawRecord } = require('./college-draw.js');
const {
  canStartCollegeEvent, firstRoundPairsOf, buildTiesForRound, buildTieRow,
  canStartTie, canAssignTieReferee, legMatchIdsOf, buildLegMatchDrafts, tieStatusOf,
} = require('./college-tie.js');
const { buildLineupRecord, buildLineupRow, canSubmitLineup } = require('./college-lineup.js');
const { canAssignReferee, buildRefereePatch } = require('./match-record.js');
const { REVIEW_ACTION } = require('./member-review.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const EVENT_LIST_LIMIT = 20;
const EVENT_LIST_MAX = 50;

const iso = value => new Date(value).toISOString();

const freshContext = (tx, ctx) => buildSchoolContext({
  repo: tx, actorId: ctx.actorId,
  scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now,
});

const collegeEventAuditKey = (eventId, action, revision) =>
  schoolKey('ceau', eventId, action, String(revision));
const collegeEntryAuditKey = (eventId, collegeId, action, revision) =>
  schoolKey('cenau', eventId, collegeId, action, String(revision));
const collegeTieAuditKey = (eventId, action, revision) =>
  schoolKey('ctau', eventId, action, String(revision));
const collegeLineupAuditKey = (tieId, collegeId, revision) =>
  schoolKey('clau', tieId, collegeId, String(revision));

/** 一条学院赛主记录。status 可以是 0（报名中，falsy），所以不能用真值判断。 */
const isCollegeEventDoc = doc => Boolean(doc && doc.title && typeof doc.status === 'number' && doc.startTime);

/** 一条大场记录：有双方学院与轮次即认。 */
const isCollegeTieDoc = doc => Boolean(doc && doc.eventId && doc.collegeA && doc.collegeB
  && typeof doc.round === 'number');

/** 列表排序权重：报名中在前，已结束在后。 */
const STATUS_PRIORITY = {
  [COLLEGE_EVENT_STATUS.SIGNUP]: 0,
  [COLLEGE_EVENT_STATUS.READY]: 1,
  [COLLEGE_EVENT_STATUS.ONGOING]: 2,
  [COLLEGE_EVENT_STATUS.FINISHED]: 3,
};

/** 由规范化记录组装可落库的学院赛主记录：补范围、稳定主键、ISO 时间与版本。 */
function collegeEventDoc(record, eventId, ctx, fingerprint) {
  return {
    ...record,
    _id: eventId,
    schoolId: ctx.schoolId,
    association: ctx.association,
    startTime: iso(record.startTime),
    publishTime: iso(record.publishTime),
    pinned: false,
    fingerprint,
    revision: 1,
    updatedAt: iso(record.publishTime),
  };
}

/** 幂等指纹：同编号重发同样的单子返回同一条，改过内容则拒绝。 */
const fingerprintOf = record => JSON.stringify([
  record.title, record.description, record.legPlan, record.allowMultiEntry,
  record.rosterMin, record.rosterMax, record.tieAlgo, record.tieNetMode,
  record.location, record.courtCount, new Date(record.startTime).getTime(),
]);

/** 把学院编号解析成本校的全名；同时回退接受直接提交的全名。 */
function resolveCollege(payload = {}, dir) {
  const collegeId = String(payload.collegeId || '').trim()
    || dir.collegeIdByName(String(payload.college || '').trim());
  const college = dir.collegeNameById(collegeId) || String(payload.college || '').trim();
  return { collegeId, college };
}

/** 会员编号 → 档案的映射，供名单行显示姓名。 */
const memberMapOf = dir => new Map(dir.members.map(item => [item._id, item]));

/* ------------------------------------------------------------------ 读 */

async function listCollegeEvents(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, events: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const canManage = canManageCollegeEvent(actor);

  let rows = (await ctx.repo.forScope(ctx).collegeEvents.list()).filter(isCollegeEventDoc);
  if (typeof payload.status === 'number') rows = rows.filter(row => row.status === payload.status);

  const sorted = rows.slice().sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    const byStatus = (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99);
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
    events: page.map(doc => buildCollegeEventRow(doc, { actor })),
    message: '',
  });
}

async function getCollegeEvent(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));

  const doc = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return ok(refused('学院赛不存在'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  return ok({
    ok: true,
    canManage: canManageCollegeEvent(actor),
    event: buildCollegeEventRow(doc, { actor }),
    message: '',
  });
}

async function listCollegeEntries(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, entries: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const canManage = canManageCollegeEvent(actor);

  const all = await ctx.repo.forScope(ctx).collegeEntries.list();
  const rows = typeof payload.eventId === 'string' && payload.eventId
    ? all.filter(row => row.eventId === payload.eventId) : all;

  // 名单能否再改，取决于所属学院赛是否仍在报名阶段；取不到的赛事不传，行内 canEdit 自动为假。
  const event = typeof payload.eventId === 'string' && payload.eventId
    ? await ctx.repo.collegeEvents.getById(payload.eventId) : null;
  const eventDoc = isCollegeEventDoc(event) && belongsToSchoolScope(event, ctx) ? event : null;
  const members = memberMapOf(dir);

  return ok({
    ok: true, canManage,
    entries: rows
      .slice()
      .sort((a, b) => (a.college < b.college ? -1 : 1))
      .map(row => buildCollegeEntryRow(row, { actor, event: eventDoc, members })),
    message: '',
  });
}

async function listCollegeTies(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, ties: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);

  const all = (await ctx.repo.forScope(ctx).ties.list()).filter(isCollegeTieDoc);
  const rows = typeof payload.eventId === 'string' && payload.eventId
    ? all.filter(row => row.eventId === payload.eventId) : all;

  const sorted = rows.slice().sort(
    (a, b) => (Number(a.round) - Number(b.round)) || (Number(a.slot) - Number(b.slot)));

  return ok({
    ok: true, canManage: canManageCollegeEvent(actor),
    ties: sorted.map(tie => buildTieRow(tie, { actor })),
    message: '',
  });
}

async function listCollegeLineups(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) {
    return ok({ ok: false, lineups: [], canManage: false, message: '没有读取协会空间的权限' });
  }
  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const members = memberMapOf(dir);

  let rows = await ctx.repo.forScope(ctx).lineups.list();
  if (typeof payload.eventId === 'string' && payload.eventId) {
    rows = rows.filter(row => row.eventId === payload.eventId);
  }
  if (typeof payload.tieId === 'string' && payload.tieId) {
    rows = rows.filter(row => row.tieId === payload.tieId);
  }

  return ok({
    ok: true, canManage: canManageCollegeEvent(actor),
    lineups: rows.map(row => buildLineupRow(row, { actor, members })),
    message: '',
  });
}

/* ------------------------------------------------------------------ 写 */

async function publishCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('发布请求编号无效'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const built = buildCollegeEventRecord(payload, { actor, now: ctx.now });
  if (!built.ok) return ok(refused(built.firstError, { errors: built.errors }));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await freshContext(tx, ctx);
    // 发布权与旧栈同一门槛：仅管理员（学院负责人 / 会员都不行）。
    if (!canManageCollegeEvent(legacyActorOf(fresh, dir))) return refused('只有管理员可以发布学院赛');

    const eventId = collegeEventKey(schoolKey('ce', fresh.actorId, token), fresh);
    const doc = collegeEventDoc(built.record, eventId, fresh, fingerprintOf(built.record));
    const existing = await tx.collegeEvents.getById(eventId);
    if (isCollegeEventDoc(existing)) {
      return existing.fingerprint === doc.fingerprint
        ? { ok: true, event: buildCollegeEventRow(existing, { actor }), message: '' }
        : refused('请求编号已使用，请重新发布');
    }
    await tx.collegeEvents.set(eventId, doc);
    await tx.audit.append({ _id: collegeEventAuditKey(eventId, 'publishCollegeEvent', 1),
      action: 'publishCollegeEvent', schoolId: fresh.schoolId, association: fresh.association,
      actorId: fresh.actorId, eventId, at: iso(fresh.now) });
    return { ok: true, event: buildCollegeEventRow(doc, { actor }), message: '' };
  });
  return ok(result);
}

async function submitCollegeEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const { collegeId, college } = resolveCollege(payload, dir);
  const members = memberMapOf(dir);

  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('学院赛不存在');

    // 校验复用旧栈纯规则：在册、同学院、人数上下限。有效学院清单取本校目录。
    const built = buildCollegeEntryRecord(
      { ...payload, college },
      { event: doc, actor, members: dir.members, colleges: dir.collegeNames, now: ctx.now });
    if (!built.ok) return refused(built.message);

    const key = collegeEntryKey(doc._id, collegeId, ctx);
    const existing = await tx.collegeEntries.getById(key);
    const nowIso = iso(ctx.now);
    const entry = {
      ...built.record,
      _id: key,
      schoolId: ctx.schoolId,
      association: ctx.association,
      collegeId,
      submitTime: nowIso,
      revision: existing ? Number(existing.revision || 1) + 1 : 1,
      updatedAt: nowIso,
    };
    await tx.collegeEntries.set(key, entry);
    await tx.audit.append({ _id: collegeEntryAuditKey(doc._id, collegeId, 'submitCollegeEntry', entry.revision),
      action: 'submitCollegeEntry', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, collegeId, at: nowIso });
    return { ok: true, entry: buildCollegeEntryRow(entry, { actor, event: doc, members }), message: '' };
  });
  return ok(result);
}

async function reviewCollegeEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const { collegeId } = resolveCollege(payload, dir);
  if (!collegeId) return ok(refused('请指定要审核的学院'));
  const members = memberMapOf(dir);

  const result = await ctx.repo.transaction(async tx => {
    const doc = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(doc) || !belongsToSchoolScope(doc, ctx)) return refused('学院赛不存在');

    const key = collegeEntryKey(doc._id, collegeId, ctx);
    const entry = await tx.collegeEntries.getById(key);
    // 审核权与旧栈同一门槛：仅管理员；退回必须给理由。
    const checked = validateEntryReview(actor, entry, payload.action, payload.reason);
    if (!checked.ok) return refused(checked.message);

    const nowIso = iso(ctx.now);
    const next = {
      ...entry,
      status: checked.status,
      reviewedBy: ctx.actorId,
      reviewedAt: nowIso,
      reason: payload.action === REVIEW_ACTION.REJECT ? String(payload.reason || '').trim() : '',
      revision: Number(entry.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.collegeEntries.set(key, next);
    await tx.audit.append({ _id: collegeEntryAuditKey(doc._id, collegeId, `reviewCollegeEntry-${checked.status}`, next.revision),
      action: 'reviewCollegeEntry', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: doc._id, collegeId, status: checked.status, at: nowIso });
    return { ok: true, entry: buildCollegeEntryRow(next, { actor, event: doc, members }), message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------ 抽签 / 开赛 */

async function drawCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const event = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('学院赛不存在'));

  // 抽签定的是整场对阵结构，与发布同一门槛：仅管理员，且赛事在报名中。
  if (!canDrawCollegeEvent(event, actor)) {
    return ok(refused(event.status !== COLLEGE_EVENT_STATUS.SIGNUP ? '只能在报名阶段抽签' : '只有管理员可以抽签'));
  }

  // 名单直读集合：只有已通过审核的学院才进签表（旧栈 approvedCollegesOf 同口径）。
  const entries = (await ctx.repo.forScope(ctx).collegeEntries.list())
    .filter(row => row.eventId === event._id);
  // seedValue 由调用方给（测试可复现）；没给就现取一个随机值并落库备查。
  const seedValue = Number.isFinite(Number(payload.seedValue))
    ? Number(payload.seedValue) : Math.floor(Math.random() * 0x7fffffff);

  const plan = planCollegeDraw({ event, actor, entries, seedColleges: payload.seedColleges, seedValue });
  if (!plan.ok) return ok(refused(plan.message));

  const draw = buildCollegeDrawRecord(plan, { drawnAt: ctx.now, drawnBy: ctx.actorId });
  const nowIso = iso(ctx.now);

  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('学院赛不存在');
    // 事务内复查状态：并发两次抽签只落一次。
    if (current.status !== COLLEGE_EVENT_STATUS.SIGNUP) return refused('只能在报名阶段抽签');

    // 抽签顺带锁定名单：status 转 READY，而名单提交权只看「是否报名中」，自然不可再改（D13）。
    const next = {
      ...current,
      draw,
      status: COLLEGE_EVENT_STATUS.READY,
      seedColleges: Array.isArray(draw.seeds) ? draw.seeds.slice() : [],
      revision: Number(current.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'drawCollegeEvent', next.revision),
      action: 'drawCollegeEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: payload.eventId, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }), draw, message: '' };
  });
  return ok(result);
}

async function startCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const event = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('学院赛不存在'));

  if (!canStartCollegeEvent(event, actor)) {
    return ok(refused(event.status !== COLLEGE_EVENT_STATUS.READY ? '还没有抽签，不能开始' : '只有管理员可以开始赛事'));
  }

  const ties = buildTiesForRound({ event, round: 1, pairs: firstRoundPairsOf(event.draw) });
  const nowIso = iso(ctx.now);

  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('学院赛不存在');
    // 事务内复查：并发的第二次「开始」不再覆盖首轮——只补不覆盖，免得冲掉其间已录的排阵 / 比分。
    if (current.status !== COLLEGE_EVENT_STATUS.READY) return refused('这场学院赛已经开始了');

    const stored = [];
    for (const tie of ties) {
      const existing = await tx.ties.getById(tie._id);
      if (existing) { stored.push(existing); continue; }
      const doc = { ...tie, schoolId: ctx.schoolId, association: ctx.association,
        revision: 1, updatedAt: nowIso };
      await tx.ties.set(tie._id, doc);
      stored.push(doc);
    }

    const next = {
      ...current,
      status: COLLEGE_EVENT_STATUS.ONGOING,
      currentRound: 1,
      startedAt: nowIso,
      revision: Number(current.revision || 1) + 1,
      updatedAt: nowIso,
    };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'startCollegeEvent', next.revision),
      action: 'startCollegeEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: payload.eventId, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }),
      ties: stored.map(tie => buildTieRow(tie, { actor })), message: '' };
  });
  return ok(result);
}

/* ------------------------------------------------------------ 排阵 / 开大场 / 名次 */

/** 裁判必须是本范围内正常在册的会员：查不到与状态不对分开报（与个人赛同一口径）。 */
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

async function submitCollegeLineup(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const { collegeId, college } = resolveCollege(payload, dir);
  if (!collegeId) return ok(refused('学院无效'));

  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  const event = await ctx.repo.collegeEvents.getById(tie.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('找不到这场学院赛'));

  // 排阵的人必须出自本学院已通过审核的名单（D37）；校验复用旧栈 college-lineup 纯规则。
  const entry = await ctx.repo.collegeEntries.getById(collegeEntryKey(tie.eventId, collegeId, ctx));
  const built = buildLineupRecord(
    { ...payload, college },
    { tie, event, actor, entry, now: ctx.now, carriedFrom: payload.carriedFrom, members: dir.members });
  if (!built.ok) return ok(refused(built.message));

  const key = collegeLineupKey(tie._id, collegeId, ctx);
  const side = college === tie.collegeA ? 'lineupA' : 'lineupB';
  const members = memberMapOf(dir);
  const nowIso = iso(ctx.now);

  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.ties.getById(payload.tieId);
    if (!isCollegeTieDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('找不到这个大场');
    // 事务内复查：大场已开始 / 已结束就不能再改排阵。
    if (!canSubmitLineup(current, actor, { college, event })) return refused('大场已经开始，不能再改排阵');

    const existing = await tx.lineups.getById(key);
    const doc = {
      ...built.record,
      _id: key,
      schoolId: ctx.schoolId,
      association: ctx.association,
      collegeId,
      submitTime: nowIso,
      revision: existing ? Number(existing.revision || 1) + 1 : 1,
      updatedAt: nowIso,
    };
    await tx.lineups.set(key, doc);
    // 每次提交只翻自己那一侧，另一方不受影响（大场状态由 tieStatusOf 推出）。
    await tx.ties.set(payload.tieId, { ...current, [side]: true,
      revision: Number(current.revision || 1) + 1, updatedAt: nowIso });
    await tx.audit.append({ _id: collegeLineupAuditKey(payload.tieId, collegeId, doc.revision),
      action: 'submitCollegeLineup', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: tie.eventId, tieId: payload.tieId, collegeId, at: nowIso });
    return { ok: true, lineup: buildLineupRow(doc, { actor, members }), message: '' };
  });
  return ok(result);
}

async function startCollegeTie(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  const event = await ctx.repo.collegeEvents.getById(tie.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('找不到这场学院赛'));

  if (!canStartTie(tie, actor)) {
    if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) return ok(refused('这个大场已经开始'));
    if (!(tie.lineupA && tie.lineupB)) return ok(refused('双方排阵还没交齐，不能开始'));
    return ok(refused('只有管理员可以开始大场'));
  }

  // 排阵在事务外一次取全（事务内不允许整表查询）；小场草稿按排阵铺出。
  const lineups = (await ctx.repo.forScope(ctx).lineups.list()).filter(row => row.eventId === tie.eventId);
  const built = buildLegMatchDrafts({ event, tie, lineups, now: ctx.now });
  if (!built.ok) return ok(refused(built.message));

  const byLegNo = new Map(built.drafts.map(draft => [Number(draft.legNo), draft._id]));
  const legs = (Array.isArray(tie.legs) ? tie.legs : []).map(leg => ({
    ...leg, matchId: byLegNo.get(Number(leg.legNo)) || leg.matchId || '',
  }));
  const nowIso = iso(ctx.now);

  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.ties.getById(payload.tieId);
    if (!isCollegeTieDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('找不到这个大场');
    if (tieStatusOf(current) !== TIE_STATUS.READY) return refused('这个大场已经开始');

    for (const draft of built.drafts) {
      const existing = await tx.matches.getById(draft._id);
      // 重开同一大场：编号相同，只补不覆盖，免得冲掉已录的比分。
      if (existing) continue;
      await tx.matches.set(draft._id, { ...draft, _id: draft._id, schoolId: ctx.schoolId,
        association: ctx.association, matchTime: nowIso, createdAt: nowIso, revision: 1, updatedAt: nowIso });
    }
    const next = { ...current, status: TIE_STATUS.ONGOING, startedAt: nowIso, legs,
      revision: Number(current.revision || 1) + 1, updatedAt: nowIso };
    await tx.ties.set(payload.tieId, next);
    await tx.audit.append({ _id: collegeTieAuditKey(payload.tieId, 'startCollegeTie', next.revision),
      action: 'startCollegeTie', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: current.eventId, tieId: payload.tieId, at: nowIso });
    return { ok: true, tie: buildTieRow(next, { actor }), message: '' };
  });
  return ok(result);
}

async function assignCollegeTieReferee(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.tieId !== 'string' || !payload.tieId) return ok(refused('缺少大场编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  if (!canManageCollegeEvent(actor)) return ok(refused('只有管理员可以指派裁判'));

  const tie = await ctx.repo.ties.getById(payload.tieId);
  if (!isCollegeTieDoc(tie) || !belongsToSchoolScope(tie, ctx)) return ok(refused('找不到这个大场'));
  if (!canAssignTieReferee(tie)) return ok(refused('这个大场已经结束，不能再改派裁判'));

  const refereeId = String(payload.refereeId || '').trim();
  const nowIso = iso(ctx.now);
  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.ties.getById(payload.tieId);
    if (!isCollegeTieDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('找不到这个大场');
    if (!canAssignTieReferee(current)) return refused('这个大场已经结束，不能再改派裁判');
    if (refereeId) {
      const rejection = await refereeRejection(tx, ctx, refereeId);
      if (rejection) return refused(rejection);
    }

    const patch = buildRefereePatch(refereeId, { actorId: ctx.actorId, now: ctx.now });
    // 一次指派 = 写大场 + 写它下面所有能改派的小场（权限判定只读小场自己的 referee）。
    for (const legId of legMatchIdsOf(current)) {
      const leg = await tx.matches.getById(legId);
      if (!leg || !canAssignReferee(leg)) continue;
      await tx.matches.set(legId, { ...leg, ...patch,
        revision: Number(leg.revision || 1) + 1, updatedAt: nowIso });
    }
    const next = { ...current, ...patch, refereeAt: nowIso,
      revision: Number(current.revision || 1) + 1, updatedAt: nowIso };
    await tx.ties.set(payload.tieId, next);
    await tx.audit.append({ _id: collegeTieAuditKey(payload.tieId, 'assignCollegeTieReferee', next.revision),
      action: 'assignCollegeTieReferee', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: current.eventId, tieId: payload.tieId, refereeId, at: nowIso });
    return { ok: true, tie: buildTieRow(next, { actor }), message: '' };
  });
  return ok(result);
}

async function finishCollegeEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (typeof payload.eventId !== 'string' || !payload.eventId) return ok(refused('缺少学院赛编号'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('没有读取协会空间的权限'));

  const dir = await buildCollegeDirectory(ctx);
  const actor = legacyActorOf(ctx, dir);
  const event = await ctx.repo.collegeEvents.getById(payload.eventId);
  if (!isCollegeEventDoc(event) || !belongsToSchoolScope(event, ctx)) return ok(refused('学院赛不存在'));
  if (event.status === COLLEGE_EVENT_STATUS.FINISHED) return ok(refused('这场学院赛已经结束了'));
  if (event.status !== COLLEGE_EVENT_STATUS.ONGOING) return ok(refused('学院赛还没开始，不能录入名次'));
  if (!canFinishCollegeEvent(event, actor)) return ok(refused('只有管理员可以录入名次'));

  // 只能给「已通过审核」的学院记名次，挡住手滑写进来的学院名。
  const entries = (await ctx.repo.forScope(ctx).collegeEntries.list())
    .filter(row => row.eventId === event._id && row.status === COLLEGE_ENTRY_STATUS.APPROVED);
  const checked = validateCollegePlacements(payload.results, { colleges: entries.map(row => row.college) });
  if (!checked.ok) return ok(refused(checked.firstError));

  const nowIso = iso(ctx.now);
  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!isCollegeEventDoc(current) || !belongsToSchoolScope(current, ctx)) return refused('学院赛不存在');
    if (current.status !== COLLEGE_EVENT_STATUS.ONGOING) return refused('这场学院赛已经结束了');

    const next = { ...current, status: COLLEGE_EVENT_STATUS.FINISHED, results: checked.results,
      finishedAt: nowIso, revision: Number(current.revision || 1) + 1, updatedAt: nowIso };
    await tx.collegeEvents.set(payload.eventId, next);
    await tx.audit.append({ _id: collegeEventAuditKey(payload.eventId, 'finishCollegeEvent', next.revision),
      action: 'finishCollegeEvent', schoolId: ctx.schoolId, association: ctx.association,
      actorId: ctx.actorId, eventId: payload.eventId, at: nowIso });
    return { ok: true, event: buildCollegeEventRow(next, { actor }), results: next.results, message: '' };
  });
  return ok(result);
}

module.exports = {
  EVENT_LIST_LIMIT, EVENT_LIST_MAX,
  isCollegeEventDoc, isCollegeTieDoc,
  listCollegeEvents, getCollegeEvent, publishCollegeEvent,
  listCollegeEntries, submitCollegeEntry, reviewCollegeEntry,
  listCollegeTies, drawCollegeEvent, startCollegeEvent,
  listCollegeLineups, submitCollegeLineup, startCollegeTie,
  assignCollegeTieReferee, finishCollegeEvent,
};
