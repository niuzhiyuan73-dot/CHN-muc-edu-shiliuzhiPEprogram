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
const { TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS } = require('../miniprogram/utils/constants');

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
  assert.equal(updated.status, TEAM_EVENT_STATUS.SCHEDULED);

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
