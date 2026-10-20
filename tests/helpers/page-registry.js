/**
 * 页面路径注册表
 * ============================================================
 * 页面自 2026-10 起按域拆进了 5 个分包（packageEvent / packageMeet /
 * packageTeam / packageCollege / packageMember），主包只留 tabBar 三页加
 * 登录与工作台外壳。测试原先一律按 `pages/<name>/<name>.js` 写死路径，
 * 页面一搬就全部 MODULE_NOT_FOUND。
 *
 * 这里统一从 app.json 读回「页面名 → 实际路径」，测试只按**页面名**取。
 * 好处是页面以后再换包、调整 `subPackages` 的分组，测试都不用改。
 * ============================================================
 */
const fs = require('fs');
const path = require('path');

/** 小程序根目录的绝对路径 */
const MINI = path.join(__dirname, '..', '..', 'miniprogram');

const app = JSON.parse(fs.readFileSync(path.join(MINI, 'app.json'), 'utf8'));

/** 页面名 → miniprogram 下的相对路径（不含扩展名） */
const registry = new Map();
for (const page of app.pages) registry.set(page.split('/')[1], page);
for (const pack of app.subPackages || []) {
  for (const page of pack.pages) registry.set(page.split('/')[0], `${pack.root}/${page}`);
}

/**
 * 取页面文件的相对路径。
 *
 * 入参兼容四种写法，调用方不必关心页面现在在哪个包：
 *   · 页面名          'meet-list'
 *   · 目录形式        'meet-list/meet-list.js'
 *   · 带包前缀        'packageMeet/meet-list/meet-list.js'
 *   · 旧的主包形式    'pages/index/index.js'
 * 页面名全站唯一，所以「取第几段」只取决于第一段是不是 pages / packageX。
 *
 * @param {string} name
 * @param {string} [ext='.js']
 * @returns {string} 例如 'packageMeet/meet-list/meet-list.js'
 */
function pagePathOf(name, ext = '.js') {
  const segments = String(name).replace(/\.(js|json|wxml|wxss)$/, '').split('/');
  const head = segments[0];
  const key = (head === 'pages' || /^package/i.test(head)) ? segments[1] : head;
  const target = registry.get(key);
  if (!target) throw new Error(`未在 app.json 注册的页面：${name}`);
  return `${target}${ext}`;
}

/** 全部已注册页面名（主包 + 分包） */
function pageNames() {
  return [...registry.keys()];
}

/**
 * 该页面是否已在 app.json 注册（主包 pages 或任一分包）。
 *
 * 分包页面**不在** `app.pages` 里，所以不能再拿 `app.pages.includes(...)`
 * 判断注册——那样分包页面一律判成未注册。
 *
 * @param {string} name 页面名
 * @returns {boolean}
 */
function isRegistered(name) {
  return registry.has(name);
}

/**
 * 页面文件的绝对路径。
 *
 * 测试里读 wxml / json / wxss 时用这个，省得自己拼 'pages' 前缀——
 * 拼出来的路径在分包化之后有一半是错的。
 *
 * @param {string} name 页面名
 * @param {string} [ext='.js']
 * @returns {string} 绝对路径
 */
function pageFileOf(name, ext = '.js') {
  return path.join(MINI, pagePathOf(name, ext));
}

/**
 * 全部页面所在目录（绝对路径，去重）。
 *
 * 用于「把每个页面都扫一遍」的用例（例如禁用某个旧门面）。这类用例原先
 * 只扫 `pages/`，分包化之后会**静默漏掉** 37 个页面却仍然全绿——所以
 * 目录必须从 app.json 取，不能写死。
 *
 * @returns {Array<string>}
 */
function pageDirs() {
  return [...new Set([...registry.values()].map(page => path.dirname(path.join(MINI, page))))];
}

module.exports = {
  MINI, pagePathOf, pageFileOf, pageDirs, pageNames, isRegistered,
};
