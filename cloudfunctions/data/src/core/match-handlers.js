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
const { checkSubmitAllowed } = require('../../lib/services/rating-cap.js');
// 学院赛小场确认后，把结果写回大场并推进轮次（单向依赖，无环）
const {
  advanceCollegeAfterLeg,
  collegeLegRevokeBlocker,
  revertCollegeAfterRevoke,
} = require('./college-advance.js');
const {
  canConfirm,
  canRevoke,
  canForfeit,
  canAssignReferee,
  buildMatchRecord,
  buildForfeitPatch,
  buildRefereePatch,
  fillScheduledMatch,
  canRecordScore,
} = require('../../lib/services/match-record.js');
const { canManage } = require('../../lib/services/permission.js');
// 赛制阶段派发：单败排下一轮，循环排下一轮，小组赛在全部小组打完后转去排淘汰阶段
// findDependentMatches：撤销前的自查——签表是「排」出来的，撤不掉已经排下去的下一轮
const {
  planStageMatches,
  buildPlannedDrafts,
  findDependentMatches,
} = require('../../lib/services/format-plan.js');
const { MATCH_STATUS, ROLE, MATCH_COMPETITION, USER_STATUS } = require('../../lib/utils/constants.js');

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
  // 参赛者本人、管理员，或学院负责人代录本学院有人上场的比赛（见 canRecordScore）。
  // 学院负责人的权限以学院为界，不能替别的学院录分。
  const mayRecord = canRecordScore(target, ctx.actorId, {
    role: Number(ctx.role),
    college: (ctx.actor && ctx.actor.college) || '',
    collegeOf: (id) => (dataset.users.find((u) => u._id === id) || {}).college || '',
  });
  if (!mayRecord) {
    return ok({
      ok: false,
      match: null,
      errors: {},
      scoreErrors: [],
      firstError: '只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩',
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
      association: ctx.association,
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

  // 场号在这一步统一排：plan.rounds 里可能同时有 A 组第 2 轮与 B 组第 2 轮，
  // 它们共用一个场地池，逐轮各排一次会让两组都从 1 号场重新数
  const drafts = buildPlannedDrafts(event, plan.rounds);
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
      await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    }
  });
}

/**
 * 录入一场比赛。一律以「待确认」入账。
 *
 * 【录入人为什么由服务端定，而不是收前端传的】
 * 前端在录入单里填谁是「录入人」，等于让提交者自选身份。而「对手确认」
 * 这道闸门正是靠录入人区分「自己」与「对手」：把录入人填成一个不在场上
 * 的编号，recorderSide 就成了 null，确认权随即对场上所有人开放——提交者
 * 于是能给自己的比赛盖章，凭空造出一场胜利并涨分。所以 recorder 一律记
 * 登录者，前端传什么都不看。
 *
 * 【为什么还要查「这一场轮不轮得到我录」】
 * 光锁死 recorder 还不够：不是参赛者的人照样可以拿别人的名字编一场比赛。
 * canRecordScore 要求提交者是场上的人、本学院有人上场的负责人、或管理员
 * （见 match-record.js）。日常约球同样适用——不能替陌生人编一场比赛。
 *
 * @param {Object} payload 见 match-record.buildMatchRecord
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, errors, scoreErrors, firstError}
 */
async function submitMatch(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const dataset = await getDataset(ctx);
  const { id, ...fields } = payload;

  // 抽签生成的比赛已经有主：它带着签位与 eventId，等着有人把比分补上。
  // 若在这里另立一条新记录，签表里那场会永远空着，比分又挂到了另一条上。
  if (id) {
    return submitScheduledMatch(id, fields, { dataset, ctx });
  }

  const result = buildMatchRecord(
    // 录入人按登录者记：前端传的 recorder 不被信任（见上方说明）
    { ...fields, recorder: ctx.actorId },
    {
      // 名单必须与回放名单一致：不在名单里的参赛者会让回放直接抛错，
      // 所以「参赛者是否在名单内」要在录入这一步就校验掉
      members: dataset.users,
      // 时间基准取服务端时钟：前端传的 now 不被信任
      now: ctx.now,
      // 时间下界取赛季锚点。录到锚点之前，中途入会者的定级依据会被整体
      // 重算——一个人的笔误变成全站分数漂移
      minMatchTime: dataset.meta.seasonStart || dataset.meta.firstMatchTime,
    }
  );

  if (!result.ok) {
    return ok({
      ok: false,
      match: null,
      errors: result.errors,
      scoreErrors: result.scoreErrors,
      firstError: result.firstError,
    });
  }

  // 校验通过后再看权限：把「这一场轮不轮得到我录」与「这张单子填得对不对」
  // 分开报，用户被拒时才不会以为是自己某个输入框填错了。
  const mayRecord = canRecordScore(result.record, ctx.actorId, {
    role: Number(ctx.role),
    college: (ctx.actor && ctx.actor.college) || '',
    collegeOf: (memberId) => (dataset.users.find((u) => u._id === memberId) || {}).college || '',
  });
  if (!mayRecord) {
    return ok({
      ok: false,
      match: null,
      errors: {},
      scoreErrors: [],
      firstError: '只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩',
    });
  }

  // 自然键直接当主键：重复提交会撞上同一个 _id，事务里读一下就知道了
  const _id = matchNaturalKey(result.record);

  // 重试必须先于闸门。上一轮若已经把这场写进去了，名额此刻已经算上它，
  // 再拿「名额已满」把这次重试挡回去，用户就会看到「失败」而库里其实有这条
  // ——幂等被破坏，且他多半会换个对手再录一次。事务里那道检查仍然保留：
  // 两次请求挤在一起时，只有事务能兜住。
  const already = await ctx.repo.matches.getById(_id);
  if (already) return ok({ ok: true, match: already, errors: {}, scoreErrors: [], firstError: '' });

  // 防刷分闸门：一对会员本赛季打满上限之后，他们之间的比赛不再让录
  // （见 rating-cap.checkSubmitAllowed）。判据取完整台账——待确认的场次
  // 也占名额，否则连录 15 场等对手逐一确认就把上限绕过去了。
  const gate = checkSubmitAllowed(result.record, dataset.ledger, {
    seasonStart: dataset.meta.resetTime,
    nameOf: dataset.nameOf,
  });
  if (!gate.ok) {
    return ok({ ok: false, match: null, errors: {}, scoreErrors: [], firstError: gate.message });
  }

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
      association: ctx.association,
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
  if (!canConfirm(match, ctx.actorId, { isMock: false, role: ctx.role })) {
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
      association: ctx.association,
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '这场比赛已经处理过了' });

  // 刚打完的若是某一轮的最后一场，把下一轮排出来
  await advanceAfterConfirm(ctx, patched.eventId);

  // 学院赛的小场：把结果写回大场、定出大场胜负，并在本轮打完时排出下一轮。
  // 它没有个人赛的 eventId，上面那条推进会直接返回。
  if (patched.competition === MATCH_COMPETITION.COLLEGE) {
    await advanceCollegeAfterLeg(ctx, patched);
  }

  return ok({ ok: true, match: patched, message: '' });
}

/**
 * 个人赛弃权：参赛者本人自选，或管理员代记（M5-3 / D41、D42）。
 *
 * 【弃权为什么也写成一场「已生效」的比赛】
 * 与学院赛小场弃权（college-handlers.recordForfeit）同一取舍：胜方直接判给
 * 对手、状态直接生效、比分留空，性质由 outcome 表达。于是晋级（单败）、
 * 小组积分（循环 / 小组赛）与排名分三处都不必为弃权再开分支——它们本来
 * 就按「谁赢了这场比赛」算，而这场比赛现在明明白白写着对手赢。
 *
 * 【ELO 为什么不在这里处理】
 * 回放侧 isEloEligibleMatch 已经把 outcome=forfeit 的比赛挡在等级分之外，
 * 不管它是个人赛还是学院赛。这里只要把字段写对，分数自然不动。
 *
 * @param {Object} payload { id, forfeitBy }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, message}
 */
async function forfeitMatch(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const { id } = payload;
  const forfeitBy = String(payload.forfeitBy || '').trim();
  const dataset = await getDataset(ctx);
  const match = findRecord(dataset, id);
  if (!match) return ok({ ok: false, match: null, message: '找不到这场比赛' });

  if (!canForfeit(match, forfeitBy, ctx.actorId, { role: ctx.role })) {
    return ok({ ok: false, match: null, message: '你无权记录这次弃权' });
  }

  const patch = buildForfeitPatch(match, forfeitBy, { actorId: ctx.actorId, now: ctx.now });

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.matches.getById(id);
    // 事务内再核一次状态：并发的「确认」与「弃权」只有一次能落地
    if (!current || current.status !== MATCH_STATUS.PENDING) return null;

    await tx.matches.update(id, patch);
    await bumpSeason(tx, {
      association: ctx.association,
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '这场比赛已经处理过了' });

  // 弃权也算「这一场有了结果」：单败里对手晋级，循环 / 小组赛里记对手一胜
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
  if (!canConfirm(match, ctx.actorId, { isMock: false, role: ctx.role })) {
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
      association: ctx.association,
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
 * 只有管理员能撤——撤销改写的是已生效的账本，而录入者不是可信第三方
 * （他是录分的人自己选的），放开就等于当事人可以单方面抹掉战绩。
 * 录分错了走驳回（rejectMatch），那条路在比分生效之前，不涉及回滚。
 *
 * 【为什么「已经排进下一轮」的就撤不动】
 * 分数撤得回，签表撤不回。确认一场时 advanceAfterConfirm 已经把下一轮落成
 * 真实的比赛记录，而写入侧只给 upsert / patch、没有删除（见 repository.js），
 * 那个 advance 又是「只补不覆盖」。撤下去只会让下一轮顶着一个作废的晋级者
 * 留在台账里，等着被谁录个比分确认掉。所以这里用 findDependentMatches 拦一道，
 * 要求从最后一轮往前撤——先撤决赛，再撤半决赛，签表才始终自洽。
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
  // 分数撤得回，签表撤不回：确认这场时已经把下一轮落成了真实记录，而写入侧
  // 没有删除（见 repository.js），advance 又「只补不覆盖」。放任撤下去，下一轮
  // 会顶着一个作废的晋级者留在台账里，随时可能被人录个比分确认掉。
  // 挡在这里，让管理员从后往前撤（先撤决赛、再撤半决赛）。
  const dependent = findDependentMatches({ match, matches: dataset.ledger });
  if (dependent.length > 0) {
    return ok({
      ok: false,
      match: null,
      message: `这场比赛已经排进了后面的 ${dependent.length} 场，请从最后一轮往前依次撤销`,
    });
  }
  // 学院赛小场的下游在大场那一侧（下一轮大场按胜者落成真实记录），
  // findDependentMatches 只看 matches，够不着，得单独拦一道。
  const collegeBlock = await collegeLegRevokeBlocker(ctx, match);
  if (collegeBlock) return ok({ ok: false, match: null, message: collegeBlock });

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
      association: ctx.association,
      anchorTime: anchorCandidate(dataset, current.matchTime),
      now: ctx.now,
    });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '这场比赛已经作废了' });

  // 学院赛小场：把这一场的结果从大场里收回来（清胜负、必要时退回进行中）。
  // 少了这一步，大场会一直记着已经退回去的那一场胜负——等级分退回了，
  // 大场却还把晋级给了同一个人。
  if (patched.competition === MATCH_COMPETITION.COLLEGE) {
    await revertCollegeAfterRevoke(ctx, patched);
  }

  return ok({ ok: true, match: patched, message: '' });
}

/**
 * 指派 / 改派 / 取消一场比赛的裁判。**仅管理员**（Q3），且比赛尚未生效。
 *
 * 【为什么要 bumpSeason】
 * 这里曾经不 bump，理由是「裁判只影响权限，与回放输入无关」。这个前提是错的：
 * referee 是 matches 文档上的字段，而读它的路径全部走 dataset ——
 * canRecordScore / canConfirm 拿到的 match 来自 dataset.ledger，签表页渲染的
 * 也是 ledger。不 +1 就会出现两种相反的错：
 *   1. 权限收窄不生效：指派裁判后，参赛者仍能录分、能确认；
 *   2. 被指派的裁判本人被拒：他看到的还是「没有裁判」的旧副本。
 * 判据是「改没改 dataset 里的集合」，不是「这次改动与等级分有没有关系」。
 *
 * 【为什么在事务内复查】
 * 与确认 / 撤销同一手法：指派与「确认」并发时，只有一次能落地——否则会
 * 出现「成绩已生效，裁判却是事后补的」。
 *
 * @param {Object} payload { matchId, refereeId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, message}
 */
async function assignMatchReferee(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canManage(ctx.actor, { minRole: ROLE.ADMIN })) {
    return ok({ ok: false, match: null, message: '只有管理员可以指派裁判' });
  }

  const refereeId = String(payload.refereeId || '').trim();
  const dataset = await getDataset(ctx);
  const match = findRecord(dataset, payload.matchId);
  if (!match) return ok({ ok: false, match: null, message: '找不到这场比赛' });
  if (!canAssignReferee(match)) {
    return ok({ ok: false, match: null, message: '这场比赛已生效或已作废，不能再改派裁判' });
  }
  // 裁判必须是一位正常在册的会员（Q3）：待审核的还没转正，已禁用 / 已离校
  // 的不该再执法。空串表示取消裁判，不需要校验。
  if (refereeId) {
    // 在册会员与待审核申请分在两个数组里，一起查才能把「编号填错了」与
    // 「这人还没转正」分开报（与 mock.refereeRejection 同一口径）
    const accounts = [...(dataset.members || []), ...(dataset.applications || [])];
    const referee = accounts.find((user) => user._id === refereeId);
    if (!referee) return ok({ ok: false, match: null, message: '找不到这位会员' });
    if (referee.status !== USER_STATUS.ACTIVE) {
      return ok({ ok: false, match: null, message: '该会员不是正常在册状态，不能担任裁判' });
    }
  }

  const patch = buildRefereePatch(refereeId, { actorId: ctx.actorId, now: ctx.now });

  const updated = await ctx.repo.transaction(async (tx) => {
    const current = await tx.matches.getById(payload.matchId);
    if (!current || !canAssignReferee(current)) return null;
    await tx.matches.update(payload.matchId, patch);
    // 裁判是从 dataset 读的（见上面说明），不 +1 就「指派了看不见」，
    // 且权限收窄不生效
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...current, ...patch };
  });

  if (!updated) {
    return ok({ ok: false, match: null, message: '这场比赛已生效或已作废，不能再改派裁判' });
  }
  return ok({ ok: true, match: updated, message: '' });
}

module.exports = {
  submitMatch,
  confirmMatch,
  rejectMatch,
  revokeMatch,
  forfeitMatch,
  assignMatchReferee,
};
