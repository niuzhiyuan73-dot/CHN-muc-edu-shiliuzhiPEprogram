/**
 * 实时比分写接口：开台 / 判球 / 撤销 / 定稿，外加一个批量读
 * ============================================================
 * 与 mock.js 的同名函数一一对应：同样的校验顺序、同样的拒绝文案、
 * 同样的返回形状。页面只认形状，形状一致，切数据源才不用改页面。
 *
 * 【为什么每球不 bumpSeason】
 * 实时态是录分过程的中间态，不是回放的输入。每判一球就让整季缓存失效，
 * 等于每打一球白跑一遍全场重放。只有定稿（finishLiveScore）转成正式比分、
 * 走 submitMatch 时才让赛季版本号 +1，整季才重放一次（§八.5）。
 *
 * 【为什么判球要幂等】
 * 移动网络下断线重发与连点都会把同一球送两次，服务端只看客户端带来的
 * rallyId（见 idempotency.js 同一思路）：编号记过就直接回现状，不重复计分。
 *
 * 【为什么实时态按 _id 逐条读】
 * 一场恒一条（_id = 'ls_' + matchId）。轮询读与写都按编号定位，不做集合
 * 查询——事务里不能整表读，这个约定刚好让读写都能进事务。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { getDataset } = require('./derive.js');
// 定稿把逐球流水转成正式比分后，交给现有的录分链路（单向依赖，无环）
const { submitMatch } = require('./match-handlers.js');
const { canRecordScore } = require('../../lib/services/match-record.js');
const {
  LIVE_STATUS,
  SIDE,
  liveKey,
  createLive,
  applyRally,
  // 与下面的云端写接口撞名，导入时改个前缀
  undoRally: undoLiveRally,
  hasRally,
  liveScoreOf,
  toOfficialScores,
} = require('../../lib/services/live-score.js');
const { MATCH_STATUS } = require('../../lib/utils/constants.js');

/**
 * 在台账里找一场比赛（含待确认与已撤销）。
 * @param {Object} dataset
 * @param {string} id
 * @returns {Object|null}
 */
function findRecord(dataset, id) {
  return dataset.ledger.find((match) => match._id === id) || null;
}

/**
 * 这位操作者能不能给这场比赛计分。
 * 判定与 submitMatch 的录分权一字不差（见 canRecordScore），三处一旦分叉
 * 就会出现「看得见计分台、点下去却被拒」。
 *
 * @param {Object} match
 * @param {Object} ctx
 * @param {Array<Object>} users 用于解析学院（干事代录的边界）
 * @returns {boolean}
 */
function mayRecord(match, ctx, users) {
  return canRecordScore(match, ctx.actorId, {
    role: Number(ctx.role),
    college: (ctx.actor && ctx.actor.college) || '',
    collegeOf: (memberId) => (users.find((u) => u._id === memberId) || {}).college || '',
  });
}

/**
 * 找一场比赛并校验计分权，供四个写接口共用。
 *
 * @param {Object} dataset
 * @param {string} matchId
 * @param {Object} ctx
 * @returns {{match:Object}|{error:string}}
 */
function liveTarget(dataset, matchId, ctx) {
  const match = findRecord(dataset, matchId);
  if (!match) return { error: '找不到这场比赛' };
  // 已生效 / 已作废的比赛不再开实时台：改历史要走撤销，重录要走录分页
  if (match.status !== MATCH_STATUS.PENDING) {
    return { error: '这场比赛已生效或已作废，不能再计分' };
  }
  if (!mayRecord(match, ctx, dataset.users)) return { error: '你无权为这场比赛计分' };
  return { match };
}

/**
 * 开实时计分台。建 / 取实时态；已存在就原样返回（重开不重置比分）。
 *
 * @param {Object} payload { matchId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, live, message}
 */
async function startLiveScore(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const matchId = payload.matchId;
  const dataset = await getDataset(ctx);
  const target = liveTarget(dataset, matchId, ctx);
  if (target.error) return ok({ ok: false, live: null, message: target.error });

  const id = liveKey(matchId);
  const live = await ctx.repo.transaction(async (tx) => {
    // 事务内再核一次：并发的两次开台只会落地一条
    const existing = await tx.liveScores.getById(id);
    if (existing) return existing;

    const state = createLive(target.match, { actorId: ctx.actorId, now: ctx.now });
    await tx.liveScores.insert(state);
    return state;
  });

  return ok({ ok: true, live, message: '' });
}

/**
 * 判一球。
 *
 * @param {Object} payload { matchId, side, rallyId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, live, message}
 */
async function recordRally(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const matchId = payload.matchId;
  const side = payload.side;
  const dataset = await getDataset(ctx);
  const target = liveTarget(dataset, matchId, ctx);
  if (target.error) return ok({ ok: false, live: null, message: target.error });

  const id = liveKey(matchId);
  const rallyId = String(payload.rallyId || '');

  const result = await ctx.repo.transaction(async (tx) => {
    // 事务内重读：并发判球以库里那份为准，避免两个请求都基于旧分各加一
    const current = await tx.liveScores.getById(id);
    if (!current) return { error: '这场比赛还没开实时计分台', live: null };
    if (current.status !== LIVE_STATUS.LIVE) {
      return { error: '比赛已经结束，不能再判球', live: current };
    }
    if (side !== SIDE.A && side !== SIDE.B) {
      return { error: '判球方不合法', live: current };
    }
    // 幂等：同一个 rallyId 重发（断线重试 / 连点）不再计一次
    if (hasRally(current, rallyId)) return { live: current };

    const next = {
      ...applyRally(current, side, { rallyId }),
      updatedBy: ctx.actorId,
      updatedAt: ctx.now,
    };
    await tx.liveScores.update(id, next);
    return { live: next };
  });

  if (result.error) return ok({ ok: false, live: result.live, message: result.error });
  return ok({ ok: true, live: result.live, message: '' });
}

/**
 * 撤销最后一球。若撤的是决定性的那一球，整场退回「进行中」。
 *
 * @param {Object} payload { matchId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, live, message}
 */
async function undoRally(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const matchId = payload.matchId;
  const dataset = await getDataset(ctx);
  const target = liveTarget(dataset, matchId, ctx);
  if (target.error) return ok({ ok: false, live: null, message: target.error });

  const id = liveKey(matchId);
  const result = await ctx.repo.transaction(async (tx) => {
    const current = await tx.liveScores.getById(id);
    if (!current) return { error: '这场比赛还没开实时计分台', live: null };
    if (!current.rallies || current.rallies.length === 0) {
      return { error: '没有可撤销的判球', live: current };
    }

    const next = {
      ...undoLiveRally(current),
      updatedBy: ctx.actorId,
      updatedAt: ctx.now,
    };
    await tx.liveScores.update(id, next);
    return { live: next };
  });

  if (result.error) return ok({ ok: false, live: result.live, message: result.error });
  return ok({ ok: true, live: result.live, message: '' });
}

/**
 * 定稿：把逐球流水转成正式比分，回到现有的录分链路。
 *
 * 定稿只把「打完的局」交出去（见 live-score.toOfficialScores），得到的
 * 仍是一条**待确认**的比赛——确认权照旧落在裁判 / 管理员手上，实时比分
 * 不新开一条计分链路。submitMatch 会让赛季版本号 +1，整季重放一次。
 *
 * @param {Object} payload { matchId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, live, match, message}
 */
async function finishLiveScore(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const matchId = payload.matchId;
  const dataset = await getDataset(ctx);
  const target = liveTarget(dataset, matchId, ctx);
  if (target.error) return ok({ ok: false, live: null, match: null, message: target.error });

  const id = liveKey(matchId);
  const current = await ctx.repo.liveScores.getById(id);
  if (!current) {
    return ok({ ok: false, live: null, match: null, message: '这场比赛还没开实时计分台' });
  }
  // 只有分出胜负才能定稿：半局比分（比如 5:2）不是一场合法比赛
  if (current.status !== LIVE_STATUS.FINISHED) {
    return ok({ ok: false, live: current, match: null, message: '比赛还没打完，不能定稿' });
  }

  const { scoreA, scoreB } = toOfficialScores(current);
  if (scoreA.length === 0) {
    return ok({ ok: false, live: current, match: null, message: '还没有可提交的比分' });
  }

  // 复用现有链路：它负责校验、写回比分、把状态留在待确认并 bumpSeason
  const submitted = await submitMatch({ id: matchId, scoreA, scoreB }, ctx);
  const body = submitted && submitted.data;
  if (!body || !body.ok) {
    return ok({
      ok: false,
      live: current,
      match: null,
      message: (body && body.firstError) || '提交失败',
    });
  }

  // 实时态留在台账里（status=finished），查看端据此显示终局；
  // 正式比分已经写进 matches，回放与积分都由那条走。
  const done = { ...current, updatedBy: ctx.actorId, updatedAt: ctx.now };
  await ctx.repo.liveScores.update(id, done);
  return ok({ ok: true, live: done, match: body.match, message: '' });
}

/**
 * 批量取实时比分，供查看端轮询。只返回比分相关字段，尽量小。
 * matchIds 为空直接返回空数组——没开赛就不该产生任何读取。
 *
 * @param {Object} payload { matchIds }
 * @param {Object} ctx
 * @returns {Promise<Object>} 实时视图数组
 */
async function getLiveScores(payload = {}, ctx) {
  const ids = Array.isArray(payload.matchIds) ? payload.matchIds : [];
  if (ids.length === 0) return ok([]);

  const out = [];
  for (const matchId of ids) {
    const state = await ctx.repo.liveScores.getById(liveKey(matchId));
    if (state) out.push(liveScoreOf(state));
  }
  return ok(out);
}

module.exports = {
  startLiveScore,
  recordRally,
  undoRally,
  finishLiveScore,
  getLiveScores,
};
