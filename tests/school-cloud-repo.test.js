const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo');
const { COLLECTIONS } = require('../cloudfunctions/data/src/repository');

/**
 * `db.command` 的最小替身。
 * 仓储的分页 2026-10-21 起从 `skip(offset)` 改为游标（`_id > 上一页末条`），
 * 批读用 `_.in`。这个桩必须认这两种操作符，否则拿到的 where 会被当成
 * 「等于某个对象」，查询恒空。
 */
const CMD = Symbol('db.command');
const command = {
  gt: (value) => ({ [CMD]: 'gt', value }),
  gte: (value) => ({ [CMD]: 'gte', value }),
  in: (value) => ({ [CMD]: 'in', value }),
  and: (value) => ({ [CMD]: 'and', value }),
};
const isCmd = (value) => Boolean(value && value[CMD]);
function matchDoc(doc, where) {
  if (!where) return true;
  if (isCmd(where)) return where[CMD] === 'and' ? where.value.every((part) => matchDoc(doc, part)) : false;
  return Object.entries(where).every(([field, cond]) => {
    if (!isCmd(cond)) return doc[field] === cond;
    if (cond[CMD] === 'and') return cond.value.every((part) => matchDoc(doc, part));
    if (cond[CMD] === 'in') return Array.isArray(cond.value) && cond.value.includes(doc[field]);
    if (cond[CMD] === 'gt') return String(doc[field] ?? '') > String(cond.value ?? '');
    if (cond[CMD] === 'gte') return String(doc[field] ?? '') >= String(cond.value ?? '');
    return false;
  });
}

/** SDK contract stub: validates query construction and pagination, not real cloud locking. */
function database(seed = {}) {
  const state = Object.fromEntries(Object.values(COLLECTIONS).map(name => [name, new Map()]));
  for (const [name, docs] of Object.entries(seed)) for (const doc of docs) state[name].set(doc._id, { ...doc });
  const queries = [];
  function surface(store) {
    return {
      collection(name) {
        const table = store[name];
        if (!table) throw new Error(`unknown collection ${name}`);
        const query = (where = {}, offset = 0, limit = 100) => ({
          where: (next) => query(next, offset, limit),
          orderBy: (field, order) => { assert.equal(field, '_id'); assert.equal(order, 'asc'); return query(where, offset, limit); },
          skip: (next) => query(where, next, limit),
          limit: (next) => query(where, offset, next),
          get: async () => {
            queries.push({ name, where, offset, limit });
            const data = [...table.values()].filter(doc => matchDoc(doc, where))
              .sort((a, b) => a._id.localeCompare(b._id)).slice(offset, offset + limit);
            return { data };
          },
        });
        return {
          ...query(),
          doc: id => ({
            get: async () => ({ data: table.get(id) || null }),
            set: async ({ data }) => { assert.equal(data._id, undefined); table.set(id, { ...data, _id: id }); },
          }),
        };
      },
    };
  }
  return {
    ...surface(state), queries, command,
    runTransaction: async fn => {
      const scratch = Object.fromEntries(Object.entries(state).map(([name, rows]) => [name, new Map(rows)]));
      const result = await fn(surface(scratch));
      for (const [name, rows] of Object.entries(scratch)) {
        state[name].clear();
        for (const [id, doc] of rows) state[name].set(id, doc);
      }
      return result;
    },
  };
}

test('cloud queries filter school and project in the database and read all 205 scoped records', async () => {
  const matches = Array.from({ length: 205 }, (_, i) => ({ _id: `m${String(i).padStart(4, '0')}`, schoolId: 'muc', association: 'pkb' }));
  matches.push({ _id: 'other-school', schoolId: 'buaa', association: 'pkb' });
  matches.push({ _id: 'other-sport', schoolId: 'muc', association: 'tt' });
  matches.push({ _id: 'legacy-no-school', association: 'pkb' });
  const db = database({ matches });
  const repo = createRepo(db);
  const rows = await repo.forScope({ schoolId: 'muc', association: 'pkb' }).matches.list();
  assert.equal(rows.length, 205);
  assert.equal(new Set(rows.map(row => row._id)).size, 205);
  // 游标分页：205 条 = 3 次查询，首页不带游标，后两页各带「上一页末条的 _id」。
  // 旧断言是 offset [0,100,200]（skip 语义）；改成游标后偏移恒为 0，这里改成
  // 钉住游标值本身——它才是「不会漏读/重读」的保证（2026-10-21 审查 P1-4）。
  assert.equal(db.queries.length, 3);
  assert.equal(db.queries[0].where._id, undefined, '首页不带 _id 游标');
  assert.equal(db.queries[1].where._id.value, 'm0099', '第二页从上一页末条之后开始');
  assert.equal(db.queries[2].where._id.value, 'm0199', '第三页同理');
  assert.ok(db.queries.every(q => q.where.schoolId === 'muc' && q.where.association === 'pkb'));
});

test('cloud school identity query uses school without artificially filtering by project', async () => {
  const db = database({ school_members: [
    { _id: 'a', schoolId: 'muc' }, { _id: 'b', schoolId: 'buaa' },
  ] });
  const repo = createRepo(db).forScope({ schoolId: 'muc', association: 'tt' });
  assert.deepEqual((await repo.schoolMembers.list()).map(r => r._id), ['a']);
  assert.deepEqual(db.queries[0].where, { schoolId: 'muc' });
});

test('cloud scoped write checks existing ownership inside transaction and rollback preserves data', async () => {
  const db = database({ events: [{ _id: 'b', schoolId: 'buaa', association: 'pkb', value: 7 }] });
  const raw = createRepo(db);
  const a = raw.forScope({ schoolId: 'muc', association: 'pkb' });
  await assert.rejects(a.events.set('b', { value: 9 }));
  assert.equal((await raw.events.getById('b')).value, 7);
  await a.events.insert({ _id: 'a', value: 1 });
  assert.equal((await a.events.getById('a')).schoolId, 'muc');
  await assert.rejects(a.transaction(async tx => {
    await tx.events.update('a', { value: 2 });
    throw new Error('injected failure');
  }), /injected/);
  assert.equal((await a.events.getById('a')).value, 1);
  await assert.rejects(a.transaction(tx => tx.events.list()), /事务内/);
});
