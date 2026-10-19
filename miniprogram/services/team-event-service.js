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
  TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS,
} = require('../utils/constants.js');
const { EVENT_FORMAT } = require('../utils/constants.js');
const { normalizeBasketballRules, formatBasketballRules, DEFAULT_PRESET_KEY } = require('../utils/basketball-rules.js');
const { sportTypeOf } = require('../utils/associations.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const NAME_MAX = 30;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FORMATS = [EVENT_FORMAT.SINGLE_ELIM, EVENT_FORMAT.ROUND_ROBIN, EVENT_FORMAT.GROUP_KNOCKOUT];

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
    entryCount: Number(entryCount) || 0,
    canManage: manage,
    createdAt: event.createdAt || null,
  };
}

/* ---------------- 读 ---------------- */

async function listTeamEvents(_payload = {}, ctx) {
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
    }));

  return ok({
    ok: true,
    event: eventView(event, ctx, { manage, entryCount: entries.length }),
    entries: rows,
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

  const now = ctx.now;
  await ctx.repo.forScope(ctx).teamEvents.set(eventId, {
    _id: eventId, schoolId: ctx.schoolId, association: ctx.association,
    name, format, rules, status: TEAM_EVENT_STATUS.REGISTRATION,
    entryMin: rules.rosterMin, entryMax: rules.rosterMax,
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
    ...event, status: TEAM_EVENT_STATUS.SCHEDULED,
    lockedCount: entries.length,
    revision: Number(event.revision || 1) + 1, updatedAt: now,
  });
  return ok({ ok: true, locked: entries.length, message: '' });
}

module.exports = {
  listTeamEvents,
  getTeamEvent,
  createTeamEvent,
  submitTeamEntry,
  reviewTeamEntry,
  lockTeamEntries,
};
