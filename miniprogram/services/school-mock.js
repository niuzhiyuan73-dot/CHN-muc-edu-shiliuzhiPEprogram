const { createSchoolDemoSeed } = require('./school-seed.js');
const { createSchoolMemoryRepo } = require('./school-memory-repo.js');
const { createSchoolHandlers } = require('./school-membership-service.js');
const { buildSchoolContext } = require('./school-context.js');
const { schoolScope, schoolKey } = require('../utils/school.js');

const DEMO_ACTORS = Object.freeze([
  { id: 'demo_applicant', label: '模拟申请人' },
  { id: 'demo_muc_admin', label: '民大校管理员' },
  { id: 'demo_buaa_admin', label: '北航校管理员' },
]);
let actorId = DEMO_ACTORS[0].id;
let repo;
const handlers = createSchoolHandlers({ claimKey: (schoolId, studentId) => schoolKey('demo-claim', schoolId, studentId) });
function reset() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_applicant', openId: 'mock_openid_applicant', nickName: '模拟申请人',
    platformStatus: 'active', platformRole: 'member', simulated: true });
  repo = createSchoolMemoryRepo(seed);
  actorId = DEMO_ACTORS[0].id;
}
reset();
function setDemoActor(id) {
  if (!DEMO_ACTORS.some(actor => actor.id === id)) throw new Error('未知模拟身份');
  actorId = id;
}
function forSchoolIdentity(input) {
  const scope = schoolScope(input);
  const boundActor = actorId;
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, actorId: boundActor, scope });
    const result = await handler(payload || {}, ctx);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  }])));
}
module.exports = { forSchoolIdentity, setDemoActor, getDemoActor: () => actorId, DEMO_ACTORS, reset };
