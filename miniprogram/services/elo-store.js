/**
 * 按协会的「当前等级分」改分台账（仅本地模拟数据用）
 * ============================================================
 * 与初始等级分台账（initialElo-store.js）互补：
 *   - 初始分是**入池起评分**，只有没出过场的人能改；
 *   - 这里记的是**当前分的时间线快照**，任何人任何时候都能改，改完由回放
 *     引擎在对应时间点把分数直接置成新值，之后的比赛再从这个值继续累加。
 *
 * 典型用途：会员在外面打了比赛，对手不在本程序里，没法走流水。管理员在
 * 外部算好新分数后，直接用这里记一条「某时刻某池 = X」，比分照常回放，
 * 那条改分会像一场比赛一样被后续流水继承。
 *
 * 【为什么记时间点（at）而不是简单地覆盖最终值】
 * 若一律在回放结束后覆盖，则「改分之后新录的比赛」会被无声抹掉——用户改完
 * 分，第二天录入一场新比赛，刷新后分数又变回手动值，比赛白打了。记时间点、
 * 按时间线插入，才能让改分与真实比赛正确衔接。
 *
 * 【为什么按协会分桶】
 * 同一个人在匹克球 / 乒乓球协会可以有不同的当前分。分桶让切换协会即切换
 * 整份台账，与云端 `users.currentEloByAssoc` 的语义一致。
 *
 * 纯内存，不落盘——与其它台账一致，重启小程序即回到种子状态。
 * ============================================================
 */

const { perAssociation } = require('./association-scope.js');

/**
 * 按协会分桶的改分台账：每个协会各持一份。
 * 键为 `${userId}|${pool}`，值为 `{ userId, pool, value, at }`。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({ overrides: new Map() }));

/** 拼台账键，避免 userId / pool 里出现分隔符时歧义 */
function keyOf(userId, pool) {
  return `${userId}|${pool}`;
}

/**
 * 取某位会员在某协会某个池的当前改分。
 * @param {string} userId
 * @param {string} pool 等级分池（singles / doubles）
 * @returns {{set:boolean, value:number|null, at:number|null}}
 */
function valueOf(userId, pool) {
  if (!userId || !pool) return { set: false, value: null, at: null };
  const entry = state.current().overrides.get(keyOf(userId, pool));
  if (!entry) return { set: false, value: null, at: null };
  return { set: true, value: entry.value, at: entry.at };
}

/**
 * 记下一次改分。
 * @param {string} userId
 * @param {string} pool 等级分池（singles / doubles）
 * @param {number} value 改后的分数
 * @param {number|string|Date} at 生效时刻
 * @returns {{userId:string, pool:string, value:number, at:number}|null}
 */
function setValue(userId, pool, value, at) {
  if (!userId || !pool) return null;
  const atMs = new Date(at).getTime();
  const entry = {
    userId,
    pool,
    value,
    at: Number.isFinite(atMs) ? atMs : Date.now(),
  };
  state.current().overrides.set(keyOf(userId, pool), entry);
  return entry;
}

/**
 * 列出本协会全部改分，喂给回放引擎的 eloOverrides。
 * @returns {Array<{userId:string, pool:string, value:number, at:number}>}
 */
function list() {
  return [...state.current().overrides.values()].map((entry) => ({ ...entry }));
}

/** 清空全部协会的台账。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = { valueOf, setValue, list, reset };
