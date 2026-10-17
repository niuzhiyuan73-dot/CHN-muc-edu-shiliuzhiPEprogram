/**
 * 运动会：成绩录入与正式结果发布（B7）
 * ============================================================
 * 链路：裁判录分 → 全员提交 → 服务端汇总 → 名次 → 发布（带版本）→ 结果行。
 *
 * 【为什么录分与发布是两件事】
 * D66 允许「提交后、汇总前」修改，D85 是「每项目组别发布」。所以分数有
 * draft / submitted 两态，发布是一个独立动作：只有发布才产生名次与学院分。
 * 未发布的分数不进任何榜单——这是 D79「只算已发布」的落点。
 *
 * 【平均怎么算（D63／N4）】
 * 每个场次的**全部有效裁判**都提交后才可汇总；去掉一个最高、一个最低后平均。
 * 3 人时等价取中间值（与田联 TR19.11 的三表取中一致）。不足 3 人时不去极值，
 * 直接平均——2 人去掉最高最低等于没有分数，这条边界必须显式写出来。
 * 汇总结果按最小单位（0.01 秒 / 0.01 米 / 1 次 / 0.1 分）四舍五入到整数，
 * 因为排名比较用的是同一套缩放整数（见 meet-measure）。
 *
 * 【无成绩不是 0（A3／D68）】
 * 无效与弃权在**发布时**由发布人标记，存为「无成绩」状态：不参与名次、学院 0 分。
 * 绝不写成数值 0——计时项目 0 秒会是第一名。
 *
 * 【更正是无痕的（D87／B3）】
 * 重新发布不保留历史版本：版本号 +1（用于幂等与「三处展示一致」的判断），
 * 结果行按同一主键**覆盖**——这正是用户要的「无痕更正」，不做版本可追。
 * 因此不要在这里加 version 到行主键上：那会把「无痕」变成「可追」，
 * 与已确认的裁决相反。
 *
 * 【本批不做】
 * · 预赛晋级（多轮推进）：一个项目组别当前只支持一个发布场次；
 * · 胜负项目（拔河）的赛制名次由发布人直接录入，不自动跑赛制。
 * 两处都在各自入口给出明确提示，不假装支持。
 * ============================================================
 */

const {
  MEET_STATUS,
  meetScoreKey, meetJudgeKey, meetPublicationKey, meetResultRowKey,
} = require('../utils/meet-scope.js');
const { MEET_SCORE_TYPE } = require('./meet-event-catalog.js');
const { MEASURE_RULES, normalizeMeasure, formatMeasure, compareMeasure } = require('./meet-measure.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const { meetReadable, canManageMeet, canPublishMeetResult } = require('./meet-permission.js');

const ok = (data) => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

/** 4.2 默认名次分表（个人）；团体 ×2（D72） */
const PERSONAL_POINTS = Object.freeze([9, 7, 6, 5, 4, 3, 2, 1]);
const TEAM_MULTIPLIER = 2;
const SCORED_RANKS = PERSONAL_POINTS.length;

const SCORE_STATE = Object.freeze({ DRAFT: 'draft', SUBMITTED: 'submitted' });
const ROW_STATUS = Object.freeze({ RESULT: 'result', VOID: 'void' });

const isAlive = (doc) => Boolean(doc && doc.status && doc.status !== MEET_STATUS.DELETED);
const toIso = (now) => (now instanceof Date ? now.toISOString() : String(now));
const scopeOf = (ctx) => ({ schoolId: ctx.schoolId, meetId: ctx.meetId });

/** 名次分：只对「计分」项目、且名次在录取范围内计分 */
function pointsOf(rank, scored, entryForm) {
  if (!scored || !Number.isInteger(rank) || rank < 1 || rank > SCORED_RANKS) return 0;
  const base = PERSONAL_POINTS[rank - 1];
  return entryForm === 'team' ? base * TEAM_MULTIPLIER : base;
}

/**
 * 去极值平均（D63）。入参是缩放后的整数数组，返回缩放整数。
 * 不足 3 人不去极值——2 人去掉最高最低就没有数了。
 */
function averageOf(values) {
  const list = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  if (list.length < 3) {
    const sum = list.reduce((acc, value) => acc + value, 0);
    return Math.round(sum / list.length);
  }
  const trimmed = list.slice(1, -1);
  const sum = trimmed.reduce((acc, value) => acc + value, 0);
  return Math.round(sum / trimmed.length);
}

/** 竞赛排名 1,2,2,4（D73）：同值同名次，后续跳号 */
function rankRows(rows, order) {
  const sorted = [...rows].sort((a, b) => {
    const compared = compareMeasure(a.value, b.value, order);
    if (compared === null || compared === 0) return 0;
    return compared;
  });
  let lastValue = null;
  let lastRank = 0;
  sorted.forEach((row, index) => {
    if (lastValue !== null && compareMeasure(row.value, lastValue, order) === 0) {
      row.rank = lastRank;
    } else {
      row.rank = index + 1;
      lastValue = row.value;
      lastRank = row.rank;
    }
  });
  return sorted;
}

/** 汇总某个场次的有效分数：要求全部有效裁判都已提交 */
function summarizeScores(entries, scores, judgeIds, eventKey, sessionKey) {
  const mine = scores.filter((doc) => doc.eventKey === eventKey
    && doc.sessionKey === sessionKey && doc.state === SCORE_STATE.SUBMITTED);
  const missing = entries.filter((entry) => {
    const submitted = new Set(mine.filter((doc) => doc.entryKey === entry._id).map((doc) => doc.judgeId));
    return judgeIds.some((judgeId) => !submitted.has(judgeId));
  });
  const values = new Map();
  for (const entry of entries) {
    const list = mine.filter((doc) => doc.entryKey === entry._id).map((doc) => doc.scaled);
    values.set(entry._id, averageOf(list));
  }
  return { values, missing };
}

/** 我的裁判任务里，某个场次需要录哪些参赛记录 */
async function getMeetSessionScores(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = scopeOf(ctx);
  const sessionKey = String(payload.sessionKey || '').trim();
  if (!sessionKey) return refused('请指定场次');

  const [session, entries, scores, assignment] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetSessions.getById(sessionKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetScores.list(),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.getById(
      meetJudgeKey(ctx.meetId, sessionKey, ctx.actorId || '-'),
    ),
  ]);
  if (!session || session.meetId !== ctx.meetId) return refused('场次不存在或不属于本届运动会');

  const isAdmin = canManageMeet(ctx);
  const own = entries
    .filter((doc) => doc.eventKey === session.eventKey && doc.status === 'approved')
    .map((doc) => {
      const mine = scores.find((row) => row.entryKey === doc._id
        && row.sessionKey === sessionKey && row.judgeId === ctx.actorId);
      return {
        entryKey: doc._id,
        collegeId: doc.collegeId,
        userIds: doc.userIds,
        myScore: mine ? { text: mine.rawText, state: mine.state } : null,
      };
    });

  return ok({
    session: {
      sessionKey, eventKey: session.eventKey, round: session.round,
      startAt: session.startAt, venue: session.venue, judgeCount: session.judgeCount || 0,
    },
    items: own,
    // 能不能录：管理员可代录（D70），裁判必须本人被指派到该场次
    canEnter: isAdmin || Boolean(assignment && assignment.status === 'active'),
  });
}

/** 保存我的分数草稿（D66：提交前可改） */
async function saveMeetJudgeScore(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');
  const scope = scopeOf(ctx);
  const sessionKey = String(payload.sessionKey || '').trim();
  const entryKey = String(payload.entryKey || '').trim();
  if (!sessionKey || !entryKey) return refused('请指定场次与参赛记录');

  return ctx.repo.transaction(async (tx) => {
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (!session || session.meetId !== ctx.meetId) return refused('场次不存在或不属于本届运动会');
    const event = await tx.sportsMeetEvents.getById(session.eventKey);
    if (!event) return refused('项目组别不存在');
    if (event.scoreType === MEET_SCORE_TYPE.VERSUS) {
      return refused('胜负项目不录入数值成绩，由发布人直接录入赛制名次');
    }
    const entry = await tx.sportsMeetEntries.getById(entryKey);
    if (!entry || entry.eventKey !== session.eventKey || entry.status !== 'approved') {
      return refused('参赛记录不存在或未通过审核');
    }
    // 只有被指派的裁判（或管理员代录 D70）可以录分
    const assignment = await tx.sportsMeetJudgeAssignments.getById(
      meetJudgeKey(ctx.meetId, sessionKey, ctx.actorId),
    );
    const isAdmin = canManageMeet(ctx);
    if (!isAdmin && !(assignment && assignment.status === 'active')) {
      return refused('你不是该场次的裁判');
    }
    const judgeId = isAdmin && !(assignment && assignment.status === 'active')
      ? String(payload.judgeId || ctx.actorId)
      : ctx.actorId;

    const key = meetScoreKey(entryKey, sessionKey, judgeId);
    const current = await tx.sportsMeetScores.getById(key);
    if (current && current.state === SCORE_STATE.SUBMITTED && payload.allowResubmit !== true) {
      return refused('已提交，如需修改请先撤回提交');
    }

    const normalized = normalizeMeasure(event.scoreType, payload.rawText);
    if (!normalized.ok) return refused(normalized.message);

    const now = toIso(ctx.now);
    const doc = {
      schoolId: ctx.schoolId, meetId: ctx.meetId, eventKey: session.eventKey,
      sessionKey, entryKey, judgeId,
      rawText: String(payload.rawText).trim(),
      scaled: normalized.scaled,
      state: SCORE_STATE.DRAFT,
      revision: ((current && current.revision) || 0) + 1,
      updatedAt: now,
    };
    await tx.sportsMeetScores.set(key, doc);
    return ok({ score: { entryKey, sessionKey, judgeId, text: normalized.text, state: doc.state } });
  });
}

/** 提交我的分数（提交后到汇总前仍可改，D66） */
async function submitMeetJudgeScore(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');
  const sessionKey = String(payload.sessionKey || '').trim();
  const entryKey = String(payload.entryKey || '').trim();
  if (!sessionKey || !entryKey) return refused('请指定场次与参赛记录');

  // 管理员代录时（D70）可以替某个裁判提交；裁判本人只能提交自己的
  const judgeId = canManageMeet(ctx) && payload.judgeId ? String(payload.judgeId) : ctx.actorId;

  return ctx.repo.transaction(async (tx) => {
    const key = meetScoreKey(entryKey, sessionKey, judgeId);
    const current = await tx.sportsMeetScores.getById(key);
    if (!current) return refused('请先填写成绩');
    const now = toIso(ctx.now);
    await tx.sportsMeetScores.set(key, { ...current, state: SCORE_STATE.SUBMITTED, updatedAt: now });
    return ok({ entryKey, sessionKey, state: SCORE_STATE.SUBMITTED });
  });
}

/**
 * 预览：这个项目组别当前能不能汇总、每条的均值与缺分情况。
 * 不写库，发布前给管理员看。
 */
async function getMeetResultPreview(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以预览汇总');
  const scope = scopeOf(ctx);
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');

  const [event, entries, scores, sessions, assignments] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetScores.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');

  const own = sessions.filter((doc) => doc.eventKey === eventKey);
  if (own.length === 0) return refused('该项目组别还没有场次');
  const sessionKey = String(payload.sessionKey || own[0]._id);
  const judgeIds = assignments
    .filter((doc) => doc.status === 'active' && doc.sessionKey === sessionKey)
    .map((doc) => doc.judgeId);

  const approved = entries.filter((doc) => doc.eventKey === eventKey && doc.status === 'approved');
  if (event.scoreType === MEET_SCORE_TYPE.VERSUS) {
    return ok({
      event: { eventKey, name: event.name, group: event.group, scoreType: event.scoreType },
      sessionKey, judgeIds, versus: true, items: [], missing: [],
    });
  }

  const { values, missing } = summarizeScores(approved, scores, judgeIds, eventKey, sessionKey);
  return ok({
    event: { eventKey, name: event.name, group: event.group, scoreType: event.scoreType, order: event.order },
    sessionKey,
    judgeIds,
    versus: false,
    missing: missing.map((doc) => ({ entryKey: doc._id, collegeId: doc.collegeId })),
    items: approved.map((doc) => ({
      entryKey: doc._id,
      collegeId: doc.collegeId,
      userIds: doc.userIds,
      value: values.get(doc._id),
      text: values.get(doc._id) === null
        ? '未收齐'
        : formatMeasure(event.scoreType, values.get(doc._id)),
    })),
  });
}

/**
 * 发布正式结果（D84／D85）。
 *
 * @param {Object} payload { eventKey, sessionKey?, voidEntryKeys?: string[], rankings?: [{entryKey,rank}] }
 */
async function publishMeetResults(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');

  const scope = scopeOf(ctx);
  const [meet, event, entries, scores, sessions, assignments, publications] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetScores.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
  ]);
  if (!isAlive(meet) || meet.schoolId !== ctx.schoolId) return refused('运动会不存在或已删除');
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canPublishMeetResult(ctx)) return refused('只有校级管理员及以上或本届总裁判可以发布成绩');

  const ownSessions = sessions.filter((doc) => doc.eventKey === eventKey);
  if (ownSessions.length === 0) return refused('该项目组别还没有场次');
  if (ownSessions.length > 1 && !payload.sessionKey) {
    return refused('该项目组别有多个场次（预赛/决赛），本批还不支持自动推进，请指定场次');
  }
  const sessionKey = String(payload.sessionKey || ownSessions[0]._id);

  const approved = entries.filter((doc) => doc.eventKey === eventKey && doc.status === 'approved');
  if (approved.length === 0) return refused('该项目还没有通过审核的参赛名单');

  const voidKeys = new Set(Array.isArray(payload.voidEntryKeys) ? payload.voidEntryKeys : []);
  const rows = [];

  if (event.scoreType === MEET_SCORE_TYPE.VERSUS) {
    // 胜负项目：名次由赛制产生，本批由发布人直接录入（A5）
    const rankings = Array.isArray(payload.rankings) ? payload.rankings : [];
    if (rankings.length !== approved.length) {
      return refused('请为每条参赛记录录入赛制名次');
    }
    const seen = new Set();
    for (const item of rankings) {
      const rank = Number(item.rank);
      if (!Number.isInteger(rank) || rank < 1 || rank > approved.length) return refused('名次超出范围');
      if (seen.has(rank)) return refused('名次不能重复');
      seen.add(rank);
      const entry = approved.find((doc) => doc._id === item.entryKey);
      if (!entry) return refused('名次里有不属于本项目的参赛记录');
      const isVoid = voidKeys.has(entry._id);
      rows.push({
        entryKey: entry._id, collegeId: entry.collegeId, userIds: entry.userIds,
        value: null, rank: isVoid ? null : rank,
        status: isVoid ? ROW_STATUS.VOID : ROW_STATUS.RESULT,
        points: isVoid ? 0 : pointsOf(rank, event.scored, event.entryForm),
      });
    }
  } else {
    const judgeIds = assignments
      .filter((doc) => doc.status === 'active' && doc.sessionKey === sessionKey)
      .map((doc) => doc.judgeId);
    if (judgeIds.length === 0) return refused('该场次还没有指派裁判');

    const { values, missing } = summarizeScores(approved, scores, judgeIds, eventKey, sessionKey);
    if (missing.length > 0) {
      return refused(`还有 ${missing.length} 条参赛记录没有收齐裁判成绩`, {
        missing: missing.map((doc) => doc._id),
      });
    }

    const live = [];
    for (const entry of approved) {
      const value = values.get(entry._id);
      if (voidKeys.has(entry._id) || value === null) {
        rows.push({
          entryKey: entry._id, collegeId: entry.collegeId, userIds: entry.userIds,
          value: null, rank: null, status: ROW_STATUS.VOID, points: 0,
        });
      } else {
        live.push({
          entryKey: entry._id, collegeId: entry.collegeId, userIds: entry.userIds,
          value, status: ROW_STATUS.RESULT, points: 0,
        });
      }
    }
    for (const row of rankRows(live, event.order)) {
      row.points = pointsOf(row.rank, event.scored, event.entryForm);
      rows.push(row);
    }
  }

  const publicationKey = meetPublicationKey(ctx.meetId, eventKey);
  const current = publications.find((doc) => doc._id === publicationKey);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canPublishMeetResult(fresh)) return refused('只有校级管理员及以上或本届总裁判可以发布成绩');
    const latest = await tx.sportsMeetPublications.getById(publicationKey);
    if (current && (!latest || latest.version !== current.version)) {
      return refused('发布状态已变化，请刷新后重试');
    }
    const now = toIso(fresh.now);
    const version = (latest ? Number(latest.version) || 0 : 0) + 1;
    const rules = {
      personalPoints: [...PERSONAL_POINTS],
      teamMultiplier: TEAM_MULTIPLIER,
      tieRanking: 'competition',
      average: 'trim-extremes',
    };
    await tx.sportsMeetPublications.set(publicationKey, {
      schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey,
      version, status: 'published', rules,
      sessionKey,
      rowCount: rows.length,
      voidCount: rows.filter((row) => row.status === ROW_STATUS.VOID).length,
      publishedBy: fresh.actorId, publishedAt: now,
      reason: String(payload.reason || '').slice(0, 100),
    });
    for (const row of rows) {
      await tx.sportsMeetResultRows.set(meetResultRowKey(publicationKey, row.entryKey), {
        schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey,
        publicationKey, version,
        ...row,
        updatedAt: now,
      });
    }
    return ok({
      publication: {
        eventKey, version, sessionKey,
        rows: rows.map((row) => ({
          entryKey: row.entryKey, collegeId: row.collegeId,
          rank: row.rank, points: row.points, status: row.status,
        })),
      },
    });
  });
}

/** 已发布结果：读当前版本的行（旧版本留在库里但不返回） */
async function getPublishedResults(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = scopeOf(ctx);
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');

  const [publication, rows, event] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetPublications.getById(meetPublicationKey(ctx.meetId, eventKey)),
    ctx.repo.forMeet(scope).sportsMeetResultRows.list(),
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
  ]);
  if (!publication) return ok({ published: false, eventKey });

  const current = rows.filter((row) => row.publicationKey === publication._id
    && row.version === publication.version);

  return ok({
    published: true,
    eventKey,
    event: event ? { name: event.name, group: event.group, scored: event.scored } : null,
    publication: {
      version: publication.version,
      publishedAt: publication.publishedAt,
      rowCount: publication.rowCount,
      voidCount: publication.voidCount,
      reason: publication.reason || '',
    },
    items: current.map((row) => ({
      entryKey: row.entryKey, collegeId: row.collegeId, userIds: row.userIds,
      rank: row.rank, points: row.points, status: row.status,
    })),
  });
}

module.exports = {
  getMeetSessionScores,
  saveMeetJudgeScore,
  submitMeetJudgeScore,
  getMeetResultPreview,
  publishMeetResults,
  getPublishedResults,
  // 纯函数导出给测试与 B8 复用
  averageOf,
  pointsOf,
};
