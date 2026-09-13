/**
 * 写操作的统一错误约定
 * ============================================================
 * 【要解决什么】
 * 两个数据源对「基础设施故障」的表现不一样：
 *   mock  —— 从不抛错，业务失败包在 {ok:false, message} 里正常返回；
 *   cloud —— 顶层失败（未登录、账号停用、事务失败、云环境未就绪）会被
 *            services/cloud.js 的 request() 直接抛出（见该文件说明）。
 *
 * 页面代码写惯了「等一个 {ok:...} 回来」，切到云端后，一次基础设施故障
 * 会让 await 当场抛出：若页面没包 try/catch，提示不弹、submitting 不复位，
 * 提交按钮从此卡死，还会留下一串未处理的 Promise rejection。这类页面有
 * 二十来个、写接口三十个，逐个包 try/catch 必然漏，漏掉的那一页就是
 * 「点了没反应」。
 *
 * 【怎么做】
 * 门面（services/index.js）在调用写接口时套上 guardWrite，把抛出的异常
 * 收敛成与 mock 同形的业务失败对象，页面只认一种形状：
 *   { ok:false, errors:{}, scoreErrors:[], firstError, message }
 * 成功则原样返回实现的结果。读接口不套——读失败本就该让页面自己去 catch，
 * 收敛成空数据反而会把故障伪装成「没有内容」。
 *
 * 【为什么写接口名单要显式列出来】
 * 门面是按 mock 的函数名单自动生成的，无法从函数名判断谁写谁读。这份名单
 * 与 cloud.js 的写接口一一对应，由 tests/write.test.js 守着，新增写接口
 * 时若忘了加进来，测试会指出「这个接口抛错时没人兜底」。
 * ============================================================
 */

/** 会改动数据的动作。顺序与 cloud.js 的写接口分组一致 */
const WRITE_ACTIONS = [
  // 比赛录入与流转
  'submitMatch',
  'confirmMatch',
  'rejectMatch',
  'revokeMatch',
  'forfeitMatch',
  // 会员注册与审核、干事任免
  'registerMember',
  'approveMember',
  'rejectMember',
  'setCollegeLeader',
  // 公告发布与下架
  'publishAnnouncement',
  'archiveAnnouncement',
  // 个人资料与赛季
  'updateProfile',
  'resetSeason',
  // 赛事闭环
  'publishEvent',
  'startEvent',
  'setEventPinned',
  'drawEvent',
  'signUpEvent',
  'cancelSignupEvent',
  'checkInEvent',
  'finishEvent',
  // 学院赛闭环
  'publishCollegeEvent',
  'submitCollegeEntry',
  'reviewCollegeEntry',
  'drawCollegeEvent',
  'startCollegeEvent',
  'setCollegeEventPinned',
  'submitLineup',
  'startTie',
  'recordForfeit',
  'finishCollegeEvent',
];

const WRITE_ACTION_SET = new Set(WRITE_ACTIONS);

/** 基础设施故障但异常没带 message 时的兜底提示 */
const FALLBACK_MESSAGE = '网络异常，请稍后重试';

/**
 * 该动作是否会改动数据（决定门面要不要套 guardWrite）。
 * @param {string} name
 * @returns {boolean}
 */
function isWriteAction(name) {
  return WRITE_ACTION_SET.has(name);
}

/**
 * 把一次写操作的异常收敛成业务失败形状。
 *
 * @param {Function} run 发起写操作，返回 Promise
 * @returns {Promise<Object>} 成功时是实现的原始结果；抛错时是
 *          {ok:false, errors:{}, scoreErrors:[], firstError, message}
 */
async function guardWrite(run) {
  try {
    return await run();
  } catch (err) {
    const message = (err && err.message) || FALLBACK_MESSAGE;
    return { ok: false, errors: {}, scoreErrors: [], firstError: message, message };
  }
}

module.exports = {
  WRITE_ACTIONS,
  FALLBACK_MESSAGE,
  isWriteAction,
  guardWrite,
};
