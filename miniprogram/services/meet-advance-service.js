/**
 * 运动会：预赛分组、晋级推进与赛制签表（B8a）
 * ============================================================
 * 本模块解决两件事，都是「让系统自己算名次」而不是让管理员手填：
 *
 *   1. 数值型项目的预赛 → 决赛：抽签分组、发布各组成绩、按口径晋级；
 *   2. 胜负型项目（拔河等）：生成签表 / 循环赛对阵，记录每场胜负，
 *      由赛制推出最终名次。
 *
 * 【为什么一场比赛就是一条场次记录】
 * 赛程已经用 `sportsMeetSessions` 表达「什么时候、在哪、谁执裁」。签表里的
 * 每一场对阵同样是「什么时候、在哪、谁执裁，谁对谁」，只是多了对阵双方与
 * 胜负。复用它有三个直接好处：
 *   · 不用新增集合，也不用到四处注册点改集合清单；
 *   · 赛程页、裁判指派、开赛、录分全部自动适用，不需要为赛制另写一套；
 *   · 「场次 × 参与人」这份索引本来就要为预赛建，签表顺带就有了。
 * 若另建 `matches` 集合，等于把赛程拆成两套，页面与权限都要写两遍。
 *
 * 【签表所有轮次一次落库，不「打到哪建到哪」】
 * 16 支队是 15 条场次记录，一次写完毫无压力。好处是槽位重算可以做成纯函数：
 * 每次改胜负，从第 1 轮往后把「上一轮胜者」写进下一轮槽位，并顺手清掉
 * 「胜者已不在场上」的过期判定。若改成按需建场次，就要在事务里递归读写，
 * 一旦某一环漏清，后续轮次会带着一个已经被淘汰的人继续比赛。
 *
 * 【赛制只做单败与循环】
 * 见 meet-advance.js 顶部说明：双败与小组赛不是「加几十行」的量级，配置时
 * 直接拒绝，避免按单败跑出一个看似合理实则错误的名次。
 * ============================================================
 */

const { MEET_ENTRY_STATUS, meetSessionKey } = require('../utils/meet-scope.js');
const { createSeededRandom, shuffle } = require('../utils/random.js');
const { drawBracket } = require('../utils/bracket.js');
const { MEET_SCORE_TYPE } = require('./meet-event-catalog.js');
const {
  ADVANCE_MODE, MEET_FORMAT, bracketTotalRounds, bracketRoundLabel,
  advanceFromHeats, bracketStandings, roundRobinRounds, roundRobinStandings,
} = require('./meet-advance.js');
const { freshMeetContext } = require('./meet-context.js');
const { meetReadable, canManageMeet, canPublishMeetResult } = require('./meet-permission.js');

const ok = (data) => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const scopeOf = (ctx) => ({ schoolId: ctx.schoolId, meetId: ctx.meetId });
const toIso = (now) => (now instanceof Date ? now.toISOString() : String(now));

/** 预赛每组默认 8 人，最多 6 组——再多就不是「预赛」而是决赛分枪了。 */
const MAX_HEATS = 6;
const DEFAULT_HEAT_SIZE = 8;

function approvedOf(entries, eventKey) {
  return entries
    .filter((doc) => doc.eventKey === eventKey && doc.status === MEET_ENTRY_STATUS.APPROVED)
    .sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

/** 取一个可复现的随机种子：显式传入优先，否则用当前毫秒。落库后可供复核。 */
function seedOf(payload, now) {
  const given = Number(payload.seed);
  if (Number.isFinite(given) && given > 0) return Math.floor(given) % 2147483647;
  return Number(now instanceof Date ? now.getTime() : Date.now()) % 2147483647;
}

/**
 * 把参赛记录分到若干预赛组。
 *
 * 种子按「一列一个」放（1 号进第 1 组、2 号进第 2 组…），其余随机洗牌后
 * 依次补进当前人数最少的组。这样既保证强手不挤在同一组，也保证各组人数
 * 最多差 1——人数不均会让「每组前 N 晋级」变成对人多那组不公。
 */
function splitIntoHeats(entryKeys, heatCount, seeds, random) {
  const buckets = Array.from({ length: heatCount }, () => []);
  const seedSet = new Set(seeds);
  seeds.forEach((key, index) => {
    if (buckets[index % heatCount]) buckets[index % heatCount].push(key);
  });
  const rest = shuffle(random, entryKeys.filter((key) => !seedSet.has(key)));
  for (const key of rest) {
    let target = 0;
    for (let i = 1; i < heatCount; i += 1) {
      if (buckets[i].length < buckets[target].length) target = i;
    }
    buckets[target].push(key);
  }
  return buckets;
}

/**
 * 抽签分预赛组（D48：预赛随机）。
 *
 * @param {Object} payload { eventKey, heatCount?, seeds?, seed? }
 */
async function drawMeetHeats(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [event, entries, publications] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以抽签分预赛');
  if (event.scoreType === MEET_SCORE_TYPE.VERSUS) {
    return refused('胜负项目不做预赛分组，请用签表编排');
  }
  if (event.rounds !== 'heat_final') return refused('该项目没有配置预赛，不需要抽签分组');

  const approved = approvedOf(entries, eventKey);
  if (approved.length < 2) return refused('参赛记录不足 2 条，无法分预赛');
  if (publications.some((doc) => doc.eventKey === eventKey)) {
    return refused('该项目已有成绩发布，不能再重新抽签');
  }

  const heatCount = Number(payload.heatCount === undefined
    ? Math.min(MAX_HEATS, Math.max(1, Math.ceil(approved.length / DEFAULT_HEAT_SIZE)))
    : payload.heatCount);
  if (!Number.isInteger(heatCount) || heatCount < 1 || heatCount > MAX_HEATS) {
    return refused(`预赛组数应为 1–${MAX_HEATS} 的整数`);
  }

  const entryKeys = approved.map((doc) => doc._id);
  const seeds = (Array.isArray(payload.seeds) ? payload.seeds : [])
    .map((key) => String(key).trim())
    .filter((key) => entryKeys.includes(key));
  const seed = seedOf(payload, ctx.now);
  let buckets;
  try {
    buckets = splitIntoHeats(entryKeys, heatCount, seeds, createSeededRandom(seed));
  } catch (err) {
    return refused((err && err.message) || '分组失败');
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以抽签分预赛');
    const now = toIso(fresh.now);

    for (let i = 1; i <= heatCount; i += 1) {
      const key = meetSessionKey(fresh.meetId, eventKey, 'heat', i);
      const current = await tx.sportsMeetSessions.getById(key);
      await tx.sportsMeetSessions.set(key, {
        ...(current || {}),
        schoolId: fresh.schoolId,
        meetId: fresh.meetId,
        eventKey,
        round: 'heat',
        index: i,
        roundLabel: '预赛',
        entryKeys: buckets[i - 1],
        startAt: (current && current.startAt) || '',
        endAt: (current && current.endAt) || '',
        venue: (current && current.venue) || '',
        note: (current && current.note) || '',
        status: (current && current.status) || 'scheduled',
        createdAt: (current && current.createdAt) || now,
        updatedAt: now,
      });
    }
    // 决赛先建出来（还没定人），赛程才能一起排；参赛人由晋级动作填。
    const finalKey = meetSessionKey(fresh.meetId, eventKey, 'final', 1);
    const finalDoc = await tx.sportsMeetSessions.getById(finalKey);
    if (!finalDoc) {
      await tx.sportsMeetSessions.set(finalKey, {
        schoolId: fresh.schoolId, meetId: fresh.meetId, eventKey,
        round: 'final', index: 1, roundLabel: '决赛', entryKeys: [],
        startAt: '', endAt: '', venue: '', note: '', status: 'scheduled',
        createdAt: now, updatedAt: now,
      });
    }
    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent,
      heatDraw: { seed, heatCount, at: now },
      updatedAt: now,
    });
    return ok({
      eventKey,
      seed,
      heatCount,
      heats: buckets.map((keys, index) => ({ index: index + 1, entryKeys: keys })),
    });
  });
}

/**
 * 按已发布的预赛成绩推进到决赛。
 *
 * 必须「每组都发布」才能晋级：只发布第一组就晋级，等于让其余组的人凭空出局。
 * 晋级名单写进决赛场次的 `entryKeys`，之后决赛只在这些人之内比。
 *
 * @param {Object} payload { eventKey }
 */
async function advanceMeetEvent(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [event, entries, sessions, publications, rows] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
    ctx.repo.forMeet(scope).sportsMeetResultRows.list(),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以推进晋级');
  if (event.rounds !== 'heat_final') return refused('该项目没有预赛，不需要晋级');

  const heatSessions = sessions
    .filter((doc) => doc.eventKey === eventKey && doc.round === 'heat')
    .sort((a, b) => Number(a.index) - Number(b.index));
  if (heatSessions.length === 0) return refused('该项目还没有预赛分组，请先抽签');

  const missing = [];
  const heats = [];
  for (const session of heatSessions) {
    const publication = publications.find((doc) => doc.eventKey === eventKey
      && doc.sessionKey === session._id);
    if (!publication) {
      missing.push(`预赛第 ${session.index} 组`);
      continue;
    }
    const items = rows.filter((row) => row.publicationKey === publication._id
      && row.version === publication.version);
    heats.push({
      index: Number(session.index),
      rows: items.map((row) => ({
        entryKey: row.entryKey, value: row.value, status: row.status,
      })),
    });
  }
  if (missing.length > 0) return refused(`请先发布以下场次成绩：${missing.join('、')}`);

  const advance = event.advance || { mode: ADVANCE_MODE.PER_HEAT, count: 1 };
  const computed = advanceFromHeats({
    heats, mode: advance.mode, count: advance.count, order: event.order,
  });
  if (!computed.ok) return refused(computed.message);
  if (computed.advanced.length < 2) return refused('有效晋级人数不足 2 人，无法组织决赛');

  const finalSession = sessions.find((doc) => doc.eventKey === eventKey && doc.round === 'final');
  if (finalSession && publications.some((doc) => doc.sessionKey === finalSession._id)) {
    return refused('决赛成绩已发布，不能再重新晋级');
  }
  // 参赛记录可能已被撤回（有人退赛），晋级名单只保留仍然通过审核的人
  const alive = new Set(approvedOf(entries, eventKey).map((doc) => doc._id));
  const advancedKeys = computed.advanced.map((row) => row.entryKey).filter((key) => alive.has(key));
  if (advancedKeys.length < 2) return refused('晋级名单里的人已撤回报名，无法组织决赛');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以推进晋级');
    const now = toIso(fresh.now);
    const finalKey = meetSessionKey(fresh.meetId, eventKey, 'final', 1);
    const current = await tx.sportsMeetSessions.getById(finalKey);
    await tx.sportsMeetSessions.set(finalKey, {
      ...(current || {}),
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      eventKey,
      round: 'final',
      index: 1,
      roundLabel: '决赛',
      entryKeys: advancedKeys,
      startAt: (current && current.startAt) || '',
      endAt: (current && current.endAt) || '',
      venue: (current && current.venue) || '',
      note: (current && current.note) || '',
      status: (current && current.status) || 'scheduled',
      createdAt: (current && current.createdAt) || now,
      updatedAt: now,
    });
    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent,
      advanceResult: {
        at: now,
        mode: advance.mode,
        count: advance.count,
        entryKeys: advancedKeys,
        perHeat: computed.perHeat,
      },
      updatedAt: now,
    });
    return ok({
      eventKey,
      entryKeys: advancedKeys,
      advanced: computed.advanced,
      perHeat: computed.perHeat,
    });
  });
}

/**
 * 按「上一轮胜者」重算每一轮的槽位。
 *
 * 纯函数：入参是全部场次（含 entryKeys 与 winnerEntryKey），返回需要改写的场次。
 * 从第 1 轮往后扫，所以「某个胜者被换掉」会顺着链条一路清干净——这正是
 * 手工递归最容易漏的地方（改了第一轮，第三轮还挂着一个已被淘汰的人）。
 */
function recomputeBracket(matches, totalRounds) {
  const byRound = new Map();
  for (const match of matches) {
    if (!byRound.has(match.roundNo)) byRound.set(match.roundNo, new Map());
    byRound.get(match.roundNo).set(match.index, match);
  }
  for (let roundNo = 1; roundNo < totalRounds; roundNo += 1) {
    const current = byRound.get(roundNo) || new Map();
    for (const match of current.values()) {
      const next = (byRound.get(roundNo + 1) || new Map()).get(Math.ceil(match.index / 2));
      if (!next) continue;
      const slot = match.index % 2 === 1 ? 0 : 1;
      next.entryKeys[slot] = match.winnerEntryKey || null;
      // 上一轮的胜者变了：下一轮原先判出的胜者若已不在场上，判定作废
      if (next.winnerEntryKey && !next.entryKeys.includes(next.winnerEntryKey)) {
        next.winnerEntryKey = '';
      }
    }
  }
  return matches;
}

/** 场次上的轮次号：`r3` → 3；循环赛统一记作 1（它不分轮次）。 */
function roundNoOf(session) {
  if (String((session && session.round) || '') === 'rr') return 1;
  const matched = /^r([1-9])$/.exec(String((session && session.round) || ''));
  return matched ? Number(matched[1]) : 0;
}

/** 把场次还原成纯函数要的对阵结构。 */
function matchesOf(sessions, eventKey) {
  return sessions
    .filter((doc) => doc.eventKey === eventKey && roundNoOf(doc) > 0)
    .map((doc) => ({
      sessionKey: doc._id,
      roundNo: roundNoOf(doc),
      index: Number(doc.index) || 1,
      roundLabel: doc.roundLabel || '',
      entryKeys: Array.isArray(doc.entryKeys) && doc.entryKeys.length === 2
        ? [...doc.entryKeys]
        : [null, null],
      winnerEntryKey: doc.winnerEntryKey || '',
    }))
    .sort((a, b) => a.roundNo - b.roundNo || a.index - b.index);
}

/**
 * 生成签表（单败）或全部对阵（循环赛）。
 *
 * @param {Object} payload { eventKey, seeds?, seed? }
 */
async function drawMeetBracket(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [event, entries, sessions] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以编排赛制');
  if (event.scoreType !== MEET_SCORE_TYPE.VERSUS) {
    return refused('只有胜负项目需要签表；数值型项目请用预赛分组');
  }

  const approved = approvedOf(entries, eventKey);
  if (approved.length < 2) return refused('参赛队伍不足 2 支，无法编排赛制');
  const existing = matchesOf(sessions, eventKey);
  if (existing.some((match) => match.winnerEntryKey)) {
    return refused('签表已经开赛，不能重新编排');
  }

  const format = event.format || MEET_FORMAT.SINGLE_ELIM;
  const entryKeys = approved.map((doc) => doc._id);
  const seeds = (Array.isArray(payload.seeds) ? payload.seeds : [])
    .map((key) => String(key).trim())
    .filter((key) => entryKeys.includes(key));
  const seed = seedOf(payload, ctx.now);

  let matches = [];
  let totalRounds = 1;
  let size = entryKeys.length;

  if (format === MEET_FORMAT.ROUND_ROBIN) {
    const rounds = roundRobinRounds(entryKeys);
    totalRounds = Math.max(1, rounds.length);
    size = entryKeys.length;
    let index = 0;
    rounds.forEach((pairs, roundIndex) => {
      for (const [a, b] of pairs) {
        index += 1;
        matches.push({
          roundNo: 1,
          index,
          entryKeys: [a, b],
          winnerEntryKey: '',
          roundLabel: `循环赛 第 ${roundIndex + 1} 轮`,
        });
      }
    });
  } else {
    let draw;
    try {
      draw = drawBracket({ entries: entryKeys, seeds, random: createSeededRandom(seed) });
    } catch (err) {
      return refused((err && err.message) || '抽签失败');
    }
    if (!draw.ok) return refused(draw.firstError || '抽签失败');
    size = draw.size;
    totalRounds = bracketTotalRounds(size);
    for (let roundNo = 1; roundNo <= totalRounds; roundNo += 1) {
      const count = size / Math.pow(2, roundNo);
      for (let index = 1; index <= count; index += 1) {
        const pair = roundNo === 1 ? draw.pairs[index - 1] : [null, null];
        matches.push({
          roundNo,
          index,
          entryKeys: [pair[0], pair[1]],
          winnerEntryKey: '',
          roundLabel: bracketRoundLabel(roundNo, totalRounds),
        });
      }
    }
    // 首轮轮空直接判胜：一方是空位，不需要比赛
    for (const match of matches.filter((row) => row.roundNo === 1)) {
      const [a, b] = match.entryKeys;
      if (a && !b) match.winnerEntryKey = a;
      else if (b && !a) match.winnerEntryKey = b;
    }
    recomputeBracket(matches, totalRounds);
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以编排赛制');
    const now = toIso(fresh.now);

    for (const match of matches) {
      const round = format === MEET_FORMAT.ROUND_ROBIN ? 'rr' : `r${match.roundNo}`;
      const key = meetSessionKey(fresh.meetId, eventKey, round, match.index);
      const current = await tx.sportsMeetSessions.getById(key);
      await tx.sportsMeetSessions.set(key, {
        ...(current || {}),
        schoolId: fresh.schoolId,
        meetId: fresh.meetId,
        eventKey,
        round,
        index: match.index,
        roundLabel: match.roundLabel,
        entryKeys: match.entryKeys,
        winnerEntryKey: match.winnerEntryKey,
        startAt: (current && current.startAt) || '',
        endAt: (current && current.endAt) || '',
        venue: (current && current.venue) || '',
        note: (current && current.note) || '',
        status: (current && current.status) || 'scheduled',
        createdAt: (current && current.createdAt) || now,
        updatedAt: now,
      });
    }

    const currentEvent = await tx.sportsMeetEvents.getById(eventKey);
    await tx.sportsMeetEvents.set(eventKey, {
      ...currentEvent,
      bracket: { format, size, totalRounds, seed, drawnAt: now },
      updatedAt: now,
    });
    return ok({
      eventKey,
      format,
      size,
      totalRounds,
      seed,
      matches: matches.map((match) => ({
        roundNo: match.roundNo,
        index: match.index,
        roundLabel: match.roundLabel,
        entryKeys: match.entryKeys,
        winnerEntryKey: match.winnerEntryKey,
      })),
    });
  });
}

/**
 * 记录一场对阵的胜负，并顺着签表把胜者推上去。
 *
 * @param {Object} payload { sessionKey, winnerEntryKey }，winnerEntryKey 传空表示撤销判定
 */
async function setMeetMatchWinner(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const sessionKey = String(payload.sessionKey || '').trim();
  if (!sessionKey) return refused('请指定场次');
  const scope = scopeOf(ctx);

  const [session, sessions, events] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetSessions.getById(sessionKey),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetEvents.list(),
  ]);
  if (!session || session.meetId !== ctx.meetId) return refused('场次不存在或不属于本届运动会');
  if (!canPublishMeetResult(ctx)) return refused('只有校级管理员及以上或本届总裁判可以判定胜负');
  if (!session.entryKeys || !session.entryKeys.some(Boolean)) {
    return refused('该场次还没有对阵双方');
  }
  const winner = String(payload.winnerEntryKey || '').trim();
  if (winner && !session.entryKeys.includes(winner)) return refused('胜者必须是本场的参赛方');

  const event = events.find((row) => row._id === session.eventKey);
  if (!event || event.scoreType !== MEET_SCORE_TYPE.VERSUS) return refused('该场次不是胜负项目的对阵');
  const bracket = event.bracket || null;
  const singleElim = !bracket || bracket.format !== MEET_FORMAT.ROUND_ROBIN;
  const totalRounds = bracket ? Number(bracket.totalRounds) || 1 : 1;

  const matches = matchesOf(sessions, session.eventKey);
  const target = matches.find((match) => match.sessionKey === sessionKey);
  if (!target) return refused('该场次不属于任何签表轮次');
  target.winnerEntryKey = winner;
  // 循环赛各场相互独立，没有「往上推」这回事
  if (singleElim) recomputeBracket(matches, totalRounds);

  const changed = [];
  for (const match of matches) {
    const previous = sessions.find((row) => row._id === match.sessionKey);
    const before = previous || {};
    const sameEntry = JSON.stringify(before.entryKeys || []) === JSON.stringify(match.entryKeys);
    if (sameEntry && (before.winnerEntryKey || '') === match.winnerEntryKey) continue;
    changed.push(match);
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canPublishMeetResult(fresh)) return refused('只有校级管理员及以上或本届总裁判可以判定胜负');
    const now = toIso(fresh.now);
    for (const match of changed) {
      const current = await tx.sportsMeetSessions.getById(match.sessionKey);
      await tx.sportsMeetSessions.set(match.sessionKey, {
        ...(current || {}),
        entryKeys: match.entryKeys,
        winnerEntryKey: match.winnerEntryKey,
        updatedAt: now,
      });
    }
    const champion = singleElim
      ? (matches.find((match) => match.roundNo === totalRounds && match.winnerEntryKey)
        || {}).winnerEntryKey || ''
      : '';
    const currentEvent = await tx.sportsMeetEvents.getById(session.eventKey);
    await tx.sportsMeetEvents.set(session.eventKey, {
      ...currentEvent, championEntryKey: champion, updatedAt: now,
    });
    return ok({
      sessionKey: sessionKey,
      winnerEntryKey: winner,
      championEntryKey: champion,
      changed: changed.length,
    });
  });
}

/**
 * 赛制视图：签表/对阵、各自胜负、当前名次（未决出时给出还差几场）。
 *
 * @param {Object} payload { eventKey }
 */
async function getMeetBracket(payload = {}, ctx) {
  if (!meetReadable(ctx) || !ctx.meetId) return refused('请先登录');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = scopeOf(ctx);

  const [event, entries, sessions] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetEntries.list(),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  if (event.scoreType !== MEET_SCORE_TYPE.VERSUS) return refused('该项目不是胜负项目');

  const approved = approvedOf(entries, eventKey);
  const entryKeys = approved.map((doc) => doc._id);
  const bracket = event.bracket || null;
  const format = (bracket && bracket.format) || event.format || MEET_FORMAT.SINGLE_ELIM;
  const totalRounds = bracket ? Number(bracket.totalRounds) || 1 : 1;
  const matches = matchesOf(sessions, eventKey);

  const collegeOf = new Map(approved.map((doc) => [doc._id, doc.collegeId]));
  const rows = (format === MEET_FORMAT.ROUND_ROBIN
    ? roundRobinStandings({ entries: entryKeys, matches })
    : bracketStandings({ entries: entryKeys, totalRounds, matches }));

  return ok({
    event: { eventKey, name: event.name, group: event.group, format, scored: event.scored },
    drawn: Boolean(bracket),
    totalRounds,
    championEntryKey: (bracket && event.championEntryKey) || '',
    matches: matches.map((match) => ({
      sessionKey: match.sessionKey,
      roundNo: match.roundNo,
      roundLabel: match.roundLabel || bracketRoundLabel(match.roundNo, totalRounds),
      index: match.index,
      entryKeys: match.entryKeys,
      colleges: match.entryKeys.map((key) => (key ? collegeOf.get(key) || '' : '')),
      winnerEntryKey: match.winnerEntryKey,
    })),
    complete: Boolean(rows.ok),
    message: rows.ok ? '' : rows.message,
    standings: rows.ok
      ? rows.rows.map((row) => ({ ...row, collegeId: collegeOf.get(row.entryKey) || '' }))
      : [],
  });
}

module.exports = {
  drawMeetHeats,
  advanceMeetEvent,
  drawMeetBracket,
  setMeetMatchWinner,
  getMeetBracket,
  // 纯函数导出：测试直接断言槽位重算与对阵生成
  recomputeBracket,
  roundNoOf,
  matchesOf,
};
