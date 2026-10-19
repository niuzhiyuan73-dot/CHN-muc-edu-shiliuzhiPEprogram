/**
 * 页面装配测试的共用工装
 * ============================================================
 * 三个页面测试文件（team-pages / team-event-pages 等）都要同一套东西：
 * 按路径加载页面、按真机语义实现 setData、把门面换成假的并记录调用。
 * 抄一份到每个文件里，改一处就得记着改三处——所以放在这里。
 *
 * 【为什么按路径加载而不是 registered[N]】
 * page.test.js 用注册下标取页面，新增一页就要同步维护下标，加一页错一次。
 * 这里按**文件路径**加载，与 app.json 的注册顺序无关。
 * ============================================================
 */

const assert = require('node:assert/strict');
const path = require('node:path');

/** 深拷贝，避免用例之间串 data */
function cloneData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 按路径加载页面配置。`Page()` 调用被这次加载截获。
 *
 * @param {string} relative 例：'team-list/team-list.js'
 */
function loadPage(relative) {
  let config = null;
  const previousPage = global.Page;
  global.Page = (def) => { config = def; };
  try {
    const target = require.resolve(path.join(__dirname, '..', '..', 'miniprogram', 'pages', relative));
    delete require.cache[target];
    require(target);
  } finally {
    global.Page = previousPage;
  }
  assert.ok(config, `页面没有调用 Page()：${relative}`);
  return config;
}

/** 按真机语义实现 setData（支持 'a.b' 路径键）与页面方法绑定 */
function instantiate(config) {
  const page = { data: cloneData(config.data) };
  for (const [key, value] of Object.entries(config)) {
    if (key === 'data') continue;
    page[key] = typeof value === 'function' ? value.bind(page) : value;
  }
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.');
      let target = page.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (target[parts[i]] === null || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
    }
    if (callback) callback();
  };
  return page;
}

/**
 * 用假的 API 顶掉协会空间门面，并记录每次调用。
 *
 * @param {Object<string, Function>} methods 接口名 → 返回值的函数
 * @param {Function} run 收到调用记录数组
 */
function withApi(methods, run) {
  const space = require('../../miniprogram/services/association-space.js');
  const original = space.forScope;
  const calls = [];
  space.forScope = () => new Proxy({}, {
    get: (_t, name) => async (payload) => {
      calls.push([String(name), payload]);
      const handler = methods[String(name)];
      if (!handler) throw new Error(`未打桩的接口：${String(name)}`);
      return handler(payload);
    },
  });
  return Promise.resolve(run(calls)).finally(() => { space.forScope = original; });
}

/** 页面的 wx 桩：navigateTo / navigateBack / showModal（默认确认） */
function withWx(run) {
  const previous = global.wx;
  const modals = [];
  const navigations = [];
  global.wx = {
    navigateTo: (options) => { navigations.push(options && options.url); },
    navigateBack: () => undefined,
    showModal: (options) => {
      modals.push(options.title);
      if (options.success) options.success({ confirm: true });
    },
  };
  return Promise.resolve(run({ modals, navigations })).finally(() => { global.wx = previous; });
}

module.exports = {
  cloneData,
  loadPage,
  instantiate,
  withApi,
  withWx,
};
