/**
 * 学校维度：个人赛事「页面适配层」（school-event-view.js，迁移清单 M1-a 配套）
 *
 * 守的是：协议 2 的 DTO 经这一层翻译回旧构建器的形状后，页面上看到的东西与
 * 协议 1 同一把尺子——
 *   · 单打 / 双打 / 分组赛 / 淘汰赛的签表、积分表、名次都能整形成旧形状；
 *   · 权限旗标来自服务端 DTO，不在视图层用旧角色重算；
 *   · 「我」的高亮按传入的 actorId 落在本人那几行上。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const { schoolMemberKey } = require('../miniprogram/utils/school');
const { MATCH_TYPE, EVENT_FORMAT } = require('../miniprogram/utils/constants');

const eventSvc = require('../miniprogram/services/school-event-service');
const matchSvc = require('../miniprogram/services/school-match-service');
const rankSvc = require('../miniprogram/services/school-rank-service');
const assocSpace = require('../miniprogram/services/association-space');
const view = require('../miniprogram/services/school-event-view');

const SPACE_HANDLERS = { ...eventSvc, ...matchSvc, ...rankSvc };
const SPACE_NAMES = ['publishSchoolEvent', 'signUpSchoolEvent', 'drawSchoolEvent', 'startSchoolEvent',
  'finishSchoolEvent', 'confirmSchoolMatch', 'getSchoolEvent', 'listSchoolEvents',
  'listSchoolEventSignups', 'listSchoolMatches', 'getSchoolMemberStats'];

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const startAt = new Date(NOW.getTime() + DAY).toISOString();

/** 民大 pkb：管理员 + 四名在册男会员（够排单打 4 人与双打 2 队）。 */
function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  seed.users.find(item => item._id === 'demo_muc_admin').gender = 'M';
  seed.users.find(item => item._id === 'demo_muc_member').gender = 'M';
  ['_2', '_3', '_4'].forEach((suffix, index) => {
    const id = `demo_muc_member${suffix}`;
    seed.users.push({ _id: id, openId: `mock_openid${suffix}`, nickName: `会员${index + 2}`,
      gender: 'M', platformStatus: 'active', platformRole: 'member',
      primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId: 'c01', studentId: `TEST00${index + 3}`, status: 'active', simulated: true });
  });
  return createSchoolMemoryRepo(seed);
}

/**
 * 协会空间客户端：与 school-mock.forAssociationSpace 同一套绑法——把 actor 与
 * scope 绑进 ctx，返回各接口的 `.data`（读端失败藏在 data.ok 里，与线上一致）。
 */
function spaceClient(repo, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  return Object.fromEntries(SPACE_NAMES.map(name => [name, async payload => {
    const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
    return (await SPACE_HANDLERS[name](payload || {}, { ...ctx, isMock: true })).data;
  }]));
}

const valid = (extra = {}) => ({
  title: '周末单打赛', description: '协会常规赛', matchType: MATCH_TYPE.SINGLES, level: 3,
  format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
  startTime: startAt, courtCount: 2, ...extra,
});

/** 发布一场，返回 eventId。 */
async function publish(admin, token, extra = {}) {
  const result = await admin.publishSchoolEvent({ requestId: token, ...valid(extra) });
  assert.equal(result.ok, true, result.message);
  return result.event.eventId;
}

/**
 * 把一个空间客户端装到 association-space.forScope 上跑一段——装载器会自己调
 * forScope，这里替掉门面即可（跑完恢复）。与 school-profile-view.test.js 同路数。
 */
async function asSpace(repo, opts, run) {
  const orig = assocSpace.forScope;
  assocSpace.forScope = () => spaceClient(repo, opts);
  try {
    return await run();
  } finally {
    assocSpace.forScope = orig;
  }
}

/** 让一组会员各自报名。 */
async function signUpAll(repo, eventId, actorIds, opts = {}) {
  for (const actor of actorIds) {
    const result = await spaceClient(repo, { ...opts, actor }).signUpSchoolEvent({ eventId });
    assert.equal(result.ok, true, result.message);
  }
}

/* ============================================================
 * 单打
 * ============================================================ */

test('单打详情：抽签后带签表与种子，能力旗标照服务端落位', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.found, true);
  assert.equal(detail.event.isSignup, true, '抽签不改报名状态');
  assert.equal(detail.event.drawn, true);
  // 能力来自服务端 capabilities：报名阶段管理员可重抽、可开赛、不可录名次
  assert.equal(detail.event.canDraw, true);
  assert.equal(detail.event.canStart, true);
  assert.equal(detail.event.canFinish, false);
  assert.equal(detail.event.canPin, true, '置顶入口按 canManage 推');
  assert.match(detail.drawText, /2 个签位/);
  assert.equal(detail.event.signupCount, 2);
  assert.equal(detail.event.quotaText, '2 人');
  assert.deepEqual(detail.resultRows, [], '未结束无名次');

  assert.equal(detail.bracketRows.length, 1, '两人单败只排一场首轮（即决赛）');
  assert.equal(detail.bracketRows[0].roundText, '决赛');
  assert.equal(detail.bracketRows[0].groupText, '');
  assert.equal(detail.seedCandidates.length, 2, '种子候选即有效报名者');
});

test('单打详情：开赛后名单行给代签、签表行按服务端给录分/确认', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const asAdmin = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(asAdmin.event.isOngoing, true);
  assert.equal(asAdmin.event.canStart, false, '已开赛不能再开');
  assert.equal(asAdmin.event.canDraw, false, '已开赛不能再抽');
  assert.equal(asAdmin.event.canFinish, true);
  assert.ok(asAdmin.signupRows.every(row => row.canCheckIn === true), '进行中管理员可代签');
  assert.equal(asAdmin.bracketRows[0].canRecord, true, '待录分的场次，管理员可录分');

  // 换成普通会员看同一页：能力全部收回，代签不给
  const asMember = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  assert.equal(asMember.event.canFinish, false);
  assert.equal(asMember.event.canCheckIn, false);
  assert.ok(asMember.signupRows.every(row => row.canCheckIn === false), '普通会员不能代签');
});

test('单打详情：isMe 只落在本人那几行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  const mine = detail.signupRows.filter(row => row.isMe).map(row => row.userId);
  assert.deepEqual(mine, ['demo_muc_member']);
  assert.equal(detail.event.signedUp, true);
  assert.equal(detail.event.mySignupLabel, '已报名');

  // 访客（无 actorId）不该有任何人被标成「我」
  const guest = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: null }));
  assert.equal(guest.signupRows.some(row => row.isMe), false);
});

/* ============================================================
 * 双打
 * ============================================================ */

test('双打：签表两边显示两人，名次页按队伍成行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1', {
    matchType: MATCH_TYPE.DOUBLES, seedMode: 'elo', seedCount: 2,
  });
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.event.isDoubles, true);
  assert.equal(detail.seedUnit, '位参赛者', '双打点的是参赛者，不是种子组');
  assert.equal(detail.bracketRows.length, 1, '四人为两队，单败一场决赛');
  assert.equal(detail.bracketRows[0].teamAText.includes('、'), true, '一边两人，名字用顿号相连');
  assert.equal(detail.bracketRows[0].teamBText.includes('、'), true);

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.allowed, true);
  assert.equal(placement.rows.length, 2, '一行一支队伍');
  assert.ok(placement.rows.every(row => Array.isArray(row.userIds) && row.userIds.length === 2));
  assert.ok(placement.rows.every(row => row.nickName.includes('、')));
  assert.match(placement.bronzeHint, /两组/, '双打量词跟着换');
});

/* ============================================================
 * 分组赛与淘汰赛
 * ============================================================ */

test('分组赛：积分表按组、签表行带组名、名次提示走推导口径', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1', {
    format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2, advancePerGroup: 2,
  });
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });

  const detail = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(detail.standings.length, 2, '两组各一张积分表');
  assert.ok(detail.standings.every(group => group.rows.length === 2));
  assert.equal(detail.standings[0].groupLabel, 'A 组');
  assert.equal(detail.hasStandings, true);

  const groupRow = detail.bracketRows.find(row => row.groupText);
  assert.ok(groupRow, '小组赛的比赛带组名');
  assert.ok(['A 组', 'B 组'].includes(groupRow.groupText));

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.allowed, true);
  assert.equal(placement.hasRows, true);
  assert.match(placement.hintText, /抽签|打完|自动排名/, '未打完时给出可读的提示');
});

test('淘汰赛：四人单败首轮叫半决赛，确认后补出决赛行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId,
    ['demo_muc_member', 'demo_muc_member_2', 'demo_muc_member_3', 'demo_muc_member_4']);
  const drawn = await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const first = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(first.bracketRows.length, 2, '4 人单败首轮两场');
  assert.ok(first.bracketRows.every(row => row.roundText === '半决赛'));

  // 两场都确认后，签表推进补出决赛
  for (const matchId of drawn.matchIds) {
    const doc = await repo.matches.getById(matchId);
    await repo.matches.set(matchId, { ...doc, scoreA: [11], scoreB: [9], winner: 'A', recorder: 'demo_muc_admin' });
    const confirmed = await admin.confirmSchoolMatch({ matchId });
    assert.equal(confirmed.ok, true, confirmed.message);
  }

  const second = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(second.bracketRows.length, 3, '首轮打完后补出决赛');
  const final = second.bracketRows.find(row => row.roundText === '决赛');
  assert.ok(final, '决赛已排');
  assert.equal(final.scoreText, '', '刚补出的决赛还没有比分');
  assert.equal(final.winnerSide, '');
});

/* ============================================================
 * 列表与失败关闭
 * ============================================================ */

test('列表：本协会赛事按服务端次序下发，跨校 / 跨协会为空', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  await publish(admin, 'r1');
  await publish(admin, 'r2', { title: '第二场赛事' });

  const list = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(list.hasEvents, true);
  assert.equal(list.events.length, 2);
  assert.equal(list.canPublish, true);
  assert.equal(list.eventTotal, 2);
  assert.ok(list.events.every(row => row.canPin === true), '列表行只带置顶能力');
  assert.ok(list.events.every(row => typeof row.title === 'string' && row.title));

  // 北航管理员管的是北航自己的 pkb 空间，那边一场没有 → 列表为空
  const buaaList = await asSpace(repo, { actor: 'demo_buaa_admin', schoolId: 'buaa' }, () =>
    view.loadSchoolEventListView({ schoolId: 'buaa', association: 'pkb', actorId: 'demo_buaa_admin' }));
  assert.equal(buaaList.hasEvents, false);
  assert.equal(buaaList.eventTotal, 0);

  // 民大另一协会（乒乓）也看不到 pkb 的赛事
  const ttList = await asSpace(repo, { actor: 'demo_muc_member', association: 'tt' }, () =>
    view.loadSchoolEventListView({ schoolId: 'muc', association: 'tt', actorId: 'demo_muc_member' }));
  assert.equal(ttList.hasEvents, false, '本校外协会看不到');
});

test('名次页失败关闭：普通会员被挡，管理员放行', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r1');
  await signUpAll(repo, eventId, ['demo_muc_member', 'demo_muc_member_2']);
  await admin.drawSchoolEvent({ eventId, seedValue: 42 });
  await admin.startSchoolEvent({ eventId });

  const blocked = await asSpace(repo, { actor: 'demo_muc_member' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_member' }));
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.rows, [], '没有管理权就一条名单都不下发');
  assert.match(blocked.blockedText, /没有录入名次的权限/);

  const allowed = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.found, true);
  assert.equal(allowed.canEdit, true, '进行中可录名次');
  assert.equal(allowed.rows.length, 2);
});

test('详情：赛事不存在时给出与旧栈同形的空视图', async () => {
  const repo = fixture();
  const missing = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView('x_muc_pkb_missing', { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(missing.found, false);
  assert.equal(missing.event, null);
  assert.deepEqual(missing.bracketRows, []);
  assert.equal(missing.notFoundText, '这场赛事不存在或已被删除');
});

/* ============================================================
 * 纯适配单测
 * ============================================================ */

test('全量列表装载器：连续取完超过 50 场的 S2 分页', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  for (let i = 0; i < 52; i += 1) await publish(admin, `list_${i}`);
  const result = await asSpace(repo, {}, () => view.loadSchoolEventListView({ schoolId: 'muc', association: 'pkb', limit: Infinity }));
  assert.equal(result.events.length, 52);
  assert.equal(new Set(result.events.map(row => row.id)).size, 52);
});

test('纯适配：DTO 形状翻译与权限注入', () => {
  const event = view.toLegacyEvent({ eventId: 'e1', isDoubles: true, drawn: true });
  assert.equal(event._id, 'e1');
  assert.equal(event.pool, 'doubles');
  assert.equal(Boolean(event.draw), true, '列表只有 drawn，补一个真值占位');

  const matches = view.toLegacyMatches([{ matchId: 'm1', eventId: 'e1' }]);
  assert.equal(matches[0]._id, 'm1');

  const signups = view.signupsFromSummary(
    { signupCount: 2, mySignup: { status: 1, signTime: 't' } }, 'me');
  assert.equal(signups.length, 2, '本人一条 + 占位一条凑足计数');
  assert.equal(signups[0].userId, 'me');
  assert.equal(signups[0].status, 1);
  assert.equal(signups[1].userId, undefined, '占位条目不冒充任何人');

  // 本人已取消：不计入有效人数，但本人那一条要留着显示「已取消」
  const canceled = view.signupsFromSummary({ signupCount: 1, mySignup: { status: 0 } }, 'me');
  assert.equal(canceled.length, 2);
  assert.equal(canceled.filter(row => row.status !== 0).length, 1);

  const caps = view.capsForEvent({ canManage: true, capabilities: { canSignUp: false, canDraw: true } });
  assert.deepEqual(caps, { canSignUp: false, canDraw: true, canPin: true });
});

/* ============================================================
 * 路由编号编码兼容（2026-10-16 实测：开发者工具把 query 原样透传）
 * ============================================================ */

test('路由编号兼容：未解码的 query（%3A 形式）也能打开详情，真不存在仍是 notFound', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_enc');
  const encoded = encodeURIComponent(eventId);
  assert.notStrictEqual(encoded, eventId, '前提：S2 编号含需要编码的字符（冒号）');

  // 开发者工具 / 真机：query 原样透传（仍是编码串）
  const viaEncoded = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(encoded, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(viaEncoded.found, true, '未解码的 query 也要查得到');
  assert.equal(viaEncoded.event.id, eventId, '命中的是解码后的真实编号');

  // 测试替身 / 已解码环境：原值照旧
  const viaPlain = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView(eventId, { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(viaPlain.found, true, '已解码环境照旧');
  assert.match(viaEncoded.notFoundText + viaPlain.notFoundText, /^$/);

  // 真正不存在的编号：仍然是「不存在」，不会因为探测而变成别的话术
  const missing = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventDetailView('sev%3Amuc%3Apkb%3Anope', { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(missing.found, false);
  assert.match(missing.notFoundText, /不存在/);
});

test('名次录入页同样兼容未解码的编号', async () => {
  const repo = fixture();
  const admin = spaceClient(repo);
  const eventId = await publish(admin, 'r_enc2');

  const placement = await asSpace(repo, { actor: 'demo_muc_admin' }, () =>
    view.loadSchoolEventPlacementView(encodeURIComponent(eventId),
      { schoolId: 'muc', association: 'pkb', actorId: 'demo_muc_admin' }));
  assert.equal(placement.found, true, '名次页也要认编码过的编号');
});
