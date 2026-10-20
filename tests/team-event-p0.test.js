/**
 * 篮球 P0：并发、统计准确性、发布隔离
 * ============================================================
 * 这四条不是新需求，是「已交付能力不可信」的缺陷回归。此前的 103 项测试
 * 全绿却没抓到它们，原因是：
 *   · 并发用例总是**串行**调用，两个请求一前一后，自然看不出丢失更新；
 *   · 榜单用例只断言「填了的指标对不对」，没断言「没填的指标该是什么」；
 *   · 按节合计用例只录了一个人，全队合计与个人合计恰好相等，错误被掩盖；
 *   · 可见性用例全用管理员账号跑，普通成员视角从未进入断言。
 * 这里逐条把那几个缺口补上。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/team-event-service');
const teamHandlers = require('../miniprogram/services/team-service');
const { schoolMemberKey, schoolMembershipKey, schoolKey } = require('../miniprogram/utils/school');
const { TEAM_MATCH_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-20T10:00:00Z');
const SCOPE = { schoolId: 'muc', association: 'bk' };

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

async function call(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

async function callTeam(repo, action, payload = {}, actor = 'u_leader') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now: NOW });
  return (await teamHandlers[action](payload, ctx)).data;
}

/** 建 teamCount 支队（每队 roster 人）、报名、审核、锁定，返回赛事与球队 */
async function lockedEvent(repo, { teamCount = 2, roster = 5, format, statPolicy } = {}) {
  const event = await call(repo, 'createTeamEvent', {
    name: '秋季联赛',
    requestId: 'req_e1',
    ...(format ? { format } : {}),
    ...(statPolicy ? { statPolicy } : {}),
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
  await call(repo, 'drawTeamEvent', { eventId: event.eventId });
  const matches = (await call(repo, 'listTeamMatches', { eventId: event.eventId })).matches;
  return { eventId: event.eventId, teamIds, match: matches[0] };
}

/* ============================================================
 * 一、并发：同版本号两次提交只能有一次生效
 * ============================================================ */

test('并发 —— 两个请求带同一版本号同时录分，只有一次生效，不静默覆盖', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await lockedEvent(repo);
  assert.equal(match.revision, 1, '刚抽签出来的比赛版本号是 1');

  // 真正并发：不 await 第一个就发第二个。旧实现在这里会让两次都成功，
  // 后到的把 80:70 直接盖成 81:70。
  const [first, second] = await Promise.all([
    call(repo, 'recordTeamMatch', {
      matchId: match.matchId, scoreA: 80, scoreB: 70, expectRevision: 1,
    }),
    call(repo, 'recordTeamMatch', {
      matchId: match.matchId, scoreA: 81, scoreB: 70, expectRevision: 1,
    }),
  ]);

  const winners = [first, second].filter(row => row.ok === true);
  const losers = [first, second].filter(row => row.ok !== true);
  assert.equal(winners.length, 1, '只能有一次成功');
  assert.equal(losers.length, 1, '另一次必须被拒');
  assert.match(losers[0].message, /刚被改过/);

  const doc = await repo.teamMatches.getById(match.matchId);
  assert.equal(doc.revision, 2, '只进了一版');
  // 存下来的必须是「成功那一次」的比分，不能是两次的混合
  const expected = winners[0] === first ? [80, 70] : [81, 70];
  assert.deepEqual([doc.scoreA, doc.scoreB], expected);
});

test('并发 —— 比赛返回体带版本号，页面才有东西可传', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await lockedEvent(repo);

  const list = await call(repo, 'listTeamMatches', { eventId });
  const row = list.matches.find(item => item.matchId === match.matchId);
  assert.equal(row.revision, 1, '赛程列表要下发版本号');

  await call(repo, 'recordTeamMatch', {
    matchId: match.matchId, scoreA: 80, scoreB: 70, expectRevision: 1,
  });
  const detail = await call(repo, 'getTeamEvent', { eventId });
  const after = detail.matches.find(item => item.matchId === match.matchId);
  assert.equal(after.revision, 2, '录完版本 +1，详情页据此判断要不要刷新');

  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  assert.equal(panel.match.revision, 2, '统计面板上的比赛也要带版本号');
});

/* ============================================================
 * 二、统计准确性：按节合计按人算
 * ============================================================ */

test('按节统计 —— 两人分别 10 分与 3 分，读回来各自 10 与 3', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await lockedEvent(repo, { statPolicy: 'detailed' });
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 13, scoreB: 9 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const side = panel.sides.find(item => item.teamId === match.teamA);
  const [p0, p1, p2] = side.players;

  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [
      { period: 1, userId: p0.userId, points: 10 },
      { period: 1, userId: p1.userId, points: 3 },
    ],
  });

  const reread = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const players = reread.sides.find(item => item.teamId === match.teamA).players;
  assert.equal(players.find(row => row.userId === p0.userId).points, 10, '第一个人是自己的 10 分');
  assert.equal(players.find(row => row.userId === p1.userId).points, 3, '第二个人是自己的 3 分，不是全队 13');
  assert.equal(players.find(row => row.userId === p2.userId).points, null, '没上场记录的人是未记录，不是 13');
});

test('按节统计 —— 同一个人跨两节的分数只累到自己头上', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await lockedEvent(repo, { statPolicy: 'detailed' });
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 25, scoreB: 9 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const side = panel.sides.find(item => item.teamId === match.teamA);
  const [p0, p1] = side.players;

  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [
      { period: 1, userId: p0.userId, points: 6, rebounds: 2 },
      { period: 2, userId: p0.userId, points: 4, rebounds: 1 },
      { period: 1, userId: p1.userId, points: 7, rebounds: 3 },
    ],
  });

  const reread = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const players = reread.sides.find(item => item.teamId === match.teamA).players;
  const a = players.find(row => row.userId === p0.userId);
  const b = players.find(row => row.userId === p1.userId);
  assert.equal(a.points, 10);
  assert.equal(a.rebounds, 3);
  assert.equal(b.points, 7);
  assert.equal(b.rebounds, 3, '第二个人不该拿到别人的篮板');
});

/* ============================================================
 * 三、未记录 ≠ 0
 * ============================================================ */

test('球员榜 —— 只录得分时，篮板与助攻是未记录而不是 0', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await lockedEvent(repo, { statPolicy: 'detailed' });
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 20, scoreB: 9 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const scorer = panel.sides.find(item => item.teamId === match.teamA).players[0];
  // 只填得分，篮板/助攻/抢断一个格子都不碰
  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [{ period: 1, userId: scorer.userId, points: 20 }],
  });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });

  const board = await call(repo, 'getTeamEventPlayerStats', { eventId });
  assert.equal(board.players.length, 1);
  const row = board.players[0];
  assert.equal(row.points, 20);
  assert.equal(row.rebounds, null, '一场都没记过篮板 → null，不是 0');
  assert.equal(row.assists, null);
  assert.equal(row.reboundsText, '—', '页面显示 —，不显示 0');
  assert.equal(row.assistsPerGame, null, '未记录的指标不参与场均');
  assert.equal(row.assistsPerGameText, '—');

  // 同一指标有记录的场次才进分母：这里只有 1 场，场均等于总数
  assert.equal(row.reboundsPerGame, null);
  assert.equal(row.pointsPerGame, 20);
});

/* ============================================================
 * 四、发布隔离：待审核的比分与统计不对普通成员可见
 * ============================================================ */

test('可见性 —— 普通成员看不到待审核比分，队长与管理者看得到', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await lockedEvent(repo);
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 86, scoreB: 80 });

  const stranger = await call(repo, 'getTeamEvent', { eventId }, 'u_t1p0');
  const hidden = stranger.matches.find(item => item.matchId === match.matchId);
  assert.equal(hidden.status, TEAM_MATCH_STATUS.REVIEWING, '状态仍是待审核');
  assert.equal(hidden.scoreA, null, '普通成员拿不到待审核比分');
  assert.equal(hidden.scoreText, '待审核', '看到的是「待审核」而不是一串数字');
  assert.equal(hidden.winner, null, '胜负也不下发');

  // 参赛队队长：自己录的分自己要看得见
  const captain = await call(repo, 'getTeamEvent', { eventId }, 'u_t0c');
  const own = captain.matches.find(item => item.matchId === match.matchId);
  assert.equal(own.scoreText, '86 : 80');

  const leader = await call(repo, 'getTeamEvent', { eventId }, 'u_leader');
  const admin = leader.matches.find(item => item.matchId === match.matchId);
  assert.equal(admin.scoreText, '86 : 80');
});

test('可见性 —— 未发布比赛的统计面板，普通成员直接拿不到', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await lockedEvent(repo);
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 86, scoreB: 80 });

  const denied = await call(repo, 'getTeamMatchStats', { matchId: match.matchId }, 'u_t1p0');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /还没发布/);

  const allowed = await call(repo, 'getTeamMatchStats', { matchId: match.matchId }, 'u_leader');
  assert.equal(allowed.ok, true);
});

test('可见性 —— 发布之后普通成员才看到比分与统计', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await lockedEvent(repo);
  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const scorer = panel.sides.find(item => item.teamId === match.teamA).players[0];

  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 86, scoreB: 80 });
  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    players: [{ userId: scorer.userId, points: 30 }],
  });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });

  const stranger = await call(repo, 'getTeamEvent', { eventId }, 'u_t1p0');
  const row = stranger.matches.find(item => item.matchId === match.matchId);
  assert.equal(row.scoreText, '86 : 80');

  const stats = await call(repo, 'getTeamMatchStats', { matchId: match.matchId }, 'u_t1p0');
  assert.equal(stats.ok, true);
  const shown = stats.sides.find(item => item.teamId === match.teamA).players
    .find(item => item.userId === scorer.userId);
  assert.equal(shown.points, 30, '发布时统计一并发布，普通成员立刻能看到');
  assert.equal(stats.canEdit, false, '普通成员只读');
});

/* ============================================================
 * 五、已发布比赛的统计改动走独立审核
 * ============================================================ */

test('统计审核 —— 已发布比赛改统计不直接生效，审核通过后才更新榜单', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await lockedEvent(repo, { statPolicy: 'detailed' });
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 20, scoreB: 9 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const side = panel.sides.find(item => item.teamId === match.teamA);
  const scorer = side.players[0];

  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [{ period: 1, userId: scorer.userId, points: 20 }],
  });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });

  const before = await call(repo, 'getTeamEventPlayerStats', { eventId });
  assert.equal(before.players[0].points, 20);

  // 发布后更正：把 20 分改成 18 分
  const reopened = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const revision = Math.max(...reopened.sides.map(item => item.revision));
  const saved = await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [{ period: 1, userId: scorer.userId, points: 18 }],
    expectRevision: revision,
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.needReview, true, '已发布比赛的改动要重新审核');

  const during = await call(repo, 'getTeamEventPlayerStats', { eventId });
  assert.equal(during.players[0].points, 20, '审核通过前，榜单仍是上一版');

  const doc = await repo.teamMatchStats.getById(schoolKey('tms', match.matchId, match.teamA));
  assert.equal(doc.status, 'pending');
  assert.equal(doc.published.revision, doc.publishedRevision, '已发布快照不动');

  const approved = await call(repo, 'reviewTeamMatchStats', { matchId: match.matchId, approve: true });
  assert.equal(approved.ok, true, approved.message);
  const after = await call(repo, 'getTeamEventPlayerStats', { eventId });
  assert.equal(after.players[0].points, 18, '通过之后榜单才跟着变');
});

test('统计审核 —— 退回把工作副本还原成已发布版本', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await lockedEvent(repo, { statPolicy: 'detailed' });
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 20, scoreB: 9 });

  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const scorer = panel.sides.find(item => item.teamId === match.teamA).players[0];
  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [{ period: 1, userId: scorer.userId, points: 20 }],
  });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });

  const reopened = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const revision = Math.max(...reopened.sides.map(item => item.revision));
  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId,
    mode: 'detailed',
    rows: [{ period: 1, userId: scorer.userId, points: 99 }],
    expectRevision: revision,
  });

  const rejected = await call(repo, 'reviewTeamMatchStats', { matchId: match.matchId, approve: false });
  assert.equal(rejected.ok, true, rejected.message);

  const reread = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const shown = reread.sides.find(item => item.teamId === match.teamA).players
    .find(item => item.userId === scorer.userId);
  assert.equal(shown.points, 20, '退回后回到已发布的那一版，不是 99');

  const doc = await repo.teamMatchStats.getById(schoolKey('tms', match.matchId, match.teamA));
  assert.equal(doc.status, 'published');
  assert.equal(doc.pendingReview, undefined);
});

test('统计审核 —— 非管理员审不了；没有待审核版本时给出人话', async () => {
  const repo = fixtureFor(2, 5);
  const { match } = await lockedEvent(repo);
  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 20, scoreB: 9 });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });

  const denied = await call(repo, 'reviewTeamMatchStats', {
    matchId: match.matchId, approve: true,
  }, 'u_t0c');
  assert.equal(denied.ok, false);
  assert.match(denied.message, /协会负责人/);

  const nothing = await call(repo, 'reviewTeamMatchStats', { matchId: match.matchId, approve: true });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /没有待审核/);
});

/* ============================================================
 * 六、驳回要把比分与统计一起退回
 * ============================================================ */

test('驳回 —— 比分清空的同时，统计也不再对外可见', async () => {
  const repo = fixtureFor(2, 5);
  const { eventId, match } = await lockedEvent(repo);
  const panel = await call(repo, 'getTeamMatchStats', { matchId: match.matchId });
  const scorer = panel.sides.find(item => item.teamId === match.teamA).players[0];

  await call(repo, 'recordTeamMatch', { matchId: match.matchId, scoreA: 86, scoreB: 80 });
  await call(repo, 'saveTeamMatchStats', {
    matchId: match.matchId, players: [{ userId: scorer.userId, points: 30 }],
  });
  await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: true });
  assert.equal((await call(repo, 'getTeamEventPlayerStats', { eventId })).players.length, 1);

  // 把已发布的比赛驳回：现实里靠「先驳回再重录」，这里直接改状态更贴近接口能力
  const doc = await repo.teamMatches.getById(match.matchId);
  await repo.teamMatches.set(match.matchId, { ...doc, status: TEAM_MATCH_STATUS.REVIEWING });
  const rejected = await call(repo, 'publishTeamMatch', { matchId: match.matchId, approve: false });
  assert.equal(rejected.ok, true, rejected.message);

  const board = await call(repo, 'getTeamEventPlayerStats', { eventId });
  assert.equal(board.players.length, 0, '比分退回后，统计一并退出榜单');
});
