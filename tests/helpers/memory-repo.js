/**
 * 内存仓储（仅测试用）
 * ============================================================
 * 实现 cloudfunctions/data/src/repository.js 约定的接口，但数据放在 Map 里。
 * 有了它，云函数的核心逻辑不需要云环境、不需要凭据、不需要网络就能测——
 * 这是当初把业务逻辑与 wx-server-sdk 隔开的全部回报。
 *
 * 【事务怎么模拟】
 * 微信云开发的事务提供「读已提交 + 冲突重试」。这里不需要那么真：
 * 事务开始时把每个集合作一份浅拷贝当作草稿本，处理器在草稿本上读写；
 * 正常返回就把草稿本换回仓库，抛错就整份丢掉。
 *
 * 浅拷贝是安全的：处理器从不就地修改读到的文档，一律 spread 出新的
 * （cloud-repo.js 那边也是同样的纪律，因为云开发的事务也要求这样）。
 *
 * 【为什么 set 要补上 _id】
 * 云开发按 doc(id) 写入时 id 来自路径，文档里不存 _id 字段，读回来时
 * 由 SDK 补上。内存版没有路径这一层，于是在写入时补，读出来才一致。
 * ============================================================
 */

/** 浅拷贝一条文档。null / 原始值原样返回。 */
function clone(doc) {
  return doc === null || typeof doc !== 'object' ? doc : { ...doc };
}

/**
 * 每个集合的形状：有 _id 的用 Map 存，纯追加日志用数组。
 * 键名与 repository.js 里的逻辑名一致。
 */
function emptyStore() {
  return {
    users: new Map(),
    matches: new Map(),
    events: new Map(),
    eventSignups: new Map(),
    collegeEvents: new Map(),
    collegeEntries: new Map(),
    ties: new Map(),
    lineups: new Map(),
    announcements: new Map(),
    seasons: new Map(),
    auditLogs: [],
  };
}

/**
 * 建一个内存仓储。
 *
 * @param {Object} [seed] { users, matches, events, announcements, seasons }，均为文档数组
 * @returns {Object} 仓储
 */
function createMemoryRepo(seed = {}) {
  const store = emptyStore();

  for (const key of Object.keys(store)) {
    const docs = seed[key];
    if (!docs) continue;
    if (key === 'auditLogs') {
      store[key] = docs.map(clone);
      continue;
    }
    for (const doc of docs) store[key].set(doc._id, clone(doc));
  }

  /**
   * 在某个目标上组装集合操作。目标可以是真仓库，也可以是事务草稿本。
   * @param {Object} target
   * @param {boolean} inTx
   */
  function collections(target, inTx) {
    const list = (key) => {
      if (inTx) throw new Error(`事务内不允许整表读取（${key}），请改用 getById`);
      return [...target[key].values()].map(clone);
    };

    const read = (key, id) => {
      const doc = target[key].get(id);
      return Promise.resolve(doc ? clone(doc) : null);
    };

    return {
      users: {
        list: () => list('users'),
        getById: (id) => read('users', id),
        getByOpenId: async (openId) => {
          if (!openId) return null;
          for (const doc of target.users.values()) {
            if (doc.openId === openId) return clone(doc);
          }
          return null;
        },
        set: async (id, doc) => {
          target.users.set(id, { ...doc, _id: id });
        },
      },

      matches: {
        list: () => list('matches'),
        getById: (id) => read('matches', id),
        insert: async (doc) => {
          target.matches.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.matches.get(id);
          if (!current) throw new Error(`更新失败：找不到比赛 ${id}`);
          target.matches.set(id, { ...current, ...patch });
        },
      },

      events: {
        list: () => list('events'),
        getById: (id) => read('events', id),
        insert: async (doc) => {
          target.events.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.events.get(id);
          if (!current) throw new Error(`更新失败：找不到赛事 ${id}`);
          target.events.set(id, { ...current, ...patch });
        },
      },

      eventSignups: {
        list: () => list('eventSignups'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（eventSignups），请改用 getById');
          return [...target.eventSignups.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('eventSignups', id),
        insert: async (doc) => {
          target.eventSignups.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.eventSignups.get(id);
          if (!current) throw new Error(`更新失败：找不到报名记录 ${id}`);
          target.eventSignups.set(id, { ...current, ...patch });
        },
      },

      collegeEvents: {
        list: () => list('collegeEvents'),
        getById: (id) => read('collegeEvents', id),
        insert: async (doc) => {
          target.collegeEvents.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.collegeEvents.get(id);
          if (!current) throw new Error(`更新失败：找不到学院赛 ${id}`);
          target.collegeEvents.set(id, { ...current, ...patch });
        },
      },

      collegeEntries: {
        list: () => list('collegeEntries'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（collegeEntries），请改用 getById');
          return [...target.collegeEntries.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('collegeEntries', id),
        insert: async (doc) => {
          target.collegeEntries.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.collegeEntries.get(id);
          if (!current) throw new Error(`更新失败：找不到学院名单 ${id}`);
          target.collegeEntries.set(id, { ...current, ...patch });
        },
      },

      ties: {
        list: () => list('ties'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（ties），请改用 getById');
          return [...target.ties.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('ties', id),
        insert: async (doc) => {
          target.ties.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.ties.get(id);
          if (!current) throw new Error(`更新失败：找不到大场 ${id}`);
          target.ties.set(id, { ...current, ...patch });
        },
      },

      lineups: {
        list: () => list('lineups'),
        listByEvent: (eventId) => {
          if (inTx) throw new Error('事务内不允许条件读取（lineups），请改用 getById');
          return [...target.lineups.values()]
            .filter((doc) => doc.eventId === eventId)
            .map(clone);
        },
        getById: (id) => read('lineups', id),
        insert: async (doc) => {
          target.lineups.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.lineups.get(id);
          if (!current) throw new Error(`更新失败：找不到排阵 ${id}`);
          target.lineups.set(id, { ...current, ...patch });
        },
      },

      announcements: {
        list: () => list('announcements'),
        getById: (id) => read('announcements', id),
        insert: async (doc) => {
          target.announcements.set(doc._id, clone(doc));
        },
        update: async (id, patch) => {
          const current = target.announcements.get(id);
          if (!current) throw new Error(`更新失败：找不到公告 ${id}`);
          target.announcements.set(id, { ...current, ...patch });
        },
      },

      seasons: {
        get: (id) => read('seasons', id),
        set: async (id, doc) => {
          target.seasons.set(id, { ...doc, _id: id });
        },
      },

      audit: {
        append: async (entry) => {
          target.auditLogs.push(clone(entry));
        },
      },
    };
  }

  const repo = collections(store, false);

  repo.transaction = async (fn) => {
    const scratch = emptyStore();
    for (const key of Object.keys(scratch)) {
      scratch[key] = key === 'auditLogs' ? [...store[key]] : new Map(store[key]);
    }

    const result = await fn(collections(scratch, true));

    // 走到这里说明没抛错，草稿本整体生效
    for (const key of Object.keys(store)) store[key] = scratch[key];
    return result;
  };

  return repo;
}

module.exports = { createMemoryRepo };
