/**
 * 赛事写/读接口：发布 / 开始 / 报名 / 退赛 / 签到 / 录入名次
 * ============================================================
 * 与 match-handlers / announcement-handlers 同一纪律：权限在服务端按
 * OpenID 判定，前端传的 actor 一概不信；业务失败包在 ok({ok:false,…})
 * 里正常返回，只有基础设施故障才走顶层 fail（见 envelope.js）。
 *
 * 【为什么只有赛事文档的改动才让缓存失效】
 * 回放缓存（derive.getDataset）里存的是「比赛 + 赛事 + 公告」。赛事本身
 * 变了（发布 / 开始 / 结束、名次落定）必须让缓存失效，否则 getEvents
 * 会一直返回旧的那份，页面上「进行中」永远停在「报名中」。
 * 而报名记录不在回放输入里——它只经 getEventSignups 直接读库，
 * 所以报名、退赛、签到都不必触发一次全场重放。这不是偷懒：一场赛事
 * 几百人签到，若每次签到都重算全部等级分，云函数的计费会很可观。
 *
 * 【报名为什么要读两次库再进事务】
 * 微信云开发的事务里不能做集合查询，而「名额满没满」需要看这场赛事
 * 已有的报名数。于是先在事务外把赛事与报名读齐、判完，再在事务里按
 * 自然键写入。名额判定的竞态（两人同时抢最后一个位）留给自然键兜底：
 * 至多多收一两个人，不会产生重复记录——这是刻意的取舍，见 README。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { bumpSeason } = require('./season.js');
const { getDataset } = require('./derive.js');
const { eventNaturalKey, signupNaturalKey } = require('./idempotency.js');
const { belongsToAssociation } = require('../../lib/utils/associations.js');
const {
  canManageEvent,
  canStartEvent,
  startBlockedReason,
  canCheckIn,
  canFinishEvent,
  canDrawEvent,
  canSignUp,
  canCancelSignup,
  buildEventRecord,
  buildSignupRecord,
  buildCheckInPatch,
  validatePlacements,
} = require('../../lib/services/event.js');
const {
  planDraw,
  buildDrawRecord,
  drawnEntryCount,
  canRedraw,
} = require('../../lib/services/draw.js');
// 首轮（或循环赛第一轮）由赛制决定：单败摆签表，分组摆各组第一轮
const { buildInitialMatches } = require('../../lib/services/format-plan.js');
const { EVENT_STATUS, SIGNUP_STATUS, MATCH_STATUS } = require('../../lib/utils/constants.js');

/**
 * 取一场本协会的赛事。
 *
 * 【为什么直接 getById 的读也要挡】
 * 事务外按编号取赛事走的是集合直读，不像 getDataset 那样已经按协会筛过。
 * 若不判归属，A 协会的人拿着 B 协会的赛事编号一样能开赛、抽签、录名次。
 * 「查无此赛事」与真的不存在表现一致，不泄露别家协会的存在。
 *
 * @param {Object} ctx
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function eventInScope(ctx, id) {
  const event = await ctx.repo.events.getById(id);
  return belongsToAssociation(event, ctx.association) ? event : null;
}

/* ============================================================
 * 读接口
 * ============================================================ */

/**
 * 报名记录。给出 eventId 就只取那一场的，否则取全部——
 * 赛事列表页要一次把每场的人数与「我报没报」都算出来。
 *
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 * @returns {Promise<Object>} 报名记录数组
 */
async function getEventSignups(payload = {}, ctx) {
  const { eventId } = payload;
  const rows = eventId
    ? await ctx.repo.eventSignups.listByEvent(eventId)
    : await ctx.repo.eventSignups.list();
  // 报名记录直读集合，不像 getDataset 那样已按协会筛过——这里补齐这道过滤，
  // 否则带上别家协会的赛事编号就能把对方的报名名单整个读走
  return ok(rows.filter((row) => belongsToAssociation(row, ctx.association)));
}

/* ============================================================
 * 写接口
 * ============================================================ */

/**
 * 发布一场赛事。落库即「报名中」。
 *
 * 等级与三四名赛方式都必须是用户确认过的值（见 event.validateEvent）——
 * 这两项直接决定积分怎么算，留空取默等于悄悄改分。
 *
 * @param {Object} payload { form }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, errors, firstError}
 */
async function publishEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canManageEvent(ctx.actor, { isMock: false })) {
    return ok({
      ok: false,
      record: null,
      errors: {},
      firstError: '当前账号没有发布赛事的权限',
    });
  }

  const built = buildEventRecord(payload.form, { actor: ctx.actor, now: ctx.now });
  if (!built.ok) {
    return ok({ ok: false, record: null, errors: built.errors, firstError: built.firstError });
  }

  // 盖章协会：写进文档供读路径过滤，同时并入自然键——同样的赛事内容
  // 在两个协会发出来就是两场，不会互相顶掉
  built.record.association = ctx.association;

  // 自然键当 _id：弱网重试不会发出两场一模一样的赛事
  const _id = eventNaturalKey(built.record);

  const record = await ctx.repo.transaction(async (tx) => {
    const existing = await tx.events.getById(_id);
    if (existing) return existing;

    const doc = { ...built.record, _id, status: EVENT_STATUS.SIGNUP };
    await tx.events.insert(doc);
    // 赛事进了回放输入，缓存必须失效，否则列表页看不到刚发的这场
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return doc;
  });

  return ok({ ok: true, record, errors: {}, firstError: '' });
}

/**
 * 开始一场赛事（报名中 → 进行中）。之后才能签到与录入名次。
 *
 * @param {Object} payload { id }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function startEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场赛事' });

  if (!canStartEvent(event, ctx.actor, { isMock: false })) {
    // 状态先判：已经开始了还说「没有权限」会让人以为是自己账号的问题
    if (event.status !== EVENT_STATUS.SIGNUP) {
      return ok({ ok: false, record: null, message: '这场赛事已经开始了' });
    }
    return ok({ ok: false, record: null, message: '当前账号没有管理赛事的权限' });
  }

  // 单打不抽签就没有任何一场比赛可打，且开赛后抽签入口会关闭，
  // 整场赛事会卡死。拦住并说清该做什么。
  const blocked = startBlockedReason(event);
  if (blocked) return ok({ ok: false, record: null, message: blocked });

  const patch = { status: EVENT_STATUS.ONGOING, actor: ctx.actorId, actedAt: ctx.now };
  const record = await ctx.repo.transaction(async (tx) => {
    // 事务内复查状态：两个并发的开赛请求只有一个能落地，另一个看到已经开始
    // 就退出，避免重复 bumpSeason。
    const fresh = await tx.events.getById(payload.id);
    if (!fresh || fresh.status !== EVENT_STATUS.SIGNUP) return null;
    await tx.events.update(payload.id, patch);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...fresh, ...patch };
  });

  if (!record) return ok({ ok: false, record: null, message: '这场赛事已经开始了' });
  return ok({ ok: true, record, message: '' });
}

/**
 * 置顶 / 取消置顶一场赛事。**仅管理员**，与发布同一门槛。
 *
 * 与赛事进行到哪一步无关，因此不判状态机；改的是赛事文档本身，要随
 * bumpSeason 让回放缓存失效，否则 getEvents 会一直返回置顶前的旧记录。
 *
 * @param {Object} payload { id, pinned }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function setEventPinned(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场赛事' });

  if (!canManageEvent(ctx.actor, { isMock: false })) {
    return ok({ ok: false, record: null, message: '当前账号没有管理赛事的权限' });
  }

  const patch = { pinned: Boolean(payload.pinned), actor: ctx.actorId, actedAt: ctx.now };
  const record = await ctx.repo.transaction(async (tx) => {
    await tx.events.update(payload.id, patch);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...event, ...patch };
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 报名一场赛事。报名人就是调用者本人——不接受 payload 里的 userId，
 * 否则谁都能替别人报名。
 *
 * @param {Object} payload { id }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function signUpEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场赛事' });

  const signups = await ctx.repo.eventSignups.listByEvent(payload.id);
  const signup = signups.find((item) => item.userId === ctx.actorId) || null;

  // 名次页要的报名状态是「有一条有效报名」，canSignUp 已把离校与名额一并算过
  if (!canSignUp(event, ctx.actor, { signup, signups })) {
    return ok({ ok: false, record: null, message: signUpRefusal(event, signup) });
  }

  const built = buildSignupRecord(event, ctx.actor, { now: ctx.now });
  if (!built.ok) return ok({ ok: false, record: null, message: built.message });

  const _id = signupNaturalKey(payload.id, ctx.actorId);
  const result = await ctx.repo.transaction(async (tx) => {
    const fresh = await tx.events.getById(payload.id);
    const existing = await tx.eventSignups.getById(_id);
    if (!belongsToAssociation(fresh, ctx.association)) return { message: '找不到这场赛事' };
    // 旧赛事首次写入时从报名表初始化；后续以事务内赛事计数为准。
    const count = Number.isInteger(fresh.signupCount)
      ? fresh.signupCount
      : signups.filter((item) => item.status !== SIGNUP_STATUS.CANCELED).length;
    if (!canSignUp({ ...fresh, quota: 0 }, ctx.actor, { signup: existing })) {
      return { message: signUpRefusal(fresh, existing) };
    }
    if (Number(fresh.quota) > 0 && count >= Number(fresh.quota)) {
      return { message: '报名名额已满' };
    }
    const builtFresh = buildSignupRecord(fresh, ctx.actor, { now: ctx.now });
    if (!builtFresh.ok) return { message: builtFresh.message };
    await tx.events.update(payload.id, {
      signupCount: count + 1,
      signupRevision: Number(fresh.signupRevision || 0) + 1,
    });
    if (existing) {
      // 取消过的人重新报名：翻回同一条记录，报名时间刷新为这一次
      await tx.eventSignups.update(_id, {
        status: SIGNUP_STATUS.SIGNED,
        signTime: ctx.now,
        checkInTime: null,
        actorId: ctx.actorId,
      });
      return { record: { ...existing, status: SIGNUP_STATUS.SIGNED, signTime: ctx.now, checkInTime: null } };
    }
    const doc = { ...builtFresh.record, _id, association: ctx.association };
    await tx.eventSignups.insert(doc);
    return { record: doc };
  });

  // 报名不影响等级分，无需让回放缓存失效（见文件头说明）
  return ok({ ok: Boolean(result.record), record: result.record || null, message: result.message || '' });
}

/**
 * 报名被拒时，给一句说得清的文案。
 * @param {Object} event
 * @param {Object|null} signup
 * @returns {string}
 */
function signUpRefusal(event, signup) {
  if (event.status !== EVENT_STATUS.SIGNUP) return '报名已经截止了';
  // 抽签后的冻结要单独说：此时赛事仍在「报名中」，笼统说「状态不能报名」
  // 会让人以为是自己账号的问题
  if (event.draw) return '抽签后报名已锁定，如需变更请联系管理员重抽';
  if (signup && signup.status === SIGNUP_STATUS.CHECKED_IN) return '你已经签过到了';
  if (signup && signup.status === SIGNUP_STATUS.SIGNED) return '你已经报过名了';
  return '当前状态不能报名这场赛事';
}

/**
 * 取消报名。不删记录，只把状态置为「已取消」——报了多少人、退了多少人
 * 都要留痕，重新报名也落回同一条（见 idempotency.signupNaturalKey）。
 *
 * @param {Object} payload { id }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function cancelSignupEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场赛事' });

  const _id = signupNaturalKey(payload.id, ctx.actorId);
  const signup = await ctx.repo.eventSignups.getById(_id);
  if (!signup) return ok({ ok: false, record: null, message: '你还没有报名这场赛事' });

  if (!canCancelSignup(event, ctx.actor, { signup })) {
    return ok({ ok: false, record: null, message: '现在不能取消报名' });
  }

  const patch = { status: SIGNUP_STATUS.CANCELED, actorId: ctx.actorId, actedAt: ctx.now };
  const signups = await ctx.repo.eventSignups.listByEvent(payload.id);
  const record = await ctx.repo.transaction(async (tx) => {
    const fresh = await tx.events.getById(payload.id);
    const current = await tx.eventSignups.getById(_id);
    if (!belongsToAssociation(fresh, ctx.association) || !canCancelSignup(fresh, ctx.actor, { signup: current })) return null;
    const count = Number.isInteger(fresh.signupCount)
      ? fresh.signupCount
      : signups.filter((item) => item.status !== SIGNUP_STATUS.CANCELED).length;
    await tx.eventSignups.update(_id, patch);
    await tx.events.update(payload.id, {
      signupCount: Math.max(0, count - 1),
      signupRevision: Number(fresh.signupRevision || 0) + 1,
    });
    return { ...current, ...patch };
  });

  if (!record) return ok({ ok: false, record: null, message: '现在不能取消报名' });
  return ok({ ok: true, record, message: '' });
}

/**
 * 代某位会员签到。只有学院负责人以上能签（决策 4：不做自助签到）。
 *
 * @param {Object} payload { id, userId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function checkInEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场赛事' });

  const userId = payload.userId;
  if (!userId) return ok({ ok: false, record: null, message: '请指定要签到的会员' });

  // 学院负责人只能签本学院的人；管理员通行（见 event.canCheckIn）
  const target = await ctx.repo.users.getById(userId);
  if (!canCheckIn(event, ctx.actor, { isMock: false, target: target || {} })) {
    return ok({ ok: false, record: null, message: '当前账号不能为会员签到' });
  }

  const _id = signupNaturalKey(payload.id, userId);
  const signup = await ctx.repo.eventSignups.getById(_id);

  const built = buildCheckInPatch(signup, ctx.actor, { now: ctx.now });
  if (!built.ok) return ok({ ok: false, record: null, message: built.message });

  const record = await ctx.repo.transaction(async (tx) => {
    const fresh = await tx.events.getById(payload.id);
    const current = await tx.eventSignups.getById(_id);
    if (!fresh || !canCheckIn(fresh, ctx.actor, { isMock: false, target: target || {} })) return null;
    const checked = buildCheckInPatch(current, ctx.actor, { now: ctx.now });
    if (!checked.ok) return null;
    await tx.eventSignups.update(_id, checked.patch);
    return { ...current, ...checked.patch };
  });

  if (!record) return ok({ ok: false, record: null, message: '报名状态已变化，请刷新后重试' });
  return ok({ ok: true, record, message: '' });
}

/**
 * 录入名次并结束赛事。这是全赛事闭环里唯一会改动积分的动作。
 *
 * 【为什么要校验「名次对应的人都报过名」】
 * 名次直接换成积分，一个错字的 userId 就会凭空多出一位参赛者，还带着
 * 名次分。所以只接受这场比赛里有效报名的人；没报名的人拿不到名次。
 * 三四名赛的成对规则由 validatePlacements 判定（见 event.js）。
 *
 * @param {Object} payload { id, results }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, errors, firstError}
 */
async function finishEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) {
    return ok({ ok: false, record: null, errors: {}, firstError: '找不到这场赛事' });
  }

  if (!canFinishEvent(event, ctx.actor, { isMock: false })) {
    const firstError =
      event.status !== EVENT_STATUS.ONGOING ? '只有进行中的赛事可以录入名次' : '当前账号没有管理赛事的权限';
    return ok({ ok: false, record: null, errors: {}, firstError });
  }

  const signups = await ctx.repo.eventSignups.listByEvent(payload.id);
  const validUsers = new Set(
    signups.filter((item) => item.status !== SIGNUP_STATUS.CANCELED).map((item) => item.userId)
  );

  // 以签表人数为准判「打不打得出三四名赛」；没抽签时退回报名人数
  const entryCount = drawnEntryCount(event.draw) || validUsers.size;
  // 循环 / 小组赛走「阶梯」口径：名次列为 1..N，不再受三四名成对规则约束
  const checked = validatePlacements(payload.results, {
    bronzeMode: event.bronzeMode,
    entryCount,
    format: event.format,
    // 名次单位随项目变：单打一位 1 人，双打一位 2 人（两人名次相同）
    matchType: event.matchType,
  });
  if (!checked.ok) {
    return ok({ ok: false, record: null, errors: checked.errors, firstError: checked.firstError });
  }

  const stranger = checked.results.find((row) => !validUsers.has(row.userId));
  if (stranger) {
    const firstError = '名次里出现了没有报名这场赛事的会员';
    return ok({ ok: false, record: null, errors: { results: firstError }, firstError });
  }

  const patch = {
    status: EVENT_STATUS.FINISHED,
    results: checked.results,
    actor: ctx.actorId,
    finishedAt: ctx.now,
  };
  const record = await ctx.repo.transaction(async (tx) => {
    // 事务内复查状态：两个并发结束（各带一份名次）只有一个能落地，另一个
    // 看到已结束就退出，避免后写者的 results 静默覆盖前者的名次。
    const fresh = await tx.events.getById(payload.id);
    if (!fresh || fresh.status !== EVENT_STATUS.ONGOING) return null;
    await tx.events.update(payload.id, patch);
    // 名次落定就要重算积分，缓存必须失效
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...fresh, ...patch };
  });

  if (!record) {
    return ok({ ok: false, record: null, errors: {}, firstError: '只有进行中的赛事可以录入名次' });
  }
  return ok({ ok: true, record, errors: {}, firstError: '' });
}

/**
 * 抽签（含重抽）：把签表落进赛事文档，并按签表生成首轮比赛。
 *
 * 【为什么一次读写要分「事务外算、事务内写」】
 * 事务里不能做集合查询，而抽签要读报名记录、会员名单与既有比赛三份数据
 * （分别算参赛者、排种子、判能否重抽）。所以全部在事务外读齐算好，事务
 * 里只做按确定性编号的写入。签表的算法本身是纯函数，见 services/draw.js。
 *
 * 【为什么用确定性编号 upsert 而不是先删后插】
 * 重抽时新首轮与旧首轮占据同一批签位。按编号覆盖，抽多少次都只有一批
 * 比赛；若改成先删后插，中途失败会留下「删了还没插」的空签表。
 *
 * @param {Object} payload { id, seedValue?, manualOrder? }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, draw, matches, message}
 */
async function drawEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await eventInScope(ctx, payload.id);
  if (!event) {
    return ok({ ok: false, record: null, draw: null, matches: [], message: '找不到这场赛事' });
  }

  if (!canDrawEvent(event, ctx.actor, { isMock: false })) {
    // 逐条说清是哪一样不满足，别把「已经开赛」混进「没有权限」。
    // 单打双打都可抽签，双打由抽签把报名的个人编成队伍（见 services/draw.js）
    if (event.status !== EVENT_STATUS.SIGNUP) {
      return ok({ ok: false, record: null, draw: null, matches: [], message: '只能在报名阶段抽签' });
    }
    return ok({ ok: false, record: null, draw: null, matches: [], message: '当前账号没有抽签的权限' });
  }

  const signups = await ctx.repo.eventSignups.listByEvent(payload.id);
  const { members } = await getDataset(ctx);

  // 重抽前置：已有比赛被确认生效过就禁止重抽（决策 9.5）。
  // 集合查询不能进事务，所以在这里先把该赛事的比赛读齐。按赛事条件取，
  // 不必把整张比赛流水翻一遍再筛——上面 getDataset 已经全表读过一次了。
  const existing = await ctx.repo.matches.listByEvent(payload.id);
  if (event.draw && !canRedraw(existing)) {
    return ok({
      ok: false,
      record: null,
      draw: null,
      matches: [],
      message: '该赛事已有比赛确认生效，不能再重抽',
    });
  }

  // 随机种子值没传就取当前时刻。它是可复核的唯一凭据：落库后任何人拿
  // 同一个值重跑一遍，都能得到同一张签表（决策 4.4）
  const seedValue =
    payload.seedValue === undefined || payload.seedValue === null
      ? ctx.now.getTime()
      : Number(payload.seedValue);

  const plan = planDraw({
    event,
    signups,
    members,
    seedValue,
    manualOrder: payload.manualOrder,
  });
  if (!plan.ok) {
    return ok({ ok: false, record: null, draw: null, matches: [], message: plan.message });
  }

  const draw = buildDrawRecord(plan, {
    drawnAt: ctx.now,
    drawnBy: ctx.actorId,
    // 第几次抽签：历史参数与操作人都在这里累加，便于追溯
    drawCount: (event.draw && event.draw.drawCount ? event.draw.drawCount : 0) + 1,
  });
  const drafts = buildInitialMatches(event, draw);

  const written = await ctx.repo.transaction(async (tx) => {
    const fresh = await tx.events.getById(payload.id);
    if (!fresh || !canDrawEvent(fresh, ctx.actor, { isMock: false }) ||
        Number(fresh.signupRevision || 0) !== Number(event.signupRevision || 0)) return null;
    await tx.events.update(payload.id, { draw });

    const docs = [];
    for (const draft of drafts) {
      const doc = {
        ...draft,
        status: MATCH_STATUS.PENDING,
        createdAt: ctx.now,
        association: ctx.association,
      };
      const found = await tx.matches.getById(draft._id);
      if (found) await tx.matches.update(draft._id, doc);
      else await tx.matches.insert(doc);
      docs.push(doc);
    }

    // 签表与首轮比赛都进了回放输入（getEvents / getMatches 读的是缓存），
    // 不失效缓存，页面上就看不到刚抽的签
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { record: { ...event, draw }, docs };
  });

  if (!written) return ok({ ok: false, record: null, draw: null, matches: [], message: '赛事或报名名单已变化，请刷新后重新抽签' });
  return ok({ ok: true, record: written.record, draw, matches: written.docs, message: '' });
}

module.exports = {
  getEventSignups,
  publishEvent,
  startEvent,
  setEventPinned,
  drawEvent,
  signUpEvent,
  cancelSignupEvent,
  checkInEvent,
  finishEvent,
};
