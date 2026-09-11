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
const getHeadToHead = (userId) => request('getHeadToHead', { userId });
const getPartnerRecord = (userId) => request('getPartnerRecord', { userId });
const getEventRecord = (userId) => request('getEventRecord', { userId });
const getRatingHistory = (userId, pool) => request('getRatingHistory', { userId, pool });
const getForm = (userId, options) => request('getForm', { userId, options });
const getMyProjects = (userId) => request('getMyProjects', { userId });
const getHomeSummary = () => request('getHomeSummary');

/* 成绩录入与流转。权限一律由云函数在服务端判定，前端说了不算。 */
const getMatchRecords = (options) => request('getMatchRecords', options);
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
const approveMember = (applicationId, actor) => request('approveMember', { applicationId, actor });
const rejectMember = (applicationId, actor, reason) =>
  request('rejectMember', { applicationId, actor, reason });

/*
 * 公告发布与下架。
 *
 * 与审核同理：actor 只是「谁点的按钮」的线索，真正的发布权由云函数按
 * OpenID 在服务端判定，前端说了不算。form 里只有标题、正文这些内容字段，
 * 发布者与发布时间一律由服务端填。
 */
const publishAnnouncement = (form, actor) => request('publishAnnouncement', { form, actor });
const archiveAnnouncement = (id, actor) => request('archiveAnnouncement', { id, actor });

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
  submitMatch,
  confirmMatch,
  rejectMatch,
  revokeMatch,
  registerMember,
  approveMember,
  rejectMember,
  publishAnnouncement,
  archiveAnnouncement,
};
