/**
 * 云端数据源
 * ============================================================
 * 与 mock.js 实现同一套接口，只是把每个调用转成一次云函数请求。
 *
 * 【为什么现在就写这个文件】
 * 页面从第一天起就通过门面（services/index.js）取数，将来把数据源
 * 从 mock 换成 cloud 时，页面代码一行都不用改。如果等到接入云开发
 * 才去定义接口，各页面早就长出了各自的取数写法，迁移会非常痛苦。
 *
 * 【当前状态】
 * 云函数属于后续阶段的工作，尚未创建。这里只固定接口形态，
 * 因此现在调用会直接抛错——这是刻意的：与其返回一份假数据让人误以为
 * 已经接通，不如立刻报错，避免把问题带到更难排查的地方。
 *
 * 所有云函数统一命名为 `data`，通过 action 参数分发，
 * 这样云函数数量可控，权限校验也只需写一份。
 * ============================================================
 */

/** 统一的云函数名 */
const CLOUD_FUNCTION = 'data';

/**
 * 发起一次云端数据请求。
 *
 * @param {string} action 动作名，与 mock.js 中的函数名一致
 * @param {Object} [payload] 参数
 * @returns {Promise<*>}
 * @throws {Error} 未开通云开发或云函数尚未部署时抛出
 */
async function request(action, payload = {}) {
  if (typeof wx === 'undefined' || !wx.cloud) {
    throw new Error('云开发尚未初始化，请先在 app.js 中调用 wx.cloud.init');
  }

  const { result } = await wx.cloud.callFunction({
    name: CLOUD_FUNCTION,
    data: { action, payload },
  });

  if (!result || result.ok !== true) {
    throw new Error((result && result.message) || `云函数 ${action} 调用失败`);
  }
  return result.data;
}

/* ---------- 以下接口与 mock.js 一一对应 ---------- */

const getCurrentUser = () => request('getCurrentUser');
const getMembers = () => request('getMembers');
const getMember = (userId) => request('getMember', { userId });
const getMemberApplications = () => request('getMemberApplications');
const getMatches = (options) => request('getMatches', options);
const getEvents = () => request('getEvents');
const getAnnouncements = () => request('getAnnouncements');
const getAnnouncementRecords = () => request('getAnnouncementRecords');

const getLeaderboard = (project, options) => request('getLeaderboard', { project, options });
const getProgressLeaderboard = (project, options) =>
  request('getProgressLeaderboard', { project, options });
const getPercentile = (userId, project) => request('getPercentile', { userId, project });

const getMatchHistory = (userId, options) => request('getMatchHistory', { userId, options });
// options 必须透传：对头 / 搭档 / 赛事记录都按它筛池与限条数，丢掉就变成
// 「传了筛选条件却拿到全部」，页面还以为后端已经按条件给了。
const getHeadToHead = (userId, options) => request('getHeadToHead', { userId, options });
const getPartnerRecord = (userId, options) => request('getPartnerRecord', { userId, options });
const getEventRecord = (userId, options) => request('getEventRecord', { userId, options });
const getRatingHistory = (userId, pool) => request('getRatingHistory', { userId, pool });
const getForm = (userId, options) => request('getForm', { userId, options });
const getMyProjects = (userId) => request('getMyProjects', { userId });
const getHomeSummary = () => request('getHomeSummary');

/* 成绩录入与流转。权限一律由云函数在服务端判定，前端说了不算。 */
const getMatchRecords = (options) => request('getMatchRecords', options);
const getSeasonState = () => request('getSeasonState');
const submitMatch = (params) => request('submitMatch', params);
const confirmMatch = (id, actor) => request('confirmMatch', { id, actor });
const rejectMatch = (id, actor, reason) => request('rejectMatch', { id, actor, reason });
const revokeMatch = (id, actor, reason) => request('revokeMatch', { id, actor, reason });

/*
 * 会员注册与审核。
 *
 * 【registerMember 为什么只上送 profile】
 * 账号记录（_id、role、status）一律由云函数按 OpenID 生成。若把客户端
 * 造好的账号整个送上去，改一个 role: 2 就能自封管理员，甚至自己给自己
 * 写一个 status: ACTIVE。申请人的身份只有一个来源：服务端。
 *
 * 审核同理：actor 只是「谁点的按钮」的线索，真正的审核权由云函数按
 * OpenID 在服务端判定，前端说了不算。
 */
const registerMember = (profile, options) => request('registerMember', { profile, options });
// initialElo 是管理员在通过时手工填的初始等级分（选填）。它同样不被前端信任：
// 云函数会用 validateInitialElo 再校验一遍取值范围。
const approveMember = (applicationId, actor, initialElo) =>
  request('approveMember', { applicationId, actor, initialElo });
const rejectMember = (applicationId, actor, reason) =>
  request('rejectMember', { applicationId, actor, reason });
// 任免干事。目标角色由服务端的 validateCollegeLeader 算出，前端只传「是谁」
// 与「设还是撤」。actor 同样不被信任，只为日志留个线索。
const setCollegeLeader = (userId, actor, makeLeader) =>
  request('setCollegeLeader', { userId, actor, makeLeader });

/*
 * 公告发布与下架。
 *
 * 与审核同理：actor 只是「谁点的按钮」的线索，真正的发布权由云函数按
 * OpenID 在服务端判定，前端说了不算。form 里只有标题、正文这些内容字段，
 * 发布者与发布时间一律由服务端填。
 */
const publishAnnouncement = (form, actor) => request('publishAnnouncement', { form, actor });
const archiveAnnouncement = (id, actor) => request('archiveAnnouncement', { id, actor });

/*
 * 修改自己的昵称与头像。
 *
 * actor 只是「谁点的按钮」的线索，真正的身份由云函数按 OpenID 在服务端
 * 判定，前端说了不算。patch 里只有昵称与头像两个字段——真实姓名、学号
 * 即使被塞进来，服务端也会按白名单丢掉。
 */
const updateProfile = (patch, actor) => request('updateProfile', { patch, actor });

/*
 * 赛季管理。软重置会按公式改动全俱乐部每个人的分数，权限门槛高于发布
 * 公告：服务端按 OpenID 判定必须为管理员。actor 同样只是「谁点的按钮」
 * 的线索，前端说了不算。
 */
const resetSeason = (actor) => request('resetSeason', { actor });

/*
 * 赛事闭环：发布 / 开始 / 报名 / 退赛 / 签到 / 录入名次。
 *
 * 与审核、公告同一纪律：actor 只是「谁点的按钮」的线索，发布权、签到权
 * 由云函数按 OpenID 在服务端判定。报名人更是只认 OpenID——不接受
 * userId 参数，否则谁都能替别人报名。报名记录按「赛事 + 会员」自然键
 * 去重，连点两下不会多出一条。
 */
const getEventSignups = (eventId) => request('getEventSignups', { eventId });
const publishEvent = (form, actor) => request('publishEvent', { form, actor });
const startEvent = (id, actor) => request('startEvent', { id, actor });
// 抽签（含重抽）。seedValue / manualOrder 都是可选：前者用于固定随机结果
// （主要是测试与复核），后者只在「手工指定种子」模式下才带。
const drawEvent = (id, actor, options) => request('drawEvent', { id, actor, ...options });
const signUpEvent = (id, actor) => request('signUpEvent', { id, actor });
const cancelSignupEvent = (id, actor) => request('cancelSignupEvent', { id, actor });
const checkInEvent = (id, userId, actor) => request('checkInEvent', { id, userId, actor });
const finishEvent = (id, results, actor) => request('finishEvent', { id, results, actor });
// 个人赛弃权：参赛者本人自选，或管理员代记。forfeitBy 是弃权者的会员编号，
// 胜方由服务端按它站在哪一边推出，前端说了不算（D41）
const forfeitMatch = (id, forfeitBy, actor) => request('forfeitMatch', { id, forfeitBy, actor });

/*
 * 学院赛闭环：发布 / 交名单 / 审名单。
 *
 * 与赛事闭环同一纪律：actor 只是「谁点的按钮」的线索，发布权、审核权由
 * 云函数按 OpenID 在服务端判定。名单的队员身份也不被前端信任——服务端会
 * 拿会员台账回查每个人的学院与在册状态，塞一个别院的人进来会被拒。
 */
const getCollegeEvents = () => request('getCollegeEvents');
const getCollegeEvent = (id) => request('getCollegeEvent', { id });
const getCollegeEntries = (eventId) => request('getCollegeEntries', { eventId });
const getCollegeTies = (eventId) => request('getCollegeTies', { eventId });
const getCollegeLineups = (eventId) => request('getCollegeLineups', { eventId });
const publishCollegeEvent = (form, actor) => request('publishCollegeEvent', { form, actor });
// payload 只含 eventId / college / memberIds / remark；提交人与时间由服务端填
const submitCollegeEntry = (payload, actor) => request('submitCollegeEntry', { ...payload, actor });
const reviewCollegeEntry = (entryId, action, reason, actor) =>
  request('reviewCollegeEntry', { entryId, action, reason, actor });
// 抽签：seedColleges 是有序种子（可空），seedValue 只在测试 / 复核时显式给
const drawCollegeEvent = (eventId, actor, options) =>
  request('drawCollegeEvent', { eventId, actor, ...options });
const startCollegeEvent = (eventId, actor) => request('startCollegeEvent', { eventId, actor });
// payload 只含 tieId / college / entries；提交人与时间由服务端填
const submitLineup = (payload, actor) => request('submitLineup', { ...payload, actor });
const startTie = (tieId, actor) => request('startTie', { tieId, actor });
// 管理员记弃权：对手直接拿到这一小项，且不计 ELO。forfeitBy 必须是本大场参赛学院
const recordForfeit = (tieId, legNo, forfeitBy, actor) =>
  request('recordForfeit', { tieId, legNo, forfeitBy, actor });
// 录入学院名次并结束赛事：results 形如 [{ college, placement }]，只记给学院（D26）
const finishCollegeEvent = (id, results, actor) =>
  request('finishCollegeEvent', { id, results, actor });

module.exports = {
  CLOUD_FUNCTION,
  request,
  getCurrentUser,
  getMembers,
  getMember,
  getMemberApplications,
  getMatches,
  getEvents,
  getAnnouncements,
  getAnnouncementRecords,
  getLeaderboard,
  getProgressLeaderboard,
  getPercentile,
  getMatchHistory,
  getHeadToHead,
  getPartnerRecord,
  getEventRecord,
  getRatingHistory,
  getForm,
  getMyProjects,
  getHomeSummary,
  getMatchRecords,
  getSeasonState,
  submitMatch,
  confirmMatch,
  rejectMatch,
  revokeMatch,
  registerMember,
  approveMember,
  rejectMember,
  setCollegeLeader,
  publishAnnouncement,
  archiveAnnouncement,
  updateProfile,
  resetSeason,
  getEventSignups,
  publishEvent,
  startEvent,
  drawEvent,
  signUpEvent,
  cancelSignupEvent,
  checkInEvent,
  finishEvent,
  forfeitMatch,
  getCollegeEvents,
  getCollegeEvent,
  getCollegeEntries,
  getCollegeTies,
  getCollegeLineups,
  publishCollegeEvent,
  submitCollegeEntry,
  reviewCollegeEntry,
  drawCollegeEvent,
  startCollegeEvent,
  submitLineup,
  startTie,
  recordForfeit,
  finishCollegeEvent,
};
