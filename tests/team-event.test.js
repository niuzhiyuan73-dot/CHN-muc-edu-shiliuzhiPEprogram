/**
 * 团队赛事（C 期首片）：建赛 → 报名 → 审核 → 锁定名单
 * 守三件事：规则快照建赛时固化、报名人数按 5 人下限卡、锁定后不可再改。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/team-event-service');
const teamHandlers = require('../miniprogram/services/team-service');
const { schoolMemberKey, schoolMembershipKey } = require('../miniprogram/utils/school');
const { TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS, TEAM_MATCH_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

function fixture(playerCount = 5) {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  ['u_cap', 'u_leader'].forEach(add);
  for (let i = 1; i < playerCount; i += 1) add(`u_p${i}`);
  seed.memberships.push({ _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active' });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

/** 球队相关动作在 team-service 里 */
async function callTeam(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamHandlers[action](payload, ctx)).data;
}

/** 建一支已通过的队，队员为 u_cap + u_p1.. */
async function teamWithPlayers(repo, players = 4) {
  const created = await callTeam(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_t1' }, 'u_cap');
  await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
  for (let i = 1; i < players; i += 1) {
    await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, `u_p${i}`);
    await callTeam(repo, 'reviewTeamMember', { teamId: created.teamId, userId: `u_p${i}`, approve: true }, 'u_cap');
  }
  return created.teamId;
}

test('建赛 —— 规则快照固化，报名阶段，名称重名被拒', async () => {
  const repo = fixture();
  const done = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1', presetKey: 'campus-2x20' });
  assert.equal(done.ok, true, done.message);

  const event = await repo.teamEvents.getById(done.eventId);
  assert.equal(event.status, TEAM_EVENT_STATUS.REGISTRATION);
  assert.equal(event.rules.periods, 2);
  assert.equal(event.rules.periodMinutes, 20);
  assert.equal(event.entryMin, 5, '报名下限取规则快照的 5 人');

  const same = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e2' });
  assert.equal(same.ok, false);
  assert.match(same.message, /同名/);
});

test('建赛 —— 普通会员不能建赛；非法规则被拒', async () => {
  const repo = fixture();
  const denied = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' }, 'u_cap');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /协会负责人/);

  const bad = await call(repo, 'createTeamEvent', {
    name: '秋季联赛', requestId: 'req_e2', rules: { periods: 9 },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不合法/);
});

test('报名 —— 只有队长能报，人数不足 5 人被拒', async () => {
  const repo = fixture();
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamId = await teamWithPlayers(repo, 2); // 队长 + 1 名队员 = 2 人

  const notCaptain = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_p1');
  assert.equal(notCaptain.ok, false);
  assert.match(notCaptain.message, /队长/);

  const tooFew = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /至少需要 5 人/);
});

test('报名 → 审核 → 锁定：名单成为快照，锁后不可改', async () => {
  const repo = fixture();
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamId = await teamWithPlayers(repo, 5);

  const submitted = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.status, TEAM_ENTRY_STATUS.SUBMITTED);

  await call(repo, 'reviewTeamEntry', { eventId: event.eventId, teamId, approve: true });
  const locked = await call(repo, 'lockTeamEntries', { eventId: event.eventId });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, 1);

  const updated = await repo.teamEvents.getById(event.eventId);
  assert.equal(updated.status, TEAM_EVENT_STATUS.LOCKED, '锁定名单只到「名单已锁定」，赛程要抽签之后才有');

  const entry = await repo.teamEventEntries.getById(
    require('../miniprogram/utils/school.js').schoolKey('ten', event.eventId, teamId)
  );
  assert.equal(entry.status, TEAM_ENTRY_STATUS.LOCKED);
  assert.equal(entry.roster.length, 5);
  assert.ok(entry.roster.every(row => row.name), '快照里要有当时的姓名');

  const again = await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  assert.equal(again.ok, false);
  // 锁定后赛事已转「赛程已发布」，报名口先被状态挡住
  assert.match(again.message, /不开放报名|已锁定/);
});

test('详情 —— 非管理者看不到被退回的报名', async () => {
  const repo = fixture();
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const teamId = await teamWithPlayers(repo, 5);
  await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId }, 'u_cap');
  await call(repo, 'reviewTeamEntry', { eventId: event.eventId, teamId, approve: false });

  const asLeader = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_leader');
  assert.equal(asLeader.entries.length, 1);

  const asMember = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_p1');
  assert.equal(asMember.entries.length, 0);
});

/* ============================================================
 * 十、抽签 → 赛程 → 录分 → 发布 → 结算
 * ============================================================
 * 这一段才是「真的办完一届比赛」。此前的用例只到锁定名单；从这里开始，
 * 球队要按签表打、比分要发布才进积分表、名次要结算才算数。
 * ============================================================ */

/** 造一份能支撑 N 支球队 × R 人的种子数据 */
function fixtureFor(teamCount, roster) {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true,
    });
  };
  add('u_leader');
  for (let t = 0; t < teamCount; t += 1) {
    add(`u_t${t}c`);
    for (let p = 0; p < roster - 1; p += 1) add(`u_t${t}p${p}`);
  }
  seed.memberships.push({
    _id: schoolMembershipKey('u_leader', SCOPE),
    userId: 'u_leader', schoolId: 'muc', association: 'bk', role: 'leader', status: 'active',
  });
  return createSchoolMemoryRepo(seed);
}

/** 建 N 支队、各自报名、审核、锁定，返回赛事与球队编号 */
async function lockedEvent(repo, { teamCount = 4, roster = 5, format } = {}) {
  const event = await call(repo, 'createTeamEvent', {
    name: '秋季联赛', requestId: 'req_e1', ...(format ? { format } : {}),
  });
  const teamIds = [];
  for (let t = 0; t < teamCount; t += 1) {
    const captain = `u_t${t}c`;
    const created = await callTeam(repo, 'createTeamApplication', {
      name: `球队${t + 1}`, requestId: `req_t${t}`,
    }, captain);
    await callTeam(repo, 'reviewTeamApplication', { teamId: created.teamId, approve: true });
    for (let p = 0; p < roster - 1; p += 1) {
      const memberId = `u_t${t}p${p}`;
      await callTeam(repo, 'applyToJoinTeam', { teamId: created.teamId }, memberId);
      await callTeam(repo, 'reviewTeamMember', {
        teamId: created.teamId, userId: memberId, approve: true,
      }, captain);
    }
    await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId: created.teamId }, captain);
    await call(repo, 'reviewTeamEntry', {
      eventId: event.eventId, teamId: created.teamId, approve: true,
    });
    teamIds.push(created.teamId);
  }
  const locked = await call(repo, 'lockTeamEntries', { eventId: event.eventId });
  assert.equal(locked.ok, true, locked.message);
  return { eventId: event.eventId, teamIds };
}

test('抽签 —— 四支队出两场半决赛，赛事转「赛程已发布」', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);

  const drawn = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.matchCount, 2, '4 支队首轮两场');
  assert.equal(drawn.rounds, 1);

  const event = await repo.teamEvents.getById(eventId);
  assert.equal(event.status, TEAM_EVENT_STATUS.SCHEDULED);
  assert.equal(event.draw.size, 4);
  assert.ok(Number.isInteger(event.draw.seed), '种子要落库，事后能复核');

  const list = await call(repo, 'listTeamMatches', { eventId });
  assert.equal(list.matches.length, 2);
  list.matches.forEach((row) => {
    assert.equal(row.status, TEAM_MATCH_STATUS.SCHEDULED);
    assert.equal(row.scoreText, '—', '没开打不能显示 0 : 0');
    assert.notEqual(row.teamA, row.teamB);
  });
});

test('抽签 —— 没锁定名单不能抽；已有比分不能重抽', async () => {
  const repo = fixtureFor(4, 5);
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  const early = await call(repo, 'drawTeamEvent', { eventId: event.eventId });
  assert.equal(early.ok, false);
  assert.match(early.message, /锁定/);

  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const list = await call(repo, 'listTeamMatches', { eventId });
  const first = list.matches[0];
  await call(repo, 'recordTeamMatch', { matchId: first.matchId, scoreA: 80, scoreB: 70 });
  const again = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(again.ok, false);
  assert.match(again.message, /录了分/);
});

test('淘汰赛全流程 —— 两场半决赛发布后才能排决赛，决赛发布后可结算', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });

  const first = (await call(repo, 'listTeamMatches', { eventId })).matches;
  assert.equal(first.length, 2);

  // 半决赛还没发完就排下一轮 → 拒绝
  const tooEarly = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.message, /未发布/);

  for (const row of first) {
    const recorded = await call(repo, 'recordTeamMatch', {
      matchId: row.matchId, scoreA: row.teamA < row.teamB ? 80 : 70, scoreB: row.teamA < row.teamB ? 70 : 80,
    });
    assert.equal(recorded.ok, true, recorded.message);
    const published = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
    assert.equal(published.ok, true, published.message);
  }

  const advanced = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(advanced.ok, true, advanced.message);
  assert.equal(advanced.matchCount, 1, '4 队签表下一轮只有决赛');

  const all = (await call(repo, 'listTeamMatches', { eventId })).matches;
  assert.equal(all.length, 3);
  const final = all.find(row => row.round === 2);
  assert.ok(final, '应当排出决赛');

  // 前面已发布，此时才能结算；但决赛还没打
  const pending = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(pending.ok, false);
  assert.match(pending.message, /未发布/);

  await call(repo, 'recordTeamMatch', { matchId: final.matchId, scoreA: 90, scoreB: 88 });
  await call(repo, 'publishTeamMatch', { matchId: final.matchId, approve: true });

  const settled = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(settled.ok, true, settled.message);
  assert.equal(settled.placements.length, 4);
  assert.equal(settled.placements[0].note, '冠军');
  assert.equal(settled.placements[1].note, '亚军');
  assert.deepEqual(settled.placements.map(row => row.rank), [1, 2, 3, 4]);

  const event = await repo.teamEvents.getById(eventId);
  assert.equal(event.status, TEAM_EVENT_STATUS.FINISHED);
  assert.equal(event.placements.length, 4);
});

test('循环赛 —— 抽签一次排完全部轮次，结算按积分表', async () => {
  const repo = fixtureFor(3, 5);
  const { eventId } = await lockedEvent(repo, { teamCount: 3, format: 'round_robin' });
  const drawn = await call(repo, 'drawTeamEvent', { eventId });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.rounds, 3, '3 支队单循环共 3 轮');
  assert.equal(drawn.matchCount, 3);

  const list = await call(repo, 'listTeamMatches', { eventId });
  // 让 teamA 全部赢：每人一场，最终 2 胜 1 负之类的分布不固定，这里只求全员打完
  for (const row of list.matches) {
    await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 70 });
    await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  }

  const noNext = await call(repo, 'advanceTeamRound', { eventId });
  assert.equal(noNext.ok, false);
  assert.match(noNext.message, /循环赛没有下一轮/);

  const settled = await call(repo, 'settleTeamEvent', { eventId });
  assert.equal(settled.ok, true, settled.message);
  assert.equal(settled.placements.length, 3);
  assert.deepEqual(settled.placements.map(row => row.rank), [1, 2, 3]);
  assert.equal(settled.placements[0].note, '冠军');

  const detail = await call(repo, 'getTeamEvent', { eventId });
  assert.equal(detail.table.length, 3);
  assert.ok(detail.table.every(row => row.played === 2), '单循环每人打两场');
});

test('录分 —— 平局、非法比分、越权都被拦下', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  const tie = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 80 });
  assert.equal(tie.ok, false);
  assert.match(tie.message, /平局/);

  const bad = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80.5, scoreB: 70 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /整数/);

  const zero = await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 0, scoreB: 0 });
  assert.equal(zero.ok, false);

  // 路过的会员（不是队长、不是管理者）
  const stranger = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 80, scoreB: 70,
  }, 'u_t1p0');
  assert.equal(stranger.ok, false);
  assert.match(stranger.message, /队长/);

  // 参赛队队长可以录
  const okAsCaptain = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId, scoreA: 80, scoreB: 70,
  }, 'u_t0c');
  assert.equal(okAsCaptain.ok, true, okAsCaptain.message);
});

test('发布 —— 待审核驳回会把比分清空并要求重录', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  await call(repo, 'recordTeamMatch', { matchId: row.matchId, scoreA: 80, scoreB: 70 });
  const rejected = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: false });
  assert.equal(rejected.ok, true);

  const after = (await call(repo, 'listTeamMatches', { eventId })).matches
    .find(item => item.matchId === row.matchId);
  assert.equal(after.status, TEAM_MATCH_STATUS.SCHEDULED);
  assert.equal(after.scoreA, null, '驳回不能留着旧比分让人猜');
  assert.equal(after.winner, null);

  const publishAgain = await call(repo, 'publishTeamMatch', { matchId: row.matchId, approve: true });
  assert.equal(publishAgain.ok, false, '没重录就发布不了');
});

test('录分 —— 带个人统计时合计与球队得分不符只提示，不拒绝', async () => {
  const repo = fixtureFor(4, 5);
  const { eventId } = await lockedEvent(repo);
  await call(repo, 'drawTeamEvent', { eventId });
  const row = (await call(repo, 'listTeamMatches', { eventId })).matches[0];

  // 统计里的人和球队必须真的属于这一方：签表是洗过牌的，不能假设谁对谁
  const entries = await repo.teamEventEntries.list();
  const roster = entries.find(item => item.teamId === row.teamA).roster;
  const scorer = roster[0].userId;

  const out = await call(repo, 'recordTeamMatch', {
    matchId: row.matchId,
    scoreA: 80,
    scoreB: 70,
    stats: [{ teamId: row.teamA, players: [{ userId: scorer, points: 20, fouls: 3 }] }],
  });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /差 60 分待归属/);

  const stats = await repo.teamMatchStats.getById(
    require('../miniprogram/utils/school.js').schoolKey('tms', row.matchId, row.teamA)
  );
  assert.equal(stats.integrity, 'basic');
  assert.deepEqual(stats.players, [{ userId: scorer, points: 20, fouls: 3 }]);
});

test('详情 —— 报名入口：队长只看到自己队，管理者看到所有还没报的队', async () => {
  const repo = fixtureFor(4, 5);
  const event = await call(repo, 'createTeamEvent', { name: '秋季联赛', requestId: 'req_e1' });
  // 两支已通过的球队：t0（5 人）、t1（4 人，还差 1 个）
  const t0 = await callTeam(repo, 'createTeamApplication', { name: '热浪队', requestId: 'req_a' }, 'u_t0c');
  await callTeam(repo, 'reviewTeamApplication', { teamId: t0.teamId, approve: true });
  for (let i = 0; i < 4; i += 1) {
    await callTeam(repo, 'applyToJoinTeam', { teamId: t0.teamId }, `u_t0p${i}`);
    await callTeam(repo, 'reviewTeamMember', { teamId: t0.teamId, userId: `u_t0p${i}`, approve: true }, 'u_t0c');
  }
  const t1 = await callTeam(repo, 'createTeamApplication', { name: '闪电队', requestId: 'req_b' }, 'u_t1c');
  await callTeam(repo, 'reviewTeamApplication', { teamId: t1.teamId, approve: true });
  for (let i = 0; i < 3; i += 1) {
    await callTeam(repo, 'applyToJoinTeam', { teamId: t1.teamId }, `u_t1p${i}`);
    await callTeam(repo, 'reviewTeamMember', { teamId: t1.teamId, userId: `u_t1p${i}`, approve: true }, 'u_t1c');
  }

  // 队长：只有自己那支
  const asCaptain = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_t0c');
  assert.equal(asCaptain.submitCandidates.length, 1);
  assert.equal(asCaptain.submitCandidates[0].teamId, t0.teamId);
  assert.equal(asCaptain.submitCandidates[0].memberCount, 5);
  assert.equal(asCaptain.submitCandidates[0].enough, true);

  // 管理者：两支都在，人数不足的那支标出来
  const asLeader = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_leader');
  assert.equal(asLeader.submitCandidates.length, 2);
  const weak = asLeader.submitCandidates.find(row => row.teamId === t1.teamId);
  assert.equal(weak.memberCount, 4);
  assert.equal(weak.enough, false);

  // 报过名（待审核）之后就不再出现在候选里
  await call(repo, 'submitTeamEntry', { eventId: event.eventId, teamId: t0.teamId }, 'u_t0c');
  const after = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_t0c');
  assert.deepEqual(after.submitCandidates, []);

  // 退回之后可以重报
  await call(repo, 'reviewTeamEntry', { eventId: event.eventId, teamId: t0.teamId, approve: false });
  const reopened = await call(repo, 'getTeamEvent', { eventId: event.eventId }, 'u_t0c');
  assert.equal(reopened.submitCandidates.length, 1);
});
