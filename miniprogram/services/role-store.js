/**
 * 角色任免台账（仅本地模拟数据用）
 * ============================================================
 * 与 profile-store 同一套路数：种子里那 24 位会员不在 user-store 里
 * （那是注册申请的台账），管理员在本地把某位种子会员设为干事，
 * 改的就是这里。
 *
 * 结构同样是「_id → 补丁」，只是补丁只含一个字段：role。
 * buildCache 把它盖在（种子 + 已通过审核的账号）拼出来的会员名单上，
 * 于是种子里的人也能被任免，改完各处读到的就是新角色。
 *
 * 【为什么只存补丁而不是整条会员记录】
 * 与 profile-store 同理：分数、场次、排名都是回放算出来的，这里再存一份
 * 整记录，就有「台账与回放结果谁对」的问题。补丁只覆盖 role，其余一律
 * 以回放结果为准，天然不会分叉。
 *
 * 【为什么不复用 user-store.setStatus】
 * 那份台账只管注册申请，装不下种子会员；而本台账只服务「角色」这一件事，
 * 范围收得越窄，越不容易被将来的改动误伤。
 *
 * 纯内存，不落盘——与其它台账一致，重启小程序即回到种子状态。
 * ============================================================
 */

/** _id → 角色补丁 */
let overrides = new Map();

/**
 * 取某人的角色补丁。没有任免过时返回 null。
 * @param {string} userId
 * @returns {Object|null}
 */
function patchOf(userId) {
  if (!userId) return null;
  const patch = overrides.get(userId);
  return patch ? { ...patch } : null;
}

/**
 * 记下一次角色任免。
 *
 * @param {string} userId
 * @param {number} role 取值见 constants.ROLE
 * @returns {Object|null} 合并后的补丁
 */
function setRole(userId, role) {
  if (!userId) return null;
  const next = { ...(overrides.get(userId) || {}), role };
  overrides.set(userId, next);
  return { ...next };
}

/** 清空台账。测试与 resetCache 用 */
function reset() {
  overrides = new Map();
}

module.exports = { patchOf, setRole, reset };
