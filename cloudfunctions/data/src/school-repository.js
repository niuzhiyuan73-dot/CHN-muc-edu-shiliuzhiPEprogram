/** 两个适配器共享的学校仓储扩展。原单校接口保留，S2 逐一接入新接口。 */
const { schoolScope } = require('../lib/utils/school.js');

const SCHOOL_COLLECTIONS = ['schools', 'schoolAssociations', 'colleges', 'schoolMembers', 'schoolRoles', 'memberRatings', 'studentIdClaims',
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches'];
const SCHOOL_ONLY = ['colleges', 'schoolMembers', 'schoolRoles'];
const SCOPED_COLLECTIONS = [
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  ...SCHOOL_ONLY, 'schoolAssociations', 'memberRatings', 'memberships',
  'matches', 'events', 'eventSignups', 'announcements', 'collegeEvents', 'collegeEntries',
  'ties', 'lineups', 'liveScores', 'seasons', 'rankings',
];

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
  repo.exchangeSignups.listByEvent = eventId => io.query('exchangeSignups', { eventId });
  repo.exchangeMatches.listByEvent = eventId => io.query('exchangeMatches', { eventId });
  repo.forScope = (input) => {
    const scope = schoolScope(input);
    const result = { scope };
    for (const key of SCOPED_COLLECTIONS) {
      const expected = SCHOOL_ONLY.includes(key) ? { schoolId: scope.schoolId } : scope;
      const owns = (doc) => doc && Object.keys(expected).every((field) => doc[field] === expected[field]);
      const checked = (doc) => {
        for (const field of Object.keys(expected)) {
          if (doc[field] !== undefined && doc[field] !== expected[field]) throw new Error('不能写入其他学校或协会的数据');
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
        if (!inTx) return repo.transaction((tx) => run(tx.forScope(scope)));
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
    }
    if (!inTx) result.transaction = (fn) => repo.transaction((tx) => fn(tx.forScope(scope)));
    return result;
  };
  return repo;
}

module.exports = { SCHOOL_COLLECTIONS, SCOPED_COLLECTIONS, attachSchoolRepository };
