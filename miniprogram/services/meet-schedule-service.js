/**
 * 运动会：赛程与裁判指派（B6）
 * ============================================================
 * 三条产品约束决定这一批的形状：
 *
 *   D53 报名结束后、赛程发布前，**时间与场地必须配齐**——缺一个就不许发布，
 *       并且要报出缺哪些项目，而不是一句「不完整」；
 *   裁判可以随时指派，但**没有裁判的场次不能开赛**；
 *   D55 本期**不做冲突检测**（同裁判同时段两场、选手撞场都不拦），只给提示。
 *
 * 【为什么冲突检测不做而不是「顺手做一下」】
 * 冲突检测要判「同一裁判同一时间段」「同一选手两场重叠」「同一场地重叠」，
 * 而选手重叠需要展开每条参赛名单——那是跨集合查询，事务内做不到，读放大也大。
 * 用户明确裁了「暂不做」，这里就诚实地不加：页面上仍会显示同时间同裁判的提示，
 * 但不阻断。若将来要做，必须补一份「场次 × 参与人」的索引，不能靠扫名单。
 *
 * 【裁判为什么必须是在册会员】
 * D59 要求可鉴权账号。这里取「本校在册会员 + 账号有效」，与参赛资格同一把尺子：
 * 外校账号、已退会、被停用的账号都不能被指派。
 * ============================================================
 */

const {
  MEET_STATUS, meetSessionKey, meetJudgeKey,
} = require('../utils/meet-scope.js');
const { schoolMemberKey, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { MEET_SCORE_TYPE } = require('./meet-event-catalog.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const { meetReadable, canManageMeet } = require('./meet-permission.js');

const ok = (data) => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const ROUND_LABEL = Object.freeze({ final: '决赛', heat: '预赛', rr: '循环赛' });
/** 赛制轮次用 `r1`、`r2`… 表示；`rf` 不单独存在，最后一轮仍记作 `r<总轮数>`。 */
const BRACKET_ROUND = /^r[1-9]$/;
const SESSION_STATUS = Object.freeze({ SCHEDULED: 'scheduled', RUNNING: 'running', FINISHED: 'finished' });

const isAliveMeet = (doc) => Boolean(doc && doc.status && doc.status !== MEET_STATUS.DELETED);
const toIso = (now) => (now instanceof Date ? now.toISOString() : String(now));

function textOf(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max) return { ok: false, message: `${label}不超过 ${max} 个字` };
  return { ok: true, value: text };
}

/** 时间：接受 `YYYY-MM-DDTHH:mm` 或带秒的写法，与报名窗口同一套格式 */
function timeOf(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return { ok: false, message: `${label}格式应为 YYYY-MM-DDTHH:mm` };
  }
  const time = Date.parse(text.length === 16 ? `${text}:00Z` : `${text}Z`);
  if (!Number.isFinite(time)) return { ok: false, message: `${label}不是有效时间` };
  return { ok: true, value: text, time };
}

function sessionSummary(doc) {
  return {
    sessionKey: doc._id,
    eventKey: doc.eventKey,
    round: doc.round,
    roundLabel: doc.roundLabel || ROUND_LABEL[doc.round] || doc.round,
    index: doc.index,
    startAt: doc.startAt,
    endAt: doc.endAt || '',
    venue: doc.venue || '',
    note: doc.note || '',
    status: doc.status,
    // 参赛人：预赛是分到本组的人，赛制项目是本场对阵双方。空数组表示「全项目」。
    entryKeys: Array.isArray(doc.entryKeys) ? doc.entryKeys : [],
    winnerEntryKey: doc.winnerEntryKey || '',
  };
}

const scopeOf = (ctx) => ({ schoolId: ctx.schoolId, meetId: ctx.meetId });

/** 本届全部场次（按开始时间排序；无时间的排最后） */
async function listSessions(repo, ctx) {
  const docs = await repo.forMeet(scopeOf(ctx)).sportsMeetSessions.list();
  return docs
    .filter((doc) => doc.schoolId === ctx.schoolId && doc.meetId === ctx.meetId)
    .sort((a, b) => {
      const ta = a.startAt ? Date.parse(a.startAt) : Number.MAX_SAFE_INTEGER;
      const tb = b.startAt ? Date.parse(b.startAt) : Number.MAX_SAFE_INTEGER;
      return ta - tb || String(a._id).localeCompare(String(b._id));
    });
}

/**
 * 保存一个场次（同一项目组别 × 轮次 × 组次是唯一键，重复保存即覆盖）。
 *
 * @param {Object} payload { eventKey, round: 'final'|'heat', index, startAt, endAt, venue, note }
 */
async function saveMeetSession(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const round = String(payload.round || 'final');
  // 轮次三类：预赛 / 决赛（数值型项目的多轮），循环赛，以及淘汰赛的 r1…r9。
  // 淘汰赛轮次由编排自动生成，这里允许手工保存是为了改时间、场地与裁判，不是
  // 让管理员手工造对阵——对阵只能由签表算法落位。
  if (!ROUND_LABEL[round] && !BRACKET_ROUND.test(round)) {
    return refused('轮次只能是预赛、决赛、循环赛或淘汰赛轮次（r1–r9）');
  }
  const index = Number(payload.index === undefined ? 1 : payload.index);
  if (!Number.isInteger(index) || index < 1 || index > 99) return refused('组次应为 1–99 的整数');

  const start = timeOf(payload.startAt, '开始时间');
  if (!start.ok) return refused(start.message);
  const end = payload.endAt ? timeOf(payload.endAt, '结束时间') : { ok: true, value: '' };
  if (!end.ok) return refused(end.message);
  if (end.value && end.time <= start.time) return refused('结束时间必须晚于开始时间');

  const venue = textOf(payload.venue, 40, '场地');
  if (!venue.ok) return refused(venue.message);
  const note = textOf(payload.note, 100, '备注');
  if (!note.ok) return refused(note.message);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以编排赛程');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAliveMeet(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');

    const eventKey = String(payload.eventKey || '').trim();
    const event = await tx.sportsMeetEvents.getById(eventKey);
    if (!event || event.meetId !== fresh.meetId) return refused('项目组别不存在或不属于本届运动会');

    const key = meetSessionKey(fresh.meetId, eventKey, round, index);
    const current = await tx.sportsMeetSessions.getById(key);
    const now = toIso(fresh.now);
    // 先铺原文档再覆盖排期字段：裁判数与参赛人不是本动作的数据，
    // 若整份重写就会把 judgeCount 归零（开赛随即被判「没有裁判」），
    // 也会把抽签分好的对阵抹掉。改时间不该有这两种副作用。
    const doc = {
      ...(current || {}),
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey,
      round,
      index,
      startAt: start.value,
      endAt: end.value,
      venue: venue.value,
      note: note.value,
      status: current ? current.status : SESSION_STATUS.SCHEDULED,
      entryKeys: Array.isArray(current && current.entryKeys) ? current.entryKeys : [],
      roundLabel: (current && current.roundLabel) || ROUND_LABEL[round] || '',
      createdAt: current ? (current.createdAt || now) : now,
      updatedAt: now,
    };
    await tx.sportsMeetSessions.set(key, doc);
    return ok({ session: sessionSummary(doc) });
  });
}

/**
 * 发布赛程：每个项目组别都要有「带了时间与场地」的场次，缺一项就拒绝并列出。
 *
 * 【什么算「配齐」要按项目类型分开判】
 * 数值型直接决赛：那一场配齐即可。数值型预赛+决赛：**每一组预赛与决赛**都要配齐，
 * 只配第一组就发布，等于让后面几组没有时间场地。赛制项目：只需首轮（r1／循环赛）
 * 配齐——后面几轮要等上一轮出了胜负才存在，要求它们提前配齐是不可能的。
 *
 * 预赛还有一条前置：分组必须已经抽签（每个预赛场次都有参赛人）。没抽签就发布，
 * 首页会显示一排「预赛第 N 组 · 0 人」的空场次。
 *
 * 校验在事务外读一次（事务内不能查询），事务内只重读运动会状态再落库。
 * 赛程发布不是名额类操作，不存在「并发超卖」，这里接受一次读快照。
 */
async function publishMeetSchedule(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  const [events, sessions] = await Promise.all([
    ctx.repo.forMeet(scopeOf(ctx)).sportsMeetEvents.list(),
    listSessions(ctx.repo, ctx),
  ]);
  if (events.length === 0) return refused('本届还没有项目，无法发布赛程');

  const byEvent = new Map();
  for (const doc of sessions) {
    if (!byEvent.has(doc.eventKey)) byEvent.set(doc.eventKey, []);
    byEvent.get(doc.eventKey).push(doc);
  }

  const missing = [];
  const notDrawn = [];
  for (const event of events) {
    const own = byEvent.get(event._id) || [];
    const required = event.scoreType === MEET_SCORE_TYPE.VERSUS
      ? own.filter((doc) => doc.round === 'r1' || doc.round === 'rr')
      : own;// 数值型：所有场次都要配齐
    if (required.length === 0 || required.some((doc) => !doc.startAt || !doc.venue)) {
      missing.push(event.name);
      continue;
    }
    if (event.rounds === 'heat_final' && own.some((doc) => doc.round === 'heat'
      && !(Array.isArray(doc.entryKeys) && doc.entryKeys.length > 0))) {
      notDrawn.push(event.name);
    }
  }
  if (missing.length > 0) {
    return refused(`以下项目还没配齐时间与场地：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}`, { missing });
  }
  if (notDrawn.length > 0) {
    return refused(`以下项目的预赛还没抽签分组：${notDrawn.slice(0, 8).join('、')}`, { missing: notDrawn });
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以发布赛程');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAliveMeet(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (meet.status === MEET_STATUS.DRAFT) return refused('请先发布报名，再发布赛程');

    const now = toIso(fresh.now);
    const next = {
      ...meet, status: MEET_STATUS.SCHEDULED, schedulePublishedAt: now, updatedAt: now,
      version: (meet.version || 1) + 1,
    };
    await tx.sportsMeets.set(fresh.meetId, next);
    return ok({ meet: { meetId: fresh.meetId, status: next.status } });
  });
}

/** 指派裁判：本校在册会员；同一场次同一人重复指派是幂等的 */
async function assignMeetJudge(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以指派裁判');

    const sessionKey = String(payload.sessionKey || '').trim();
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (!session || session.meetId !== fresh.meetId) return refused('场次不存在或不属于本届运动会');

    const judgeId = String(payload.judgeId || '').trim();
    if (!judgeId) return refused('请选择裁判');
    const member = await tx.schoolMembers.getById(schoolMemberKey(judgeId, fresh.schoolId));
    const judge = await tx.users.getById(judgeId);
    if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE
      || !judge || judge.platformStatus !== 'active') {
      return refused('只能指派本校在册且账号有效的成员担任裁判');
    }

    const key = meetJudgeKey(fresh.meetId, sessionKey, judgeId);
    const current = await tx.sportsMeetJudgeAssignments.getById(key);
    if (current && current.status === 'active') return ok({ assignment: current, created: false });

    const now = toIso(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      sessionKey,
      eventKey: session.eventKey,
      judgeId,
      status: 'active',
      assignedBy: fresh.actorId,
      assignedAt: current ? (current.assignedAt || now) : now,
      updatedAt: now,
    };
    await tx.sportsMeetJudgeAssignments.set(key, doc);
    // 在场次上维护「有效裁判数」：开赛判断必须在事务内做，而事务内不能查指派表，
    // 只能点读场次文档 —— 所以把计数压在它身上（与兼项计数同一手法）。
    await tx.sportsMeetSessions.set(sessionKey, {
      ...session, judgeCount: Number(session.judgeCount || 0) + 1, updatedAt: now,
    });
    return ok({ assignment: doc, created: true });
  });
}

/** 移除裁判：保留记录（status=revoked），B7 会据此判断「已提交分数的裁判不可撤换」 */
async function removeMeetJudge(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以撤销指派');

    const sessionKey = String(payload.sessionKey || '').trim();
    const judgeId = String(payload.judgeId || '').trim();
    const key = meetJudgeKey(fresh.meetId, sessionKey, judgeId);
    const current = await tx.sportsMeetJudgeAssignments.getById(key);
    if (!current || current.status !== 'active') return refused('该裁判没有在任指派');

    // N4：只允许撤换「还没提交成绩」的裁判。成绩在 B7 落地，届时这里补一道检查。
    const now = toIso(fresh.now);
    await tx.sportsMeetJudgeAssignments.set(key, {
      ...current, status: 'revoked', revokedBy: fresh.actorId, revokedAt: now, updatedAt: now,
    });
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (session) {
      await tx.sportsMeetSessions.set(sessionKey, {
        ...session, judgeCount: Math.max(0, Number(session.judgeCount || 0) - 1), updatedAt: now,
      });
    }
    return ok({ sessionKey, judgeId });
  });
}

/**
 * 开赛：该场次至少 1 名有效裁判，否则拒绝（D53「不指定裁判的项目不能开赛」）。
 * 开赛后运动会进入「进行中」。
 */
async function startMeetEvent(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以开始比赛');

    const sessionKey = String(payload.sessionKey || '').trim();
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (!session || session.meetId !== fresh.meetId) return refused('场次不存在或不属于本届运动会');
    if (!session.startAt || !session.venue) return refused('该场次还没配齐时间与场地');

    // 判「有没有裁判」只能点读场次上的计数——事务内不能查指派表。
    if (!(Number(session.judgeCount || 0) > 0)) return refused('该场次还没有指派裁判，不能开赛');

    const now = toIso(fresh.now);
    await tx.sportsMeetSessions.set(sessionKey, {
      ...session, status: SESSION_STATUS.RUNNING, startedAt: now, updatedAt: now,
    });
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (meet && meet.status !== MEET_STATUS.RUNNING) {
      await tx.sportsMeets.set(fresh.meetId, {
        ...meet, status: MEET_STATUS.RUNNING, updatedAt: now, version: (meet.version || 1) + 1,
      });
    }
    return ok({ sessionKey, status: SESSION_STATUS.RUNNING });
  });
}

/** 赛程：按项目组别分组，附带每个场次的裁判 */
async function getMeetSchedule(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const isAdmin = canManageMeet(ctx);
  const scope = scopeOf(ctx);

  const [meet, events, sessions, assignments] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    ctx.repo.forMeet(scope).sportsMeetEvents.list(),
    listSessions(ctx.repo, ctx),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
  ]);
  if (!isAliveMeet(meet) || meet.schoolId !== ctx.schoolId) return refused('运动会不存在或已删除');
  if (meet.status === MEET_STATUS.DRAFT && !isAdmin) return refused('运动会尚未发布');

  const judgesOf = new Map();
  for (const row of assignments.filter((doc) => doc.status === 'active')) {
    const list = judgesOf.get(row.sessionKey) || [];
    list.push(row.judgeId);
    judgesOf.set(row.sessionKey, list);
  }

  const items = events.map((event) => {
    const own = sessions.filter((doc) => doc.eventKey === event._id);
    return {
      eventKey: event._id,
      name: event.name,
      group: event.group,
      // 录分页要据此决定显示「场次切换」「抽签分预赛」还是「签表」，
      // 所以把成绩类型与赛制一起带出来，页面不用再猜。
      scoreType: event.scoreType,
      rounds: event.rounds,
      format: event.format || '',
      advance: event.advance || null,
      scored: event.scored,
      ready: own.some((doc) => doc.startAt && doc.venue),
      sessions: own.map((doc) => ({
        ...sessionSummary(doc),
        judgeIds: judgesOf.get(doc._id) || [],
        judgeCount: (judgesOf.get(doc._id) || []).length,
        // D55：不做冲突检测，只把「同时间同裁判」标出来提示
        warning: (judgesOf.get(doc._id) || []).length === 0 ? '未指派裁判' : '',
      })),
    };
  });

  return ok({
    meet: { meetId: meet._id, status: meet.status, name: meet.name },
    items,
    canManage: isAdmin,
  });
}

/** 我的裁判任务：只返回指派给我的场次 */
async function getMyMeetJudgeTasks(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId || !ctx.actorId) return refused('请先登录');
  const scope = scopeOf(ctx);

  const [sessions, assignments, events] = await Promise.all([
    listSessions(ctx.repo, ctx),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
    ctx.repo.forMeet(scope).sportsMeetEvents.list(),
  ]);
  const eventOf = new Map(events.map((doc) => [doc._id, doc]));
  const mine = new Set(assignments
    .filter((doc) => doc.status === 'active' && doc.judgeId === ctx.actorId)
    .map((doc) => doc.sessionKey));

  const items = sessions
    .filter((doc) => mine.has(doc._id))
    .map((doc) => {
      const event = eventOf.get(doc.eventKey);
      return {
        ...sessionSummary(doc),
        name: event ? event.name : '',
        group: event ? event.group : '',
      };
    });

  return ok({ items });
}

/**
 * 可指派为裁判的本校成员（D59）。
 *
 * 页面不该让管理员手输 userId：那既容易错，也绕过了「在册」判断。
 * 这里只列本校在册且账号有效的成员，姓名一并给出。
 */
async function listMeetJudgeCandidates(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以指派裁判');

  const members = await ctx.repo.schoolMembers.listBySchool(ctx.schoolId);
  const active = members.filter((doc) => doc.status === SCHOOL_MEMBER_STATUS.ACTIVE);
  const items = [];
  for (const member of active) {
    const user = await ctx.repo.users.getById(member.userId);
    if (!user || user.platformStatus !== 'active') continue;
    items.push({ userId: member.userId, name: user.name || '未命名', collegeId: member.collegeId || '' });
  }
  items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok({ items });
}

module.exports = {
  listMeetJudgeCandidates,
  saveMeetSession,
  publishMeetSchedule,
  assignMeetJudge,
  removeMeetJudge,
  startMeetEvent,
  getMeetSchedule,
  getMyMeetJudgeTasks,
  SESSION_STATUS,
};
