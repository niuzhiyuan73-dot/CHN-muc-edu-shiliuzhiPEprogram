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
const { LEGACY_SCHOOL_ID } = require('../utils/school.js');
const scope = require('./association-scope.js');
const mock = require('./mock.js');
const runtime = require('./runtime-mode.js');

/**
 * 已注册的数据源实现。
 * 这两个 require 是静态的：小程序打包时会一并收进来，切换数据源不需要
 * 重新构建，也不会因为「用到才加载」而在首次调用时卡一下。
 */
const implementations = {
  [DATA_SOURCE.MOCK]: mock,
  [DATA_SOURCE.CLOUD]: require('./cloud.js'),
};

/**
 * 解析出当前生效的实现。
 *
 * 【运行模式为什么不在本模块里存】见 runtime-mode.js：模式是**两个栈共用**的
 * 运行状态——学校维度（school-identity）也要按它决定取模拟仓储还是云端仓储。
 * 协议 1 已定完全下线，本门面本身要删；模式若长在门面里就会跟着陪葬，删门面
 * 就会连带打断学校维度。所以模式搬去 runtime-mode，本模块改为向它取，
 * 自己只负责「按模式挑实现」这一件事。
 *
 * @returns {Object}
 */
function resolveSource() {
  const name = runtime.getDataSource();
  const impl = implementations[name];
  if (!impl) throw new Error(`未知的数据源：${name}`);
  return impl;
}

/**
 * 按 mock.js 的函数名单逐个生成透传函数。
 * 名单以 mock 为准：它是客户端接口的超集（多出 mock 特有的 load / resetCache），
 * 与 cloud 的一致性由 tests/datasource.test.js 守着。
 */
function createApi(association) {
  const api = {};
  for (const name of Object.keys(mock)) {
    if (typeof mock[name] !== 'function') continue;
    api[name] = (...args) => {
      const run = () => {
        const source = resolveSource();
        if (typeof source[name] !== 'function') {
          throw new Error(`当前数据源（${runtime.getDataSource()}）不支持 ${name}`);
        }
        if (association === undefined) return source[name](...args);
        if (runtime.getDataSource() === DATA_SOURCE.CLOUD) {
          return source.forAssociation(association)[name](...args);
        }
        return scope.runSynchronous(association, () => source[name](...args));
      };
      return isWriteAction(name) ? guardWrite(run) : run();
    };
  }
  return api;
}

function forAssociation(id) {
  scope.validateAssociation(id);
  return createApi(id);
}

/** 非默认校调用旧门面时抛出的错误码，供上层辨认（写接口会收敛成 {ok:false}） */
const LEGACY_SCHOOL_UNSUPPORTED = 'legacy-school-unsupported';

/**
 * 旧栈的「范围」适配层（迁移清单 M0-2 / M0-3）。
 *
 * 旧业务的数据模型只有 `association` 一维，主记录里没有 `schoolId`。学校维度
 * 尚未迁移到旧业务的任何一页，因此这里把旧门面**钉死在默认校**（`muc`）：
 *   · `schoolId` 缺省或等于默认校 → 与 `forAssociation(association)` 等价，
 *     兼容读取既有的、来源不明的旧数据；
 *   · 其他任何学校 → 一律拒绝：读接口抛错、写接口收敛成 `{ok:false}`。
 *
 * 这样做的目的只有一个：**堵死「借旧门面把第二所学校的数据写进默认校」**。
 * 页面若在非默认校误用旧门面，会立刻得到明确报错，而不是静默串校——串校
 * 一旦发生，是数据的静默污染，比报错难查得多。
 *
 * M1–M4 会把旧业务逐页迁到学校维度栈（`association-space.js` 那套
 * `forScope`）；迁移完成前，任何一页仍走旧门面时都必须守在这里。
 *
 * @param {Object} input { schoolId, association }
 * @returns {Object} 与门面同形的接口集合
 */
function forScope(input = {}) {
  const schoolId = input.schoolId || LEGACY_SCHOOL_ID;
  const association = input.association === undefined ? scope.getAssociation() : input.association;
  scope.validateAssociation(association);

  if (schoolId === LEGACY_SCHOOL_ID) return forAssociation(association);

  const message = `旧业务尚未支持学校「${schoolId}」，请改用学校维度接口`;
  const deny = {};
  for (const name of Object.keys(mock)) {
    if (typeof mock[name] !== 'function') continue;
    const run = () => {
      const err = new Error(message);
      err.code = LEGACY_SCHOOL_UNSUPPORTED;
      throw err;
    };
    deny[name] = isWriteAction(name) ? () => guardWrite(run) : run;
  }
  return deny;
}

const api = createApi();

module.exports = {
  ...api,
  forAssociation,
  forScope,
  LEGACY_SCHOOL_UNSUPPORTED,
  // 运行模式由 runtime-mode 持有，这里只做转发，保持既有调用方不必改。
  setDataSource: runtime.setDataSource,
  getDataSource: runtime.getDataSource,
  isMockNow: runtime.isMockNow,
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
    get: runtime.getDataSource,
  },
  isMock: {
    enumerable: true,
    get: runtime.isMockNow,
  },
});
