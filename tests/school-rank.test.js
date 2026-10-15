/**
 * 学校维度：计分 / 赛季 / 排行榜（迁移清单 M4）
 *
 * 守的是：等级分由本范围流水重放而来（同一把尺子），榜单按项目分池，
 * 只有出场过的人上榜，跨校 / 跨协会彼此隔离；赛季权限与旧栈同门槛，
 * 赛季文档按范围各持一份。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-rank-service');
const { schoolMemberKey, scopeKey } = require('../miniprogram/utils/school');
const { MATCH_TYPE, MATCH_STATUS, MATCH_OUTCOME } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({
    _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true,
  });
  // 种子里 demo_muc_member 没有性别，补一条带性别的覆盖（同编号后者胜出）。
  seed.users.push({
    _id: 'demo_muc_member', openId: 'mock_openid_muc_member', nickName: '民大会员', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
  });
  const add = (id, gender) => {
    seed.users.push({
      _id: id, openId: `mock_openid_${id}`, nickName: id, gender,
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true,
    });
    seed.schoolMembers.push({
      _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: id, status: 'active', simulated: true,
    });
  };
  add('rank_m2', 'M');
  add('rank_m3', 'M');
  add('rank_m4', 'M');
  add('rank_f1', 'F');
  add('rank_f2', 'F');
  // 北航演示会员也没有性别，补上，便于测跨校隔离时的男女分榜。
  seed.users.push({
    _id: 'demo_buaa_member', openId: 'mock_openid_buaa_member', nickName: '北航会员', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'buaa', simulated: true,
  });
  seed.users.push({
    _id: 'demo_buaa_admin', openId: 'mock_openid_buaa_admin', nickName: '北航管理员', gender: 'M',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'buaa', simulated: true,
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_member', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

/** 直接种一场已生效的比赛（不进状态机，只喂回放）。 */
async function seedMatch(repo, id, {
  a, b, winner, matchType = MATCH_TYPE.SINGLES, time = at(-HOUR),
  schoolId = 'muc', association = 'pkb', ...extra
}) {
  await repo.matches.set(id, {
    _id: id, schoolId, association, matchType, pool: 1,
    teamA: a, teamB: b, scoreA: [11], scoreB: [winner === 'A' ? 5 : 11],
    winner, gamePoints: 11, bestOf: 1, location: '', matchTime: time,
    recorder: a[0], status: MATCH_STATUS.ACTIVE, revision: 1, ...extra,
  });
}

test('榜单：按范围重放流水，胜者名次在前，行形状与旧栈一致', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.ok, true, board.message);
  assert.equal(board.total, 2);
  assert.equal(board.rows.length, 2);
  assert.equal(board.rows[0].rank, 1);
  assert.equal(board.rows[0].medal, 'gold');
  assert.equal(board.rows[1].rank, 2);
  assert.equal(board.rows[0].detailText, '1 胜 0 负');
  assert.equal(board.rows[0].badge, '定级中', '只打一场标为定级中');
  assert.equal(board.rows[0].noteText, '胜率 100%');
  const top = Number(board.rows[0].valueText);
  const second = Number(board.rows[1].valueText);
  assert.ok(top > second, '胜者的等级分应高于负者');
  assert.equal(board.empty, false);
  assert.equal(board.playerCountText, '2 人上榜');
});

test('榜单：我的那一行被标出，并在 me 卡里给出名次', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.rows[0].isMe, true);
  assert.equal(board.me.rank, 1);
  assert.equal(board.me.total, 2);
  assert.match(board.me.beatText, /超过/);
  assert.equal(board.meHint, '');
});

test('榜单：没出场的人不上榜；我没出场时给一句解释', async () => {
  const repo = fixture();
  // rank_m3 一场没打，不该出现在榜上
  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.total, 0);
  assert.equal(board.empty, true);
  assert.equal(board.emptyNote, '这个项目还没有人打过');
  assert.equal(board.me, null);
  assert.equal(board.meHint, '你还没有参加过这个项目');

  // 女生看男单榜：不在榜上，同样给解释
  const women = await call(repo, 'getSchoolRanking', { project: 'men_singles' }, { actor: 'rank_f1' });
  assert.equal(women.me, null);
  assert.equal(women.rows.some(row => row.userId === 'rank_f1'), false);
});

test('榜单：项目分池——女单只看女生，双打单独成榜', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
  await seedMatch(repo, 'm2', { a: ['rank_f1'], b: ['rank_f2'], winner: 'A' });
  await seedMatch(repo, 'm3', {
    a: ['rank_m3', 'rank_m4'], b: ['demo_muc_member', 'rank_m2'],
    winner: 'A', matchType: MATCH_TYPE.DOUBLES,
  });

  const men = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(men.total, 2, '男单榜只含打过单打的男生');
  assert.equal(men.rows.some(row => row.userId === 'rank_f1'), false, '女生不进男单榜');
  assert.equal(men.rows.some(row => row.userId === 'rank_m3'), false, '只打双打的人不进单打榜');

  const women = await call(repo, 'getSchoolRanking', { project: 'women_singles' });
  assert.equal(women.total, 2, '女单榜只含打过单打的女生');
  assert.equal(women.rows[0].userId, 'rank_f1');

  const doubles = await call(repo, 'getSchoolRanking', { project: 'doubles' });
  assert.equal(doubles.total, 4, '双打是独立的池，四个人都在');
});

test('榜单：待确认与弃权的比赛不计分', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
  // 待确认：擅自种成 PENDING，不该进回放
  await seedMatch(repo, 'm2', {
    a: ['demo_muc_member'], b: ['rank_m3'], winner: 'A', status: MATCH_STATUS.PENDING,
  });
  // 弃权：已生效但不计 ELO
  await seedMatch(repo, 'm3', {
    a: ['demo_muc_member'], b: ['rank_m4'], winner: 'B', outcome: MATCH_OUTCOME.FORFEIT,
  });

  const board = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(board.total, 2, '只有那场正常生效的比赛进了榜');
  assert.deepEqual(board.rows.map(row => row.userId).sort(), ['demo_muc_member', 'rank_m2']);
});

test('权限：外校人读不到本协会榜；平台管理员可跨校读', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  // 北航人读民大的榜：不是民大人，读不到（默认 scope 为 muc）
  const outsider = await call(repo, 'getSchoolRanking', {}, { actor: 'demo_buaa_member' });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.rows.length, 0, '无权限时一行榜都不下发');
  assert.deepEqual(outsider.allRows, []);

  const admin = await call(repo, 'getSchoolRanking', {}, { actor: 'demo_platform_admin' });
  assert.equal(admin.ok, true);
  assert.equal(admin.total, 2);
});

test('隔离：一个学校的流水不影响另一个学校的榜', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });
  // 北航的两位会员，各自打一场
  await seedMatch(repo, 'b1', {
    a: ['demo_buaa_member'], b: ['demo_buaa_admin'], winner: 'A',
    schoolId: 'buaa', association: 'pkb',
  });

  const muc = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.equal(muc.total, 2, '民大榜不掺入北航的流水');
  assert.equal(muc.rows.some(row => row.userId === 'demo_buaa_member'), false);

  const buaa = await call(repo, 'getSchoolRanking', { project: 'men_singles' },
    { actor: 'demo_buaa_member', schoolId: 'buaa' });
  assert.equal(buaa.total, 2, '北航榜只有北航的人');
  assert.equal(buaa.rows.some(row => row.userId === 'demo_muc_member'), false);
});

test('赛季：默认第一赛季；普通会员不能开新赛季', async () => {
  const repo = fixture();
  const initial = await call(repo, 'getSchoolSeason');
  assert.equal(initial.ok, true);
  assert.equal(initial.season.seasonNumber, 1);
  assert.equal(initial.season.resetTime, null);

  const byMember = await call(repo, 'resetSchoolSeason');
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);
});

test('赛季：管理员开新赛季，编号 +1、记下分界点，且按范围隔离', async () => {
  const repo = fixture();
  const opened = await call(repo, 'resetSchoolSeason', {}, { actor: 'demo_muc_admin' });
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.season.seasonNumber, 2);
  assert.ok(opened.season.resetTime, '分界点应被记下');

  const muc = await call(repo, 'getSchoolSeason', {}, { actor: 'demo_muc_admin' });
  assert.equal(muc.season.seasonNumber, 2);

  // 北航的赛季不受影响
  const buaa = await call(repo, 'getSchoolSeason', {}, { actor: 'demo_buaa_admin', schoolId: 'buaa' });
  assert.equal(buaa.season.seasonNumber, 1);
  assert.equal(buaa.season.resetTime, null);

  // 赛季文档按范围成键，键里带学校与协会
  const stored = await repo.seasons.getById(scopeKey({ schoolId: 'muc', association: 'pkb' }));
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
});

test('选手成绩读端：按编号取本范围会员的评级与积分，榜外之人也取得到', async () => {
  const repo = fixture();
  // 只让 demo_muc_member 与 rank_m2 出场；rank_m3 一场没打（榜单里根本看不到他）。
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A' });

  // 省略 userIds：本范围在册会员全部下发，含没出过场的人——不像榜单会截断 / 过滤。
  const all = await call(repo, 'getSchoolMemberStats');
  assert.equal(all.ok, true, all.message);
  assert.ok(all.members.some(row => row.userId === 'rank_m3'), '没出场的人也取得到');

  // 指定编号：只回这几个人，逐人给出两个池子的评级与赛季积分。
  const picked = await call(repo, 'getSchoolMemberStats',
    { userIds: ['demo_muc_member', 'rank_m2', 'rank_m3'] });
  assert.deepEqual(picked.members.map(row => row.userId).sort(),
    ['demo_muc_member', 'rank_m2', 'rank_m3']);

  const winner = picked.members.find(row => row.userId === 'demo_muc_member');
  const loser = picked.members.find(row => row.userId === 'rank_m2');
  assert.equal(winner.nickName, '民大会员');
  assert.equal(winner.ratings.singles.matchCount, 1);
  assert.equal(winner.ratings.singles.wins, 1);
  assert.equal(winner.ratings.singles.losses, 0);
  assert.ok(winner.ratings.singles.elo > loser.ratings.singles.elo, '与榜单同口径：胜者等级分更高');
  assert.equal(typeof winner.points, 'number');

  // 没出场：两个池子出场数都是 0。
  const idle = picked.members.find(row => row.userId === 'rank_m3');
  assert.equal(idle.ratings.singles.matchCount, 0);
  assert.equal(idle.ratings.doubles.matchCount, 0);

  // 夹带外校编号取不到：隔离在取数层完成，不靠调用方自觉。
  const foreign = await call(repo, 'getSchoolMemberStats', { userIds: ['demo_buaa_member'] });
  assert.equal(foreign.members.length, 0, '外校的人取不到');

  // 外校人来读本协会成绩：整份读端被权限挡下。
  const outsider = await call(repo, 'getSchoolMemberStats', {}, { actor: 'demo_buaa_member' });
  assert.equal(outsider.ok, false);
  assert.deepEqual(outsider.members, []);
});

test('赛季：开新赛季改的是积分归属，等级分照旧连续累计', async () => {
  const repo = fixture();
  await seedMatch(repo, 'm1', { a: ['demo_muc_member'], b: ['rank_m2'], winner: 'A', time: at(-HOUR) });
  const before = await call(repo, 'getSchoolRanking', { project: 'men_singles' });

  // 分界点落在比赛之后：那场比赛仍是本赛季的（ELO 不受分界影响）
  await call(repo, 'resetSchoolSeason', { resetTime: at(0) }, { actor: 'demo_muc_admin' });
  const after = await call(repo, 'getSchoolRanking', { project: 'men_singles' });
  assert.deepEqual(
    after.rows.map(row => row.valueText),
    before.rows.map(row => row.valueText),
    '等级分不随赛季重置清零'
  );
});
