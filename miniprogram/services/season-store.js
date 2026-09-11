/**
 * 本地赛季状态（仅内存）
 * ============================================================
 * mock 数据源原先没有「赛季」这个概念——种子直接当成一个完整赛季。
 * 引入赛季软重置后，需要有地方记住「本次会话里做过一次重置、分界点
 * 在哪、用的什么参数」。与 match-store / user-store / announcement-store
 * 是一套路数：只管存取，不做任何判断。
 *
 * 【为什么只记最后一次】
 * 软重置的语义就是「从此刻起新赛季」。理论上连续重置两次只需要后一次
 * ——分界点更靠后，前一次被完全覆盖。因此这里不保留历史，省掉一堆
 * 「哪一次才算数」的歧义。
 *
 * 【纯内存】
 * 与其它本地台账一致，刻意不写 wx storage：演示期的临时写入，重启即
 * 失效。上云后持久化由云函数负责，整个模块可以直接删掉。
 * ============================================================
 */

const { DEFAULT_RESET_POLICY } = require('./season.js');

/** 最近一次软重置的分界点（Date）与策略；从未重置时为 null */
let resetTime = null;
let resetPolicy = null;

/**
 * 赛季编号。与云端 seasonNumber 同义：默认第一赛季，只有「开始新赛季」
 * （setReset）能让它 +1。日常录入比赛、审核会员都不该动它——否则界面上的
 * 赛季数会随操作次数乱涨。
 */
let seasonNumber = 1;

/**
 * 读取最近一次重置。从未重置过时返回 null。
 * @returns {{resetTime:Date, policy:Object, seasonNumber:number}|null}
 */
function getReset() {
  if (!resetTime) return null;
  return {
    resetTime: new Date(resetTime.getTime()),
    policy: { ...(resetPolicy || DEFAULT_RESET_POLICY) },
    seasonNumber,
  };
}

/**
 * 读取当前赛季编号。从未重置过时为 1。
 * @returns {number}
 */
function getSeasonNumber() {
  return seasonNumber;
}

/**
 * 记下一次重置（即「开始新赛季」），把赛季编号加一。
 * @param {Object} params
 * @param {Date|string} params.resetTime 分界点
 * @param {Object} [params.policy] 重置策略
 * @returns {{resetTime:Date, policy:Object, seasonNumber:number}}
 */
function setReset({ resetTime: time, policy } = {}) {
  resetTime = time instanceof Date ? new Date(time.getTime()) : new Date(time);
  resetPolicy = { ...(policy || DEFAULT_RESET_POLICY) };
  seasonNumber += 1;
  return getReset();
}

/** 清空重置记录。mock.resetCache() 会调用它 */
function reset() {
  resetTime = null;
  resetPolicy = null;
  seasonNumber = 1;
}

module.exports = { getReset, getSeasonNumber, setReset, reset };
