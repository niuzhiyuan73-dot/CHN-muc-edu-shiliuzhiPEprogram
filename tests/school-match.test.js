/**
 * 学校维度：比赛记录状态机（迁移清单 M1-b）
 *
 * 守的是：录入 / 确认 / 驳回 / 撤销 / 弃权的权限与流转与旧栈同口径，
 * 且每条记录都钉在 `schoolId + association` 上，跨校读不到、写不进。
 * 签表晋级（advanceEvent）属 M1-a2，本片不测。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-match-service');
const {
  schoolMemberKey, schoolMatchKey, schoolKey, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS,
} = require('../miniprogram/utils/school');
const {
  MATCH_TYPE, MATCH_STATUS, MATCH_OUTCOME,
} = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  const add = (id, gender = 'M') => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member');            // 参赛者甲（也是录入者）
  add('demo_muc_member_2');          // 参赛者乙（对手）
  add('demo_muc_member_3');          // 无关的普通会员
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const casual = (extra = {}) => ({
  matchType: MATCH_TYPE.SINGLES, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
  scoreA: [11], scoreB: [9], gamePoints: 11, bestOf: 1, matchTime: at(-HOUR), ...extra,
});

async function record(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'submitSchoolMatch', { requestId: token, ...casual(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.match;
}

test('录入：参赛者可录，非参赛的普通会员被拒', async () => {
  const repo = fixture();
  const byPlayer = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual() },
    { actor: 'demo_muc_member' });
  assert.equal(byPlayer.ok, true, byPlayer.message);
  assert.equal(byPlayer.match.status, MATCH_STATUS.PENDING);
  assert.equal(byPlayer.match.winner, 'A', '胜负由比分推出');

  const byStranger = await call(repo, 'submitSchoolMatch', { requestId: 'r2', ...casual() },
    { actor: 'demo_muc_member_3' });
  assert.equal(byStranger.ok, false);
  assert.match(byStranger.message, /参赛者/);
});

test('录入：请求编号幂等，改内容重发被拒', async () => {
  const repo = fixture();
  const first = await record(repo, 'r1');
  const again = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual() });
  assert.equal(again.ok, true);
  assert.equal(again.match.matchId, first.matchId);

  const changed = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual({ scoreA: [11], scoreB: [5] }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /已使用/);
});

test('确认：严格口径下只有对手能确认，录入方自己不行', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const byRecorder = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member' });
  assert.equal(byRecorder.ok, false, '录入方不能给自己盖章');

  const byOpponent = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(byOpponent.ok, true, byOpponent.message);
  assert.equal(byOpponent.match.status, MATCH_STATUS.ACTIVE);
});

test('确认：管理员可确认任意一场；无比分不能确认', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const admin = await call(repo, 'confirmSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_admin' });
  assert.equal(admin.ok, true, admin.message);

  // 无比分（抽签生成）的比赛不能确认：直接种一条待确认、无胜方的记录。
  const blankId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', 'r2'), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(blankId, {
    _id: blankId, schoolId: 'muc', association: 'pkb',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
  });
  const noScore = await call(repo, 'confirmSchoolMatch', { matchId: blankId },
    { actor: 'demo_muc_member_2' });
  assert.equal(noScore.ok, false);
  assert.match(noScore.message, /还没有比分/);
});

test('驳回：须填理由，状态落到已撤销（action=reject）', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const noReason = await call(repo, 'rejectSchoolMatch', { matchId: match.matchId },
    { actor: 'demo_muc_member_2' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /理由/);

  const rejected = await call(repo, 'rejectSchoolMatch',
    { matchId: match.matchId, reason: '比分记错了' }, { actor: 'demo_muc_member_2' });
  assert.equal(rejected.ok, true, rejected.message);
  assert.equal(rejected.match.status, MATCH_STATUS.REVOKED);
  assert.equal(rejected.match.action, 'reject');
});

test('撤销：仅管理员、须理由、只对已生效或待确认场次', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');
  await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_2' });

  const byMember = await call(repo, 'revokeSchoolMatch',
    { matchId: match.matchId, reason: 'x' }, { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false, '普通会员不能撤销');

  const noReason = await call(repo, 'revokeSchoolMatch', { matchId: match.matchId });
  assert.equal(noReason.ok, false);

  const revoked = await call(repo, 'revokeSchoolMatch',
    { matchId: match.matchId, reason: '赛果有争议' }, { actor: 'demo_muc_admin' });
  assert.equal(revoked.ok, true, revoked.message);
  assert.equal(revoked.match.status, MATCH_STATUS.REVOKED);
  assert.equal(revoked.match.action, 'revoke');
});

test('弃权：日常约球不能弃；赛事比赛本人可弃，胜方判给对手', async () => {
  const repo = fixture();
  const casualMatch = await record(repo, 'r1');
  const casualForfeit = await call(repo, 'forfeitSchoolMatch', { matchId: casualMatch.matchId },
    { actor: 'demo_muc_member' });
  assert.equal(casualForfeit.ok, false, '日常约球没有晋级，谈不上弃权');

  // 直接种一场带 eventId 的赛事比赛（抽签签表见 M1-a2）。
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', 'evm1'), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb', eventId: 'evt1',
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
  });
  const forfeited = await call(repo, 'forfeitSchoolMatch', { matchId },
    { actor: 'demo_muc_member' });
  assert.equal(forfeited.ok, true, forfeited.message);
  assert.equal(forfeited.match.status, MATCH_STATUS.ACTIVE);
  assert.equal(forfeited.match.outcome, MATCH_OUTCOME.FORFEIT);
  assert.equal(forfeited.match.winner, 'B', '甲弃权则乙获胜');
});

/* ---------- M1-a2 剩余：既有赛程比赛按 matchId 补录 ---------- */

/** 种一条抽签排定的待确认比赛（个人赛签表场次）。 */
async function seedScheduled(repo, id, extra = {}) {
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_admin', id), { schoolId: 'muc', association: 'pkb' });
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: 'muc', association: 'pkb', eventId: 'evt1', round: 1, stage: 'main', slot: 1,
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
    scoreA: [], scoreB: [], winner: '', gamePoints: 11, bestOf: 1, location: '一号场',
    matchTime: at(-HOUR), recorder: 'demo_muc_member', status: MATCH_STATUS.PENDING, revision: 1,
    ...extra,
  });
  return matchId;
}

test('补录：既有赛程比赛按 matchId 补分，就地更新、不另立记录', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1');
  const before = await repo.matches.getById(matchId);

  const filled = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] },
    { actor: 'demo_muc_member' });
  assert.equal(filled.ok, true, filled.message);
  assert.equal(filled.match.matchId, matchId, '就地更新，编号不变');
  assert.equal(filled.match.status, MATCH_STATUS.PENDING);
  assert.equal(filled.match.winner, 'A', '胜负由比分推');
  assert.equal(filled.match.location, '一号场', '场地取自原记录');
  assert.deepEqual(filled.match.teamA, ['demo_muc_member'], '对阵取自原记录');

  // 库里仍只有这一条（补录不改立新记录）
  const all = await repo.forScope({ schoolId: 'muc', association: 'pkb' }).matches.list();
  assert.equal(all.length, 1);
  // 版本递增；比赛时间保持原 ISO 字符串（不写 Date 对象进库）
  const after = await repo.matches.getById(matchId);
  assert.equal(after.revision, 2);
  assert.equal(after.matchTime, before.matchTime);
});

test('补录：非参赛的普通会员被拒；确认生效后不能再补录', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1');

  const stranger = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] },
    { actor: 'demo_muc_member_3' });
  assert.equal(stranger.ok, false);
  assert.match(stranger.message, /参赛者/);

  // 参赛者补分 → 对手确认生效 → 再补录被拒（非「待确认」）
  await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] }, { actor: 'demo_muc_member' });
  await call(repo, 'confirmSchoolMatch', { matchId }, { actor: 'demo_muc_member_2' });
  const again = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [3] },
    { actor: 'demo_muc_member' });
  assert.equal(again.ok, false);
  assert.match(again.message, /待确认/);
});

test('补录：跨校补不进', async () => {
  const repo = fixture();
  const matchId = await seedScheduled(repo, 'sch1');
  const buaa = await call(repo, 'submitSchoolMatch', { matchId, scoreA: [11], scoreB: [7] },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.ok, false);
  assert.match(buaa.message, /找不到/);
});

test('指派裁判：仅管理员；裁判须在册，生效后不能改派', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const byMember = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'demo_muc_member_3' }, { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false, '普通会员不能指派');

  const ghost = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'nobody' }, { actor: 'demo_muc_admin' });
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /找不到/);

  const assigned = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'demo_muc_member_3' }, { actor: 'demo_muc_admin' });
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal(assigned.match.referee, 'demo_muc_member_3');

  // 生效后不能改派：指定裁判后由裁判确认。
  await call(repo, 'confirmSchoolMatch', { matchId: match.matchId }, { actor: 'demo_muc_member_3' });
  const afterActive = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: '' }, { actor: 'demo_muc_admin' });
  assert.equal(afterActive.ok, false);
  assert.match(afterActive.message, /生效/);
});

test('防刷分：一对会员打满上限后不再让录', async () => {
  const repo = fixture();
  for (let i = 0; i < 15; i += 1) {
    const id = `seed_${i}`;
    await repo.matches.set(id, {
      _id: id, schoolId: 'muc', association: 'pkb',
      matchType: MATCH_TYPE.SINGLES, pool: 1, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
      scoreA: [11], scoreB: [9], winner: 'A', gamePoints: 11, bestOf: 1, location: '',
      matchTime: at(-2 * HOUR - i * 60000), recorder: 'demo_muc_member',
      status: MATCH_STATUS.ACTIVE, revision: 1,
    });
  }
  const blocked = await call(repo, 'submitSchoolMatch', { requestId: 'r1', ...casual() });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /上限/);
});

test('跨学校：外校读不到也写不进', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');

  const buaaList = await call(repo, 'listSchoolMatches', {}, {
    schoolId: 'buaa', actor: 'demo_buaa_member',
  });
  assert.equal(buaaList.ok, true);
  assert.equal(buaaList.matches.length, 0);

  const buaaGet = await call(repo, 'getSchoolMatch', { matchId: match.matchId }, {
    schoolId: 'buaa', actor: 'demo_buaa_member',
  });
  assert.equal(buaaGet.ok, false);
  assert.match(buaaGet.message, /找不到/);
});

test('记录带范围：schoolId + association；非在册裁判被拒', async () => {
  const repo = fixture();
  const match = await record(repo, 'r1');
  const stored = await repo.matches.getById(match.matchId);
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');

  // 把会员停用后不能再当裁判。
  const key = schoolMemberKey('demo_muc_member_3', 'muc');
  const member = await repo.schoolMembers.getById(key);
  await repo.schoolMembers.set(key, { ...member, status: 'left' });
  const refused = await call(repo, 'assignSchoolMatchReferee',
    { matchId: match.matchId, refereeId: 'demo_muc_member_3' }, { actor: 'demo_muc_admin' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /在册/);
});

test('在册判定使用 S2 字符串状态常量', () => {
  assert.equal(PLATFORM_STATUS.ACTIVE, 'active');
  assert.equal(SCHOOL_MEMBER_STATUS.ACTIVE, 'active');
});
