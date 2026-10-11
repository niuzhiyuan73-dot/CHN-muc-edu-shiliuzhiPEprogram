/**
 * 按协会的初始等级分台账（仅本地模拟数据用）
 * ============================================================
 * 初始等级分是回放的**起评分**，管理员 / 协会负责人可以在会员还没出场时
 * 手工指定一个，或把指定过的清掉。种子里的 24 位会员不在 user-store 里
 * （那是注册申请的台账），改他们的初始分就落在这里。
 *
 * 结构同样是「_id → 值」，只是值可以是一个数字（指定）或 null（清除）。
 * buildCache 在**回放之前**把它盖到会员名单上：回放引擎读的是会员记录上的
 * 扁平字段 initialElo，这个台账只负责把「本协会那一个值」解析进去。注意这
 * 与 role-store 不同——角色盖在回放之后即可（角色的变化不影响分数），而
 * 初始分必须在回放之前生效，否则分数就已经算错了。
 *
 * 【为什么按协会分桶】
 * 初始分天然因协会而异：同一个人可以在匹克球协会有一个指定分、在乒乓球
 * 协会是自动定级。分桶让每个协会各持一份，切换协会即切换整份台账。这与
 * 云端 `users.initialEloByAssoc` 的语义一致。
 *
 * 纯内存，不落盘——与其它台账一致，重启小程序即回到种子状态。
 * ============================================================
 */

const { perAssociation } = require('./association-scope.js');

/**
 * 按协会分桶的初始分台账：每个协会各持一份「_id → 初始分 | null」。
 * 键存在即表示「这一档被手工设置过」（值为 null 即清除）。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({ overrides: new Map() }));

/**
 * 取某位会员在本协会的初始分覆盖。
 * @param {string} userId
 * @returns {{set:boolean, value:number|null}} set 为假表示没有覆盖（沿用会员自带的初值）
 */
function valueOf(userId) {
  if (!userId) return { set: false, value: null };
  const bucket = state.current();
  if (!bucket.overrides.has(userId)) return { set: false, value: null };
  return { set: true, value: bucket.overrides.get(userId) };
}

/**
 * 记下一次初始分设置 / 清除。
 * @param {string} userId
 * @param {number|null} value 数字为指定，null 为清除
 * @returns {number|null}
 */
function setValue(userId, value) {
  if (!userId) return null;
  const next = value === null || value === undefined ? null : value;
  state.current().overrides.set(userId, next);
  return next;
}

/** 清空全部协会的台账。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = { valueOf, setValue, reset };
