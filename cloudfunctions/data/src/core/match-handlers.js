/**
 * 比赛写接口：录入 / 确认 / 驳回 / 撤销
 * ============================================================
 * 【统一的四步套路】
 *   1. 查   —— 从台账里找到目标比赛（找不到就报「找不到这场比赛」）
 *   2. 判   —— 用共享的纯函数判定权限与状态（严格生产口径，不放宽）
 *   3. 写   —— 在事务里改状态，并让赛季版本号 +1
 *   4. 回   —— 业务结果包在 ok(data) 里，形状与 mock 一致
 *
 * 【为什么改状态要动版本号】
 * 等级分不落库、由回放现算（见 derive.js）。版本号是缓存的失效凭据，
 * 不改它，下一次读还会命中旧缓存，分数就不动了。
 *
 * 【为什么状态流转不写增量】
 * 撤销一场比赛不是「把当初加的分减回去」，而是把这场比赛从回放输入里
 * 丢掉重算——定级锚点、连胜奖励都依赖完整时间序，增量更新迟早算错。
 * 这里只负责把状态改掉，重算交给下一次 derive。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { getDataset } = require('./derive.js');
const { bumpSeason } = require('./season.js');
const { matchNaturalKey } = require('./idempotency.js');
const {
  canConfirm,
  canRevoke,
  buildMatchRecord,
  fillScheduledMatch,
  isParticipant,
} = require('../../lib/services/match-record.js');
const { buildRoundMatches } = require('../../lib/services/draw.js');
// 赛制阶段派发：单败排下一轮，循环排下一轮，小组赛在全部小组打完后转去排淘汰阶段
const { planStageMatches } = require('../../lib/services/format-plan.js');
const { MATCH_STATUS, ROLE } = require('../../lib/utils/constants.js');

/**
 * 在台账里找一场比赛（含待确认与已撤销）。
 *
 * @param {Object} dataset getDataset 的返回值
 * @param {string} id
 * @returns {Object|null}
 */
function findRecord(dataset, id) {
  return dataset.ledger.find((match) => match._id === id) || null;
}

/**
 * 本次写入应当把赛季锚点钉在哪个时刻。
 *
 * 锚点首次写入后就不再改动（见 season.js），所以候选值必须是「当前已知
 * 的最早一场」，而不是「这次写的那一场」。确认一场五月的比赛时若把锚点
 * 钉到五月，四月入会的人会被重新判定成创始会员，定级分凭空消失——
 * 正是 season-anchor.test.js 钉住的那个回归。
 *
 * @param {Object} dataset
 * @param {Date|string} fallback 一场都还没有时，退回这一场的时间
 * @returns {Date|string}
 */
function anchorCandidate(dataset, fallback) {
  return dataset.meta.seasonStart || fallback;
}

/**
 * 给抽签生成的待确认比赛补录比分。
 *
 * 与「新录一场」不同，这里不吃队伍、赛制、时间——它们已经在记录上。
 * 只有参赛者本人（或管理员代录）能补分；补完仍是待确认，等对手确认
 * 才计入等级分，沿用同一道闸门。
 *
 * @param {string} id 抽签生成的比赛编号
 * @param {Object} scores { scoreA, scoreB }
 * @param {Object} params { dataset, ctx, now }
 * @returns {Promise<Object>}
 */
async function submitScheduledMatch(id, scores, { dataset, ctx, now }) {
  const target = findRecord(dataset, id);
  if (!target) {
    return ok({ ok: false, match: null, errors: {}, scoreErrors: [], firstError: '找不到这场比赛' });
  }
  if (!isParticipant(target, ctx.actorId) && ctx.role !== ROLE.ADMIN) {
    return ok({
      ok: false,
      match: null,
      errors: {},
      scoreErrors: [],
      firstError: '只有参赛者可以录入这场比赛的成绩',
    });
  }

  const filled = fillScheduledMatch(target, scores, {
    members: dataset.users,
    now: now || ctx.now,
    minMatchTime: dataset.meta.seasonStart || dataset.meta.firstMatchTime,
    // 录入人按登录者记，而不是沿用记录上的空值：确认权要靠它区分「自己」与「对手」
    recorder: ctx.actorId,
  });
  if (!filled.ok) {
    return ok({
      ok: false,
      match: null,
      errors: filled.errors,
      scoreErrors: filled.scoreErrors,
      firstError: filled.firstError,
    });
  }

  const match = await ctx.repo.transaction(async (tx) => {
    const current = await tx.matches.getById(id);
    // 事务内再核一次：并发的补录与撤销，只有一侧能落地
    if (!current || current.status !== MATCH_STATUS.PENDING) return null;

    const patch = {
      ...filled.patch,
      status: MATCH_STATUS.PENDING,
      action: 'score',
      actor: ctx.actorId,
      actedAt: ctx.now,
    };
    await tx.matches.update(id, patch);
    await bumpSeason(tx, {
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!match) {
    return ok({ ok: false, match: null, errors: {}, scoreErrors: [], firstError: '只有待确认的比赛可以录分' });
  }
  return ok({ ok: true, match, errors: {}, scoreErrors: [], firstError: '' });
}

/**
 * 一轮打完后排出下一轮（决策 5.2）。
 *
 * 在确认事务提交之后调用，此时赛季版本号已经变过，getDataset 会重放，
 * 读到的是刚确认完的最新台账。生成下一轮时必须「只补不覆盖」：这些
 * 编号是确定的，若像重抽那样 upsert，会把下一轮里已经录好的比分冲掉。
 *
 * 排不出来就静默返回——还没打完、或这轮早排过了，都不是错误。
 *
 * @param {Object} ctx
 * @param {string|undefined} eventId
 */
async function advanceAfterConfirm(ctx, eventId) {
  if (!eventId) return;

  const dataset = await getDataset(ctx);
  const event = (dataset.events || []).find((item) => item._id === eventId);
  if (!event || !event.draw) return;

  const plan = planStageMatches({
    event,
    draw: event.draw,
    matches: dataset.ledger.filter((match) => match.eventId === eventId),
  });
  if (!plan.ok) return;

  const drafts = plan.rounds.reduce(
    (all, roundPlan) => all.concat(buildRoundMatches(event, roundPlan)),
    []
  );
  if (drafts.length === 0) return;

  await ctx.repo.transaction(async (tx) => {
    let inserted = false;
    for (const draft of drafts) {
      const existing = await tx.matches.getById(draft._id);
      if (existing) continue; // 排过的轮次不覆盖，也就不会抹掉已录的比分
      await tx.matches.insert({ ...draft, status: MATCH_STATUS.PENDING, createdAt: ctx.now });
      inserted = true;
    }
    if (inserted) {
      await bumpSeason(tx, { anchorTime: null, now: ctx.now });
    }
  });
}

/**
 * 录入一场比赛。一律以「待确认」入账。
 *
 * @param {Object} payload 见 match-record.buildMatchRecord，另可带 now
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, errors, scoreErrors, firstError}
 */
async function submitMatch(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const dataset = await getDataset(ctx);
  const { now, id, ...fields } = payload;

  // 抽签生成的比赛已经有主：它带着签位与 eventId，等着有人把比分补上。
  // 若在这里另立一条新记录，签表里那场会永远空着，比分又挂到了另一条上。
  if (id) {
    return submitScheduledMatch(id, fields, { dataset, ctx, now });
  }

  const result = buildMatchRecord(fields, {
    // 名单必须与回放名单一致：不在名单里的参赛者会让回放直接抛错，
    // 所以「参赛者是否在名单内」要在录入这一步就校验掉
    members: dataset.users,
    now: now || ctx.now,
    // 时间下界取赛季锚点。录到锚点之前，中途入会者的定级依据会被整体
    // 重算——一个人的笔误变成全站分数漂移
    minMatchTime: dataset.meta.seasonStart || dataset.meta.firstMatchTime,
  });

  if (!result.ok) {
    return ok({
      ok: false,
      match: null,
      errors: result.errors,
      scoreErrors: result.scoreErrors,
      firstError: result.firstError,
    });
  }

  // 自然键直接当主键：重复提交会撞上同一个 _id，事务里读一下就知道了
  const _id = matchNaturalKey(result.record);

  const match = await ctx.repo.transaction(async (tx) => {
    const existing = await tx.matches.getById(_id);
    if (existing) return existing; // 重试：返回上次那条，不重复计分

    const record = {
      ...result.record,
      _id,
      status: MATCH_STATUS.PENDING,
      createdAt: ctx.now,
    };
    await tx.matches.insert(record);
    await bumpSeason(tx, {
      anchorTime: anchorCandidate(dataset, record.matchTime),
      now: ctx.now,
    });
    return record;
  });

  return ok({ ok: true, match, errors: {}, scoreErrors: [], firstError: '' });
}

/**
 * 确认一场待确认的比赛，成绩随即计入等级分。
 *
 * 注意：确认权在云端是「对手方确认」，不是「参与即可」——mock 的放宽
 * 只属于演示口径。
 *
 * @param {Object} payload { id }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, message}
 */
async function confirmMatch(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const { id } = payload;
  const dataset = await getDataset(ctx);
  const match = findRecord(dataset, id);
  if (!match) return ok({ ok: false, match: null, message: '找不到这场比赛' });

  // canConfirm 本身就要求「处于待确认状态」，所以非待确认的比赛
  // 会走到这里被挡下，与 mock 的文案一致
  if (!canConfirm(match, ctx.actorId, { isMock: false })) {
    return ok({ ok: false, match: null, message: '你无权确认这场比赛' });
  }

  // 抽签排出来的比赛天生没有比分，确认前必须有人录过。若放行，回放会
  // 读到一个没有胜方的比赛，整条赛季的等级分都算不出来。
  if (!match.winner) {
    return ok({ ok: false, match: null, message: '这场比赛还没有比分，请先录入成绩' });
  }

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.matches.getById(id);
    // 事务内再核一次状态：并发的两次确认只有一次能落地
    if (!current || current.status !== MATCH_STATUS.PENDING) return null;

    const patch = {
      status: MATCH_STATUS.ACTIVE,
      action: 'confirm',
      actor: ctx.actorId,
      actedAt: ctx.now,
    };
    await tx.matches.update(id, patch);
    await bumpSeason(tx, {
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '这场比赛已经处理过了' });

  // 刚打完的若是某一轮的最后一场，把下一轮排出来
  await advanceAfterConfirm(ctx, patched.eventId);

  return ok({ ok: true, match: patched, message: '' });
}

/**
 * 驳回一场待确认的比赛。驳回后成绩作废。
 * 与「撤销」共用 REVOKED 状态，靠 action 区分，不新增枚举值。
 *
 * @param {Object} payload { id, reason }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, message}
 */
async function rejectMatch(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const { id, reason } = payload;
  const dataset = await getDataset(ctx);
  const match = findRecord(dataset, id);
  if (!match) return ok({ ok: false, match: null, message: '找不到这场比赛' });
  if (match.status !== MATCH_STATUS.PENDING) {
    return ok({ ok: false, match: null, message: '只有待确认的比赛可以驳回' });
  }
  if (!canConfirm(match, ctx.actorId, { isMock: false })) {
    return ok({ ok: false, match: null, message: '你无权驳回这场比赛' });
  }
  if (!String(reason || '').trim()) {
    return ok({ ok: false, match: null, message: '请填写驳回理由' });
  }

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.matches.getById(id);
    if (!current || current.status !== MATCH_STATUS.PENDING) return null;

    const patch = {
      status: MATCH_STATUS.REVOKED,
      action: 'reject',
      reason: String(reason).trim(),
      actor: ctx.actorId,
      actedAt: ctx.now,
    };
    await tx.matches.update(id, patch);
    await bumpSeason(tx, {
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '只有待确认的比赛可以驳回' });
  return ok({ ok: true, match: patched, message: '' });
}

/**
 * 撤销一场比赛，分数随之回滚（回滚方式见本文件头部说明）。
 * 管理员可撤任意一场；其余人只能撤自己录的。
 *
 * @param {Object} payload { id, reason }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, message}
 */
async function revokeMatch(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const { id, reason } = payload;
  const dataset = await getDataset(ctx);
  const match = findRecord(dataset, id);
  if (!match) return ok({ ok: false, match: null, message: '找不到这场比赛' });
  if (match.status === MATCH_STATUS.REVOKED) {
    return ok({ ok: false, match: null, message: '这场比赛已经作废了' });
  }
  // 角色取自服务端查到的账号，不信前端传的 actor
  if (!canRevoke(match, ctx.actorId, { role: ctx.role })) {
    return ok({ ok: false, match: null, message: '你无权撤销这场比赛' });
  }
  if (!String(reason || '').trim()) {
    return ok({ ok: false, match: null, message: '请填写撤销理由' });
  }

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.matches.getById(id);
    if (!current) return null;
    if (current.status === MATCH_STATUS.REVOKED) return null;

    const patch = {
      status: MATCH_STATUS.REVOKED,
      action: 'revoke',
      reason: String(reason).trim(),
      actor: ctx.actorId,
      actedAt: ctx.now,
    };
    await tx.matches.update(id, patch);
    await bumpSeason(tx, {
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '这场比赛已经作废了' });
  return ok({ ok: true, match: patched, message: '' });
}

module.exports = { submitMatch, confirmMatch, rejectMatch, revokeMatch };
