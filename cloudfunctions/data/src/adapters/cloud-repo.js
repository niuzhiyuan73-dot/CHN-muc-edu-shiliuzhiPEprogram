/**
 * 微信云开发仓储实现
 * ============================================================
 * 把 repository.js 约定的接口落到云数据库上。业务逻辑一行都不用知道
 * 这里存在——它只调用 repo.users.getById 这样的方法。
 *
 * 【为什么整表读取要分页】
 * 云开发单次查询默认只返回 20 条，上限 100 条。会员与比赛流水迟早会
 * 超过这个数，直接 .get() 一次就悄悄少读一段数据——等级分少算几场，
 * 而且不报错。所以按 100 条一页翻到底，取不满一页才停。
 *
 * 【为什么写操作都走 doc(id)】
 * 云开发的事务里不能做集合查询，只有按主键的读写稳定可用。恰好业务上
 * 的写都是「改一条已知 _id 的记录」（去重靠自然键当 _id，见 idempotency.js），
 * 于是这个限制反而把接口收得更干净。
 *
 * 【为什么 set 前要摘掉 _id】
 * doc(id).set({data}) 的 data 里不允许再出现 _id，带上会被拒。id 由
 * 文档路径给出，读回来时云开发会自己补上，语义不受影响。
 * ============================================================
 */

const { COLLECTIONS } = require('../repository.js');

/** 单页条数，取云开发云函数端的查询上限 */
const PAGE_SIZE = 100;

/**
 * 判断读失败是不是「文档不存在」。
 * 云开发把它当异常抛，但业务上等价于 null。
 * @param {Error} err
 * @returns {boolean}
 */
function isMissing(err) {
  if (!err) return false;
  const code = err.errCode !== undefined ? err.errCode : err.code;
  if (code === -1) return true;
  return /not exist/i.test(String(err.errMsg || err.message || ''));
}

/**
 * 按主键读一条，不存在返回 null。
 * @param {Object} scope db 或 transaction
 * @param {string} name 集合名
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function readDoc(scope, name, id) {
  try {
    const res = await scope.collection(name).doc(id).get();
    return (res && res.data) || null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * 整表读取，自动翻页。
 * @param {Object} scope db
 * @param {string} name 集合名
 * @returns {Promise<Array<Object>>}
 */
async function readAll(scope, name) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await scope.collection(name).skip(offset).limit(PAGE_SIZE).get();
    const batch = (res && res.data) || [];
    for (const doc of batch) out.push(doc);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/** 复制一份并去掉 _id */
function withoutId(doc) {
  const copy = { ...doc };
  delete copy._id;
  return copy;
}

/**
 * 带等值条件读取，自动翻页。
 * @param {Object} scope db
 * @param {string} name 集合名
 * @param {Object} where 等值条件
 * @returns {Promise<Array<Object>>}
 */
async function readWhere(scope, name, where) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await scope.collection(name).where(where).skip(offset).limit(PAGE_SIZE).get();
    const batch = (res && res.data) || [];
    for (const doc of batch) out.push(doc);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * 按同一个接口形状组装集合操作。
 *
 * @param {Object} scope db 或事务对象，两者都有 .collection()
 * @param {boolean} inTx 是否处于事务中（事务里不能整表读）
 * @returns {Object} 仓储
 */
function buildCollections(scope, inTx) {
  const col = (key) => scope.collection(COLLECTIONS[key]);

  const list = (key) => {
    // 事务里做集合查询会被云开发拒绝，报错晦涩。这里主动拦下并说清原因，
    // 免得后来人以为是数据库抽风。
    if (inTx) throw new Error(`事务内不允许整表读取（${key}），请改用 getById`);
    return readAll(scope, COLLECTIONS[key]);
  };

  return {
    users: {
      list: () => list('users'),
      getById: (id) => readDoc(scope, COLLECTIONS.users, id),
      getByOpenId: async (openId) => {
        if (!openId) return null;
        const res = await col('users').where({ openId }).limit(1).get();
        return (res && res.data && res.data[0]) || null;
      },
      set: (id, doc) => col('users').doc(id).set({ data: withoutId(doc) }),
    },

    matches: {
      list: () => list('matches'),
      getById: (id) => readDoc(scope, COLLECTIONS.matches, id),
      insert: (doc) => col('matches').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('matches').doc(id).update({ data: withoutId(patch) }),
    },

    events: {
      list: () => list('events'),
      getById: (id) => readDoc(scope, COLLECTIONS.events, id),
      insert: (doc) => col('events').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('events').doc(id).update({ data: withoutId(patch) }),
    },

    eventSignups: {
      list: () => list('eventSignups'),
      // 按赛事取报名名单：一场赛事的人数远在单页之内，但仍按同一套翻页
      // 办法实现，免得将来「一场比赛报了两百人」时静默少读一段。
      listByEvent: (eventId) => {
        if (inTx) throw new Error('事务内不允许条件读取（eventSignups），请改用 getById');
        return readWhere(scope, COLLECTIONS.eventSignups, { eventId });
      },
      getById: (id) => readDoc(scope, COLLECTIONS.eventSignups, id),
      insert: (doc) => col('eventSignups').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('eventSignups').doc(id).update({ data: withoutId(patch) }),
    },

    collegeEvents: {
      list: () => list('collegeEvents'),
      getById: (id) => readDoc(scope, COLLECTIONS.collegeEvents, id),
      insert: (doc) => col('collegeEvents').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('collegeEvents').doc(id).update({ data: withoutId(patch) }),
    },

    collegeEntries: {
      list: () => list('collegeEntries'),
      // 一场学院赛的名单按赛事过滤：与 eventSignups 同一套翻页办法
      listByEvent: (eventId) => {
        if (inTx) throw new Error('事务内不允许条件读取（collegeEntries），请改用 getById');
        return readWhere(scope, COLLECTIONS.collegeEntries, { eventId });
      },
      getById: (id) => readDoc(scope, COLLECTIONS.collegeEntries, id),
      insert: (doc) => col('collegeEntries').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('collegeEntries').doc(id).update({ data: withoutId(patch) }),
    },

    ties: {
      list: () => list('ties'),
      // 一场学院赛的大场数远在单页之内，但仍按同一套翻页办法实现
      listByEvent: (eventId) => {
        if (inTx) throw new Error('事务内不允许条件读取（ties），请改用 getById');
        return readWhere(scope, COLLECTIONS.ties, { eventId });
      },
      getById: (id) => readDoc(scope, COLLECTIONS.ties, id),
      insert: (doc) => col('ties').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('ties').doc(id).update({ data: withoutId(patch) }),
    },

    lineups: {
      list: () => list('lineups'),
      listByEvent: (eventId) => {
        if (inTx) throw new Error('事务内不允许条件读取（lineups），请改用 getById');
        return readWhere(scope, COLLECTIONS.lineups, { eventId });
      },
      getById: (id) => readDoc(scope, COLLECTIONS.lineups, id),
      insert: (doc) => col('lineups').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('lineups').doc(id).update({ data: withoutId(patch) }),
    },

    announcements: {
      list: () => list('announcements'),
      getById: (id) => readDoc(scope, COLLECTIONS.announcements, id),
      insert: (doc) => col('announcements').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('announcements').doc(id).update({ data: withoutId(patch) }),
    },

    seasons: {
      get: (id) => readDoc(scope, COLLECTIONS.seasons, id),
      set: (id, doc) => col('seasons').doc(id).set({ data: withoutId(doc) }),
    },

    audit: {
      append: (entry) => col('auditLogs').add({ data: withoutId(entry) }),
    },
  };
}

/**
 * 在真实的云数据库上建一个仓储。
 *
 * @param {Object} db cloud.database() 的返回值
 * @returns {Object} 仓储，含 transaction
 */
function createRepo(db) {
  const repo = buildCollections(db, false);

  repo.transaction = (fn) =>
    db.runTransaction(async (transaction) => fn(buildCollections(transaction, true)));

  return repo;
}

module.exports = { createRepo, PAGE_SIZE };
