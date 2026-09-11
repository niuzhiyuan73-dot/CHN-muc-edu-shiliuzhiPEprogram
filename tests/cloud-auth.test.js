/**
 * 云函数写接口 —— 权限一律走严格口径
 * ============================================================
 * mock 为了让演示流程走得通，把确认、审核、发布都放宽成「登录即可」。
 * 云端必须相反：放宽的是演示口径，不是规则本身。
 *
 * 这一组测试把每条严格边界钉死：
 *   确认 —— 限对手方，录入方不能给自己盖章
 *   撤销 —— 限管理员或原录入者
 *   审核 / 公告 —— 限 role >= 干事，且不能审自己
 * 任何一条被「顺手放宽」，都会在这里变红。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatch } = require('../cloudfunctions/data/src/core/dispatch.js');
const { ROLE, USER_STATUS, MATCH_STATUS, ANNOUNCEMENT_STATUS } = require('../miniprogram/utils/constants.js');
const {
  USERS,
  createFixtureRepo,
  contextFor,
} = require('./helpers/cloud-fixture.js');

/** 一位干事，用来验证「role >= STAFF 即可管理」这条线 */
const STAFF = { ...USERS[1], _id: 'u_staff', openId: 'openid-staff', role: ROLE.STAFF };

/** 一份合法的录入单：u01 录入，对手是 u02 */
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

/** 一份合法的公告表单 */
const ANNOUNCEMENT_FORM = { title: '周末招新', content: '周六下午在体育馆招新。', category: '通知' };

/** 建好仓储与上下文，再录一场待确认的比赛 */
async function pendingMatch(openId = 'openid-u01', options) {
  const repo = createFixtureRepo(options);
  const ctx = await contextFor(repo, openId);
  const res = await dispatch('submitMatch', MATCH_FORM, ctx);
  assert.equal(res.data.ok, true, '夹具本身要能录进一场比赛');
  return { repo, ctx, id: res.data.match._id };
}

/* ---------- 公告 ---------- */

test('发布公告 —— 普通会员被挡下', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);

  assert.equal(res.data.ok, false);
  assert.equal(res.data.firstError, '当前账号没有发布公告的权限');
});

test('发布公告 —— 待审核的账号也被挡下（还没转正，不能去管别人）', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-pending');
  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);

  assert.equal(res.data.ok, false);
  assert.equal(res.data.firstError, '当前账号没有发布公告的权限');
});

test('发布公告 —— 干事即可发布，发布人与发布时间由服务端填写', async () => {
  const repo = createFixtureRepo({ users: [...USERS, STAFF] });
  const ctx = await contextFor(repo, 'openid-staff');
  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);

  assert.equal(res.data.ok, true);
  assert.equal(res.data.record.status, ANNOUNCEMENT_STATUS.PUBLISHED);
  assert.equal(res.data.record.publisherId, 'u_staff');
  assert.equal(res.data.record.publisherName, '甲', '昵称逐层兜底，绝不落空字符串');
  assert.equal(
    new Date(res.data.record.publishTime).getTime(),
    ctx.now.getTime(),
    '发布时间取服务端时钟，不信客户端'
  );
});

test('发布公告 —— 内容不合规时不落库，且不产生副作用', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-admin');
  const res = await dispatch('publishAnnouncement', { form: { ...ANNOUNCEMENT_FORM, title: '短' } }, ctx);

  assert.equal(res.data.ok, false);
  assert.match(res.data.firstError, /标题/);

  const ledger = await dispatch('getAnnouncementRecords', {}, ctx);
  assert.equal(ledger.data.length, 3, '校验没过就不该多出任何一条公告');
});

test('下架公告 —— 普通会员无权，管理员可以，且不能重复下架', async () => {
  const repo = createFixtureRepo();

  const member = await contextFor(repo, 'openid-u01');
  const denied = await dispatch('archiveAnnouncement', { id: 'a1' }, member);
  assert.equal(denied.data.message, '当前账号没有管理公告的权限');

  const admin = await contextFor(repo, 'openid-admin');
  const first = await dispatch('archiveAnnouncement', { id: 'a1' }, admin);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.record.status, ANNOUNCEMENT_STATUS.ARCHIVED);

  const again = await dispatch('archiveAnnouncement', { id: 'a1' }, admin);
  assert.equal(again.data.ok, false);
  assert.equal(again.data.message, '这条公告已经下架了');

  const missing = await dispatch('archiveAnnouncement', { id: 'nope' }, admin);
  assert.equal(missing.data.message, '找不到这条公告');
});

/* ---------- 比赛确认 ---------- */

test('确认比赛 —— 录入方不能给自己盖章', async () => {
  const { ctx, id } = await pendingMatch('openid-u01');
  const res = await dispatch('confirmMatch', { id }, ctx);

  assert.equal(res.data.ok, false);
  assert.equal(res.data.message, '你无权确认这场比赛');
});

test('确认比赛 —— 对手方可以确认，成绩随即生效', async () => {
  const { repo, id } = await pendingMatch('openid-u01');
  const opponent = await contextFor(repo, 'openid-u02');

  const res = await dispatch('confirmMatch', { id }, opponent);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.match.status, MATCH_STATUS.ACTIVE);

  // 确认之后这场才算进「已生效」的流水
  const active = await dispatch('getMatches', { userId: 'u01' }, opponent);
  assert.ok(active.data.some((m) => m._id === id));
});

test('确认比赛 —— 非参赛者被挡下，找不到的比赛有明确文案', async () => {
  const { repo, id } = await pendingMatch('openid-u01');

  const outsider = await contextFor(repo, 'openid-u03');
  const denied = await dispatch('confirmMatch', { id }, outsider);
  assert.equal(denied.data.message, '你无权确认这场比赛');

  const missing = await dispatch('confirmMatch', { id: 'nope' }, outsider);
  assert.equal(missing.data.message, '找不到这场比赛');
});

test('驳回比赛 —— 必须给出理由，且只有对手方能驳回', async () => {
  const { repo, id } = await pendingMatch('openid-u01');

  const recorder = await contextFor(repo, 'openid-u01');
  const wrongSide = await dispatch('rejectMatch', { id, reason: '打错了' }, recorder);
  assert.equal(wrongSide.data.message, '你无权驳回这场比赛');

  const opponent = await contextFor(repo, 'openid-u02');
  const noReason = await dispatch('rejectMatch', { id }, opponent);
  assert.equal(noReason.data.message, '请填写驳回理由');

  const done = await dispatch('rejectMatch', { id, reason: '比分录反了' }, opponent);
  assert.equal(done.data.ok, true);
  assert.equal(done.data.match.status, MATCH_STATUS.REVOKED);
  assert.equal(done.data.match.action, 'reject');
});

/* ---------- 比赛撤销 ---------- */

test('撤销比赛 —— 普通会员只能撤自己录的', async () => {
  const repo = createFixtureRepo();
  const other = await contextFor(repo, 'openid-u03');

  // m1 由 u01 录入，u03 既不是录入者也不是管理员
  const denied = await dispatch('revokeMatch', { id: 'm1', reason: '录错了' }, other);
  assert.equal(denied.data.message, '你无权撤销这场比赛');
});

test('撤销比赛 —— 录入者可以撤，理由是必填的', async () => {
  const repo = createFixtureRepo();
  const recorder = await contextFor(repo, 'openid-u01');

  const noReason = await dispatch('revokeMatch', { id: 'm1' }, recorder);
  assert.equal(noReason.data.message, '请填写撤销理由');

  const done = await dispatch('revokeMatch', { id: 'm1', reason: '对手记错了' }, recorder);
  assert.equal(done.data.ok, true);
  assert.equal(done.data.match.action, 'revoke');

  const again = await dispatch('revokeMatch', { id: 'm1', reason: '再撤一次' }, recorder);
  assert.equal(again.data.message, '这场比赛已经作废了');
});

test('撤销比赛 —— 管理员可以撤别人的比赛', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  // m2 由 u03 录入
  const res = await dispatch('revokeMatch', { id: 'm2', reason: '重复录入' }, admin);
  assert.equal(res.data.ok, true);

  // 撤销后分数整体重算：这场不再计入流水
  const list = await dispatch('getMatches', {}, admin);
  assert.ok(!list.data.some((m) => m._id === 'm2'));
});

/* ---------- 入会审核 ---------- */

test('入会审核 —— 普通会员无权审核', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-u01');
  const res = await dispatch('approveMember', { applicationId: 'u_pending' }, ctx);

  assert.equal(res.data.ok, false);
  assert.equal(res.data.message, '当前账号没有审核权限');
});

test('入会审核 —— 管理员可以通过，驳回必须给理由', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const noReason = await dispatch('rejectMember', { applicationId: 'u_pending' }, admin);
  assert.equal(noReason.data.message, '请填写驳回理由');

  const approved = await dispatch('approveMember', { applicationId: 'u_pending' }, admin);
  assert.equal(approved.data.ok, true);
  assert.equal(approved.data.account.status, USER_STATUS.ACTIVE);

  // 批过之后这位就成了正式会员，会进入回放名单
  const members = await dispatch('getMembers', {}, admin);
  assert.ok(members.data.some((m) => m._id === 'u_pending'));

  const again = await dispatch('approveMember', { applicationId: 'u_pending' }, admin);
  assert.equal(again.data.message, '这条申请已经处理过了');
});

test('入会审核 —— 找不到的申请有明确文案', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-admin');
  const res = await dispatch('approveMember', { applicationId: 'nobody' }, ctx);

  assert.equal(res.data.message, '找不到这条入会申请');
});

/* ---------- 入会申请 ---------- */

test('提交入会申请 —— 注册不需要先登录，但身份由服务端盖章', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-new');

  const res = await dispatch(
    'registerMember',
    {
      profile: {
        realName: '王五',
        studentId: '2026123456',
        college: '体育学院',
        phone: '13900000000',
        nickName: '小王',
      },
    },
    ctx
  );

  assert.equal(res.data.ok, true);
  assert.equal(res.data.account.status, USER_STATUS.PENDING);
  assert.equal(res.data.account.role, ROLE.MEMBER);
  assert.equal(res.data.account.openId, 'openid-new');
  assert.ok(res.data.account._id, '主键由服务端按 OpenID 派生');
});

test('提交入会申请 —— 实名信息不合规时一个字都不落库', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-new');
  const res = await dispatch('registerMember', { profile: { realName: '王' } }, ctx);

  assert.equal(res.data.ok, false);
  assert.ok(res.data.firstError);
  assert.equal(res.data.account, null);

  const applications = await dispatch('getMemberApplications', {}, ctx);
  assert.equal(applications.data.length, 1, '被拒的申请不能留下痕迹');
});

/* ---------- 个人资料 ---------- */

test('修改资料 —— 普通会员可以改自己的昵称与头像', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const res = await dispatch(
    'updateProfile',
    { patch: { nickName: '小甲', avatarUrl: 'cloud://a/b.png' } },
    ctx
  );
  assert.equal(res.data.ok, true, res.data.firstError);
  assert.equal(res.data.account.nickName, '小甲');
  assert.equal(res.data.account.avatarUrl, 'cloud://a/b.png');

  // 改完之后别人取到的也是新名字
  const fetched = await dispatch('getMember', { userId: 'u01' }, ctx);
  assert.equal(fetched.data.nickName, '小甲');
});

test('修改资料 —— 只认登录身份，请求体里写别人的编号也改不到别人', async () => {
  const repo = createFixtureRepo();
  const mine = await contextFor(repo, 'openid-u01');
  const other = await contextFor(repo, 'openid-u02');

  const res = await dispatch(
    'updateProfile',
    { patch: { nickName: '改别人' }, actor: 'u02' },
    mine
  );
  assert.equal(res.data.ok, true, res.data.firstError);

  assert.equal((await dispatch('getMember', { userId: 'u01' }, mine)).data.nickName, '改别人');
  assert.equal(
    (await dispatch('getMember', { userId: 'u02' }, other)).data.nickName,
    '乙',
    'u02 的名字不该被 u01 的请求改动'
  );
});

test('修改资料 —— 实名与权限字段被白名单挡在门外', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  // 拿库里那条原始记录比对：数据集里的 points 是从赛事名次算出来的派生值，
  // 与库里存的那一列无关。这里要确认的是「存进去的敏感字段一个都没被改动」，
  // 所以直接读库比对，而不是拿派生值去和原始值对等。
  const before = await repo.users.getById('u01');
  const res = await dispatch(
    'updateProfile',
    {
      patch: {
        nickName: '合规',
        realName: '冒名',
        studentId: '000000',
        role: 2,
        points: 99999,
      },
    },
    ctx
  );

  const after = await repo.users.getById('u01');
  assert.equal(res.data.ok, true, res.data.firstError);
  assert.equal(res.data.account.nickName, '合规');
  assert.equal(after.realName, before.realName);
  assert.equal(after.studentId, before.studentId);
  assert.equal(after.role, before.role);
  assert.equal(after.points, before.points, '积分是派生值，不该被资料补丁改动库里的那一列');
});

test('修改资料 —— 昵称不合规与空补丁都被挡下，且不落库', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const blank = await dispatch('updateProfile', { patch: { nickName: '  ' } }, ctx);
  assert.equal(blank.data.ok, false);
  assert.ok(blank.data.errors.nickName);

  const nothing = await dispatch('updateProfile', { patch: { role: 2 } }, ctx);
  assert.equal(nothing.data.ok, false);
  assert.equal(nothing.data.firstError, '没有要修改的内容');

  assert.equal((await dispatch('getMember', { userId: 'u01' }, ctx)).data.nickName, '甲');
});

test('修改资料 —— 未登录时顶层失败，提示先登录', async () => {
  const ctx = await contextFor(createFixtureRepo(), null);
  const res = await dispatch('updateProfile', { patch: { nickName: '谁' } }, ctx);

  assert.equal(res.ok, false);
  assert.equal(res.message, '请先登录后再操作');
});
