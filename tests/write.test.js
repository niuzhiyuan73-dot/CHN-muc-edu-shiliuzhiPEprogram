/**
 * 写操作错误约定 单元测试
 *
 * 要守住的两件事：
 *   1. guardWrite 把「抛错」收敛成与 mock 同形的业务失败，成功则原样透传；
 *   2. 名单与真实接口对得上——少列一个写接口，那一页就会在云端故障时卡死。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { WRITE_ACTIONS, FALLBACK_MESSAGE, isWriteAction, guardWrite } = require('../miniprogram/utils/write.js');
const facade = require('../miniprogram/services/index.js');
const mock = require('../miniprogram/services/mock.js');
const cloud = require('../miniprogram/services/cloud.js');

describe('guardWrite —— 把异常收敛成业务失败', () => {
  test('抛出带 message 的异常时，转成统一的失败形状', async () => {
    const result = await guardWrite(() => {
      throw new Error('账号已被停用，请联系管理员');
    });

    assert.equal(result.ok, false);
    assert.equal(result.message, '账号已被停用，请联系管理员');
    assert.equal(result.firstError, '账号已被停用，请联系管理员');
    assert.deepEqual(result.errors, {});
    assert.deepEqual(result.scoreErrors, []);
  });

  test('异步拒绝同样被接住', async () => {
    const result = await guardWrite(async () => {
      throw new Error('云开发尚未初始化');
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /云开发尚未初始化/);
  });

  test('异常没有 message 时给兜底文案', async () => {
    const result = await guardWrite(() => {
      throw new Error('');
    });
    assert.equal(result.ok, false);
    assert.equal(result.message, FALLBACK_MESSAGE);
  });

  test('成功时原样透传，不做任何包装', async () => {
    const payload = { ok: true, record: { _id: 'le0001' }, message: '' };
    const result = await guardWrite(async () => payload);
    assert.equal(result, payload, '成功结果应当就是实现返回的那个对象');
  });

  test('实现返回的业务失败也原样透传（不重复包装）', async () => {
    const payload = { ok: false, message: '找不到这场比赛', errors: {} };
    const result = await guardWrite(async () => payload);
    assert.equal(result, payload);
  });
});

describe('写接口名单 —— 与两个实现对齐', () => {
  test('名单里的名字在 mock 与 cloud 都是函数', () => {
    for (const name of WRITE_ACTIONS) {
      assert.equal(typeof mock[name], 'function', `mock 缺少写接口 ${name}`);
      assert.equal(typeof cloud[name], 'function', `cloud 缺少写接口 ${name}`);
    }
  });

  test('名单没有重复项', () => {
    assert.equal(new Set(WRITE_ACTIONS).size, WRITE_ACTIONS.length);
  });

  test('isWriteAction 只认写接口，读接口一律放行', () => {
    assert.equal(isWriteAction('submitMatch'), true);
    assert.equal(isWriteAction('publishCollegeEvent'), true);
    for (const read of [
      'getMembers',
      'getMatches',
      'getLeaderboard',
      'getMatchRecords',
      'getCollegeTies',
      'getSeasonState',
    ]) {
      assert.equal(isWriteAction(read), false, `${read} 是读接口，不该套写守卫`);
    }
  });

  test('两个实现的接口差集里不含写接口', () => {
    // load / resetCache 是 mock 专有，request 是 cloud 专有；写接口必须两边都有
    const mockOnly = ['load', 'resetCache'];
    const cloudOnly = ['request'];
    for (const name of WRITE_ACTIONS) {
      assert.ok(!mockOnly.includes(name) && !cloudOnly.includes(name), `${name} 不该是工具函数`);
    }
  });
});

describe('门面 —— 写接口抛错不再冒泡到页面', () => {
  function withSource(name, fn) {
    return async () => {
      const original = facade.getDataSource();
      facade.setDataSource(name);
      try {
        await fn();
      } finally {
        facade.setDataSource(original);
      }
    };
  }

  test(
    'cloud 下写接口抛错被收敛成 {ok:false}，而不是拒绝',
    withSource('cloud', async () => {
      const result = await facade.publishEvent({ title: 'x' }, 'u01');
      assert.equal(result.ok, false, '写接口不该把异常抛给页面');
      assert.match(result.message, /云开发尚未初始化/);
      assert.equal(result.firstError, result.message);
      assert.deepEqual(result.errors, {});
      assert.deepEqual(result.scoreErrors, []);
    })
  );

  test(
    'cloud 下读接口仍然抛错（故障不能被伪装成空数据）',
    withSource('cloud', async () => {
      await assert.rejects(() => facade.getMembers(), /云开发尚未初始化/);
    })
  );

  test(
    'mock 下写接口业务失败原样返回，守卫不改变成功路径',
    withSource('mock', async () => {
      const result = await facade.confirmMatch('nope', 'u01');
      assert.equal(result.ok, false);
      assert.match(result.message, /找不到/);
    })
  );
});
