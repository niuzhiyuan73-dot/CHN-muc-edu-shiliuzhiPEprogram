/**
 * 统一数据云函数入口
 * ============================================================
 * 全站只有一个云函数，名为 data。前端把请求包成
 *   { action: 'getLeaderboard', payload: { project, options } }
 * 这里按 action 分发，返回
 *   { ok: true, data }  正常（业务失败也在 data.ok 里）
 *   { ok: false, message }  基础设施故障（未知操作、数据库报错等）
 *
 * 【为什么只有一个云函数】
 * 权限校验、身份解析（按 OpenID 查账号）、错误信封只写一份。云函数按
 * 个数计费与部署，散成几十个之后，改一条共用规则要改几十处。
 *
 * 【只有这个文件认识 wx-server-sdk】
 * 业务逻辑全在 src/ 下，不认识云开发，所以能在普通 Node 里跑单元测试。
 * 把 SDK 收在这一层，测试才不需要云环境、也不需要凭据。
 *
 * 【仓储为什么要缓存】
 * 云函数容器会热复用。db 句柄建一次就够，顺带让 derive.js 挂在仓储上的
 * 回放缓存也能在同一个热容器里留存。冷启动时重建，缓存自然从头来过。
 * ============================================================
 */

const cloud = require('wx-server-sdk');

const { fail } = require('./src/envelope.js');
const { dispatch } = require('./src/core/dispatch.js');
const { buildContext } = require('./src/core/context.js');
const { createRepo } = require('./src/adapters/cloud-repo.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 容器级仓储单例 */
let repo = null;

function getRepo() {
  if (!repo) repo = createRepo(cloud.database());
  return repo;
}

/**
 * 云函数入口。
 * @param {Object} event { action, payload }
 * @returns {Promise<Object>} 回包信封
 */
exports.main = async (event = {}) => {
  try {
    const { action, payload } = event;

    // OPENID 由微信注入，客户端伪造不了——这正是身份可信的唯一来源
    const { OPENID } = cloud.getWXContext();

    const ctx = await buildContext({
      repo: getRepo(),
      openId: OPENID,
      now: new Date(),
    });

    return await dispatch(action, payload, ctx);
  } catch (err) {
    // 到这里说明是没预料到的故障（数据库连不上、代码有 bug）。
    // 原始错误写进日志便于排查，回给前端的是不泄露内部细节的一句中文。
    console.error('[data] 处理失败', event && event.action, err);
    return fail('服务异常，请稍后再试');
  }
};
