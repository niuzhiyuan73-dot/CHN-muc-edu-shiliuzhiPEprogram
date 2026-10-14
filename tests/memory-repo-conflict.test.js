/**
 * 内存仓储的事务语义（迁移清单 M0-4 / 协会空间规划 §9.2）
 *
 * 真云开发的事务是「读已提交 + 冲突重试」：两个事务改到同一批文档时，后到的
 * 会被回滚重跑，绝不丢更新。内存仓储用「队列串行化 + 写版本冲突检测」来模拟：
 *   · 并发事务排队执行（结果与真库的串行提交一致）；
 *   · 事务写过的集合若被外部（非事务）写入抢先改过，草稿本整份丢弃、重跑。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepo } = require('./helpers/memory-repo.js');

describe('内存仓储 —— 冲突检测与重跑', () => {
  test('外部写入抢先改了同一集合 → 丢弃草稿本并重跑，基于最新值', async () => {
    const repo = createMemoryRepo({ users: [{ _id: 'u1', points: 0 }] });
    let injected = false;
    let runs = 0;

    const result = await repo.transaction(async (tx) => {
      runs += 1;
      const u = await tx.users.getById('u1');
      if (!injected) {
        injected = true;
        // 事务跑到一半，外部（非事务）写入改了同一集合，使草稿本过期
        await repo.users.set('u1', { _id: 'u1', points: 99 });
      }
      await tx.users.set('u1', { _id: 'u1', points: (u.points || 0) + 1 });
      return (u.points || 0) + 1;
    });

    assert.strictEqual(runs, 2, '应重跑了一次');
    assert.strictEqual(result, 100, '重跑后读到外部写入的 99，再加 1');
    assert.strictEqual((await repo.users.getById('u1')).points, 100);
  });

  test('写不同集合不构成冲突，不重跑', async () => {
    const repo = createMemoryRepo({ users: [{ _id: 'u1', name: 'a' }], matches: [{ _id: 'm1' }] });
    let injected = false;
    let runs = 0;

    const result = await repo.transaction(async (tx) => {
      runs += 1;
      const u = await tx.users.getById('u1');
      if (!injected) {
        injected = true;
        await repo.matches.update('m1', { status: 'draft' }); // 只碰了别的集合
      }
      await tx.users.set('u1', { ...u, tag: 'ok' });
      return 'done';
    });

    assert.strictEqual(result, 'done');
    assert.strictEqual(runs, 1, '外部只写了别的集合，不应触发重跑');
  });

  test('冲突持续存在时，重试次数耗尽会报错，不静默丢写', async () => {
    const repo = createMemoryRepo({ users: [{ _id: 'u1', points: 0 }] });
    await assert.rejects(() => repo.transaction(async (tx) => {
      await tx.users.getById('u1');
      await repo.users.set('u1', { _id: 'u1', points: Date.now() }); // 每次都抢先写
      await tx.users.set('u1', { _id: 'u1', points: 1 });
    }), /冲突重试次数耗尽/);
  });
});

describe('内存仓储 —— 并发串行化不丢更新', () => {
  test('三个并发事务各 +1，最终为 3', async () => {
    const repo = createMemoryRepo({ users: [{ _id: 'u1', points: 0 }] });
    const inc = () => repo.transaction(async (tx) => {
      const u = await tx.users.getById('u1');
      await new Promise((resolve) => setTimeout(resolve, 1));
      await tx.users.set('u1', { _id: 'u1', points: (u.points || 0) + 1 });
    });

    await Promise.all([inc(), inc(), inc()]);
    assert.strictEqual((await repo.users.getById('u1')).points, 3);
  });
});
