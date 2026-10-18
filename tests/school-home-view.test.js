/**
 * B4-b：学校维度首页装载器（school-home-view）
 * ============================================================
 * 守的是：
 *   1. 首页按「当前浏览学校」聚合公告 / 近期赛事 / 概况（公告 2026-10-18 起是
 *      学校级一条通道，只取一次；赛事与概况仍按协会汇总）；
 *   2. 游客只看公告（§11.8），赛事与概况不取；
 *   3. 跨校只读浏览得到真实空聚合，不编数字、不展示静态演示内容；
 *   4. 分页循环取完，不把第一页当全集；单协会读失败跳过，不拖垮整页。
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../miniprogram/services/runtime-mode.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const schoolSession = require('../miniprogram/services/school-session.js');
const {
  loadSchoolHomeView, announcementRow, eventRow, isUpcomingEvent, sortUpcoming,
} = require('../miniprogram/services/school-home-view.js');

beforeEach(() => {
  runtime.setDataSource('mock');
  schoolMock.reset();
  schoolSession.reset();
});

/* ============================================================
 * 纯函数
 * ============================================================ */

test('isUpcomingEvent —— 只认报名中 / 进行中', () => {
  assert.strictEqual(isUpcomingEvent({ isSignup: true }), true);
  assert.strictEqual(isUpcomingEvent({ isOngoing: true }), true);
  assert.strictEqual(isUpcomingEvent({ isSignup: false, isOngoing: false }), false);
  assert.strictEqual(isUpcomingEvent(null), false);
});

test('sortUpcoming —— 只留近期、开赛时间升序、按 limit 截断', () => {
  const rows = [
    { id: 'a', isSignup: false, isOngoing: true, startTime: '2026-11-05T09:00:00' },
    { id: 'b', isSignup: true, isOngoing: false, startTime: '2026-10-20T09:00:00' },
    { id: 'c', isSignup: false, isOngoing: false, startTime: '2026-10-01T09:00:00' }, // 已结束
  ];
  const result = sortUpcoming(rows, 3);
  assert.deepStrictEqual(result.map((row) => row.id), ['b', 'a'], '已结束不进近期，最近要打的在前');
});

test('announcementRow / eventRow —— 渲染字段齐备，无 undefined 泄露', () => {
  const assoc = { id: 'pkb', shortName: '匹克球', logoGlyph: '匹' };
  // 公告是学校级的一条通道：不再带协会标注与分类
  const a = announcementRow(
    { announcementId: 'ann_1', title: 't', content: '', pinned: false, publishTime: '2026-10-01T00:00:00Z' }
  );
  const e = eventRow(
    { eventId: 'ev_1', title: 't', statusLabel: '报名中', isOngoing: false, startTime: null, location: '', quotaText: '', mySignup: null },
    assoc
  );
  assert.ok(!JSON.stringify([a, e]).includes('undefined'), '渲染行里出现 undefined');
  assert.strictEqual(a.id, 'ann_1');
  assert.strictEqual(a.association, undefined, '公告不带协会标注');
  assert.strictEqual(e.association, 'pkb');
  assert.strictEqual(e.associationName, '匹克球');
  assert.strictEqual(e.associationGlyph, '匹');
  assert.strictEqual(e.signedUp, false);
});

/* ============================================================
 * 真实 mock 聚合
 * ============================================================ */

test('聚合 —— 民大首页：公告置顶在前、近期赛事、概况数字来自 S2', async () => {
  schoolMock.setDemoActor('u06');
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06' });

  assert.strictEqual(view.loggedIn, true);
  assert.ok(view.announcements.rows.length > 0);
  assert.strictEqual(view.announcements.rows[0].pinned, true, '置顶公告排在最前');
  // 公告是学校级的一条通道：民大演示 5 条，不按协会重复
  assert.strictEqual(view.announcements.total, 5, '演示公告按学校一份');
  for (const row of view.announcements.rows) {
    assert.ok(row.id && row.title, '每条公告带编号与标题');
    assert.strictEqual(row.associationName, undefined, '公告不再标注所属协会');
  }

  // 报名中的赛事：各协会汇总后默认只展示前 3 条（home-view 的 DEFAULT_EVENT_LIMIT）
  assert.strictEqual(view.upcomingEvents.length, 3, '近期赛事按默认条数截断');
  const upcoming = view.upcomingEvents[0];
  assert.strictEqual(upcoming.signedUp, false);
  assert.ok(upcoming.timeText, '赛事带开赛时间文案');

  // 会员数学校级一份（24 + 校管理员 + 会员 + 会员二 + 学院负责人）；比赛 / 赛事按协会汇总
  assert.strictEqual(view.summary.memberCount, 28);
  assert.strictEqual(view.summary.matchCount, 28);
  assert.strictEqual(view.summary.eventCount, 6);
  assert.strictEqual(view.summary.seasonText, '第 1 赛季');
});

test('聚合 —— 游客只看公告：近期赛事与概况不取', async () => {
  schoolMock.setDemoActor('u06');
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: '' });

  assert.strictEqual(view.loggedIn, false);
  assert.ok(view.announcements.rows.length > 0, '访客能看公告');
  assert.deepStrictEqual(view.upcomingEvents, [], '访客看不到近期赛事');
  assert.strictEqual(view.summary, null, '访客看不到概况');
});

test('聚合 —— 跨校只读浏览得到真实空聚合，不编数字', async () => {
  schoolMock.setDemoActor('demo_muc_member');
  const view = await loadSchoolHomeView({ schoolId: 'buaa', viewerId: 'demo_muc_member' });

  assert.strictEqual(view.loggedIn, true);
  assert.deepStrictEqual(view.announcements.rows, [], '民大会员读不到北航公告');
  assert.deepStrictEqual(view.upcomingEvents, []);
  assert.strictEqual(view.summary, null, '读不到任何协会时不编概况数字');
});

/* ============================================================
 * 分页与容错（注入替身客户端）
 * ============================================================ */

function fakeClient({ announcements = [], events = [], matchTotal = 0, seasonNumber = 1, memberTotal = 0, failAssociations = [] }) {
  const associations = require('../miniprogram/utils/associations.js').allAssociations();
  const apiFor = (assocId) => ({
    async listSchoolAnnouncements(payload = {}) {
      if (failAssociations.includes(assocId)) throw new Error('没有读取协会空间的权限');
      const limit = payload.limit || 20;
      const page = announcements.slice(0, limit);
      return { ok: true, announcements: page, hasMore: announcements.length > page.length };
    },
    async listSchoolEvents(payload = {}) {
      const limit = payload.limit || 50;
      const offset = payload.offset || 0;
      const page = events.slice(offset, offset + limit);
      return { ok: true, events: page, hasMore: offset + page.length < events.length, nextOffset: offset + page.length };
    },
    async listSchoolMatches() {
      return { ok: true, total: matchTotal, matches: [], hasMore: false };
    },
    async getSchoolSeason() {
      return { ok: true, season: { seasonNumber } };
    },
    async listSchoolMembers() {
      return { ok: true, total: memberTotal, members: [] };
    },
  });
  const forScope = (scope) => apiFor(scope.association);
  return { forScope, associations };
}

test('聚合 —— 公告超过单页限量时如实带 hasMore，赛事数循环取完不截断', async () => {
  const announcements = Array.from({ length: 120 }, (_, i) => ({
    announcementId: `a${i}`, title: `公告${i}`, content: '', category: '通知',
    pinned: i === 0, publishTime: `2026-10-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const events = Array.from({ length: 80 }, (_, i) => ({
    eventId: `e${i}`, title: `赛${i}`, statusLabel: '已结束', isSignup: false, isOngoing: false,
    startTime: '2026-01-01T09:00:00', location: '', quotaText: '', mySignup: null,
  }));
  const client = fakeClient({ announcements, events, matchTotal: 5, memberTotal: 10 });
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', client });

  // 公告服务端单页限量 50（无 offset）：首页展示第一页的前 3 条，如实带上 hasMore
  assert.strictEqual(view.announcements.hasMore, true);
  assert.strictEqual(view.announcements.rows.length, 3, '首屏仍只展示 3 条');
  assert.strictEqual(view.announcements.rows[0].pinned, true, '置顶在最前');
  // 赛事带 offset 分页：循环取完，概况数不截断
  assert.strictEqual(view.summary.eventCount, 80 * 3, '赛事数循环取完不截断');
  assert.strictEqual(view.summary.matchCount, 5 * 3);
});

test('聚合 —— 单协会读失败跳过，其余协会照常聚合（公告不受影响）', async () => {
  const announcements = [{
    announcementId: 'a1', title: '停训通知', content: '',
    pinned: false, publishTime: '2026-10-01T00:00:00Z',
  }];
  const client = fakeClient({ announcements, failAssociations: ['tt', 'bd'] });
  const view = await loadSchoolHomeView({ schoolId: 'muc', viewerId: 'u06', client });

  // 公告走第一个协会的客户端一次取全（它是学校级集合），tt / bd 失败与它无关
  assert.strictEqual(view.announcements.total, 1);
  assert.strictEqual(view.announcements.rows[0].title, '停训通知');
});
