/**
 * 本地学院赛台账（仅内存）
 * ============================================================
 * 学院赛与个人赛并行，但两者不共用集合：学院赛本体落 college_events，
 * 各学院名单落 college_entries，大场与排阵落 ties / lineups
 * （见「学院赛设计方案」2.3）。这里就是这几份数据在本地演示期的暂存区，
 * 与 event-store.js 是一套路数。
 *
 * 【为什么不进 buildCache】
 * 个人赛要进回放（等级决定 K 值、名次发积分），所以必须拼进缓存再回放。
 * 学院赛目前只是一个「发布 + 收名单 + 抽签 + 排阵」的壳，既不算等级分也不算
 * 积分，不参与回放，因此直接从台账读，与报名记录同一处理（见 getEventSignups）。
 *
 * 【名单为什么用「赛事 + 学院」当主键】
 * 同一赛事同一学院只有一份有效名单（D10），键直接由这两者拼成，重复提交
 * 天然覆盖同一条，不需要再写一套去重逻辑。这与云端
 * idempotency.collegeEntryNaturalKey 是同一个思路，只是本地不做哈希。
 * 排阵同理：同一大场同一学院只有一份（lineupKey）。
 *
 * 【为什么 reset 要复位序号】
 * 与 event-store 同理：测试里要能断言「第一场新发的学院赛是 lce0001」，
 * 序号只增不减的话，这条断言会随用例执行顺序飘移。
 *
 * 【为什么按协会分桶】
 * 与 event-store 同理：每个协会各持一份独立的学院赛台账，切换协会即切换
 * 整份台账。新增编号（lce0001……）也随桶清零，两个协会各自从 lce0001 起编。
 *
 * 【纯内存】
 * 刻意不写 wx storage：这些是演示期的临时写入，重启即失效。上云后
 * 持久化由云函数负责，届时整个模块可以直接删掉。
 * ============================================================
 */

const { COLLEGE_EVENT_STATUS } = require('../utils/constants.js');
const { lineupKey } = require('./college-lineup.js');
const { perAssociation } = require('./association-scope.js');

/** 本地新增学院赛的编号前缀 */
const LOCAL_EVENT_ID_PREFIX = 'lce';
/** 名单主键前缀。用「赛事 + 学院」拼成，天然一院一份 */
const ENTRY_ID_PREFIX = 'cen';

/**
 * 按协会分桶的学院赛台账：每个协会各持一份「学院赛 + 名单 + 大场 + 排阵 + 序号」。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({
  /** 本次会话新发的学院赛（按发布顺序） */
  events: [],
  /** 自增序号，保证同一协会会话内编号不重复 */
  sequence: 0,
  /** 名单台账：_id → 记录 */
  entries: new Map(),
  /** 大场台账：_id → 记录 */
  ties: new Map(),
  /** 排阵台账：_id → 记录 */
  lineups: new Map(),
}));

/** 逐层复制日期，外部改自己的对象渗不进台账 */
function copyDate(value) {
  return value instanceof Date ? new Date(value.getTime()) : value;
}

/** 复制一场学院赛；数组、签表与日期都逐层复制 */
function cloneEvent(record) {
  const copy = { ...record };
  if (record.startTime instanceof Date) copy.startTime = new Date(record.startTime.getTime());
  if (record.publishTime instanceof Date) copy.publishTime = new Date(record.publishTime.getTime());
  copy.legPlan = Array.isArray(record.legPlan) ? record.legPlan.slice() : [];
  copy.seedColleges = Array.isArray(record.seedColleges) ? record.seedColleges.slice() : [];
  copy.results = Array.isArray(record.results) ? record.results.map((row) => ({ ...row })) : [];
  copy.draw = record.draw ? cloneDraw(record.draw) : record.draw;
  return copy;
}

/** 复制签表；slots / seeds / byes 都是数组 */
function cloneDraw(draw) {
  const copy = { ...draw };
  copy.slots = Array.isArray(draw.slots) ? draw.slots.slice() : [];
  copy.seeds = Array.isArray(draw.seeds) ? draw.seeds.slice() : [];
  copy.byes = Array.isArray(draw.byes) ? draw.byes.slice() : [];
  copy.drawnAt = copyDate(draw.drawnAt);
  return copy;
}

/** 复制一份名单；队员数组与日期都逐层复制 */
function cloneEntry(record) {
  const copy = { ...record };
  copy.members = Array.isArray(record.members) ? record.members.slice() : [];
  copy.submitTime = copyDate(record.submitTime);
  copy.reviewedAt = copyDate(record.reviewedAt);
  return copy;
}

/** 复制一个大场；小项数组逐层复制 */
function cloneTie(record) {
  const copy = { ...record };
  copy.legs = Array.isArray(record.legs) ? record.legs.map((leg) => ({ ...leg })) : [];
  copy.startedAt = copyDate(record.startedAt);
  copy.finishedAt = copyDate(record.finishedAt);
  return copy;
}

/** 复制一份排阵；小项与出场人数组逐层复制 */
function cloneLineup(record) {
  const copy = { ...record };
  copy.entries = Array.isArray(record.entries)
    ? record.entries.map((row) => ({ ...row, players: Array.isArray(row.players) ? row.players.slice() : [] }))
    : [];
  copy.submitTime = copyDate(record.submitTime);
  return copy;
}

/**
 * 分配下一个本地学院赛编号。
 * @returns {string} lce0001、lce0002……
 */
function nextEventId() {
  const bucket = state.current();
  bucket.sequence += 1;
  return `${LOCAL_EVENT_ID_PREFIX}${String(bucket.sequence).padStart(4, '0')}`;
}

/**
 * 记入一场新学院赛。状态强制为「报名中」——刚发布的赛事自然要能收名单。
 *
 * @param {Object} draft buildCollegeEventRecord 给出的记录（不含 _id）
 * @returns {Object} 带 _id 的完整记录（副本）
 */
function addEvent(draft) {
  const record = cloneEvent({ ...draft, _id: nextEventId() });
  state.current().events.push(record);
  return cloneEvent(record);
}

/**
 * 列出本次会话新发的学院赛（副本）。
 * @returns {Array<Object>}
 */
function listEvents() {
  return state.current().events.map(cloneEvent);
}

/**
 * 取一场学院赛。
 * @param {string} id
 * @returns {Object|null}
 */
function findEvent(id) {
  const hit = state.current().events.find((item) => item._id === id);
  return hit ? cloneEvent(hit) : null;
}

/**
 * 改一场学院赛的字段（抽签落签表、开赛推进状态、结束登记名次）。
 * @param {string} id
 * @param {Object} patch
 * @returns {Object|null}
 */
function updateEvent(id, patch) {
  const bucket = state.current();
  const index = bucket.events.findIndex((item) => item._id === id);
  if (index < 0) return null;
  bucket.events[index] = { ...bucket.events[index], ...patch };
  return cloneEvent(bucket.events[index]);
}

/* ---------- 名单 ---------- */

/** 名单主键：同一赛事同一学院恒为一条 */
function entryId(eventId, college) {
  return `${ENTRY_ID_PREFIX}_${eventId}_${college}`;
}

/**
 * 取某学院在某场学院赛的名单。
 * @param {string} eventId
 * @param {string} college
 * @returns {Object|null}
 */
function findEntry(eventId, college) {
  const record = state.current().entries.get(entryId(eventId, college));
  return record ? cloneEntry(record) : null;
}

/**
 * 按主键取名单（审核入口用）。
 * @param {string} id
 * @returns {Object|null}
 */
function findEntryById(id) {
  const record = state.current().entries.get(id);
  return record ? cloneEntry(record) : null;
}

/**
 * 列出名单。给了 eventId 就只列那一场的。
 * @param {string} [eventId]
 * @returns {Array<Object>}
 */
function listEntries(eventId) {
  const all = [...state.current().entries.values()].map(cloneEntry);
  return eventId ? all.filter((item) => item.eventId === eventId) : all;
}

/**
 * 写入一份名单（新增或整条覆盖）。主键由「赛事 + 学院」决定，
 * 重复提交自然覆盖同一条。
 *
 * @param {Object} draft 需含 eventId / college
 * @returns {Object} 落库后的副本
 */
function saveEntry(draft) {
  const id = entryId(draft.eventId, draft.college);
  const stored = cloneEntry({ ...draft, _id: id });
  state.current().entries.set(id, stored);
  return cloneEntry(stored);
}

/**
 * 改名单的字段（审核通过 / 退回）。
 * @param {string} id
 * @param {Object} patch
 * @returns {Object|null}
 */
function updateEntry(id, patch) {
  const bucket = state.current();
  const current = bucket.entries.get(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  bucket.entries.set(id, next);
  return cloneEntry(next);
}

/* ---------- 大场 ---------- */

/**
 * 批量写入某轮的大场。主键由签位决定（college-tie.collegeTieKey），
 * 重复开赛 / 重抽时按 _id 覆盖，不会堆出两批首轮。
 *
 * @param {Array<Object>} draftList
 * @returns {Array<Object>} 落库后的副本
 */
function saveTies(draftList) {
  const bucket = state.current();
  const saved = [];
  for (const draft of Array.isArray(draftList) ? draftList : []) {
    const stored = cloneTie(draft);
    bucket.ties.set(stored._id, stored);
    saved.push(cloneTie(stored));
  }
  return saved;
}

/**
 * 列出大场。给了 eventId 就只列那一场的，并按轮次、签位排序。
 * @param {string} [eventId]
 * @returns {Array<Object>}
 */
function listTies(eventId) {
  const all = [...state.current().ties.values()].map(cloneTie);
  const filtered = eventId ? all.filter((item) => item.eventId === eventId) : all;
  return filtered.sort((a, b) => (a.round - b.round) || (a.slot - b.slot));
}

/**
 * 取一个大场。
 * @param {string} id
 * @returns {Object|null}
 */
function findTie(id) {
  const record = state.current().ties.get(id);
  return record ? cloneTie(record) : null;
}

/**
 * 改大场的字段（排阵到位、开始、结束）。
 * @param {string} id
 * @param {Object} patch
 * @returns {Object|null}
 */
function updateTie(id, patch) {
  const bucket = state.current();
  const current = bucket.ties.get(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  bucket.ties.set(id, next);
  return cloneTie(next);
}

/* ---------- 排阵 ---------- */

/**
 * 取某学院在某大场的排阵。
 * @param {string} tieId
 * @param {string} college
 * @returns {Object|null}
 */
function findLineup(tieId, college) {
  const record = state.current().lineups.get(lineupKey(tieId, college));
  return record ? cloneLineup(record) : null;
}

/**
 * 列出排阵。给了 eventId 就只列那一场的。
 * @param {string} [eventId]
 * @returns {Array<Object>}
 */
function listLineups(eventId) {
  const all = [...state.current().lineups.values()].map(cloneLineup);
  return eventId ? all.filter((item) => item.eventId === eventId) : all;
}

/**
 * 写入一份排阵（新增或整条覆盖）。主键由「大场 + 学院」决定，
 * 改后重交（含换替补）自然覆盖同一条。
 *
 * @param {Object} draft 需含 tieId / college
 * @returns {Object} 落库后的副本
 */
function saveLineup(draft) {
  const id = lineupKey(draft.tieId, draft.college);
  const stored = cloneLineup({ ...draft, _id: id });
  state.current().lineups.set(id, stored);
  return cloneLineup(stored);
}

/** 清空全部协会的学院赛、名单、大场与排阵，并复位编号。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = {
  LOCAL_EVENT_ID_PREFIX,
  COLLEGE_EVENT_STATUS,
  nextEventId,
  addEvent,
  listEvents,
  findEvent,
  updateEvent,
  entryId,
  findEntry,
  findEntryById,
  listEntries,
  saveEntry,
  updateEntry,
  saveTies,
  listTies,
  findTie,
  updateTie,
  findLineup,
  listLineups,
  saveLineup,
  reset,
};
