/**
 * 分包边界
 * ============================================================
 * 小程序的引用规则只有一条，但方向不对称：
 *
 *   主包 → 主包       ✅
 *   分包 → 主包       ✅（分包可以使用主包资源）
 *   主包 → 分包       ❌
 *   分包A → 分包B     ❌
 *
 * 违反时编译器才报错，而且错误信息指的是「文件找不到」——看起来像路径写错，
 * 实际是方向错了。2026-10-20 分包化就踩了一次：
 * `components/team-profile-panel.wxss`（主包）@import 了
 * `packageTeam/my-team-profile/my-team-profile.wxss`（分包），
 * 模拟器报「wxss 文件编译错误：path '../../packageTeam/...' not found」。
 *
 * 单元测试天然看不见这类问题（Node 里 require 一切正常），所以单开一组，
 * 把四种引用形式全查一遍：
 *   · WXSS  @import
 *   · WXML  <import src> / <include src> / <wxs src>
 *   · JSON  usingComponents
 *   · JS    require()
 * ============================================================
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MINI = path.join(__dirname, '..', 'miniprogram');
const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));
const PACKAGE_ROOTS = new Set((app.subPackages || []).map((pack) => pack.root));

/**
 * 某个文件属于哪个包。主包返回 'main'。
 * @param {string} abs 绝对路径
 * @returns {string}
 */
function packageOf(abs) {
  const rel = path.relative(MINI, abs).split(path.sep).join('/');
  const head = rel.split('/')[0];
  return PACKAGE_ROOTS.has(head) ? head : 'main';
}

/** 递归列出小程序源码里指定扩展名的文件 */
function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * 把引用解析成绝对路径。支持 `/` 开头的「从小程序根算」写法与相对写法。
 * @param {string} fromFile 引用所在的文件
 * @param {string} spec 引用字符串
 * @param {string} ext 缺省扩展名（引用里常省略）
 * @returns {string}
 */
function resolveRef(fromFile, spec, ext) {
  const target = spec.startsWith('/')
    ? path.join(MINI, spec)
    : path.resolve(path.dirname(fromFile), spec);
  return path.extname(target) ? target : `${target}${ext}`;
}

/**
 * 判断一条引用是否越界。
 * @param {string} from 引用方所在包
 * @param {string} to 被引用方所在包
 * @returns {boolean} 越界返回 true
 */
function isIllegal(from, to) {
  if (from === to) return false;
  // 分包引用主包是允许的
  return !(from !== 'main' && to === 'main');
}

/** 收集全部引用：[{ file, spec, ext, kind }] */
function collectRefs() {
  const refs = [];

  for (const file of walk(MINI, '.wxss')) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/@import\s+['"]([^'"]+)['"]/g)) {
      refs.push({ file, spec: m[1], ext: '.wxss', kind: 'wxss @import' });
    }
  }

  for (const file of walk(MINI, '.wxml')) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(?:import|include|wxs)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) {
      refs.push({ file, spec: m[1], ext: '', kind: 'wxml src' });
    }
  }

  for (const file of walk(MINI, '.json')) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      continue; // 坏 JSON 由别的用例管，这里只查引用方向
    }
    for (const spec of Object.values(doc.usingComponents || {})) {
      refs.push({ file, spec, ext: '.js', kind: 'usingComponents' });
    }
  }

  for (const file of walk(MINI, '.js')) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      refs.push({ file, spec: m[1], ext: '.js', kind: 'require' });
    }
  }

  return refs;
}

test('主包不引用分包、分包不引用别的分包', () => {
  const violations = [];
  for (const ref of collectRefs()) {
    // 只看得懂相对路径与 / 开头的路径；裸模块名（如 'utils/x'）跳过
    if (!ref.spec.startsWith('.') && !ref.spec.startsWith('/')) continue;
    const target = resolveRef(ref.file, ref.spec, ref.ext);
    const from = packageOf(ref.file);
    const to = packageOf(target);
    if (isIllegal(from, to)) {
      violations.push(`${path.relative(MINI, ref.file)} (${from}) --${ref.kind}--> ${ref.spec} (${to})`);
    }
  }
  assert.deepEqual(violations, [],
    '跨包引用方向错误：主包不能引用分包，分包之间也不能互相引用');
});

test('所有内部引用都指向真实存在的文件', () => {
  const missing = [];
  for (const ref of collectRefs()) {
    if (!ref.spec.startsWith('.') && !ref.spec.startsWith('/')) continue;
    const target = resolveRef(ref.file, ref.spec, ref.ext);
    // 只检查落在小程序目录内的引用（../.. 跑到仓库别的目录是另一回事）
    if (!target.startsWith(MINI)) continue;
    if (!fs.existsSync(target)) {
      missing.push(`${path.relative(MINI, ref.file)} --${ref.kind}--> ${ref.spec}`);
    }
  }
  assert.deepEqual(missing, [], '有引用指向不存在的文件');
});

test('每个分包 root 都在 miniprogram 下真实存在，且至少有一页', () => {
  for (const pack of app.subPackages || []) {
    const dir = path.join(MINI, pack.root);
    assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
      `分包 root 目录不存在：${pack.root}`);
    assert.ok(pack.pages.length > 0, `分包 ${pack.root} 没有页面`);
    for (const rel of pack.pages) {
      assert.ok(fs.existsSync(path.join(dir, `${rel}.wxml`)),
        `分包页缺少 wxml：${pack.root}/${rel}`);
    }
  }
});

test('tabBar 页面必须留在主包', () => {
  const mainPages = new Set(app.pages);
  for (const item of app.tabBar.list) {
    assert.ok(mainPages.has(item.pagePath), `tabBar 页面 ${item.pagePath} 不在主包 pages 里`);
  }
});

test('preloadRule 指向的页面与分包都存在', () => {
  const alias = new Set();
  for (const pack of app.subPackages || []) {
    alias.add(pack.root);
    // 设了 name 之后，preloadRule 用的是别名
    if (pack.name) alias.add(pack.name);
  }
  for (const [page, rule] of Object.entries(app.preloadRule || {})) {
    assert.ok(app.pages.includes(page), `preloadRule 的源页面未注册在主包：${page}`);
    for (const pkg of rule.packages || []) {
      assert.ok(alias.has(pkg), `preloadRule 引用了不存在的分包：${pkg}`);
    }
  }
});
