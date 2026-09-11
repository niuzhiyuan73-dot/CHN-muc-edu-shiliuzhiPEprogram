/**
 * 云函数幂等 —— 弱网重试不能变成重复计分
 * ============================================================
 * 用户连点两下「提交」，或请求超时后客户端自动重试，都会让同一个动作
 * 到达云端两次。等级分是零和的，一场比赛被记两遍会让双方各多算一次分，
 * 而且从数据上完全看不出哪里错了。
 *
 * 云端的做法是把「自然键」直接当成文档主键：第二次提交撞上同一个 _id，
 * 事务里读到已存在就知道是重试。这一组测试盯的就是这条路走不走得通。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const { USER_STATUS } = require('../miniprogram/utils/constants.js');
const {
  createFixtureRepo,
  contextFor,
} = require('./helpers/cloud-fixture.js');
const {
  matchNaturalKey,
  announcementNaturalKey,
  memberKey,
} = require('../cloudfunctions/data/src/core/idempotency.js');

const MATCH_FORM = {
  matchType: 1,
  teamA: ['u01'],
  teamB: ['u02'],
  scoreA: [11],
  scoreB: [9],
  gamePoints: 11,
  bestOf: 1,
  matchTime: '2026-05-01T18:00:00',
  recorder: 'u01',
};

const FORM = { title: '周末招新', content: '周六下午在体育馆招新。', category: '通知' };

/* ---------- 自然键 ---------- */

test('自然键 —— 同一份输入永远得到同一个键', () => {
  const record = {
    pool: 'doubles',
    teamA: ['u01', 'u02'],
    teamB: ['u03', 'u04'],
    scoreA: [11],
    scoreB: [5],
    matchTime: '2026-04-10T18:00:00',
    recorder: 'u01',
  };

  assert.equal(matchNaturalKey(record), matchNaturalKey({ ...record }));
});

test('自然键 —— 队内顺序无关，换人或换录入人则不同', () => {
  const record = {
    pool: 'doubles',
    teamA: ['u01', 'u02'],
    teamB: ['u03', 'u04'],
    scoreA: [11],
    scoreB: [5],
    matchTime: '2026-04-10T18:00:00',
    recorder: 'u01',
  };

  assert.equal(
    matchNaturalKey(record),
    matchNaturalKey({ ...record, teamA: ['u02', 'u01'] }),
    '同一队里两人顺序不同，不该被当成两场比赛'
  );

  assert.notEqual(
    matchNaturalKey(record),
    matchNaturalKey({ ...record, recorder: 'u02' }),
    '不同的人报出同一组合比分，那是两场真实比赛'
  );

  assert.notEqual(
    matchNaturalKey(record),
    matchNaturalKey({ ...record, scoreB: [6] }),
    '比分不同就是不同的比赛'
  );
});

test('自然键 —— 会员键与公告键同样是确定且互不相同', () => {
  assert.equal(memberKey('openid-u01'), memberKey('openid-u01'));
  assert.notEqual(memberKey('openid-u01'), memberKey('openid-u02'));

  const announcement = { publisherId: 'u_admin', title: '招新', content: '正文' };
  assert.equal(announcementNaturalKey(announcement), announcementNaturalKey({ ...announcement }));
  assert.notEqual(
    announcementNaturalKey(announcement),
    announcementNaturalKey({ ...announcement, content: '别的正文' })
  );
});

/* ---------- 录入比赛 ---------- */

test('录入比赛 —— 重复提交只落一条，且返回的是同一条', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const first = await dispatch('submitMatch', MATCH_FORM, ctx);
  const second = await dispatch('submitMatch', MATCH_FORM, ctx);

  assert.equal(first.data.ok, true);
  assert.equal(second.data.ok, true);
  assert.equal(second.data.match._id, first.data.match._id, '重试必须落回同一条记录');

  // 夹具里的四场都是已生效的，台账里待确认的那部分只该有这一场
  const pending = await dispatch('getMatchRecords', { status: 0 }, ctx);
  assert.equal(pending.data.length, 1, '弱网重试不该多出第二场比赛');
});

test('录入比赛 —— 内容变了就是另一场比赛', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  await dispatch('submitMatch', MATCH_FORM, ctx);
  await dispatch('submitMatch', { ...MATCH_FORM, scoreB: [7] }, ctx);

  const pending = await dispatch('getMatchRecords', { status: 0 }, ctx);
  assert.equal(pending.data.length, 2);
});

/* ---------- 入会申请 ---------- */

test('入会申请 —— 重复提交不会多出一条申请', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-new');
  const profile = {
    realName: '王五',
    gender: 'M',
    studentId: '2026123456',
    college: '体育学院',
    phone: '13900000000',
    nickName: '小王',
  };

  const first = await dispatch('registerMember', { profile }, ctx);
  const second = await dispatch('registerMember', { profile }, ctx);

  assert.equal(second.data.account._id, first.data.account._id);

  const applications = await dispatch('getMemberApplications', {}, ctx);
  assert.equal(applications.data.filter((a) => a._id === first.data.account._id).length, 1);
});

test('入会申请 —— 已经批下来的账号不会被一次重试打回待审核', async () => {
  const repo = createFixtureRepo();
  const applicant = await contextFor(repo, 'openid-new');
  const profile = {
    realName: '王五',
    gender: 'M',
    studentId: '2026123456',
    college: '体育学院',
    phone: '13900000000',
    nickName: '小王',
  };

  const created = await dispatch('registerMember', { profile }, applicant);
  const admin = await contextFor(repo, 'openid-admin');
  await dispatch('approveMember', { applicationId: created.data.account._id }, admin);

  // 用户手抖又点了一次「提交申请」
  const retry = await dispatch('registerMember', { profile }, applicant);

  assert.equal(retry.data.ok, true);
  assert.equal(retry.data.account.status, USER_STATUS.ACTIVE, '重试不能冲掉既有的审核结果');
});

/* ---------- 公告 ---------- */

test('发布公告 —— 同一个人重复发同一条只留一份', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const first = await dispatch('publishAnnouncement', { form: FORM }, admin);
  const second = await dispatch('publishAnnouncement', { form: FORM }, admin);

  assert.equal(first.data.ok, true);
  assert.equal(second.data.record._id, first.data.record._id);

  const ledger = await dispatch('getAnnouncementRecords', {}, admin);
  assert.equal(ledger.data.length, 4, '夹具原本 3 条，重试后仍应只有 4 条');
});

test('发布公告 —— 换了标题就是另一条公告', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  await dispatch('publishAnnouncement', { form: FORM }, admin);
  await dispatch('publishAnnouncement', { form: { ...FORM, title: '下周招新' } }, admin);

  const ledger = await dispatch('getAnnouncementRecords', {}, admin);
  assert.equal(ledger.data.length, 5);
});
