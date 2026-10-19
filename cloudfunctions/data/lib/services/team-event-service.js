/**
 * 团队运动：团队赛事与报名（C 期首片）
 * ============================================================
 * 只做「建赛 → 报名 → 审核 → 锁定名单」这一段。赛程、录分、发布在后续切片，
 * 它们都要读这里的规则快照与名单快照，先把这两份快照钉住。
 *
 * 【规则快照为什么在建赛时固化】
 * 「4 节 × 10 分钟」还是「2 × 20」、个人几犯离场，直接决定比分怎么算。
 * 开赛后再改规则，前面打过的比赛就不可比了。所以 rules 一旦建库就不再变，
 * 改规则 = 新建一场赛事。
 *
 * 【名单快照为什么在锁定那一刻拍】
 * 报名名单锁定后，队员退队、改名、换号都不该回写历史。锁定把每个人的
 * 姓名当场抄进 roster；后续退队只影响球队，不影响这场比赛由谁打。
 * ============================================================
 */

const { canManageAssociationSpace } = require('./association-space-permission.js');
const { buildDirectory } = require('./school-actor.js');
const { schoolKey } = require('../utils/school.js');
const {
  TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS, TEAM_MATCH_STATUS,
  BRACKET_STAGE, EVENT_BRONZE_MODE, TEAM_STAT_INTEGRITY,
} = require('../utils/constants.js');
const { EVENT_FORMAT } = require('../utils/constants.js');
const { normalizeBasketballRules, formatBasketballRules, DEFAULT_PRESET_KEY } = require('../utils/basketball-rules.js');
const { sportTypeOf } = require('../utils/associations.js');
const { drawBracket } = require('../utils/bracket.js');
const { roundRobinRounds } = require('../utils/standings.js');
const { createSeededRandom, shuffle } = require('../utils/random.js');
const { eventMatchKey, planNextRound } = require('./draw.js');
const { computeTeamTable, computeTeamPlacements, isFinal } = require('../utils/team-standings.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const NAME_MAX = 30;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * 首版支持两种赛制。
 *
 * 小组赛+淘汰（GROUP_KNOCKOUT）不是「多打几场」，它要分组、组内循环、
 * 按小组名次出线再拼签表——少一层都会排出一张错的赛程。首版明确拒绝，
 * 而不是默默按单败淘汰处理（那会让人以为小组赛已经能用了）。
 */
const FORMATS = [EVENT_FORMAT.SINGLE_ELIM, EVENT_FORMAT.ROUND_ROBIN];
const SCORE_MAX = 299;

function assertTeamSport(ctx) {
  return sportTypeOf(ctx.association) === 'team';
}

function inScope(doc, ctx) {
  return Boolean(doc) && doc.schoolId === ctx.schoolId && doc.association === ctx.association;
}

const eventKey = (seed, ctx) => schoolKey('tev', ctx.schoolId, ctx.association, seed);
const entryKey = (eventId, teamId) => schoolKey('ten', eventId, teamId);

/** 赛事视图：布尔量与文案在服务端算好 */
function eventView(event, ctx, { manage, entryCount }) {
  return {
    eventId: event._id,
    name: event.name,
    format: event.format,
    status: event.status,
    statusLabel: TEAM_EVENT_STATUS[event.status] || event.status,
    rulesText: formatBasketballRules(event.rules),
    rules: event.rules,
    bronzeMode: event.bronzeMode || EVENT_BRONZE_MODE.PLAYOFF,
    statPolicy: event.statPolicy || STAT_MODE.BASIC,
    entryCount: Number(entryCount) || 0,
    canManage: manage,
    createdAt: event.createdAt || null,
  };
}

/**
 * 一场团队比赛的展示形状。
 *
 * 比分是**一个数字**（96:88），不是个人赛那种「逐局比分数组」。缺比分时
 * 显示 `—` 而不是 0:0——0:0 是「还没开打」，不能和「打完了 0 分」混为一谈。
 */
function matchView(match, teamName, rights = {}) {
  const nameOf = teamId => (teamName && teamName.get(teamId)) || teamId;
  const hasScore = match.scoreA !== null && match.scoreA !== undefined
    && match.scoreB !== null && match.scoreB !== undefined;
  return {
    matchId: match._id,
    round: Number(match.round) || 1,
    stage: match.stage || BRACKET_STAGE.MAIN,
    slot: Number(match.slot) || 0,
    teamA: match.teamA,
    teamB: match.teamB,
    teamAName: nameOf(match.teamA),
    teamBName: nameOf(match.teamB),
    scoreA: hasScore ? Number(match.scoreA) : null,
    scoreB: hasScore ? Number(match.scoreB) : null,
    scoreText: hasScore ? `${match.scoreA} : ${match.scoreB}` : '—',
    overtime: match.overtime === true,
    forfeit: match.forfeit || null,
    winner: match.winner || null,
    status: match.status,
    statusLabel: TEAM_MATCH_STATUS[match.status] || match.status,
    matchTime: match.matchTime || null,
    location: match.location || '',
    // 按钮显不显示由服务端定：页面拿不到「我是不是这队的队长」，
    // 自己猜一遍迟早与接口的口径分叉
    canRecord: rights.canRecord === true,
    canPublish: rights.canPublish === true,
  };
}

/** 把赛事编号揉成一个稳定的随机种子：同一个赛事重抽不会拿到同一张签 */
function hashSeed(text) {
  let hash = 2166136261;
  const source = String(text || '');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647;
}

/* ---------------- 读 ---------------- */async function listTeamEvents(_payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const manage = canManageAssociationSpace(ctx);
  const repo = ctx.repo.forScope(ctx);
  const [events, entries] = await Promise.all([repo.teamEvents.list(), repo.teamEventEntries.list()]);
  const countByEvent = new Map();
  for (const entry of entries) {
    countByEvent.set(entry.eventId, (countByEvent.get(entry.eventId) || 0) + 1);
  }

  const rows = events
    .filter(event => event.status !== TEAM_EVENT_STATUS.DRAFT || manage)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(event => eventView(event, ctx, { manage, entryCount: countByEvent.get(event._id) }));
  return ok({ ok: true, events: rows, canManage: manage, message: '' });
}

async function getTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  const manage = canManageAssociationSpace(ctx);
  if (event.status === TEAM_EVENT_STATUS.DRAFT && !manage) return ok(refused('赛事尚未发布'));

  const entries = (await repo.teamEventEntries.list()).filter(entry => entry.eventId === event._id);
  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  const rows = entries
    .filter(entry => manage || entry.status !== TEAM_ENTRY_STATUS.REJECTED)
    .map(entry => ({
      teamId: entry.teamId,
      teamName: teamName.get(entry.teamId) || '已归档球队',
      status: entry.status,
      statusLabel: TEAM_ENTRY_STATUS[entry.status] || entry.status,
      rosterCount: (entry.roster || []).length,
      lockedAt: entry.lockedAt || null,
      placement: Number(entry.placement) || null,
    }));

  const matches = (await repo.teamMatches.list())
    .filter(match => match.eventId === event._id)
    .sort((a, b) => (Number(a.round) - Number(b.round)) || (Number(a.slot) - Number(b.slot)));
  // 积分表对所有人可见（它就是赛程的一部分），名次只认赛事上已结算的那份
  const table = computeTeamTable({
    entries: entries
      .filter(entry => entry.status === TEAM_ENTRY_STATUS.LOCKED)
      .map(entry => ({ teamId: entry.teamId, teamName: teamName.get(entry.teamId) || entry.teamId })),
    matches,
  });

  const rightsOf = match => {
    const captain = [match.teamA, match.teamB].some(
      teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
    );
    return { canRecord: manage || captain, canPublish: manage };
  };

  // 「我能替哪支队报名」由服务端算：队长只有自己队，管理者可以替任何队补报。
  // 已经报过（含待审核、已通过、已锁定）的队不再出现，退回的可以重报。
  const memberRows = await repo.teamMembers.list();
  const activeCount = new Map();
  memberRows
    .filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE)
    .forEach((row) => {
      activeCount.set(row.teamId, (activeCount.get(row.teamId) || 0) + 1);
    });
  const entered = new Set(
    entries
      .filter(entry => entry.status !== TEAM_ENTRY_STATUS.REJECTED)
      .map(entry => entry.teamId)
  );
  const entryMin = Number(event.entryMin) || 5;
  const submitCandidates = event.status === TEAM_EVENT_STATUS.REGISTRATION
    ? teams
      .filter(team => inScope(team, ctx)
        && team.status === TEAM_STATUS.ACTIVE
        && !entered.has(team._id)
        && (manage || team.captainId === ctx.actorId))
      .map(team => {
        const count = activeCount.get(team._id) || 0;
        return {
          teamId: team._id,
          name: team.name,
          memberCount: count,
          enough: count >= entryMin,
          need: entryMin,
        };
      })
    : [];

  return ok({
    ok: true,
    event: eventView(event, ctx, { manage, entryCount: entries.length }),
    entries: rows,
    submitCandidates,
    matches: matches.map(match => matchView(match, teamName, rightsOf(match))),
    table,
    placements: event.placements || [],
    message: '',
  });
}

/* ---------------- 写 ---------------- */

async function createTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以创建赛事'));

  const name = String(payload.name || '').trim();
  if (name.length < 2 || name.length > NAME_MAX) return ok(refused(`赛事名称需 2–${NAME_MAX} 个字`));
  // 不支持的形式要明确说出来，不能静默降级成单败淘汰——那会让人以为
  // 「选了小组赛」的赛事真的会分组打循环。
  if (payload.format && !FORMATS.includes(payload.format)) {
    return ok(refused('首版的团队赛事只支持单败淘汰与循环赛'));
  }
  const format = FORMATS.includes(payload.format) ? payload.format : EVENT_FORMAT.SINGLE_ELIM;
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('创建请求编号无效'));
  const rules = normalizeBasketballRules({
    presetKey: payload.presetKey || DEFAULT_PRESET_KEY,
    ...(payload.rules || {}),
  });
  if (!rules) return ok(refused('规则配置不合法'));

  const eventId = eventKey(`${ctx.actorId}|${token}`, ctx);
  const existing = await ctx.repo.forScope(ctx).teamEvents.getById(eventId);
  if (inScope(existing, ctx)) return ok({ ok: true, eventId, message: '' });

  const duplicate = (await ctx.repo.forScope(ctx).teamEvents.list())
    .some(event => inScope(event, ctx) && event.name === name && event.status !== TEAM_EVENT_STATUS.CANCELED);
  if (duplicate) return ok(refused('同协会已有同名赛事'));

  // 季军赛默认要打：并列季军只适合「不发奖牌、只记名次」的场合，
  // 校园赛要发第三名，不给一场比赛就永远只能按净胜分排
  const bronzeMode = payload.bronzeMode === EVENT_BRONZE_MODE.TIED
    ? EVENT_BRONZE_MODE.TIED
    : EVENT_BRONZE_MODE.PLAYOFF;
  // 统计口径：默认只记总分与个人得分/犯规；有专职记录员的赛事才开按节统计
  const statPolicy = payload.statPolicy === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC;

  const now = ctx.now;
  await ctx.repo.forScope(ctx).teamEvents.set(eventId, {
    _id: eventId, schoolId: ctx.schoolId, association: ctx.association,
    name, format, rules, bronzeMode, statPolicy, status: TEAM_EVENT_STATUS.REGISTRATION,
    entryMin: rules.rosterMin, entryMax: rules.rosterMax,
    // 赛程的时间与地点在建赛时给一次，之后每场可单独改
    startTime: String(payload.startTime || '') || null,
    location: String(payload.location || '').trim(),
    revision: 1, requestId: token, createdBy: ctx.actorId, createdAt: now, updatedAt: now,
  });
  return ok({ ok: true, eventId, message: '' });
}

/** 队长为本队报名：名单取当前在队成员，报名后待审核 */
async function submitTeamEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status !== TEAM_EVENT_STATUS.REGISTRATION) return ok(refused('赛事当前不开放报名'));

  const team = await repo.teams.getById(payload.teamId);
  if (!inScope(team, ctx) || team.status !== TEAM_STATUS.ACTIVE) return ok(refused('球队不存在或未通过审核'));
  if (team.captainId !== ctx.actorId && !canManageAssociationSpace(ctx)) {
    return ok(refused('只有队长可以为本队报名'));
  }

  const members = (await repo.teamMembers.list())
    .filter(row => row.teamId === team._id && row.status === TEAM_MEMBER_STATUS.ACTIVE);
  if (members.length < (Number(event.entryMin) || 5)) {
    return ok(refused(`报名至少需要 ${event.entryMin || 5} 人，当前在队 ${members.length} 人`));
  }

  const now = ctx.now;
  const key = entryKey(event._id, team._id);
  const previous = await repo.teamEventEntries.getById(key);
  if (previous && previous.status === TEAM_ENTRY_STATUS.LOCKED) return ok(refused('名单已锁定，不能再改'));
  if (previous && previous.status === TEAM_ENTRY_STATUS.SUBMITTED) {
    return ok({ ok: true, eventId: event._id, teamId: team._id, status: previous.status, message: '' });
  }

  const dir = await buildDirectory(ctx);
  const nameOf = userId => {
    const user = (dir.members || []).find(item => item._id === userId);
    return (user && (user.nickName || user.realName)) || userId;
  };
  await repo.teamEventEntries.set(key, {
    _id: key, schoolId: ctx.schoolId, association: ctx.association,
    eventId: event._id, teamId: team._id,
    status: TEAM_ENTRY_STATUS.SUBMITTED,
    roster: members.map(row => ({ userId: row.userId, name: nameOf(row.userId) })),
    submittedBy: ctx.actorId, submittedAt: now, updatedAt: now,
    lockedAt: null,
  });
  return ok({ ok: true, eventId: event._id, teamId: team._id, status: TEAM_ENTRY_STATUS.SUBMITTED, message: '' });
}

/** 审核报名（协会负责人） */
async function reviewTeamEntry(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以审核报名'));

  const repo = ctx.repo.forScope(ctx);
  const key = entryKey(payload.eventId, payload.teamId);
  const entry = await repo.teamEventEntries.getById(key);
  if (!inScope(entry, ctx)) return ok(refused('找不到这条报名'));
  if (entry.status === TEAM_ENTRY_STATUS.LOCKED) return ok(refused('名单已锁定，不能再改'));

  const now = ctx.now;
  await repo.teamEventEntries.set(key, {
    ...entry,
    status: payload.approve === true ? TEAM_ENTRY_STATUS.APPROVED : TEAM_ENTRY_STATUS.REJECTED,
    reviewedBy: ctx.actorId, reviewedAt: now, updatedAt: now,
  });
  return ok({ ok: true, status: payload.approve === true ? 'approved' : 'rejected', message: '' });
}

/**
 * 锁定报名名单：已是「已通过」的报名一律转「已锁定」，并把 roster 定稿。
 * 锁定后球队再换人也不影响这一场——历史成绩按快照认人。
 */
async function lockTeamEntries(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以锁定名单'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status !== TEAM_EVENT_STATUS.REGISTRATION) return ok(refused('只有在报名阶段可以锁定名单'));

  const entries = (await repo.teamEventEntries.list())
    .filter(entry => entry.eventId === event._id && entry.status === TEAM_ENTRY_STATUS.APPROVED);
  const tooSmall = entries.filter(entry => (entry.roster || []).length < (Number(event.entryMin) || 5));
  if (tooSmall.length > 0) return ok(refused('有球队名单人数不足，先补齐再锁定'));

  const now = ctx.now;
  for (const entry of entries) {
    await repo.teamEventEntries.set(entry._id, {
      ...entry, status: TEAM_ENTRY_STATUS.LOCKED, lockedAt: now, updatedAt: now,
    });
  }
  await repo.teamEvents.set(event._id, {
    ...event, status: TEAM_EVENT_STATUS.LOCKED,
    lockedCount: entries.length,
    revision: Number(event.revision || 1) + 1, updatedAt: now,
  });
  return ok({ ok: true, locked: entries.length, message: '' });
}

/* ---------------- 抽签与赛程 ---------------- */

/** 一场待打的比赛。比分留空 = 还没打，与「打了 0 分」区分开 */
function matchDocOf({ event, ctx, round, stage, slot, teamA, teamB, now }) {
  return {
    _id: eventMatchKey(event._id, round, stage, slot),
    schoolId: ctx.schoolId,
    association: ctx.association,
    eventId: event._id,
    round,
    stage,
    slot,
    teamA,
    teamB,
    scoreA: null,
    scoreB: null,
    overtime: false,
    forfeit: null,
    winner: null,
    status: TEAM_MATCH_STATUS.SCHEDULED,
    matchTime: event.startTime || null,
    location: event.location || '',
    recordedBy: null,
    recordedAt: null,
    publishedBy: null,
    publishedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 抽签：把已锁定的球队摆进签表，并生成首轮（循环赛则生成全部轮次）。
 *
 * 【为什么可以重抽】
 * 种子排错、有队退赛都发生在开打之前。只要还没有任何一场录过分，
 * 重抽是安全的；一旦有了比分，重抽等于把已经打过的比赛从赛程里抹掉，
 * 所以这里直接拒绝。
 *
 * 【种子从哪来】
 * 由「赛事编号 + 当前版本号」揉成，存进 `draw.seed`。同样的种子重跑一次
 * 得到同一张签，事后能复核；重抽时版本号变了，签也就变了。
 */
async function drawTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以抽签'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  // 报名阶段还没锁定名单，抽签无从谈起；已开打的赛事交给下面的
  // 「已有比分」判定给出一句更准确的话
  if (event.status === TEAM_EVENT_STATUS.DRAFT || event.status === TEAM_EVENT_STATUS.REGISTRATION) {
    return ok(refused('请先锁定报名名单再抽签'));
  }
  if (event.status === TEAM_EVENT_STATUS.FINISHED || event.status === TEAM_EVENT_STATUS.CANCELED) {
    return ok(refused('赛事已结束，不能再抽签'));
  }

  const entries = (await repo.teamEventEntries.list())
    .filter(entry => entry.eventId === event._id && entry.status === TEAM_ENTRY_STATUS.LOCKED)
    .sort((a, b) => String(a.teamId).localeCompare(String(b.teamId)));
  if (entries.length < 2) return ok(refused('至少 2 支球队才能抽签'));

  const alreadyPlayed = (await repo.teamMatches.list())
    .some(match => match.eventId === event._id && match.scoreA !== null && match.scoreA !== undefined);
  if (alreadyPlayed) return ok(refused('已经有比赛录了分，不能再重抽'));

  const teamIds = entries.map(entry => entry.teamId);
  const seeds = Array.isArray(payload.seedTeamIds) ? payload.seedTeamIds.filter(Boolean) : [];
  if (new Set(seeds).size !== seeds.length) return ok(refused('种子名单里有重复的球队'));
  if (seeds.some(teamId => !teamIds.includes(teamId))) return ok(refused('种子必须是已锁定的参赛球队'));
  if (seeds.length > teamIds.length) return ok(refused('种子数不能超过参赛队数'));

  const revision = Number(event.revision || 1);
  const seed = Number.isInteger(payload.seed) ? payload.seed : hashSeed(`${event._id}#${revision}`);
  const random = createSeededRandom(seed);
  const now = ctx.now;

  let draw;
  let rounds;
  if (event.format === EVENT_FORMAT.ROUND_ROBIN) {
    // 种子按顺序占前排，其余洗牌：强弱均匀分摊到各轮
    const rest = shuffle(random, teamIds.filter(teamId => !seeds.includes(teamId)));
    const ordered = seeds.concat(rest);
    const schedule = roundRobinRounds(ordered);
    rounds = schedule.map((pairs, index) => ({
      round: index + 1, stage: BRACKET_STAGE.GROUP, pairs,
    }));
    draw = {
      format: event.format, size: ordered.length, slots: ordered,
      byes: [], seeds: seeds.slice(), seed, roundCount: schedule.length, drawnAt: now,
    };
  } else {
    const plan = drawBracket({ entries: teamIds, seeds, random });
    if (!plan.ok) return ok(refused(plan.firstError || '抽签失败'));
    rounds = [{ round: 1, stage: BRACKET_STAGE.MAIN, pairs: plan.pairs }];
    draw = {
      format: event.format, size: plan.size, slots: plan.slots,
      byes: plan.byes, seeds: plan.seeds, seed, roundCount: 1, drawnAt: now,
    };
  }

  // 轮空（一方为空）不产生比赛，直接晋级
  let matchCount = 0;
  for (const item of rounds) {
    for (let slot = 0; slot < item.pairs.length; slot += 1) {
      const [a, b] = item.pairs[slot] || [];
      if (!a || !b) continue;
      const doc = matchDocOf({
        event, ctx, round: item.round, stage: item.stage, slot, teamA: a, teamB: b, now,
      });
      await repo.teamMatches.set(doc._id, doc);
      matchCount += 1;
    }
  }

  await repo.teamEvents.set(event._id, {
    ...event,
    draw,
    status: TEAM_EVENT_STATUS.SCHEDULED,
    revision: revision + 1,
    updatedAt: now,
  });

  return ok({
    ok: true, matchCount, rounds: rounds.length, byes: draw.byes || [], seed, message: '',
  });
}

/** 赛程列表：按轮次与签位排好，供赛程页与录分页使用 */
async function listTeamMatches(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));

  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  const manage = canManageAssociationSpace(ctx);
  const rows = (await repo.teamMatches.list())
    .filter(match => match.eventId === event._id)
    .sort((a, b) => (Number(a.round) - Number(b.round)) || (Number(a.slot) - Number(b.slot)))
    .map(match => matchView(match, teamName, {
      canRecord: manage || [match.teamA, match.teamB].some(
        teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
      ),
      canPublish: manage,
    }));

  return ok({
    ok: true,
    rounds: event.draw && event.draw.roundCount ? event.draw.roundCount : 1,
    matches: rows,
    canManage: manage,
    message: '',
  });
}

/* ---------------- 录分与发布 ---------------- */

/** 比分归一：非整数或越界一律返回 null（不静默夹取） */
function toScore(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > SCORE_MAX) return null;
  return n;
}

async function canRecordTeamMatch(match, ctx, repo) {
  if (canManageAssociationSpace(ctx)) return true;
  const sides = await Promise.all([
    repo.teams.getById(match.teamA),
    repo.teams.getById(match.teamB),
  ]);
  return sides.some(team => inScope(team, ctx) && team.captainId === ctx.actorId);
}

/**
 * 录一场比赛的比分（→ 待审核）。
 *
 * 【为什么录完不是直接发布】
 * 两队的队长都可能录分，谁录的都可能看错记分牌。录分只说明「这场打完了」，
 * 由协会负责人核对后发布，发布之后才进入积分表与名次。
 *
 * 【平局】
 * 篮球没有平局，只有允许平局的循环赛例外（`rules.allowDraw`）。淘汰赛
 * 平局直接拒绝，并提示打加时——静默接受会让签表卡在「这一轮永远打不完」。
 */
async function recordTeamMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));

  const event = await repo.teamEvents.getById(match.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status === TEAM_EVENT_STATUS.FINISHED) return ok(refused('赛事已结束，不能再录分'));
  if (event.status !== TEAM_EVENT_STATUS.SCHEDULED && event.status !== TEAM_EVENT_STATUS.RUNNING) {
    return ok(refused('赛事当前不可录分'));
  }
  if (match.status === TEAM_MATCH_STATUS.PUBLISHED) return ok(refused('这场已发布，要改请先驳回'));
  if (match.status === TEAM_MATCH_STATUS.CANCELED) return ok(refused('这场已取消'));

  if (!(await canRecordTeamMatch(match, ctx, repo))) {
    return ok(refused('只有协会管理者或参赛队队长可以录分'));
  }

  const scoreA = toScore(payload.scoreA);
  const scoreB = toScore(payload.scoreB);
  if (scoreA === null || scoreB === null) return ok(refused(`比分需为 0–${SCORE_MAX} 的整数`));
  if (scoreA === 0 && scoreB === 0) return ok(refused('0:0 不是有效的比赛比分'));

  const forfeit = payload.forfeit === 'A' || payload.forfeit === 'B' ? payload.forfeit : null;
  let winner = null;
  if (forfeit) {
    winner = forfeit === 'A' ? 'B' : 'A';
  } else if (scoreA === scoreB) {
    const drawAllowed = event.rules && event.rules.allowDraw === true
      && event.format === EVENT_FORMAT.ROUND_ROBIN;
    if (!drawAllowed) return ok(refused('篮球不允许平局，请打加时后再录'));
  } else {
    winner = scoreA > scoreB ? 'A' : 'B';
  }

  const warnings = [];
  const stats = Array.isArray(payload.stats) ? payload.stats : [];
  if (stats.length > 0) {
    const entries = await repo.teamEventEntries.list();
    const now = ctx.now;
    for (const item of stats) {
      const teamId = item && item.teamId;
      if (teamId !== match.teamA && teamId !== match.teamB) {
        return ok(refused('统计里的球队与这场比赛的对阵不符'));
      }
      const entry = entries.find(row => row.eventId === event._id && row.teamId === teamId);
      const roster = new Set(((entry && entry.roster) || []).map(row => row.userId));
      const players = (Array.isArray(item.players) ? item.players : [])
        .filter(row => row && roster.has(row.userId))
        .map(row => ({
          userId: row.userId,
          points: Number.isInteger(Number(row.points)) ? Math.max(0, Number(row.points)) : null,
          fouls: Number.isInteger(Number(row.fouls)) ? Math.max(0, Number(row.fouls)) : null,
        }));
      const total = players.reduce((sum, row) => sum + (row.points || 0), 0);
      const teamScore = teamId === match.teamA ? scoreA : scoreB;
      if (players.some(row => row.points !== null) && total !== teamScore) {
        warnings.push(`个人得分合计 ${total}，球队 ${teamScore}，差 ${teamScore - total} 分待归属`);
      }
      const key = schoolKey('tms', match._id, teamId);
      await repo.teamMatchStats.set(key, {
        _id: key,
        schoolId: ctx.schoolId,
        association: ctx.association,
        eventId: event._id,
        matchId: match._id,
        teamId,
        players,
        // 首版只做「总分 + 个人得分/犯规」，其余指标是 D 期的详细模式
        integrity: players.some(row => row.points !== null || row.fouls !== null) ? 'basic' : 'none',
        updatedBy: ctx.actorId,
        updatedAt: now,
      });
    }
  }

  // 并发保护：录入途中若这场刚被别人改过（版本号变了），拒绝而不是覆盖
  if (Number.isInteger(payload.expectRevision) && payload.expectRevision !== (Number(match.revision) || 0)) {
    return ok(refused('这场比赛刚被改过，请刷新后重试'));
  }

  const now = ctx.now;
  await repo.teamMatches.set(match._id, {
    ...match,
    scoreA, scoreB,
    overtime: payload.overtime === true,
    forfeit,
    winner,
    status: TEAM_MATCH_STATUS.REVIEWING,
    recordedBy: ctx.actorId,
    recordedAt: now,
    revision: Number(match.revision || 1) + 1,
    updatedAt: now,
  });

  if (event.status === TEAM_EVENT_STATUS.SCHEDULED) {
    await repo.teamEvents.set(event._id, {
      ...event,
      status: TEAM_EVENT_STATUS.RUNNING,
      revision: Number(event.revision || 1) + 1,
      updatedAt: now,
    });
  }

  return ok({ ok: true, status: TEAM_MATCH_STATUS.REVIEWING, winner, warnings, message: '' });
}

/**
 * 发布 / 驳回比分。
 *
 * 驳回会把比分清空并要求重录，而不是「留着让人改一改」——留着的话，
 * 一次驳回之后谁都分不清屏幕上那串数字是核对过的还是被退回的。
 */
async function publishTeamMatch(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以发布成绩'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));
  if (match.status !== TEAM_MATCH_STATUS.REVIEWING) {
    return ok(refused('只有待审核的比赛可以发布或驳回'));
  }

  if (Number.isInteger(payload.expectRevision) && payload.expectRevision !== (Number(match.revision) || 0)) {
    return ok(refused('这场比赛刚被改过，请刷新后重试'));
  }

  const now = ctx.now;
  if (payload.approve !== true) {
    await repo.teamMatches.set(match._id, {
      ...match,
      scoreA: null,
      scoreB: null,
      overtime: false,
      forfeit: null,
      winner: null,
      status: TEAM_MATCH_STATUS.SCHEDULED,
      recordedBy: null,
      recordedAt: null,
      revision: Number(match.revision || 1) + 1,
      updatedAt: now,
    });
    return ok({ ok: true, status: TEAM_MATCH_STATUS.SCHEDULED, message: '' });
  }

  await repo.teamMatches.set(match._id, {
    ...match,
    status: TEAM_MATCH_STATUS.PUBLISHED,
    publishedBy: ctx.actorId,
    publishedAt: now,
    revision: Number(match.revision || 1) + 1,
    updatedAt: now,
  });

  const event = await repo.teamEvents.getById(match.eventId);
  if (inScope(event, ctx) && event.status === TEAM_EVENT_STATUS.SCHEDULED) {
    await repo.teamEvents.set(event._id, {
      ...event,
      status: TEAM_EVENT_STATUS.RUNNING,
      revision: Number(event.revision || 1) + 1,
      updatedAt: now,
    });
  }

  return ok({ ok: true, status: TEAM_MATCH_STATUS.PUBLISHED, message: '' });
}

/**
 * 生成下一轮（淘汰赛）。
 *
 * 复用个人赛的 `planNextRound`：它只认「签位 + 已有比赛 + 哪一场算定局」，
 * 与参赛单位是人还是球队无关。团队赛只是把判定函数换成「已发布」。
 */
async function advanceTeamRound(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以编排赛程'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.format !== EVENT_FORMAT.SINGLE_ELIM) return ok(refused('循环赛没有下一轮'));
  if (!event.draw || !Array.isArray(event.draw.slots) || event.draw.slots.length < 2) {
    return ok(refused('还没有抽签'));
  }
  if (event.status === TEAM_EVENT_STATUS.FINISHED || event.status === TEAM_EVENT_STATUS.CANCELED) {
    return ok(refused('赛事已结束'));
  }

  const matches = (await repo.teamMatches.list()).filter(match => match.eventId === event._id);
  const plan = planNextRound({
    eventId: event._id,
    draw: event.draw,
    matches,
    bronzeMode: event.bronzeMode || EVENT_BRONZE_MODE.PLAYOFF,
    isFinal: match => isFinal(match) && Boolean(match.winner),
  });
  if (!plan.ok || plan.rounds.length === 0) {
    const pending = matches.filter(
      match => match.status !== TEAM_MATCH_STATUS.PUBLISHED && match.status !== TEAM_MATCH_STATUS.CANCELED
    );
    return ok(refused(pending.length > 0
      ? `还有 ${pending.length} 场未发布，打完了再排下一轮`
      : '赛程已全部打完，可以结算名次'));
  }

  const now = ctx.now;
  let created = 0;
  for (const item of plan.rounds) {
    for (let slot = 0; slot < item.pairs.length; slot += 1) {
      const [a, b] = item.pairs[slot] || [];
      if (!a || !b) continue;
      const doc = matchDocOf({
        event, ctx, round: item.round, stage: item.stage, slot, teamA: a, teamB: b, now,
      });
      const existing = await repo.teamMatches.getById(doc._id);
      if (existing) continue;
      await repo.teamMatches.set(doc._id, doc);
      created += 1;
    }
  }

  const addedRounds = plan.rounds.length;
  await repo.teamEvents.set(event._id, {
    ...event,
    draw: { ...event.draw, roundCount: Math.max(Number(event.draw.roundCount) || 1, addedRounds) },
    revision: Number(event.revision || 1) + 1,
    updatedAt: now,
  });

  return ok({ ok: true, rounds: addedRounds, matchCount: created, message: '' });
}

/**
 * 结算名次：写进赛事与各队报名记录，赛事转「已结束」。
 *
 * 循环赛按积分表定名次；淘汰赛按签表定。两者都要求「所有比赛已定局」，
 * 否则结算出来的名次第二天就变了。
 */
async function settleTeamEvent(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以结算名次'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status === TEAM_EVENT_STATUS.FINISHED) return ok(refused('赛事已结算'));

  const matches = (await repo.teamMatches.list()).filter(match => match.eventId === event._id);
  if (matches.length === 0) return ok(refused('还没有赛程，无法结算'));
  const pending = matches.filter(
    match => match.status !== TEAM_MATCH_STATUS.PUBLISHED && match.status !== TEAM_MATCH_STATUS.CANCELED
  );
  if (pending.length > 0) return ok(refused(`还有 ${pending.length} 场未发布，无法结算`));

  const entries = (await repo.teamEventEntries.list())
    .filter(entry => entry.eventId === event._id && entry.status === TEAM_ENTRY_STATUS.LOCKED);
  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));

  const table = computeTeamTable({
    entries: entries.map(entry => ({ teamId: entry.teamId, teamName: teamName.get(entry.teamId) })),
    matches,
  });

  let placements;
  if (event.format === EVENT_FORMAT.ROUND_ROBIN) {
    placements = table.map(row => ({
      rank: row.rank,
      teamId: row.teamId,
      note: row.rank === 1 ? '冠军' : (row.rank === 2 ? '亚军' : ''),
    }));
  } else {
    placements = computeTeamPlacements({ draw: event.draw, matches, table });
  }
  if (placements.length === 0) return ok(refused('还没有产生可结算的名次'));

  const rows = placements.map(row => ({
    rank: row.rank,
    teamId: row.teamId,
    teamName: teamName.get(row.teamId) || '已归档球队',
    note: row.note || '',
  }));

  const now = ctx.now;
  await repo.teamEvents.set(event._id, {
    ...event,
    placements: rows,
    status: TEAM_EVENT_STATUS.FINISHED,
    finishedAt: now,
    revision: Number(event.revision || 1) + 1,
    updatedAt: now,
  });
  for (const row of rows) {
    const entry = entries.find(item => item.teamId === row.teamId);
    if (!entry) continue;
    await repo.teamEventEntries.set(entry._id, { ...entry, placement: row.rank, updatedAt: now });
  }

  return ok({ ok: true, placements: rows, message: '' });
}

/* ---------------- 个人统计 ---------------- */

/**
 * 统计口径与两种模式。
 *
 *   basic    —— 只记每个人整场的得分与犯规（没有专职记录员的比赛）
 *   detailed —— 按节记每个人（得分 / 篮板 / 助攻 / 抢断 / 盖帽 / 失误 / 犯规），
 *               合计由各行算出，绝不与合计双份存储
 *
 * 【为什么不做逐球事件流】
 * 逐球（谁在哪儿投了个两分）需要一个人全程盯着一支队录，校园赛凑不出这个人力。
 * 「按节合计」是记录员在纸上真正会填的粒度：一节一格，四节就是四行。
 */
const STAT_MODE = { BASIC: 'basic', DETAILED: 'detailed' };
const STAT_FIELDS = {
  points: 199, rebounds: 60, assists: 60,
  steals: 40, blocks: 40, turnovers: 40, fouls: 10,
};

/** 报错时用中文指标名，不把字段键抛给用户 */
const STAT_LABEL = {
  points: '个人得分', rebounds: '篮板', assists: '助攻',
  steals: '抢断', blocks: '盖帽', turnovers: '失误', fouls: '犯规',
};

/** 一个格子的数字：空 → null（未记录），非整数 / 越界 → 非法 */
function parseStat(raw, max) {
  if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false };
  return { ok: true, value: n };
}

/** 由各行算出合计；某个指标一行都没填 → null（不是 0） */
function totalsOf(rows) {
  const out = {};
  for (const field of Object.keys(STAT_FIELDS)) {
    const filled = rows.filter(row => row[field] !== null && row[field] !== undefined);
    out[field] = filled.length > 0 ? filled.reduce((sum, row) => sum + row[field], 0) : null;
  }
  return out;
}

/**
 * 取一场比赛的个人统计面板。
 *
 * 【为什么要单独一个接口】
 * 名单是「锁定那一刻的快照」（`team_event_entries.roster`），不在球队表里。
 * 页面要按当时上场的人列格子，只能由服务端把快照与已有统计一起给出——
 * 前端自己拼会把「现在队里有谁」误当成「这场谁打了」。
 */
async function getTeamMatchStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));
  const event = await repo.teamEvents.getById(match.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));

  const entries = await repo.teamEventEntries.list();
  const teams = await repo.teams.list();
  const teamName = new Map(teams.map(team => [team._id, team.name]));
  const stats = (await repo.teamMatchStats.list()).filter(row => row.matchId === match._id);
  const manage = canManageAssociationSpace(ctx);
  const captain = [match.teamA, match.teamB].some(
    teamId => (teams.find(team => team._id === teamId) || {}).captainId === ctx.actorId
  );

  const sides = [match.teamA, match.teamB].map((teamId) => {
    const entry = entries.find(row => row.eventId === event._id && row.teamId === teamId);
    const roster = ((entry && entry.roster) || []).map(row => ({ userId: row.userId, name: row.name }));
    const saved = stats.find(row => row.teamId === teamId);
    const rows = (saved && saved.rows) || [];
    const players = (saved && saved.players) || [];
    // 详细模式的合计由各行算出；基础模式直接取存好的合计
    const totals = saved && saved.mode === STAT_MODE.DETAILED ? totalsOf(rows) : {};
    return {
      teamId,
      teamName: teamName.get(teamId) || '已归档球队',
      players: roster.map(row => {
        const hit = players.find(item => item.userId === row.userId) || {};
        const out = { userId: row.userId, name: row.name || row.userId };
        for (const field of Object.keys(STAT_FIELDS)) {
          const value = saved && saved.mode === STAT_MODE.DETAILED
            ? totals[field]
            : hit[field];
          out[field] = Number.isInteger(value) ? value : null;
        }
        return out;
      }),
      // 详细模式把每节各行一起交给页面；基础模式没有行
      rows: saved && saved.mode === STAT_MODE.DETAILED ? rows : null,
      revision: Number(saved && saved.revision) || 0,
    };
  });

  return ok({
    ok: true,
    match: matchView(match, teamName, { canRecord: manage || captain, canPublish: manage }),
    statPolicy: event.statPolicy === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC,
    periods: Number(event.rules && event.rules.periods) || 4,
    sides,
    canEdit: (manage || captain) && match.status !== TEAM_MATCH_STATUS.CANCELED
      && event.status !== TEAM_EVENT_STATUS.FINISHED,
    message: '',
  });
}

/**
 * 保存一场比赛的个人统计。
 *
 * 【总分与个人统计谁说话】
 * 比分是权威、统计是解释。个人得分合计与球队得分对不上时**照存**，
 * 只回一句差额提醒——校园赛经常只有一个记分牌，硬拦会让人干脆不录。
 *
 * 【未记录 ≠ 0】
 * 没填的格子存 `null` 而不是 0。0 分是一个事实（上场了没得分），
 * 没填是另一个事实（这场没统计）。混成一个数，场均得分就永远偏低。
 *
 * 【并发】
 * 队长与协会负责人可能同时录。调用方可带 `expectRevision`（面板打开时拿到的
 * 版本号），对不上就拒绝并要求刷新——后来者覆盖先到者的数据，是最难发现
 * 的一类数据丢失。
 */
async function saveTeamMatchStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const match = await repo.teamMatches.getById(payload.matchId);
  if (!inScope(match, ctx)) return ok(refused('比赛不存在，或不在本协会'));
  const event = await repo.teamEvents.getById(match.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));
  if (event.status === TEAM_EVENT_STATUS.FINISHED) return ok(refused('赛事已结束，统计不能再改'));
  if (match.status === TEAM_MATCH_STATUS.CANCELED) return ok(refused('这场已取消'));
  if (!(await canRecordTeamMatch(match, ctx, repo))) {
    return ok(refused('只有协会管理者或参赛队队长可以录统计'));
  }

  const mode = payload.mode === STAT_MODE.DETAILED ? STAT_MODE.DETAILED : STAT_MODE.BASIC;
  if (mode === STAT_MODE.DETAILED && event.statPolicy !== STAT_MODE.DETAILED) {
    return ok(refused('这场赛事未开启按节统计'));
  }

  const entries = await repo.teamEventEntries.list();
  const periods = Number(event.rules && event.rules.periods) || 4;
  const sides = [match.teamA, match.teamB].map((teamId) => {
    const entry = entries.find(row => row.eventId === event._id && row.teamId === teamId);
    return {
      teamId,
      roster: new Map(((entry && entry.roster) || []).map(row => [row.userId, row.name || row.userId])),
      rows: [],
      players: [],
    };
  });

  if (mode === STAT_MODE.DETAILED) {
    const incoming = Array.isArray(payload.rows) ? payload.rows : [];
    if (incoming.length === 0) return ok(refused('没有可保存的统计'));
    for (const row of incoming) {
      const side = sides.find(item => item.roster.has(row && row.userId));
      if (!side) return ok(refused('统计里有人不在本场名单中'));
      const period = Number(row.period);
      if (!Number.isInteger(period) || period < 1 || period > periods) {
        return ok(refused(`节次需在 1–${periods} 之间`));
      }
      const cleaned = { period, userId: row.userId };
      let any = false;
      for (const [field, max] of Object.entries(STAT_FIELDS)) {
        const parsed = parseStat(row[field], max);
        if (!parsed.ok) return ok(refused(`第 ${period} 节的「${STAT_LABEL[field] || field}」需为 0–${max} 的整数`));
        cleaned[field] = parsed.value;
        if (parsed.value !== null) any = true;
      }
      // 整行都是空的等于没录这个人这一节，直接丢掉，不要存一排 null
      if (any) side.rows.push(cleaned);
    }
    if (sides.every(side => side.rows.length === 0)) return ok(refused('没有可保存的统计'));
  } else {
    const incoming = Array.isArray(payload.players) ? payload.players : [];
    if (incoming.length === 0) return ok(refused('没有可保存的统计'));
    for (const row of incoming) {
      const side = sides.find(item => item.roster.has(row && row.userId));
      if (!side) return ok(refused('统计里有人不在本场名单中'));
      const cleaned = { userId: row.userId };
      let any = false;
      for (const [field, max] of Object.entries(STAT_FIELDS)) {
        const parsed = parseStat(row[field], max);
        if (!parsed.ok) return ok(refused(`${STAT_LABEL[field] || field}需为 0–${max} 的整数`));
        cleaned[field] = parsed.value;
        if (parsed.value !== null) any = true;
      }
      if (any) side.players.push(cleaned);
    }
    if (sides.every(side => side.players.length === 0)) return ok(refused('没有可保存的统计'));
  }

  const warnings = [];
  const now = ctx.now;
  for (const side of sides) {
    const key = schoolKey('tms', match._id, side.teamId);
    const saved = await repo.teamMatchStats.getById(key);
    const current = Number(saved && saved.revision) || 0;
    if (Number.isInteger(payload.expectRevision) && payload.expectRevision !== current) {
      return ok(refused('这场的统计刚被改过，请刷新后重试'));
    }
    const rows = mode === STAT_MODE.DETAILED ? side.rows : [];
    const players = mode === STAT_MODE.DETAILED ? [] : side.players;
    const totals = mode === STAT_MODE.DETAILED ? totalsOf(rows) : null;

    if (mode === STAT_MODE.DETAILED) {
      const rosterIds = [...side.roster.keys()];
      const covered = new Set(rows.map(row => row.userId));
      const integrity = rows.length === 0
        ? TEAM_STAT_INTEGRITY.NONE
        : (rosterIds.every(id => covered.has(id)) ? TEAM_STAT_INTEGRITY.FULL : TEAM_STAT_INTEGRITY.PARTIAL);
      const pointsTotal = totals.points;
      const teamScore = side.teamId === match.teamA ? match.scoreA : match.scoreB;
      if (pointsTotal !== null && Number.isInteger(Number(teamScore)) && pointsTotal !== Number(teamScore)) {
        warnings.push(`第 ${side.teamId === match.teamA ? 'A' : 'B'} 队个人得分合计 ${pointsTotal}，球队 ${teamScore}，差 ${Number(teamScore) - pointsTotal} 分待归属`);
      }
      await repo.teamMatchStats.set(key, {
        _id: key, schoolId: ctx.schoolId, association: ctx.association,
        eventId: event._id, matchId: match._id, teamId: side.teamId,
        mode: STAT_MODE.DETAILED, rows, players: [], integrity,
        revision: current + 1, updatedBy: ctx.actorId, updatedAt: now,
      });
    } else {
      const hasAny = side.players.some(row => Object.keys(STAT_FIELDS).some(f => row[f] !== null));
      const pointsTotal = side.players.reduce((sum, row) => sum + (row.points || 0), 0);
      const teamScore = side.teamId === match.teamA ? match.scoreA : match.scoreB;
      if (hasAny && side.players.some(row => row.points !== null)
        && Number.isInteger(Number(teamScore)) && pointsTotal !== Number(teamScore)) {
        warnings.push(`第 ${side.teamId === match.teamA ? 'A' : 'B'} 队个人得分合计 ${pointsTotal}，球队 ${teamScore}，差 ${Number(teamScore) - pointsTotal} 分待归属`);
      }
      await repo.teamMatchStats.set(key, {
        _id: key, schoolId: ctx.schoolId, association: ctx.association,
        eventId: event._id, matchId: match._id, teamId: side.teamId,
        mode: STAT_MODE.BASIC, rows: [], players: side.players,
        integrity: hasAny ? TEAM_STAT_INTEGRITY.BASIC : TEAM_STAT_INTEGRITY.NONE,
        revision: current + 1, updatedBy: ctx.actorId, updatedAt: now,
      });
    }
  }

  return ok({ ok: true, mode, warnings, message: '' });
}

/**
 * 一届赛事的球员数据榜。
 *
 * 【为什么不落库】
 * 只统计「已发布」的比赛，从 `team_matches` + `team_match_stats` 现算。
 * 多一张赛季汇总表就多一次不一致的机会，而它没有任何写入方需要它——
 * 赛事一年才打几十场，现算的开销可以忽略。
 */
async function getTeamEventPlayerStats(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const event = await repo.teamEvents.getById(payload.eventId);
  if (!inScope(event, ctx)) return ok(refused('赛事不存在，或不在本协会'));

  const matches = (await repo.teamMatches.list())
    .filter(match => match.eventId === event._id && match.status === TEAM_MATCH_STATUS.PUBLISHED);
  const stats = (await repo.teamMatchStats.list())
    .filter(row => matches.some(match => match._id === row.matchId) && row.integrity !== TEAM_STAT_INTEGRITY.NONE);
  const entries = await repo.teamEventEntries.list();

  const byPlayer = new Map();
  for (const doc of stats) {
    const rows = doc.mode === STAT_MODE.DETAILED
      ? doc.rows
      : (doc.players || []).map(player => ({ userId: player.userId, ...player }));
    for (const row of rows) {
      if (!byPlayer.has(row.userId)) {
        byPlayer.set(row.userId, {
          userId: row.userId,
          games: new Set(),
          points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0, fouls: 0,
          hasPoints: false,
        });
      }
      const acc = byPlayer.get(row.userId);
      acc.games.add(doc.matchId);
      for (const field of Object.keys(STAT_FIELDS)) {
        if (Number.isInteger(row[field])) acc[field] += row[field];
        if (field === 'points' && Number.isInteger(row[field])) acc.hasPoints = true;
      }
    }
  }

  const nameOf = (userId) => {
    for (const entry of entries) {
      const hit = ((entry.roster || []).find(row => row.userId === userId) || {}).name;
      if (hit) return hit;
    }
    return userId;
  };
  const teamOf = (userId) => {
    const entry = entries.find(item => (item.roster || []).some(row => row.userId === userId));
    return entry ? entry.teamId : '';
  };

  const players = [...byPlayer.values()]
    .map(acc => {
      const games = acc.games.size || 1;
      const out = {
        userId: acc.userId, name: nameOf(acc.userId), teamId: teamOf(acc.userId), games: acc.games.size,
      };
      for (const field of Object.keys(STAT_FIELDS)) {
        out[field] = acc.hasPoints || field === 'points' ? acc[field] : acc[field];
      }
      out.pointsPerGame = Math.round((acc.points / games) * 10) / 10;
      out.reboundsPerGame = Math.round((acc.rebounds / games) * 10) / 10;
      out.assistsPerGame = Math.round((acc.assists / games) * 10) / 10;
      return out;
    })
    .sort((a, b) => (b.points - a.points) || (b.rebounds - a.rebounds) || String(a.userId).localeCompare(String(b.userId)));

  return ok({ ok: true, players, matchCount: matches.length, message: '' });
}

module.exports = {
  listTeamEvents,
  getTeamEvent,
  createTeamEvent,
  submitTeamEntry,
  reviewTeamEntry,
  lockTeamEntries,
  drawTeamEvent,
  listTeamMatches,
  recordTeamMatch,
  publishTeamMatch,
  advanceTeamRound,
  settleTeamEvent,
  getTeamMatchStats,
  saveTeamMatchStats,
  getTeamEventPlayerStats,
};
