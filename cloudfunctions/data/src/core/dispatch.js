/**
 * 动作分发
 * ============================================================
 * 云函数只有一个入口，靠 action 找到对应的处理器。处理器名单直接由
 * 各模块的导出拼成——不在别处再抄一份，否则加了处理器却忘了登记，
 * 表现就是线上「未知的操作」，而单元测试什么也发现不了。
 *
 * 【未知操作为什么算基础设施故障】
 * 那是前端的调用名写错了（或部署了旧版云函数），请求本身就无法处理，
 * 属于顶层 ok:false。而业务失败（权限不足、状态不对）由处理器自己
 * 包成 data.ok:false 正常返回，见 envelope.js 的说明。
 * ============================================================
 */

const { fail } = require('../envelope.js');
const readHandlers = require('./read-handlers.js');
const matchHandlers = require('./match-handlers.js');
const memberHandlers = require('./member-handlers.js');
const announcementHandlers = require('./announcement-handlers.js');
const seasonHandlers = require('./season-handlers.js');
const eventHandlers = require('./event-handlers.js');

/** action → 处理器 */
const HANDLERS = {
  ...readHandlers,
  ...matchHandlers,
  ...memberHandlers,
  ...announcementHandlers,
  ...seasonHandlers,
  ...eventHandlers,
};

/**
 * 把一次调用交给对应的处理器。
 *
 * @param {string} action 动作名
 * @param {Object} [payload] 调用参数
 * @param {Object} ctx 调用上下文
 * @returns {Promise<Object>} 回包信封
 */
async function dispatch(action, payload, ctx) {
  const handler = HANDLERS[action];
  if (typeof handler !== 'function') {
    return fail(`未知的操作：${action}`);
  }
  return handler(payload || {}, ctx);
}

module.exports = { HANDLERS, dispatch };
