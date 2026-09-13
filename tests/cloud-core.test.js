/**
 * 云函数核心 —— 分发、筛选、排序
 * ============================================================
 * 这一组测试盯两件事：
 *   1. 前端能调的名字，云端必须都有；反之云端不许有多余的路由。
 *      名字对不上是接入阶段最容易犯、也最难在真机上定位的错——
 *      用户点下去只看到「未知的操作」，测试却全绿。
 *   2. 只读接口的筛选与排序口径。云端与 mock 是两套实现，形状却必须
 *      一样，否则切换数据源时页面会以各种方式崩掉。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cloud = require('../miniprogram/services/cloud.js');
const { ALL_ACTIONS } = require('../cloudfunctions/data/src/actions.js');
const { HANDLERS, dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const { createFixtureRepo, contextFor, USERS } = require('./helpers/cloud-fixture.js');
const {
  EVENT_STATUS,
  SIGNUP_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  BRACKET_STAGE,
  SEED_MODE,
  MATCH_TYPE,
  MATCH_STATUS,
  EVENT_FORMAT,
  ROLE,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  TIE_STATUS,
  LEG_DISCIPLINE,
  DOUBLES_DISCIPLINES,
} = require('../miniprogram/utils/constants.js');

/** 用一份全新的夹具调一次接口 */
async function call(action, payload = {}, openId = 'openid-u01') {
  const ctx = await contextFor(createFixtureRepo(), openId);
  return dispatch(action, payload, ctx);
}

/* ---------- 名单对齐 ---------- */

test('前端 cloud.js 的调用名与云端操作名单逐一对应', () => {
  // request 是发起请求的工具函数，CLOUD_FUNCTION 是字符串，都不是 action
  const called = Object.keys(cloud)
    .filter((name) => typeof cloud[name] === 'function' && name !== 'request')
    .sort();

  assert.deepEqual(
    called,
    [...ALL_ACTIONS].sort(),
    '前端导出的调用名与 actions.js 的名单不一致：加了接口要同步加进名单'
  );
});

test('每个 action 都有处理器，且没有计划外的路由', () => {
  assert.deepEqual(
    Object.keys(HANDLERS).sort(),
    [...ALL_ACTIONS].sort(),
    'dispatch 的路由表必须与 actions.js 一字不差'
  );
});

test('未知的 action —— 顶层 ok:false，属于基础设施故障', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
  const res = await dispatch('不存在的操作', {}, ctx);

  assert.equal(res.ok, false);
  assert.match(res.message, /未知的操作/);
});

/* ---------- 会员 ---------- */

test('getMembers —— 只给审核通过的会员，申请中的不算', async () => {
  const res = await call('getMembers');

  assert.equal(res.ok, true);
  assert.deepEqual(
    res.data.map((m) => m._id).sort(),
    ['u01', 'u02', 'u03', 'u04', 'u_admin']
  );
});

test('getMembers —— 名单里不带 openId 与手机号', async () => {
  const res = await call('getMembers');
  const first = res.data[0];

  assert.equal(first.openId, undefined, 'openId 是账号凭据，不该随公开名单下发');
  assert.equal(first.phone, undefined, '手机号是隐私，公开名单里不该出现');
  assert.ok(first.nickName, '昵称、头像这些页面要用的字段要留着');
});

test('getMemberApplications —— 干部看全部，普通会员只看自己那一条', async () => {
  // 管理员（干部）看到完整的申请台账
  const admin = await call('getMemberApplications', {}, 'openid-admin');
  assert.deepEqual(admin.data.map((m) => m._id), ['u_pending']);

  // 普通会员没有可看的申请，拿到的是空名单——不能顺手拉走别人的实名资料
  const member = await call('getMemberApplications');
  assert.deepEqual(member.data, []);

  // 游客同样拿不到
  const guest = await call('getMemberApplications', {}, null);
  assert.deepEqual(guest.data, []);
});

test('getMember —— 正式会员人人可查，申请只给干部与本人', async () => {
  assert.equal((await call('getMember', { userId: 'u01' })).data._id, 'u01');
  assert.equal(
    (await call('getMember', { userId: 'u_pending' })).data,
    null,
    '普通会员查不到别人的申请（申请里带着学号与手机号）'
  );
  assert.equal(
    (await call('getMember', { userId: 'u_pending' }, 'openid-admin')).data._id,
    'u_pending',
    '干部要审申请，必须查得到'
  );
  assert.equal((await call('getMember', { userId: 'nobody' })).data, null);
});

test('getCurrentUser —— 由 OpenID 决定，而不是前端说了算', async () => {
  const mine = await call('getCurrentUser', {}, 'openid-admin');
  assert.equal(mine.data._id, 'u_admin');
  assert.equal(mine.data.role, 2);

  const guest = await call('getCurrentUser', {}, null);
  assert.equal(guest.data, null);
});

/* ---------- 比赛与台账 ---------- */

test('getMatches —— 只给已生效的比赛，按时间倒序', async () => {
  const res = await call('getMatches');

  assert.deepEqual(res.data.map((m) => m._id), ['m4', 'm3', 'm2', 'm1']);
});

test('getMatches —— 支持 user / pool / event / limit 四种筛选', async () => {
  assert.deepEqual(
    (await call('getMatches', { userId: 'u01' })).data.map((m) => m._id),
    ['m4', 'm3', 'm1']
  );
  assert.deepEqual(
    (await call('getMatches', { pool: 'singles' })).data.map((m) => m._id),
    ['m4', 'm2', 'm1']
  );
  assert.deepEqual((await call('getMatches', { eventId: 'ev1' })).data, []);
  assert.deepEqual(
    (await call('getMatches', { limit: 2 })).data.map((m) => m._id),
    ['m4', 'm3']
  );
});

test('getMatchRecords —— 台账含待确认与已撤销，status 0 不能被当成假值', async () => {
  // 夹具里四场都已生效，没有待确认的
  assert.deepEqual((await call('getMatchRecords', { status: 0 })).data, []);

  const active = await call('getMatchRecords', { status: 1 });
  assert.deepEqual(active.data.map((m) => m._id), ['m4', 'm3', 'm2', 'm1']);
});

/* ---------- 公告 ---------- */

test('getAnnouncements —— 已下架的从公开列表消失，台账里仍留着', async () => {
  const publicList = await call('getAnnouncements');
  assert.deepEqual(publicList.data.map((a) => a._id), ['a2', 'a1']);

  const ledger = await call('getAnnouncementRecords');
  assert.equal(ledger.data.length, 3, '台账要能看到已下架的那条，否则查不到「通知哪去了」');
});

/* ---------- 榜单 ---------- */

test('getLeaderboard —— 男单榜只列男会员，且分数来自同一个单打池', async () => {
  const board = (await call('getLeaderboard', { project: 'men_singles' })).data;
  const ids = board.map((row) => row._id);

  assert.deepEqual([...ids].sort(), ['u01', 'u02', 'u_admin']);
  assert.ok(!ids.includes('u03'), '女会员不该出现在男单榜上');

  // 榜是按等级分降序排的
  for (let i = 1; i < board.length; i += 1) {
    assert.ok(board[i - 1].elo >= board[i].elo, '榜单必须按等级分降序');
  }
});

test('getLeaderboard —— 女单榜与男单榜共用单打池的分数', async () => {
  const men = (await call('getLeaderboard', { project: 'men_singles' })).data;
  const women = (await call('getLeaderboard', { project: 'women_singles' })).data;

  assert.deepEqual(women.map((row) => row._id).sort(), ['u03', 'u04']);
  assert.ok(!men.some((row) => row._id === 'u03'), '两个榜只是过滤条件不同');
});

test('getLeaderboard —— 双打榜不分性别', async () => {
  const board = (await call('getLeaderboard', { project: 'doubles' })).data;
  assert.deepEqual(
    board.map((row) => row._id).sort(),
    ['u01', 'u02', 'u03', 'u04', 'u_admin']
  );
});

test('getMyProjects —— 只列打过球的项目，且不带异性项目', async () => {
  const mine = (await call('getMyProjects', { userId: 'u01' })).data;
  const projects = mine.map((item) => item.project);

  assert.deepEqual(projects, ['men_singles', 'doubles']);
  assert.ok(!projects.includes('women_singles'), '男会员不该看到女单项目');

  const singles = mine.find((item) => item.project === 'men_singles');
  assert.equal(singles.pool, 'singles');
  assert.equal(singles.matchCount, 2);
  assert.equal(singles.delta, singles.elo - singles.startElo);
});

test('getMyProjects —— 没打过球的人没有任何项目', async () => {
  const none = (await call('getMyProjects', { userId: 'u_admin' })).data;
  assert.deepEqual(none, []);
});

test('getHomeSummary —— 会员数只算审核通过的，榜首只算打过球的', async () => {
  const home = (await call('getHomeSummary')).data;

  assert.equal(home.memberCount, 5, '申请中的那位不能被算进会员数');
  assert.equal(home.matchCount, 4);
  assert.equal(home.eventCount, 1);

  assert.equal(home.topByProject.men_singles.playerCount, 2);
  assert.equal(home.topByProject.women_singles.playerCount, 2);
  assert.equal(home.topByProject.doubles.playerCount, 4);
});

/* ---------- 赛事 ---------- */

test('getEvents —— 原样透传', async () => {
  const res = await call('getEvents');
  assert.deepEqual(res.data.map((e) => e._id), ['ev1']);
});

test('getEventRecord —— 只给这位会员参加过的赛事', async () => {
  const mine = (await call('getEventRecord', { userId: 'u01' })).data;
  assert.equal(mine.records.length, 1);
  assert.equal(mine.records[0].placement, 1);
  assert.deepEqual(mine.summary, {
    eventCount: 1,
    championCount: 1,
    topThreeCount: 1,
    bestPlacement: 1,
  });

  const other = (await call('getEventRecord', { userId: 'u03' })).data;
  assert.deepEqual(other.records, []);
});

/* ---------- 未登录 ---------- */

test('未登录调用写接口 —— 顶层 ok:false，且提示先登录', async () => {
  const ctx = await contextFor(createFixtureRepo(), null);
  const res = await dispatch('submitMatch', {}, ctx);

  assert.equal(res.ok, false);
  assert.equal(res.message, '请先登录后再操作');
});

/* ---------- 赛事闭环 ---------- */

describe('云函数 —— 赛事闭环', () => {
  /** 一份合法的赛事表单 */
  const draft = {
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
  };

  /** 在同一份仓储上换个身份再调一次（不必为每一步重建夹具） */
  const on = async (repo, action, payload, openId) =>
    dispatch(action, payload, await contextFor(repo, openId));

  test('发布赛事 —— 落库即报名中，自然键当 _id 保证重试不重复', async () => {
    const repo = createFixtureRepo();

    const first = await on(repo, 'publishEvent', { form: draft }, 'openid-admin');
    assert.equal(first.ok, true);
    assert.equal(first.data.ok, true, first.data.firstError);
    assert.equal(first.data.record.status, EVENT_STATUS.SIGNUP);
    assert.equal(first.data.record.level, EVENT_LEVEL.SECOND);
    assert.deepEqual(first.data.record.results, []);

    // 同一份表单再发一次：自然键相同，不产生第二场
    const again = await on(repo, 'publishEvent', { form: draft }, 'openid-admin');
    assert.equal(again.data.record._id, first.data.record._id);

    const list = await on(repo, 'getEvents', {}, 'openid-u01');
    assert.equal(list.data.filter((e) => e._id === first.data.record._id).length, 1);
  });

  test('发布赛事 —— 等级缺失被拒（留空取默等于悄悄改分）', async () => {
    const repo = createFixtureRepo();
    const res = await on(repo, 'publishEvent', { form: { ...draft, level: undefined } }, 'openid-admin');

    assert.equal(res.data.ok, false);
    assert.ok(res.data.errors.level);
  });

  test('发布赛事 —— 普通会员没有权限', async () => {
    const repo = createFixtureRepo();
    const res = await on(repo, 'publishEvent', { form: draft }, 'openid-u01');

    assert.equal(res.data.ok, false);
    assert.match(res.data.firstError, /权限/);
  });

  test('报名 → 签到 → 录入名次：一条链路走通', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';

    // 单打双打都要先抽签才能开赛，链路按真人路线走：发布 → 报名 → 抽签 → 开赛
    const { data: published } = await on(repo, 'publishEvent', { form: draft }, admin);
    const id = published.record._id;

    // 报名：报名人由 OpenID 决定，不接受前端传的 userId
    const signed = await on(repo, 'signUpEvent', { id }, 'openid-u01');
    assert.equal(signed.data.ok, true, signed.data.message);
    assert.equal(signed.data.record.status, SIGNUP_STATUS.SIGNED);

    const mine = await on(repo, 'getEventSignups', { eventId: id }, 'openid-u01');
    assert.equal(mine.data.length, 1);

    // 再来一位，签表才排得出来
    await on(repo, 'signUpEvent', { id }, 'openid-u02');

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 7 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);

    const started = await on(repo, 'startEvent', { id }, admin);
    assert.equal(started.data.record.status, EVENT_STATUS.ONGOING);

    // 签到：干事代签
    const checked = await on(repo, 'checkInEvent', { id, userId: 'u01' }, admin);
    assert.equal(checked.data.ok, true, checked.data.message);
    assert.equal(checked.data.record.status, SIGNUP_STATUS.CHECKED_IN);

    const finished = await on(
      repo,
      'finishEvent',
      { id, results: [{ userId: 'u01', placement: 1 }] },
      admin
    );
    assert.equal(finished.data.ok, true, finished.data.firstError);
    assert.equal(finished.data.record.status, EVENT_STATUS.FINISHED);
    assert.deepEqual(finished.data.record.results, [{ userId: 'u01', placement: 1 }]);
  });

  test('录入名次 —— 没报名的人拿不到名次', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    // 双打也要先抽签，链路统一按单打走：发布 → 两人报名 → 抽签 → 开赛
    const { data: published } = await on(repo, 'publishEvent', { form: { ...draft, seedCount: 2 } }, admin);
    const id = published.record._id;
    await on(repo, 'signUpEvent', { id }, 'openid-u01');
    await on(repo, 'signUpEvent', { id }, 'openid-u02');
    const drawn = await on(repo, 'drawEvent', { id, seedValue: 7 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);
    await on(repo, 'startEvent', { id }, admin);

    // u03 从没报名，名次给不进去
    const res = await on(repo, 'finishEvent', { id, results: [{ userId: 'u03', placement: 1 }] }, admin);
    assert.equal(res.data.ok, false);
    assert.match(res.data.firstError, /没有报名/);
  });

  test('取消报名 —— 只置状态不删记录，重新报名落回同一条', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', { form: draft }, admin);
    const id = published.record._id;

    await on(repo, 'signUpEvent', { id }, 'openid-u01');
    const canceled = await on(repo, 'cancelSignupEvent', { id }, 'openid-u01');
    assert.equal(canceled.data.ok, true, canceled.data.message);
    assert.equal(canceled.data.record.status, SIGNUP_STATUS.CANCELED);

    // 记录还在，只是状态变了
    const afterCancel = await on(repo, 'getEventSignups', { eventId: id }, 'openid-u01');
    assert.equal(afterCancel.data.length, 1);
    assert.equal(afterCancel.data[0].status, SIGNUP_STATUS.CANCELED);

    // 重新报名翻回同一条，不新增
    const again = await on(repo, 'signUpEvent', { id }, 'openid-u01');
    assert.equal(again.data.ok, true, again.data.message);
    const afterSignUp = await on(repo, 'getEventSignups', { eventId: id }, 'openid-u01');
    assert.equal(afterSignUp.data.length, 1);
    assert.equal(afterSignUp.data[0].status, SIGNUP_STATUS.SIGNED);
  });

  test('签到 —— 赛事还没开始时不能签到', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', { form: draft }, admin);
    const id = published.record._id;
    await on(repo, 'signUpEvent', { id }, 'openid-u01');

    const res = await on(repo, 'checkInEvent', { id, userId: 'u01' }, admin);
    assert.equal(res.data.ok, false);
    assert.match(res.data.message, /不能为会员签到/);
  });

  /** 报名一场赛事（把若干 openid 拉进名单） */
  const signUpAll = async (repo, id, openIds) => {
    for (const openId of openIds) await on(repo, 'signUpEvent', { id }, openId);
  };

  test('抽签 —— 生成首轮比赛，同时写进赛事与比赛读路径', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', { form: { ...draft, seedCount: 2 } }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 12345 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);
    assert.equal(drawn.data.draw.seedValue, 12345);
    assert.equal(drawn.data.draw.size, 4);
    assert.equal(drawn.data.draw.drawCount, 1);
    assert.equal(drawn.data.matches.length, 2, '4 人 4 签，正好两场');

    const events = await on(repo, 'getEvents', {}, 'openid-u01');
    assert.equal(events.data.find((e) => e._id === id).draw.seedValue, 12345);

    // 待确认的比赛还没生效，只在台账里，不在成绩公示 getMatches 里
    const shown = await on(repo, 'getMatches', { eventId: id }, 'openid-u01');
    assert.equal(shown.data.length, 0);

    const ledger = await on(repo, 'getMatchRecords', { eventId: id }, 'openid-u01');
    assert.equal(ledger.data.length, 2);
    for (const match of ledger.data) {
      assert.equal(match.eventId, id);
      assert.equal(match.round, 1);
      assert.equal(match.stage, BRACKET_STAGE.MAIN);
      assert.equal(match.status, MATCH_STATUS.PENDING);
      assert.deepEqual(match.scoreA, []);
      assert.equal(match.teamA.length, 1);
    }
  });

  test('抽签 —— 重抽覆盖同一批比赛，不追加', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', { form: { ...draft, seedCount: 2 } }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);

    const first = await on(repo, 'drawEvent', { id, seedValue: 1 }, admin);
    const second = await on(repo, 'drawEvent', { id, seedValue: 2 }, admin);
    assert.equal(second.data.ok, true, second.data.message);
    assert.equal(second.data.draw.drawCount, 2);
    assert.deepEqual(
      first.data.matches.map((m) => m._id).sort(),
      second.data.matches.map((m) => m._id).sort()
    );

    const ledger = await on(repo, 'getMatchRecords', { eventId: id }, 'openid-u01');
    assert.equal(ledger.data.length, 2, '重抽不该让比赛翻倍');
  });

  test('抽签 —— 已有比赛确认生效后禁止重抽', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', { form: { ...draft, seedCount: 2 } }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 1 }, admin);
    const scheduled = drawn.data.matches[0];
    // 二期还没有「给待确认比赛录比分」的入口（那是三期的活），
    // 这里直接把一场比赛置成已生效，只为验证重抽闸门。
    await repo.matches.update(scheduled._id, {
      status: MATCH_STATUS.ACTIVE,
      winner: 'A',
      scoreA: [11],
      scoreB: [9],
    });

    const again = await on(repo, 'drawEvent', { id, seedValue: 3 }, admin);
    assert.equal(again.data.ok, false);
    assert.match(again.data.message, /不能再重抽/);
  });

  test('抽签 —— 双打可抽、开赛后与普通会员两种拒绝各说清原因', async () => {
    const admin = 'openid-admin';

    // 双打与单打同步：凑够 4 人（两对）就能正常抽签，不再被一刀切拒绝
    const doublesRepo = createFixtureRepo();
    const { data: doubles } = await on(
      doublesRepo,
      'publishEvent',
      { form: { ...draft, matchType: MATCH_TYPE.DOUBLES, seedCount: 2 } },
      admin
    );
    const doublesId = doubles.record._id;
    await signUpAll(doublesRepo, doublesId, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);
    const doublesRes = await on(doublesRepo, 'drawEvent', { id: doublesId, seedValue: 7 }, admin);
    assert.equal(doublesRes.data.ok, true, doublesRes.data.message);

    // 单打要先抽签才开得了赛，于是「开赛后不能再抽」就落在重抽这一步
    const startedRepo = createFixtureRepo();
    const { data: started } = await on(
      startedRepo,
      'publishEvent',
      { form: { ...draft, seedCount: 2 } },
      admin
    );
    const startedId = started.record._id;
    await signUpAll(startedRepo, startedId, ['openid-u02', 'openid-u03']);
    await on(startedRepo, 'drawEvent', { id: startedId, seedValue: 7 }, admin);
    await on(startedRepo, 'startEvent', { id: startedId }, admin);
    const startedRes = await on(startedRepo, 'drawEvent', { id: startedId, seedValue: 8 }, admin);
    assert.equal(startedRes.data.ok, false);
    assert.match(startedRes.data.message, /报名阶段/);

    const memberRepo = createFixtureRepo();
    const { data: member } = await on(memberRepo, 'publishEvent', { form: draft }, admin);
    const memberRes = await on(memberRepo, 'drawEvent', { id: member.record._id }, 'openid-u01');
    assert.equal(memberRes.data.ok, false);
    assert.match(memberRes.data.message, /权限/);
  });

  test('抽签后报名被冻结 —— 新的报名与退赛都拒绝', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', { form: { ...draft, seedCount: 2 } }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u02', 'openid-u03']);

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 7 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);

    const late = await on(repo, 'signUpEvent', { id }, 'openid-u01');
    assert.equal(late.data.ok, false);
    assert.match(late.data.message, /锁定/);

    const quit = await on(repo, 'cancelSignupEvent', { id }, 'openid-u02');
    assert.equal(quit.data.ok, false);
  });

  /** 会员编号 → 该会员的 OpenID */
  const openIdOf = {
    u01: 'openid-u01',
    u02: 'openid-u02',
    u03: 'openid-u03',
    u04: 'openid-u04',
  };

  /** 抽签、报名四位会员、并把首轮两场都打完（A 队胜） */
  const playFirstRound = async (repo, admin, form) => {
    const { data: published } = await on(repo, 'publishEvent', { form }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 5 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);

    const first = drawn.data.matches;
    for (const match of first) {
      // A 队的人录分（记为录入方），B 队的人确认——正是「对手确认」口径
      const scored = await on(
        repo,
        'submitMatch',
        { id: match._id, scoreA: ['11', '11'], scoreB: ['3', '5'] },
        openIdOf[match.teamA[0]]
      );
      assert.equal(scored.data.ok, true, scored.data.firstError);

      const confirmed = await on(repo, 'confirmMatch', { id: match._id }, openIdOf[match.teamB[0]]);
      assert.equal(confirmed.data.ok, true, confirmed.data.message);
    }
    return { id, first };
  };

  test('逐轮推进 —— 首轮打完自动排出决赛与季军赛', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { id, first } = await playFirstRound(repo, admin, {
      ...draft,
      seedCount: 2,
      startTime: '2026-05-20T09:00:00',
    });

    const ledger = await on(repo, 'getMatchRecords', { eventId: id }, admin);
    assert.equal(ledger.data.length, 4, '首轮两场 + 决赛 + 季军赛');

    const final = ledger.data.find((m) => m.round === 2 && m.stage === BRACKET_STAGE.MAIN);
    const bronze = ledger.data.find((m) => m.round === 2 && m.stage === BRACKET_STAGE.BRONZE);
    assert.ok(final, '应排出决赛');
    assert.ok(bronze, '打三四名模式下应排出季军赛');

    // A 队是胜者、B 队是负者，两款对阵都要对上
    assert.deepEqual([final.teamA[0], final.teamB[0]], [first[0].teamA[0], first[1].teamA[0]]);
    assert.deepEqual([bronze.teamA[0], bronze.teamB[0]], [first[0].teamB[0], first[1].teamB[0]]);
    // 新排出的比赛仍是待确认，要重新走录入 → 确认
    assert.equal(final.status, MATCH_STATUS.PENDING);
    assert.deepEqual(final.scoreA, []);
  });

  test('逐轮推进 —— 并列季军模式下不排季军赛', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { id } = await playFirstRound(repo, admin, {
      ...draft,
      seedCount: 2,
      startTime: '2026-05-20T09:00:00',
      bronzeMode: EVENT_BRONZE_MODE.TIED,
    });

    const ledger = await on(repo, 'getMatchRecords', { eventId: id }, admin);
    assert.equal(ledger.data.length, 3, '首轮两场 + 决赛');
    assert.equal(ledger.data.filter((m) => m.stage === BRACKET_STAGE.BRONZE).length, 0);
  });

  test('循环赛 —— 云端逐轮推进：4 人 6 场排完，阶梯名次允许第 4 名', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(
      repo,
      'publishEvent',
      {
        // 比赛时间取自赛事开赛时间，录分时会校验「不能晚于现在」，
        // 所以要用夹具当前时间之前的日子（与 playFirstRound 同一口径）
        form: {
          ...draft,
          format: EVENT_FORMAT.ROUND_ROBIN,
          seedCount: 2,
          startTime: '2026-05-20T09:00:00',
        },
      },
      admin
    );
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 7 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);
    assert.equal(drawn.data.draw.format, EVENT_FORMAT.ROUND_ROBIN, '赛制要落到 draw 上');
    assert.equal(drawn.data.matches.length, 2, '4 人循环赛首轮两场');
    assert.ok(
      drawn.data.matches.every((m) => m.stage === BRACKET_STAGE.GROUP),
      '循环赛的比赛都在 group 阶段'
    );
    assert.equal(drawn.data.matches[0].group, 0, '循环赛只有一组，组号自 0 起');
    await on(repo, 'startEvent', { id }, admin);

    // 逐轮打完：每确认一场，云端 advanceAfterConfirm 就会试着排下一轮
    for (let guard = 0; guard < 12; guard += 1) {
      const ledger = await on(repo, 'getMatchRecords', { eventId: id }, admin);
      const pending = ledger.data.filter(
        (m) => m.status === MATCH_STATUS.PENDING && m.teamA[0] && m.teamB[0]
      );
      if (pending.length === 0) break;
      for (const match of pending) {
        const scored = await on(
          repo,
          'submitMatch',
          { id: match._id, scoreA: ['11', '11'], scoreB: ['3', '5'] },
          openIdOf[match.teamA[0]]
        );
        assert.equal(scored.data.ok, true, scored.data.firstError);
        const confirmed = await on(repo, 'confirmMatch', { id: match._id }, openIdOf[match.teamB[0]]);
        assert.equal(confirmed.data.ok, true, confirmed.data.message);
      }
    }

    const all = await on(repo, 'getMatchRecords', { eventId: id }, admin);
    assert.equal(all.data.length, 6, '4 人循环赛共 3 轮 6 场');
    assert.ok(all.data.every((m) => m.status === MATCH_STATUS.ACTIVE), '全部已生效');

    // 阶梯名次：1..4 都要允许，不能再套三四名成对规则
    const finished = await on(
      repo,
      'finishEvent',
      {
        id,
        results: [
          { userId: 'u01', placement: 1 },
          { userId: 'u02', placement: 2 },
          { userId: 'u03', placement: 3 },
          { userId: 'u04', placement: 4 },
        ],
      },
      admin
    );
    assert.equal(finished.data.ok, true, finished.data.firstError);
    assert.equal(finished.data.record.status, EVENT_STATUS.FINISHED);
    assert.equal(finished.data.record.results.length, 4);
  });

  test('双败淘汰 —— 云端逐轮推进：胜者组→败者组→总决赛，4 人共 6 场', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(
      repo,
      'publishEvent',
      {
        form: {
          ...draft,
          format: EVENT_FORMAT.DOUBLE_ELIM,
          seedCount: 2,
          startTime: '2026-05-20T09:00:00',
        },
      },
      admin
    );
    const id = published.record._id;
    assert.equal(published.record.gfReset, true, '双败默认开启总决赛重赛');
    await signUpAll(repo, id, ['openid-u01', 'openid-u02', 'openid-u03', 'openid-u04']);

    const drawn = await on(repo, 'drawEvent', { id, seedValue: 7 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);
    assert.equal(drawn.data.matches.length, 2, '4 人双败首轮两场');
    assert.ok(
      drawn.data.matches.every((m) => m.stage === BRACKET_STAGE.WINNERS),
      '双败的落败者先在胜者组里打出来'
    );
    await on(repo, 'startEvent', { id }, admin);

    for (let guard = 0; guard < 16; guard += 1) {
      const ledger = await on(repo, 'getMatchRecords', { eventId: id }, admin);
      const pending = ledger.data.filter(
        (m) => m.status === MATCH_STATUS.PENDING && m.teamA[0] && m.teamB[0]
      );
      if (pending.length === 0) break;
      for (const match of pending) {
        const scored = await on(
          repo,
          'submitMatch',
          { id: match._id, scoreA: ['11', '11'], scoreB: ['3', '5'] },
          openIdOf[match.teamA[0]]
        );
        assert.equal(scored.data.ok, true, scored.data.firstError);
        const confirmed = await on(repo, 'confirmMatch', { id: match._id }, openIdOf[match.teamB[0]]);
        assert.equal(confirmed.data.ok, true, confirmed.data.message);
      }
    }

    const all = await on(repo, 'getMatchRecords', { eventId: id }, admin);
    assert.equal(all.data.length, 6, '4 人双败共 2n−2 = 6 场');
    assert.ok(all.data.every((m) => m.status === MATCH_STATUS.ACTIVE), '全部已生效');
    const stages = new Set(all.data.map((m) => m.stage));
    assert.ok(stages.has(BRACKET_STAGE.WINNERS) && stages.has(BRACKET_STAGE.LOSERS));
    assert.ok(stages.has(BRACKET_STAGE.GRAND_FINAL), '总决赛也排出来了');

    const finished = await on(
      repo,
      'finishEvent',
      {
        id,
        results: [
          { userId: 'u01', placement: 1 },
          { userId: 'u02', placement: 2 },
          { userId: 'u03', placement: 3 },
          { userId: 'u04', placement: 4 },
        ],
      },
      admin
    );
    assert.equal(finished.data.ok, true, finished.data.firstError);
    assert.equal(finished.data.record.status, EVENT_STATUS.FINISHED);
    assert.equal(finished.data.record.results.length, 4);
  });

  test('给抽签生成的比赛录分 —— 非参赛者被拒，参赛者可以补录', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', {
      form: { ...draft, seedCount: 2, startTime: '2026-05-20T09:00:00' },
    }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02']);
    const drawn = await on(repo, 'drawEvent', { id, seedValue: 5 }, admin);
    const scheduled = drawn.data.matches[0];

    // u03 没报名，摸不到这场
    const outsider = await on(
      repo,
      'submitMatch',
      { id: scheduled._id, scoreA: ['11'], scoreB: ['5'] },
      'openid-u03'
    );
    assert.equal(outsider.data.ok, false);
    assert.match(outsider.data.firstError, /参赛者/);

    // 参赛者补录后仍是待确认，签位与赛事归属不变
    const scored = await on(
      repo,
      'submitMatch',
      { id: scheduled._id, scoreA: ['11', '11'], scoreB: ['3', '5'] },
      openIdOf[scheduled.teamA[0]]
    );
    assert.equal(scored.data.ok, true, scored.data.firstError);
    assert.equal(scored.data.match.status, MATCH_STATUS.PENDING);
    assert.equal(scored.data.match.round, 1);
    assert.equal(scored.data.match.eventId, id);
  });

  test('确认抽签比赛 —— 没录分前不许确认，回放不会被空胜方带崩', async () => {
    const repo = createFixtureRepo();
    const admin = 'openid-admin';
    const { data: published } = await on(repo, 'publishEvent', {
      form: { ...draft, seedCount: 2, startTime: '2026-05-20T09:00:00' },
    }, admin);
    const id = published.record._id;
    await signUpAll(repo, id, ['openid-u01', 'openid-u02']);
    const drawn = await on(repo, 'drawEvent', { id, seedValue: 5 }, admin);
    const scheduled = drawn.data.matches[0];

    // 参赛者想直接确认一场没比分的比赛：必须被拦下
    const early = await on(repo, 'confirmMatch', { id: scheduled._id }, openIdOf[scheduled.teamB[0]]);
    assert.equal(early.data.ok, false);
    assert.match(early.data.message, /还没有比分/);

    // 录分之后同一人才可以确认，且确认后赛季回放仍算得出来
    await on(
      repo,
      'submitMatch',
      { id: scheduled._id, scoreA: ['11', '11'], scoreB: ['3', '5'] },
      openIdOf[scheduled.teamA[0]]
    );
    const confirmed = await on(repo, 'confirmMatch', { id: scheduled._id }, openIdOf[scheduled.teamB[0]]);
    assert.equal(confirmed.data.ok, true, confirmed.data.message);

    // 读一次赛季数据：若空胜方混进了回放，这里会直接抛错
    const ledger = await on(repo, 'getMatchRecords', { eventId: id }, admin);
    assert.equal(ledger.data[0].status, MATCH_STATUS.ACTIVE);
    assert.equal(ledger.data[0].winner, 'A');
  });

  test('未登录调用发布赛事 —— 顶层 ok:false', async () => {
    const repo = createFixtureRepo();
    const res = await on(repo, 'publishEvent', { form: draft }, null);

    assert.equal(res.ok, false);
    assert.equal(res.message, '请先登录后再操作');
  });
});

describe('云函数 —— 学院赛闭环', () => {
  /**
   * 学院赛要两所学院才测得出跨院权限，夹具默认全在体育学院，这里把
   * u02 提成信息工程学院的干事、u04 划到体育学院，于是两所学院各有
   * 一男一女（一个小项是男单、一个是女单，单性别学院排不出阵）：
   *   体育学院 —— u01（男）、u04（女），管理员兜底名单
   *   信息工程学院 —— u02（男，干事）、u03（女）
   */
  const collegeFixtureRepo = () =>
    createFixtureRepo({
      users: USERS.map((user) => {
        if (user._id === 'u02') return { ...user, role: ROLE.STAFF, college: '信息工程学院' };
        if (user._id === 'u03') return { ...user, college: '信息工程学院' };
        if (user._id === 'u04') return { ...user, college: '体育学院' };
        return user;
      }),
    });

  /** 在同一份仓储上换个身份再调一次 */
  const on = async (repo, action, payload, openId) =>
    dispatch(action, payload, await contextFor(repo, openId));

  const admin = 'openid-admin';
  const COLLEGE_SPORTS = '体育学院';
  const COLLEGE_INFO = '信息工程学院';
  /** 名单按 [男, 女] 排，正好对上 [男单, 女单] 两个小项 */
  const ROSTER_SPORTS = ['u01', 'u04'];
  const ROSTER_INFO = ['u02', 'u03'];

  /** 一份合法的学院赛表单：两个单打小项，每院 1–10 人 */
  const collegeDraft = {
    title: '学院团体赛',
    description: '以学院为单位报名',
    legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS],
    rosterMin: 1,
    rosterMax: 10,
    startTime: '2026-06-10T09:00:00',
    location: '学校体育馆',
  };

  const publishCollege = async (repo, form = {}) => {
    const { data } = await on(
      repo,
      'publishCollegeEvent',
      { form: { ...collegeDraft, ...form } },
      admin
    );
    assert.equal(data.ok, true, data.firstError);
    return data.record._id;
  };

  const submitEntry = async (repo, eventId, openId, college, memberIds) => {
    const res = await on(repo, 'submitCollegeEntry', { eventId, college, memberIds }, openId);
    assert.equal(res.data.ok, true, res.data.message);
    return res.data.record._id;
  };

  const approveEntry = async (repo, entryId) => {
    const res = await on(repo, 'reviewCollegeEntry', { entryId, action: 'approve' }, admin);
    assert.equal(res.data.ok, true, res.data.message);
  };

  /** 两所学院各交一份名单并双双通过审核 */
  const submitBothEntries = async (repo, eventId) => {
    const sports = await submitEntry(repo, eventId, admin, COLLEGE_SPORTS, ROSTER_SPORTS);
    const info = await submitEntry(repo, eventId, 'openid-u02', COLLEGE_INFO, ROSTER_INFO);
    await approveEntry(repo, sports);
    await approveEntry(repo, info);
    return { sports, info };
  };

  /** 抽签 + 赛事级开始，返回首轮大场 */
  const startCollege = async (repo, eventId, seedValue = 42) => {
    const drawn = await on(repo, 'drawCollegeEvent', { eventId, seedValue }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);
    const started = await on(repo, 'startCollegeEvent', { eventId }, admin);
    assert.equal(started.data.ok, true, started.data.message);
    return started.data.ties;
  };

  /** 一个小项需要几个人：双打 2 人，单打 1 人 */
  const legNeed = (discipline) => (DOUBLES_DISCIPLINES.includes(discipline) ? 2 : 1);

  /**
   * 按名单顺序给每个小项派够人（默认允许兼项，人手不够可以重复上）。
   * 逐个小项往后取人——两个单打小项就会分别拿到名单里的男、女队员，
   * 与 [男单, 女单] 的性别要求对上；全都取下标 0 的话女单会排到男队员上。
   */
  const lineupFrom = (tie, roster) => {
    let cursor = 0;
    return tie.legs.map((leg) => {
      const need = legNeed(leg.discipline);
      const players = [];
      for (let i = 0; i < need; i += 1) {
        players.push(roster[cursor] || roster[roster.length - 1]);
        cursor += 1;
      }
      return { legNo: leg.legNo, players };
    });
  };

  test('发布学院赛 —— 仅管理员，落库即报名中', async () => {
    const repo = collegeFixtureRepo();

    const byStaff = await on(repo, 'publishCollegeEvent', { form: collegeDraft }, 'openid-u02');
    assert.equal(byStaff.data.ok, false);
    assert.match(byStaff.data.firstError, /没有发布学院赛的权限/);

    const id = await publishCollege(repo);
    const event = (await on(repo, 'getCollegeEvent', { id }, admin)).data;
    assert.equal(event.status, COLLEGE_EVENT_STATUS.SIGNUP);
    assert.equal(event.format, EVENT_FORMAT.SINGLE_ELIM, '学院赛固定团体单败');
    assert.deepEqual(event.legPlan, [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS]);
  });

  test('提交名单 —— 干事限本学院，重交覆盖同一条', async () => {
    const repo = collegeFixtureRepo();
    const id = await publishCollege(repo);

    // 会员没有提交权；别院干事也不能替体育学院交
    const byMember = await on(
      repo,
      'submitCollegeEntry',
      { eventId: id, college: COLLEGE_SPORTS, memberIds: ROSTER_SPORTS },
      'openid-u01'
    );
    assert.equal(byMember.data.ok, false);
    assert.match(byMember.data.message, /只能提交本学院的名单/);

    const byOtherStaff = await on(
      repo,
      'submitCollegeEntry',
      { eventId: id, college: COLLEGE_SPORTS, memberIds: ROSTER_SPORTS },
      'openid-u02'
    );
    assert.equal(byOtherStaff.data.ok, false);
    assert.match(byOtherStaff.data.message, /只能提交本学院的名单/);

    // 跨院凑人被拦：体育学院的名单里塞了信息工程学院的人
    const cross = await on(
      repo,
      'submitCollegeEntry',
      { eventId: id, college: COLLEGE_SPORTS, memberIds: ['u03'] },
      admin
    );
    assert.equal(cross.data.ok, false);
    assert.match(cross.data.message, /不属于本学院/);

    const first = await submitEntry(repo, id, admin, COLLEGE_SPORTS, ROSTER_SPORTS);
    const again = await submitEntry(repo, id, admin, COLLEGE_SPORTS, ROSTER_SPORTS);
    assert.equal(again, first, '同一赛事同一学院恒为一条（自然键当 _id）');

    const entries = (await on(repo, 'getCollegeEntries', { eventId: id }, admin)).data;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, COLLEGE_ENTRY_STATUS.PENDING);
  });

  test('审核名单 —— 仅管理员，退回必须给理由', async () => {
    const repo = collegeFixtureRepo();
    const id = await publishCollege(repo);
    const entryId = await submitEntry(repo, id, admin, COLLEGE_SPORTS, ROSTER_SPORTS);

    const byStaff = await on(repo, 'reviewCollegeEntry', { entryId, action: 'approve' }, 'openid-u02');
    assert.equal(byStaff.data.ok, false);
    assert.match(byStaff.data.message, /只有管理员/);

    const noReason = await on(repo, 'reviewCollegeEntry', { entryId, action: 'reject' }, admin);
    assert.equal(noReason.data.ok, false);
    assert.match(noReason.data.message, /必须说明理由/);

    const returned = await on(
      repo,
      'reviewCollegeEntry',
      { entryId, action: 'reject', reason: '名单人数不足' },
      admin
    );
    assert.equal(returned.data.ok, true, returned.data.message);
    assert.equal(returned.data.record.status, COLLEGE_ENTRY_STATUS.RETURNED);

    // 处理过的不再受理，避免「退回后又被悄悄通过」
    const twice = await on(repo, 'reviewCollegeEntry', { entryId, action: 'approve' }, admin);
    assert.equal(twice.data.ok, false);
    assert.match(twice.data.message, /已经处理过/);
  });

  test('抽签 —— 只收已通过审核的学院，抽完即锁定名单', async () => {
    const repo = collegeFixtureRepo();
    const id = await publishCollege(repo);
    const sports = await submitEntry(repo, id, admin, COLLEGE_SPORTS, ROSTER_SPORTS);
    const info = await submitEntry(repo, id, 'openid-u02', COLLEGE_INFO, ROSTER_INFO);

    // 两份都还待审核：一所学院都进不了签表
    const none = await on(repo, 'drawCollegeEvent', { eventId: id, seedValue: 42 }, admin);
    assert.equal(none.data.ok, false);
    assert.match(none.data.message, /不足 2 个/);

    await approveEntry(repo, sports);
    const one = await on(repo, 'drawCollegeEvent', { eventId: id, seedValue: 42 }, admin);
    assert.equal(one.data.ok, false, '只有一个通过也抽不了');

    await approveEntry(repo, info);
    const byStaff = await on(repo, 'drawCollegeEvent', { eventId: id, seedValue: 42 }, 'openid-u02');
    assert.equal(byStaff.data.ok, false);
    assert.match(byStaff.data.message, /只有管理员/);

    const drawn = await on(repo, 'drawCollegeEvent', { eventId: id, seedValue: 42 }, admin);
    assert.equal(drawn.data.ok, true, drawn.data.message);
    assert.equal(drawn.data.record.status, COLLEGE_EVENT_STATUS.READY);
    assert.equal(drawn.data.record.draw.size, 2);

    // 抽完名单锁定（D13）：再交名单被拒，再抽也被拒
    const late = await on(
      repo,
      'submitCollegeEntry',
      { eventId: id, college: COLLEGE_SPORTS, memberIds: ROSTER_SPORTS },
      admin
    );
    assert.equal(late.data.ok, false);
    assert.match(late.data.message, /锁定/);

    const again = await on(repo, 'drawCollegeEvent', { eventId: id, seedValue: 99 }, admin);
    assert.equal(again.data.ok, false);
    assert.match(again.data.message, /只能在报名阶段抽签/);
  });

  test('赛事级开始 —— 没抽签不能开，开赛生成首轮大场', async () => {
    const repo = collegeFixtureRepo();
    const id = await publishCollege(repo);
    await submitBothEntries(repo, id);

    const early = await on(repo, 'startCollegeEvent', { eventId: id }, admin);
    assert.equal(early.data.ok, false);
    assert.match(early.data.message, /还没有抽签/);

    await on(repo, 'drawCollegeEvent', { eventId: id, seedValue: 42 }, admin);
    const byStaff = await on(repo, 'startCollegeEvent', { eventId: id }, 'openid-u02');
    assert.equal(byStaff.data.ok, false);
    assert.match(byStaff.data.message, /只有管理员/);

    const started = await on(repo, 'startCollegeEvent', { eventId: id }, admin);
    assert.equal(started.data.ok, true, started.data.message);
    assert.equal(started.data.record.status, COLLEGE_EVENT_STATUS.ONGOING);
    assert.equal(started.data.ties.length, 1, '两所学院首轮一场');

    const tie = started.data.ties[0];
    assert.equal(tie.legs.length, 2, '小项序列铺到每个大场上');
    assert.equal(tie.status, TIE_STATUS.PENDING_LINEUP);
    assert.equal(tie.lineupA, false);
    assert.equal(tie.lineupB, false);
    assert.deepEqual(
      [tie.collegeA, tie.collegeB].sort(),
      [COLLEGE_SPORTS, COLLEGE_INFO].sort()
    );

    // 落库的与返回的是同一批大场（确定性主键）
    const stored = (await on(repo, 'getCollegeTies', { eventId: id }, admin)).data;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]._id, tie._id);
  });

  test('排阵与大场开始 —— 双方交齐才能开，开完不能再改', async () => {
    const repo = collegeFixtureRepo();
    const id = await publishCollege(repo);
    await submitBothEntries(repo, id);
    const [tie] = await startCollege(repo, id);
    const tieId = tie._id;

    const sportsLineup = lineupFrom(tie, ROSTER_SPORTS);
    const infoLineup = lineupFrom(tie, ROSTER_INFO);

    // 未登录 → 顶层失败；会员 / 别院干事 → 业务失败
    const anon = await on(repo, 'submitLineup', { tieId, college: COLLEGE_SPORTS, entries: sportsLineup }, null);
    assert.equal(anon.ok, false);
    assert.equal(anon.message, '请先登录后再操作');

    const byMember = await on(
      repo,
      'submitLineup',
      { tieId, college: COLLEGE_SPORTS, entries: sportsLineup },
      'openid-u01'
    );
    assert.equal(byMember.data.ok, false);
    assert.match(byMember.data.message, /只能提交本学院大场的排阵/);

    const byOther = await on(
      repo,
      'submitLineup',
      { tieId, college: COLLEGE_SPORTS, entries: sportsLineup },
      'openid-u02'
    );
    assert.equal(byOther.data.ok, false);

    // 少排一个人不给交（D40）
    const short = await on(
      repo,
      'submitLineup',
      { tieId, college: COLLEGE_SPORTS, entries: [sportsLineup[0]] },
      admin
    );
    assert.equal(short.data.ok, false);
    assert.match(short.data.message, /第 2 场还没排满/);

    // 名单外的人不给上（D37）：u03 是信息工程学院的人，塞不进体育学院
    const outsider = await on(
      repo,
      'submitLineup',
      {
        tieId,
        college: COLLEGE_SPORTS,
        entries: [{ legNo: 1, players: ['u03'] }, { legNo: 2, players: [ROSTER_SPORTS[1]] }],
      },
      admin
    );
    assert.equal(outsider.data.ok, false);
    assert.match(outsider.data.message, /不在本学院名单内/);

    // 先交体育学院：只翻自己那一侧，仍待排阵
    const first = await on(
      repo,
      'submitLineup',
      { tieId, college: COLLEGE_SPORTS, entries: sportsLineup },
      admin
    );
    assert.equal(first.data.ok, true, first.data.message);
    let stored = (await on(repo, 'getCollegeTies', { eventId: id }, admin)).data[0];
    assert.equal(Boolean(stored.lineupA) !== Boolean(stored.lineupB), true, '只有一侧置真');
    assert.equal(stored.status, TIE_STATUS.PENDING_LINEUP);

    // 还差一方，管理员不能开（D38）
    const notYet = await on(repo, 'startTie', { tieId }, admin);
    assert.equal(notYet.data.ok, false);
    assert.match(notYet.data.message, /排阵还没交齐/);

    // 信息工程学院补齐 → 双方排阵齐
    const infoSubmitted = await on(
      repo,
      'submitLineup',
      { tieId, college: COLLEGE_INFO, entries: infoLineup },
      'openid-u02'
    );
    assert.equal(infoSubmitted.data.ok, true, infoSubmitted.data.message);
    stored = (await on(repo, 'getCollegeTies', { eventId: id }, admin)).data[0];
    assert.equal(stored.lineupA && stored.lineupB, true);

    // 会员不能开大场；管理员可以
    const byMemberStart = await on(repo, 'startTie', { tieId }, 'openid-u01');
    assert.equal(byMemberStart.data.ok, false);
    assert.match(byMemberStart.data.message, /只有管理员/);

    const started = await on(repo, 'startTie', { tieId }, admin);
    assert.equal(started.data.ok, true, started.data.message);
    assert.equal(started.data.record.status, TIE_STATUS.ONGOING);

    // 开完再交 / 再开都被拒
    const afterStart = await on(
      repo,
      'submitLineup',
      { tieId, college: COLLEGE_SPORTS, entries: sportsLineup },
      admin
    );
    assert.equal(afterStart.data.ok, false);
    assert.match(afterStart.data.message, /已经开始/);

    const twice = await on(repo, 'startTie', { tieId }, admin);
    assert.equal(twice.data.ok, false);
    assert.match(twice.data.message, /已经开始/);
  });

  test('记弃权 —— 已撤销的小项不能被弃权悄悄复活', async () => {
    const repo = collegeFixtureRepo();
    const id = await publishCollege(repo);
    await submitBothEntries(repo, id);
    const [tie] = await startCollege(repo, id);
    const tieId = tie._id;

    await on(repo, 'submitLineup', { tieId, college: COLLEGE_SPORTS, entries: lineupFrom(tie, ROSTER_SPORTS) }, admin);
    await on(repo, 'submitLineup', { tieId, college: COLLEGE_INFO, entries: lineupFrom(tie, ROSTER_INFO) }, 'openid-u02');
    const started = await on(repo, 'startTie', { tieId }, admin);
    assert.equal(started.data.ok, true, started.data.message);

    const stored = (await on(repo, 'getCollegeTies', { eventId: id }, admin)).data[0];
    const leg = stored.legs[0];
    assert.ok(leg.matchId, '小项应当已生成比赛');

    // 管理员撤销了这场小场（判罚有误）。撤销是终局判定，弃权不能把它翻回来
    await repo.matches.update(leg.matchId, { status: MATCH_STATUS.REVOKED });

    const revived = await on(
      repo,
      'recordForfeit',
      { tieId, legNo: leg.legNo, forfeitBy: stored.collegeA },
      admin
    );
    assert.equal(revived.data.ok, false);
    assert.match(revived.data.message, /已撤销/);
    assert.equal(
      (await repo.matches.getById(leg.matchId)).status,
      MATCH_STATUS.REVOKED,
      '被拒的调用不许改动小场状态'
    );
  });
});
