/** 协议 2：学校身份 + 协会空间接口。未迁移的旧 action 不可借此跨校调用。 */
const { fail } = require('../envelope.js');
const { buildSchoolContext } = require('./school-context.js');
const { buildMeetContext } = require('../../lib/services/meet-context.js');
const { SCHOOL_MEET_ACTIONS } = require('../../lib/utils/school-actions.js');
const { guardRate } = require('./rate-limit.js');
const contextCache = require('../../lib/services/context-cache.js');
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

/**
 * 允许未登录调用的动作。
 *
 * 【为什么存在】（2026-10-21）
 * 小程序的第一步是「选学校与学院」和「查我是谁」，那时还没有账号：
 *   · getSchoolDirectory      —— 选校/选院目录（登录页要渲染）；
 *   · getSchoolIdentitySession —— 未登录时返回 guest 会话，页面据此决定跳登录。
 * 这两个动作本身就设计成对匿名可用，测试（school-membership.test.js）也钉着
 * 「guest.user === null」这一口径。
 *
 * 【为什么其余一律要求登录】
 * 协议 2 的每个动作都要按 OPENID 解析账号，没有它就只会白读「学校 + 协会」
 * 两条记录再把权限判死——那 2 次读正是匿名攻击的成本。把匿名面收窄到这两个
 * 动作，配合 rate-limit.js 的匿名桶（全站 3 读/秒），匿名流量的读消耗被压到
 * 可忽略。新增公开接口必须来这里登记，默认要求登录。
 */
const ANON_ACTIONS = new Set(['getSchoolDirectory', 'getSchoolIdentitySession']);

/**
 * 写完之后**只清本范围**缓存的动作（2026-10-27 第八轮审查 P2-6）。
 *
 * 【为什么不是一律全清】判球一次就是一次写，全清会把所有用户的上下文一起打掉：
 * 一场比赛 50 球期间，观众与其它协会的读请求全部命中不了缓存——缓存对最热的
 * 计分台反而完全失效。而这些动作只写实时比分 / 比赛记录，不碰
 * schoolMembers / schoolRoles / memberships，**不可能改变任何人的身份**，
 * 所以按 `schoolId + association` 失效就够。
 *
 * 【新增条目的判据】只允许「纯比赛类」写：不写学籍、不写角色、不写会籍、
 * 不改学校/协会状态。撤权、审批、任免、变更学籍一律走全清（默认分支）。
 * 拿不准就别加——多清一次只多付几次读，漏清是一段撤权不生效的窗口。
 */
const SCOPE_ONLY_INVALIDATION = new Set([
  'startSchoolLiveScore', 'recordSchoolRally', 'undoSchoolRally', 'finishSchoolLiveScore',
  'startTeamLiveScore', 'updateTeamLiveScore',
]);

async function handleSchoolRequest(event, { repo, openId, clientIp = '', now = new Date() }) {
  if (event.protocolVersion !== 2) return fail('学校接口需要协议版本 2，请升级客户端');
  if (!Object.prototype.hasOwnProperty.call(handlers, event.action)) return fail('该操作尚未支持学校范围');

  // 没有 OPENID ⇒ 不是小程序端发起的调用（控制台直调 / 伪造 HTTP）。只放行
  // 上面那两个公开动作，其余直接拒——不然匿名请求会白耗 2 次数据库读。
  if (!openId && !ANON_ACTIONS.has(event.action)) return fail('请先登录后再使用');

  // 限流放在「动作确认存在」之后：未知动作不消耗配额，也免得把探测请求
  // 与真实业务混在一个桶里。每个读接口要读 6~8 个集合，不限流时一个
  // 在册账号的循环就能打空全校每日读配额（见 rate-limit.js 的说明）。
  // clientIp 只用于**匿名**分桶：匿名请求没有 OPENID 可分，过去全站共用一个桶，
  // 一个来源打满就让所有新用户卡在选校页（2026-10-27 第八轮审查 P1-5）。
  const limited = guardRate(openId, event.action, now.getTime(), { clientIp });
  if (limited) return fail(limited.message);

  // 【身份上下文缓存】（2026-10-23 H-10）读动作的上下文缓存 5 秒；写动作不缓存，
  // 且执行完让缓存失效——写请求可能改了**别人**的权限/状态，而缓存里存的是
  // 别人的上下文。默认全清；只有 SCOPE_ONLY_INVALIDATION 里的纯比赛类写
  // 才按范围清（2026-10-27 第八轮审查 P2-6，理由见那里的注释）。
  //
  // 用 try/finally 保证 handler 抛错时也失效：一次失败的事务可能已经改了一半。
  const readOnly = contextCache.isReadAction(event.action);
  try {
    // 运动会分支：只要求 schoolId，meetId 按动作可选（列表/建赛/搜项目都没有届）。
    if (MEET_ACTIONS.has(event.action)) {
      if (!event.schoolId) return fail('运动会接口必须指定学校');
      const meetCtx = await buildMeetContext({ repo, openId, now, action: event.action,
        scope: { schoolId: event.schoolId, meetId: event.meetId } });
      return await handlers[event.action](event.payload || {}, meetCtx);
    }

    if (!event.schoolId || !event.association) return fail('学校接口必须指定学校和项目');
    const ctx = await buildSchoolContext({ repo, openId, now, action: event.action,
      scope: { schoolId: event.schoolId, association: event.association } });
    return await handlers[event.action](event.payload || {}, ctx);
  } finally {
    if (!readOnly) {
      // 纯比赛类写只失效本范围（见 SCOPE_ONLY_INVALIDATION）；其余全清。
      // 运动会没有 association，因此不进白名单，走全清。
      if (SCOPE_ONLY_INVALIDATION.has(event.action) && event.association) {
        contextCache.invalidateScope(event.schoolId, event.association);
      } else {
        contextCache.invalidateAll();
      }
    }
  }
}

module.exports = { handleSchoolRequest };
