/**
 * 当前协会（客户端会话作用域）
 * ============================================================
 * 多协会版本里，「我现在在哪个协会」是贯穿整个客户端的会话状态：门面透传时
 * 要知道它（决定向云端请求哪个协会的数据），mock 的各台账要按它分桶，
 * 榜单、种子也都要按它取。
 *
 * 【为什么单列一个模块，而不是塞进门面或 utils/associations.js】
 *   · 门面 index.js 会 require cloud.js / mock.js；若「当前协会」也放在门面里，
 *     cloud.js 与各 store 再回头 require 门面就成了环。放在这里，谁都能直接读，
 *     不经过门面。
 *   · utils/associations.js 是纯计算模块，要逐字节镜像进云函数
 *     （见 tools/sync-cloud-lib.js）；带了可变状态就镜像不过去了。协会的
 *     「清单」在那边，「当前选的是哪一个」在这里。
 *
 * 【默认值】从未设定过时取注册表里首个启用中的协会（defaultAssociationId）。
 * 设定非法 id 直接抛错——宁可当场炸，也不要让数据悄悄落到别的协会名下。
 * ============================================================
 */

const {
  defaultAssociationId,
  isKnownAssociation,
  activeAssociations,
} = require('../utils/associations.js');

/** 当前协会 id；空串表示尚未设定 */
let current = '';

/**
 * 当前协会 id。尚未设定时回落到默认协会。
 * @returns {string}
 */
function getAssociation() {
  if (!current) current = defaultAssociationId();
  return current;
}

/**
 * 设定当前协会。
 * @param {string} id 必须是注册表里的已知协会
 * @returns {string} 设定后的 id
 * @throws {Error} 未知协会
 */
function setAssociation(id) {
  if (!isKnownAssociation(id)) throw new Error(`未知的协会 id：${id}`);
  current = id;
  return current;
}

/** 复位到「未设定」。测试与冷启动重来用。 */
function resetAssociation() {
  current = '';
}

/**
 * 造一个「按协会分桶」的台账容器。
 *
 * 【为什么按协会分桶，而不是把协会并进复合键】
 * 各台账（match-store 等）的编号是固定形状的（lm0001……），测试与界面都
 * 依赖它；把协会并进主键会让编号变形。分桶则让每个协会各持一份完全独立的
 * 台账——隔离是「天然」的：读到的永远只有当前协会那一桶，不必在每个读取点
 * 再写一遍过滤。
 *
 * @param {Function} init 造一份空台账（返回一个对象）
 * @returns {{current: Function, clear: Function}}
 *   current() 取当前协会的台账（没有就现造一份）；clear() 清空所有协会的台账。
 */
function perAssociation(init) {
  const buckets = new Map();
  return {
    current() {
      const id = getAssociation();
      if (!buckets.has(id)) buckets.set(id, init());
      return buckets.get(id);
    },
    clear() {
      buckets.clear();
    },
  };
}

/**
 * 在「指定的协会」作用域里跑一段（可异步的）逻辑，跑完把当前协会还原。
 *
 * 【用途】页面局部的切换（个人详情页 / 他人主页）：只想让本页按另一个协会取数，
 * 不改变全局的当前协会。把「临时切过去—取数—还原」包成一步，调用方不必自己在
 * 每个出口记得还原。
 *
 * 【为什么 finally 里要判 isKnownAssociation】一个启用协会都没有时 getAssociation()
 * 返回空串；此时还原 setAssociation('') 会抛「未知协会」，把真实的取数结果也带塌。
 * 空串就不还原（本来也没切过）。
 *
 * @param {string} id 目标协会
 * @param {Function} fn 无参函数，可返回 Promise
 * @returns {Promise<*>} fn 的返回值
 */
async function withAssociation(id, fn) {
  const saved = getAssociation();
  setAssociation(id);
  try {
    return await fn();
  } finally {
    if (isKnownAssociation(saved)) setAssociation(saved);
  }
}

/**
 * 依次在全部启用协会的作用域里跑 fn，收集结果（跨协会聚合读的地基）。
 *
 * 【为什么是串行而不是并发】当前协会是模块级单例状态，并发跑会互相串味。
 * 顺序执行、每次取完还原，是让「聚合」这件事在单例状态上安全成立的最省事做法。
 * 数据量小（个位数协会），串行的代价可以接受。
 *
 * @param {Function} fn (assoc) => result，可返回 Promise
 * @returns {Promise<Array<*>>} 与启用协会一一对应的结果
 */
async function mapActiveAssociations(fn) {
  const list = activeAssociations();
  const saved = getAssociation();
  const results = [];
  try {
    for (const assoc of list) {
      setAssociation(assoc.id);
      results.push(await fn(assoc));
    }
  } finally {
    if (isKnownAssociation(saved)) setAssociation(saved);
  }
  return results;
}

module.exports = {
  getAssociation,
  setAssociation,
  resetAssociation,
  perAssociation,
  withAssociation,
  mapActiveAssociations,
};
