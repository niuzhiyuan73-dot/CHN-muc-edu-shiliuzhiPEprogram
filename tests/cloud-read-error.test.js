/**
 * 读失败的三种结局（2026-10-27 第八轮审查 P0-1）
 * ============================================================
 * 【钉什么】
 * `readDoc` 只有三种合法结局：读到文档 / **确认**不存在返回 null / 抛出。
 * 第三种曾经过宽：`errCode === -1` 或文案含 `not exist` 就当成「不存在」，
 * 而 `-1` 是云开发的通用失败码。一旦读失败被折成 null，
 * `school-repository.write()` 就会跳过归属校验、把调用方 scope 写进别人的文档。
 *
 * 【为什么这里用自造桩而不是内存仓储】
 * 内存仓储永远读得到（不存在即 undefined，不会抛），所以「读抛错」这条路径在
 * 现有用例里根本走不到。这里必须让 `doc().get()` 真的抛，才能钉住判定逻辑。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo.js');

/** 造一个会按需抛错的极简 db。calls 记录实际发生的读操作，用来断言「有没有白探测」。 */
function makeDb({ docs = {}, fail = () => null, probeFail = () => null } = {}) {
  const calls = [];
  const collection = (name) => ({
    doc: (id) => ({
      get: async () => {
        calls.push({ kind: 'get', name, id });
        const err = fail(name, id);
        if (err) throw err;
        const doc = (docs[name] || {})[id];
        if (!doc) throw Object.assign(new Error('document.get:fail document not exists'), { errCode: -1 });
        return { data: doc };
      },
      set: async () => {},
      update: async () => {},
      remove: async () => {},
    }),
    where: (cond) => ({
      count: async () => {
        calls.push({ kind: 'count', name, cond });
        const err = probeFail(name, cond);
        if (err) throw err;
        const table = docs[name] || {};
        return { total: Object.keys(table).filter((key) => key === cond._id).length };
      },
      get: async () => ({ data: [] }),
    }),
  });
  return {
    collection, command: {}, calls,
    runTransaction: async (fn) => fn({ collection }),
  };
}

const err = (message, errCode = -1) => Object.assign(new Error(message), { errCode, errMsg: message });
const school = (id) => ({ _id: id, schoolId: id, status: 'active' });

test('文案明确说文档不存在 → 返回 null，且不做多余探测', async () => {
  const db = makeDb({ docs: { schools: {} } });
  const repo = createRepo(db);

  assert.equal(await repo.schools.getById('muc'), null);
  assert.deepEqual(db.calls.map((call) => call.kind), ['get'], '确认不存在时不该多发一次 count');
});

test('errCode -1 但文档确实存在（权限/瞬时故障）→ 必须抛出，不能返回 null', async () => {
  const db = makeDb({
    docs: { schools: { muc: school('muc') } },
    fail: () => err('database permission denied'),
  });
  const repo = createRepo(db);

  await assert.rejects(repo.schools.getById('muc'), /permission denied/,
    '把读失败折成 null 会让写路径跳过归属校验（跨校覆盖）');
  assert.equal(db.calls.filter((call) => call.kind === 'count').length, 1, '无法判定时应探测一次');
});

test('errCode -1 且探测确认不存在 → 返回 null（兼容 SDK 换文案）', async () => {
  const db = makeDb({
    docs: { schools: {} },
    fail: () => err('request fail, please retry'),
  });
  const repo = createRepo(db);

  assert.equal(await repo.schools.getById('muc'), null);
  assert.equal(db.calls.filter((call) => call.kind === 'count').length, 1);
});

test('探测本身也失败 → 抛原错误，不把探测失败当成「不存在」', async () => {
  const db = makeDb({
    docs: { schools: { muc: school('muc') } },
    fail: () => err('service unavailable'),
    probeFail: () => err('count failed'),
  });
  const repo = createRepo(db);

  await assert.rejects(repo.schools.getById('muc'), /service unavailable/);
});

test('集合不存在 → 抛带集合名的中文错误，而不是 null', async () => {
  const db = makeDb({
    docs: {},
    fail: () => err('database collection not exists', -502005),
  });
  const repo = createRepo(db);

  await assert.rejects(repo.schools.getById('muc'), /数据库集合 schools 不存在/);
});

test('事务内无法探测时宁可抛错，也不猜「不存在」', async () => {
  const db = makeDb({
    docs: { schools: { muc: school('muc') } },
    fail: () => err('request fail, please retry'),
  });
  const repo = createRepo(db);

  await assert.rejects(
    () => repo.transaction(async (tx) => tx.schools.getById('muc')),
    /request fail/,
  );
  // 事务内的 where 被适配器拦下，所以不会真的发出 count
  assert.equal(db.calls.filter((call) => call.kind === 'count').length, 0);
});
