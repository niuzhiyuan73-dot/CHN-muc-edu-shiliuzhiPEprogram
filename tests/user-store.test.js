/**
 * 本地账号台账的单元测试
 * ============================================================
 * 这块内存里放的是「注册进来的人」和「管理员对他们的改判」。它一旦记错，
 * 后果不是页面难看，而是审批结果被抹掉——重试点两下注册就可能把一个已经
 * 转正的账号打回待审核。所以这里重点钉死三件事：
 *
 *   1. 基线稳定 —— 每条用例都从「2 条演示申请 + 0 条改判」开始。
 *   2. 定案不可逆 —— 已通过/已驳回的账号不会被后续写入覆盖。
 *   3. 副本隔离 —— 取出去的数据怎么改都污染不到台账。
 * ============================================================
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../miniprogram/services/user-store.js');
const { USER_STATUS, ROLE } = require('../miniprogram/utils/constants.js');

beforeEach(() => store.reset());

/* ============================================================
 * 一、基线
 * ============================================================ */

test('reset —— 复位到两条演示申请的基线', () => {
  const list = store.listAccounts();

  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(
    list.map((item) => item._id),
    ['local_demo01', 'local_demo02']
  );
  for (const item of list) {
    assert.strictEqual(item.status, USER_STATUS.PENDING);
    assert.strictEqual(item.role, ROLE.MEMBER);
  }
});

test('DEMO_APPLICATIONS —— 冻结，顺手改不动', () => {
  // 它们代表种子数据，被顺手改一下会让所有「基数是 2」的断言莫名飘移
  assert.ok(Object.isFrozen(store.DEMO_APPLICATIONS));
  assert.ok(store.DEMO_APPLICATIONS.every((item) => Object.isFrozen(item)));
});

/* ============================================================
 * 二、注册落库
 * ============================================================ */

test('addAccount —— 记入后能找到，且状态被收回待审核', () => {
  // 调用方就算塞进来一个 ACTIVE，也不能靠这次写入让自己转正
  const saved = store.addAccount({ _id: 'local_x', nickName: '新人', status: USER_STATUS.ACTIVE });

  assert.strictEqual(saved.status, USER_STATUS.PENDING);
  assert.strictEqual(store.listAccounts().length, 3);
  assert.strictEqual(store.findAccount('local_x').nickName, '新人');
});

test('addAccount —— 没有编号的账号被拒之门外', () => {
  assert.strictEqual(store.addAccount(null), null);
  assert.strictEqual(store.addAccount({}), null);
  assert.strictEqual(store.listAccounts().length, 2, '被拒绝的写入不该留下任何痕迹');
});

test('addAccount —— 同一个人重复提交只留一条，以最后一次为准', () => {
  store.addAccount({ _id: 'local_x', nickName: '旧名' });
  store.addAccount({ _id: 'local_x', nickName: '新名' });

  assert.strictEqual(store.listAccounts().length, 3, '重复注册不该多出一条');
  assert.strictEqual(store.findAccount('local_x').nickName, '新名');
});

test('addAccount —— 已定案的账号不会被一次重试打回待审核', () => {
  store.addAccount({ _id: 'local_x', nickName: '原' });
  store.setStatus('local_x', { status: USER_STATUS.ACTIVE, action: 'approve' });

  // 网络重试、用户手抖点两下，都会走到这里
  const again = store.addAccount({ _id: 'local_x', nickName: '想覆盖' });

  assert.strictEqual(again.status, USER_STATUS.ACTIVE);
  assert.strictEqual(store.findAccount('local_x').nickName, '原', '审批结果被覆盖了');
});

test('addAccount —— 已驳回的账号同样保持原样', () => {
  store.addAccount({ _id: 'local_x', nickName: '原' });
  store.setStatus('local_x', { status: USER_STATUS.DISABLED, action: 'reject', reason: '学号对不上' });

  store.addAccount({ _id: 'local_x', nickName: '想覆盖' });

  const found = store.findAccount('local_x');
  assert.strictEqual(found.status, USER_STATUS.DISABLED);
  assert.strictEqual(found.nickName, '原');
});

/* ============================================================
 * 三、改判
 * ============================================================ */

test('setStatus —— 多次改判叠加，后一次不丢前一次的字段', () => {
  store.setStatus('local_demo01', {
    status: USER_STATUS.DISABLED,
    action: 'reject',
    reason: '学号对不上',
  });
  store.setStatus('local_demo01', { actor: 'u02', actedAt: new Date('2026-09-03T09:00:00') });

  const patch = store.overrideOf('local_demo01');
  assert.strictEqual(patch.status, USER_STATUS.DISABLED);
  assert.strictEqual(patch.reason, '学号对不上', '前一次的字段被后一次冲掉了');
  assert.strictEqual(patch.actor, 'u02');
});

test('overrideOf —— 没改判过时返回 null，不返回空对象', () => {
  assert.strictEqual(store.overrideOf('local_demo01'), null);
  assert.strictEqual(store.overrideOf('ghost'), null);
});

test('listAccounts / findAccount —— 改判在读取时生效', () => {
  store.setStatus('local_demo01', { status: USER_STATUS.ACTIVE, action: 'approve' });

  const row = store.listAccounts().find((item) => item._id === 'local_demo01');
  assert.strictEqual(row.status, USER_STATUS.ACTIVE);
  assert.strictEqual(store.findAccount('local_demo01').status, USER_STATUS.ACTIVE);
  // 没被改判的那条原样不动
  assert.strictEqual(store.findAccount('local_demo02').status, USER_STATUS.PENDING);
});

/* ============================================================
 * 四、副本隔离
 * ============================================================ */

test('listAccounts —— 取出去的数组与对象改不动台账', () => {
  const first = store.listAccounts();
  first[0].nickName = '篡改';
  first[0].ratings.doubles.elo = 9999;
  first.push({ _id: 'local_fake' });

  const second = store.listAccounts();
  assert.strictEqual(second.length, 2, '数组被外部 push 污染了');
  assert.strictEqual(second[0].nickName, '周雨桐', '对象被外部改动了');
  assert.notStrictEqual(second[0].ratings.doubles.elo, 9999, 'ratings 是浅拷贝，共享了同一个对象');
});

test('addAccount —— 交出去的副本改了也影响不到台账', () => {
  const saved = store.addAccount({ _id: 'local_x', nickName: '新人' });
  saved.nickName = '篡改';

  assert.strictEqual(store.findAccount('local_x').nickName, '新人');
});

test('findAccount —— 查不到返回 null，空编号也不抛错', () => {
  assert.strictEqual(store.findAccount('ghost'), null);
  assert.strictEqual(store.findAccount(''), null);
  assert.strictEqual(store.findAccount(null), null);
});

/* ============================================================
 * 五、复位
 * ============================================================ */

test('reset —— 注册与改判一并清空，回到两条演示申请', () => {
  store.addAccount({ _id: 'local_x', nickName: '新人' });
  store.setStatus('local_demo01', { status: USER_STATUS.ACTIVE });

  store.reset();

  assert.strictEqual(store.listAccounts().length, 2);
  assert.strictEqual(store.overrideOf('local_demo01'), null);
  assert.strictEqual(store.findAccount('local_x'), null);
});
