/** 两个适配器共享的学校仓储扩展。原单校接口保留，S2 逐一接入新接口。 */
const { schoolScope } = require('../lib/utils/school.js');
const { MEET_COLLECTIONS, meetScope } = require('../lib/utils/meet-scope.js');

const SCHOOL_COLLECTIONS = ['schools', 'schoolAssociations', 'colleges', 'schoolMembers', 'schoolRoles', 'studentIdClaims',
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations', 'pairCounts',
  // 会员评级表与结算序号计数：均为「学校 + 协会」双维度归属，写入即校验。
  'memberRatings', 'ratingCounters',
  // 团队运动（篮球/足球/排球）6 个集合：与个人赛彻底分开，同样按
  // 「学校 + 协会」双维度归属。比赛与统计**绝不写 matches / memberRatings**。
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
  // 运动会 12 个集合：学校级业务，不属于任何协会。基础读写挂在这里，
  // 范围校验走 forMeet（{schoolId, meetId}），不能混进下面的 SCOPED_COLLECTIONS
  // ——那一组会注入 association 字段，把运动会错挂到协会上。
  ...MEET_COLLECTIONS,
  // 学院部长授权：**学校级**常设角色，不随届次、也不挂协会，故按 SCHOOL_ONLY 处理。
  'sportsMeetCollegeLeads'];
// 学校级集合：只按 schoolId 判归属，写入不注入 association。
// 公告 2026-10-18 起并入这一档——只有管理员能发、发的是全校信息，
// 不能因为发布时当前协会不同而只在那家协会可见。
const SCHOOL_ONLY = ['colleges', 'schoolMembers', 'schoolRoles', 'sportsMeetCollegeLeads', 'announcements'];
// 带 eventId 的从属集合：按赛事取子集走 listByEvent（条件查询），不再整表读完
// 再内存过滤。与内存仓储 school-memory-repo.js 的 EVENT_SCOPED 一一对应。
//
// 团队运动的报名 / 比赛 / 统计三个集合同样有 eventId、同样是「按赛事取子集」
// 的读法（team-event-service 里 6 处 `list().filter(eventId)`），2026-10-21
// 审查 P1-5 把它们并进来：此前一次详情页要把历年全部比赛与统计读回来才滤出
// 本届那几十条。
const EVENT_SCOPED = ['matches', 'eventSignups', 'collegeEntries', 'ties', 'lineups',
  'teamEventEntries', 'teamMatches', 'teamMatchStats'];
const SCOPED_COLLECTIONS = [
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  ...SCHOOL_ONLY, 'schoolAssociations', 'memberships',
  'matches', 'events', 'eventSignups', 'collegeEvents', 'collegeEntries',
  'ties', 'lineups', 'liveScores', 'seasons',
  // 协会空间小组 / 通知 / 训练均按「学校 + 协会」双维度范围，写入即校验归属。
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations',
  // 交手名额计数：每对一条，同属「学校 + 协会 + 赛季」，写入即校验归属。
  'pairCounts',
  // 会员评级表：每「学校 + 协会 + 用户 + 池」一条，写入即校验归属。
  'memberRatings',
  // 结算序号计数：每「学校 + 协会」一条，写入即校验归属。
  'ratingCounters',
  // 团队运动：球队 / 队员 / 赛事 / 报名 / 比赛 / 统计，一律按「学校 + 协会」。
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
];

/**
 * 通用「受范围仓储」。
 *
 * 协会维度与运动会维度只有 `expected` 字段不同（前者 schoolId+association，
 * 后者 schoolId+meetId），读写校验、事务内点读、事务包装完全一致。
 * 抽成一处而不是复制两份：这段代码里「写入前在同一事务内复查归属」是关键，
 * 两份实现迟早分叉，而分叉的后果是能跨届/跨院写入。
 *
 * @param {Object} repo 基础仓储
 * @param {Object} io { read, set, query }
 * @param {boolean} inTx 是否已在事务内
 * @param {Object} options
 * @param {ReadonlyArray<string>} options.keys 受范围集合
 * @param {Object} options.scope 写进文档与结果的范围对象
 * @param {Function} options.expectedOf (key) => 该集合应有的归属字段
 * @param {Function} options.surfaceOf (tx, scope) => 事务内的对应受范围仓储
 * @param {string} options.mismatchMessage 越界写入的报错文案
 */
function buildScoped(repo, io, inTx, options) {
  const { keys, scope, expectedOf, surfaceOf, mismatchMessage } = options;
  const result = { scope };

  for (const key of keys) {
    const expected = expectedOf(key);
    const owns = (doc) => doc && Object.keys(expected).every((field) => doc[field] === expected[field]);
    const checked = (doc) => {
      for (const field of Object.keys(expected)) {
        if (doc[field] !== undefined && doc[field] !== expected[field]) throw new Error(mismatchMessage);
      }
      return { ...doc, ...expected };
    };
    // 按主键写前检查已有归属，检查与写入保持在同一事务。
    const write = async (id, doc, mode) => {
      if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
      if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');
      const patch = checked(doc);
      const run = async (tx) => {
        const current = await tx[key].getById(id);
        if (current && mode === 'insert') throw new Error('记录已存在');
        if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
        await tx[key].set(id, mode === 'update' ? { ...current, ...patch } : patch);
        return { ...(mode === 'update' ? current : {}), ...patch, _id: id };
      };
      if (!inTx) return repo.transaction((tx) => run(surfaceOf(tx, scope)));
      const current = await io.read(key, id);
      if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
      if (current && mode === 'insert') throw new Error('记录已存在');
      if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
      const next = { ...(mode === 'update' ? current : {}), ...patch, _id: id };
      await io.set(key, id, next);
      return next;
    };
    result[key] = {
      list: () => repo[key].listByScope(scope),
      getById: async (id) => {
        const doc = await io.read(key, id);
        return owns(doc) ? doc : null;
      },
      set: (id, doc) => write(id, doc, 'set'),
      insert: (doc) => write(doc._id, doc, 'insert'),
      update: (id, patch) => write(id, patch, 'update'),
    };
    // 按赛事取子集：条件**一起下推到查询**（范围字段 + eventId），而不是读全表
    // 再在内存里过滤。内存仓储有同名方法（school-memory-repo.js 的 listByEvent），
    // 两端方法面由 tests/for-scope-contract.test.js 逐字守住。
    if (EVENT_SCOPED.includes(key)) {
      const scopeFields = SCHOOL_ONLY.includes(key)
        ? { schoolId: scope.schoolId }
        : { schoolId: scope.schoolId, association: scope.association };
      result[key].listByEvent = (eventId) => io.query(key, { ...scopeFields, eventId });
    }
  }
  // 本赛季的比赛：把 `matchTime >= sinceIso` 下推到查询。
  //
  // 【为什么需要】（2026-10-22 第二轮审查 P-2）
  // 「本赛季与每个人的交手次数」原来是把**全部历史比赛**读回来再按 resetTime
  // 在应用层过滤。matches 是只增不减的最大集合，一个练了三年的协会打开一次
  // 录分页要翻上百页 RPC，而真正用得上的只有本赛季那几十条。
  //
  // 【为什么不过滤 status】
  // 名额口径（rating-cap.countedMatches）只排除**作废**的场次，待确认的照样占
  // 名额。若这里按 status 收窄，等于顺手改了业务口径——过滤留在 countedMatches。
  //
  // 【为什么只挂在 forScope 上】
  // 没有范围字段的同类查询会跨校泄露。matchTime 落库是 ISO 串，同格式字符串的
  // 字典序即时间序，字符串范围比较成立。
  if (result.matches) {
    result.matches.listPage = (options) => {
      if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
      return io.matchPage(scope, options);
    };
    result.matches.listSince = (sinceIso) => {
      const where = { schoolId: scope.schoolId, association: scope.association };
      if (typeof sinceIso === 'string' && sinceIso) where.matchTime = io.cmd.gte(sinceIso);
      return io.query('matches', where);
    };
  }
  if (!inTx) result.transaction = (fn) => repo.transaction((tx) => fn(surfaceOf(tx, scope)));
  return result;
}

function attachSchoolRepository(repo, io, inTx) {
  for (const key of SCHOOL_COLLECTIONS) {
    repo[key] = {
      getById: (id) => io.read(key, id),
      set: (id, doc) => io.set(key, id, doc),
      list: () => io.query(key, {}),
    };
  }
  for (const key of SCOPED_COLLECTIONS) {
    repo[key].listByScope = (input) => {
      const scope = schoolScope(input);
      return io.query(key, SCHOOL_ONLY.includes(key) ? { schoolId: scope.schoolId } : scope);
    };
  }
  // 学校级集合（学院目录 / 身份 / 校级角色 / 学院部长授权）的按校列举。
  // 为什么另开一个方法：listByScope 走 schoolScope()，它要求 schoolId + association，
  // 而运动会的 context 里根本没有 association——拿 forScope 去列学院部长会直接抛错。
  for (const key of SCHOOL_ONLY) {
    repo[key].listBySchool = (schoolId) => io.query(key, { schoolId: String(schoolId || '') });
  }
  // 运动会集合的按校列举（列「本校有哪些届运动会」用）。
  for (const key of MEET_COLLECTIONS) {
    repo[key].listBySchool = (schoolId) => io.query(key, { schoolId: String(schoolId || '') });
  }
  // 运动会集合的 listByScope 只按「学校 + 运动会」，与协会无关。
  for (const key of MEET_COLLECTIONS) {
    repo[key].listByScope = (input) => {
      const scope = meetScope(input);
      return io.query(key, { schoolId: scope.schoolId, meetId: scope.meetId });
    };
  }
  repo.exchangeSignups.listByEvent = eventId => io.query('exchangeSignups', { eventId });
  repo.exchangeMatches.listByEvent = eventId => io.query('exchangeMatches', { eventId });

  repo.forScope = (input) => {
    const scope = schoolScope(input);
    return buildScoped(repo, io, inTx, {
      keys: SCOPED_COLLECTIONS,
      scope,
      expectedOf: (key) => (SCHOOL_ONLY.includes(key)
        ? { schoolId: scope.schoolId }
        : { schoolId: scope.schoolId, association: scope.association }),
      surfaceOf: (tx, next) => tx.forScope(next),
      mismatchMessage: '不能写入其他学校或协会的数据',
    });
  };

  /**
   * 运动会范围的受范围仓储。
   *
   * 与 forScope 的关键差异：归属字段是 `{schoolId, meetId}`，**没有 association**。
   * 因此不能复用 forScope，也不能把运动会集合塞进 SCOPED_COLLECTIONS——
   * 那会在每次写入时给文档强塞一个 association，等于把运动会挂到匹克球协会上。
   */
  repo.forMeet = (input) => {
    const scope = meetScope(input);
    return buildScoped(repo, io, inTx, {
      keys: MEET_COLLECTIONS,
      scope,
      expectedOf: () => ({ schoolId: scope.schoolId, meetId: scope.meetId }),
      surfaceOf: (tx, next) => tx.forMeet(next),
      mismatchMessage: '不能写入其他学校或其他运动会的数据',
    });
  };

  return repo;
}

module.exports = {
  SCHOOL_COLLECTIONS,
  SCOPED_COLLECTIONS,
  MEET_COLLECTIONS,
  attachSchoolRepository,
};
