/**
 * 镜像里的服务与门面的关系（只读审计 H9）
 * ============================================================
 * 背景：`miniprogram/services/auth.js` 的 `login()` 在**函数体内** require
 * `'./index.js'`——这是为规避 `mock → auth → index → mock` 循环依赖的有意设计
 * （注释见 auth.js:240-247）。而 `index.js` 不在 `tools/sync-cloud-lib.js` 的
 * MANIFEST 里，镜像之后云端根本没有这个文件，一旦云端真的调到 `login()` 就是
 * 「找不到模块」。
 *
 * 这条约束此前只写在同步脚本的注释里（「云函数不要调用 login()」），靠人记得。
 * 本测试把能验证的部分钉住。**注意不能简单断言「没有任何文件 require
 * './index.js'」**——auth.js 那一处是有意为之，一刀切会直接变红，那是把测试写成
 * 了谎话。真正可验证、且真正危险的是下面三条：
 *
 *   ① **模块顶层**不许 require 门面——那会让云端连加载都失败（本测试的重点）；
 *   ② 懒加载 require 门面的文件必须恰好是清单里的那一个（新增即失败，评审可见）；
 *   ③ 门面本身不在 MANIFEST、也不在镜像里（否则 ① 的前提就不成立）。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MANIFEST, DEST_ROOT } = require('../tools/sync-cloud-lib');
const LIB_SERVICES = path.join(DEST_ROOT, 'services');
const LIB_UTILS = path.join(DEST_ROOT, 'utils');

/**
 * 允许「懒加载 require 门面」的文件清单（相对 lib/）。
 *
 * 【为什么 auth.js 在清单里】
 * `login()` 的 require 必须留在函数体内（循环依赖），而 login() 只有小程序端会
 * 用——云端按 OpenID 取用户，调不到它。这里把「有意为之」与「不小心引入」分开：
 * 前者登记在案，后者一律失败。
 */
const LAZY_FACADE_REQUIRE_ALLOWED = ['services/auth.js'];

/** 递归列出目录下的 .js 文件。 */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 找出门面 require：返回 [{ target, line, topLevel }]。 */
function facadeRequires(file) {
  const found = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!/(^|\/)index(\.js)?$/.test(match[1])) continue;
      // 顶层 require 顶格写（本项目所有文件都是这个风格）；缩进即「在函数体里」。
      found.push({ target: match[1], line: index + 1, topLevel: line === line.trimStart() });
    }
  });
  return found;
}

const MIRRORED = [...jsFiles(LIB_SERVICES), ...jsFiles(LIB_UTILS)];

test('镜像里没有任何文件在模块顶层 require 门面（加载期安全）', () => {
  const offenders = [];
  for (const file of MIRRORED) {
    for (const hit of facadeRequires(file)) {
      if (hit.topLevel) offenders.push(`${path.relative(DEST_ROOT, file)}:${hit.line} → ${hit.target}`);
    }
  }
  assert.deepEqual(offenders, [],
    `顶层 require 门面会让云端加载即失败：\n  ${offenders.join('\n  ')}`);
});

test('懒加载 require 门面的文件恰好是登记在案的那一个', () => {
  const found = [];
  for (const file of MIRRORED) {
    const hits = facadeRequires(file).filter(hit => !hit.topLevel);
    if (hits.length === 0) continue;
    found.push({ rel: path.relative(DEST_ROOT, file).replace(/\\/g, '/'), hits });
  }
  assert.deepEqual(found.map(item => item.rel), LAZY_FACADE_REQUIRE_ALLOWED,
    '懒加载 require 门面的文件清单变了——新增的请先确认它真的只在云端调不到的分支里');
  assert.equal(found[0].hits.length, 1, 'auth.js 里应当只有 login() 这一处懒加载');
});

test('门面 index.js 本身不在 MANIFEST、也不在镜像里', () => {
  assert.equal(MANIFEST.includes('services/index.js'), false,
    'index.js 若进了镜像，说明有人改了同步清单，请一并复核本测试的前提');
  assert.equal(fs.existsSync(path.join(DEST_ROOT, 'services', 'index.js')), false,
    '镜像目录里出现了 index.js，云端将拿到一个依赖本地 mock 的门面');
});

test('扫描逻辑本身有效：MANIFEST 里的纯模块确实都镜像到了', () => {
  const missing = MANIFEST.filter(rel => !fs.existsSync(path.join(DEST_ROOT, rel)));
  assert.deepEqual(missing, [], `这些清单文件没同步：${missing.join('、')}`);
  assert.ok(jsFiles(LIB_SERVICES).length >= 30, '镜像 services 数量异常，扫描目录可能写错了');
});
