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
 * 【多轮与赛制（B8a）】
 * 预赛各组与决赛各自发布（发布键按场次拆开），预赛只排名次、不计学院分；
 * 胜负项目不再手填名次，由签表/循环赛推出来（见 meet-advance.js）。
 * 本模块只负责「取数 → 排名 → 落库」，晋级与赛制的判定全在纯函数里。
 * ============================================================
 */

const {
  MEET_STATUS,
  meetScoreKey, meetJudgeKey, meetPublicationKey, meetResultRowKey, meetStandingKey,
  meetHonorKey, listAliveEvents,
} = require('../utils/meet-scope.js');
const { MEET_SCORE_TYPE } = require('./meet-event-catalog.js');
const { normalizeMeasure, formatMeasure } = require('./meet-measure.js');
const {
  MEET_FORMAT, rankByValue, bracketStandings, roundRobinStandings, groupKnockoutStandings,
} = require('./meet-advance.js');
const { matchesOf, roundNoOf } = require('./meet-advance-service.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const { collegeKey } = require('../utils/school.js');
const { unchanged, touchEvent, liveMeet } = require('./meet-consistency.js');
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

/**
 * 裁判人数过多的风险提示（Q2：汇总维持「去极值平均」，但人数 ≥5 时要说清后果）。
 *
 * 3 人去极值后只剩中间值，等价于「取中位数」，与手计时规则一致。5 人以上时
 * 去掉最高最低再平均，可能得到一个**没有任何秒表读出过**的成绩
 * （12.00/12.01/12.02/12.30/12.40 → 12.15 秒），足以改变名次。
 *
 * 只提示、不拦截：用户已裁决不改算法，但赛时应该看见这句话。
 */
function judgeCountWarning(judgeCount) {
  if (Number(judgeCount) < 5) return '';
  return `${judgeCount} 名裁判取平均，可能产生无人读出过的成绩（如 5 人给出 12.00/12.01/12.02/12.30/12.40 会算成 12.15 秒）；3 人以内不存在这个问题`;
}

/**
 * 胜负项目的名次：按赛制分支。
 *
 * 单败只看淘汰赛；小组+淘汰要先算小组名次再算淘汰赛；循环赛整体一套。
 * 抽成一个函数，是因为预览与发布必须给出**同一份**名次——两处各写一遍，
 * 迟早出现「预览看到第 2、发布变成第 3」。
 */
function versusStandingsOf({ format, entryKeys, totalRounds, bracket, matches }) {
  if (format === MEET_FORMAT.ROUND_ROBIN) {
    return roundRobinStandings({ entries: entryKeys, matches });
  }
  if (format === MEET_FORMAT.GROUP_KNOCKOUT) {
    return groupKnockoutStandings({
      entries: entryKeys,
      groupEntries: (bracket && bracket.groupEntries) || {},
      advancePerGroup: (bracket && bracket.groups && bracket.groups.advancePerGroup) || 1,
      groupMatches: matches.filter((match) => match.stage === 'group'),
      knockoutMatches: matches.filter((match) => match.stage !== 'group'),
      totalRounds,
    });
  }
  return bracketStandings({
    entries: entryKeys,
    totalRounds,
    matches: matches.filter((match) => match.stage !== 'group'),
  });
}
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

/**
 * 竞赛排名 1,2,2,4（D73）：同值同名次，后续跳号。
 * 实现放在 meet-advance.js 里由这里与晋级判定共用——两处各写一份，
 * 迟早会在「并列算不算晋级」这种边界上分叉。
 */
const rankRows = rankByValue;

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

/**
 * 参赛记录的展示标签：学院名 + 学生姓名（工作视图用）。
 *
 * 【为什么服务端算而不是页面拼】
 * 页面只有 userIds 与 collegeId，逐个查账号再拼字符串，等于把「姓名怎么取」
 * 这份逻辑复制到每个页面。集中在这里，录分页与预览页永远是同一个口径。
 *
 * 【姓名取 realName || nickName】
 * 录分与预览是给执裁人和管理员的工作视图，场上对人对不出昵称。公开成绩单
 * （listMeetPublishedResults）才按 D95 只显示昵称——两个口径分开，别混。
 */
async function entryLabels(ctx, entries) {
  const collegeIds = [...new Set(entries.map((doc) => doc.collegeId).filter(Boolean))];
  const userIds = [...new Set(entries.flatMap(
    (doc) => (Array.isArray(doc.userIds) ? doc.userIds : []),
  ))];
  const [colleges, users] = await Promise.all([
    Promise.all(collegeIds.map((collegeId) => ctx.repo.colleges.getById(
      collegeKey(ctx.schoolId, collegeId),
    ))),
    Promise.all(userIds.map((userId) => ctx.repo.users.getById(userId))),
  ]);
  const collegeName = new Map();
  collegeIds.forEach((collegeId, index) => {
    collegeName.set(collegeId, (colleges[index] && colleges[index].name) || collegeId);
  });
  const memberName = new Map();
  userIds.forEach((userId, index) => {
    const user = users[index];
    memberName.set(userId, (user && (user.realName || user.nickName)) || userId);
  });
  const labels = new Map();
  for (const entry of entries) {
    const names = (Array.isArray(entry.userIds) ? entry.userIds : [])
      .map((userId) => memberName.get(userId) || userId);
    labels.set(entry._id, {
      collegeId: entry.collegeId,
      collegeName: collegeName.get(entry.collegeId) || entry.collegeId,
      memberText: names.join('、'),
    });
  }
  return labels;
}

/** 我的裁判任务里，某个场次需要录哪些参赛记录 */
async function getMeetSessionScores(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = scopeOf(ctx);
  const sessionKey = String(payload.sessionKey || '').trim();
  if (!sessionKey) return refused('请指定场次');

  const [session, entries, scores, assignment, event, sessions, assignments] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetSessions.getById(sessionKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetScores.list(),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.getById(
      meetJudgeKey(ctx.meetId, sessionKey, ctx.actorId || '-'),
    ),
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
  ]);
  if (!session || session.meetId !== ctx.meetId) return refused('场次不存在或不属于本届运动会');
  const doc = event.find((row) => row._id === session.eventKey);
  // 胜负项目没有分数可录：让裁判看到「这场由谁判胜」，而不是把他带到录分框前再报错
  if (doc && doc.scoreType === MEET_SCORE_TYPE.VERSUS) {
    return ok({
      session: {
        sessionKey, eventKey: session.eventKey, round: session.round,
        startAt: session.startAt, venue: session.venue, judgeCount: session.judgeCount || 0,
        winnerEntryKey: session.winnerEntryKey || '',
      },
      versus: true,
      items: (session.entryKeys || []).filter(Boolean).map((entryKey) => {
        const entry = entries.find((row) => row._id === entryKey) || {};
        return { entryKey, collegeId: entry.collegeId || '', userIds: entry.userIds || [], myScore: null };
      }),
      canEnter: false,
    });
  }

  const isAdmin = canManageMeet(ctx);
  const docEvent = doc || {};
  if (!isAdmin && !assignments.some(row => row.status === 'active' && row.judgeId === ctx.actorId
    && sessions.some(item => item._id === row.sessionKey && item.eventKey === session.eventKey))) return ok({ session: {sessionKey, eventKey: session.eventKey}, items: [], canEnter: false });
  // 预赛分组的场次只列本组的人：把全项目的人都摆到「预赛第 2 组」的录分页上，
  // 裁判必然会录错行。没有 entryKeys 的场次（直接决赛）才是全项目。
  const assigned = Array.isArray(session.entryKeys) && session.entryKeys.length > 0
    ? new Set(session.entryKeys)
    : null;
  // 道次来自场次上的 lanes 映射（Q7）。没有道次的项目（长跑、田赛）记 0，
  // 排序时排到最后，不影响录分。
  const lanes = (session.lanes && typeof session.lanes === 'object') ? session.lanes : {};
  const labels = await entryLabels(ctx, entries.filter(row => row.eventKey === session.eventKey));
  const own = entries
    .filter((doc) => doc.eventKey === session.eventKey && doc.status === 'approved'
      && (assigned ? assigned.has(doc._id) : docEvent.rounds !== 'heat_final'))
    .map((doc) => {
      const mine = scores.find((row) => row.entryKey === doc._id
        && row.sessionKey === sessionKey && row.judgeId === (isAdmin && payload.judgeId ? String(payload.judgeId) : ctx.actorId));
      const label = labels.get(doc._id) || {};
      return {
        entryKey: doc._id,
        collegeId: doc.collegeId,
        // 学院名与学生姓名：录分页原先只显示 collegeId（「c01」），裁判在场上
        // 根本对不出人。姓名取 realName||nickName——这是给执裁人的工作视图，
        // 不是公开资料页（D95 的昵称口径只约束公开列表，见 listMeetPublishedResults）。
        collegeName: label.collegeName || doc.collegeId,
        memberText: label.memberText || '',
        userIds: doc.userIds,
        lane: Number(lanes[doc._id]) || 0,
        myScore: mine ? { text: mine.rawText, state: mine.state } : null,
      };
    })
    // 按道次排：裁判按道点名与记录，不按主键（主键顺序对现场毫无意义）
    .sort((a, b) => (a.lane || 99) - (b.lane || 99));

  // 能不能录（D70 代录 + B9c 批量指派）：
  //   · 管理员可代录任意场次；
  //   · 裁判本人被指派到本场次；
  //   · **或**被指派到同一项目的任一场次——连续几个项目同一批裁判时，
  //     逐场逐个指派不现实，同项目内默认他们就是同一组人。
  const eventSessions = new Set(sessions
    .filter((doc) => doc.eventKey === session.eventKey)
    .map((doc) => doc._id));
  const assignedInEvent = assignments.some((doc) => doc.status === 'active'
    && doc.judgeId === ctx.actorId && eventSessions.has(doc.sessionKey));
  // 本场已选裁判（姓名版）：录分页要能看到这场有谁执裁
  const judgeNames = new Map();
  for (const row of assignments.filter((doc) => doc.status === 'active'
    && doc.sessionKey === sessionKey)) {
    const user = await ctx.repo.users.getById(row.judgeId);
    judgeNames.set(row.judgeId, (user && (user.realName || user.nickName)) || row.judgeId);
  }
  const judges = assignments
    .filter((doc) => doc.status === 'active' && doc.sessionKey === sessionKey)
    .map((doc) => ({ judgeId: doc.judgeId, name: judgeNames.get(doc.judgeId) || doc.judgeId }));

  return ok({
    session: {
      sessionKey, eventKey: session.eventKey, round: session.round,
      startAt: session.startAt, venue: session.venue, judgeCount: judges.length,
      judges,
    },
    items: own,
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
    ctx = await freshMeetContext(tx, ctx);
    if (!meetReadable(ctx) || !liveMeet(ctx)) return refused('账号或运动会已失效');
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    if (!session || session.meetId !== ctx.meetId) return refused('场次不存在或不属于本届运动会');
    const event = await tx.sportsMeetEvents.getById(session.eventKey);
    if (!event) return refused('项目组别不存在');
    if (event.scoreType === MEET_SCORE_TYPE.VERSUS) {
      return refused('胜负项目不录入数值成绩，名次由签表自动产生');
    }
    const entry = await tx.sportsMeetEntries.getById(entryKey);
    if (!entry || entry.eventKey !== session.eventKey || entry.status !== 'approved') {
      return refused('参赛记录不存在或未通过审核');
    }
    if ((Array.isArray(session.entryKeys) && session.entryKeys.length > 0
      && !session.entryKeys.includes(entryKey))
      || (event.rounds === 'heat_final' && !(session.entryKeys || []).length)) {
      return refused('该参赛记录不在本场名单中，请先完成分组或晋级');
    }
    // 只有被指派的裁判（或管理员代录 D70）可以录分
    const assignment = await tx.sportsMeetJudgeAssignments.getById(
      meetJudgeKey(ctx.meetId, sessionKey, ctx.actorId),
    );
    const isAdmin = canManageMeet(ctx);
    if (!isAdmin && !(assignment && assignment.status === 'active')) {
      return refused('你不是该场次的裁判');
    }
    const judgeId = isAdmin && payload.judgeId ? String(payload.judgeId) : ctx.actorId;
    const scoringJudge = await tx.sportsMeetJudgeAssignments.getById(meetJudgeKey(ctx.meetId, sessionKey, judgeId));
    if (!scoringJudge || !['active', 'revoked'].includes(scoringJudge.status)) return refused('代录必须选择本场已指派的裁判');
    const publication = await tx.sportsMeetPublications.getById(meetPublicationKey(ctx.meetId, event._id,
      event.rounds === 'final' ? 'all' : sessionKey));
    if (publication && !isAdmin) return refused('成绩已发布，仅管理员可以更正并重新发布');

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
    await touchEvent(tx, session.eventKey);
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
  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!meetReadable(fresh) || !liveMeet(fresh)) return refused('账号或运动会已失效');
    const isAdmin = canManageMeet(fresh);
    const judgeId = isAdmin && payload.judgeId ? String(payload.judgeId) : fresh.actorId;
    const session = await tx.sportsMeetSessions.getById(sessionKey);
    const entry = await tx.sportsMeetEntries.getById(entryKey);
    if (!session || session.meetId !== fresh.meetId || session.schoolId !== fresh.schoolId
      || !entry || entry.eventKey !== session.eventKey || entry.status !== 'approved'
      || ((session.entryKeys || []).length && !session.entryKeys.includes(entryKey))) return refused('场次或参赛名单已变化');
    const assignment = await tx.sportsMeetJudgeAssignments.getById(meetJudgeKey(fresh.meetId, sessionKey, judgeId));
    if (!assignment || (!isAdmin && assignment.status !== 'active')) return refused('你不是该场次的有效裁判');
    const event = await tx.sportsMeetEvents.getById(session.eventKey);
    if (!event || (event.rounds === 'heat_final' && !(session.entryKeys || []).length)) return refused('请先完成分组或晋级');
    const publication = await tx.sportsMeetPublications.getById(meetPublicationKey(fresh.meetId, event._id,
      event.rounds === 'final' ? 'all' : sessionKey));
    if (publication && !isAdmin) return refused('成绩已发布，仅管理员可以更正并重新发布');
    const key = meetScoreKey(entryKey, sessionKey, judgeId);
    const current = await tx.sportsMeetScores.getById(key);
    if (!current || current.schoolId !== fresh.schoolId || current.meetId !== fresh.meetId) return refused('请先填写成绩');
    if (current.state === SCORE_STATE.SUBMITTED) return ok({ entryKey, sessionKey, state: current.state });
    const now = toIso(ctx.now);
    await tx.sportsMeetScores.set(key, { ...current, state: SCORE_STATE.SUBMITTED, updatedAt: now });
    await touchEvent(tx, session.eventKey);
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

  const own = sessions
    .filter((doc) => doc.eventKey === eventKey)
    .sort((a, b) => Number(a.index) - Number(b.index));
  if (own.length === 0) return refused('该项目组别还没有场次');

  const isVersus = event.scoreType === MEET_SCORE_TYPE.VERSUS;
  // 多枪决赛：全部场次合成一份预览，与发布口径保持一致
  const aggregateFinal = !isVersus && event.rounds === 'final';

  // 场次选择：显式指定 > 唯一场次 > 拒绝。多轮项目绝不默认第一场——
  // 管理员想预览决赛，系统却给他预赛第 1 组，接着就会把决赛发成预赛。
  let session = null;
  if (aggregateFinal) {
    session = null;
  } else if (payload.sessionKey) {
    session = own.find((doc) => doc._id === String(payload.sessionKey));
    if (!session) return refused('场次不存在或不属于该项目');
  } else if (own.length === 1) {
    session = own[0];
  } else {
    return refused('该项目有多个场次，请指定要预览哪一场', {
      sessions: own.map((doc) => ({
        sessionKey: doc._id,
        round: doc.round,
        roundLabel: doc.roundLabel || doc.round,
        index: doc.index,
      })),
    });
  }
  const sessionKey = session ? session._id : 'all';
  const judgeIds = session
    ? assignments
      .filter((doc) => doc.status === 'active' && doc.sessionKey === sessionKey)
      .map((doc) => doc.judgeId)
    : [];

  const assigned = session && Array.isArray(session.entryKeys) && session.entryKeys.length > 0
    ? new Set(session.entryKeys) : null;
  const approved = entries.filter((doc) => doc.eventKey === eventKey
    && doc.status === 'approved' && (!assigned || assigned.has(doc._id)));

  if (isVersus) {
    // 胜负项目不再手填名次：预览直接给「签表打完了没有、当前名次如何」
    const matches = matchesOf(sessions, eventKey);
    const bracket = event.bracket || null;
    const format = (bracket && bracket.format) || event.format || MEET_FORMAT.SINGLE_ELIM;
    const totalRounds = bracket ? Number(bracket.totalRounds) || 1 : 1;
    const entryKeys = approved.map((doc) => doc._id);
    const standings = versusStandingsOf({
      format, entryKeys, totalRounds, bracket, matches,
    });
    return ok({
      event: { eventKey, name: event.name, group: event.group, scoreType: event.scoreType },
      sessionKey,
      judgeIds,
      versus: true,
      format,
      complete: Boolean(standings.ok),
      message: standings.ok ? '' : standings.message,
      standings: standings.ok ? standings.rows : [],
      items: [],
      missing: [],
    });
  }

  let values;
  let missing;
  if (aggregateFinal) {
    values = new Map();
    missing = [];
    for (const row of own) {
      const rowJudges = assignments
        .filter((doc) => doc.status === 'active' && doc.sessionKey === row._id)
        .map((doc) => doc.judgeId);
      const scoped = Array.isArray(row.entryKeys) && row.entryKeys.length > 0
        ? approved.filter((doc) => row.entryKeys.includes(doc._id))
        : approved;
      const summary = summarizeScores(scoped, scores, rowJudges, eventKey, row._id);
      for (const [key, value] of summary.values) values.set(key, value);
      missing.push(...summary.missing);
    }
  } else {
    const summary = summarizeScores(approved, scores, judgeIds, eventKey, sessionKey);
    values = summary.values;
    missing = summary.missing;
  }

  // 多枪项目的裁判数按场次算，取最大值（各枪人数可能不同）
  const judgeCounts = own.map((row) => assignments
    .filter((doc) => doc.status === 'active' && doc.sessionKey === row._id).length);
  const warning = judgeCountWarning(judgeCounts.length ? Math.max(...judgeCounts) : judgeIds.length);

  const previewLabels = await entryLabels(ctx, approved);
  return ok({
    event: { eventKey, name: event.name, group: event.group, scoreType: event.scoreType, order: event.order },
    sessionKey,
    warning,
    round: session ? session.round : 'final',
    roundLabel: session ? (session.roundLabel || session.round) : '决赛（合并排名）',
    // 多枪决赛合成一份正式成绩；预赛只排名次不计分
    official: aggregateFinal ? true : session.round === 'final',
    multiSession: aggregateFinal && own.length > 1,
    sessionCount: own.length,
    judgeIds,
    versus: false,
    missing: missing.map((doc) => ({ entryKey: doc._id, collegeId: doc.collegeId })),
    items: approved.map((doc) => {
      const label = previewLabels.get(doc._id) || {};
      return {
        entryKey: doc._id,
        collegeId: doc.collegeId,
        // 预览同样要能对上人：原先只显示学院编号（用户反馈「成绩页面显示为编号」）
        collegeName: label.collegeName || doc.collegeId,
        memberText: label.memberText || '',
        userIds: doc.userIds,
        lane: Number((session && session.lanes && session.lanes[doc._id]) || 0),
        value: values.get(doc._id),
        text: values.get(doc._id) === null
          ? '未收齐'
          : formatMeasure(event.scoreType, values.get(doc._id)),
      };
    }),
  });
}

/**
 * 发布正式结果（D84／D85）。
 *
 * 【每个场次单独发布】
 * 有预赛的项目，各组比完的时间不同，必须能分别发布。所以发布键按场次拆开
 * （见 meetPublicationKey），预赛的行与决赛的行互不覆盖。
 *
 * 【预赛发布不计分】
 * 预赛只决定谁进决赛。若预赛也给学院分，一个项目就会被计两次分，学院总榜
 * 直接失真。所以 `official` 只在决赛（或胜负项目）为真，其余一律 0 分。
 *
 * 【胜负项目不再手填名次（D51）】
 * 名次由签表/循环赛推出来。签表没打完就发布会被拒绝，并告诉管理员还差几场——
 * 半程名次没有意义，硬发只会让学院总榜在中途反复变动。
 *
 * @param {Object} payload { eventKey, sessionKey?, voidEntryKeys?: string[], reason? }
 */
async function publishMeetResults(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');

  const scope = scopeOf(ctx);
  const event = await ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey);
  const [meet, entries, scores, sessions, assignments, publications] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetScores.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetJudgeAssignments.list(),
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
  ]);
  if (!isAlive(meet) || meet.schoolId !== ctx.schoolId) return refused('运动会不存在或已删除');
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canPublishMeetResult(ctx)) return refused('只有校级管理员及以上或本届总裁判可以发布成绩');

  const ownSessions = sessions
    .filter((doc) => doc.eventKey === eventKey)
    .sort((a, b) => Number(a.index) - Number(b.index));
  if (ownSessions.length === 0) return refused('该项目组别还没有场次');

  const isVersus = event.scoreType === MEET_SCORE_TYPE.VERSUS;
  const bracket = event.bracket || null;
  const format = (bracket && bracket.format) || event.format || MEET_FORMAT.SINGLE_ELIM;
  const isRoundRobin = isVersus && format === MEET_FORMAT.ROUND_ROBIN;

  // rounds='final' 的数值项目可能分多枪：各枪只跑一次、成绩合并排名，不晋级。
  // 这类项目必须「一次性发布全部场次」，不能按场次各发各的——否则每条枪都会
  // 产生一份 1..N 的名次与学院分，同一项目被算好几次。
  const aggregateFinal = !isVersus && event.rounds === 'final';

  let session = null;
  if (isVersus && !isRoundRobin) {
    if (!bracket) return refused('请先编排签表');
    const totalRounds = Number(bracket.totalRounds) || 1;
    session = ownSessions.find((doc) => roundNoOf(doc) === totalRounds) || null;
    if (!session) return refused('签表还没有决赛场次');
  } else if (!isVersus && !aggregateFinal) {
    const wanted = String(payload.sessionKey || '').trim();
    if (wanted) {
      session = ownSessions.find((doc) => doc._id === wanted);
      if (!session) return refused('场次不存在或不属于该项目');
    } else if (ownSessions.length === 1) {
      session = ownSessions[0];
    } else {
      return refused('该项目有多个场次（预赛/决赛），请指定要发布哪一场', {
        sessions: ownSessions.map((doc) => ({
          sessionKey: doc._id, round: doc.round, roundLabel: doc.roundLabel || doc.round, index: doc.index,
        })),
      });
    }
  }

  // `all` 是「整项目一条成绩」的发布键段：循环赛与多枪决赛都用它
  const sessionKey = session ? session._id : 'all';
  const official = isVersus ? true : (aggregateFinal ? true : session.round === 'final');

  let approved;
  if (isVersus || aggregateFinal) {
    approved = entries.filter((doc) => doc.eventKey === eventKey && doc.status === 'approved');
  } else {
    const assigned = Array.isArray(session.entryKeys) && session.entryKeys.length > 0
      ? new Set(session.entryKeys) : null;
    if (!assigned && event.rounds === 'heat_final' && session.round === 'final') {
      return refused('决赛参赛名单还没产生，请先完成晋级');
    }
    approved = entries.filter((doc) => doc.eventKey === eventKey && doc.status === 'approved'
      && (!assigned || assigned.has(doc._id)));
  }
  if (approved.length === 0) return refused('该项目还没有通过审核的参赛名单');

  const voidKeys = new Set(Array.isArray(payload.voidEntryKeys) ? payload.voidEntryKeys : []);
  const rows = [];

  if (isVersus) {
    const matches = matchesOf(sessions, eventKey);
    const entryKeys = approved.map((doc) => doc._id);
    const standings = versusStandingsOf({
      format,
      entryKeys,
      totalRounds: Number(bracket && bracket.totalRounds) || 1,
      bracket,
      matches,
    });
    if (!standings.ok) {
      return refused(standings.message || '赛制还没有打完，不能发布', { pending: standings.pending });
    }
    const byKey = new Map(approved.map((doc) => [doc._id, doc]));
    const ranked = new Set();
    for (const row of standings.rows) {
      const entry = byKey.get(row.entryKey);
      if (!entry) continue;
      ranked.add(entry._id);
      const isVoid = voidKeys.has(entry._id);
      rows.push({
        entryKey: entry._id, collegeId: entry.collegeId, userIds: entry.userIds,
        value: null, rank: isVoid ? null : row.rank,
        status: isVoid ? ROW_STATUS.VOID : ROW_STATUS.RESULT,
        points: isVoid ? 0 : pointsOf(row.rank, event.scored, event.entryForm),
      });
    }
    // 编排之后才通过审核、没进签表的记录：不给名次，避免「没比赛却有分」
    for (const entry of approved) {
      if (ranked.has(entry._id)) continue;
      rows.push({
        entryKey: entry._id, collegeId: entry.collegeId, userIds: entry.userIds,
        value: null, rank: null, status: ROW_STATUS.VOID, points: 0,
      });
    }
  } else {
    let values;
    if (aggregateFinal) {
      // 多枪：逐枪汇总后合并。任何一枪没有裁判或没录齐，整项目都不能发布——
      // 只发一部分会让总排名缺人，名次与学院分全错。
      values = new Map();
      const missing = [];
      const noJudge = [];
      for (const row of ownSessions) {
        const judgeIds = assignments
          .filter((doc) => doc.status === 'active' && doc.sessionKey === row._id)
          .map((doc) => doc.judgeId);
        if (judgeIds.length === 0) {
          noJudge.push(row.roundLabel || row.round);
          continue;
        }
        const scoped = Array.isArray(row.entryKeys) && row.entryKeys.length > 0
          ? approved.filter((doc) => row.entryKeys.includes(doc._id))
          : approved;
        const summary = summarizeScores(scoped.filter(entry => !voidKeys.has(entry._id)), scores, judgeIds, eventKey, row._id);
        for (const [key, value] of summary.values) values.set(key, value);
        missing.push(...summary.missing);
      }
      if (noJudge.length > 0) {
        return refused(`以下场次还没有指派裁判：${noJudge.join('、')}`);
      }
      const unassigned = approved.filter((doc) => !voidKeys.has(doc._id) && !values.has(doc._id));
      if (unassigned.length > 0) {
        return refused(`还有 ${unassigned.length} 条参赛记录没有编入任何一枪，请先分组`);
      }
      if (missing.length > 0) {
        return refused(`还有 ${missing.length} 条参赛记录没有收齐裁判成绩`, {
          missing: missing.map((doc) => doc._id),
        });
      }
    } else {
      const judgeIds = assignments
        .filter((doc) => doc.status === 'active' && doc.sessionKey === sessionKey)
        .map((doc) => doc.judgeId);
      if (judgeIds.length === 0) return refused('该场次还没有指派裁判');

      const summary = summarizeScores(approved.filter(entry => !voidKeys.has(entry._id)), scores, judgeIds, eventKey, sessionKey);
      if (summary.missing.length > 0) {
        return refused(`还有 ${summary.missing.length} 条参赛记录没有收齐裁判成绩`, {
          missing: summary.missing.map((doc) => doc._id),
        });
      }
      values = summary.values;
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
      // 预赛只排名次、不计学院分：决赛才产生积分
      row.points = official ? pointsOf(row.rank, event.scored, event.entryForm) : 0;
      rows.push(row);
    }
  }

  const publicationKey = meetPublicationKey(ctx.meetId, eventKey, sessionKey);
  const current = publications.find((doc) => doc._id === publicationKey);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canPublishMeetResult(fresh)) return refused('只有校级管理员及以上或本届总裁判可以发布成绩');
    if (!liveMeet(fresh)) return refused('运动会不存在或已删除');
    if (!await unchanged(tx, 'sportsMeetEvents', [event])
      || !await unchanged(tx, 'sportsMeetSessions', ownSessions)
      || !await unchanged(tx, 'sportsMeetEntries', approved)
      || !await unchanged(tx, 'sportsMeetScores', scores.filter(row => row.eventKey === eventKey))
      || !await unchanged(tx, 'sportsMeetJudgeAssignments', assignments.filter(row => row.eventKey === eventKey))) return refused('报名、裁判或成绩已变化，请刷新后重试');
    const latest = await tx.sportsMeetPublications.getById(publicationKey);
    if ((latest ? latest.version : null) !== (current ? current.version : null)) {
      return refused('发布状态已变化，请刷新后重试');
    }
    await touchEvent(tx, eventKey);
    const now = toIso(fresh.now);
    const version = (latest ? Number(latest.version) || 0 : 0) + 1;
    const rules = {
      personalPoints: [...PERSONAL_POINTS],
      teamMultiplier: TEAM_MULTIPLIER,
      tieRanking: 'competition',
      average: 'trim-extremes',
      official,
      ...(isVersus ? { format } : {}),
      ...(official ? {} : { advance: event.advance || null }),
    };
    // rows 摘要随发布存档：下次重发时要靠它把旧学院的分减回去。
    // 不存档的话，「无痕更正」发一次就把学院总分翻一倍——结果行被同主键覆盖，
    // 旧值无从得知，而总榜是累加出来的。
    const rowDigest = rows.map((row) => ({
      entryKey: row.entryKey,
      collegeId: row.collegeId,
      userIds: Array.isArray(row.userIds) ? [...row.userIds] : [],
      rank: row.rank,
      points: row.points,
      status: row.status,
    }));
    await tx.sportsMeetPublications.set(publicationKey, {
      schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey,
      version, status: 'published', rules,
      sessionKey,
      round: isVersus ? 'versus' : (aggregateFinal ? 'final' : session.round),
      roundLabel: isVersus
        ? '赛制'
        : (aggregateFinal ? (ownSessions.length > 1 ? '决赛（多枪合并）' : '决赛')
          : (session.roundLabel || session.round)),
      official,
      rowCount: rows.length,
      voidCount: rows.filter((row) => row.status === ROW_STATUS.VOID).length,
      rows: rowDigest,
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

    // 学院总分与个人荣誉：**只在正式成绩发布时**更新。
    // 预赛的名次是组内排名，不是奖牌名次，计进去会让总榜出现一批假金牌。
    if (official) {
      const delta = new Map();
      const bump = (collegeId, sign, row) => {
        const key = String(collegeId || '');
        if (!key) return;
        const cur = delta.get(key) || { points: 0, gold: 0, silver: 0, bronze: 0 };
        cur.points += sign * Number(row.points || 0);
        if (Number(row.rank) === 1) cur.gold += sign;
        if (Number(row.rank) === 2) cur.silver += sign;
        if (Number(row.rank) === 3) cur.bronze += sign;
        delta.set(key, cur);
      };
      // 旧行先减、新行后加：净额为 0 的学院一次都不用写
      const oldRows = Array.isArray(latest && latest.rows) ? latest.rows : [];
      for (const row of oldRows) bump(row.collegeId, -1, row);
      for (const row of rowDigest) bump(row.collegeId, 1, row);

      for (const [collegeId, change] of delta) {
        const key = meetStandingKey(fresh.meetId, collegeId);
        const doc = await tx.sportsMeetStandings.getById(key);
        const base = doc || {
          _id: key, schoolId: fresh.schoolId, meetId: fresh.meetId, collegeId,
          total: 0, gold: 0, silver: 0, bronze: 0, createdAt: now, updatedAt: now,
        };
        await tx.sportsMeetStandings.set(key, {
          ...base,
          total: Number(base.total || 0) + change.points,
          gold: Number(base.gold || 0) + change.gold,
          silver: Number(base.silver || 0) + change.silver,
          bronze: Number(base.bronze || 0) + change.bronze,
          updatedAt: now,
        });
      }

      // 旧版有、新版没有的记录（例如报名被撤回、被排除出签表）：
      // 荣誉必须一并作废，否则「我的荣誉」会一直挂着一个已不成立的第一名。
      const liveKeys = new Set(rowDigest.map((row) => row.entryKey));
      for (const row of oldRows) {
        if (liveKeys.has(row.entryKey)) continue;
        await tx.sportsMeetHonors.set(meetHonorKey(fresh.meetId, row.entryKey), {
          _id: meetHonorKey(fresh.meetId, row.entryKey),
          schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey,
          entryKey: row.entryKey, collegeId: row.collegeId,
          userIds: Array.isArray(row.userIds) ? [...row.userIds] : [],
          rank: null, points: 0, version, publishedAt: now, updatedAt: now,
        });
      }

      // 荣誉一条参赛记录一条；不再得奖的记录直接覆盖成「无名次」，
      // 而不是留着旧名次——那会让「我的荣誉」显示一个已经作废的第一名。
      for (const row of rowDigest) {
        const key = meetHonorKey(fresh.meetId, row.entryKey);
        const worth = row.status === ROW_STATUS.RESULT && Number(row.rank) > 0;
        await tx.sportsMeetHonors.set(key, {
          _id: key,
          schoolId: fresh.schoolId,
          meetId: fresh.meetId,
          eventKey,
          entryKey: row.entryKey,
          collegeId: row.collegeId,
          userIds: Array.isArray(row.userIds) ? [...row.userIds] : [],
          rank: worth ? row.rank : null,
          points: worth ? row.points : 0,
          version,
          publishedAt: now,
          updatedAt: now,
        });
      }
    }
    // 多枪项目的发布键是 'all'，没有对应指派记录，要回到各场次上取人数
    const publishWarning = judgeCountWarning(aggregateFinal
      ? Math.max(0, ...ownSessions.map((row) => assignments.filter(
        (doc) => doc.status === 'active' && doc.sessionKey === row._id,
      ).length))
      : assignments.filter((doc) => doc.status === 'active' && doc.sessionKey === sessionKey).length);

    return ok({
      warning: publishWarning,
      publication: {
        eventKey, version, sessionKey, official,
        rows: rows.map((row) => ({
          entryKey: row.entryKey, collegeId: row.collegeId,
          rank: row.rank, points: row.points, status: row.status,
        })),
      },
    });
  });
}

/**
 * 已发布结果：读该项目所有场次的当前版本。
 *
 * `items` 只返回**正式成绩**（决赛／赛制）的行——学院总榜、个人荣誉都按它算。
 * 预赛各行放在 `rounds` 里：它们是过程数据，既不该进荣誉，也不该进总榜。
 */
async function getPublishedResults(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const parent = await ctx.repo.sportsMeets.getById(ctx.meetId);
  if (!isAlive(parent) || parent.schoolId !== ctx.schoolId || (parent.status === 'draft' && !canManageMeet(ctx))) return refused('运动会不存在或尚未发布');
  const scope = scopeOf(ctx);
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');

  const [publications, rows, event, sessions] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
    ctx.repo.forMeet(scope).sportsMeetResultRows.list(),
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
  ]);
  const mine = publications.filter((doc) => doc.eventKey === eventKey);
  if (mine.length === 0) return ok({ published: false, eventKey, rounds: [] });

  const labelOf = new Map(sessions.map((doc) => [doc._id, doc.roundLabel || doc.round]));
  // 与 listMeetPublishedResults 同一套口径：学院名取当届快照、学生名只显示昵称
  const collegeName = new Map();
  for (const row of await ctx.repo.forMeet(scope).sportsMeetColleges.list()) {
    if (row && row.schoolId === ctx.schoolId) collegeName.set(row.collegeId, row.name || row.collegeId);
  }
  const nickOf = new Map();
  for (const userId of [...new Set(rows.flatMap((row) => (Array.isArray(row.userIds) ? row.userIds : [])))]) {
    const user = await ctx.repo.users.getById(userId);
    nickOf.set(userId, (user && user.nickName) || '未设置昵称');
  }
  const rowLabel = (row) => ({
    entryKey: row.entryKey,
    collegeId: row.collegeId,
    collegeName: collegeName.get(row.collegeId) || row.collegeId,
    memberText: (Array.isArray(row.userIds) ? row.userIds : [])
      .map((userId) => nickOf.get(userId) || userId).join('、'),
    rank: row.rank,
    value: row.value,
    text: row.value === null || row.value === undefined ? '—' : formatMeasure(event.scoreType, row.value),
    points: row.points,
    status: row.status,
  });
  const rounds = mine
    .sort((a, b) => Number(a.official ? 1 : 0) - Number(b.official ? 1 : 0)
      || String(a.sessionKey).localeCompare(String(b.sessionKey)))
    .map((doc) => ({
      sessionKey: doc.sessionKey,
      round: doc.round,
      roundLabel: doc.roundLabel || labelOf.get(doc.sessionKey) || '',
      official: Boolean(doc.official),
      version: doc.version,
      publishedAt: doc.publishedAt,
      reason: doc.reason || '',
      items: rows
        .filter((row) => row.publicationKey === doc._id && row.version === doc.version)
        .map(rowLabel),
    }));

  const official = rounds.find((row) => row.official) || null;
  return ok({
    published: Boolean(official),
    eventKey,
    event: event ? { name: event.name, group: event.group, scored: event.scored } : null,
    publication: official ? {
      version: official.version,
      publishedAt: official.publishedAt,
      rowCount: official.items.length,
      voidCount: official.items.filter((row) => row.status === ROW_STATUS.VOID).length,
      reason: official.reason,
    } : null,
    items: official ? official.items : [],
    rounds,
  });
}

/**
 * 本届已发布成绩（任何本校成员可读）——成绩公示的取数口。
 *
 * 【为什么单独一个动作，而不是让页面循环调 getPublishedResults】
 * 一届可能有 120 个项目组别，逐个项目调一遍既是 120 次云函数调用，也让页面
 * 自己拼顺序。这里一次读全届，按项目目录顺序返回，没有发布记录的项目不出现
 * （D79：只算已发布项目，未发布不当成 0 分结果）。
 *
 * 【两个口径】
 *   · 学院名取**当届快照**（sportsMeetColleges）：学院改名不让历史成绩单漂移，
 *     与总榜同一来源；
 *   · 学生名只显示**昵称**（D95 公开口径）。执裁工作视图（录分/预览）才显示
 *     姓名，两者刻意分开——公开成绩单不是通讯录。
 */
async function listMeetPublishedResults(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const scope = scopeOf(ctx);

  const [meet, events, publications, rows, sessions, scopeRows] = await Promise.all([
    ctx.repo.sportsMeets.getById(ctx.meetId),
    listAliveEvents(ctx.repo.forMeet(scope).sportsMeetEvents),
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
    ctx.repo.forMeet(scope).sportsMeetResultRows.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetColleges.list(),
  ]);
  if (!isAlive(meet) || meet.schoolId !== ctx.schoolId || (meet.status === 'draft' && !canManageMeet(ctx))) return refused('运动会不存在或尚未发布');

  const byEvent = new Map();
  for (const doc of publications) {
    const list = byEvent.get(doc.eventKey) || [];
    list.push(doc);
    byEvent.set(doc.eventKey, list);
  }
  if (byEvent.size === 0) return ok({ meetId: ctx.meetId, meetName: meet.name || '', published: false, items: [] });

  const publishedEvents = events.filter(event => byEvent.has(event._id));
  const offset = Math.max(0, Math.trunc(Number(payload.offset) || 0));
  const limit = Math.min(20, Math.max(1, Math.trunc(Number(payload.limit) || 10)));
  const selectedEvents = payload.metadataOnly ? publishedEvents : publishedEvents.slice(offset, offset + limit);
  const selectedKeys = new Set(selectedEvents.map(event => event._id));
  const currentVersions = new Map(publications.map(doc => [doc._id, doc.version]));
  const selectedRows = payload.metadataOnly ? [] : rows.filter(row => selectedKeys.has(row.eventKey) && currentVersions.get(row.publicationKey) === row.version);
  const collegeName = new Map();
  for (const row of scopeRows) {
    if (row && row.schoolId === ctx.schoolId) collegeName.set(row.collegeId, row.name || row.collegeId);
  }
  // 行里存了 userIds 快照，不需要再读报名名单；昵称按行里的用户解析一次
  const nickOf = new Map();
  const userIds = [...new Set(selectedRows.flatMap((row) => (Array.isArray(row.userIds) ? row.userIds : [])))];
  for (let i = 0; i < userIds.length; i += 20) {
    await Promise.all(userIds.slice(i, i + 20).map(async userId => {
      const user = await ctx.repo.users.getById(userId);
      nickOf.set(userId, (user && user.nickName) || '未设置昵称');
    }));
  }
  const labelOf = new Map(sessions.map((doc) => [doc._id, doc.roundLabel || doc.round]));

  const items = [];
  for (const event of selectedEvents) {
    const own = byEvent.get(event._id);
    if (!own || own.length === 0) continue;
    const rounds = own
      .sort((a, b) => Number(a.official ? 1 : 0) - Number(b.official ? 1 : 0)
        || String(a.sessionKey).localeCompare(String(b.sessionKey)))
      .map((doc) => ({
        sessionKey: doc.sessionKey,
        round: doc.round,
        roundLabel: doc.roundLabel || labelOf.get(doc.sessionKey) || '',
        official: Boolean(doc.official),
        version: doc.version,
        publishedAt: doc.publishedAt,
        reason: doc.reason || '',
        items: selectedRows
          .filter((row) => row.publicationKey === doc._id && row.version === doc.version)
          .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99))
          .map((row) => ({
            entryKey: row.entryKey,
            collegeId: row.collegeId,
            collegeName: collegeName.get(row.collegeId) || row.collegeId,
            memberText: (Array.isArray(row.userIds) ? row.userIds : [])
              .map((userId) => nickOf.get(userId) || userId).join('、'),
            rank: row.rank,
            value: row.value,
            text: row.value === null || row.value === undefined
              ? '—'
              : formatMeasure(event.scoreType, row.value),
            points: row.points,
            status: row.status,
          })),
      }));
    items.push({
      eventKey: event._id,
      name: event.name,
      group: event.group,
      scoreType: event.scoreType,
      scored: event.scored,
      rounds,
    });
  }

  return ok({
    meetId: ctx.meetId,
    meetName: meet.name || '',
    published: true,
    total: publishedEvents.length, offset, limit, hasMore: offset + limit < publishedEvents.length,
    items,
  });
}

module.exports = {
  getMeetSessionScores,
  saveMeetJudgeScore,
  submitMeetJudgeScore,
  getMeetResultPreview,
  publishMeetResults,
  getPublishedResults,
  listMeetPublishedResults,
  // 纯函数导出给测试与 B8 复用
  averageOf,
  pointsOf,
};
