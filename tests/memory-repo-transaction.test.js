/**
 * 内存仓储事务语义 —— P0 冲突串行化的回归测试
 * ============================================================
 * 云开发事务是「读已提交 + 冲突重试」：两个事务同时改同一批文档，后到的会被
 * 回滚重试，绝不会各自读到旧值再互相覆盖。测试夹具必须复刻这一点，否则
 * 「并发占用最后一个名额」这类用例会基于同一份旧快照双双提交，测出假绿。
 *
 * 这组用例把夹具的串行化钉死：谁把事务队列改回「直接 await 草稿本」，这里先红。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepo } = require('./helpers/memory-repo');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('并发事务读改写同一文档不丢更新（串行化）', async () => {
  const repo = createMemoryRepo({ seasons: [{ _id: 's1', value: 0 }] });
  const bump = () => repo.transaction(async (tx) => {
    const current = await tx.seasons.get('s1');
    await tick();
    await tx.seasons.set('s1', { ...current, value: current.value + 1 });
  });
  await Promise.all([bump(), bump()]);
  assert.equal((await repo.seasons.get('s1')).value, 2, '两次读改写都落到最终值');
});

test('事务抛错整份回滚，草稿本不落库', async () => {
  const repo = createMemoryRepo({ seasons: [{ _id: 's1', value: 1 }] });
  await assert.rejects(repo.transaction(async (tx) => {
    await tx.seasons.set('s2', { _id: 's2', value: 9 });
    await tx.seasons.set('s1', { _id: 's1', value: 100 });
    throw new Error('boom');
  }), /boom/);
  assert.equal(await repo.seasons.get('s2'), null, '新写入的文档被丢弃');
  assert.equal((await repo.seasons.get('s1')).value, 1, '既有文档回到原值');
});

test('回滚后队列继续：下一次事务读到的是最后一次成功提交的状态', async () => {
  const repo = createMemoryRepo({ seasons: [{ _id: 's1', value: 0 }] });
  await assert.rejects(repo.transaction(async (tx) => {
    await tx.seasons.set('s1', { _id: 's1', value: 5 });
    throw new Error('boom');
  }));
  await repo.transaction((tx) => tx.seasons.set('s1', { _id: 's1', value: 7 }));
  assert.equal((await repo.seasons.get('s1')).value, 7, '回滚未阻塞后续事务');
});

test('事务内禁止整表读取', async () => {
  const repo = createMemoryRepo({ users: [{ _id: 'u1' }] });
  await assert.rejects(repo.transaction((tx) => tx.users.list()), /事务内/);
});
