/**
 * 会员审核 —— 权限与状态流转
 * ============================================================
 * 入会申请要回答三个问题，答案全在这里：
 *   1. 我有没有资格审核？（审核权）
 *   2. 我能不能审这一条？（不能审自己的）
 *   3. 我填的理由够不够格把这条申请批掉？（驳回校验）
 *
 * 【为什么单独成模块】
 * 与 match-record.js 同一套路数：这三件事都是纯判断，不碰 wx、不碰数据源。
 * 放进页面里就要靠点真机验证，放进 mock.js 又会被卷进「哪些申请该列出来」
 * 的取数逻辑里。单独拿出来，权限的每一条边界都能用字面量在 Node 里钉死。
 *
 * 【为什么注册产生的是申请而不是会员】
 * 实名信息必须有人核对学号与姓名是否对得上，否则谁都能填个假名注册进来
 * 打球。所以 auth.buildAccount 一律产出 PENDING，而把 PENDING 变成 ACTIVE
 * 的权力收在这里——这是防刷分的第一道闸门。
 *
 * 【mock 下的审核权为什么放宽】
 * 种子里 24 位会员的 role 全是普通会员，没有管理员可演示；真要严格按
 * 「role >= 干事」，本地任何一条申请都永远批不了，这条链路走不通。
 * 所以 isMock 时放宽为「已登录的正常会员即可审」，界面必须把这一点
 * 明示出来（见 member-review-view 的 demoNotice）。放宽只影响 mock，
 * 云端仍走严格口径。
 *
 * 【有一条规则 mock 下也不放宽】
 * 任何人不能审核自己的申请。若连这条也放开，放开的那一瞬就变成了
 * 「注册即可自封正式会员」，前面的闸门等于没装。
 * ============================================================
 */

const { USER_STATUS, USER_STATUS_LABEL } = require('../utils/constants.js');
const { formatDateTime } = require('../utils/format.js');
const { canManage } = require('./permission.js');

/** 审核动作 */
const REVIEW_ACTION = {
  APPROVE: 'approve', // 通过
  REJECT: 'reject', // 驳回
};

/**
 * 状态标签的文案与样式类。
 *
 * 【驳回为什么借「已禁用」的壳】
 * 驳回和禁用都会让账号无法使用，区别只在动作和理由——驳回是「资料没通过」，
 * 禁用是「违规被封」。为驳回单开一个枚举值，会让所有「判断账号能不能用」
 * 的地方都要改，而 constants.js 规定枚举只增不改，所以靠 action 区分文案即可。
 * 这与 MATCH_STATUS.REVOKED 被撤销/驳回共用是同一先例。
 *
 * @param {number} status 取值见 constants.USER_STATUS
 * @param {string} [action] 取值见 REVIEW_ACTION
 * @returns {{label:string, className:string}}
 */
function statusTagOf(status, action) {
  if (status === USER_STATUS.PENDING) return { label: '待审核', className: 'is-pending' };
  if (status === USER_STATUS.DISABLED) {
    return action === REVIEW_ACTION.REJECT
      ? { label: '已驳回', className: 'is-rejected' }
      : { label: '已禁用', className: 'is-disabled' };
  }
  if (status === USER_STATUS.ACTIVE) return { label: '正常', className: 'is-active' };
  return { label: USER_STATUS_LABEL[status] || '未知状态', className: 'is-unknown' };
}

/**
 * 这条申请是不是审核者自己的。
 * @param {Object|null} actor 审核者
 * @param {Object|null} application 被审的申请
 * @returns {boolean}
 */
function isSelf(actor, application) {
  return Boolean(
    actor && application && actor._id && application._id && actor._id === application._id
  );
}

/**
 * 有没有审核资格。
 *
 * 判定规则本身与「发公告」等管理动作一字不差，已抽到 permission.canManage；
 * 这里只把它包一层，留住「审核」这个业务语义的函数名，调用方不必知道它
 * 背后其实就是通用的管理权限。
 *
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false] mock 下放宽为「已登录的正常会员即可」
 * @returns {boolean}
 */
function canReview(actor, options = {}) {
  return canManage(actor, options);
}

/**
 * 能不能审这一条。
 *
 * 「自己审自己」先于其它条件挡住：即便放宽口径下人人可审，本人的申请
 * 也一律不出按钮。
 *
 * @param {Object|null} actor
 * @param {Object|null} application
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false]
 * @returns {boolean}
 */
function canReviewApplication(actor, application, options = {}) {
  if (!canReview(actor, options)) return false;
  if (!application) return false;
  if (isSelf(actor, application)) return false;
  // 只有待审核的申请才谈得上处理；已经批过或驳回过的不能再动
  return application.status === USER_STATUS.PENDING;
}

/**
 * 校验一次审核动作。
 *
 * 顺序刻意从「我有没有资格」到「这条单子能不能动」，这样一个没权限的人
 * 看到的是「没有审核权限」，而不是一条莫名其妙的「已经处理过了」。
 *
 * @param {Object|null} actor
 * @param {Object|null} application
 * @param {string} action 取值见 REVIEW_ACTION
 * @param {string} [reason] 驳回理由，通过时可以不填
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false]
 * @returns {{ok:boolean, message:string}}
 */
function validateReview(actor, application, action, reason, options = {}) {
  if (!canReview(actor, options)) return { ok: false, message: '当前账号没有审核权限' };
  if (!application) return { ok: false, message: '找不到这条入会申请' };
  if (isSelf(actor, application)) return { ok: false, message: '不能审核自己的申请' };
  if (application.status !== USER_STATUS.PENDING) {
    return { ok: false, message: '这条申请已经处理过了' };
  }
  if (action !== REVIEW_ACTION.APPROVE && action !== REVIEW_ACTION.REJECT) {
    return { ok: false, message: '未知的审核操作' };
  }
  // 驳回必须给理由：没有理由的驳回，申请人问起来谁也说不清当初为什么被拒
  if (action === REVIEW_ACTION.REJECT && !String(reason || '').trim()) {
    return { ok: false, message: '请填写驳回理由' };
  }

  return { ok: true, message: '' };
}

/**
 * 整形申请列表的一行。
 *
 * 与 match-view.buildRecordRow 同一约定：把权限算进数据里，模板只照着
 * 渲染按钮，不写 `wx:if="{{viewer.role >= 1}}"` 这类业务判断——那种写法
 * Node 跑不了，等于没法测。
 *
 * @param {Object} application 一条账号记录（待审核 / 已驳回 / 已禁用）
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @param {boolean} [ctx.isMock=false] 是否放宽审核权
 * @returns {Object}
 */
function buildApplicationRow(application, ctx = {}) {
  const { actor = null, isMock: mock = false } = ctx;

  const tag = statusTagOf(application.status, application.action);
  const self = isSelf(actor, application);
  const relaxed = canReview(actor, { isMock: mock });
  const strict = canReview(actor, { isMock: false });
  const allowed = canReviewApplication(actor, application, { isMock: mock });

  return {
    applicationId: application._id,
    // 注册时昵称可能没填，退回真实姓名，再退回编号——绝不渲染出 undefined
    nickName: application.nickName || application.realName || application._id,
    avatarUrl: application.avatarUrl || '',
    realName: application.realName || '',
    studentId: application.studentId || '',
    college: application.college || '',
    phone: application.phone || '',
    appliedAtText: formatDateTime(application.joinDate),
    statusLabel: tag.label,
    statusClass: tag.className,
    action: application.action || '',
    reason: application.reason || '',
    isSelf: self,
    // 自己被自己审时模板据此渲染一句提示，而不是两个按不动的按钮
    canApprove: allowed,
    canReject: allowed,
    // 权限只来自 mock 放宽时置真——界面据此标注「演示口径」
    reviewRelaxed: relaxed && !strict,
  };
}

module.exports = {
  REVIEW_ACTION,
  statusTagOf,
  isSelf,
  canReview,
  canReviewApplication,
  validateReview,
  buildApplicationRow,
};
