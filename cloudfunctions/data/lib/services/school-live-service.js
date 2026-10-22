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
const {
  schoolLiveKey, belongsToSchoolScope, schoolMemberKey, collegeKey,
} = require('../utils/school.js');
const { MATCH_STATUS, ROLE } = require('../utils/constants.js');
const { canRecordScore, fillScheduledMatch } = require('./match-record.js');
const { legacyRoleOf } = require('./school-actor.js');
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

/** getSchoolLiveScores 一次最多跟多少场：轮询接口，编号由客户端给，必须限量 */
const LIVE_IDS_MAX = 50;

/**
 * 判球编号（rallyId）的字符集与长度上限。
 *
 * 【为什么必须卡】（2026-10-22 第二轮审查 S-2）
 * 这个编号由客户端生成，会**原样存进实时态文档**的逐球流水（`rallies[].id`），
 * 而每次判球都是整条文档重写。原实现只做了 `String(payload.rallyId)`，
 * 一条 1 MB 的编号就能让该场 `liveScores` 文档超出单文档上限：此后每一次判球
 * 都写入失败，这场比赛既不能继续计分、也不能撤销或定稿，只能改库修数据。
 *
 * 字符集比照客户端实际生成方式 `<matchId>-<时间戳>-<序号>`（matchId 里可能
 * 含 encodeURIComponent 产生的 `%`），所以放行 `% : . _ -`。
 */
const RALLY_ID_MAX = 200;
const RALLY_ID_PATTERN = new RegExp(`^[A-Za-z0-9%._:-]{1,${RALLY_ID_MAX}}$`);

/**
 * 不需要"别人属于哪个学院"时的空目录。
 *
 * `canRecordScore` 只在**学院负责人**（ROLE.STAFF）那一档才调用 involvesCollege，
 * 即"这位操作者的学院，是否等于某个参赛者的学院"。管理员与参赛者本人都在此之前
 * 就返回了，所以他们根本不需要学院映射（见 match-record.js 的 canRecordScore）。
 */
const EMPTY_RECORD_DIR = Object.freeze({
  actorCollege: '',
  collegeIdOf: () => '',
  collegeNameById: () => '',
  collegeOf: () => '',
});

/**
 * 只取"这场比赛用得上"的那几个学院，而不是全院名单。
 *
 * 【为什么不能直接用 buildDirectory】（2026-10-22 第二轮审查 P-1）
 * `buildDirectory` 会读全校在册名单 + 这批人的账号：2000 人的学校是
 * 20 + 20 = 40 次 RPC。而 `guard()` 在**每一次判球**都会调用它——一场 50 球的
 * 比赛光"确认你有没有权限"就要 2000 次 RPC，同场多个场地并行时直接打空
 * 全校每日读配额（5 万次），限流按 3 写/秒也拦不住（3 × 48 = 144 RPC/秒）。
 *
 * 真正需要的信息只有：操作者自己的学院名，加上**这场比赛的两队选手**各自
 * 属于哪个学院。单人赛 2 人、双人赛 4 人，最多 4 次点读 + 2 次学院名点读。
 *
 * @param {Object} ctx 请求上下文（含 schoolMember）
 * @param {Object} match 比赛记录
 * @returns {Promise<Object>} 与 recordOptions 兼容的目录形状
 */
async function liveRecordDir(ctx, match) {
  const memberCollegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) || '';
  // 没有学院归属 ⇒ involvesCollege 的两个条件（college 非空、collegeOf 是函数）
  // 必然不成立，与"全院目录里查不到他的学院"是同一个结论，读都不用读。
  if (!memberCollegeId) return EMPTY_RECORD_DIR;

  const participants = [...new Set([...(match.teamA || []), ...(match.teamB || [])])];
  const [actorCollege, rows] = await Promise.all([
    ctx.repo.colleges.getById(collegeKey(ctx.schoolId, memberCollegeId)),
    Promise.all(participants.map(userId =>
      ctx.repo.schoolMembers.getById(schoolMemberKey(userId, ctx.schoolId)))),
  ]);
  const actorCollegeName = (actorCollege && actorCollege.name) || '';

  const collegeIdByUser = new Map();
  rows.forEach((row, index) => {
    if (row && row.collegeId) collegeIdByUser.set(participants[index], row.collegeId);
  });

  // 一张「学院编号 → 全名」表，先放操作者自己的学院，再补参赛者涉及的学院。
  // 两边必须走同一张表：involvesCollege 比较的是"操作者学院名 === 参赛者学院名"，
  // 若操作者的学院没有登记进来，同一学院也会被判成不同学院（越权拦截误伤）。
  const nameById = new Map();
  if (memberCollegeId && actorCollegeName) nameById.set(memberCollegeId, actorCollegeName);
  const missingIds = [...new Set([...collegeIdByUser.values()])].filter(id => !nameById.has(id));
  const missing = await Promise.all(missingIds.map(id =>
    ctx.repo.colleges.getById(collegeKey(ctx.schoolId, id))));
  missing.forEach((doc) => {
    if (doc && doc.collegeId) nameById.set(doc.collegeId, doc.name || '');
  });

  return {
    actorCollege: actorCollegeName,
    collegeIdOf: userId => collegeIdByUser.get(userId) || '',
    collegeNameById: id => nameById.get(id) || '',
    collegeOf: userId => nameById.get(collegeIdByUser.get(userId)) || '',
  };
}

/** 计分权与录分权一字不差：能录这一场的人才能开台 / 判球 / 撤销 / 定稿。 */
function mayRecord(doc, ctx, dir) {
  return canRecordScore(doc, ctx.actorId, recordOptions(ctx, dir));
}

/** 写接口公共入参：登录、比赛编号、读权限、计分权。 */
async function guard(payload, ctx, options = {}) {
  if (!ctx.actorId) return { error: '请先登录' };
  if (typeof payload.matchId !== 'string' || !payload.matchId) return { error: '缺少比赛编号' };
  if (!canReadAssociationSpace(ctx)) return { error: '没有读取协会空间的权限' };

  const match = await ctx.repo.matches.getById(payload.matchId);
  if (!isMatchDoc(match) || !belongsToSchoolScope(match, ctx)) return { error: '找不到这场比赛' };
  // 已生效 / 已作废的比赛不再开实时台：改历史要走撤销，重录要走录分页。
  if (match.status !== MATCH_STATUS.PENDING) {
    return { error: '这场比赛已生效或已作废，不能再计分' };
  }

  // 定稿要把正式比分写回比赛记录，`fillScheduledMatch` 需要本院在册名单做校验，
  // 因此只有那一条路读全院目录（一场比赛只发生一次）；判球/撤销走最小读取。
  // 学院关系只对**学院负责人**这一档有意义：管理员与参赛者本人在 canRecordScore
  // 里更早就返回了，为他们读学院映射是纯浪费。
  const dir = options.withRoster
    ? await buildDirectory(ctx)
    : (legacyRoleOf(ctx) === ROLE.STAFF ? await liveRecordDir(ctx, match) : EMPTY_RECORD_DIR);

  if (!mayRecord(match, ctx, dir)) return { error: '你无权为这场比赛计分' };
  return { dir, match };
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
  // 编号必填且必须合法：它既是幂等去重的依据（缺了就会重复计分），
  // 又会原样落库成文档字段（过长会把整场计分台写死），见 RALLY_ID_PATTERN。
  const rallyId = typeof payload.rallyId === 'string' ? payload.rallyId.trim() : '';
  if (!RALLY_ID_PATTERN.test(rallyId)) {
    return ok(refused('判球编号无效（缺失或格式不正确），请刷新页面后重试', { live: null }));
  }

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
  // 定稿要把比分写回比赛记录，`fillScheduledMatch` 用 dir.memberIds 校验阵容，
  // 所以这一条路（每场一次）仍然读全院目录。
  const ready = await guard(payload, ctx, { withRoster: true });
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
  // matchIds 由客户端给（当前页可见的比赛），必须限量：无上限时一次轮询
  // 可以变成上千次顺序 RPC，正好撞上默认 3 秒超时（2026-10-17 审计 C6/C8）。
  const ids = (Array.isArray(payload.matchIds) ? payload.matchIds : [])
    .filter(id => typeof id === 'string' && id)
    .slice(0, LIVE_IDS_MAX);
  if (ids.length === 0) return ok({ ok: true, scores: [], message: '' });

  // 一次批读：`_.in(编号)` 只花 1 个 RTT。原先是「每批 10 个并发、逐条点读」，
  // 50 场要 5 轮往返回，而这是每 2 秒跑一次的轮询接口（2026-10-21 审查 P1-6）。
  const states = await ctx.repo.liveScores.listByIds(ids.map(matchId => schoolLiveKey(matchId, ctx)));
  const scores = [];
  // 编号由调用方给，直读集合前判一次归属——别校 / 别协会的实时比分同样读不到。
  for (const state of states) {
    if (state && belongsToSchoolScope(state, ctx)) scores.push(liveScoreOf(state));
  }
  return ok({ ok: true, scores, message: '' });
}

module.exports = {
  startSchoolLiveScore, recordSchoolRally, undoSchoolRally,
  finishSchoolLiveScore, getSchoolLiveScores,
};
