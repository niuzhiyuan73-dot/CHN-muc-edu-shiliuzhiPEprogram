/**
 * 顶层 list() 的使用边界（2026-10-27 第八轮审查 P1-3）
 * ============================================================
 * 【问题】
 * `attachSchoolRepository` 给每个集合都补了 `list: () => io.query(key, {})`——
 * 条件对象为空，云端等于「把这个集合的所有学校的行都读回来」。它存在是为满足
 * 「两套仓储方法面一致」的契约（模拟仓储顶层 list 也是全量），本身没错；
 * 错的是业务代码顺手写成 `ctx.repo.schoolMembers.list()`：一次请求就是一次
 * 跨校全表读，读配额与内存同时爆，而且结果里带着别校的数据。
 *
 * 历史上确实发生过（`exchange-service.js` 里留着一句「原先是
 * ctx.repo.schoolMembers.list()」的注释），只是当时靠人工审查才发现。
 *
 * 【为什么用静态扫描而不是运行时抛错】
 * 契约测试把顶层 list 当作合法形态钉着，模拟端也这么实现；运行时禁掉会让两端
 * 分叉（本地绿、云端红）。静态扫描守的是「业务层不要这么写」，与
 * `subpackage-boundaries` / `miniprogram-runtime-safety` 同一路数：零运行时成本，
 * 新代码写错当场变红。
 *
 * 【白名单为什么只有这三个】
 * 学校 / 协会 / 学院目录是平台级或学校级的小集合，且本来就该跨校枚举
 * （选校页、注册页）。其余集合一律必须带范围。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICES_DIR = path.join(__dirname, '..', 'miniprogram', 'services');

/** 允许顶层无范围读取的集合：平台级 / 学校级小目录。 */
const ALLOWED = new Set(['schools', 'schoolAssociations', 'colleges']);

/** 只认代码行，跳过注释（注释里会引用旧写法的历史说明）。 */
function codeLines(source) {
  return source.split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

const TOP_LEVEL_LIST = /ctx\.repo\.([A-Za-z0-9_]+)\.list\(\s*\)/g;

test('业务服务不得用顶层 list() 做跨范围整表读', () => {
  const offenders = [];
  for (const name of fs.readdirSync(SERVICES_DIR)) {
    if (!name.endsWith('.js')) continue;
    // school-memory-repo 是仓储实现本身，顶层 list 是它的契约职责，不在此列。
    if (name === 'school-memory-repo.js') continue;
    const source = fs.readFileSync(path.join(SERVICES_DIR, name), 'utf8');
    for (const { line, number } of codeLines(source)) {
      TOP_LEVEL_LIST.lastIndex = 0;
      let hit;
      while ((hit = TOP_LEVEL_LIST.exec(line)) !== null) {
        if (ALLOWED.has(hit[1])) continue;
        offenders.push(`${name}:${number} → ctx.repo.${hit[1]}.list()`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    '顶层 list() 的条件是空对象，云端会把全平台该集合读回来。\n'
    + '请改用 ctx.repo.forScope(ctx).<集合>.list()（带 schoolId + association），'
    + '或给仓储加一个带条件的原语（listByEvent / listByStatus / listByUser …）。');
});

test('forScope 上的 list() 不受影响（带范围的整表读是允许的）', () => {
  // 反向验证：这条正则不该把 `forScope(ctx).x.list()` 也算进来，否则规则会误伤。
  const sample = 'const rows = await ctx.repo.forScope(ctx).schoolMembers.list();';
  TOP_LEVEL_LIST.lastIndex = 0;
  assert.equal(TOP_LEVEL_LIST.exec(sample), null);
});
