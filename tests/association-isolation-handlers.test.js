/**
 * 数据隔离处理器 —— 每个集合的跨协会隔离、写盖章、两级任免
 * ============================================================
 * P1 只把内核钉死（有效角色、单例按协会、自然键并入协会）。P2 要把这套
 * 内核真正落到每一个 handler 上，于是这一组盯三件事：
 *
 *   1. 读：每一类内容（赛事、报名、公告、比赛、学院赛四件套、实时比分）
 *      都只返回本协会的；带着别家协会的编号直取，一律「查无此物」。
 *   2. 写：新建的文档都盖了 association，同一内容跨协会各留一条，不互相顶掉。
 *   3. 任免分两级：协会负责人能任免本协会学院负责人，但动不了协会负责人；
 *      协会负责人只由全局管理员任免。
 *
 * 这些边界一旦漏掉，后果不是「少显示一条」，而是别家协会能改到本协会的
 * 名单、比分、甚至把负责人换掉。所以每一条都在这里变红。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const { membershipKey } = require('../cloudfunctions/data/src/core/idempotency.js');
const {
  createFixtureRepo,
  contextFor,
  USERS,
  MATCHES,
  EVENTS,
  ANNOUNCEMENTS,
  NOW,
} = require('./helpers/cloud-fixture.js');
const {
  ROLE,
  ASSOC_ROLE,
  USER_STATUS,
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  RATING_POOL,
  ANNOUNCEMENT_STATUS,
  COLLEGE_EVENT_STATUS,
  LEG_DISCIPLINE,
  TIE_STATUS,
} = require('../miniprogram/utils/constants.js');

/* ============================================================
 * 公共小工具
 * ============================================================ */

const SPORTS = '体育学院';

/** 同一份仓储上换个身份 + 换个协会再调一次 */
const on = (repo, action, payload, openId, association) =>
  contextFor(repo, openId, NOW, association).then((ctx) => dispatch(action, payload, ctx));

/** 造一条比赛记录（单打，已生效或待确认） */
function matchDoc(id, association, teamA, teamB, matchTime, status = MATCH_STATUS.ACTIVE) {
  return {
    _id: id,
    association,
    matchType: MATCH_TYPE.SINGLES,
    pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
    teamA,
    teamB,
    scoreA: [11],
    scoreB: [9],
    gamePoints: 11,
    bestOf: 1,
    winner: 'A',
    location: '',
    matchTime,
    recorder: teamA[0],
    eventId: null,
    status,
  };
}

/** 一份合法的赛事表单 */
const EVENT_DRAFT = {
  title: '秋季单打赛',
  description: '面向全体会员的单打赛事',
  matchType: MATCH_TYPE.SINGLES,
  level: EVENT_LEVEL.SECOND,
  bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
  seedMode: SEED_MODE.ELO,
  seedCount: 8,
  startTime: '2026-06-10T09:00:00',
  location: '学校体育馆',
  quota: 8,
  courtCount: 4,
};

/** 一份合法的学院赛表单：两个单打小项 */
const COLLEGE_DRAFT = {
  title: '学院团体赛',
  description: '以学院为单位报名',
  legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS],
  rosterMin: 1,
  rosterMax: 10,
  startTime: '2026-06-10T09:00:00',
  location: '学校体育馆',
  courtCount: 4,
};

/** 一份合法的比赛录入单 */
const MATCH_FORM = {
  matchType: MATCH_TYPE.SINGLES,
  teamA: ['u01'],
  teamB: ['u02'],
  scoreA: [11],
  scoreB: [9],
  gamePoints: 11,
  bestOf: 1,
  matchTime: '2026-05-01T18:00:00',
  recorder: 'u01',
};

/* ============================================================
 * 一、赛事
 * ============================================================ */

test('赛事 —— 列表只含本协会；带别家协会编号直取一律查无此物', async () => {
  const ttEvent = {
    _id: 'ev_tt',
    association: 'tt',
    title: 'tt联赛',
    matchType: MATCH_TYPE.SINGLES,
    pool: RATING_POOL.SINGLES,
    location: '',
    startTime: '2026-04-16T09:00:00',
    status: EVENT_STATUS.SIGNUP,
    results: [],
  };
  const repo = createFixtureRepo({ events: [...EVENTS, ttEvent] });

  const pkb = await on(repo, 'getEvents', {}, 'openid-u01', 'pkb');
  assert.deepEqual(pkb.data.map((e) => e._id), ['ev1'], 'pkb 只看到自己的赛事');

  const tt = await on(repo, 'getEvents', {}, 'openid-u01', 'tt');
  assert.deepEqual(tt.data.map((e) => e._id), ['ev_tt'], 'tt 只看到自己的赛事');

  // 三个按编号直取的写接口（开赛 / 置顶 / 报名）都要挡住别家协会的编号
  const start = await on(repo, 'startEvent', { id: 'ev_tt' }, 'openid-admin', 'pkb');
  assert.equal(start.data.ok, false);
  assert.match(start.data.message, /找不到这场赛事/);

  const pin = await on(repo, 'setEventPinned', { id: 'ev_tt', pinned: true }, 'openid-admin', 'pkb');
  assert.equal(pin.data.ok, false);
  assert.match(pin.data.message, /找不到这场赛事/);

  const sign = await on(repo, 'signUpEvent', { id: 'ev_tt' }, 'openid-u01', 'pkb');
  assert.equal(sign.data.ok, false);
  assert.match(sign.data.message, /找不到这场赛事/);
});

test('赛事 —— 报名名单按协会过滤，借编号也读不到对方的人', async () => {
  const repo = createFixtureRepo({
    events: [
      ...EVENTS,
      {
        _id: 'ev_tt',
        association: 'tt',
        title: 'tt联赛',
        matchType: MATCH_TYPE.SINGLES,
        pool: RATING_POOL.SINGLES,
        location: '',
        startTime: '2026-04-16T09:00:00',
        status: EVENT_STATUS.SIGNUP,
        results: [],
      },
    ],
    eventSignups: [
      { _id: 'sg_pkb', eventId: 'ev1', userId: 'u01', status: 1, association: 'pkb' },
      { _id: 'sg_tt', eventId: 'ev_tt', userId: 'u02', status: 1, association: 'tt' },
    ],
  });

  const pkb = await on(repo, 'getEventSignups', {}, 'openid-u01', 'pkb');
  assert.deepEqual(pkb.data.map((s) => s._id), ['sg_pkb']);

  const tt = await on(repo, 'getEventSignups', {}, 'openid-u01', 'tt');
  assert.deepEqual(tt.data.map((s) => s._id), ['sg_tt']);

  // 即便点名要别家协会赛事的报名，也一条都拿不到
  const peek = await on(repo, 'getEventSignups', { eventId: 'ev_tt' }, 'openid-u01', 'pkb');
  assert.deepEqual(peek.data, []);
});

test('赛事 —— 发布盖章协会，同一表单跨协会各留一条', async () => {
  const repo = createFixtureRepo();

  const pkb = await on(repo, 'publishEvent', { form: EVENT_DRAFT }, 'openid-admin', 'pkb');
  const tt = await on(repo, 'publishEvent', { form: EVENT_DRAFT }, 'openid-admin', 'tt');

  assert.equal(pkb.data.ok, true, pkb.data.firstError);
  assert.equal(tt.data.ok, true, tt.data.firstError);
  assert.notEqual(pkb.data.record._id, tt.data.record._id, '自然键并入协会，跨协会不碰撞');
  assert.equal(pkb.data.record.association, 'pkb');
  assert.equal(tt.data.record.association, 'tt');

  const pkbList = await on(repo, 'getEvents', {}, 'openid-u01', 'pkb');
  assert.ok(pkbList.data.some((e) => e._id === pkb.data.record._id));
  assert.ok(!pkbList.data.some((e) => e._id === tt.data.record._id), 'tt 那场不进 pkb 列表');
});

/* ============================================================
 * 二、公告
 * ============================================================ */

test('公告 —— 列表只含本协会；发布盖章协会', async () => {
  const repo = createFixtureRepo({
    announcements: [
      ...ANNOUNCEMENTS,
      {
        _id: 'a_tt',
        association: 'tt',
        title: 'tt公告',
        content: 'tt 的通知。',
        category: '通知',
        pinned: false,
        publishTime: '2026-04-21T10:00:00',
        publisherId: 'u_admin',
        publisherName: '管理员',
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
      },
    ],
  });

  const pkb = await on(repo, 'getAnnouncements', {}, 'openid-u01', 'pkb');
  assert.ok(!pkb.data.some((a) => a._id === 'a_tt'), 'pkb 看不到 tt 的公告');

  const tt = await on(repo, 'getAnnouncements', {}, 'openid-u01', 'tt');
  assert.deepEqual(tt.data.map((a) => a._id), ['a_tt']);

  const published = await on(
    repo,
    'publishAnnouncement',
    { form: { title: '周末招新', content: '周六下午在体育馆招新。', category: '通知' } },
    'openid-admin',
    'tt'
  );
  assert.equal(published.data.ok, true, published.data.firstError);
  assert.equal(published.data.record.association, 'tt');
});

/* ============================================================
 * 三、比赛
 * ============================================================ */

test('比赛 —— 流水只含本协会；录入盖章协会且跨协会不碰撞', async () => {
  const repo = createFixtureRepo({
    matches: [...MATCHES, matchDoc('m_tt', 'tt', ['u03'], ['u04'], '2026-04-09T18:00:00')],
  });

  const pkb = await on(repo, 'getMatches', {}, 'openid-u01', 'pkb');
  assert.ok(!pkb.data.some((m) => m._id === 'm_tt'), 'pkb 的流水不含 tt 的比赛');

  const tt = await on(repo, 'getMatches', {}, 'openid-u01', 'tt');
  assert.deepEqual(tt.data.map((m) => m._id), ['m_tt']);

  // 录入：同一份单子在两个协会各录一场，各盖各的章
  const p = await on(repo, 'submitMatch', MATCH_FORM, 'openid-u01', 'pkb');
  const t = await on(repo, 'submitMatch', MATCH_FORM, 'openid-u01', 'tt');
  assert.equal(p.data.ok, true, p.data.firstError);
  assert.equal(t.data.ok, true, t.data.firstError);
  assert.notEqual(p.data.match._id, t.data.match._id);
  assert.equal(p.data.match.association, 'pkb');
  assert.equal(t.data.match.association, 'tt');

  const pkbLedger = await on(repo, 'getMatchRecords', {}, 'openid-u01', 'pkb');
  assert.ok(pkbLedger.data.some((m) => m._id === p.data.match._id));
  assert.ok(!pkbLedger.data.some((m) => m._id === t.data.match._id), 'tt 那场不进 pkb 台账');
});

/* ============================================================
 * 四、学院赛四件套
 * ============================================================ */

/** 一份学院赛体系的跨协会种子：赛事 / 名单 / 大场 / 排阵 各一对 */
function collegeSeed() {
  return {
    collegeEvents: [
      { _id: 'ce_pkb', association: 'pkb', title: 'pkb团体赛', status: COLLEGE_EVENT_STATUS.SIGNUP },
      { _id: 'ce_tt', association: 'tt', title: 'tt团体赛', status: COLLEGE_EVENT_STATUS.SIGNUP },
    ],
    collegeEntries: [
      { _id: 'en_pkb', eventId: 'ce_pkb', college: SPORTS, association: 'pkb' },
      { _id: 'en_tt', eventId: 'ce_tt', college: SPORTS, association: 'tt' },
    ],
    ties: [
      { _id: 'tie_pkb', eventId: 'ce_pkb', round: 1, status: TIE_STATUS.PENDING, association: 'pkb' },
      { _id: 'tie_tt', eventId: 'ce_tt', round: 1, status: TIE_STATUS.PENDING, association: 'tt' },
    ],
    lineups: [
      { _id: 'ln_pkb', eventId: 'ce_pkb', tieId: 'tie_pkb', college: SPORTS, association: 'pkb' },
      { _id: 'ln_tt', eventId: 'ce_tt', tieId: 'tie_tt', college: SPORTS, association: 'tt' },
    ],
  };
}

test('学院赛 —— 四个读接口都只返回本协会的内容', async () => {
  const repo = createFixtureRepo(collegeSeed());

  for (const [action, payload, expect] of [
    ['getCollegeEvents', {}, 'ce_pkb'],
    ['getCollegeEntries', {}, 'en_pkb'],
    ['getCollegeTies', {}, 'tie_pkb'],
    ['getCollegeLineups', {}, 'ln_pkb'],
  ]) {
    const pkb = await on(repo, action, payload, 'openid-u01', 'pkb');
    assert.deepEqual(pkb.data.map((row) => row._id), [expect], `${action} 在 pkb 只返回本协会`);

    const tt = await on(repo, action, payload, 'openid-u01', 'tt');
    assert.equal(tt.data.length, 1);
    assert.notEqual(tt.data[0]._id, expect, `${action} 在 tt 拿到的是 tt 的那条`);
  }

  // 单场：带别家协会编号直取 → null
  const peek = await on(repo, 'getCollegeEvent', { id: 'ce_tt' }, 'openid-u01', 'pkb');
  assert.equal(peek.data, null);
});

test('学院赛 —— 发布盖章协会；带别家协会编号的写接口一律拒绝', async () => {
  const repo = createFixtureRepo(collegeSeed());

  const pkb = await on(repo, 'publishCollegeEvent', { form: COLLEGE_DRAFT }, 'openid-admin', 'pkb');
  const tt = await on(repo, 'publishCollegeEvent', { form: COLLEGE_DRAFT }, 'openid-admin', 'tt');
  assert.equal(pkb.data.ok, true, pkb.data.firstError);
  assert.equal(tt.data.ok, true, tt.data.firstError);
  assert.notEqual(pkb.data.record._id, tt.data.record._id);
  assert.equal(pkb.data.record.association, 'pkb');
  assert.equal(tt.data.record.association, 'tt');

  // 抽签 / 置顶：用 pkb 身份点 tt 的赛事 → 查无此物
  const draw = await on(repo, 'drawCollegeEvent', { eventId: 'ce_tt', seedValue: 1 }, 'openid-admin', 'pkb');
  assert.equal(draw.data.ok, false);
  assert.match(draw.data.message, /找不到这场学院赛/);

  const pin = await on(repo, 'setCollegeEventPinned', { eventId: 'ce_tt', pinned: true }, 'openid-admin', 'pkb');
  assert.equal(pin.data.ok, false);
  assert.match(pin.data.message, /找不到这场学院赛/);

  // 大场级：排阵 / 开赛：用 pkb 身份点 tt 的大场 → 查无此物
  const lineup = await on(repo, 'submitLineup', { tieId: 'tie_tt', college: SPORTS, entries: [] }, 'openid-admin', 'pkb');
  assert.equal(lineup.data.ok, false);
  assert.match(lineup.data.message, /找不到这个大场/);

  const start = await on(repo, 'startTie', { tieId: 'tie_tt' }, 'openid-admin', 'pkb');
  assert.equal(start.data.ok, false);
  assert.match(start.data.message, /找不到这个大场/);
});

test('学院赛 —— 名单盖章协会，重交仍是同一条', async () => {
  const repo = createFixtureRepo(collegeSeed());
  const ttEventId = 'ce_tt';

  const first = await on(
    repo,
    'submitCollegeEntry',
    { eventId: ttEventId, college: SPORTS, memberIds: ['u01'] },
    'openid-admin',
    'tt'
  );
  assert.equal(first.data.ok, true, first.data.message);
  assert.equal(first.data.record.association, 'tt');

  const again = await on(
    repo,
    'submitCollegeEntry',
    { eventId: ttEventId, college: SPORTS, memberIds: ['u01', 'u02'] },
    'openid-admin',
    'tt'
  );
  assert.equal(again.data.record._id, first.data.record._id, '同赛事同学院重交覆盖同一条');

  // 拿 pkb 身份交 tt 的名单：赛事不在本协会，直接被拒
  const cross = await on(
    repo,
    'submitCollegeEntry',
    { eventId: ttEventId, college: SPORTS, memberIds: ['u01'] },
    'openid-admin',
    'pkb'
  );
  assert.equal(cross.data.ok, false);
});

/* ============================================================
 * 五、实时比分
 * ============================================================ */

test('实时比分 —— 开台盖章协会；批量读按协会过滤', async () => {
  const repo = createFixtureRepo({
    matches: [
      ...MATCHES,
      matchDoc('m_pkb_live', 'pkb', ['u01'], ['u02'], '2026-05-02T18:00:00', MATCH_STATUS.PENDING),
      matchDoc('m_tt_live', 'tt', ['u01'], ['u02'], '2026-05-03T18:00:00', MATCH_STATUS.PENDING),
    ],
  });

  const p = await on(repo, 'startLiveScore', { matchId: 'm_pkb_live' }, 'openid-u01', 'pkb');
  const t = await on(repo, 'startLiveScore', { matchId: 'm_tt_live' }, 'openid-u01', 'tt');
  assert.equal(p.data.ok, true, p.data.message);
  assert.equal(t.data.ok, true, t.data.message);
  assert.equal(p.data.live.association, 'pkb');
  assert.equal(t.data.live.association, 'tt');

  const pkbView = await on(repo, 'getLiveScores', { matchIds: ['m_pkb_live', 'm_tt_live'] }, 'openid-u01', 'pkb');
  assert.deepEqual(pkbView.data.map((s) => s.matchId), ['m_pkb_live'], 'pkb 只看到自己的实时态');

  const ttView = await on(repo, 'getLiveScores', { matchIds: ['m_pkb_live', 'm_tt_live'] }, 'openid-u01', 'tt');
  assert.deepEqual(ttView.data.map((s) => s.matchId), ['m_tt_live']);
});

/* ============================================================
 * 六、两级任免
 * ============================================================
 * 安全红线（施工方案 §3.4）：协会负责人能任免本协会学院负责人，但绝不能让
 * 他顺势把自己人提成协会负责人——那等于把「换个协会当家」的闸门交给了他。
 */

/** u01 在 tt 是协会负责人；账号全局角色仍是普通会员 */
function leaderRepo() {
  return createFixtureRepo({
    memberships: [
      { _id: membershipKey('u01', 'tt'), userId: 'u01', association: 'tt', role: ASSOC_ROLE.LEADER },
    ],
  });
}

test('学院负责人任免 —— 协会负责人在本协会可任免，跨协会不行', async () => {
  const repo = leaderRepo();

  // tt 里 u01 是协会负责人（有效角色 ADMIN）→ 可以任免本协会学院负责人
  const promoted = await on(repo, 'setCollegeLeader', { userId: 'u04', makeLeader: true }, 'openid-u01', 'tt');
  assert.equal(promoted.data.ok, true, promoted.data.message);
  assert.equal(promoted.data.account.role, ROLE.STAFF);

  const row = await repo.memberships.get(membershipKey('u04', 'tt'));
  assert.ok(row, '落了一条 memberships 记录');
  assert.equal(row.role, ASSOC_ROLE.STAFF);
  assert.equal(row.association, 'tt');

  // 同一个 u01 换到 pkb 只是普通会员 → 没有任免权
  const denied = await on(repo, 'setCollegeLeader', { userId: 'u04', makeLeader: true }, 'openid-u01', 'pkb');
  assert.equal(denied.data.ok, false);
  assert.match(denied.data.message, /只有管理员可以任免学院负责人/);

  // 撤销：把刚提的人退回普通会员（删掉成员行）
  const revoked = await on(repo, 'setCollegeLeader', { userId: 'u04', makeLeader: false }, 'openid-u01', 'tt');
  assert.equal(revoked.data.ok, true, revoked.data.message);
  assert.equal(await repo.memberships.get(membershipKey('u04', 'tt')), null);
});

test('学院负责人任免 —— 不会把协会负责人顺手降成学院负责人', async () => {
  const repo = leaderRepo();

  // 管理员试图把在 tt 已是「协会负责人」的 u01 设成学院负责人：成员行不动
  const res = await on(repo, 'setCollegeLeader', { userId: 'u01', makeLeader: true }, 'openid-admin', 'tt');
  assert.equal(res.data.ok, true, res.data.message);

  const row = await repo.memberships.get(membershipKey('u01', 'tt'));
  assert.equal(row.role, ASSOC_ROLE.LEADER, '协会负责人不会被降级');
});

test('协会负责人任免 —— 只有全局管理员能做，负责人自己也不行', async () => {
  const repo = leaderRepo();

  // tt 的协会负责人（有效角色 ADMIN，但 isGlobalAdmin=false）不能任免协会负责人
  const byLeader = await on(repo, 'setAssociationLeader', { userId: 'u04', makeLeader: true }, 'openid-u01', 'tt');
  assert.equal(byLeader.data.ok, false);
  assert.match(byLeader.data.message, /只有全局管理员可以任免协会负责人/);

  // 全局管理员可以
  const byAdmin = await on(repo, 'setAssociationLeader', { userId: 'u04', makeLeader: true }, 'openid-admin', 'tt');
  assert.equal(byAdmin.data.ok, true, byAdmin.data.message);
  assert.equal(byAdmin.data.account.role, ROLE.ADMIN, '协会负责人等同管理员');

  const row = await repo.memberships.get(membershipKey('u04', 'tt'));
  assert.equal(row.role, ASSOC_ROLE.LEADER);
  // 只在 tt 生效，pkb 里仍是普通会员（角色按协会各算各的）
  assert.equal(await repo.memberships.get(membershipKey('u04', 'pkb')), null);
});

test('协会负责人任免 —— 不能给自己、不能动管理员、不能动未在册者', async () => {
  const repo = leaderRepo();
  // 再造一位全局管理员，用来验证「管理员之间不能互相改角色」
  await repo.users.set('u_admin2', {
    ...USERS[0],
    _id: 'u_admin2',
    openId: 'openid-admin2',
    nickName: '管理员2',
  });

  const self = await on(repo, 'setAssociationLeader', { userId: 'u_admin', makeLeader: true }, 'openid-admin', 'tt');
  assert.equal(self.data.ok, false);
  assert.match(self.data.message, /不能给自己任免角色/);

  const peerAdmin = await on(repo, 'setAssociationLeader', { userId: 'u_admin2', makeLeader: true }, 'openid-admin', 'tt');
  assert.equal(peerAdmin.data.ok, false);
  assert.match(peerAdmin.data.message, /不能改变管理员的角色/);

  const pending = await on(repo, 'setAssociationLeader', { userId: 'u_pending', makeLeader: true }, 'openid-admin', 'tt');
  assert.equal(pending.data.ok, false);
  assert.match(pending.data.message, /只有在册会员才能设为协会负责人/);
  assert.equal(USERS[5].status, USER_STATUS.PENDING, '前提：待审账号仍未通过');
});

test('有效角色随成员行变化 —— 任免后名单里的角色跟着变', async () => {
  const repo = leaderRepo();

  const before = await on(repo, 'getMembers', {}, 'openid-u01', 'tt');
  const beforeU04 = before.data.find((m) => m._id === 'u04');
  assert.equal(beforeU04.role, ROLE.MEMBER);

  await on(repo, 'setCollegeLeader', { userId: 'u04', makeLeader: true }, 'openid-u01', 'tt');

  const after = await on(repo, 'getMembers', {}, 'openid-u01', 'tt');
  const afterU04 = after.data.find((m) => m._id === 'u04');
  assert.equal(afterU04.role, ROLE.STAFF, '名单里的角色由成员行覆盖');
});

/* ============================================================
 * 七、按协会分身份：入会审核指定的初始分与全局管理员标记
 * ============================================================
 * 入会审核通过时指定的初始分是「某人在某协会里的起评分」，不是账号的全局
 * 属性：在 A 协会指定的分不该漂到 B 协会去。云端的存储形态是
 * users.initialEloByAssoc（按协会一张小表），下发前再由 derive 拍平成本
 * 协会那一个（见 derive.withScopedInitialElo）。
 *
 * 另外，名单与 getCurrentUser 下发的 isGlobalAdmin 要把「全局管理员」与
 * 「有效角色同为 ADMIN 的协会负责人」分开——前端据此决定协会负责人任免
 * 入口显不显示，两者混淆会让人层层自封。
 * ============================================================ */

test('入会审核 —— 指定的初始分写进审核所在协会那一档', async () => {
  const repo = createFixtureRepo();

  const res = await on(repo, 'approveMember', { applicationId: 'u_pending', initialElo: 1400 }, 'openid-admin', 'tt');
  assert.equal(res.data.ok, true, res.data.message);

  const stored = await repo.users.getById('u_pending');
  assert.equal(stored.initialEloByAssoc.tt, 1400);
  assert.equal(stored.initialElo, undefined, '旧的扁平字段被清掉');

  const ttVal = (await on(repo, 'getMembers', {}, 'openid-u01', 'tt')).data.find((m) => m._id === 'u_pending');
  assert.equal(ttVal.initialElo, 1400);
  const pkbVal = (await on(repo, 'getMembers', {}, 'openid-u01', 'pkb')).data.find((m) => m._id === 'u_pending');
  assert.equal(pkbVal.initialElo, undefined, 'pkb 里没指定，不漂过去');
});

/* ============================================================
 * 八、按协会分身份：当前等级分（时间线改分）
 * ============================================================
 * 与初始分不同，当前分不限「是否出过场」——用来同步「在外面打完比赛、对手
 * 不在本程序里」的分数。云端把改分存进 users.currentEloByAssoc（按协会、
 * 按池），下发前由 derive 摊平成一条时间线喂给回放（见
 * derive.collectCurrentEloOverrides）。这一节盯三件事：
 *
 *   1. 写：改分落进写操作所在协会那一档，另一协会不受影响。
 *   2. 权：管理员 / 本协会负责人可改，普通会员不行。
 *   3. 用：改分确实作用于回放——出过场的人该池分数被改成指定值。
 * ============================================================ */

test('当前等级分 —— 管理员改本协会某池：落 currentEloByAssoc 并作用于回放', async () => {
  const repo = createFixtureRepo();

  const pkbBefore = (await on(repo, 'getMembers', {}, 'openid-u01', 'pkb')).data.find(
    (m) => m._id === 'u01'
  );
  const baseElo = pkbBefore.ratings[RATING_POOL.SINGLES].elo;
  assert.notEqual(baseElo, 1700, '前提：改的分与原值不同，否则这条测不出东西');

  const res = await on(
    repo,
    'setMemberElo',
    { userId: 'u01', pool: RATING_POOL.SINGLES, value: 1700 },
    'openid-admin',
    'pkb'
  );
  assert.equal(res.data.ok, true, res.data.message);

  // 落库：按协会、按池存一个 {value, at}
  const stored = await repo.users.getById('u01');
  assert.equal(stored.currentEloByAssoc.pkb[RATING_POOL.SINGLES].value, 1700);
  assert.ok(Number.isFinite(stored.currentEloByAssoc.pkb[RATING_POOL.SINGLES].at));

  // pkb 名单里 u01 的单打分数被改成 1700（改分晚于所有比赛，直接是终值）
  const pkbAfter = (await on(repo, 'getMembers', {}, 'openid-u01', 'pkb')).data.find(
    (m) => m._id === 'u01'
  );
  assert.equal(pkbAfter.ratings[RATING_POOL.SINGLES].elo, 1700);

  // tt 里没有改分，分数照旧按流水算
  const ttU01 = (await on(repo, 'getMembers', {}, 'openid-u01', 'tt')).data.find(
    (m) => m._id === 'u01'
  );
  assert.notEqual(ttU01.ratings[RATING_POOL.SINGLES].elo, 1700, 'tt 不该受 pkb 改分影响');
});

test('当前等级分 —— 协会负责人只在本协会可改，普通会员无权', async () => {
  const repo = createFixtureRepo({
    memberships: [
      { _id: membershipKey('u01', 'tt'), userId: 'u01', association: 'tt', role: ASSOC_ROLE.LEADER },
    ],
  });

  const byLeader = await on(
    repo,
    'setMemberElo',
    { userId: 'u03', pool: RATING_POOL.SINGLES, value: 1500 },
    'openid-u01',
    'tt'
  );
  assert.equal(byLeader.data.ok, true, byLeader.data.message);

  const asMember = await on(
    repo,
    'setMemberElo',
    { userId: 'u03', pool: RATING_POOL.SINGLES, value: 1500 },
    'openid-u01',
    'pkb'
  );
  assert.equal(asMember.data.ok, false);
  assert.match(asMember.data.message, /只有管理员或本协会负责人/);
});

test('当前等级分 —— 查无此人 / 项目非法 / 数值越界都不写入', async () => {
  const repo = createFixtureRepo();

  const ghost = await on(
    repo,
    'setMemberElo',
    { userId: 'ghost', pool: RATING_POOL.SINGLES, value: 1500 },
    'openid-admin',
    'pkb'
  );
  assert.equal(ghost.data.ok, false);
  assert.match(ghost.data.message, /找不到/);

  const badPool = await on(
    repo,
    'setMemberElo',
    { userId: 'u03', pool: 'mixed', value: 1500 },
    'openid-admin',
    'pkb'
  );
  assert.equal(badPool.data.ok, false);
  assert.match(badPool.data.message, /项目/);

  const badValue = await on(
    repo,
    'setMemberElo',
    { userId: 'u03', pool: RATING_POOL.SINGLES, value: 99999 },
    'openid-admin',
    'pkb'
  );
  assert.equal(badValue.data.ok, false);
  assert.match(badValue.data.message, /之间/);

  // 一次都没写进去
  const stored = await repo.users.getById('u03');
  assert.ok(!stored.currentEloByAssoc || !stored.currentEloByAssoc.pkb);
});

test('getCurrentUser —— 下发 isGlobalAdmin：全局管理员为真，协会负责人为假', async () => {
  const repo = leaderRepo(); // u01 在 tt 是协会负责人

  const admin = await on(repo, 'getCurrentUser', {}, 'openid-admin', 'tt');
  assert.equal(admin.data.isGlobalAdmin, true);

  const leader = await on(repo, 'getCurrentUser', {}, 'openid-u01', 'tt');
  assert.equal(leader.data.role, ROLE.ADMIN, '有效角色是管理员');
  assert.equal(leader.data.isGlobalAdmin, false, '但他不是全局管理员');

  const plain = await on(repo, 'getCurrentUser', {}, 'openid-u01', 'pkb');
  assert.equal(plain.data.isGlobalAdmin, false);
});

test('会员名单 —— isGlobalAdmin 区分全局管理员与协会负责人', async () => {
  const repo = leaderRepo();
  const tt = await on(repo, 'getMembers', {}, 'openid-u01', 'tt');
  const rows = new Map(tt.data.map((m) => [m._id, m]));

  assert.equal(rows.get('u_admin').role, ROLE.ADMIN);
  assert.equal(rows.get('u_admin').isGlobalAdmin, true);
  // u01 在 tt 是协会负责人：有效角色 ADMIN，但全局身份不是
  assert.equal(rows.get('u01').role, ROLE.ADMIN);
  assert.equal(rows.get('u01').isGlobalAdmin, false);
  assert.equal(rows.get('u02').isGlobalAdmin, false);
});
