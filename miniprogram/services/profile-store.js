/**
 * 个人资料修改台账（仅本地模拟数据用）
 * ============================================================
 * 种子里那 24 位会员并不在 user-store 里（那是注册申请的台账），
 * 所以「改自己的昵称头像」不能只改 user-store——种子里的人根本不在那儿。
 *
 * 于是另起一份薄薄的台账：_id → { nickName?, avatarUrl? }。
 * buildCache 把它盖在（种子 + 已通过审核的账号）拼出来的会员名单上，
 * 于是种子里的人也能改，改完各处读到的就是新名字。
 *
 * 【为什么只存补丁而不是整条会员记录】
 * 分数、场次、排名都是回放算出来的，这里再存一份整记录，就有了
 * 「台账与回放结果谁对」的问题。补丁只覆盖昵称与头像两个字段，
 * 其余一律以回放结果为准，天然不会分叉。
 *
 * 【为什么按协会分桶】
 * 与其它台账同理：改名、换头像的效果只在当前协会里可见，切换协会即切回
 * 该协会自己的那份补丁。于是「同一个账号在两个协会里叫什么」互不串味。
 *
 * 纯内存，不落盘——与其它台账一致，重启小程序即回到种子状态。
 * ============================================================
 */

const { perAssociation } = require('./association-scope.js');

/**
 * 按协会分桶的资料台账：每个协会各持一份「_id → 资料补丁」。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({ overrides: new Map() }));

/**
 * 取某人的资料补丁。没有改动过时返回 null。
 * @param {string} userId
 * @returns {Object|null}
 */
function patchOf(userId) {
  if (!userId) return null;
  const patch = state.current().overrides.get(userId);
  return patch ? { ...patch } : null;
}

/**
 * 记下一次资料修改。多次修改按字段累加，只改昵称不会把头像抹掉。
 *
 * @param {string} userId
 * @param {Object} patch 已清洗过的补丁（只含 nickName / avatarUrl）
 * @returns {Object|null} 合并后的补丁
 */
function setProfile(userId, patch) {
  if (!userId) return null;
  const bucket = state.current();
  const next = { ...(bucket.overrides.get(userId) || {}), ...patch };
  bucket.overrides.set(userId, next);
  return { ...next };
}

/** 清空全部协会的台账。测试与 resetCache 用 */
function reset() {
  state.clear();
}

module.exports = { patchOf, setProfile, reset };
