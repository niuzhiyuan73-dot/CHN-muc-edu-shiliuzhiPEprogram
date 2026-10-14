/**
 * 学校维度：实时比分 —— 开台 / 判球 / 撤销 / 定稿 / 批量读（协议 2，M1）
 * ============================================================
 * 判球、撤销、重算、定稿的纯逻辑一字不改地复用旧栈 `live-score.js`（同一把尺子），
 * 本片只管**归属**与**权限来源**：
 *   · 实时态 `_id` 由 `schoolId + association + matchId` 构成，读写先过
 *     `belongsToSchoolScope`；跨校 / 跨协会既读不到也写不进；
 *   · 计分权与录分权同源（`canRecordScore`），S2 角色由 `legacyRoleOf` 推导，
 *     学院边界复用比赛服务的目录解析，避免「看得见计分台、点下去却被拒」。
 *
 * 【定稿为什么不 bumpSeason】
 * 旧栈定稿会走 `writeScheduledScore` 顺带让赛季版本 +1。学校维度的赛季版本
 * 落在 M4，这里只把正式比分写回比赛记录（保持「待确认」，确认权仍在裁判 /
 * 管理员手里），不碰赛季缓存——每校独立的赛季族由 M4 统一接管。
 * ============================================================
 */

const { canReadAssociationSpace } = require('./association-space-permission.js');
const { schoolLiveKey, belongsToSchoolScope } = require('../utils/school.js');
const { MATCH_STATUS } = require('../utils/constants.js');
const { canRecordScore, fillScheduledMatch } = require('./match-record.js');
const {
  LIVE_STATUS, SIDE, createLive, applyRally,
  undoRally: undoLiveRally, hasRally, isFinalized, liveScoreOf, toOfficialScores,
} = require('./live-score.js');
const {
  buildDirectory, recordOptions, isMatchDoc, matchSummary,
} = require('./school-match-service.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const iso = value => new Date(value).toISOString();

/** 计分权与录分权一字不差：能录这一场的人才能开台 / 判球 / 撤销 / 定稿。 */
function mayRecord(doc, ctx, dir) {
  return canRecordScore(doc, ctx.actorId, recordOptions(ctx, dir));
}

/** 找一场比赛并校验计分权，四个写接口共用。读列表已在事务外取好目录。 */
async function liveTarget(ctx, matchId, dir) {
  const match = await ctx.repo.matches.getById(matchId);
  if (!isMatchDoc(match) || !belongsToSchoolScope(match, ctx)) return { error: '找不到这场比赛' };
  // 已生效 / 已作废的比赛不再开实时台：改历史要走撤销，重录要走录分页。
  if (match.status !== MATCH_STATUS.PENDING) {
    return { error: '这场比赛已生效或已作废，不能再计分' };
  }
  if (!mayRecord(match, ctx, dir)) return { error: '你无权为这场比赛计分' };
  return { match };
}

/** 写接口公共入参：登录、比赛编号、读权限、范围目录。 */
async function guard(payload, ctx) {
  if (!ctx.actorId) return { error: '请先登录' };
  if (typeof payload.matchId !== 'string' || !payload.matchId) return { error: '缺少比赛编号' };
  if (!canReadAssociationSpace(ctx)) return { error: '没有读取协会空间的权限' };
  const dir = await buildDirectory(ctx);
  const target = await liveTarget(ctx, payload.matchId, dir);
  if (target.error) return { error: target.error };
  return { dir, match: target.match };
}

async function startSchoolLiveScore(payload = {}, ctx) {
  const ready = await guard(payload, ctx);
  if (ready.error) return ok(refused(ready.error, { live: null }));

  const id = schoolLiveKey(payload.matchId, ctx);
  const live = await ctx.repo.transaction(async tx => {
    // 事务内再核一次：并发的两次开台只会落地一条。
    const existing = await tx.liveScores.getById(id);
    if (existing) return existing;
    const state = createLive(ready.match, { actorId: ctx.actorId, now: ctx.now });
    const doc = { ...state, _id: id, schoolId: ctx.schoolId, association: ctx.association };
    await tx.liveScores.set(id, doc);
    return doc;
  });
  return ok({ ok: true, live, message: '' });
}

async function recordSchoolRally(payload = {}, ctx) {
  const ready = await guard(payload, ctx);
  if (ready.error) return ok(refused(ready.error, { live: null }));

  const id = schoolLiveKey(payload.matchId, ctx);
  const side = payload.side;
  const rallyId = String(payload.rallyId || '');

  const result = await ctx.repo.transaction(async tx => {
    // 事务内重读：并发判球以库里那份为准，避免两个请求都基于旧分各加一。
    const current = await tx.liveScores.getById(id);
    if (!current || !belongsToSchoolScope(current, ctx)) {
      return { error: '这场比赛还没开实时计分台', live: null };
    }
    if (current.status !== LIVE_STATUS.LIVE) {
      return { error: '比赛已经结束，不能再判球', live: current };
    }
    if (side !== SIDE.A && side !== SIDE.B) {
      return { error: '判球方不合法', live: current };
    }
    // 幂等：同一个 rallyId 重发（断线重试 / 连点）不再计一次。
    if (hasRally(current, rallyId)) return { live: current };

    const next = { ...applyRally(current, side, { rallyId }), updatedBy: ctx.actorId, updatedAt: ctx.now };
    await tx.liveScores.set(id, next);
    return { live: next };
  });

  if (result.error) return ok(refused(result.error, { live: result.live }));
  return ok({ ok: true, live: result.live, message: '' });
}

async function undoSchoolRally(payload = {}, ctx) {
  const ready = await guard(payload, ctx);
  if (ready.error) return ok(refused(ready.error, { live: null }));

  const id = schoolLiveKey(payload.matchId, ctx);
  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.liveScores.getById(id);
    if (!current || !belongsToSchoolScope(current, ctx)) {
      return { error: '这场比赛还没开实时计分台', live: null };
    }
    // 定稿之后正式比分已经写进比赛记录，此时再撤会让实时态与比赛记录各说各话。
    if (isFinalized(current)) return { error: '比赛已经定稿，不能再撤销判球', live: current };
    if (!current.rallies || current.rallies.length === 0) {
      return { error: '没有可撤销的判球', live: current };
    }

    const next = { ...undoLiveRally(current), updatedBy: ctx.actorId, updatedAt: ctx.now };
    await tx.liveScores.set(id, next);
    return { live: next };
  });

  if (result.error) return ok(refused(result.error, { live: result.live }));
  return ok({ ok: true, live: result.live, message: '' });
}

async function finishSchoolLiveScore(payload = {}, ctx) {
  const ready = await guard(payload, ctx);
  if (ready.error) return ok(refused(ready.error, { live: null, match: null }));

  const id = schoolLiveKey(payload.matchId, ctx);
  const matchId = payload.matchId;
  // 正式比分与定稿章必须一起提交；任何异常都会回滚整个事务。
  const result = await ctx.repo.transaction(async tx => {
    const current = await tx.liveScores.getById(id);
    const failed = message => ({ ok: false, live: current || null, match: null, message });
    if (!current || !belongsToSchoolScope(current, ctx)) return failed('这场比赛还没开实时计分台');
    if (isFinalized(current)) return failed('比赛已经定稿了');
    if (current.status !== LIVE_STATUS.FINISHED) return failed('比赛还没打完，不能定稿');
    const scores = toOfficialScores(current);
    if (scores.scoreA.length === 0) return failed('还没有可提交的比分');

    const match = await tx.matches.getById(matchId);
    if (!isMatchDoc(match) || !belongsToSchoolScope(match, ctx)) return failed('找不到这场比赛');
    if (match.status !== MATCH_STATUS.PENDING) return failed('只有待确认的比赛可以录分');
    if (!mayRecord(match, ctx, ready.dir)) return failed('你无权为这场比赛计分');

    const filled = fillScheduledMatch(match, scores, {
      members: ready.dir.memberIds, now: ctx.now, recorder: ctx.actorId,
    });
    if (!filled.ok) return failed(filled.firstError || '提交失败');
    // 补录后仍是「待确认」：确认权照旧落在裁判 / 管理员手里。
    const patch = {
      ...filled.patch, status: MATCH_STATUS.PENDING, action: 'score',
      actor: ctx.actorId, actedAt: iso(ctx.now), revision: (match.revision || 1) + 1,
    };
    const nextMatch = { ...match, ...patch };
    await tx.matches.set(matchId, nextMatch);

    // 盖 finalizedAt 章：此后 undoRally 一律拒绝，实时态转只读。
    const live = { ...current, finalizedAt: ctx.now, updatedBy: ctx.actorId, updatedAt: ctx.now };
    await tx.liveScores.set(id, live);
    return { ok: true, live, match: matchSummary(nextMatch, ctx, ready.dir), message: '' };
  });
  return ok(result);
}

/** 批量取实时比分，供查看端轮询。只返回比分相关字段，尽量小。 */
async function getSchoolLiveScores(payload = {}, ctx) {
  if (!canReadAssociationSpace(ctx)) return ok({ ok: true, scores: [], message: '' });
  const ids = Array.isArray(payload.matchIds) ? payload.matchIds : [];
  if (ids.length === 0) return ok({ ok: true, scores: [], message: '' });

  const scores = [];
  for (const matchId of ids) {
    if (typeof matchId !== 'string' || !matchId) continue;
    const state = await ctx.repo.liveScores.getById(schoolLiveKey(matchId, ctx));
    // 编号由调用方给，直读集合前判一次归属——别校 / 别协会的实时比分同样读不到。
    if (state && belongsToSchoolScope(state, ctx)) scores.push(liveScoreOf(state));
  }
  return ok({ ok: true, scores, message: '' });
}

module.exports = {
  startSchoolLiveScore, recordSchoolRally, undoSchoolRally,
  finishSchoolLiveScore, getSchoolLiveScores,
};
