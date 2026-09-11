/**
 * 本地公告台账（仅内存）
 * ============================================================
 * mock 数据源原本只有种子里的 6 条公告。P4 引入「发布公告」后，需要有
 * 一处地方暂存「本次会话里新发的公告」和「对已有公告的改判（下架）」。
 * 这里就是那块暂存区，与 match-store.js / user-store.js 是一套路数。
 *
 * 【为什么保持「笨」】
 * 只负责存取，刻意不提供 `applyTo(announcements)` 这类合并函数。合并、
 * 过滤、置顶排序是有讲究的——尤其是「己下架的不能出现在公开列表，但
 * 必须留在管理台账里」，那属于数据层的知识（见 mock.js 的 buildCache）。
 * 一旦下沉到这里，最危险的约束就离使用现场太远。
 *
 * 【为什么下架走 overrides 而不是删掉】
 * 公告是发出去给人看过的，直接抹掉会让「上周那条通知哪去了」无从追溯。
 * 下架只把状态改成 archived：公开列表看不见，管理台账里仍留着，必要时
 * 还能重新发布。这与比赛用 REVOKED 而不是删除是同一个理由。
 *
 * 【为什么 reset 要复位序号】
 * 测试里要能断言「第一条新公告的编号是 la0001」。序号只增不减的话，
 * 这条断言就会随用例执行顺序飘移，变成时而通过的坏测试。
 *
 * 【纯内存】
 * 刻意不写 wx storage：这些是演示期的临时写入，重启即失效。上云后
 * 持久化由云函数负责，届时整个模块可以直接删掉。
 * ============================================================
 */

const { ANNOUNCEMENT_STATUS } = require('../utils/constants.js');

/** 本地新增公告的编号前缀 */
const LOCAL_ID_PREFIX = 'la';

/** 本次会话中新发的公告（按发布顺序） */
let submitted = [];

/** 对已有公告的改判：_id → { status, actor, actedAt } */
let overrides = new Map();

/** 自增序号，保证同一会话内编号不重复 */
let sequence = 0;

/**
 * 需要逐层复制的字段。
 * 其余字段都是标量，浅拷贝就够了；但 publishTime 是 Date，浅拷贝会让
 * 台账与调用方共用同一个对象——外部随手 setFullYear 一下，台账里的
 * 发布时间就跟着变了。
 */
const DATE_FIELDS = ['publishTime'];

/**
 * 复制一条公告。
 * @param {Object} record
 * @returns {Object} 与入参不共享任何可变子对象的新记录
 */
function cloneAnnouncement(record) {
  const copy = { ...record };
  for (const field of DATE_FIELDS) {
    if (record[field] instanceof Date) copy[field] = new Date(record[field].getTime());
  }
  return copy;
}

/**
 * 分配下一个本地公告编号。
 * @returns {string} la0001、la0002……
 */
function nextId() {
  sequence += 1;
  return `${LOCAL_ID_PREFIX}${String(sequence).padStart(4, '0')}`;
}

/**
 * 记入一条新公告。
 *
 * 状态强制为「已发布」——发布即是发布，没有「草稿待审」这一环；
 * 发完想改口径只能下架，见 setStatus。
 *
 * @param {Object} draft buildAnnouncementRecord 给出的记录（不含 _id / status）
 * @returns {Object} 带 _id 与 status 的完整记录（副本，外部改不到内部）
 */
function addAnnouncement(draft) {
  // 进台账时复制一次，交出去时再复制一次：两次都省不得，否则调用方
  // 随后再动自己的草稿（或改返回值）都会渗进台账。
  const record = cloneAnnouncement({
    ...draft,
    _id: nextId(),
    status: ANNOUNCEMENT_STATUS.PUBLISHED,
  });
  submitted.push(record);
  return cloneAnnouncement(record);
}

/**
 * 取某条公告的改判记录。
 * @param {string} id
 * @returns {Object|null} 没有改判时返回 null
 */
function overrideOf(id) {
  const patch = overrides.get(id);
  return patch ? { ...patch } : null;
}

/**
 * 写入一条公告的改判。多次改判以最后一次为准（后一次在前一次之上合并）。
 *
 * @param {string} id
 * @param {Object} patch 至少含 status；下架还要带 actor、actedAt
 * @returns {Object} 合并后的改判
 */
function setStatus(id, patch) {
  const next = { ...(overrides.get(id) || {}), ...patch };
  overrides.set(id, next);
  return { ...next };
}

/**
 * 列出本次会话新发的公告（副本）。
 * @returns {Array<Object>}
 */
function listSubmitted() {
  return submitted.map(cloneAnnouncement);
}

/** 清空新增与改判，并复位编号。mock.resetCache() 会调用它。 */
function reset() {
  submitted = [];
  overrides = new Map();
  sequence = 0;
}

module.exports = {
  LOCAL_ID_PREFIX,
  nextId,
  addAnnouncement,
  overrideOf,
  setStatus,
  listSubmitted,
  reset,
};
