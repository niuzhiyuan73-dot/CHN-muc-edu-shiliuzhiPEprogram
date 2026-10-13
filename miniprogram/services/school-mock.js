const { createSchoolDemoSeed } = require('./school-seed.js');
const { createSchoolMemoryRepo } = require('./school-memory-repo.js');
const { createSchoolHandlers } = require('./school-membership-service.js');
const { buildSchoolContext } = require('./school-context.js');
const { schoolScope, schoolKey } = require('../utils/school.js');
const exchange = require('./exchange-service.js');

const DEMO_ACTORS = Object.freeze([
  { id: 'demo_applicant', label: '模拟申请人' },
  { id: 'demo_muc_admin', label: '民大校管理员' },
  { id: 'demo_buaa_admin', label: '北航校管理员' },
  { id: 'demo_muc_member', label: '民大会员' },
  { id: 'demo_buaa_member', label: '北航会员' },
  // 平台管理员排在最后，以免挪动既有演示身份的下标（页面与用例都按下标选择）。
  { id: 'demo_platform_admin', label: '平台管理员' },
]);
let actorId = DEMO_ACTORS[0].id;
let repo;
const handlers = createSchoolHandlers({ claimKey: (schoolId, studentId) => schoolKey('demo-claim', schoolId, studentId) });
function reset() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_applicant', openId: 'mock_openid_applicant', nickName: '模拟申请人',
    platformStatus: 'active', platformRole: 'member', simulated: true });
  // 平台管理员：账号级身份，可跨校读、跨校指定权限；不带 primarySchoolId，不占某校身份。
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin', nickName: '平台管理员',
    platformStatus: 'active', platformRole: 'admin', simulated: true });
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
function forExchange(input) {
  const target = schoolScope(input);
  const boundActor = actorId;
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(exchange).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, actorId: boundActor, scope: target });
    return (await handler(payload || {}, ctx)).data;
  }])));
}
module.exports.forExchange = forExchange;
