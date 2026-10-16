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
 * 学校维度（协议 2）的三个门面（school-cloud.js 的 forSchoolIdentity /
 * forAssociationSpace / forExchange）同属这一约定：它们的 requestFor 对
 * SCHOOL_WRITE_ACTIONS 里的动作套 guardWrite，读动作放行。此前这三处没套，
 * 云端一次故障就让 11 个页面的提交按钮永久卡死。
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
  // 裁判指派（仅管理员）
  'assignMatchReferee',
  'assignTieReferee',
  // 会员注册与审核、学院负责人 / 协会负责人任免、当前等级分调整
  'registerMember',
  'approveMember',
  'rejectMember',
  'setCollegeLeader',
  'setAssociationLeader',
  'setMemberElo',
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
  // 实时比分：开台 / 判球 / 撤销 / 定稿（每球不动赛季版本号，定稿才重放）
  'startLiveScore',
  'recordRally',
  'undoRally',
  'finishLiveScore',
];

const WRITE_ACTION_SET = new Set(WRITE_ACTIONS);

/**
 * 学校维度（协议 2）门面的写动作。
 * ============================================================
 * school-cloud.js / association-space.js / exchange.js 三个页面门面走的是
 * cloud.forSchoolIdentity / forAssociationSpace / forExchange，它们共用
 * school-cloud.js 里的 requestFor。这份名单就是 requestFor 判断「这个动作
 * 要不要套 guardWrite」的依据。
 *
 * 【为什么单独列一份，不并进上面的 WRITE_ACTIONS】
 * 上面那份是旧门面（services/index.js）的接口名，与 cloud.js / mock.js 的
 * 函数一一对应，由 tests/write.test.js 守着。学校维度是协议 2 的另一套动作
 * 名（submitSchoolMatch 而非 submitMatch），两套名字互不重叠；合在一起，
 * 「名单里的名字在 mock 与 cloud 都是函数」那条断言就会当场变红。
 *
 * 【为什么写动作能靠「不以 get / list 开头」兜住】
 * 学校维度的读动作一律以 get / list 起头（getSchoolMatch、listCollegeTies…），
 * 写动作没有一个是这两个前缀——这是这份名单能被 tests/school-write-guard.test.js
 * 双向校验的前提：门面里非读动作必须在名单里，名单里不许有读动作。将来若加了
 * 一个不符合这条约定的动作名，测试会立刻点名，而不是某个页面在故障时卡死。
 * ============================================================
 */
const SCHOOL_WRITE_ACTIONS = [
  // 学校身份：注册 / 入会申请与审核 / 授权 / 改资料 / 转校三动作
  'registerSchoolAccount',
  'applySchoolMembership',
  'reviewSchoolMembership',
  'grantSchoolPermission',
  'updateSchoolProfile',
  'applySchoolTransfer',
  'reviewSchoolTransfer',
  'cancelSchoolTransfer',
  // 协会空间：分组增删改、通知、训练、赛事 / 比赛 / 实时比分 / 学院赛的写入
  'createAssociationGroup',
  'updateAssociationGroup',
  'addAssociationGroupMembers',
  'removeAssociationGroupMember',
  'leaveAssociationGroup',
  'archiveAssociationGroup',
  'deleteAssociationGroup',
  'publishAssociationNotice',
  'updateAssociationNotice',
  'withdrawAssociationNotice',
  'publishTraining',
  'updateTraining',
  'cancelTraining',
  'finishTraining',
  'registerTraining',
  'cancelTrainingRegistration',
  'removeTrainingRegistration',
  'requestTrainingCheckIn',
  'confirmTrainingCheckIn',
  'rejectTrainingCheckIn',
  'revokeTrainingCheckIn',
  'setSchoolEventPinned',
  'publishSchoolEvent',
  'signUpSchoolEvent',
  'cancelSchoolEventSignup',
  'startSchoolEvent',
  'drawSchoolEvent',
  'checkInSchoolEvent',
  'finishSchoolEvent',
  'submitSchoolMatch',
  'confirmSchoolMatch',
  'rejectSchoolMatch',
  'revokeSchoolMatch',
  'forfeitSchoolMatch',
  'assignSchoolMatchReferee',
  'startSchoolLiveScore',
  'recordSchoolRally',
  'undoSchoolRally',
  'finishSchoolLiveScore',
  'publishCollegeEvent',
  'setCollegeEventPinned',
  'submitCollegeEntry',
  'reviewCollegeEntry',
  'drawCollegeEvent',
  'startCollegeEvent',
  'submitCollegeLineup',
  'startCollegeTie',
  'assignCollegeTieReferee',
  'finishCollegeEvent',
  'forfeitCollegeTieLeg',
  'publishSchoolAnnouncement',
  'archiveSchoolAnnouncement',
  'resetSchoolSeason',
  // 跨校邀请赛：建赛 / 邀请应答 / 报名签到 / 抽签指派 / 录分与定名次
  'createExchangeEvent',
  'respondExchangeInvitation',
  'signUpExchangeEvent',
  'cancelExchangeSignup',
  'removeExchangeSignup',
  'checkInExchangeSignup',
  'withdrawExchangeInvitation',
  'cancelExchangeEvent',
  'revokeExchangeScore',
  'lockExchangeRoster',
  'drawExchangeEvent',
  'assignExchangeReferee',
  'submitExchangeScore',
  'confirmExchangeRanking',
];

const SCHOOL_WRITE_ACTION_SET = new Set(SCHOOL_WRITE_ACTIONS);

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
 * 学校维度（协议 2）的该动作是否会改动数据。
 * 与 isWriteAction 分开，因为两套动作名分属两个门面体系（见上）。
 * @param {string} name
 * @returns {boolean}
 */
function isSchoolWriteAction(name) {
  return SCHOOL_WRITE_ACTION_SET.has(name);
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
  SCHOOL_WRITE_ACTIONS,
  FALLBACK_MESSAGE,
  isWriteAction,
  isSchoolWriteAction,
  guardWrite,
};
