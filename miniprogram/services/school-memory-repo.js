/** 学校身份演示仓储。写事务排队，草稿提交/回滚，读写均复制对象。 */
const { schoolScope } = require('../utils/school.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const KEYS = ['users', 'schools', 'schoolAssociations', 'colleges', 'schoolMembers',
  'schoolRoles', 'memberships', 'studentIdClaims', 'auditLogs',
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations',
  'events', 'eventSignups', 'matches', 'liveScores'];

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
    repo.users.getByOpenId = async openId => (await repo.users.list()).find(user => user.openId === openId) || null;
    repo.audit = { append: async entry => {
      if (!entry._id) throw new Error('审计记录缺少 ID');
      await repo.auditLogs.set(entry._id, entry);
    } };
    repo.forScope = input => {
      const scope = schoolScope(input);
      return Object.fromEntries(['colleges', 'schoolMembers', 'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
        'associationGroups', 'associationGroupMembers',
        'associationNotices', 'associationTrainings', 'trainingRegistrations',
        'events', 'eventSignups', 'matches', 'liveScores'].map(key => [key, {
        list: async () => (await repo[key].list()).filter(doc => doc.schoolId === scope.schoolId &&
          (['colleges', 'schoolMembers'].includes(key) || doc.association === scope.association)),
      }]));
    };
    repo.exchangeSignups.listByEvent = async eventId => (await repo.exchangeSignups.list()).filter(doc => doc.eventId === eventId);
    repo.exchangeMatches.listByEvent = async eventId => (await repo.exchangeMatches.list()).filter(doc => doc.eventId === eventId);
    repo.exchangeInvitations.listByScope = input => repo.forScope(input).exchangeInvitations.list();
    return repo;
  };
  const repo = build(() => state, false);
  repo.transaction = fn => {
    const task = queue.then(async () => {
      const scratch = Object.fromEntries(KEYS.map(key => [key, new Map([...state[key]].map(([id, doc]) => [id, clone(doc)]))]));
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
