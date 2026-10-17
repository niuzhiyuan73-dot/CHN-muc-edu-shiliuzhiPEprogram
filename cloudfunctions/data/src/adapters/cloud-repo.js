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
const { attachSchoolRepository } = require('../school-repository.js');

/** 单页条数，取云开发云函数端的查询上限 */
const PAGE_SIZE = 100;

/** 单次整表读超过这个条数就告警：云端每翻一页是一次 RPC，深翻页同时放大耗时与读配额 */
const DEEP_READ_WARN = 500;

/**
 * 事务写入预算：云数据库事务的操作数上限**未公示**（社区实践约 100 个写/事务，
 * 超限时整个事务报错且文案晦涩）。超过预算当场抛出可操作的中文错误——失败得早、
 * 失败得明白；没超则一切照旧。可用环境变量 TX_WRITE_BUDGET 调整（真机验收校准后）。
 */
const TX_WRITE_BUDGET = Number(process.env.TX_WRITE_BUDGET) > 0 ? Number(process.env.TX_WRITE_BUDGET) : 200;

/** 单事务写操作超过这个数就留痕：真机验收时用来核对云端到底能吃多少 */
const TX_WARN_WRITES = Number(process.env.TX_WARN_WRITES) > 0 ? Number(process.env.TX_WARN_WRITES) : 50;

/**
 * 是不是「集合不存在」。
 *
 * 官方错误码 -502005，errMsg 形如 `database collection not exists` 或
 * `[ResourceNotFound] Db or Table not exist`。它**不是**「文档不存在」——
 * 旧实现用 /not exist/i 一把抓，把少建集合读成了空结果（审计 C3）。
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isMissingCollection(err) {
  if (!err) return false;
  const code = err.errCode !== undefined ? err.errCode : err.code;
  const msg = String(err.errMsg || err.message || '');
  return code === -502005 || /collection|db or table/i.test(msg);
}

/**
 * 判断读失败是不是「文档不存在」。
 * 云开发把它当异常抛，但业务上等价于 null。
 *
 * 【集合不存在为什么必须排除在外】（2026-10-17 只读审计 C3）
 * -502005 的 errMsg 同样含 "not exist"，旧正则把它和文档不存在混为一谈：
 * 少建一个集合时，读路径静默返回 null/空（表现为「账号不存在」「学校不存在或
 * 已停用」「榜单为空」），排查方向被彻底带偏；只有写路径才炸。集合不存在必须
 * 响亮地失败，让控制台日志里一眼可辨。
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isMissingDoc(err) {
  if (!err) return false;
  if (isMissingCollection(err)) return false;
  const code = err.errCode !== undefined ? err.errCode : err.code;
  if (code === -1) return true;
  return /not exist/i.test(String(err.errMsg || err.message || ''));
}

/**
 * 按主键读一条，不存在返回 null。
 *
 * 集合不存在时不降级成 null，而是抛一句可操作的中文错误：README §三 要求建齐
 * 30 个集合，少建任何一个都该在云端日志里写明是哪个集合，而不是让业务层把
 * 「集合没建」当成「这条数据没有」继续演下去。
 *
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
    if (isMissingDoc(err)) return null;
    if (isMissingCollection(err)) {
      throw new Error(`数据库集合 ${name} 不存在（错误码 -502005）：请先在云开发控制台按 README §三 建齐全部集合`);
    }
    throw err;
  }
}

/**
 * 整表读取，自动翻页。
 *
 * 【翻页为什么必须带 orderBy】
 * skip/limit 是「先排序、再切一段」。不指定顺序时，数据库给出的次序没有
 * 任何保证，两次翻页之间若有人写入（或本就无序），第 2 页可能与第 1 页
 * 重叠、也可能整条漏掉。台账漏一条，等级分就少算一场，且查不出原因。
 * 按 _id 升序是唯一稳定且不依赖业务字段的排法。
 *
 * @param {Object} scope db
 * @param {string} name 集合名
 * @returns {Promise<Array<Object>>}
 */
async function readAll(scope, name) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await scope
      .collection(name)
      .orderBy('_id', 'asc')
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const batch = (res && res.data) || [];
    for (const doc of batch) out.push(doc);
    if (batch.length < PAGE_SIZE) break;
  }
  // 云端每翻一页就是一次 RPC：深翻页同时放大单次耗时（默认 3 秒超时的大头）
  // 与每日读配额（官方 5 万次/天）。超过阈值留痕，真机验收时按日志定位慢在哪。
  if (out.length >= DEEP_READ_WARN) {
    console.warn(`[data] 深翻页告警：${name} 单次读 ${out.length} 条（${Math.ceil(out.length / PAGE_SIZE)} 页 RPC），请考虑加范围条件或批读接口`);
  }
  return out;
}

/**
 * 写库前的规格化：深拷贝、Date → ISO 绝对串、去掉值为 undefined 的字段。
 *
 * 【为什么在仓储层收口，而不是逐个调用点改】（2026-10-17 只读审计 C9）
 * 业务层有的写 iso 串、有的直接写 Date 对象（小组 / 跨校邀请赛 / 身份 / 实时
 * 比分的时间戳）。云数据库按 BSON 类型落库——同一个字段两种类型，控制台里排序
 * 与聚合按类型分段，将来任何 orderBy 落到时间字段都会静默错序。仓储是**全部**
 * 写操作的唯一必经之路（set / insert / update / audit.append 都经过 withoutId），
 * 在这里收口一次，胜过追着几十个调用点改，也不依赖将来每个新调用点记得转换。
 * 读路径一律 `new Date(x)`，串与 Date 都吃，故读侧无需配套改动。
 *
 * 【为什么顺手去掉 undefined】
 * 内存仓储原样保留 `field: undefined`；云数据库对 undefined 的处理（报错 /
 * 丢弃 / 存 null）没有真机验证过。统一去掉后两种仓储的可见字段集一致，也免得
 * 将来真机上冒出一个与业务无关的序列化错误。
 *
 * @param {*} value 任意文档 / 补丁 / 审计条目
 * @returns {*} 规格化后的深拷贝
 */
function stripForStorage(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stripForStorage);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = stripForStorage(item);
    }
    return out;
  }
  return value;
}

/** 复制一份、去掉 _id，并把时间规格成 ISO 串（见 stripForStorage）。 */
function withoutId(doc) {
  const copy = stripForStorage(doc);
  delete copy._id;
  return copy;
}

/**
 * 带等值条件读取，自动翻页。翻页同理必须带 orderBy（见 readAll）。
 * @param {Object} scope db
 * @param {string} name 集合名
 * @param {Object} where 等值条件
 * @returns {Promise<Array<Object>>}
 */
async function readWhere(scope, name, where) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await scope
      .collection(name)
      .where(where)
      .orderBy('_id', 'asc')
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const batch = (res && res.data) || [];
    for (const doc of batch) out.push(doc);
    if (batch.length < PAGE_SIZE) break;
  }
  if (out.length >= DEEP_READ_WARN) {
    console.warn(`[data] 深翻页告警：${name}（条件 ${JSON.stringify(where)}）单次读 ${out.length} 条（${Math.ceil(out.length / PAGE_SIZE)} 页 RPC）`);
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

  const repo = {
    users: {
      list: () => list('users'),
      getById: (id) => readDoc(scope, COLLECTIONS.users, id),
      // 【为什么必须带 orderBy】同一个 OpenID 可能留下两条账号（旧协议 `u_…`
      // 与协议 2 `acc:…` 两套编号并存，见 2026-10-16 只读审计 H5/P1）。不加
      // orderBy 时数据库返回哪一条**不确定**，表现为「注册过却进不去」「榜单里
      // 没有我」，且不可复现。这里与 readAll / readWhere 同一理由，按 _id 升序
      // 取定：结果变成确定的、可测试的。真正把两套编号合一见 idempotency.js。
      getByOpenId: async (openId) => {
        if (!openId) return null;
        const res = await col('users')
          .where({ openId })
          .orderBy('_id', 'asc')
          .limit(1)
          .get();
        return (res && res.data && res.data[0]) || null;
      },
      set: (id, doc) => col('users').doc(id).set({ data: withoutId(doc) }),
    },

    matches: {
      list: () => list('matches'),
      // 按赛事取比赛：抽签时会先在数据集里看过一遍全表，再单独取该赛事的
      // 比赛入签表。走条件查询，省掉一次整表翻页。
      listByEvent: (eventId) => {
        if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
        return readWhere(scope, COLLECTIONS.matches, { eventId });
      },
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

    // 实时比分：一场一条，_id = 'ls_' + matchId。轮询按编号逐条读。
    // list 也照三件套补上（见下方补齐循环）——业务目前不整表读，但两个适配器
    // 的接口形状必须一致，否则「本地能跑、云端 TypeError」还会再犯。
    liveScores: {
      getById: (id) => readDoc(scope, COLLECTIONS.liveScores, id),
      insert: (doc) => col('liveScores').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('liveScores').doc(id).update({ data: withoutId(patch) }),
    },

    announcements: {
      list: () => list('announcements'),
      getById: (id) => readDoc(scope, COLLECTIONS.announcements, id),
      insert: (doc) => col('announcements').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('announcements').doc(id).update({ data: withoutId(patch) }),
    },

    // 按协会的高配角色行（无行 = 普通会员，见施工方案 §3.2）。只在任免
    // 学院负责人 / 协会负责人时按自然键写一行或删一行，没有整表读的需求。
    memberships: {
      list: () => list('memberships'),
      listByUser: (userId) => {
        if (inTx) throw new Error('事务内不允许条件读取（memberships），请改用 get');
        return readWhere(scope, COLLECTIONS.memberships, { userId });
      },
      get: (id) => readDoc(scope, COLLECTIONS.memberships, id),
      set: (id, doc) => col('memberships').doc(id).set({ data: withoutId(doc) }),
      remove: (id) => col('memberships').doc(id).remove(),
    },

    seasons: {
      get: (id) => readDoc(scope, COLLECTIONS.seasons, id),
      set: (id, doc) => col('seasons').doc(id).set({ data: withoutId(doc) }),
    },

    rankings: {
      get: (id) => readDoc(scope, COLLECTIONS.rankings, id),
      set: (id, doc) => col('rankings').doc(id).set({ data: withoutId(doc) }),
    },

    audit: {
      append: (entry) => entry._id
        ? col('auditLogs').doc(entry._id).set({ data: withoutId(entry) })
        : col('auditLogs').add({ data: withoutId(entry) }),
    },
  };
  // ── 三件套补齐 ────────────────────────────────────────────────
  // 本地 mock 仓储（miniprogram/services/school-memory-repo.js）对**每个**集合都
  // 提供 getById / set / list 一整套；上面这份手写实现却只给一部分集合定义了
  // set（另有 insert / update）。而共享服务（lib/services/**，与
  // miniprogram/services/** 逐字节同源）大量这么写：
  //
  //     ctx.repo.transaction(async tx => { await tx.events.set(id, doc) })
  //
  // 于是同一个动作在 mock 下全绿、在云端抛 `tx.events.set is not a function`，
  // 被 index.js 兜成「服务异常，请稍后再试」——2026-10-16 的只读审计就是这么
  // 发现整条云端写入链全断的（本地测试全注入内存仓储，照不出来）。
  //
  // 这里把三件套补齐：**已有实现优先保留**（`...repo[key]` 在后覆盖同名方法，
  // 语义与顺序都不变），缺什么补什么，让两套仓储可互换。清单与 mock 的 KEYS
  // 对应，由 tests/cloud-repo-contract.test.js 守护，不要再靠人比对。
  for (const key of ['users', 'schools', 'schoolAssociations', 'colleges', 'schoolMembers',
    'schoolRoles', 'memberships', 'studentIdClaims', 'auditLogs',
    'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
    'associationGroups', 'associationGroupMembers',
    'associationNotices', 'associationTrainings', 'trainingRegistrations',
    'announcements', 'events', 'eventSignups', 'matches', 'liveScores',
    'collegeEvents', 'collegeEntries', 'ties', 'lineups', 'seasons', 'pairCounts']) {
    repo[key] = {
      getById: (id) => readDoc(scope, COLLECTIONS[key], id),
      set: (id, doc) => col(key).doc(id).set({ data: withoutId(doc) }),
      list: () => list(key),
      ...repo[key],
    };
  }

  return attachSchoolRepository(repo, {
    read: (key, id) => readDoc(scope, COLLECTIONS[key], id),
    set: (key, id, doc) => col(key).doc(id).set({ data: withoutId(doc) }),
    query: (key, where) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      return readWhere(scope, COLLECTIONS[key], where);
    },
  }, inTx);
}

/**
 * 给事务对象套一层「操作计数」。
 *
 * 【为什么需要它】（2026-10-17 只读审计 C4）
 * 云数据库事务「只允许单记录操作，可以在一个事务中对多个记录进行操作」，
 * 但**操作数上限未公示**（社区实践约 100 个写/事务）。代码里存在按参与人数
 * 在单事务内循环写的路径：建小组（50 成员 = 53 写 + 约 106 读）、学院赛抽签
 * （64 队 = 67 写）、锁定跨校名单（100 报名 = 202 写）。本地内存仓储无任何
 * 上限，测试永远全绿；云端超限时整个事务报错、文案晦涩，用户只看到
 * 「服务异常，请稍后再试」。
 *
 * 这里的对策分两层：
 *   1. 写操作超过 TX_WRITE_BUDGET 当场抛出可操作的中文错误（失败得早、失败得
 *      明白）；预算可用环境变量调整，真机验收校准后按实际值收紧；
 *   2. 写操作超过 TX_WARN_WRITES 留痕告警——给真机验收一份「哪些事务在临界」
 *      的清单，避免将来悄悄长到云端上限。
 *
 * 计数只包事务路径；非事务的 db 直读直写不经过这里，不计入。
 *
 * @param {Object} transaction db.runTransaction 回调收到的事务对象
 * @returns {{stats:{writes:number,reads:number}, transaction:Object}}
 */
function instrumentTransaction(transaction) {
  const stats = { writes: 0, reads: 0 };

  const budgetGuard = () => {
    if (stats.writes > TX_WRITE_BUDGET) {
      throw new Error(
        `单个事务已写入 ${stats.writes} 次，超过写入预算（${TX_WRITE_BUDGET} 次）：`
        + '云数据库事务的操作数上限未公示，超限会在事务中途整体报错。请分批处理，'
        + '或按真机验收结果调整环境变量 TX_WRITE_BUDGET。',
      );
    }
  };

  const wrapCollection = (name, collection) => ({
    doc: (id) => {
      const ref = collection.doc(id);
      return {
        get: async () => { stats.reads += 1; return ref.get(); },
        set: async (arg) => { stats.writes += 1; budgetGuard(); return ref.set(arg); },
        update: async (arg) => { stats.writes += 1; budgetGuard(); return ref.update(arg); },
        remove: async () => { stats.writes += 1; budgetGuard(); return ref.remove(); },
      };
    },
    add: async (arg) => { stats.writes += 1; budgetGuard(); return collection.add(arg); },
    // 事务内做集合查询本来就被云开发拒绝（见 buildCollections 的各处 inTx 拦阻）；
    // 包一层是为了让漏网之路也得到同一句人话，而不是 TypeError。
    where: () => { throw new Error(`事务内不允许条件读取（${name}），请改用 getById`); },
  });

  return {
    stats,
    transaction: {
      collection: (name) => wrapCollection(name, transaction.collection(name)),
      rollback: (...args) => transaction.rollback(...args),
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
    db.runTransaction(async (transaction) => {
      const instrumented = instrumentTransaction(transaction);
      try {
        return await fn(buildCollections(instrumented.transaction, true));
      } finally {
        // 观测层：接近临界的事务留痕，供真机验收核对云端真实上限（审计 C4）。
        if (instrumented.stats.writes >= TX_WARN_WRITES) {
          console.warn(
            `[data] 事务操作数告警：写 ${instrumented.stats.writes} 次 / 读 ${instrumented.stats.reads} 次`
            + `（预算 ${TX_WRITE_BUDGET} 写）。云端事务上限未公示，请在真机验收时重点核对。`,
          );
        }
      }
    });

  return repo;
}

module.exports = { createRepo, PAGE_SIZE };
