/** 协议 2：学校身份 + 协会空间接口。未迁移的旧 action 不可借此跨校调用。 */
const { fail } = require('../envelope.js');
const { buildSchoolContext } = require('./school-context.js');
const { buildMeetContext } = require('../../lib/services/meet-context.js');
const { SCHOOL_MEET_ACTIONS } = require('../../lib/utils/school-actions.js');
const { guardRate } = require('./rate-limit.js');
const handlers = {
  ...require('./school-member-handlers.js'),
  ...require('./school-space-handlers.js'),
  // 跨校邀请赛：2026-10-16 接入协议 2（此前只在本地模拟口径开放）
  ...require('./school-exchange-handlers.js'),
  // 运动会：学校级栏目，请求不带 association（见下方分支）
  ...require('./school-meet-handlers.js'),
};

/**
 * 运动会动作集合。
 *
 * 为什么要单独一组：其余三面都要求 `event.association`，而运动会**不属于任何协会**。
 * 若让运动会也带一个协会参数，就等于把它挂到该协会上——停用协会会连带停用运动会，
 * 权限判断也会落到 memberships 上（交接文档 §7.2 点名的高危点）。
 */
const MEET_ACTIONS = new Set(SCHOOL_MEET_ACTIONS);

async function handleSchoolRequest(event, { repo, openId, now = new Date() }) {
  if (event.protocolVersion !== 2) return fail('学校接口需要协议版本 2，请升级客户端');
  if (!Object.prototype.hasOwnProperty.call(handlers, event.action)) return fail('该操作尚未支持学校范围');

  // 限流放在「动作确认存在」之后：未知动作不消耗配额，也免得把探测请求
  // 与真实业务混在一个桶里。每个读接口要读 6~8 个集合，不限流时一个
  // 在册账号的循环就能打空全校每日读配额（见 rate-limit.js 的说明）。
  const limited = guardRate(openId, event.action);
  if (limited) return fail(limited.message);

  // 运动会分支：只要求 schoolId，meetId 按动作可选（列表/建赛/搜项目都没有届）。
  if (MEET_ACTIONS.has(event.action)) {
    if (!event.schoolId) return fail('运动会接口必须指定学校');
    const meetCtx = await buildMeetContext({ repo, openId, now,
      scope: { schoolId: event.schoolId, meetId: event.meetId } });
    return handlers[event.action](event.payload || {}, meetCtx);
  }

  if (!event.schoolId || !event.association) return fail('学校接口必须指定学校和项目');
  const ctx = await buildSchoolContext({ repo, openId, now,
    scope: { schoolId: event.schoolId, association: event.association } });
  return handlers[event.action](event.payload || {}, ctx);
}

module.exports = { handleSchoolRequest };
