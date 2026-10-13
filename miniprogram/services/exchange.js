const identity = require('./school-identity.js');
const mock = require('./school-mock.js');
function forScope(scope) {
  if (!identity.isMockNow()) throw new Error('跨校邀请赛尚未开放云端，请先完成多校迁移与联调');
  return mock.forExchange(scope);
}
module.exports = { forScope };
