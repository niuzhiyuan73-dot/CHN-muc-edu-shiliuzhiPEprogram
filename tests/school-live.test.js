/**
 * 学校维度：实时比分状态机（迁移清单 M1-c）
 *
 * 守的是：开台 / 判球 / 撤销 / 定稿 / 批量读的权限与幂等与旧栈同口径，
 * 实时态钉在 `schoolId + association` 上，跨校读不到也写不进。
 * 逐球重算、定稿只交「打完的局」等纯逻辑由 live-score.js 的既有用例覆盖，本片
 * 只验学校维度的归属与权限来源。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-live-service');
const matchHandlers = require('../miniprogram/services/school-match-service');
const { schoolMemberKey, schoolMatchKey, schoolKey, schoolLiveKey } = require('../miniprogram/utils/school');
const { MATCH_TYPE, MATCH_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member');
  add('demo_muc_member_2');
  add('demo_muc_member_3');
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

/** 与 call 同路数，换成比赛读端的处理器（验证读端是否带 live）。 */
async function callMatch(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await matchHandlers[action](payload, ctx)).data;
}

async function seedMatch(repo, { id = 'm1', bestOf = 3, status = MATCH_STATUS.PENDING,
  teamA = ['demo_muc_member'], teamB = ['demo_muc_member_2'] } = {}) {
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_member', id), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA, teamB,
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status, revision: 1,
  });
  return matchId;
}

/** 连判 n 球给某一方；每球带唯一编号，避开幂等去重。 */
async function rallies(repo, matchId, side, n, prefix) {
  for (let i = 0; i < n; i += 1) {
    await call(repo, 'recordSchoolRally', { matchId, side, rallyId: `${prefix}-${side}-${i}` });
  }
}

test('开台：参赛者可开，非参赛会员被拒；重开不重置比分', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);

  const denied = await call(repo, 'startSchoolLiveScore', { matchId }, { actor: 'demo_muc_member_3' });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /无权/);

  const started = await call(repo, 'startSchoolLiveScore', { matchId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.live.status, 'live');
  assert.equal(started.live.matchId, matchId);

  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  const again = await call(repo, 'startSchoolLiveScore', { matchId });
  assert.equal(again.live.pointsA, 1, '重开不重置比分');
});

test('判球：逐球累计，同一球编号幂等，非法方向被拒', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });

  const a = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  assert.equal(a.live.pointsA, 1);
  const dup = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  assert.equal(dup.live.pointsA, 1, '同编号不重复计一次');
  const b = await call(repo, 'recordSchoolRally', { matchId, side: 'B', rallyId: 'r2' });
  assert.equal(b.live.pointsB, 1);

  const bad = await call(repo, 'recordSchoolRally', { matchId, side: 'X', rallyId: 'r3' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不合法/);
});

test('未开台不能判球；已生效的比赛不能开台', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  const noTable = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  assert.equal(noTable.ok, false);
  assert.match(noTable.message, /还没开/);

  const activeId = await seedMatch(repo, { id: 'm2', status: MATCH_STATUS.ACTIVE });
  const blocked = await call(repo, 'startSchoolLiveScore', { matchId: activeId });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /已生效|已作废/);
});

test('撤销：撤最后一球并回退进度；无球可撤被拒', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });

  const none = await call(repo, 'undoSchoolRally', { matchId });
  assert.equal(none.ok, false);
  assert.match(none.message, /没有可撤销/);

  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });
  const undo = await call(repo, 'undoSchoolRally', { matchId });
  assert.equal(undo.ok, true, undo.message);
  assert.equal(undo.live.pointsA, 0);
});

test('整场打完后不能再判球', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  await rallies(repo, matchId, 'A', 11, 'g1');
  await rallies(repo, matchId, 'A', 11, 'g2');

  const afterEnd = await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'z' });
  assert.equal(afterEnd.ok, false);
  assert.match(afterEnd.message, /已经结束/);
});

test('定稿：未打完不能定稿；打完写回待确认的比赛记录', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  await rallies(repo, matchId, 'A', 11, 'g1');

  const early = await call(repo, 'finishSchoolLiveScore', { matchId });
  assert.equal(early.ok, false);
  assert.match(early.message, /还没打完/);

  await rallies(repo, matchId, 'A', 11, 'g2');
  const done = await call(repo, 'finishSchoolLiveScore', { matchId });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.live.finalizedAt != null, true, '定稿盖章');
  assert.equal(done.match.scoreA.join(','), '11,11', '只交打完的局');
  assert.equal(done.match.scoreB.join(','), '0,0');
  assert.equal(done.match.winner, 'A', '胜负由比分推出');
  assert.equal(done.match.status, MATCH_STATUS.PENDING, '定稿后仍待确认');

  const redo = await call(repo, 'finishSchoolLiveScore', { matchId });
  assert.equal(redo.ok, false);
  assert.match(redo.message, /定稿/);

  const undo = await call(repo, 'undoSchoolRally', { matchId });
  assert.equal(undo.ok, false);
  assert.match(undo.message, /定稿/);
});

test('批量读：只读本范围，跨校读不到', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });

  const mine = await call(repo, 'getSchoolLiveScores', { matchIds: [matchId] });
  assert.equal(mine.ok, true);
  assert.equal(mine.scores.length, 1);
  assert.equal(mine.scores[0].pointsA, 1);

  const buaa = await call(repo, 'getSchoolLiveScores', { matchIds: [matchId] },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.scores.length, 0);
});

test('跨校：外校开台被判找不到', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  const buaa = await call(repo, 'startSchoolLiveScore', { matchId },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.ok, false);
  assert.match(buaa.message, /找不到/);
});

test('比赛读端带实时比分：开台后首屏即实时值，跨校读不到', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);

  const idle = await callMatch(repo, 'listSchoolMatches', {});
  assert.equal(idle.matches[0].live, undefined, '没开台就不带 live');

  await call(repo, 'startSchoolLiveScore', { matchId });
  await call(repo, 'recordSchoolRally', { matchId, side: 'A', rallyId: 'r1' });

  const list = await callMatch(repo, 'listSchoolMatches', {});
  assert.equal(list.matches[0].live.pointsA, 1, '开台后读端即实时值，不会先 0:0 再跳');

  const one = await callMatch(repo, 'getSchoolMatch', { matchId });
  assert.equal(one.match.live.pointsA, 1);

  const buaa = await callMatch(repo, 'listSchoolMatches', {},
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.matches.length, 0, '跨校读不到');
});

test('实时态带范围：schoolId + association，主键含范围', async () => {
  const repo = fixture();
  const matchId = await seedMatch(repo);
  await call(repo, 'startSchoolLiveScore', { matchId });
  const stored = await repo.liveScores.getById(schoolLiveKey(matchId, { schoolId: 'muc', association: 'pkb' }));
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
  assert.equal(stored.matchId, matchId);
});
