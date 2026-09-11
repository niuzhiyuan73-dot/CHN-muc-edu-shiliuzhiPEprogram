/**
 * 会员审核页视图模型的自检
 * ============================================================
 * 这一层最要紧的是一条防线：没有审核权的人，一行申请都不能看到。
 * 申请单上写着全体申请人的姓名、学号、学院、手机号，泄漏一次就是
 * 一整批人的个人信息，所以「闸门」相关的用例排在最前面。
 *
 * 其余部分与比赛页视图模型同一个套路：
 *   - 权限算进行数据（canApprove / canReject），模板不写业务逻辑
 *   - 渲染字段里不许出现 undefined / null / NaN
 * ============================================================
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const { REVIEW_TAB, filterApplications, loadMemberReviewView } = require('../miniprogram/services/member-review-view.js');
const facade = require('../miniprogram/services/index.js');
const { ROLE, USER_STATUS } = require('../miniprogram/utils/constants.js');

/** 看审核页的人。审核权只看角色，所以这里得是干事 */
const REVIEWER = { _id: 'u02', nickName: '张宇轩', role: ROLE.STAFF, status: USER_STATUS.ACTIVE };

/** 已转正但没有审核权的普通会员，用来验证「一行都不下发」 */
const MEMBER = { _id: 'u05', nickName: '李思远', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE };

/** 一条申请都还没处理过的基线 */
beforeEach(() => facade.resetCache());

/* ============================================================
 * 一、闸门：没有权限就一行都不给
 * ============================================================ */

describe('会员审核视图 —— 防泄漏', () => {
  test('访客拿不到任何申请，只拿到一句提示', async () => {
    const view = await loadMemberReviewView({ user: null });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, [], '访客竟然拿到了申请数据');
    assert.deepStrictEqual(view.tabs, []);
    assert.strictEqual(view.pendingCount, 0);
    assert.match(view.blockedText, /登录/);
  });

  test('干脆不传 user 也按访客处理，不悄悄回退成演示会员', async () => {
    // 漏传一个参数不该换来权限：mock 的 getCurrentUser() 永远答 u06，
    // 一旦回退，访客就会凭空拿到审核权
    const view = await loadMemberReviewView({});

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.strictEqual(view.viewer.loggedIn, false);
  });

  test('还没转正的账号不能审核别人', async () => {
    const pendingUser = { _id: 'local_demo01', role: ROLE.MEMBER, status: USER_STATUS.PENDING };
    const view = await loadMemberReviewView({ user: pendingUser });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.blockedText, /权限/);
  });
});

/* ============================================================
 * 二、有权限时看到什么
 * ============================================================ */

describe('会员审核视图 —— 内容', () => {
  test('干事看到两条待审申请', async () => {
    const view = await loadMemberReviewView({ user: REVIEWER });

    assert.strictEqual(view.allowed, true);
    assert.strictEqual(view.blockedText, '');
    assert.strictEqual(view.activeTab, REVIEW_TAB.PENDING);
    assert.strictEqual(view.rows.length, 2);
    assert.strictEqual(view.pendingCount, 2);
    assert.strictEqual(view.handledCount, 0);
  });

  test('普通会员看到的仍是「没有权限」，一行申请都不下发', async () => {
    const view = await loadMemberReviewView({ user: MEMBER });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.blockedText, /权限/);
  });

  test('标签页带数量，且当前页被标成 active', async () => {
    const view = await loadMemberReviewView({ user: REVIEWER });

    assert.deepStrictEqual(
      view.tabs.map((item) => item.tab),
      [REVIEW_TAB.PENDING, REVIEW_TAB.HANDLED]
    );
    assert.deepStrictEqual(
      view.tabs.map((item) => item.active),
      [true, false]
    );
    assert.strictEqual(view.tabs[0].count, 2);
    assert.strictEqual(view.tabs[0].label, '待审核');
  });

  test('非法标签页退回「待审核」，不至于白屏', async () => {
    const view = await loadMemberReviewView({ user: REVIEWER, tab: 'nonsense' });
    assert.strictEqual(view.activeTab, REVIEW_TAB.PENDING);
    assert.strictEqual(view.rows.length, 2);
  });

  test('每一行都带上申请人资料与放行的两个按钮', async () => {
    const view = await loadMemberReviewView({ user: REVIEWER });
    const row = view.rows[0];

    // 实名信息是审核的依据，六项缺一不可
    assert.ok(row.nickName);
    assert.ok(row.realName);
    assert.ok(row.studentId);
    assert.ok(row.college);
    assert.ok(row.phone);
    assert.ok(row.appliedAtText);
    assert.strictEqual(row.canApprove, true);
    assert.strictEqual(row.canReject, true);
    assert.strictEqual(row.isSelf, false);
  });

  test('本人那条只留提示，不给按钮', async () => {
    // 演示申请 local_demo01 就是「自己」时，不该出现批准 / 驳回按钮。
    // 账号本身得有审核权（干事），冲突只出在「不能审自己」这一条上
    const self = { _id: 'local_demo01', role: ROLE.STAFF, status: USER_STATUS.ACTIVE };
    const view = await loadMemberReviewView({ user: self });

    const mine = view.rows.find((row) => row.applicationId === 'local_demo01');
    assert.ok(mine, '本人的申请应当仍列出来');
    assert.strictEqual(mine.isSelf, true);
    assert.strictEqual(mine.canApprove, false);
    assert.strictEqual(mine.canReject, false);
  });

  test('新提交的申请排在前面', async () => {
    const view = await loadMemberReviewView({ user: REVIEWER });
    // 演示数据里 local_demo02（9月2日）比 local_demo01（8月24日）新
    assert.deepStrictEqual(
      view.rows.map((row) => row.applicationId),
      ['local_demo02', 'local_demo01']
    );
    assert.strictEqual(view.rows[0].appliedAtText, '9月2日 20:05');
  });
});

/* ============================================================
 * 三、处理之后
 * ============================================================ */

describe('会员审核视图 —— 处理之后', () => {
  test('驳回一条之后，它从待审移到已处理', async () => {
    await facade.rejectMember('local_demo01', REVIEWER._id, '学号与姓名对不上');

    const pendingTab = await loadMemberReviewView({ user: REVIEWER });
    assert.strictEqual(pendingTab.pendingCount, 1);
    assert.strictEqual(pendingTab.handledCount, 1);
    assert.ok(!pendingTab.rows.some((row) => row.applicationId === 'local_demo01'));

    const handled = await loadMemberReviewView({ user: REVIEWER, tab: REVIEW_TAB.HANDLED });
    assert.strictEqual(handled.rows.length, 1);
    assert.strictEqual(handled.rows[0].applicationId, 'local_demo01');
    assert.strictEqual(handled.rows[0].statusLabel, '已驳回');
    assert.strictEqual(handled.rows[0].reason, '学号与姓名对不上');
    // 已经处理过的单子不再给按钮
    assert.strictEqual(handled.rows[0].canApprove, false);
  });

  test('处理完最后一条，空态有话说', async () => {
    await facade.approveMember('local_demo01', REVIEWER._id);
    await facade.approveMember('local_demo02', REVIEWER._id);

    const view = await loadMemberReviewView({ user: REVIEWER });
    assert.strictEqual(view.rows.length, 0);
    assert.strictEqual(view.pendingCount, 0);
    assert.match(view.emptyText, /没有待审核/);
  });
});

/* ============================================================
 * 四、渲染字段的基本卫生
 * ============================================================ */

describe('会员审核视图 —— 渲染字段', () => {
  test('每一行都不含 undefined / null / NaN', async () => {
    await facade.rejectMember('local_demo01', REVIEWER._id, '资料不清晰');
    const view = await loadMemberReviewView({ user: REVIEWER, tab: REVIEW_TAB.HANDLED });

    assert.ok(view.rows.length > 0);
    for (const row of view.rows) {
      for (const [key, value] of Object.entries(row)) {
        assert.notStrictEqual(value, null, `${key} 是 null`);
        assert.notStrictEqual(value, undefined, `${key} 是 undefined`);
        if (typeof value === 'string') {
          assert.ok(!/undefined|NaN/.test(value), `${key} 渲染出了「${value}」`);
        }
      }
      assert.strictEqual(typeof row.canApprove, 'boolean');
      assert.strictEqual(typeof row.canReject, 'boolean');
      assert.strictEqual(typeof row.isSelf, 'boolean');
    }
  });

  test('viewer 带出当前登录者的角色文案', async () => {
    const view = await loadMemberReviewView({ user: REVIEWER });
    assert.strictEqual(view.viewer.userId, 'u02');
    assert.strictEqual(view.viewer.loggedIn, true);
    assert.strictEqual(view.viewer.roleLabel, '干事');
  });
});

/* ============================================================
 * 五、纯筛选函数
 * ============================================================ */

test('filterApplications —— 待审与已驳回各归各的，非数组不抛错', () => {
  const list = [
    { _id: 'a', status: USER_STATUS.PENDING },
    { _id: 'b', status: USER_STATUS.DISABLED },
    { _id: 'c', status: USER_STATUS.ACTIVE },
  ];

  assert.deepStrictEqual(
    filterApplications(list, REVIEW_TAB.PENDING).map((item) => item._id),
    ['a']
  );
  assert.deepStrictEqual(
    filterApplications(list, REVIEW_TAB.HANDLED).map((item) => item._id),
    ['b']
  );
  assert.deepStrictEqual(filterApplications(null, REVIEW_TAB.PENDING), []);
});
