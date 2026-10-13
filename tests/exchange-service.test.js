const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/exchange-service');
const { schoolMemberKey } = require('../miniprogram/utils/school');
const NOW = new Date('2026-10-13T10:00:00Z');
const form = { title: '民大北航交流赛', location: '模拟球场', startTime: '2026-11-01T10:00:00Z',
  participantSchoolIds: ['muc', 'buaa'], quota: 4, schoolQuotas: { muc: 2, buaa: 2 }, requestId: 'test1' };
function fixture() { return createSchoolMemoryRepo(createSchoolDemoSeed()); }
async function call(repo, action, payload = {}, actor = 'demo_muc_admin', schoolId = 'muc', now = NOW) {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association: 'pkb' }, now });
  return (await handlers[action](payload, ctx)).data;
}
async function create(repo, fields = {}) {
  const result = await call(repo, 'createExchangeEvent', { ...form, ...fields });
  assert.equal(result.ok, true, result.message);
  return result.event._id;
}
async function accept(repo, eventId) {
  return call(repo, 'respondExchangeInvitation', { eventId, decision: 'accepted' }, 'demo_buaa_admin', 'buaa');
}
const signup = (repo, eventId, actor = 'demo_muc_member', schoolId = 'muc') => call(repo, 'signUpExchangeEvent', { eventId }, actor, schoolId);
async function readyFour(repo) {
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id, 'demo_muc_member', 'muc');
  await signup(repo, id, 'demo_muc_admin', 'muc');
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  await signup(repo, id, 'demo_buaa_admin', 'buaa');
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, true);
  return id;
}
async function schoolOf(repo, eventId, userId) {
  const rows = await repo.exchangeSignups.listByEvent(eventId);
  return (rows.find(row => row.userId === userId) || {}).representedSchoolId;
}

test('host creates one canonical unrated singles event and guest school accepts', async () => {
  const repo = fixture();
  const id = await create(repo, { ratingPolicy: 'rated', matchType: 'doubles', schoolId: 'buaa' });
  assert.equal((await create(repo)), id);
  assert.equal((await repo.exchangeEvents.list()).length, 1);
  assert.equal((await call(repo, 'createExchangeEvent', { ...form, title: 'changed' })).ok, false);
  const record = await repo.exchangeEvents.getById(id);
  assert.equal(record.schoolId, 'muc');
  assert.equal(record.ratingPolicy, 'unrated');
  assert.equal(record.matchType, 'singles');
  assert.equal((await accept(repo, id)).ok, true);
  assert.equal((await call(repo, 'getExchangeEvents', {}, 'demo_buaa_member', 'buaa')).events[0]._id, id);
});

test('only school managers may create or accept invitations, members cannot see pending guest events', async () => {
  const repo = fixture();
  assert.equal((await call(repo, 'createExchangeEvent', form, 'demo_muc_member')).ok, false);
  const id = await create(repo);
  assert.equal((await call(repo, 'getExchangeEvent', { eventId: id }, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'accepted' }, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'accepted' })).ok, false);
  assert.equal((await call(repo, 'getExchangeEvent', { eventId: id }, 'demo_muc_admin', 'buaa')).ok, false);
});

test('school quota is serialized across simultaneous registrations and cancel releases once', async () => {
  const repo = fixture();
  const id = await create(repo, { quota: 2, schoolQuotas: { muc: 1, buaa: 1 } });
  await accept(repo, id);
  const results = await Promise.all([signup(repo, id), signup(repo, id, 'demo_muc_admin')]);
  assert.equal(results.filter(row => row.ok).length, 1);
  const rows = await repo.exchangeSignups.listByEvent(id);
  const winner = rows[0].userId;
  assert.equal((await signup(repo, id, winner)).ok, true);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 1);
  const canceled = await Promise.all([1, 2].map(() => call(repo, 'cancelExchangeSignup', { eventId: id }, winner)));
  assert.equal(canceled.filter(row => row.ok).length, 1);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 0);
  assert.equal((await signup(repo, id, winner)).ok, true);
});

test('total quota is enforced independently of each school quota', async () => {
  const repo = fixture();
  const id = await create(repo, { quota: 2 });
  await accept(repo, id);
  const results = await Promise.all([signup(repo, id), signup(repo, id, 'demo_muc_admin'), signup(repo, id, 'demo_buaa_member', 'buaa')]);
  assert.equal(results.filter(row => row.ok).length, 2);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 2);
});

test('two-school roster locks once and freezes signup and cancellation', async () => {
  const repo = fixture();
  const id = await create(repo);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
  await accept(repo, id);
  await signup(repo, id);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id }, 'demo_buaa_admin', 'buaa')).ok, false);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, true);
  assert.equal((await signup(repo, id, 'demo_muc_admin')).ok, false);
  assert.equal((await call(repo, 'cancelExchangeSignup', { eventId: id }, 'demo_muc_member')).ok, false);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
});

test('roster and session projections do not expose student IDs or identity references', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.deepEqual(Object.keys(detail.participants[0]).sort(), ['nickName', 'representedSchoolId', 'schoolName', 'userId']);
  assert.equal(detail.event.fingerprint, undefined);
  assert.equal(detail.event.createdBy, undefined);
});

test('declined invitations cannot be changed or used to register', async () => {
  const repo = fixture();
  const id = await create(repo);
  assert.equal((await call(repo, 'respondExchangeInvitation', { eventId: id, decision: 'declined' }, 'demo_buaa_admin', 'buaa')).ok, true);
  assert.equal((await accept(repo, id)).ok, false);
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);
});

test('inactive participant is rejected at enrollment and checked again when roster locks', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  const memberId = schoolMemberKey('demo_buaa_member', 'buaa');
  const member = await repo.schoolMembers.getById(memberId);
  await repo.schoolMembers.set(memberId, { ...member, status: 'disabled' });
  assert.equal((await signup(repo, id, 'demo_buaa_member', 'buaa')).ok, false);
  assert.equal((await call(repo, 'lockExchangeRoster', { eventId: id })).ok, false);
});

test('audit failure rolls back event creation, invitations and enrollment', async () => {
  const repo = fixture();
  const original = repo.transaction;
  repo.transaction = fn => original(async tx => {
    tx.audit.append = async () => { throw new Error('injected'); };
    return fn(tx);
  });
  await assert.rejects(create(repo), /injected/);
  assert.equal((await repo.exchangeEvents.list()).length, 0);
  assert.equal((await repo.exchangeInvitations.list()).length, 0);
  repo.transaction = original;
  const id = await create(repo);
  repo.transaction = fn => original(async tx => { tx.audit.append = async () => { throw new Error('injected'); }; return fn(tx); });
  await assert.rejects(signup(repo, id), /injected/);
  assert.equal((await repo.exchangeEvents.getById(id)).signupCount, 0);
  assert.equal((await repo.exchangeSignups.listByEvent(id)).length, 0);
});

test('invalid dates, quotas and inactive schools are rejected without writes', async () => {
  const repo = fixture();
  for (const change of [ { quota: 1 }, { quota: 2.5 }, { schoolQuotas: { muc: 1, buaa: 1 } },
    { startTime: '2020-01-01' }, { participantSchoolIds: ['muc', 'muc'] }, { requestId: '' } ]) {
    assert.equal((await call(repo, 'createExchangeEvent', { ...form, ...change })).ok, false);
  }
  await repo.schools.set('buaa', { schoolId: 'buaa', status: 'disabled' });
  assert.equal((await call(repo, 'createExchangeEvent', form)).ok, false);
  assert.equal((await repo.exchangeEvents.list()).length, 0);
});

test('registration closes at start time and ignores client supplied user or represented school', async () => {
  const repo = fixture();
  const id = await create(repo);
  const result = await call(repo, 'signUpExchangeEvent', { eventId: id, userId: 'demo_buaa_member', representedSchoolId: 'buaa' }, 'demo_muc_member');
  assert.equal(result.ok, true);
  const row = (await repo.exchangeSignups.listByEvent(id))[0];
  assert.equal(row.userId, 'demo_muc_member');
  assert.equal(row.representedSchoolId, 'muc');
  assert.equal((await call(repo, 'signUpExchangeEvent', { eventId: id }, 'demo_muc_admin', 'muc', new Date(form.startTime))).ok, false);
});

test('exchange writes do not enter old event/match collections or change school ratings', async () => {
  const { createFixtureRepo } = require('./helpers/cloud-fixture');
  const seed = createSchoolDemoSeed();
  const repo = createFixtureRepo({ ...seed });
  const before = JSON.stringify({ matches: await repo.matches.list(), events: await repo.events.list(), ratings: await repo.memberRatings.list() });
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  await call(repo, 'lockExchangeRoster', { eventId: id });
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 1 });
  const [match] = await repo.exchangeMatches.listByEvent(id);
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: match._id, scoreA: 11, scoreB: 4 });
  await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal((await repo.exchangeEvents.getById(id)).status, 'finished');
  assert.equal(JSON.stringify({ matches: await repo.matches.list(), events: await repo.events.list(), ratings: await repo.memberRatings.list() }), before);
});

test('draw is limited to managers of both schools and only after the roster locks', async () => {
  const repo = fixture();
  const id = await create(repo);
  await accept(repo, id);
  await signup(repo, id);
  await signup(repo, id, 'demo_buaa_member', 'buaa');
  assert.equal((await call(repo, 'drawExchangeEvent', { eventId: id })).ok, false, '报名未锁定不能抽签');
  await call(repo, 'lockExchangeRoster', { eventId: id });
  assert.equal((await call(repo, 'drawExchangeEvent', { eventId: id }, 'demo_muc_member')).ok, false, '普通会员不能抽签');
  const drawn = await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 7 }, 'demo_buaa_admin', 'buaa');
  assert.equal(drawn.ok, true, drawn.message);
  const record = await repo.exchangeEvents.getById(id);
  assert.equal(record.status, 'drawn');
  assert.equal(record.draw.size, 2);
  assert.equal((await repo.exchangeMatches.listByEvent(id)).length, 1);
  const detail = await call(repo, 'getExchangeEvent', { eventId: id });
  assert.equal(detail.matches.length, 1);
  assert.equal(detail.matches[0].canScore, true, '主办方管理员可确认任意一场比分');
  assert.equal(detail.canConfirmRanking, false);
});

test('score confirmation by a player advances the bracket and rejects invalid results', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 3 });
  let rows = await repo.exchangeMatches.listByEvent(id);
  assert.equal(rows.filter(row => row.round === 1).length, 2);
  assert.equal(rows.filter(row => row.round === 2).length, 0);
  const first = rows.filter(row => row.round === 1).sort((a, b) => a.slot - b.slot)[0];
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: first._id, scoreA: 5, scoreB: 5 },
    first.playerA, await schoolOf(repo, id, first.playerA))).ok, false, '淘汰赛不能打平');
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: first._id, scoreA: 11, scoreB: 'x' },
    first.playerA, await schoolOf(repo, id, first.playerA))).ok, false, '非法比分被拒绝');
  // 未指定裁判时，比赛双方可确认比分
  const scored = await call(repo, 'submitExchangeScore', { eventId: id, matchId: first._id, scoreA: 11, scoreB: 4 },
    first.playerA, await schoolOf(repo, id, first.playerA));
  assert.equal(scored.ok, true, scored.message);
  rows = await repo.exchangeMatches.listByEvent(id);
  assert.equal(rows.find(row => row._id === first._id).winner, first.playerA);
  const second = rows.filter(row => row.round === 1 && row._id !== first._id)[0];
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: second._id, scoreA: 9, scoreB: 11 },
    second.playerB, await schoolOf(repo, id, second.playerB));
  rows = await repo.exchangeMatches.listByEvent(id);
  const final = rows.find(row => row.round === 2);
  assert.ok(final, '两场半决赛结束后应生成决赛');
  assert.equal(final.status, 'pending');
  // 第三方会员既不是参赛者也不是管理员，不能填写比分
  await repo.users.set('extra', { _id: 'extra', openId: 'mock_openid_extra', nickName: '旁观会员',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
  await repo.schoolMembers.set(schoolMemberKey('extra', 'muc'), { _id: schoolMemberKey('extra', 'muc'),
    userId: 'extra', schoolId: 'muc', collegeId: 'c01', status: 'active' });
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: final._id, scoreA: 11, scoreB: 2 },
    'extra', 'muc')).ok, false);
});

test('an assigned referee blocks players and can confirm the score, and only managers may assign', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 5 });
  const rows = await repo.exchangeMatches.listByEvent(id);
  const match = rows.filter(row => row.round === 1).sort((a, b) => a.slot - b.slot)[0];
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_muc_member' },
    'demo_muc_member')).ok, false, '普通会员不能指定裁判');
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_applicant' })).ok, false,
    '非参赛学校有效会员不能当裁判');
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_muc_member' })).ok, true);
  assert.equal((await repo.exchangeMatches.getById(match._id)).referee, 'demo_muc_member');
  // 已设裁判：比赛双方不能自行确认
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: match._id, scoreA: 11, scoreB: 3 },
    match.playerA, await schoolOf(repo, id, match.playerA))).ok, false);
  // 裁判可以确认
  assert.equal((await call(repo, 'submitExchangeScore', { eventId: id, matchId: match._id, scoreA: 11, scoreB: 3 },
    'demo_muc_member', 'muc')).ok, true);
  // 已生效的比赛不能再改派裁判
  assert.equal((await call(repo, 'assignExchangeReferee', { eventId: id, matchId: match._id, refereeId: 'demo_buaa_member' })).ok, false);
});

test('ranking is derived from confirmed results and confirmed only by managers', async () => {
  const repo = fixture();
  const id = await readyFour(repo);
  await call(repo, 'drawExchangeEvent', { eventId: id, seedValue: 9 });
  let rows = await repo.exchangeMatches.listByEvent(id);
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id })).ok, false, '还有比赛未确认不能定名次');
  for (const row of rows.filter(entry => entry.round === 1)) {
    await call(repo, 'submitExchangeScore', { eventId: id, matchId: row._id, scoreA: 11, scoreB: 6 });
  }
  rows = await repo.exchangeMatches.listByEvent(id);
  const final = rows.find(row => row.round === 2);
  await call(repo, 'submitExchangeScore', { eventId: id, matchId: final._id, scoreA: 11, scoreB: 8 });
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id }, 'demo_muc_member')).ok, false, '普通会员不能确认名次');
  const done = await call(repo, 'confirmExchangeRanking', { eventId: id });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.event.status, 'finished');
  const placements = done.event.results.map(row => row.placement).sort((a, b) => a - b);
  assert.deepEqual(placements, [1, 2, 3, 3]);
  assert.equal(done.event.results.find(row => row.placement === 1).userId, final.playerA);
  assert.equal((await call(repo, 'confirmExchangeRanking', { eventId: id })).ok, false, '不能重复确认');
  // 名次只回传昵称、代表学校与用户标识
  assert.deepEqual(Object.keys(done.event.results[0]).sort(), ['nickName', 'placement', 'representedSchoolId', 'schoolName', 'userId']);
});
