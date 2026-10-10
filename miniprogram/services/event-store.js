/**
 * 本地赛事台账（仅内存）
 * ============================================================
 * mock 数据源原本只有种子里的 6 场已结束赛事，是只读的。P1 引入赛事闭环
 * 后，需要一处地方暂存两类写入：
 *   1. 本次会话新发布的赛事，以及对已有赛事的状态改判（开始 / 结束）；
 *   2. 会员的报名记录（报名 / 退赛 / 签到）。
 * 这里就是那块暂存区，与 match-store.js / announcement-store.js 是一套路数。
 *
 * 【为什么报名记录不删只改】
 * 取消报名只把状态置为「已取消」，重新报名再翻回同一条——同一人同一
 * 赛事永远只有一条记录。这样「报了多少人、退了多少人」有据可查，也不会
 * 因为连点两下报名而长出两条。键用「赛事编号 + 会员编号」直接拼成，
 * 与云端 idempotency.signupNaturalKey 是同一个思路。
 *
 * 【为什么保持「笨」】
 * 只负责存取，刻意不提供 applyTo(events) 这类合并函数。合并、过滤、
 * 名次怎么进回放是有讲究的——尤其是「只有已结束的赛事才发积分」这条
 * （见 replay.applyEventPoints）。那属于数据层的知识，一旦下沉到这里，
 * 最危险的约束就离使用现场太远。
 *
 * 【为什么 reset 要复位序号】
 * 测试里要能断言「第一场新发赛事的编号是 le0001」。序号只增不减的话，
 * 这条断言就会随用例执行顺序飘移，变成时而通过的坏测试。
 *
 * 【为什么按协会分桶】
 * 与 match-store 同理：每个协会各持一份独立的赛事台账，切换协会即切换
 * 整份台账。新增编号（le0001……）也随桶清零，于是两个协会各自都能从
 * le0001 起编——这正是「各协会功能完全一致、数据互不可见」的落地方式。
 *
 * 【纯内存】
 * 刻意不写 wx storage：这些是演示期的临时写入，重启即失效。上云后
 * 持久化由云函数负责，届时整个模块可以直接删掉。
 * ============================================================
 */

const { EVENT_STATUS, SIGNUP_STATUS } = require('../utils/constants.js');
const { perAssociation } = require('./association-scope.js');

/** 本地新增赛事的编号前缀。种子赛事是 e01…，不会撞号 */
const LOCAL_ID_PREFIX = 'le';

/**
 * 按协会分桶的赛事台账：每个协会各持一份「新发赛事 + 改判 + 报名 + 序号」。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({
  /** 本次会话中新发的赛事（按发布顺序） */
  submitted: [],
  /** 对已有赛事的改判：_id → { status, results, actor, actedAt, finishedAt } */
  overrides: new Map(),
  /** 报名记录：自然键 → 记录。自然键用「赛事|会员」直接拼，天然去重 */
  signups: new Map(),
  /** 自增序号，保证同一协会会话内编号不重复 */
  sequence: 0,
}));

/** 复制一条赛事，并逐层复制 results——否则外部改自己的数组会渗进台账 */
function cloneEvent(record) {
  const copy = { ...record };
  if (Array.isArray(record.results)) {
    copy.results = record.results.map((row) => ({ ...row }));
  }
  if (record.startTime instanceof Date) copy.startTime = new Date(record.startTime.getTime());
  return copy;
}

/** 复制一条报名记录，Date 字段逐层复制 */
function cloneSignup(record) {
  const copy = { ...record };
  if (record.signTime instanceof Date) copy.signTime = new Date(record.signTime.getTime());
  if (record.checkInTime instanceof Date) copy.checkInTime = new Date(record.checkInTime.getTime());
  return copy;
}

/**
 * 分配下一个本地赛事编号。
 * @returns {string} le0001、le0002……
 */
function nextId() {
  const bucket = state.current();
  bucket.sequence += 1;
  return `${LOCAL_ID_PREFIX}${String(bucket.sequence).padStart(4, '0')}`;
}

/**
 * 记入一场新赛事。状态强制为「报名中」——刚发布的赛事自然要能报名。
 *
 * @param {Object} draft buildEventRecord 给出的记录（不含 _id / status）
 * @returns {Object} 带 _id 与 status 的完整记录（副本，外部改不到内部）
 */
function addEvent(draft) {
  const record = cloneEvent({ ...draft, _id: nextId(), status: EVENT_STATUS.SIGNUP });
  state.current().submitted.push(record);
  return cloneEvent(record);
}

/**
 * 取某场赛事的改判记录。
 * @param {string} id
 * @returns {Object|null}
 */
function overrideOf(id) {
  const patch = state.current().overrides.get(id);
  return patch ? { ...patch } : null;
}

/**
 * 写入一场赛事的改判。多次改判以最后一次为准（后一次在前一次之上合并），
 * 于是「先开始、再结束」不会丢掉开始时间。
 *
 * @param {string} id
 * @param {Object} patch 至少含 status；结束还要带 results、finishedAt
 * @returns {Object} 合并后的改判
 */
function setStatus(id, patch) {
  const bucket = state.current();
  const next = { ...(bucket.overrides.get(id) || {}), ...patch };
  bucket.overrides.set(id, next);
  return { ...next };
}

/**
 * 列出本次会话新发的赛事（副本）。
 * @returns {Array<Object>}
 */
function listSubmitted() {
  return state.current().submitted.map(cloneEvent);
}

/* ---------- 报名记录 ---------- */

/** 报名记录的自然键：同一人同一赛事恒为一条 */
function signupKey(eventId, userId) {
  return `${eventId}|${userId}`;
}

/**
 * 取某位会员在某场赛事的报名记录。
 * @param {string} eventId
 * @param {string} userId
 * @returns {Object|null}
 */
function findSignup(eventId, userId) {
  const record = state.current().signups.get(signupKey(eventId, userId));
  return record ? cloneSignup(record) : null;
}

/**
 * 列出报名记录。给了 eventId 就只列那一场。
 * @param {string} [eventId]
 * @returns {Array<Object>}
 */
function listSignups(eventId) {
  const all = [...state.current().signups.values()].map(cloneSignup);
  return eventId ? all.filter((item) => item.eventId === eventId) : all;
}

/**
 * 写入一条报名记录（新增或整条覆盖）。
 *
 * 整条覆盖而非改字段，是为了让「取消后重新报名」能一次把 signTime、
 * checkInTime、actorId 全部刷新，不会残留上一次签到的痕迹。
 *
 * @param {Object} record 需含 eventId / userId
 * @returns {Object} 落库后的副本
 */
function saveSignup(record) {
  const stored = cloneSignup({ ...record });
  state.current().signups.set(signupKey(record.eventId, record.userId), stored);
  return cloneSignup(stored);
}

/** 清空全部协会的新增、改判与报名，并复位编号。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = {
  LOCAL_ID_PREFIX,
  SIGNUP_STATUS,
  nextId,
  addEvent,
  overrideOf,
  setStatus,
  listSubmitted,
  signupKey,
  findSignup,
  listSignups,
  saveSignup,
  reset,
};
