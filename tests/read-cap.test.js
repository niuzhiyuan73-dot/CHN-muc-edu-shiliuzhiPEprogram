/**
 * 整表读的硬上限（2026-10-26 第四轮审查 P-9）
 * ============================================================
 * 【要防的是什么】
 * `readAll` / `readWhere` 的循环只有「取不满一页就停」这一个终点。某个集合真的
 * 涨到几万条时，一次请求会连续翻几百页 RPC，**失败方式是云函数整体超时**，
 * 调用方只看到「服务异常，请稍后再试」——既定位不到是哪条查询，也不知道该改什么。
 *
 * 【这条用例钉什么】
 * 越过 `MAX_READ_ROWS` 必须**抛错**，而且错误里要点名集合与「改用带条件的读法」。
 * 只断言「抛了错」不够：文案是给下一位接手的人看的，必须能直接指向修法。
 *
 * 【为什么用环境变量把上限压到 50】
 * 真实上限是 10000 条，造那么多文档既慢又没意义。常量在模块加载时读环境变量，
 * 所以必须在 require 之前设——测试运行器按文件起独立进程（见 tools/run-tests.js
 * 的 `spawn`），这个 env 不会漏给别的用例。
 * ============================================================
 */

process.env.MAX_READ_ROWS = '50';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRepo } = require('../cloudfunctions/data/src/adapters/cloud-repo.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/**
 * 极简 db 替身：只实现 readAll / readWhere 用到的 where / orderBy / limit / get。
 *
 * `command.gt` 用来表达游标条件（`_id > 上一页末条`），替身里解成同一个语义，
 * 否则第二次翻页会从头再来、循环永不结束。
 */
function fakeDb(docs) {
  const collection = () => {
    const state = { where: null, limit: 100 };
    const query = {
      where(cond) { state.where = cond; return query; },
      orderBy() { return query; },
      limit(n) { state.limit = n; return query; },
      async get() {
        const cursor = state.where && state.where._id && state.where._id.$gt;
        const rows = docs
          .filter((doc) => !cursor || String(doc._id) > String(cursor))
          .filter((doc) => !state.where || !state.where.status || doc.status === state.where.status)
          .sort((a, b) => (String(a._id) < String(b._id) ? -1 : 1))
          .slice(0, state.limit);
        return { data: rows };
      },
    };
    return query;
  };
  return { collection, command: { gt: (value) => ({ $gt: value }) } };
}

const match = (id) => ({
  _id: id, schoolId: SCOPE.schoolId, association: SCOPE.association,
  teamA: ['a'], teamB: ['b'], status: 1, matchTime: '2026-10-01T00:00:00.000Z',
});

test('整表读越过上限时抛错，并在文案里点名集合与改法', async () => {
  const docs = Array.from({ length: 60 }, (_, i) => match(`m${String(i).padStart(3, '0')}`));
  const repo = createRepo(fakeDb(docs));

  await assert.rejects(
    repo.forScope(SCOPE).matches.list(),
    (err) => {
      assert.match(err.message, /matches/, '要说是哪个集合读超了');
      assert.match(err.message, /50 条上限/, '要写明上限值，方便判断是数据涨了还是查询写错了');
      assert.match(err.message, /listByEvent|listByUser|listByStatus|listPage|listTop/,
        '要给出可下推的替代方法，否则接手的人还得自己翻仓储接口');
      return true;
    },
  );
});

test('上限之内的整表读照常返回，不误伤小集合', async () => {
  const docs = Array.from({ length: 10 }, (_, i) => match(`m${String(i).padStart(3, '0')}`));
  const repo = createRepo(fakeDb(docs));

  const rows = await repo.forScope(SCOPE).matches.list();
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((row) => row._id), docs.map((row) => row._id));
});
