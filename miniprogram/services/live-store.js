/**
 * 本地实时比分台账（仅内存）
 * ============================================================
 * 与 match-store / college-store 同一角色：mock 数据源的临时写入区。
 * 实时态一场一条（_id 见 live-score.liveKey），重开一局覆盖旧的，
 * 不堆历史——与 live_scores 集合「一场恒一条」的约定一致。
 *
 * 【为什么不进 buildCache】
 * 实时态不参与回放：它既不算等级分，也不必因为每判一球就让整季缓存
 * 失效（§八.5）。读取时直接从这份台账现取，比塞进缓存再同步失效
 * 简单得多。
 *
 * 【为什么存取都复制】
 * 与 match-store 同一纪律：交出去的数组若与台账共用引用，调用方随手
 * push 一球就会悄悄改到台账。rallies 是数组，必须逐层复制。
 *
 * 【为什么按协会分桶】
 * 与其它台账同理：实时比分只在当前协会里可见，切换协会即切换整份台账。
 * 比赛编号（matchId）本身已按协会隔离，分桶只是把这份隔离贯彻到实时态。
 * ============================================================
 */

const { perAssociation } = require('./association-scope.js');

/**
 * 按协会分桶的实时态台账：每个协会各持一份「matchId → 实时态」。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({ states: new Map() }));

/**
 * 复制一份实时态。rallies 是唯一的可变子结构，逐层复制。
 * @param {Object} state
 * @returns {Object}
 */
function cloneLive(state) {
  if (!state) return null;
  const copy = { ...state };
  copy.rallies = (state.rallies || []).map((rally) => ({ ...rally }));
  if (Array.isArray(state.teamA)) copy.teamA = [...state.teamA];
  if (Array.isArray(state.teamB)) copy.teamB = [...state.teamB];
  return copy;
}

/**
 * 取一场比赛的实时态。
 * @param {string} matchId
 * @returns {Object|null}
 */
function get(matchId) {
  return cloneLive(state.current().states.get(matchId));
}

/**
 * 写入（或覆盖）一场比赛的实时态。
 * @param {Object} state 必须带 matchId
 * @returns {Object} 落库后的副本
 */
function set(liveState) {
  if (!liveState || !liveState.matchId) return null;
  state.current().states.set(liveState.matchId, cloneLive(liveState));
  return cloneLive(liveState);
}

/**
 * 列出全部实时态（副本）。
 * @returns {Array<Object>}
 */
function list() {
  return [...state.current().states.values()].map(cloneLive);
}

/**
 * 按编号批量取（缺的不占位）。
 * @param {string[]} matchIds
 * @returns {Array<Object>}
 */
function byIds(matchIds) {
  const ids = Array.isArray(matchIds) ? matchIds : [];
  return ids.map((id) => get(id)).filter(Boolean);
}

/** 清空全部协会的实时态。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = {
  get,
  set,
  list,
  byIds,
  reset,
};
