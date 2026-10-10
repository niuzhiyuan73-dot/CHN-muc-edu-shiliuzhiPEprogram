/**
 * 数据源门面
 * ============================================================
 * 页面只认这一个模块，永远不直接 require mock.js 或 cloud.js。
 *
 * 【为什么要有这一层】
 * 开发初期没有云环境，只能靠本地模拟数据；上线后必须走云端。
 * 如果页面直接依赖某一个实现，切换时就要逐个页面改取数代码，
 * 必然漏改、必然出错。有了门面，切换只发生在 setDataSource 一行。
 *
 * 【为什么是「调用时解析」而不是「加载时绑定」】
 * 早先这里在模块加载时就把某一个实现整个展开（`...source`），于是
 * 「选哪个数据源」这件事被冻结在 require 的那一刻。而数据源的选择要看
 * 云环境是否就绪，只有 app.js 的 onLaunch 才知道——那时门面往往已经
 * 被别的模块 require 过了，开关便形同虚设。
 * 现在每个导出函数都在**被调用的那一刻**才解析目标实现，开关随时生效。
 *
 * 【接口约定】
 * mock.js 与 cloud.js 必须导出完全相同的函数名与参数形态。
 * 新增接口时两边都要加，否则切换数据源后才会在运行时暴露缺失。
 * 具体清单见 tests/datasource.test.js；下面的透传名单直接从 mock.js 推导，
 * 因此新增接口时只改那两处，门面不会漏掉。
 *
 * 【关于 isMock / currentSource】
 * 这两个名字历史上是「值」，现在是**取值的 getter**——每次读到都是当前
 * 数据源的真实状态。页面若直接解构（`const { isMock } = require(...)`），
 * 拿到的仍是 require 那一刻的快照；需要随数据源变化而变的场合，请改调
 * isMockNow()。app.js 在所有页面加载之前完成 setDataSource，因此页面里的
 * 解构快照在真机上是对的——但调用时取值总是更稳妥。
 * ============================================================
 */

const { DATA_SOURCE } = require('../utils/constants.js');
const { guardWrite, isWriteAction } = require('../utils/write.js');
const scope = require('./association-scope.js');
const mock = require('./mock.js');

/**
 * 已注册的数据源实现。
 * 这两个 require 是静态的：小程序打包时会一并收进来，切换数据源不需要
 * 重新构建，也不会因为「用到才加载」而在首次调用时卡一下。
 */
const implementations = {
  [DATA_SOURCE.MOCK]: mock,
  [DATA_SOURCE.CLOUD]: require('./cloud.js'),
};

const KNOWN_SOURCES = Object.values(DATA_SOURCE);

/** 当前数据源标识。默认本地模拟数据 */
let current = DATA_SOURCE.MOCK;

/**
 * 解析出当前生效的实现。
 * @returns {Object}
 */
function resolveSource() {
  const impl = implementations[current];
  if (!impl) throw new Error(`未知的数据源：${current}`);
  return impl;
}

/** 当前数据源标识 */
function getDataSource() {
  return current;
}

/**
 * 切换数据源。由 app.js 在启动时按云环境是否可用决定调用。
 * @param {string} name DATA_SOURCE.MOCK | DATA_SOURCE.CLOUD
 * @returns {string} 切换后的标识
 */
function setDataSource(name) {
  if (!KNOWN_SOURCES.includes(name)) {
    throw new Error(`未知的数据源：${name}`);
  }
  current = name;
  return current;
}

/** 此刻是否为模拟数据。用于界面水印与「演示口径」提示 */
function isMockNow() {
  return current === DATA_SOURCE.MOCK;
}

/**
 * 按 mock.js 的函数名单逐个生成透传函数。
 * 名单以 mock 为准：它是客户端接口的超集（多出 mock 特有的 load / resetCache），
 * 与 cloud 的一致性由 tests/datasource.test.js 守着。
 */
const api = {};
for (const name of Object.keys(mock)) {
  if (typeof mock[name] !== 'function') continue;
  api[name] = (...args) => {
    // 解析数据源与「本实现不支持该接口」这两步也放进 run 里：
    // 它们同样会抛（数据源标识非法、mock 特有的 load/resetCache 在云端没有），
    // 若留在守卫外面，写操作的异常照样会冒到页面上把按钮卡死。
    const run = () => {
      const source = resolveSource();
      if (typeof source[name] !== 'function') {
        // 只可能发生在 mock 特有而 cloud 没有的名字上（load / resetCache）
        throw new Error(`当前数据源（${current}）不支持 ${name}`);
      }
      return source[name](...args);
    };
    // 写接口在此收口：任何异常都收敛成 {ok:false,...}，免得页面因未处理的
    // 异常卡在 submitting 上（见 utils/write.js）。读接口不套——读失败该由
    // 页面自己 catch，不能伪装成空数据。
    return isWriteAction(name) ? guardWrite(run) : run();
  };
}

module.exports = {
  ...api,
  setDataSource,
  getDataSource,
  isMockNow,
  // 「当前协会」是客户端会话状态，与数据源无关，故不经 ...api 透传（mock 与
  // cloud 都不该导出它），而是由门面直接暴露——页面要切协会只能走这里。
  setAssociation: scope.setAssociation,
  getAssociation: scope.getAssociation,
};

/**
 * currentSource / isMock 保留为 getter，兼容既有写法。
 * 用 getter 而非普通属性：普通属性在模块加载时求值一次，改了数据源也不会变。
 */
Object.defineProperties(module.exports, {
  currentSource: {
    enumerable: true,
    get: getDataSource,
  },
  isMock: {
    enumerable: true,
    get: isMockNow,
  },
});
