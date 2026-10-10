/**
 * 学院赛读/写接口：发布 / 收名单 / 审核名单
 * ============================================================
 * 与 event-handlers 同一纪律：权限在服务端按 OpenID 判定，前端传的 actor
 * 一概不信；业务失败包在 ok({ok:false,…}) 里正常返回，只有基础设施故障
 * 才走顶层 fail（见 envelope.js）。
 *
 * 【学院赛哪些写操作要 bumpSeason】
 * 判据不是「是不是学院赛」，而是「改动的集合进没进 getDataset」。回放输入是
 * 「比赛 + 个人赛 + 公告」，所以：
 *   - college_events / college_entries / college_ties：不在 getDataset 里，
 *     发布、交名单、审名单、开大场、记弃权都不必失效缓存；
 *   - **matches**：学院赛小场就存在这个集合里（startTie 生成），它既是回放
 *     输入，也是 getMatchRecords / findRecord 的唯一来源。凡写它就必须 +1，
 *     否则紧接着的「录分 / 开台计分」会在旧快照里找不到刚生成的场次。
 * 判据看「写了哪个集合」，别看「属于哪条业务线」——这条区分曾经漏过，
 * 后果是学院赛开台后录分直接报「找不到这场比赛」。
 *
 * 【名单为什么用「赛事 + 学院」当自然键】
 * 同一赛事同一学院只该有一份有效名单（D10）。把这两者压成 _id，重交时
 * 撞上同一条文档即可覆盖，不需要事务里做集合查询找旧记录——与报名的
 * signupNaturalKey 是同一取舍。学院赛名单可以改后重交，所以是 upsert
 * 而不是「已存在就返回旧的」。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { getDataset } = require('./derive.js');
const { bumpSeason } = require('./season.js');
const {
  collegeEventNaturalKey,
  collegeEntryNaturalKey,
  collegeLineupNaturalKey,
} = require('./idempotency.js');
const {
  canManageCollegeEvent,
  buildCollegeEventRecord,
  validateCollegePlacements,
} = require('../../lib/services/college-event.js');
const {
  buildCollegeEntryRecord,
  validateEntryReview,
} = require('../../lib/services/college-entry.js');
const {
  planCollegeDraw,
  buildCollegeDrawRecord,
} = require('../../lib/services/college-draw.js');
const {
  firstRoundPairsOf,
  buildTiesForRound,
  buildLegMatchDrafts,
  canStartCollegeEvent,
  canStartTie,
  canAssignTieReferee,
  legMatchIdsOf,
} = require('../../lib/services/college-tie.js');
const {
  canAssignReferee,
  buildRefereePatch,
} = require('../../lib/services/match-record.js');
const { advanceCollegeAfterLeg } = require('./college-advance.js');
const { buildLineupRecord } = require('../../lib/services/college-lineup.js');
const { REVIEW_ACTION } = require('../../lib/services/member-review.js');
const { belongsToAssociation } = require('../../lib/utils/associations.js');
const {
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  TIE_STATUS,
  MATCH_STATUS,
  MATCH_OUTCOME,
  TEAM,
  USER_STATUS,
} = require('../../lib/utils/constants.js');

/* ============================================================
 * 协会归属守卫
 * ============================================================
 * 学院赛体系的集合（college_events / college_entries / college_ties /
 * college_lineups）不走 getDataset，读的是集合直取。按编号直取前必须
 * 判归属，否则带着别家协会的编号一样能开赛、审名单、开大场。
 * 「查无此物」与「不属于本协会」表现一致，不泄露别家协会的存在。
 */

async function collegeEventInScope(ctx, id) {
  const event = await ctx.repo.collegeEvents.getById(id);
  return belongsToAssociation(event, ctx.association) ? event : null;
}

async function tieInScope(ctx, id) {
  const tie = await ctx.repo.ties.getById(id);
  return belongsToAssociation(tie, ctx.association) ? tie : null;
}

/* ============================================================
 * 读接口
 * ============================================================ */

/**
 * 学院赛列表。与 getEvents 分开：两套体系互不干扰（D1）。
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<Object>} 学院赛数组
 */
async function getCollegeEvents(payload = {}, ctx) {
  const rows = await ctx.repo.collegeEvents.list();
  return ok(rows.filter((row) => belongsToAssociation(row, ctx.association)));
}

/**
 * 单场学院赛。
 * @param {Object} payload { id }
 * @param {Object} ctx
 * @returns {Promise<Object>} 学院赛或 null
 */
async function getCollegeEvent(payload = {}, ctx) {
  return ok(await collegeEventInScope(ctx, payload.id));
}

/**
 * 某场学院赛的名单（含待审核 / 已通过 / 已退回）。缺省取全部。
 *
 * 【为什么不走 getDataset】
 * 名单不参与回放，直接读集合即可；与 getEventSignups 同一处理。
 *
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 * @returns {Promise<Object>} 名单数组
 */
async function getCollegeEntries(payload = {}, ctx) {
  const { eventId } = payload;
  const rows = eventId
    ? await ctx.repo.collegeEntries.listByEvent(eventId)
    : await ctx.repo.collegeEntries.list();
  return ok(rows.filter((row) => belongsToAssociation(row, ctx.association)));
}

/**
 * 某场学院赛的大场列表。缺省取全部。大场同样不参与回放，直接读集合。
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 * @returns {Promise<Object>} 大场数组
 */
async function getCollegeTies(payload = {}, ctx) {
  const { eventId } = payload;
  const rows = eventId
    ? await ctx.repo.ties.listByEvent(eventId)
    : await ctx.repo.ties.list();
  return ok(rows.filter((row) => belongsToAssociation(row, ctx.association)));
}

/**
 * 某场学院赛的排阵列表。缺省取全部。
 *
 * 【为什么按赛事整批取，而不是按大场取】
 * 「自动沿用上次排阵」要能看到本学院在其它大场交过什么，只有整场拉全才
 * 找得到「上一次」。一场学院赛的排阵数等于大场数 × 2，量很小。
 *
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 * @returns {Promise<Object>} 排阵数组
 */
async function getCollegeLineups(payload = {}, ctx) {
  const { eventId } = payload;
  const rows = eventId
    ? await ctx.repo.lineups.listByEvent(eventId)
    : await ctx.repo.lineups.list();
  return ok(rows.filter((row) => belongsToAssociation(row, ctx.association)));
}

/* ============================================================
 * 写接口
 * ============================================================ */

/**
 * 发布一场学院赛。落库即「报名中」。
 *
 * 发布权仅管理员（见 college-event.canManageCollegeEvent）——学院赛要定
 * 小项序列、人数上下限、胜负算法，这些是整场赛事的规则，定错所有学院跟着重来。
 *
 * @param {Object} payload { form }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, errors, firstError}
 */
async function publishCollegeEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canManageCollegeEvent(ctx.actor, { isMock: false })) {
    return ok({
      ok: false,
      record: null,
      errors: {},
      firstError: '当前账号没有发布学院赛的权限',
    });
  }

  const built = buildCollegeEventRecord(payload.form, { actor: ctx.actor, now: ctx.now });
  if (!built.ok) {
    return ok({ ok: false, record: null, errors: built.errors, firstError: built.firstError });
  }

  // 盖章协会：写进文档供读路径过滤，同时并入自然键——同样的学院赛内容
  // 在两个协会发出来就是两场，不会互相顶掉
  built.record.association = ctx.association;

  // 自然键当 _id：弱网重试不会发出两场一模一样的学院赛
  const _id = collegeEventNaturalKey(built.record);

  const record = await ctx.repo.transaction(async (tx) => {
    const existing = await tx.collegeEvents.getById(_id);
    if (existing) return existing;

    const doc = { ...built.record, _id, status: COLLEGE_EVENT_STATUS.SIGNUP };
    await tx.collegeEvents.insert(doc);
    return doc;
  });

  return ok({ ok: true, record, errors: {}, firstError: '' });
}

/**
 * 提交本学院的参赛名单。**学院负责人（本学院）+ 管理员**，且仅在报名中。
 *
 * 队员身份一律用会员台账回查（不信任 payload 里的 college 与成员身份），
 * 与 accountOf 同一思路。同一赛事同一学院只有一份名单，重交覆盖旧的。
 *
 * @param {Object} payload { eventId, college, memberIds, remark }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function submitCollegeEntry(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await collegeEventInScope(ctx, payload.eventId);
  const { members } = await getDataset(ctx);

  const built = buildCollegeEntryRecord(payload, {
    event,
    actor: ctx.actor,
    members,
    now: ctx.now,
  });
  if (!built.ok) {
    return ok({ ok: false, record: null, message: built.message });
  }

  const _id = collegeEntryNaturalKey(built.record.eventId, built.record.college);

  const record = await ctx.repo.transaction(async (tx) => {
    const doc = { ...built.record, _id, association: ctx.association };
    const existing = await tx.collegeEntries.getById(_id);
    // 重交覆盖同一条：不保留上一版，避免事务里做集合查询找旧记录
    if (existing) await tx.collegeEntries.update(_id, doc);
    else await tx.collegeEntries.insert(doc);
    return doc;
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 审核一份名单。**仅管理员**，且只能处理「待审核」的那一份。
 *
 * 退回必须给理由（与入会审核同一条硬规则）；通过时清空理由，避免上一轮
 * 退回的说明留在通过记录上。审核改的是名单状态，不影响等级分，无需失效缓存。
 *
 * @param {Object} payload { entryId, action, reason }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function reviewCollegeEntry(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const found = await ctx.repo.collegeEntries.getById(payload.entryId);
  // 名单直读集合，先判归属；不属于本协会视同不存在
  const entry = belongsToAssociation(found, ctx.association) ? found : null;
  const checked = validateEntryReview(ctx.actor, entry, payload.action, payload.reason);
  if (!checked.ok) {
    return ok({ ok: false, record: null, message: checked.message });
  }

  const patch = {
    status: checked.status,
    reviewedBy: ctx.actorId,
    reviewedAt: ctx.now,
    // 退回留理由；通过时清空，避免上一轮退回的说明留在通过记录上
    reason: payload.action === REVIEW_ACTION.REJECT ? String(payload.reason || '').trim() : '',
  };

  const record = await ctx.repo.transaction(async (tx) => {
    await tx.collegeEntries.update(payload.entryId, patch);
    return { ...entry, ...patch };
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 抽签：把已通过审核的学院排进签表，赛事转入「待开赛」。
 *
 * 【为什么抽签顺带锁定名单】
 * 抽签一落库，status 从 SIGNUP 转 READY，而名单的提交权只看「是否报名中」
 * （college-entry.canSubmitCollegeEntry），于是名单自然不可再改（D13），
 * 不需要在名单记录上另打一个 locked 标记。
 *
 * @param {Object} payload { eventId, seedColleges, seedValue }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function drawCollegeEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await collegeEventInScope(ctx, payload.eventId);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场学院赛' });

  const entries = await ctx.repo.collegeEntries.listByEvent(payload.eventId);
  // seedValue 由调用方给（测试可复现）；没给就现取一个随机值并落库备查
  const seedValue = Number.isFinite(Number(payload.seedValue))
    ? Number(payload.seedValue)
    : Math.floor(Math.random() * 0x7fffffff);

  const plan = planCollegeDraw({
    event,
    actor: ctx.actor,
    entries,
    seedColleges: payload.seedColleges,
    seedValue,
  });
  if (!plan.ok) return ok({ ok: false, record: null, message: plan.message });

  const draw = buildCollegeDrawRecord(plan, { drawnAt: ctx.now, drawnBy: ctx.actorId });

  const record = await ctx.repo.transaction(async (tx) => {
    await tx.collegeEvents.update(payload.eventId, { draw, status: COLLEGE_EVENT_STATUS.READY });
    return { ...event, draw, status: COLLEGE_EVENT_STATUS.READY };
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 赛事级「开始」：赛事转入进行中，并生成第一轮全部大场（D35、D36）。
 *
 * 【为什么生成首轮绑在开赛上，而不是抽签上】
 * 抽签只回答「谁在签表哪个位置」。若抽签即生成大场，任何一个想改种子的人
 * 都会先得到一批已存在的大场，得先清理再重抽。绑在开赛上，抽签到开赛之间
 * 仍可从容核对对阵。
 *
 * @param {Object} payload { eventId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, ties, message}
 */
async function startCollegeEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await collegeEventInScope(ctx, payload.eventId);
  if (!event) return ok({ ok: false, record: null, ties: [], message: '找不到这场学院赛' });

  if (!canStartCollegeEvent(event, ctx.actor)) {
    if (event.status !== COLLEGE_EVENT_STATUS.READY) {
      return ok({ ok: false, record: null, ties: [], message: '还没有抽签，不能开始' });
    }
    return ok({ ok: false, record: null, ties: [], message: '只有管理员可以开始赛事' });
  }

  const ties = buildTiesForRound({ event, round: 1, pairs: firstRoundPairsOf(event.draw) });
  const patch = { status: COLLEGE_EVENT_STATUS.ONGOING, currentRound: 1, startedAt: ctx.now };

  const record = await ctx.repo.transaction(async (tx) => {
    // 【为什么必须在事务内复查状态】
    // 上面那次读取与这次写入之间可能插进另一次「开始」。ties.insert 是 set
    // （upsert），若不复查，并发的第二次会把首轮大场连同其间已经录进去的
    // 排阵、小场编号一起覆盖掉——大场看着还在，进展却凭空消失。
    const current = await tx.collegeEvents.getById(payload.eventId);
    if (!current || current.status !== COLLEGE_EVENT_STATUS.READY) return null;

    for (const tie of ties) {
      const existing = await tx.ties.getById(tie._id);
      if (existing) continue; // 只补不覆盖，与 startTie 同一纪律
      await tx.ties.insert({ ...tie, association: ctx.association });
    }
    await tx.collegeEvents.update(payload.eventId, patch);
    return { ...event, ...patch };
  });

  if (!record) return ok({ ok: false, record: null, ties: [], message: '这场学院赛已经开始了' });

  return ok({ ok: true, record, ties, message: '' });
}

/**
 * 置顶 / 取消置顶一场学院赛。**仅管理员**，与发布同一门槛。
 *
 * 与进行到哪一步无关，因此不判状态机。学院赛不走回放，列表直接读集合
 * （见 getCollegeEvents），改完即可见，无需失效缓存。
 *
 * @param {Object} payload { eventId, pinned }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function setCollegeEventPinned(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const event = await collegeEventInScope(ctx, payload.eventId);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场学院赛' });

  if (!canManageCollegeEvent(ctx.actor, { isMock: false })) {
    return ok({ ok: false, record: null, message: '当前账号没有管理学院赛的权限' });
  }

  const patch = { pinned: Boolean(payload.pinned), actor: ctx.actorId, actedAt: ctx.now };
  const record = await ctx.repo.transaction(async (tx) => {
    await tx.collegeEvents.update(payload.eventId, patch);
    return { ...event, ...patch };
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 提交本大场的排阵。**学院负责人（本学院）+ 管理员**，且大场尚未开始（D37）。
 *
 * 【为什么提交后要把大场的 lineupA / lineupB 置真】
 * 大场状态（待排阵 → 待开赛）由「双方是否都交」推出来（college-tie.tieStatusOf）。
 * 每次提交只翻自己那一侧，另一方不受影响。
 *
 * @param {Object} payload { tieId, college, entries }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function submitLineup(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const tie = await tieInScope(ctx, payload.tieId);
  if (!tie) return ok({ ok: false, record: null, message: '找不到这个大场' });

  const event = await collegeEventInScope(ctx, tie.eventId);
  const college = String(payload.college || (ctx.actor && ctx.actor.college) || '').trim();
  // 排阵的人必须出自本学院已通过审核的名单：名单本身由自然键取回
  const foundEntry = await ctx.repo.collegeEntries.getById(
    collegeEntryNaturalKey(tie.eventId, college)
  );
  const entry = belongsToAssociation(foundEntry, ctx.association) ? foundEntry : null;
  // 排阵要按小项核对上场队员性别，得先拿到全量会员档案（含 gender）
  const { members } = await getDataset(ctx);

  const built = buildLineupRecord(
    { ...payload, college },
    { tie, event, actor: ctx.actor, entry, now: ctx.now, carriedFrom: payload.carriedFrom, members }
  );
  if (!built.ok) return ok({ ok: false, record: null, message: built.message });

  const _id = collegeLineupNaturalKey(tie._id, built.record.college);
  const side = built.record.college === tie.collegeA ? 'lineupA' : 'lineupB';

  const record = await ctx.repo.transaction(async (tx) => {
    const existing = await tx.lineups.getById(_id);
    // update 只传业务字段，避免把 _id 带进云开发的 update（会被拒）
    if (existing) await tx.lineups.update(_id, built.record);
    else await tx.lineups.insert({ ...built.record, _id, association: ctx.association });
    await tx.ties.update(tie._id, { [side]: true });
    return { ...built.record, _id };
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 大场级「开始」。**仅管理员**，且双方排阵已齐（D38）。
 *
 * 【为什么在这里才生成小场】
 * 排阵交齐之前不知道每个小项谁上，生成不了比赛记录。开赛这一刻双方排阵
 * 已就位，正好按排阵铺出全部小场（每条 status=PENDING，等录分与确认），
 * 并把编号写回 tie.legs[].matchId，详情页据此就能点进每个小项去录分。
 *
 * @param {Object} payload { tieId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, legs, message}
 */
async function startTie(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const tie = await tieInScope(ctx, payload.tieId);
  if (!tie) return ok({ ok: false, record: null, legs: [], message: '找不到这个大场' });

  if (!canStartTie(tie, ctx.actor)) {
    if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) {
      return ok({ ok: false, record: null, legs: [], message: '这个大场已经开始' });
    }
    if (!(tie.lineupA && tie.lineupB)) {
      return ok({ ok: false, record: null, legs: [], message: '双方排阵还没交齐，不能开始' });
    }
    return ok({ ok: false, record: null, legs: [], message: '只有管理员可以开始大场' });
  }

  const event = await collegeEventInScope(ctx, tie.eventId);
  // 事务内不允许条件读取，排阵在事务外一次取全
  const lineups = await ctx.repo.lineups.listByEvent(tie.eventId);
  const built = buildLegMatchDrafts({ event, tie, lineups, now: ctx.now });
  if (!built.ok) return ok({ ok: false, record: null, legs: [], message: built.message });

  const byLegNo = new Map(built.drafts.map((draft) => [Number(draft.legNo), draft._id]));
  const legs = (Array.isArray(tie.legs) ? tie.legs : []).map((leg) => ({
    ...leg,
    matchId: byLegNo.get(Number(leg.legNo)) || leg.matchId || '',
  }));
  const patch = { status: TIE_STATUS.ONGOING, startedAt: ctx.now, legs };

  const record = await ctx.repo.transaction(async (tx) => {
    for (const draft of built.drafts) {
      const existing = await tx.matches.getById(draft._id);
      // 重开同一大场时编号相同，只补不覆盖，免得冲掉已录的比分
      if (!existing) await tx.matches.insert({ ...draft, association: ctx.association });
    }
    await tx.ties.update(tie._id, patch);
    // 小场落的是 matches 集合，它经 dataset 读（按赛季版本号缓存）。
    // 不 +1，刚生成的场次在下一次读里就查不到——录分与开台计分都会
    // 报「找不到这场比赛」，要等某次无关写入才「自己好了」。
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...tie, ...patch };
  });

  return ok({ ok: true, record, legs: built.drafts, message: '' });
}

/**
 * 管理员记一次弃权（M4-7）。**仅管理员**，且大场已开始。
 *
 * 【为什么弃权是一场「已生效」的比赛】
 * D41：弃权不计 ELO，但对阵照常推进——对手直接拿到这一小项。把它记成
 * 一条正常的比赛记录（outcome=forfeit、winner 给对手、status 直接 ACTIVE），
 * 就复用了同一套大场汇总与轮次推进；回放侧只多认一个 outcome 字段，
 * 把这类比赛排除在等级分之外（见 college-tie.isEloEligibleMatch）。
 * 因此不需要再发明一种「弃权小项」，也就不会有两套并行的推进逻辑。
 *
 * @param {Object} payload { tieId, legNo, forfeitBy }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, match, message}
 */
async function recordForfeit(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canManageCollegeEvent(ctx.actor, { isMock: false })) {
    return ok({ ok: false, match: null, message: '只有管理员可以记录弃权' });
  }

  const tie = await tieInScope(ctx, payload.tieId);
  if (!tie) return ok({ ok: false, match: null, message: '找不到这个大场' });
  if (tie.status === TIE_STATUS.FINISHED) {
    return ok({ ok: false, match: null, message: '这个大场已经结束' });
  }
  if (tie.status !== TIE_STATUS.ONGOING) {
    return ok({ ok: false, match: null, message: '大场还没开始，不能记弃权' });
  }

  const leg = (Array.isArray(tie.legs) ? tie.legs : []).find(
    (item) => Number(item.legNo) === Number(payload.legNo)
  );
  if (!leg) return ok({ ok: false, match: null, message: '找不到这个小项' });
  if (!leg.matchId) return ok({ ok: false, match: null, message: '这个小项还没有生成比赛' });
  if (leg.winner) return ok({ ok: false, match: null, message: '这个小项已经有结果了' });

  const forfeitBy = String(payload.forfeitBy || '').trim();
  if (forfeitBy !== tie.collegeA && forfeitBy !== tie.collegeB) {
    return ok({ ok: false, match: null, message: '弃权的必须是本大场的参赛学院' });
  }

  const match = await ctx.repo.matches.getById(leg.matchId);
  if (!match) return ok({ ok: false, match: null, message: '找不到这个小项的比赛' });
  // 只有待确认的小项能记弃权：已生效的再记会重复推进对阵，已撤销的更不能
  // 借弃权悄悄复活（撤销是管理员的判定，不该被一次弃权推翻）。
  if (match.status !== MATCH_STATUS.PENDING) {
    return ok({
      ok: false,
      match: null,
      message:
        match.status === MATCH_STATUS.REVOKED
          ? '这个小项已撤销，不能再记弃权'
          : '这个小项已经生效，不能再记弃权',
    });
  }

  // 弃权方丢掉这一项，对手获胜；比分留空，结果性质由 outcome 表达
  const winner = forfeitBy === tie.collegeA ? TEAM.B : TEAM.A;
  const patch = {
    outcome: MATCH_OUTCOME.FORFEIT,
    forfeitBy,
    winner,
    scoreA: [],
    scoreB: [],
    recorder: ctx.actorId,
    status: MATCH_STATUS.ACTIVE,
    action: 'forfeit',
    actor: ctx.actorId,
    actedAt: ctx.now,
  };

  const patched = await ctx.repo.transaction(async (tx) => {
    // 【为什么必须在事务内复查】
    // 一次「确认」与一次「记弃权」几乎同时落到同一个小项上时，两边的事务外
    // 读取都会看到「待确认」，于是都往下写：后写的把先写的胜者冲掉，大场
    // 汇总却按先写的那次推进过，晋级名单就此与台账对不上。重读之后条件不
    // 满足的一侧直接放弃，只有一次能落地。
    const currentTie = await tx.ties.getById(payload.tieId);
    const currentLeg = (Array.isArray(currentTie && currentTie.legs) ? currentTie.legs : []).find(
      (item) => Number(item.legNo) === Number(payload.legNo)
    );
    if (!currentTie || currentTie.status !== TIE_STATUS.ONGOING) return null;
    if (!currentLeg || currentLeg.winner) return null;

    const current = await tx.matches.getById(leg.matchId);
    if (!current || current.status !== MATCH_STATUS.PENDING) return null;

    await tx.matches.update(leg.matchId, patch);
    // 台账变了（比赛从待确认转生效），让回放缓存失效
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, match: null, message: '这个小项已经处理过了' });

  await advanceCollegeAfterLeg(ctx, patched);

  return ok({ ok: true, match: patched, message: '' });
}

/**
 * 录入学院名次并结束赛事（M5-1）。**仅管理员**，且赛事已进入比赛态。
 *
 * 【为什么不复用 finishEvent】
 * finishEvent 写的是个人赛的 events 集合，名次按 userId 记；学院赛名次按
 * 学院记（D26），两者连集合都不是同一个。共用的只有「先校验再落库」的
 * 套路，硬把两个模型塞进一个 handler，会让「这行是人还是学院」的判断
 * 扩散到事务里。
 *
 * 【为什么不动回放缓存】
 * 学院赛名次不产生任何个人等级分或赛季积分——它既不在 events 集合里，
 * 也不进 applyEventPoints 的循环（M5-2）。写完就结束，不必让全场重放。
 *
 * @param {Object} payload { id, results }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function finishCollegeEvent(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canManageCollegeEvent(ctx.actor, { isMock: false })) {
    return ok({ ok: false, record: null, message: '只有管理员可以录入名次' });
  }

  const event = await collegeEventInScope(ctx, payload.id);
  if (!event) return ok({ ok: false, record: null, message: '找不到这场学院赛' });
  if (event.status === COLLEGE_EVENT_STATUS.FINISHED) {
    return ok({ ok: false, record: null, message: '这场学院赛已经结束了' });
  }
  if (event.status !== COLLEGE_EVENT_STATUS.ONGOING) {
    return ok({ ok: false, record: null, message: '学院赛还没开始，不能录入名次' });
  }

  // 只能给「已通过审核」的学院记名次，挡住手滑写进来的学院名
  const entries = await ctx.repo.collegeEntries.listByEvent(payload.id);
  const colleges = entries
    .filter((entry) => entry.status === COLLEGE_ENTRY_STATUS.APPROVED)
    .map((entry) => entry.college);

  const checked = validateCollegePlacements(payload.results, { colleges });
  if (!checked.ok) return ok({ ok: false, record: null, message: checked.firstError });

  const patch = {
    status: COLLEGE_EVENT_STATUS.FINISHED,
    results: checked.results,
    finishedAt: ctx.now,
    actor: ctx.actorId,
  };

  const record = await ctx.repo.transaction(async (tx) => {
    await tx.collegeEvents.update(payload.id, patch);
    return { ...event, ...patch };
  });

  return ok({ ok: true, record, message: '' });
}

/**
 * 指派 / 改派 / 取消一个大场的裁判。**仅管理员**（Q3），且大场尚未结束。
 *
 * 【为什么要逐个写进小场】
 * 权限判定只读比赛记录自己的 `referee`（见 match-record.canRecordScore），
 * 录分时不必回查大场。所以一次指派 = 写大场 + 写它下面所有能改派的小场。
 * 已生效 / 已作废的小项跳过，避免改历史。
 *
 * 【为什么大场「进行中」仍可指派】
 * 小项比赛要到 startTie 才生成，而裁判本就是「录分之前」才指派。若进行中
 * 也禁掉，学院赛就永远指派不了裁判。只有已结束（胜负已定）才锁死。
 *
 * 【为什么要 bumpSeason】
 * 与 assignMatchReferee 同一条：小场是 matches 文档，而 referee 只从 dataset
 * 读得到。不 +1，改派后的裁判在明细里看不见，权限收窄（参赛者不得再录分）
 * 也不生效。此外这里还连带写了大场，大场虽不在 dataset 里，一并失效无害。
 *
 * @param {Object} payload { tieId, refereeId }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, matches, message}
 */
async function assignTieReferee(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canManageCollegeEvent(ctx.actor, { isMock: false })) {
    return ok({ ok: false, record: null, matches: [], message: '只有管理员可以指派裁判' });
  }

  const tie = await tieInScope(ctx, payload.tieId);
  if (!tie) return ok({ ok: false, record: null, matches: [], message: '找不到这个大场' });
  if (!canAssignTieReferee(tie)) {
    return ok({ ok: false, record: null, matches: [], message: '这个大场已经结束，不能再改派裁判' });
  }

  const refereeId = String(payload.refereeId || '').trim();
  if (refereeId) {
    // 在册会员与待审核申请分在两个数组里，一起查才能把「编号填错了」与
    // 「这人还没转正」分开报（与 mock.refereeRejection 同一口径）
    const dataset = await getDataset(ctx);
    const accounts = [...(dataset.members || []), ...(dataset.applications || [])];
    const referee = accounts.find((user) => user._id === refereeId);
    if (!referee) return ok({ ok: false, record: null, matches: [], message: '找不到这位会员' });
    if (referee.status !== USER_STATUS.ACTIVE) {
      return ok({ ok: false, record: null, matches: [], message: '该会员不是正常在册状态，不能担任裁判' });
    }
  }

  const patch = buildRefereePatch(refereeId, { actorId: ctx.actorId, now: ctx.now });
  const legIds = legMatchIdsOf(tie);

  const result = await ctx.repo.transaction(async (tx) => {
    const currentTie = await tx.ties.getById(payload.tieId);
    if (!currentTie || !canAssignTieReferee(currentTie)) return null;

    const matches = [];
    for (const legId of legIds) {
      const leg = await tx.matches.getById(legId);
      if (!leg || !canAssignReferee(leg)) continue;
      await tx.matches.update(legId, patch);
      matches.push({ ...leg, ...patch });
    }
    await tx.ties.update(payload.tieId, patch);
    // 小场的 referee 从 dataset 读，必须让缓存失效（见上面说明）
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { record: { ...currentTie, ...patch }, matches };
  });

  if (!result) {
    return ok({ ok: false, record: null, matches: [], message: '这个大场已经结束，不能再改派裁判' });
  }
  return ok({ ok: true, record: result.record, matches: result.matches, message: '' });
}

module.exports = {
  getCollegeEvents,
  getCollegeEvent,
  getCollegeEntries,
  getCollegeTies,
  getCollegeLineups,
  assignTieReferee,
  publishCollegeEvent,
  submitCollegeEntry,
  reviewCollegeEntry,
  drawCollegeEvent,
  startCollegeEvent,
  setCollegeEventPinned,
  submitLineup,
  startTie,
  recordForfeit,
  finishCollegeEvent,
};
