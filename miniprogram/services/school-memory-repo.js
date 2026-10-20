/** 学校身份演示仓储。写事务排队，草稿提交/回滚，读写均复制对象。 */
const { schoolScope } = require('../utils/school.js');
const { MEET_COLLECTIONS, meetScope } = require('../utils/meet-scope.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const KEYS = ['users', 'schools', 'schoolAssociations', 'colleges', 'schoolMembers',
  'schoolRoles', 'memberships', 'studentIdClaims', 'auditLogs',
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations',
  'announcements',
  'events', 'eventSignups', 'matches', 'liveScores',
  'collegeEvents', 'collegeEntries', 'ties', 'lineups',
  // M4：赛季文档（每范围一份，_id 由 scopeKey 组成，跨范围读不到也改不掉）
  'seasons',
  // 交手名额计数：每对每赛季一条，_id 由 scope + 赛季号 + 两人编号组成
  'pairCounts',
  // 会员评级表：每「学校 + 协会 + 用户 + 池」一条，_id 由 memberRatingKey 组成
  'memberRatings',
  // 结算序号计数：每「学校 + 协会」一条，_id 由 ratingSeqKey 组成
  'ratingCounters',
  // 团队运动（篮球/足球/排球）：球队 / 队员 / 赛事 / 报名 / 比赛 / 统计，
  // 与个人赛彻底分开，按「学校 + 协会」归属（与云端 SCOPED 同口径）
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
  // 运动会：学校级业务，与协会无关。12 个集合一律以 schoolId + meetId 归属，
  // 范围校验走 forMeet（与云端 attachSchoolRepository 同口径）。
  ...MEET_COLLECTIONS,
  // 学院部长授权：学校级常设角色，一院一条。
  'sportsMeetCollegeLeads'];

function createSchoolMemoryRepo(seed = {}) {
  let state = Object.fromEntries(KEYS.map(key => [key, new Map((seed[key] || []).map(doc => [doc._id, clone(doc)]))]));
  let queue = Promise.resolve();
  const build = (getState, inTx) => {
    const repo = {};
    for (const key of KEYS) {
      repo[key] = {
        getById: async id => clone(getState()[key].get(id) || null),
        set: async (id, doc) => { getState()[key].set(id, clone({ ...doc, _id: id })); },
        list: async () => {
          if (inTx) throw new Error('事务内不可查询集合');
          return [...getState()[key].values()].map(clone);
        },
      };
    }
    repo.memberships.get = repo.memberships.getById;
    // 同一 OpenID 可能留下两条账号（旧协议 `u_…` 与协议 2 `acc:…`）。这里与
    // 云端适配器同口径：按 _id 升序取定，让「解析到哪一条」确定、可复现
    // （见 2026-10-16 只读审计 H5 / P1）。
    repo.users.getByOpenId = async openId => (await repo.users.list())
      .filter(user => user.openId === openId)
      .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))[0] || null;
    repo.audit = { append: async entry => {
      if (!entry._id) throw new Error('审计记录缺少 ID');
      await repo.auditLogs.set(entry._id, entry);
    } };
    // 受范围限制的集合：与云端 attachSchoolRepository 的 SCOPED_COLLECTIONS 对齐
    // （由 tests/for-scope-contract.test.js 守护）。两端必须逐字一致——原先云端多一个
    // `rankings` 并作为例外列在契约测试里；Elo 改为逐场结算后它已无任何读写，已删除。
    const SCOPED = [
      'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
      'colleges', 'schoolMembers', 'schoolRoles', 'schoolAssociations', 'memberships',
      'matches', 'events', 'eventSignups', 'announcements',
      'collegeEvents', 'collegeEntries', 'ties', 'lineups', 'liveScores', 'seasons',
      'associationGroups', 'associationGroupMembers',
      'associationNotices', 'associationTrainings', 'trainingRegistrations',
      'pairCounts', 'memberRatings', 'ratingCounters',
      // 团队运动：按「学校 + 协会」双维度归属
      'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
      // 学院部长授权：学校级（只按 schoolId 判归属，见 SCHOOL_SCOPED）
      'sportsMeetCollegeLeads',
    ];
    // 只按学校（不带协会）判归属的集合：学院目录 / 身份 / 校级角色是学校级的。
    // `announcements` 2026-10-18 起也归到这一档：公告只有管理员能发，且发的是
    // 全校信息，不该因为发布时正停在哪家协会而只在那家协会可见。
    const SCHOOL_SCOPED = ['colleges', 'schoolMembers', 'schoolRoles', 'sportsMeetCollegeLeads', 'announcements'];
    repo.forScope = input => {
      const scope = schoolScope(input);
      const result = { scope };
      for (const key of SCOPED) {
        const expected = SCHOOL_SCOPED.includes(key)
          ? { schoolId: scope.schoolId }
          : { schoolId: scope.schoolId, association: scope.association };
        const owns = doc => Boolean(doc) && Object.keys(expected).every(field => doc[field] === expected[field]);
        const checked = doc => {
          for (const field of Object.keys(expected)) {
            if (doc[field] !== undefined && doc[field] !== expected[field]) {
              throw new Error('不能写入其他学校或协会的数据');
            }
          }
          return { ...doc, ...expected };
        };
        const write = async (id, doc, mode) => {
          if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
          if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');
          const patch = checked(doc);
          const current = await repo[key].getById(id);
          if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
          if (current && mode === 'insert') throw new Error('记录已存在');
          if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
          const next = { ...(mode === 'update' ? current : {}), ...patch, _id: id };
          await repo[key].set(id, next);
          return next;
        };
        result[key] = {
          list: async () => (await repo[key].list()).filter(owns),
          getById: async id => {
            const doc = await repo[key].getById(id);
            return owns(doc) ? doc : null;
          },
          set: (id, doc) => write(id, doc, 'set'),
          insert: doc => write(doc._id, doc, 'insert'),
          update: (id, patch) => write(id, patch, 'update'),
        };
      }
      if (!inTx) result.transaction = fn => repo.transaction(tx => fn(tx.forScope(scope)));
      return result;
    };
    // 运动会范围：{schoolId, meetId}，**不含 association**。与云端 forMeet 同口径，
    // 由 tests/meet-repo-contract.test.js 逐集合/逐方法守护两端一致。
    repo.forMeet = input => {
      const scope = meetScope(input);
      const expected = { schoolId: scope.schoolId, meetId: scope.meetId };
      const result = { scope };
      for (const key of MEET_COLLECTIONS) {
        const owns = doc => Boolean(doc) && Object.keys(expected).every(field => doc[field] === expected[field]);
        const checked = doc => {
          for (const field of Object.keys(expected)) {
            if (doc[field] !== undefined && doc[field] !== expected[field]) {
              throw new Error('不能写入其他学校或其他运动会的数据');
            }
          }
          return { ...doc, ...expected };
        };
        const write = async (id, doc, mode) => {
          if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
          if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');
          const patch = checked(doc);
          const current = await repo[key].getById(id);
          if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
          if (current && mode === 'insert') throw new Error('记录已存在');
          if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
          const next = { ...(mode === 'update' ? current : {}), ...patch, _id: id };
          await repo[key].set(id, next);
          return next;
        };
        result[key] = {
          list: async () => (await repo[key].list()).filter(owns),
          getById: async id => {
            const doc = await repo[key].getById(id);
            return owns(doc) ? doc : null;
          },
          set: (id, doc) => write(id, doc, 'set'),
          insert: doc => write(doc._id, doc, 'insert'),
          update: (id, patch) => write(id, patch, 'update'),
        };
      }
      if (!inTx) result.transaction = fn => repo.transaction(tx => fn(tx.forMeet(scope)));
      return result;
    };
    // 运动会集合的按校列举（列本届清单用；与云端同口径）
    for (const key of MEET_COLLECTIONS) {
      repo[key].listBySchool = async schoolId => (await repo[key].list())
        .filter(doc => doc.schoolId === schoolId);
    }
    // 学校级集合的按校列举（与云端 attachSchoolRepository 的 listBySchool 对齐）
    for (const key of SCHOOL_SCOPED) {
      repo[key].listBySchool = async schoolId => (await repo[key].list())
        .filter(doc => doc.schoolId === schoolId);
    }
    repo.exchangeSignups.listByEvent = async eventId => (await repo.exchangeSignups.list()).filter(doc => doc.eventId === eventId);
    repo.exchangeMatches.listByEvent = async eventId => (await repo.exchangeMatches.list()).filter(doc => doc.eventId === eventId);
    repo.exchangeInvitations.listByScope = input => repo.forScope(input).exchangeInvitations.list();
    return repo;
  };
  const repo = build(() => state, false);
  repo.transaction = fn => {
    const task = queue.then(async () => {
      // 【为什么只浅拷贝 Map，不再深拷贝整个库（2026-10-20 性能修正）】
      // 这里原先是 `new Map([...state[key]].map(([id, doc]) => [id, clone(doc)]))`
      // ——每个事务先把 52 个集合、约两千条文档整份深拷贝一遍。而 build() 的
      // 三个读写入口**本来就各自克隆**：getById 交出去的是副本、set 落进去的是
      // 副本、list 返回的也是副本。也就是说，事务只需要隔离「写」；「读」的
      // 隔离已经由那三处保证了，深拷贝这一层是重复劳动。
      //
      // 实测代价：page.test.js 的 292 条用例共耗 267s CPU，其中 clone 一项占
      // 47.5%（127s），加上它触发的 GC 后内存仓储占 67.7%。成因是库里 61%
      // 是从不被这些用例触碰的运动会演示数据（1202 条），每次都陪着一块儿拷。
      //
      // 浅拷贝为什么等价：doc 一旦从 Map 取出就已是对副本的再克隆，调用方怎么
      // 改都碰不到库里的原件；任何写入都必须经过 set()，而 set() 存的是
      // `clone({...doc, _id: id})`，只会写进 scratch 这张新 Map。所以回滚
      // （丢掉 scratch）依然完整，提交（state = scratch）依然是整批替换。
      // 前提是没有任何代码绕过 set 直接改 Map —— 本文件与全仓都没有这种写法。
      const scratch = Object.fromEntries(KEYS.map(key => [key, new Map(state[key])]));
      const result = await fn(build(() => scratch, true));
      state = scratch;
      return result;
    });
    queue = task.catch(() => {});
    return task;
  };
  return repo;
}

module.exports = { createSchoolMemoryRepo };
