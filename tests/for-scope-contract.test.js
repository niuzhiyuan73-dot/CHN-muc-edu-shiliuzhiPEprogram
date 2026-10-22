/**
 * `forScope` 的两端契约（只读审计 H4）
 * ============================================================
 * 项目有**两套**仓储实现：云端的 `attachSchoolRepository`（cloud-repo.js 与
 * 测试用的内存仓储都用它）与本地模拟端的 `createSchoolMemoryRepo`。业务代码
 * 只依赖注入的 repo，两者本该可互换。
 *
 * 但 `forScope(input)` 返回的「受范围仓储」两端并不对称：
 *   · 云端每个集合给 `list / getById / set / insert / update`（写入带范围校验，
 *     防止把别校数据写进来）；
 *   · 本地模拟端过去**只给 `list`**。
 *
 * 当前业务只用到 `list`，所以没炸；真正的风险是**契约无声分叉**——将来有人
 * 单边写 `forScope(ctx).colleges.set(...)`，云端能跑、模拟端 `set is not a
 * function`，又是「本地全绿、上线才崩」那一类。
 *
 * 这条测试把两端的「集合键集合」与「每个集合的方法名集合」钉成相等：谁想单边
 * 改，就必须同时改另一端。云端多一个 `rankings`，那是榜单快照缓存集合，
 * 模拟端根本没有它——这条差异**显式列出**（不是漏写），其余一律要求一致。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryRepo } = require('./helpers/memory-repo');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
/** 结果对象自身的属性，不属于「集合」。 */
const RESULT_LEVEL = ['scope', 'transaction'];
/** 云端独有的受范围集合。目前两端完全一致，这个清单应当保持为空。 */
const CLOUD_ONLY_KEYS = [];
/** 受范围仓储里每个集合必须提供的方法。 */
const REQUIRED_METHODS = ['getById', 'insert', 'list', 'set', 'update'];
// 带 eventId 的从属集合额外提供 listByEvent：按赛事取子集走条件查询，
// 免得整表翻页后内存过滤（2026-10-21 读放大治理）。两端必须同时有、同时无。
// 团队运动的报名 / 比赛 / 统计三个集合同在 2026-10-21 并入（P1-5）。
const EVENT_SCOPED = ['matches', 'eventSignups', 'collegeEntries', 'ties', 'lineups',
  'teamEventEntries', 'teamMatches', 'teamMatchStats'];

const collectionKeys = surface =>
  Object.keys(surface).filter(key => !RESULT_LEVEL.includes(key)).sort();
const methodNames = target =>
  Object.keys(target).filter(key => typeof target[key] === 'function').sort();

test('两端 forScope 暴露的集合键逐字一致，没有任何例外', () => {
  const cloud = collectionKeys(createMemoryRepo().forScope(SCOPE));
  const mock = collectionKeys(createSchoolMemoryRepo().forScope(SCOPE));

  assert.deepEqual(cloud.filter(key => !mock.includes(key)), CLOUD_ONLY_KEYS,
    '云端多出的受范围集合与允许清单不符——要么补上模拟端，要么写进 CLOUD_ONLY_KEYS');
  assert.deepEqual(mock.filter(key => !cloud.includes(key)), [],
    '模拟端暴露了云端没有的受范围集合');
});

test('两端 forScope 每个集合的方法面逐字相同', () => {
  const cloud = createMemoryRepo().forScope(SCOPE);
  const mock = createSchoolMemoryRepo().forScope(SCOPE);

  for (const key of Object.keys(cloud).filter(k => !RESULT_LEVEL.includes(k))) {
    if (CLOUD_ONLY_KEYS.includes(key)) continue;
    assert.deepEqual(methodNames(mock[key]), methodNames(cloud[key]),
      `${key} 的方法面对不上：业务在两套实现下会跑出不同结果`);
  }
});

test('受范围仓储的集合方法面就是约定的那一套（钉住契约，别慢慢缩水）', () => {
  const cloud = createMemoryRepo().forScope(SCOPE);
  for (const key of Object.keys(cloud).filter(k => !RESULT_LEVEL.includes(k))) {
    let expected = EVENT_SCOPED.includes(key)
      ? [...REQUIRED_METHODS, 'listByEvent']
      : REQUIRED_METHODS;
    // matches 额外一个 listSince：把「本赛季」下推成 matchTime >= 分界点，
    // 免得为了一次录分把历年台账翻一遍（2026-10-22 第二轮审查 P-2）。
    if (key === 'matches') expected = [...expected, 'listSince', 'listPage'];
    // trainingRegistrations 额外一个 listByUser：个人主页算训练积分只读这个人的
    // 几十条，不必为一个人翻完只增不减的 3000 条报名（2026-10-22 H-2）。
    if (key === 'trainingRegistrations') expected = [...expected, 'listByUser'];
    assert.deepEqual(methodNames(cloud[key]), expected.sort(),
      `${key} 的方法面变了，请同步本测试与另一端实现`);
  }
});

test('两端的结果级面相同：都有 scope，且顶层都有 transaction（事务内不给）', () => {
  const cloud = createMemoryRepo().forScope(SCOPE);
  const mock = createSchoolMemoryRepo().forScope(SCOPE);

  assert.deepEqual(mock.scope, cloud.scope, 'scope 应当原样带出，供调用方复核');
  assert.equal(typeof cloud.transaction, 'function');
  assert.equal(typeof mock.transaction, 'function');

  // 事务内再取 forScope 时两端都不给 transaction（事务里没有嵌套事务）。
  return Promise.all([
    createMemoryRepo().transaction(async tx => {
      assert.equal(tx.forScope(SCOPE).transaction, undefined);
    }),
    createSchoolMemoryRepo().transaction(async tx => {
      assert.equal(tx.forScope(SCOPE).transaction, undefined);
    }),
  ]);
});

test('受范围写入的范围校验两端一致（不能把别校数据写进来）', async () => {
  for (const repo of [createMemoryRepo(), createSchoolMemoryRepo()]) {
    const mine = repo.forScope(SCOPE);
    const other = repo.forScope({ schoolId: 'buaa', association: 'pkb' });
    await mine.colleges.insert({ _id: 'c01', name: '本院' });
    await other.colleges.insert({ _id: 'cx', name: '别校' });

    assert.deepEqual((await mine.colleges.list()).map(d => d._id), ['c01']);
    assert.equal(await mine.colleges.getById('cx'), null, '别校文档读不到');
    await assert.rejects(mine.colleges.set('cx', { name: '覆盖' }), '不能覆盖别校文档');
    await assert.rejects(mine.colleges.update('c01', { schoolId: 'buaa' }), '不能把归属改到别校');
    await assert.rejects(mine.colleges.set('c01', { _id: 'c02' }), '主键与入参不一致要拒绝');
    await mine.colleges.update('c01', { name: '改名' });
    assert.equal((await mine.colleges.getById('c01')).name, '改名');
  }
});
