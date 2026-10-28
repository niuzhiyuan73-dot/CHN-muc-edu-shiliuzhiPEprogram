const test = require('node:test');
const assert = require('node:assert/strict');
const { readMemberPage } = require('../cloudfunctions/data/src/adapters/member-page');
const { memoryDirectoryPage, accountDirectoryFields } = require('../miniprogram/services/account-directory');
const scope = { schoolId: 'muc', association: 'pkb' };
const valueAt = (row, field) => field.split('.').reduce((value, key) => value == null ? undefined : value[key], row);

/** Evaluates the SDK stages independently of the application directory search implementation. */
function directoryDatabase(tables) {
  const traces = [], returned = [];
  const expression = (value, row) => {
    if (typeof value === 'string' && value.startsWith('$')) return valueAt(row, value.slice(1));
    if (Array.isArray(value)) return value.map(item => expression(item, row));
    if (!value || typeof value !== 'object') return value;
    if (value.literal !== undefined) return value.literal;
    if (value.op === 'cond') return expression(value.args.if, row) ? expression(value.args.then, row) : expression(value.args.else, row);
    const args = value.args && expression(value.args, row);
    switch (value.op) {
      case 'ifNull': return args[0] == null ? args[1] : args[0];
      case 'indexOfCP': return args[0].indexOf(args[1]);
      case 'eq': return args[0] === args[1];
      case 'neq': return args[0] !== args[1];
      case 'and': return args.every(Boolean);
      case 'or': return args.some(Boolean);
      default: throw new Error(`unsupported expression: ${JSON.stringify(value)}`);
    }
  };
  const matches = (row, query) => Object.entries(query).every(([field, cond]) => {
    if (field === '$or') return cond.some(item => matches(row, item));
    const value = valueAt(row, field);
    if (!cond || typeof cond !== 'object') return value === cond;
    return Object.entries(cond).every(([op, expected]) => {
      if (op === '$gt') return value > expected;
      if (op === '$gte') return value >= expected;
      if (op === '$ne') return value !== expected;
      if (op === '$exists') return (value !== undefined) === expected;
      throw new Error(`unsupported query operator: ${op}`);
    });
  });
  const command = { aggregate: Object.fromEntries(['ifNull','indexOfCP','eq','neq','and','or','cond'].map(op => [op, args => ({ op, args })])) };
  command.aggregate.literal = literal => ({ literal });
  const db = { traces, returned, command, collection: name => ({ aggregate: () => {
    const stages = [];
    const api = Object.fromEntries(['match','lookup','unwind','project','addFields','sort','limit'].map(kind => [kind, spec => {
      stages.push([kind, spec]); return api;
    }]));
    api.end = async () => {
      traces.push(stages);
      let rows = tables[name].map(row => ({ ...row }));
      for (const [kind, spec] of stages) {
        if (kind === 'match') rows = rows.filter(row => matches(row, spec));
        if (kind === 'lookup') rows = rows.map(row => ({ ...row,
          [spec.as]: tables[spec.from].filter(other => valueAt(row, spec.localField) === valueAt(other, spec.foreignField)) }));
        if (kind === 'unwind') rows = rows.flatMap(row => valueAt(row, spec.slice(1)).map(value => ({ ...row, [spec.slice(1)]: value })));
        if (kind === 'project') rows = rows.map(row => Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== 0)
          .map(([key, value]) => [key, value === 1 ? row[key] : expression(value, row)])));
        if (kind === 'addFields') rows = rows.map(row => ({ ...row, ...Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, expression(value, row)])) }));
        if (kind === 'sort') rows.sort((a, b) => {
          for (const [field, direction] of Object.entries(spec)) {
            if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * direction;
          }
          return 0;
        });
        if (kind === 'limit') rows = rows.slice(0, spec);
      }
      returned.push(rows.length);
      return { list: rows };
    };
    return api;
  } }) };
  return db;
}

function fixture(names) {
  const tables = { users: [], school_members: [] };
  names.forEach((name, i) => {
    const user = { _id: `u${String(i).padStart(4,'0')}`, nickName: name, realName: i % 2 ? '小张' : '张甲',
      openId: `private-${i}`, platformStatus: 'active', primarySchoolId: 'muc', avatarUrl: '' };
    tables.users.push({ ...user, ...accountDirectoryFields(user) });
    tables.school_members.push({ _id: `m${i}`, userId: user._id, schoolId: 'muc', status: 'active', collegeId: 'c01', studentId: 'PRIVATE' });
  });
  return tables;
}

test('学院选人分页：学院条件在联表前下推，双端结果一致且不带学号', async () => {
  const tables = fixture(['甲', '乙', '丙', '丁']);
  tables.school_members[0].collegeId = 'c02'; tables.school_members[2].collegeId = 'c02';
  const query = { collegeId: 'c02', limit: 1 };
  const db = directoryDatabase(tables);
  const first = await readMemberPage(db, db.command, scope, query);
  assert.deepEqual(first, memoryDirectoryPage(tables.school_members, tables.users, scope, query));
  assert.deepEqual(db.traces[0][0], ['match', { schoolId: 'muc', status: 'active', collegeId: 'c02' }]);
  assert.equal(first.members.length, 1); assert.equal(first.hasMore, true);
  const next = await readMemberPage(db, db.command, scope, { ...query, cursor: first.nextCursor });
  assert.notEqual(first.members[0].userId, next.members[0].userId);
  assert.ok([...first.members, ...next.members].every(row => row.collegeId === 'c02' && !('studentId' in row)));
});

test('云端目录查询与原搜索一致：NFKC、前缀优先、同名、特殊字符、UTF-16 排序及跨页', async () => {
  const tables = fixture(['小张', '张甲', 'ＡＢＣ', 'abc', 'xABC', '张甲', '😀', '\ue000', '$x', '.*']);
  for (const keyword of ['', '张', 'abc', '$x', '.*', '不存在']) {
    const db = directoryDatabase(tables);
    let cursor = '';
    const actual = [];
    for (let i = 0; i < 20; i++) {
      const result = await readMemberPage(db, db.command, scope, { keyword, cursor, limit: 2 });
      const expectedPage = memoryDirectoryPage(tables.school_members, tables.users, scope, { keyword, cursor, limit: 2 });
      assert.deepEqual(result, expectedPage, keyword);
      actual.push(...result.members);
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    const expected = memoryDirectoryPage(tables.school_members, tables.users, scope, { keyword, limit: 100 }).members;
    assert.deepEqual(actual, expected);
  }
});

test('2000 人目录只返回页大小加一，学校与状态筛选、投影均在数据库完成', async () => {
  const tables = fixture(Array.from({ length: 2000 }, (_, i) => `成员${i}`));
  tables.users[0].platformStatus = 'disabled';
  tables.users[1].primarySchoolId = 'other';
  tables.school_members[2].schoolId = 'other';
  tables.school_members[3].status = 'left';
  const db = directoryDatabase(tables);
  const result = await readMemberPage(db, db.command, scope, { limit: 20 });
  assert.equal(result.members.length, 20); assert.equal(result.hasMore, true);
  assert.deepEqual(db.returned, [21]);
  assert.equal(result.members.some(row => ['u0000','u0001','u0002','u0003'].includes(row.userId)), false);
  assert.equal(result.members.some(row => 'openId' in row || 'studentId' in row || 'searchNick' in row), false);
  assert.deepEqual(db.traces[0][0], ['match', { schoolId: 'muc', status: 'active' }]);
});

test('历史搜索字段缺失明确拒绝，不能返回看似成功的缺人名单', async () => {
  const tables = fixture(['测试']); delete tables.users[0].directoryVersion;
  const db = directoryDatabase(tables);
  await assert.rejects(readMemberPage(db, db.command, scope, { limit: 20 }), /回填/);
});
