/**
 * 仓储接口约定
 * ============================================================
 * 业务逻辑（src/core/*）只认识这个接口，不认识微信云数据库。好处有二：
 *   1. 单元测试可以塞一个内存实现进去，不需要云环境、不需要凭据；
 *   2. 将来换数据库（云开发 → 自建）只改 adapters/ 一个文件。
 *
 * 【接口形状】
 *   repo.users.list()                   → Promise<Array<Object>>
 *   repo.users.getById(id)              → Promise<Object|null>
 *   repo.users.getByOpenId(openId)      → Promise<Object|null>
 *   repo.users.set(id, doc)             → Promise<void>   按 _id 整体写入（upsert）
 *   repo.matches.list()                 → Promise<Array<Object>>
 *   repo.matches.listByEvent(eid)       → Promise<Array<Object>>
 *   repo.matches.getById(id)            → Promise<Object|null>
 *   repo.matches.insert(doc)            → Promise<Object>  doc 必须自带 _id
 *   repo.matches.update(id, patch)      → Promise<void>    只改给定字段
 *   repo.events.list()                  → Promise<Array<Object>>
 *   repo.events.getById(id)             → Promise<Object|null>
 *   repo.events.insert(doc)             → Promise<Object>  doc 必须自带 _id
 *   repo.events.update(id, patch)       → Promise<void>    只改给定字段
 *   repo.eventSignups.list()            → Promise<Array<Object>>
 *   repo.eventSignups.listByEvent(eid)  → Promise<Array<Object>>
 *   repo.eventSignups.getById(id)       → Promise<Object|null>
 *   repo.eventSignups.insert(doc)       → Promise<Object>
 *   repo.eventSignups.update(id, patch) → Promise<void>
 *   repo.collegeEvents.list()           → Promise<Array<Object>>
 *   repo.collegeEvents.getById(id)      → Promise<Object|null>
 *   repo.collegeEvents.insert(doc)      → Promise<Object>  doc 必须自带 _id
 *   repo.collegeEvents.update(id, patch)→ Promise<void>
 *   repo.collegeEntries.list()          → Promise<Array<Object>>
 *   repo.collegeEntries.listByEvent(eid)→ Promise<Array<Object>>
 *   repo.collegeEntries.getById(id)     → Promise<Object|null>
 *   repo.collegeEntries.insert(doc)     → Promise<Object>
 *   repo.collegeEntries.update(id, patch)→ Promise<void>
 *   repo.ties.list()                    → Promise<Array<Object>>
 *   repo.ties.listByEvent(eid)          → Promise<Array<Object>>
 *   repo.ties.getById(id)               → Promise<Object|null>
 *   repo.ties.insert(doc)               → Promise<Object>  doc 必须自带 _id
 *   repo.ties.update(id, patch)         → Promise<void>
 *   repo.lineups.list()                 → Promise<Array<Object>>
 *   repo.lineups.listByEvent(eid)       → Promise<Array<Object>>
 *   repo.lineups.getById(id)            → Promise<Object|null>
 *   repo.lineups.insert(doc)            → Promise<Object>  doc 必须自带 _id
 *   repo.lineups.update(id, patch)      → Promise<void>
 *   repo.announcements.list()           → Promise<Array<Object>>
 *   repo.announcements.getById(id)      → Promise<Object|null>
 *   repo.announcements.insert(doc)      → Promise<Object>
 *   repo.announcements.update(id, patch)→ Promise<void>
 *   repo.seasons.get(id)                → Promise<Object|null>
 *   repo.seasons.set(id, doc)           → Promise<void>
 *   repo.rankings.get(id)               → Promise<Object|null>
 *   repo.rankings.set(id, doc)          → Promise<void>    排行榜快照（可随时删除的纯缓存）
 *   repo.transaction(fn)                → Promise<*>       fn(txRepo)，抛错则整体回滚
 *   repo.audit.append(entry)            → Promise<void>
 *
 * 【为什么写操作只给 set / update 两种形态】
 * 微信云开发的事务里，集合查询受限而 doc(id) 的读写稳定可靠。把写操作
 * 收敛成「按主键整体写」和「按主键改字段」，事务里就不必做集合查询，
 * 也就能安全地用事务隔离读写。去重靠把自然键直接当成 _id，而不是靠查询。
 * ============================================================
 */

const { COLLECTION } = require('../lib/utils/constants.js');

/** 逻辑名 → 集合名。集合名集中在 utils/constants.js 定义，便于迁移。 */
const COLLECTIONS = {
  users: COLLECTION.USERS,
  matches: COLLECTION.MATCHES,
  events: COLLECTION.EVENTS,
  eventSignups: COLLECTION.EVENT_SIGNUPS,
  collegeEvents: COLLECTION.COLLEGE_EVENTS,
  collegeEntries: COLLECTION.COLLEGE_ENTRIES,
  ties: COLLECTION.TIES,
  lineups: COLLECTION.COLLEGE_LINEUPS,
  announcements: COLLECTION.ANNOUNCEMENTS,
  seasons: COLLECTION.SEASONS,
  rankings: COLLECTION.RANKINGS,
  auditLogs: COLLECTION.AUDIT_LOGS,
};

module.exports = { COLLECTIONS };
