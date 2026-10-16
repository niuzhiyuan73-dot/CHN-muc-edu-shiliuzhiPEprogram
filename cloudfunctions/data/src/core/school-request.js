/** 协议 2：学校身份 + 协会空间接口。未迁移的旧 action 不可借此跨校调用。 */
const { fail } = require('../envelope.js');
const { buildSchoolContext } = require('./school-context.js');
const handlers = {
  ...require('./school-member-handlers.js'),
  ...require('./school-space-handlers.js'),
  // 跨校邀请赛：2026-10-16 接入协议 2（此前只在本地模拟口径开放）
  ...require('./school-exchange-handlers.js'),
};

async function handleSchoolRequest(event, { repo, openId, now = new Date() }) {
  if (event.protocolVersion !== 2) return fail('学校接口需要协议版本 2，请升级客户端');
  if (!Object.prototype.hasOwnProperty.call(handlers, event.action)) return fail('该操作尚未支持学校范围');
  if (!event.schoolId || !event.association) return fail('学校接口必须指定学校和项目');
  const ctx = await buildSchoolContext({ repo, openId, now,
    scope: { schoolId: event.schoolId, association: event.association } });
  return handlers[event.action](event.payload || {}, ctx);
}

module.exports = { handleSchoolRequest };
