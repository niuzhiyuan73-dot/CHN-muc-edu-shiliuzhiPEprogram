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
const { isKnownAssociation, getAssociation } = require('./lib/utils/associations.js');
const { ASSOCIATION_STATUS } = require('./lib/utils/constants.js');
const { handleSchoolRequest } = require('./src/core/school-request.js');
const { isSchoolRequest } = require('./src/core/route.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 容器级仓储单例 */
let repo = null;

function getRepo() {
  if (!repo) repo = createRepo(cloud.database());
  return repo;
}

/**
 * 解析并校验请求携带的协会 id。
 *
 * 【为什么带错协会要当场拒绝，而不是静默退回默认】
 * 请求里的协会决定了这次读写落在哪个协会名下。若 id 打错还默默用兜底
 * 协会，数据就会被写进另一个协会而无人察觉。宁可明确失败，让前端去修。
 * 空值（未携带）才允许走默认——那是「首次进入尚未选协会」的正常情形。
 *
 * @param {*} association
 * @returns {{ id: string, error: string }}
 */
function resolveAssociation(association) {
  if (association === undefined || association === null || association === '') {
    return { id: '', error: '' };
  }
  if (!isKnownAssociation(association)) {
    return { id: '', error: `未知的协会：${association}` };
  }
  if (getAssociation(association).status !== ASSOCIATION_STATUS.ACTIVE) {
    return { id: '', error: '该协会已停用' };
  }
  return { id: association, error: '' };
}

/**
 * 云函数入口。
 * @param {Object} event { action, payload, association }
 * @returns {Promise<Object>} 回包信封
 */
exports.main = async (event = {}) => {
  try {
    const { action, payload } = event;
    // 只认 protocolVersion：协议 2 客户端总是带它（见 src/core/route.js 的说明）。
    // 从前这里还把顶层 schoolId 当信号，会让「旧协议请求恰好带了 schoolId」
    // 得到一句误导性的「需要协议版本 2」。
    if (isSchoolRequest(event)) {
      const { OPENID } = cloud.getWXContext();
      return await handleSchoolRequest(event, { repo: getRepo(), openId: OPENID });
    }

    const assoc = resolveAssociation(event.association);
    if (assoc.error) return fail(assoc.error);

    // OPENID 由微信注入，客户端伪造不了——这正是身份可信的唯一来源
    const { OPENID } = cloud.getWXContext();

    const ctx = await buildContext({
      repo: getRepo(),
      openId: OPENID,
      now: new Date(),
      association: assoc.id,
    });

    return await dispatch(action, payload, ctx);
  } catch (err) {
    // 到这里说明是没预料到的故障（数据库连不上、代码有 bug）。
    // 原始错误写进日志便于排查，回给前端的是不泄露内部细节的一句中文。
    console.error('[data] 处理失败', event && event.action, err);
    return fail('服务异常，请稍后再试');
  }
};
