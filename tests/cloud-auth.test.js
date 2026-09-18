/**
 * 云函数写接口 —— 权限一律走严格口径
 * ============================================================
 * mock 为了让演示流程走得通，把确认、审核、发布都放宽成「登录即可」。
 * 云端必须相反：放宽的是演示口径，不是规则本身。
 *
 * 这一组测试把每条严格边界钉死：
 *   确认 —— 限对手方，录入方不能给自己盖章
 *   撤销 —— 限管理员（它改写已生效的账本，录入者本人也不行）
 *   审核 / 公告 —— 限管理员（干事是学院范围角色，管不到这两件事），且不能审自己
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

/** 一位干事，用来验证「干事管不到俱乐部全局事务」这条线 */
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

test('发布公告 —— 待审核的账号在入口就被挡下（还没转正，不能去管别人）', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-pending');
  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);

  // 账号状态不正常时，连业务校验都不进：顶层就拒绝，不给出「配置了什么」的线索
  assert.equal(res.ok, false);
  assert.equal(res.message, '账号还在审核中，通过后才能操作');
});

test('写接口 —— 已停用的账号一律挡下（账号还在，不能只认「查得到」）', async () => {
  const banned = { ...USERS[1], _id: 'u_banned', openId: 'openid-banned', status: USER_STATUS.DISABLED };
  const repo = createFixtureRepo({ users: [...USERS, banned] });
  const ctx = await contextFor(repo, 'openid-banned');

  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.message, '账号已被停用，请联系管理员');
});

test('发布公告 —— 干事被挡下（公告是发给全俱乐部的，干事收不出范围）', async () => {
  const repo = createFixtureRepo({ users: [...USERS, STAFF] });
  const ctx = await contextFor(repo, 'openid-staff');
  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);

  assert.equal(res.data.ok, false);
  assert.equal(res.data.firstError, '当前账号没有发布公告的权限');
});

test('发布公告 —— 管理员即可发布，发布人与发布时间由服务端填写', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-admin');
  const res = await dispatch('publishAnnouncement', { form: ANNOUNCEMENT_FORM }, ctx);

  assert.equal(res.data.ok, true);
  assert.equal(res.data.record.status, ANNOUNCEMENT_STATUS.PUBLISHED);
  assert.equal(res.data.record.publisherId, 'u_admin');
  assert.equal(res.data.record.publisherName, '管理员', '昵称逐层兜底，绝不落空字符串');
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

/* ---------- 录入权限 ---------- */

test('录入比赛 —— 录入人一律记登录者，前端塞的 recorder 不作数', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  const res = await dispatch('submitMatch', { ...MATCH_FORM, recorder: 'u_admin' }, ctx);
  assert.equal(res.data.ok, true, res.data.firstError);
  assert.equal(res.data.match.recorder, 'u01', '录入人必须是登录者，不能自选');
});

test('录入比赛 —— 把录入人填成不在场上的人，也换不来自己确认', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-u01');

  // 攻击链：自己那队填成赢家，再把 recorder 填成局外人——recorderSide 成了
  // null，确认权就会向场上所有人开放，提交者随即能给自己盖章涨分。
  // 录入人由服务端锁死后，这条链断在第一步。
  const res = await dispatch('submitMatch', { ...MATCH_FORM, recorder: 'nobody' }, ctx);
  assert.equal(res.data.ok, true, res.data.firstError);

  const confirm = await dispatch('confirmMatch', { id: res.data.match._id }, ctx);
  assert.equal(confirm.data.ok, false);
  assert.equal(confirm.data.message, '你无权确认这场比赛');
});

test('录入比赛 —— 不是参赛者的会员编不出一场比赛', async () => {
  const repo = createFixtureRepo();
  const outsider = await contextFor(repo, 'openid-u03');

  const res = await dispatch('submitMatch', MATCH_FORM, outsider);
  assert.equal(res.data.ok, false);
  assert.match(res.data.firstError, /只有参赛者/);
});

test('录入比赛 —— 管理员可以代录任意一场', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const res = await dispatch('submitMatch', MATCH_FORM, admin);
  assert.equal(res.data.ok, true, res.data.firstError);
  assert.equal(res.data.match.recorder, 'u_admin');
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

test('撤销比赛 —— 只有管理员能撤，录入者本人也被挡下', async () => {
  const repo = createFixtureRepo();

  // m1 由 u01 录入。关键在于连录入者本人也不放行：撤销改写的是已生效的
  // 账本，而录入者是谁由录分的人自己选，放开就等于「赢了我就把记录抹掉」。
  const recorder = await contextFor(repo, 'openid-u01');
  const mine = await dispatch('revokeMatch', { id: 'm1', reason: '录错了' }, recorder);
  assert.equal(mine.data.message, '你无权撤销这场比赛');

  const other = await contextFor(repo, 'openid-u03');
  const denied = await dispatch('revokeMatch', { id: 'm1', reason: '录错了' }, other);
  assert.equal(denied.data.message, '你无权撤销这场比赛');
});

test('撤销比赛 —— 管理员可以撤别人的比赛，理由是必填的', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  // m2 由 u03 录入
  const noReason = await dispatch('revokeMatch', { id: 'm2' }, admin);
  assert.equal(noReason.data.message, '请填写撤销理由');

  const res = await dispatch('revokeMatch', { id: 'm2', reason: '重复录入' }, admin);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.match.action, 'revoke');
  assert.equal(res.data.match.status, MATCH_STATUS.REVOKED);

  const again = await dispatch('revokeMatch', { id: 'm2', reason: '再撤一次' }, admin);
  assert.equal(again.data.message, '这场比赛已经作废了');

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

test('入会审核 —— 通过时可顺手指定初始分，越界则整单被挡下', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  // 请求体里的分数同样不被信任：越界直接挡回，申请保持待审核
  const tooHigh = await dispatch(
    'approveMember',
    { applicationId: 'u_pending', initialElo: 99999 },
    admin
  );
  assert.equal(tooHigh.data.ok, false);
  assert.match(tooHigh.data.message, /之间/);

  const approved = await dispatch(
    'approveMember',
    { applicationId: 'u_pending', initialElo: 1620 },
    admin
  );
  assert.equal(approved.data.ok, true, approved.data.message);
  // 服务端把指定分写进账号，回放据此跳过前五场自动定级
  assert.equal(approved.data.account.initialElo, 1620);
});

test('入会审核 —— 找不到的申请有明确文案', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-admin');
  const res = await dispatch('approveMember', { applicationId: 'nobody' }, ctx);

  assert.equal(res.data.message, '找不到这条入会申请');
});

/* ---------- 任免干事（学院负责人） ---------- */

test('任免干事 —— 普通会员与干事都没有资格，只有管理员能', async () => {
  const repo = createFixtureRepo();
  const asMember = await contextFor(repo, 'openid-u01');
  const res = await dispatch('setCollegeLeader', { userId: 'u02', makeLeader: true }, asMember);

  assert.equal(res.data.ok, false);
  assert.match(res.data.message, /管理员/);

  // 干事不能互相任命、更不能给别的学院安插人手
  await dispatch('setCollegeLeader', { userId: 'u02', makeLeader: true }, await contextFor(repo, 'openid-admin'));
  const asStaff = await contextFor(repo, 'openid-u02');
  const denied = await dispatch('setCollegeLeader', { userId: 'u03', makeLeader: true }, asStaff);
  assert.equal(denied.data.ok, false);
  assert.match(denied.data.message, /管理员/);
});

test('任免干事 —— 管理员设置后被设者按本学院获权，可再撤销', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const promoted = await dispatch('setCollegeLeader', { userId: 'u01', makeLeader: true }, admin);
  assert.equal(promoted.data.ok, true, promoted.data.message);
  assert.equal(promoted.data.account.role, ROLE.STAFF);

  // 角色变了要失效缓存，否则 getMembers 还答旧身份
  const members = await dispatch('getMembers', {}, admin);
  assert.equal(members.data.find((m) => m._id === 'u01').role, ROLE.STAFF);

  const revoked = await dispatch('setCollegeLeader', { userId: 'u01', makeLeader: false }, admin);
  assert.equal(revoked.data.ok, true, revoked.data.message);
  assert.equal(revoked.data.account.role, ROLE.MEMBER);
});

test('任免干事 —— 不能改自己，只有状态正常的会员才能被设为干事', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const myself = await dispatch('setCollegeLeader', { userId: 'u_admin', makeLeader: false }, admin);
  assert.equal(myself.data.ok, false);
  assert.match(myself.data.message, /自己/);

  const pending = await dispatch('setCollegeLeader', { userId: 'u_pending', makeLeader: true }, admin);
  assert.equal(pending.data.ok, false);
  assert.match(pending.data.message, /正常/);
});

test('任免干事 —— 未登录时顶层失败', async () => {
  const ctx = await contextFor(createFixtureRepo(), null);
  const res = await dispatch('setCollegeLeader', { userId: 'u01', makeLeader: true }, ctx);

  assert.equal(res.ok, false);
  assert.equal(res.message, '请先登录后再操作');
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
        gender: 'M',
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
  assert.equal(res.data.account.gender, 'M', '性别要随账号一起落库，否则会员会从两张单打榜消失');
  assert.ok(res.data.account._id, '主键由服务端按 OpenID 派生');

  // 再从仓储读一遍：确认真写进了 users 集合，而不只是出现在返回值里
  const stored = await dispatch('getMember', { userId: res.data.account._id }, ctx);
  assert.equal(stored.data.gender, 'M');
});

test('提交入会申请 —— 没选性别的申请被挡下并指明字段', async () => {
  const ctx = await contextFor(createFixtureRepo(), 'openid-new');
  const res = await dispatch(
    'registerMember',
    {
      profile: {
        realName: '王五',
        gender: '',
        studentId: '2026123456',
        college: '体育学院',
        phone: '13900000000',
      },
    },
    ctx
  );

  assert.equal(res.data.ok, false);
  assert.ok(res.data.errors.gender, '要指明是性别这一项没填');
  assert.equal(res.data.account, null);
});

test('提交入会申请 —— 实名信息不合规时一个字都不落库', async () => {
  const repo = createFixtureRepo();
  const ctx = await contextFor(repo, 'openid-new');
  const res = await dispatch('registerMember', { profile: { realName: '王' } }, ctx);

  assert.equal(res.data.ok, false);
  assert.ok(res.data.firstError);
  assert.equal(res.data.account, null);

  // 申请名单只给干部看（见 read-handlers），所以用管理员去核对条数
  const admin = await contextFor(repo, 'openid-admin');
  const applications = await dispatch('getMemberApplications', {}, admin);
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

/* ---------- 置顶赛事 / 学院赛 ---------- */

test('置顶赛事 —— 普通会员被挡下，管理员置顶后真落库', async () => {
  const repo = createFixtureRepo();

  const member = await contextFor(repo, 'openid-u01');
  const denied = await dispatch('setEventPinned', { id: 'ev1', pinned: true }, member);
  assert.equal(denied.data.ok, false);
  assert.equal(denied.data.message, '当前账号没有管理赛事的权限');
  assert.equal((await repo.events.getById('ev1')).pinned, undefined, '被拒时一个字都不落库');

  const admin = await contextFor(repo, 'openid-admin');
  const done = await dispatch('setEventPinned', { id: 'ev1', pinned: true }, admin);
  assert.equal(done.data.ok, true, done.data.message);
  assert.equal(done.data.record.pinned, true);
  assert.equal((await repo.events.getById('ev1')).pinned, true, '置顶要真的写进仓储');

  const missing = await dispatch('setEventPinned', { id: 'nope', pinned: true }, admin);
  assert.equal(missing.data.ok, false);
  assert.equal(missing.data.message, '找不到这场赛事');
});

test('置顶学院赛 —— 普通会员被挡下，管理员置顶后真落库', async () => {
  const repo = createFixtureRepo();
  const admin = await contextFor(repo, 'openid-admin');

  const created = await dispatch(
    'publishCollegeEvent',
    {
      form: {
        title: '学院团体赛',
        legPlan: ['MS', 'WS'],
        startTime: '2026-10-01T09:00:00',
        rosterMin: 1,
        rosterMax: 20,
        courtCount: 4,
      },
    },
    admin
  );
  assert.equal(created.data.ok, true, created.data.firstError);
  const id = created.data.record._id;

  const member = await contextFor(repo, 'openid-u01');
  const denied = await dispatch('setCollegeEventPinned', { eventId: id, pinned: true }, member);
  assert.equal(denied.data.ok, false);
  assert.equal(denied.data.message, '当前账号没有管理学院赛的权限');

  const done = await dispatch('setCollegeEventPinned', { eventId: id, pinned: true }, admin);
  assert.equal(done.data.ok, true, done.data.message);
  assert.equal(done.data.record.pinned, true);
  assert.equal((await repo.collegeEvents.getById(id)).pinned, true, '置顶要真的写进仓储');
});
