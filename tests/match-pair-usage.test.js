/**
 * 交手名额的取数口径（2026-10-22 第二轮审查 P-2）
 * ============================================================
 * 「这一对会员本赛季打了几场」原来是把**全部历史比赛**读回来再过滤，
 * 而 matches 是只增不减的最大集合：练了三年的协会打开一次录分页要翻上百页
 * RPC，真正用得上的只有本赛季那几十条。
 *
 * 现在两条路：
 *   · 计数文档（pairCounts）齐备 ⇒ 直接用它的 count，一次台账都不读；
 *   · 缺文档（历史数据）⇒ 只读本赛季台账兜底（matchTime >= 赛季分界点下推）。
 *
 * 这里同时钉住两件事：**不再无谓读台账**，以及**赛季过滤真的生效**。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-match-service');
const { schoolMemberKey, schoolMatchKey, schoolKey } = require('../miniprogram/utils/school');
const { MATCH_TYPE, MATCH_STATUS } = require('../miniprogram/utils/constants');
const { RATED_PAIR_LIMIT } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();
const SCOPE = { schoolId: 'muc', association: 'pkb' };

function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true });
  };
  ['demo_muc_member', 'demo_muc_member_2'].forEach(add);
  const repo = createSchoolMemoryRepo(seed);

  // 台账读取探针：分别记「整表读」与「按赛季下推」的次数
  const reads = { list: 0, listSince: 0, sinceArg: [] };
  const rawForScope = repo.forScope.bind(repo);
  repo.forScope = (input) => {
    const surface = rawForScope(input);
    const rawList = surface.matches.list;
    const rawSince = surface.matches.listSince;
    surface.matches.list = (...args) => { reads.list += 1; return rawList(...args); };
    surface.matches.listSince = (iso) => {
      reads.listSince += 1;
      reads.sinceArg.push(iso);
      return rawSince(iso);
    };
    return surface;
  };
  return { repo, reads };
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: SCOPE, now });
  return (await handlers[action](payload, ctx)).data;
}

/** 直接往台账塞一条已生效的日常约球（不经过计入名额的提交路径） */
async function seedMatch(repo, { id, matchTime, status = MATCH_STATUS.PENDING,
  teamA = ['demo_muc_member'], teamB = ['demo_muc_member_2'] }) {
  const matchId = schoolMatchKey(schoolKey('m', 'demo_muc_member', id), SCOPE);
  await repo.matches.set(matchId, {
    _id: matchId, schoolId: SCOPE.schoolId, association: SCOPE.association,
    matchType: MATCH_TYPE.SINGLES, pool: 1, teamA, teamB,
    scoreA: [11], scoreB: [9], winner: 'A', gamePoints: 11, bestOf: 1,
    matchTime, recorder: 'demo_muc_member', status, revision: 1,
  });
  return matchId;
}

const casualPayload = (token, extra = {}) => ({
  requestId: token,
  matchType: MATCH_TYPE.SINGLES, teamA: ['demo_muc_member'], teamB: ['demo_muc_member_2'],
  scoreA: [11], scoreB: [9], gamePoints: 11, bestOf: 1, matchTime: at(-DAY), ...extra,
});

test('计数文档齐备时，录分不再读比赛台账', async () => {
  const { repo, reads } = fixture();
  // 第一次录分会写计数文档（懒初始化），此后这一对就有文档了
  const first = await call(repo, 'submitSchoolMatch', casualPayload('p2-first'));
  assert.equal(first.ok, true, first.message);

  reads.list = 0;
  reads.listSince = 0;
  const second = await call(repo, 'submitSchoolMatch',
    casualPayload('p2-second', { matchTime: at(-DAY + 60 * 60 * 1000) }));
  assert.equal(second.ok, true, second.message);
  assert.equal(reads.list, 0, '不该整表读台账');
  assert.equal(reads.listSince, 0, '计数文档齐备时连「本赛季」都不必读');
});

test('计数文档缺失时回落到本赛季台账，且赛季分界点被下推', async () => {
  const { repo, reads } = fixture();
  // 赛季分界点：两天前重置
  const resetTime = at(-2 * DAY);
  const { scopeKey } = require('../miniprogram/utils/school');
  await repo.seasons.set(scopeKey(SCOPE), {
    _id: scopeKey(SCOPE), schoolId: SCOPE.schoolId, association: SCOPE.association,
    anchorTime: at(-10 * DAY), resetTime, seasonNumber: 2, version: 1,
  });

  // 上赛季一场（重置之前）、本赛季一场（重置之后），都没有计数文档
  await seedMatch(repo, { id: 'old', matchTime: at(-5 * DAY) });
  await seedMatch(repo, { id: 'new', matchTime: at(-DAY) });

  reads.list = 0;
  reads.listSince = 0;
  reads.sinceArg.length = 0;
  const result = await call(repo, 'getSchoolMatchEntryContext', {});
  assert.equal(result.ok, true, result.message);
  assert.equal(reads.list, 0, '不该整表读台账');
  assert.equal(reads.listSince, 1, '应当走一次「本赛季」下推查询');
  assert.equal(reads.sinceArg[0], resetTime, '下推的应当是赛季分界点');
  // 只有重置之后那一场算本赛季
  assert.equal(result.pairInfo.counts.demo_muc_member_2, 1,
    '上赛季的场次不该计入本赛季交手次数');
});

test('名额上限仍然生效：打满后提交被拒', async () => {
  const { repo } = fixture();
  for (let i = 0; i < RATED_PAIR_LIMIT; i += 1) {
    const res = await call(repo, 'submitSchoolMatch',
      casualPayload(`cap-${i}`, { matchTime: at(-DAY + i * 60000) }));
    assert.equal(res.ok, true, `第 ${i + 1} 场应录入成功：${res.message}`);
  }
  const blocked = await call(repo, 'submitSchoolMatch',
    casualPayload('cap-over', { matchTime: at(-DAY + RATED_PAIR_LIMIT * 60000) }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /上限|满/);
});
