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
          // 聚合计数（schoolMembers.countByStatus 用）：云端是数据库侧统计，
          // 不读文档；桩里按同一 where 数一遍即可。
          count: async () => {
            queries.push({ name, where, aggregate: 'count' });
            return { total: [...table.values()].filter(doc => matchDoc(doc, where)).length };
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

test('名册按状态分页并在数据库侧计数，游标只读本校名册', async () => {
  const db = database({ school_members: [
    { _id: 'sm:muc:u1', schoolId: 'muc', association: 'pkb', userId: 'u1', status: 'active', studentId: 'S1' },
    { _id: 'sm:muc:u2', schoolId: 'muc', association: 'pkb', userId: 'u2', status: 'active', studentId: 'S2' },
    { _id: 'sm:muc:u3', schoolId: 'muc', association: 'pkb', userId: 'u3', status: 'active', studentId: 'S3' },
    { _id: 'sm:muc:p1', schoolId: 'muc', association: 'pkb', userId: 'p1', status: 'pending', studentId: 'S4' },
    // 同一学号在别校存在：判重只能看本校
    { _id: 'sm:buaa:u9', schoolId: 'buaa', association: 'pkb', userId: 'u9', status: 'active', studentId: 'S1' },
  ] });
  const scoped = createRepo(db).forScope({ schoolId: 'muc', association: 'pkb' });

  const first = await scoped.schoolMembers.listByStatus('active', { limit: 2 });
  assert.deepEqual(first.rows.map(row => row.userId), ['u1', 'u2']);
  assert.equal(first.hasMore, true, '多取一条判还有下一页');

  const next = await scoped.schoolMembers.listByStatus('active', { limit: 2, afterId: 'sm:muc:u2' });
  assert.deepEqual(next.rows.map(row => row.userId), ['u3'], '游标之后接着取，不重复不跳过');
  assert.equal(next.hasMore, false);

  assert.equal(await scoped.schoolMembers.countByStatus('active'), 3, '别校同名行不计入');
  assert.deepEqual((await scoped.schoolMembers.listByStatus('pending')).rows.map(row => row.userId), ['p1'],
    '待审只按状态取，不再整校读回内存过滤');
  assert.deepEqual((await scoped.schoolMembers.listByStudentId('S1')).map(row => row._id), ['sm:muc:u1'],
    '学号判重只回本校那一条');
  // 每条查询都带范围条件：游标不能把归属校验挤掉
  assert.ok(db.queries.every(q => q.where.schoolId === 'muc'));
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
