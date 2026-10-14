/**
 * 协会空间门面：按数据源提供绑定 scope 的客户端
 * ============================================================
 * 页面只认这个门面，不关心底层是本地演示仓储还是云函数。每次创建客户端时把
 * 学校与协会固定下来，之后的每个请求都用这把固定的范围——不会在异步等待期间
 * 再去读全局当前学校/协会（那会造成跨范围串数据，见规划 §9.4）。
 *
 * 与 exchange.js 的差别：空间功能已同时实现本地与云端两套（云端走协议 2），
 * 因此这里按数据源直接选择，不额外抛「仅本地」错误。
 * ============================================================
 */

const identity = require('./school-identity.js');
const mock = require('./school-mock.js');
const cloud = require('./school-cloud.js');

/**
 * 取得绑定到某学校某协会的空间客户端。
 * @param {{schoolId: string, association: string}} scope
 * @returns {Object} 分组与成员名录的动作集合
 */
function forScope(scope) {
  return identity.isMockNow() ? mock.forAssociationSpace(scope) : cloud.forAssociationSpace(scope);
}

module.exports = { forScope };
