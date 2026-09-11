/**
 * 调用上下文
 * ============================================================
 * 【身份只认 OpenID，不认前端传的 actor】
 * cloud.js 的注释写得很明白：前端传上来的 actor 只是个提示，可能是任何
 * 字符串。真正的身份由 wx-server-sdk 的 getWXContext() 给出，服务端拿
 * 它回查 users 集合，查到的才是可信账号。否则改一个 role:2 就能凭空
 * 变成管理员——权限校验在服务端做的意义就没了。
 *
 * 【isMock 恒为 false】
 * mock 数据源为了让演示流程走得通，把确认、审核、发布都放宽成「登录即可」
 * （见 permission.js 的说明）。那是演示口径，云端一律走严格规则：
 * 确认限对手方、审核与公告限 role >= STAFF、管理员才能撤别人的比赛。
 * ============================================================
 */

const { ROLE } = require('../../lib/utils/constants.js');

/**
 * 组装一次调用的上下文。
 *
 * @param {Object} params
 * @param {Object} params.repo 仓储
 * @param {string} [params.openId] 微信 OpenID
 * @param {Date} [params.now] 当前时间，便于测试注入
 * @returns {Promise<Object>} 上下文对象
 */
async function buildContext({ repo, openId = '', now = new Date() }) {
  const actor = openId ? await repo.users.getByOpenId(openId) : null;

  return {
    repo,
    openId,
    now,
    actor: actor || null,
    actorId: actor ? actor._id : '',
    role: actor ? Number(actor.role || 0) : ROLE.MEMBER,
    // 云端永不放宽权限，这个字段存在是为了让共享的纯逻辑函数能收到一个
    // 明确的值，而不是 undefined
    isMock: false,
  };
}

/**
 * 写操作的前置检查：调用者得是个已登记的账号。
 *
 * @param {Object} ctx
 * @returns {string} 出错文案；通过时为空串
 */
function callerError(ctx) {
  if (!ctx.actor) return '请先登录后再操作';
  return '';
}

module.exports = { buildContext, callerError };
