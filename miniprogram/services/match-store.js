/**
 * 本地比赛台账（仅内存）
 * ============================================================
 * mock 数据源原本是只读的：每次 load() 都从种子重新生成一份。P3 引入
 * 成绩录入后，需要有一处地方暂存「本次会话里新录的比赛」和「对已有比赛的
 * 改判」（确认 / 驳回 / 撤销）。这里就是那块暂存区。
 *
 * 【为什么保持「笨」】
 * 它只负责存取，刻意不提供 applyTo(matches) 这类合并函数。合并谁、
 * 过滤什么、按什么顺序回放，是有讲究的——尤其是「未生效的比赛必须在
 * 回放之前剔除」（见 mock.js 的 buildCache）。那属于数据层的知识，
 * 一旦下沉到这里，最危险的约束就离使用现场太远，后人换个场景复用时
 * 很容易踩雷。
 *
 * 【为什么要按协会分桶】
 * 多协会版本里每个协会各持一份独立的台账，切换协会即切换整份台账。
 * 分桶在 association-scope.perAssociation 里统一实现，于是「一个协会
 * 录的比赛不会出现在另一个协会」是天然成立的，不必在每个读取点写过滤。
 *
 * 【为什么 reset 要复位序号】
 * 测试里要能断言「第一场录入的比赛编号是 lm0001」。如果序号只增不减，
 * 这个断言就会随用例执行顺序飘移，变成一条时而通过时而失败的坏测试。
 *
 * 【纯内存】
 * 刻意不写 wx storage：这些是演示期的临时写入，重启即失效。上云后
 * 持久化由云函数负责，届时整个模块可以直接删掉。
 * ============================================================
 */

const { MATCH_STATUS } = require('../utils/constants.js');
const { perAssociation } = require('./association-scope.js');

/** 本地新增比赛的编号前缀 */
const LOCAL_ID_PREFIX = 'lm';

/**
 * 按协会分桶的台账：每个协会各持一份「新增 + 改判 + 序号」。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({
  /** 本次会话中新增的比赛（按录入顺序） */
  submitted: [],
  /** 对已有比赛的改判：_id → { status, reason, action, actor, actedAt } */
  overrides: new Map(),
  /** 自增序号，保证同一协会同一会话内编号不重复 */
  sequence: 0,
}));

/**
 * 需要逐层复制的字段。
 * 其余字段都是标量，浅拷贝就够了；但这几个是数组，浅拷贝会让台账与
 * 调用方共用同一个数组——录入页随手往里 push 一下，台账里的比赛
 * 就悄悄多出一个人。
 */
const ARRAY_FIELDS = ['teamA', 'teamB', 'scoreA', 'scoreB'];

/**
 * 复制一条比赛记录。
 * @param {Object} record
 * @returns {Object} 与入参不共享任何可变子对象的新记录
 */
function cloneMatch(record) {
  const copy = { ...record };
  for (const field of ARRAY_FIELDS) {
    if (Array.isArray(record[field])) copy[field] = [...record[field]];
  }
  return copy;
}

/**
 * 分配下一个本地比赛编号。
 * @returns {string} lm0001、lm0002……
 */
function nextId() {
  const bucket = state.current();
  bucket.sequence += 1;
  return `${LOCAL_ID_PREFIX}${String(bucket.sequence).padStart(4, '0')}`;
}

/**
 * 记入一场新比赛。
 *
 * 状态强制为「待确认」——录完就生效等于自己给自己盖章，
 * 「对手确认」这道闸门就形同虚设了。
 *
 * @param {Object} draft buildMatchRecord 给出的记录（不含 _id / status）
 * @returns {Object} 带 _id 与 status 的完整记录（副本，外部改不到内部）
 */
function addMatch(draft) {
  // 进台账时复制一次：调用方随后再动自己的草稿，就影响不到台账了；
  // 交出去时再复制一次，反向也一样。两次都省不得。
  const record = cloneMatch({
    ...draft,
    _id: nextId(),
    status: MATCH_STATUS.PENDING,
  });
  state.current().submitted.push(record);
  return cloneMatch(record);
}

/**
 * 记入或覆盖一场比赛。专供抽签生成的赛事比赛使用。
 *
 * 【与 addMatch 的差别】
 * addMatch 每次分配一个新编号，同一场录入两次就是两条；抽签生成的比赛
 * 自带确定性编号（见 draw.eventMatchKey），重抽时要用同一批编号覆盖旧
 * 对阵，而不是再追加一批。所以这里按 _id 找位置：找到就替换，没有才追加。
 *
 * 状态一律重置为「待确认」：重抽会作废尚未确认的比分，覆盖上去的就该是
 * 一场干干净净、等开打的新对阵。
 *
 * 【为什么还要顺手清掉改判】
 * 重抽落到的是同一批确定性编号（见 draw.eventMatchKey）。若上一版签表里
 * 这一场被驳回或撤销过，overrides 里还压着一条 REVOKED；不清掉它，盖上来的
 * 新对阵会被那条旧改判重新盖成「已撤销」，既录不了分也确认不了，重抽多少次
 * 都解不开（见 mock.buildCache 的合并顺序）。覆盖一场比赛时，它的历史改判
 * 就该随之作废——这正是「重置为待确认」的完整含义。
 *
 * @param {Object} draft 带 _id 的比赛记录（见 draw.buildBracketMatches）
 * @returns {Object} 落库后的副本
 */
function saveMatch(draft) {
  const bucket = state.current();
  const record = cloneMatch({ ...draft, status: MATCH_STATUS.PENDING });
  const index = bucket.submitted.findIndex((item) => item._id === record._id);
  if (index >= 0) bucket.submitted[index] = record;
  else bucket.submitted.push(record);
  // 覆盖即作废旧改判，否则驳回/撤销过的签位重抽后仍是「已撤销」
  bucket.overrides.delete(record._id);
  return cloneMatch(record);
}

/**
 * 取某场比赛的改判记录。
 * @param {string} id
 * @returns {Object|null} 没有改判时返回 null
 */
function overrideOf(id) {
  const patch = state.current().overrides.get(id);
  return patch ? { ...patch } : null;
}

/**
 * 写入一场比赛的改判。多次改判以最后一次为准（后一次在前一次之上合并），
 * 这样「先驳回、再撤销」不会互相丢字段。
 *
 * @param {string} id
 * @param {Object} patch 至少含 status；撤销/驳回还要带 reason、action、actor、actedAt
 * @returns {Object} 合并后的改判
 */
function setStatus(id, patch) {
  const bucket = state.current();
  const next = { ...(bucket.overrides.get(id) || {}), ...patch };
  bucket.overrides.set(id, next);
  return { ...next };
}

/**
 * 列出本次会话新增的比赛（副本）。
 * @returns {Array<Object>}
 */
function listSubmitted() {
  return state.current().submitted.map(cloneMatch);
}

/** 清空全部协会的新增与改判，并复位编号。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = {
  LOCAL_ID_PREFIX,
  nextId,
  addMatch,
  saveMatch,
  overrideOf,
  setStatus,
  listSubmitted,
  reset,
};
