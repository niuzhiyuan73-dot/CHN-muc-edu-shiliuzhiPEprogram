// Read-only business-code audit. All writes below target in-memory fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixtureRepo, contextFor, MATCHES, NOW } = require('./helpers/cloud-fixture');
const { dispatch } = require('../cloudfunctions/data/src/core/dispatch');
const { resetMemo } = require('../cloudfunctions/data/src/core/derive');
const C = require('../miniprogram/utils/constants');
async function call(repo, action, payload = {}, user = 'openid-u01', assoc = 'pkb') {
  return dispatch(action, payload, await contextFor(repo, user, NOW, assoc));
}
async function staleGlobalUser() {
  const repo = createFixtureRepo();
  await call(repo, 'getMembers', {}, null, 'tt');
  assert.equal((await call(repo, 'approveMember', { applicationId: 'u_pending' }, 'openid-admin')).data.ok, true);
  const stale = (await call(repo, 'getMembers', {}, null, 'tt')).data;
  resetMemo(repo); // also verify invalidation of the persisted snapshot
  const cold = (await call(repo, 'getMembers', {}, null, 'tt')).data;
  assert.equal(stale.some(u => u._id === 'u_pending'), true);
  assert.equal(cold.some(u => u._id === 'u_pending'), true);
  assert.equal((await repo.users.getById('u_pending')).status, C.USER_STATUS.ACTIVE);
}
async function fakeEventBypassesCap() {
  const matches = Array.from({ length: 15 }, (_, i) => ({ ...MATCHES[0], _id: `cap${i}`, matchTime: new Date(2026, 3, 8 + i, 18).toISOString() }));
  const repo = createFixtureRepo({ matches });
  const payload = { matchType: C.MATCH_TYPE.SINGLES, teamA: ['u01'], teamB: ['u02'], scoreA: [11], scoreB: [0], gamePoints: 11, bestOf: 1, matchTime: '2026-05-30T12:00:00' };
  assert.equal((await call(repo, 'submitMatch', payload)).data.ok, false);
  const forged = await call(repo, 'submitMatch', { ...payload, eventId: 'nonexistent-event' });
  assert.equal(forged.data.ok, false);
  assert.equal((await repo.matches.list()).length, 15);
}
async function quotaRace() {
  const event = { _id: 'quota', association: 'pkb', status: C.EVENT_STATUS.SIGNUP, quota: 1, startTime: '2026-06-02', matchType: C.MATCH_TYPE.SINGLES };
  const repo = createFixtureRepo({ events: [event], matches: [] });
  const original = repo.transaction;
  let injected = false;
  repo.transaction = async fn => {
    if (!injected) {
      injected = true;
      assert.equal((await call(repo, 'signUpEvent', { id: 'quota' }, 'openid-u02')).data.ok, true);
    }
    return original(fn);
  };
  assert.equal((await call(repo, 'signUpEvent', { id: 'quota' })).data.ok, false);
  assert.equal((await repo.eventSignups.listByEvent('quota')).length, 1);
}
async function liveFailureLocksScore() {
  const match = { ...MATCHES[0], _id: 'pending_live', status: C.MATCH_STATUS.PENDING, scoreA: [], scoreB: [], winner: null };
  const repo = createFixtureRepo({ matches: [match] });
  assert.equal((await call(repo, 'startLiveScore', { matchId: match._id })).data.ok, true);
  for (let i = 0; i < 11; ++i) await call(repo, 'recordRally', { matchId: match._id, side: 'A', rallyId: `r${i}` });
  const original = repo.transaction;
  repo.transaction = fn => original(async tx => {
    tx.liveScores.update = async () => { throw new Error('injected DB failure after score write'); };
    return fn(tx);
  });
  await assert.rejects(call(repo, 'finishLiveScore', { matchId: match._id }), /injected/);
  repo.transaction = original;
  assert.equal((await repo.matches.getById(match._id)).winner, null);
  assert.ok(!(await repo.liveScores.getById(`ls_${match._id}`)).finalizedAt);
  assert.equal((await call(repo, 'finishLiveScore', { matchId: match._id })).data.ok, true);
  assert.equal((await repo.matches.getById(match._id)).winner, 'A');
  assert.equal((await call(repo, 'finishLiveScore', { matchId: match._id })).data.ok, false);
}
async function homeScopeRace() {
  const { loadSchoolHomeView } = require('../miniprogram/services/school-home-view');
  // 跨协会并发聚合时，每个协会的分页游标必须各走各的：旧栈 home-view 曾把
  // 「A 协会的赛事」拿去问「B 协会的报名记录」（eventId 与 association 配错）。
  // 协议 2 用「每个协会各自建绑定范围客户端」杜绝，这条用例守的就是这个不变量。
  // 注入替身客户端（school-home-view 的 options.client），记录每次请求带着哪个协会。
  const seen = [];
  const client = {
    forScope(scope) {
      return {
        listSchoolAnnouncements: async () => ({ ok: true, announcements: [], hasMore: false }),
        listSchoolEvents: async (payload = {}) => {
          seen.push({ association: scope.association, offset: payload.offset || 0 });
          return {
            ok: true,
            events: [{
              _id: `event-${scope.association}`, status: C.EVENT_STATUS.SIGNUP,
              startTime: '2026-06-02', matchType: C.MATCH_TYPE.SINGLES, isSignup: true,
            }],
            hasMore: false,
          };
        },
        listSchoolMatches: async () => ({ ok: true, total: 0 }),
        getSchoolSeason: async () => ({ ok: true, season: { seasonNumber: 1 } }),
        listSchoolMembers: async () => ({ ok: true, total: 1 }),
      };
    },
  };
  await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u01', client });

  assert.ok(seen.length > 0, '一个协会都没取数，这条用例就失去意义了');
  for (const association of [...new Set(seen.map((row) => row.association))]) {
    const offsets = seen.filter((row) => row.association === association).map((row) => row.offset);
    assert.deepStrictEqual(offsets, [0], `${association} 的赛事分页游标串了：${JSON.stringify(offsets)}`);
  }
}
async function secondEloEditRewritesOpponents() {
  const repo = createFixtureRepo({ matches: [MATCHES[0]] });
  const edit = async (value, time) => {
    const ctx = await contextFor(repo, 'openid-admin', new Date(time), 'pkb');
    assert.equal((await dispatch('setMemberElo', { userId: 'u01', pool: C.RATING_POOL.SINGLES, value }, ctx)).data.ok, true);
  };
  await edit(2000, '2026-04-09T12:00:00');
  const later = { ...MATCHES[3], association: 'pkb' };
  await repo.matches.insert(later);
  const { bumpSeason } = require('../cloudfunctions/data/src/core/season');
  await repo.transaction(tx => bumpSeason(tx, { association: 'pkb' }));
  const before = (await call(repo, 'getMember', { userId: 'u02' })).data.ratings.singles.elo;
  await edit(1800, '2026-04-12T12:00:00');
  const after = (await call(repo, 'getMember', { userId: 'u02' })).data.ratings.singles.elo;
  assert.equal(before, after);
  assert.equal((await repo.users.getById('u01')).currentEloByAssoc.pkb.singles.length, 2);
}
async function disabledPlayerBreaksDataset() {
  const { USERS } = require('./helpers/cloud-fixture');
  const repo = createFixtureRepo({ users: USERS.map(u => u._id === 'u01' ? { ...u, status: C.USER_STATUS.DISABLED } : u) });
  assert.ok((await call(repo, 'getHomeSummary', {}, null)).data);
  const members = (await call(repo, 'getMembers', {}, null)).data;
  assert.equal(members.some(u => u._id === 'u01'), false);
  assert.ok(members.some(u => u._id === 'u02'));
  const { getDataset } = require('../cloudfunctions/data/src/core/derive');
  const ctx = await contextFor(repo, null, NOW, 'pkb');
  const historicalName = (await getDataset(ctx)).nameOf('u01');
  resetMemo(repo);
  assert.equal((await getDataset(ctx)).nameOf('u01'), historicalName);
}
for (const fn of [staleGlobalUser, fakeEventBypassesCap, quotaRace, liveFailureLocksScore, homeScopeRace, secondEloEditRewritesOpponents, disabledPlayerBreaksDataset]) test(fn.name, fn);

test('cancellation releases exactly one quota slot and permits rejoining', async () => {
  const event = { _id: 'quota', association: 'pkb', status: C.EVENT_STATUS.SIGNUP, quota: 1, startTime: '2026-06-02', matchType: C.MATCH_TYPE.SINGLES };
  const repo = createFixtureRepo({ events: [event], matches: [] });
  assert.equal((await call(repo, 'signUpEvent', { id: 'quota' })).data.ok, true);
  assert.equal((await call(repo, 'cancelSignupEvent', { id: 'quota' })).data.ok, true);
  assert.equal((await call(repo, 'cancelSignupEvent', { id: 'quota' })).data.ok, false);
  assert.equal((await repo.events.getById('quota')).signupCount, 0);
  assert.equal((await call(repo, 'signUpEvent', { id: 'quota' })).data.ok, true);
  assert.equal((await repo.events.getById('quota')).signupCount, 1);
  assert.equal((await call(repo, 'signUpEvent', { id: 'quota' }, 'openid-u02')).data.ok, false);
});

test('bound clients survive awaits and do not undo a user association switch', async () => {
  const facade = require('../miniprogram/services/index');
  const scope = require('../miniprogram/services/association-scope');
  facade.setDataSource(C.DATA_SOURCE.CLOUD);
  scope.setAssociation('pkb');
  const associations = [];
  global.wx = { cloud: { callFunction: async ({ data }) => {
    associations.push(data.association);
    return { result: { ok: true, data: [] } };
  } } };
  try {
    await assert.rejects(scope.withAssociation('tt', async api => {
      await api.getMembers();
      scope.setAssociation('bd');
      await scope.withAssociation('pkb', nested => nested.getMembers());
      await api.getMembers();
      throw new Error('callback failure');
    }), /callback failure/);
    assert.deepEqual(associations, ['tt', 'pkb', 'tt']);
    assert.equal(scope.getAssociation(), 'bd');
  } finally {
    delete global.wx;
    facade.setDataSource(C.DATA_SOURCE.MOCK);
    scope.resetAssociation();
  }
});

test('mock adjustment ledger preserves every historical adjustment', () => {
  const store = require('../miniprogram/services/elo-store');
  store.reset();
  try {
    store.setValue('u01', 'singles', 2000, '2026-04-09');
    store.setValue('u01', 'singles', 1800, '2026-04-12');
    assert.deepEqual(store.list().map(item => item.value), [2000, 1800]);
    assert.equal(store.valueOf('u01', 'singles').value, 1800);
  } finally {
    store.reset();
  }
});
