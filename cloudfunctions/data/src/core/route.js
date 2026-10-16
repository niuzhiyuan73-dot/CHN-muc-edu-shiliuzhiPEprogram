/**
 * 云函数入口的路由判据
 * ============================================================
 * 一次调用要么走协议 2（学校维度，`handleSchoolRequest`），要么走旧协议
 * （`dispatch`）。判据单独成函数，是为了能**脱离 wx-server-sdk 单测**——
 * `cloudfunctions/data/index.js` 顶层 require 了 wx-server-sdk，测试环境
 * 装不了它，判据留在 index.js 里就永远测不到。
 *
 * 【为什么只认 protocolVersion，不认 schoolId】
 * 从前判据是：
 *
 *     event.protocolVersion !== undefined || event.schoolId !== undefined
 *
 * 但 `handleSchoolRequest` 内部严格要求 `protocolVersion === 2`，所以
 * 「旧协议请求恰好带了顶层 schoolId」这条只会得到一句
 * 「学校接口需要协议版本 2，请升级客户端」——**报错，但不会误执行业务**。
 * 真正的害处是那句文案：它把「客户端没带协议版本」说成「版本不够」，
 * 排查方向会被带偏（2026-10-16 只读审计 H6）。
 *
 * 协议 2 的客户端**总是**带 `protocolVersion: 2`（见
 * `miniprogram/services/school-cloud.js` 的 `requestFor`，写死的），
 * 所以 `schoolId` 这个条件纯属多余，去掉即可。
 * ============================================================
 */

/**
 * 该走协议 2（学校维度）吗？
 * @param {Object} event 云函数入参
 * @returns {boolean}
 */
function isSchoolRequest(event = {}) {
  return event.protocolVersion !== undefined;
}

module.exports = { isSchoolRequest };
