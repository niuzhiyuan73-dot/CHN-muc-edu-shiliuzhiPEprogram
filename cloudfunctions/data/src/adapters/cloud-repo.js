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
const { readMemberPage } = require('./member-page.js');
const { matchListWhere } = require('../../lib/services/match-list-query.js');
const { MATCH_STATUS } = require('../../lib/utils/constants.js');

/** 单页条数，取云开发云函数端的查询上限 */
const PAGE_SIZE = 100;

/** 列表只返回一页文档；总数在数据库聚合，不能为了数字把台账翻回应用层。 */
async function readMatchPage(scope, schoolScope, options) {
  const { filter = {}, limit, offset = 0, cursor = null } = options;
  const collection = () => scope.collection(COLLECTIONS.matches).aggregate();
  const rowsOf = result => result.list || result.data || [];
  const count = async where => {
    const rows = rowsOf(await collection().match(where).count('total').end());
    return rows.length ? rows[0].total : 0;
  };
  const where = matchListWhere(schoolScope, filter);
  const pageWhere = cursor ? matchListWhere(schoolScope, filter, cursor) : where;
  const pendingFilter = { ...filter, status: MATCH_STATUS.PENDING };
  const pendingPromise = count(matchListWhere(schoolScope, pendingFilter));
  const totalPromise = filter.status === MATCH_STATUS.PENDING ? pendingPromise : count(where);
  const remainingPromise = cursor ? count(pageWhere) : totalPromise;
  const pagePromise = limit === 0 ? Promise.resolve([]) : (async () => {
    // 兼容任意非负 offset；超出结果集直接返回，避免把巨大的 skip 传给数据库。
    if (!cursor && offset > 0 && offset >= await totalPromise) return [];
    let query = collection().match(pageWhere).sort({ matchTime: -1, _id: -1 });
    // offset 兼容既有调用；持续翻页优先传游标，避免深 skip 扫描和插入漂移。
    if (!cursor && offset) query = query.skip(offset);
    return rowsOf(await query.limit(limit).end());
  })();
  const [rows, total, pendingCount, remaining] = await Promise.all([
    pagePromise, totalPromise, pendingPromise, remainingPromise,
  ]);
  return { rows, total, pendingCount, hasMore: remaining > (cursor ? 0 : offset) + rows.length };
}

/** 单次整表读超过这个条数就告警：云端每翻一页是一次 RPC，深翻页同时放大耗时与读配额 */
const DEEP_READ_WARN = 500;

/** 官方事务上限 100 个读写操作；环境变量只允许收紧，不能放大云端上限。 */
const TX_OPERATION_BUDGET = Math.min(100, Number(process.env.TX_OPERATION_BUDGET) > 0
  ? Math.floor(Number(process.env.TX_OPERATION_BUDGET)) : 100);
const TX_WRITE_BUDGET = Math.min(TX_OPERATION_BUDGET, Number(process.env.TX_WRITE_BUDGET) > 0
  ? Math.floor(Number(process.env.TX_WRITE_BUDGET)) : TX_OPERATION_BUDGET);

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
  // 【为什么不能只 /collection/ 一把抓】（2026-10-22 第二轮审查 S-3）
  // 权限不足、查询语法错误、超时的提示里都可能出现 "collection"，只按名词匹配
  // 会把它们统统误报成「集合不存在，请先建齐集合」——排查方向被彻底带偏
  // （这正是 10-17 审计 C3 修了一半的地方）。这里要求名词后紧跟 not exist。
  return code === -502005 || /(collection|db or table)[^.]{0,24}not exist/i.test(msg);
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
 * 拼下一页的查询条件。
 *
 * 【为什么用「上一页最后一条的 _id」而不是 skip】（2026-10-21 审查 P1-4）
 * `skip(n)` 的语义是「排序后扫描并丢弃前 n 条」，两个后果都不好受：
 *   1. 成本随页数线性上升——第 10 页要白扫 900 条；
 *   2. 翻页期间有写入时，窗口会漂移：新文档插到游标之前，第 2 页会与第 1 页
 *      重叠（同一条被读两次），插到之后则可能整条漏掉。原实现用 orderBy('_id')
 *      只稳住了「顺序」，稳不住「窗口」，台账仍可能少读一条、等级分少算一场。
 * 游标分页每页都是 `_id > 上一页末条`，成本恒定，且天然免疫插入导致的漂移。
 *
 * where 自带 `_id` 条件时（如按编号批量取）不能直接覆盖，用 and 合并。
 *
 * @param {Object} where 原有等值条件
 * @param {string|null} lastId 上一页最后一条的 _id；null 表示第一页
 * @param {Object} cmd db.command
 * @returns {Object}
 */
function cursorCond(where, lastId, cmd) {
  const base = where && Object.keys(where).length > 0 ? where : null;
  if (lastId === null || lastId === undefined) return base;
  const next = { _id: cmd.gt(lastId) };
  if (!base) return next;
  if (base._id === undefined) return { ...base, ...next };
  // 【为什么这里直接抛，而不是 and 起来】（2026-10-22 第二轮审查 B-5）
  // 原实现写的是 `cmd.and([base, next])`，但 `db.command.and` 收的是**查询命令**
  // 数组，把普通等值条件对象塞进去并不等价于「两个条件都要满足」；而且这条
  // 分支从未被任何调用方走到（按编号批量取走 listByIds，其余条件都不含 _id），
  // 属于"看着能用、一用就错"的死代码。与其留着，不如让它响亮地失败。
  throw new Error('游标分页不支持已有的 _id 条件：请改用 listByIds 之类的批读接口');
}

/**
 * 整表读取，游标翻页。
 *
 * 【翻页为什么必须带 orderBy】
 * 游标分页依赖「下一页从这条之后开始」，顺序不稳定的话游标本身就没有意义。
 * 按 _id 升序是唯一稳定且不依赖业务字段的排法。
 *
 * @param {Object} scope db
 * @param {string} name 集合名
 * @param {Object} cmd db.command
 * @returns {Promise<Array<Object>>}
 */
async function readAll(scope, name, cmd) {
  const out = [];
  let lastId = null;
  for (;;) {
    const cond = cursorCond(null, lastId, cmd);
    const query = cond ? scope.collection(name).where(cond) : scope.collection(name);
    const res = await query
      .orderBy('_id', 'asc')
      .limit(PAGE_SIZE)
      .get();
    const batch = (res && res.data) || [];
    for (const doc of batch) out.push(doc);
    if (batch.length < PAGE_SIZE) break;
    lastId = batch[batch.length - 1]._id;
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
  // 快路径：顶层全是原始类型（且无 undefined）时，深拷贝与规格化都是白做，
  // 浅拷贝足够——随后就交给数据库序列化了（2026-10-21 审查 P2-11）。
  // 比赛结算这类"读整条、改一处、整条写回"的路径每次都要拷一遍文档，
  // 大文档上这是纯 CPU 开销。
  const plain = doc && typeof doc === 'object' && Object.values(doc)
    .every((value) => value === null || (typeof value !== 'object' && value !== undefined));
  const copy = plain ? { ...doc } : stripForStorage(doc);
  delete copy._id;
  return copy;
}

/**
 * 带等值条件读取，游标翻页（同 readAll，见 cursorCond 的说明）。
 * @param {Object} scope db
 * @param {string} name 集合名
 * @param {Object} where 等值条件
 * @param {Object} cmd db.command
 * @returns {Promise<Array<Object>>}
 */
async function readWhere(scope, name, where, cmd) {
  const out = [];
  let lastId = null;
  for (;;) {
    const cond = cursorCond(where, lastId, cmd);
    const query = cond ? scope.collection(name).where(cond) : scope.collection(name);
    const res = await query
      .orderBy('_id', 'asc')
      .limit(PAGE_SIZE)
      .get();
    const batch = (res && res.data) || [];
    for (const doc of batch) out.push(doc);
    if (batch.length < PAGE_SIZE) break;
    lastId = batch[batch.length - 1]._id;
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
 * @param {Object} cmd db.command（事务内不查询，可为空）
 * @returns {Object} 仓储
 */
function buildCollections(scope, inTx, cmd) {
  const col = (key) => scope.collection(COLLECTIONS[key]);

  const list = (key) => {
    // 事务里做集合查询会被云开发拒绝，报错晦涩。这里主动拦下并说清原因，
    // 免得后来人以为是数据库抽风。
    if (inTx) throw new Error(`事务内不允许整表读取（${key}），请改用 getById`);
    return readAll(scope, COLLECTIONS[key], cmd);
  };

  const repo = {
    users: {
      list: () => list('users'),
      getById: (id) => readDoc(scope, COLLECTIONS.users, id),
      /**
       * 按一批 userId 取账号。
       *
       * 【为什么必须有它】（2026-10-21 审查 P0-1）
       * `users` 是**平台级**集合（账号跟微信 OpenID 走，不带 schoolId），所以它的
       * `list()` 是「把全平台所有学校的账号读进内存」。而业务要的都是「给这批
       * userId 补昵称/头像」——本校几百人，全平台可能几千人，读放大十几倍，
       * 还随其它学校用户增长而变慢。
       *
       * 这里按 _id 批量取（`_.in`，每次 100 个），RPC 数从「全平台页数」降到
       * 「本校成员数 / 100」。事务内不能用条件查询，退化为逐个点读（走事务
       * 的 doc 读，合法且已被读写预算计数）。
       *
       * @param {Array<string>} ids
       * @returns {Promise<Array<Object>>}
       */
      listByIds: async (ids) => {
        const uniq = [...new Set((Array.isArray(ids) ? ids : [])
          .filter(id => typeof id === 'string' && id))];
        if (uniq.length === 0) return [];
        if (inTx) {
          const out = [];
          for (const id of uniq) {
            const doc = await readDoc(scope, COLLECTIONS.users, id);
            if (doc) out.push(doc);
          }
          return out;
        }
        const out = [];
        for (let i = 0; i < uniq.length; i += PAGE_SIZE) {
          const chunk = uniq.slice(i, i + PAGE_SIZE);
          const res = await col('users').where({ _id: cmd.in(chunk) }).get();
          for (const doc of (res && res.data) || []) out.push(doc);
        }
        return out;
      },
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
        return readWhere(scope, COLLECTIONS.matches, { eventId }, cmd);
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
        return readWhere(scope, COLLECTIONS.eventSignups, { eventId }, cmd);
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
        return readWhere(scope, COLLECTIONS.collegeEntries, { eventId }, cmd);
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
        return readWhere(scope, COLLECTIONS.ties, { eventId }, cmd);
      },
      getById: (id) => readDoc(scope, COLLECTIONS.ties, id),
      insert: (doc) => col('ties').doc(doc._id).set({ data: withoutId(doc) }),
      update: (id, patch) => col('ties').doc(id).update({ data: withoutId(patch) }),
    },

    lineups: {
      list: () => list('lineups'),
      listByEvent: (eventId) => {
        if (inTx) throw new Error('事务内不允许条件读取（lineups），请改用 getById');
        return readWhere(scope, COLLECTIONS.lineups, { eventId }, cmd);
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
      /**
       * 按一批编号取实时比分（轮询接口专用）。
       *
       * 【为什么必须批读】（2026-10-21 审查 P1-6）轮询每 2 秒一次，50 场若逐条
       * 点读就是 50 个 RTT，分批并发也要 5 轮；一次 `_.in` 只花 1 个 RTT。
       * 调用方仍须逐条判归属（编号是客户端给的）。
       */
      listByIds: async (ids) => {
        const uniq = [...new Set((Array.isArray(ids) ? ids : [])
          .filter(id => typeof id === 'string' && id))];
        if (uniq.length === 0) return [];
        const out = [];
        for (let i = 0; i < uniq.length; i += PAGE_SIZE) {
          const chunk = uniq.slice(i, i + PAGE_SIZE);
          const res = await col('liveScores').where({ _id: cmd.in(chunk) }).get();
          for (const doc of (res && res.data) || []) out.push(doc);
        }
        return out;
      },
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
        return readWhere(scope, COLLECTIONS.memberships, { userId }, cmd);
      },
      get: (id) => readDoc(scope, COLLECTIONS.memberships, id),
      set: (id, doc) => col('memberships').doc(id).set({ data: withoutId(doc) }),
      remove: (id) => col('memberships').doc(id).remove(),
    },

    seasons: {
      get: (id) => readDoc(scope, COLLECTIONS.seasons, id),
      set: (id, doc) => col('seasons').doc(id).set({ data: withoutId(doc) }),
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
    'collegeEvents', 'collegeEntries', 'ties', 'lineups', 'seasons', 'pairCounts',
    'memberRatings', 'ratingCounters']) {
    repo[key] = {
      getById: (id) => readDoc(scope, COLLECTIONS[key], id),
      set: (id, doc) => col(key).doc(id).set({ data: withoutId(doc) }),
      list: () => list(key),
      ...repo[key],
    };
  }

  // 团队运动三集合的「按赛事取子集」。
  //
  // 业务里既有 `ctx.repo.forScope(ctx).teamMatches.listByEvent(...)`，也有
  // 直接把 forScope 结果存进 `repo` 再调用的写法；本地模拟仓储顶层与受范围
  // 两层都提供同名方法（school-memory-repo.js），云端必须对齐，否则又是
  // 「本地绿、云端 TypeError」。eventId 由 teamKey 派生（内含 schoolId +
  // association），所以按它查询天然带范围，不需要再拼 schoolId。
  //
  // 必须放在 attachSchoolRepository **之后**：team* 属于 SCHOOL_COLLECTIONS，
  // 顶层对象由那一步创建（补齐循环的清单里没有它们）。
  attachSchoolRepository(repo, {
    // 范围条件要能构造操作符（gte / in 等），故把 db.command 一并交给学校仓储
    // 扩展，供 listByEvent 之外的范围查询使用。
    cmd,
    memberPage: (schoolScope, options) => {
      if (inTx) throw new Error('事务内不允许查询会员目录');
      return readMemberPage(scope, cmd, schoolScope, options);
    },
    matchPage: (schoolScope, options) => {
      if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
      return readMatchPage(scope, schoolScope, options);
    },
    read: (key, id) => readDoc(scope, COLLECTIONS[key], id),
    set: (key, id, doc) => col(key).doc(id).set({ data: withoutId(doc) }),
    query: (key, where) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      return readWhere(scope, COLLECTIONS[key], where, cmd);
    },
    /**
     * 按一批 _id 取文档（`_.in`，每次 PAGE_SIZE 个）。
     *
     * 【为什么不能走 query】（2026-10-22 H-3）
     * `readWhere` 用 `_id > lastId` 做游标，一页装不下时会拼出「既有 `_id: in(...)`
     * 又有 `_id: gt(...)`」的条件——`cursorCond` 已改成直接抛错。批读本来就知道
     * 自己只有这几十个编号，按 PAGE_SIZE 切片即可，不需要游标。
     *
     * 【为什么必须带范围条件】
     * `_id` 是调用方给的。只按 `_id in (...)` 查等于把归属校验交给了调用方——
     * 一处漏判就是跨校读。这里把范围字段一起拼进查询，拿不到别校/别协会的文档，
     * 与 `list`/`query` 同一条底线。`scopeFields` 由仓储层按集合类型给
     * （学校级集合只有 schoolId，其余还要 association）。
     */
    byIds: async (key, ids, scopeFields = {}) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      const uniq = [...new Set((Array.isArray(ids) ? ids : [])
        .filter((id) => typeof id === 'string' && id))];
      if (uniq.length === 0) return [];
      const out = [];
      for (let i = 0; i < uniq.length; i += PAGE_SIZE) {
        const chunk = uniq.slice(i, i + PAGE_SIZE);
        const res = await col(key).where({ ...scopeFields, _id: cmd.in(chunk) }).get();
        for (const doc of (res && res.data) || []) out.push(doc);
      }
      return out;
    },
    /**
     * 条件 + 排序 + 限量一起下推，只取回需要的那几条。
     *
     * 【为什么不用 readWhere】（2026-10-23 方案 A 第 2 步）
     * `readWhere` 的语义是「把满足条件的文档全部读回来」，它有游标但**没有
     * 排序与上限**——榜单要「按 elo 前 10」，用它就是先读完全部再内存排序，
     * 等于没下推。这里把 orderBy 与 limit 交给数据库，一页即可返回。
     *
     * @param {string} key 集合键
     * @param {Object} where 等值 + 操作符条件
     * @param {Array<{field:string,direction:'asc'|'desc'}>} order 排序规则（按数组顺序链式调用）
     * @param {number} limit 条数（≤ PAGE_SIZE，调用方负责夹取）
     */
    top: async (key, where, order, limit) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      const size = Math.max(1, Math.min(Number(limit) || 1, PAGE_SIZE));
      let query = col(key).where(where);
      for (const rule of (order || [])) query = query.orderBy(rule.field, rule.direction);
      const res = await query.limit(size).get();
      return (res && res.data) || [];
    },
    /**
     * 只回一个数字的计数（聚合在数据库侧完成，不读文档）。
     *
     * 【为什么单独开】「我在同项目排第几」= 比我高的人数 + 1。为了这一个数字
     * 读回 8000 条评级，是这块读放大里最不划算的一笔。
     */
    count: async (key, where) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      const res = await col(key).where(where).count();
      return Number((res && res.total) || 0);
    },
  }, inTx);

  // 团队运动三集合的「按赛事取子集」。
  //
  // 业务里既有 `ctx.repo.forScope(ctx).teamMatches.listByEvent(...)`，也有直接
  // 把 forScope 结果存进 `repo` 再调用的写法；本地模拟仓储顶层与受范围两层
  // 都提供同名方法（school-memory-repo.js），云端必须对齐，否则又是「本地绿、
  // 云端 TypeError」。eventId 由 teamKey 派生（内含 schoolId + association），
  // 按它查询天然带范围，不需要再拼 schoolId。
  //
  // 必须放在 attachSchoolRepository **之后**：team* 属于 SCHOOL_COLLECTIONS，
  // 顶层对象由那一步创建（上面补齐循环的清单里没有它们）。
  for (const key of ['teamEventEntries', 'teamMatches', 'teamMatchStats']) {
    repo[key].listByEvent = (eventId) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      return readWhere(scope, COLLECTIONS[key], { eventId }, cmd);
    };
  }

  return repo;
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
  const reads = new Map();
  const budgetGuard = () => {
    if (stats.reads + stats.writes > TX_OPERATION_BUDGET || stats.writes > TX_WRITE_BUDGET) {
      throw new Error(`事务读写总操作预算不足（读 ${stats.reads} / 写 ${stats.writes}，上限 ${TX_OPERATION_BUDGET}）：请缩小本次处理范围`);
    }
  };
  const wrapCollection = (name, collection) => ({
    doc: (id) => {
      const ref = collection.doc(id);
      const key = JSON.stringify([name, id]);
      return {
        get: async () => {
          if (!reads.has(key)) {
            stats.reads += 1; budgetGuard();
            reads.set(key, Promise.resolve().then(() => ref.get()));
          }
          // 事务内的同一条数据只点读一次，归属复查也复用同一快照；不给调用方可变缓存。
          return stripForStorage(await reads.get(key));
        },
        set: async (arg) => {
          stats.writes += 1; budgetGuard();
          const result = await ref.set(arg);
          reads.set(key, Promise.resolve({ data: { ...stripForStorage(arg.data), _id: id } }));
          return result;
        },
        update: async (arg) => {
          stats.writes += 1; budgetGuard();
          const result = await ref.update(arg); reads.delete(key); return result;
        },
        remove: async () => {
          stats.writes += 1; budgetGuard();
          const result = await ref.remove(); reads.set(key, Promise.resolve({ data: null })); return result;
        },
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
  const repo = buildCollections(db, false, db.command);

  repo.transaction = (fn) =>
    db.runTransaction(async (transaction) => {
      const instrumented = instrumentTransaction(transaction);
      try {
        return await fn(buildCollections(instrumented.transaction, true, db.command));
      } finally {
        // 观测层：接近临界的事务留痕，供真机验收核对云端真实上限（审计 C4）。
        if (instrumented.stats.writes >= TX_WARN_WRITES) {
          console.warn(
            `[data] 事务操作数告警：写 ${instrumented.stats.writes} 次 / 读 ${instrumented.stats.reads} 次`
            + `（总操作预算 ${TX_OPERATION_BUDGET}）。`,
          );
        }
      }
    });

  return repo;
}

module.exports = { createRepo, PAGE_SIZE };
