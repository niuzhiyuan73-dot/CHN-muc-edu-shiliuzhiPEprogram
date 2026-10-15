const assert = require('node:assert/strict');
const { generateSeed } = require('../../miniprogram/services/seed');
const { createSchoolDemoSeed } = require('../../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../../miniprogram/services/school-context');
const { schoolMemberKey, schoolRoleKey } = require('../../miniprogram/utils/school');
const handlers = { ...require('../../miniprogram/services/school-match-service'),
  ...require('../../miniprogram/services/school-rank-service'), ...require('../../miniprogram/services/school-event-service'),
  ...require('../../miniprogram/services/school-live-service') };
const space = require('../../miniprogram/services/association-space');

/** 保留既有页面用例的人名和编号；所有读写均执行 S2 处理器。 */
function createMatchFixture(currentUser) {
  const seed = createSchoolDemoSeed();
  const legacy = generateSeed();
  seed.users.push({ _id: 'local_1', nickName: '待审核会员', platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' });
  seed.users.push(...legacy.members.map(m => ({ ...m, platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc' })));
  seed.schoolMembers.push(...legacy.members.map(m => ({ _id: schoolMemberKey(m._id, 'muc'), userId: m._id,
    schoolId: 'muc', collegeId: 'c01', status: 'active' })));
  seed.schoolRoles.push({ _id: schoolRoleKey('u01', 'muc'), userId: 'u01', schoolId: 'muc', role: 'admin', status: 'active' });
  seed.matches = legacy.matches.map(m => ({ ...m, schoolId: 'muc', association: 'pkb' }));
  const repo = createSchoolMemoryRepo(seed);
  const original = space.forScope;
  const scope = { schoolId: 'muc', association: 'pkb' };
  let sequence = 0;
  function api(actor = currentUser() && currentUser()._id, target = scope) {
    return Object.fromEntries(Object.entries(handlers).filter(([, fn]) => typeof fn === 'function').map(([name, fn]) => [name, async (payload = {}) => {
      const ctx = await buildSchoolContext({ repo, actorId: actor || null, scope: target });
      return (await fn(payload, { ...ctx, isMock: true })).data;
    }]));
  }
  space.forScope = target => api(undefined, target);
  const record = dto => ({ ...dto, _id: dto.matchId });
  const fixture = {
    api, repo, restore: () => { space.forScope = original; },
    async submitMatch(payload) {
      const result = await api(payload.actor).submitSchoolMatch({ ...payload, matchId: payload.id, requestId: `fixture_${++sequence}` });
      return { ...result, match: result.match && record(result.match) };
    },
    confirmMatch: (matchId, actor) => api(actor).confirmSchoolMatch({ matchId }),
    assignMatchReferee: (matchId, refereeId, actor) => api(actor).assignSchoolMatchReferee({ matchId, refereeId }),
    async getMatchRecords(filter = {}) {
      if (filter.id) { const r = await api('u01').getSchoolMatch({ matchId: filter.id }); return r.ok ? [record(r.match)] : []; }
      const r = await api('u01').listSchoolMatches({ ...filter, limit: 10000 });
      assert.equal(r.ok, true, r.message); return r.matches.map(record);
    },
    async getMatches() { return (await fixture.getMatchRecords()).filter(m => m.status === 1); },
    async getMembers() { return (await api('u01').getSchoolMatchEntryContext({})).members.map(m => ({ ...m, _id: m.userId })); },
  };
  return fixture;
}
module.exports = { createMatchFixture };
