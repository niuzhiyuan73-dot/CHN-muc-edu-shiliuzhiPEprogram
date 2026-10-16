/** S2 身份接口客户端，明确范围，不改变旧业务门面的行为。 */
const { schoolScope } = require('../utils/school.js');
const { guardWrite, isSchoolWriteAction } = require('../utils/write.js');

/**
 * 绑定范围 + 协议 2 的请求器；身份 / 协会空间 / 跨校邀请赛三个门面共用一份。
 *
 * 【写动作要不要套 guardWrite 的差别】
 * 云端的基础设施故障（未登录 / 账号停用 / 事务失败 / 云环境未就绪）会让
 * callFunction 当场抛出。页面写惯了「等一个 {ok:...} 回来」，若这层没人接住
 * 抛出，一次故障就能让 submitting 永远停在 true、提交按钮从此点不动——这正是
 * 学校维度 11 个页面此前在真实环境下的表现。所以写动作套 guardWrite，把抛出
 * 收敛成与 mock 同形的 {ok:false,...}；读动作放行，读失败仍让页面自己 catch
 * （收敛成空数据会把故障伪装成「没有内容」）。口径与 utils/write.js 一致。
 */
function requestFor(scope) {
  return (action, payload = {}) => {
    const run = async () => {
      if (typeof wx === 'undefined' || !wx.cloud) throw new Error('云开发尚未初始化');
      const { result } = await wx.cloud.callFunction({ name: 'data', data: {
        protocolVersion: 2, ...scope, action, payload,
      } });
      if (!result || !result.ok) throw new Error(result && result.message || '学校接口请求失败');
      return result.data;
    };
    return isSchoolWriteAction(action) ? guardWrite(run) : run();
  };
}

function forSchoolIdentity(input) {
  const request = requestFor(schoolScope(input));
  return Object.freeze({
    registerSchoolAccount: payload => request('registerSchoolAccount', payload),
    applySchoolMembership: payload => request('applySchoolMembership', payload),
    reviewSchoolMembership: payload => request('reviewSchoolMembership', payload),
    getMySchoolMembership: () => request('getMySchoolMembership'),
    getSchoolApplications: () => request('getSchoolApplications'),
    getSchoolDirectory: () => request('getSchoolDirectory'),
    getSchoolIdentitySession: () => request('getSchoolIdentitySession'),
    getSchoolMembers: () => request('getSchoolMembers'),
    grantSchoolPermission: payload => request('grantSchoolPermission', payload),
    updateSchoolProfile: payload => request('updateSchoolProfile', payload),
    // 转校：申请 / 目标学校审批 / 申请人撤回（原学校无需同意）
    applySchoolTransfer: payload => request('applySchoolTransfer', payload),
    reviewSchoolTransfer: payload => request('reviewSchoolTransfer', payload),
    cancelSchoolTransfer: payload => request('cancelSchoolTransfer', payload),
  });
}

/** 协会空间客户端：分组与成员名录，动作名与云端 school-request 注册的一致。 */function forAssociationSpace(input) {
  const request = requestFor(schoolScope(input));
  return Object.freeze({
    listAssociationGroups: payload => request('listAssociationGroups', payload),
    getAssociationGroup: payload => request('getAssociationGroup', payload),
    createAssociationGroup: payload => request('createAssociationGroup', payload),
    updateAssociationGroup: payload => request('updateAssociationGroup', payload),
    addAssociationGroupMembers: payload => request('addAssociationGroupMembers', payload),
    removeAssociationGroupMember: payload => request('removeAssociationGroupMember', payload),
    leaveAssociationGroup: payload => request('leaveAssociationGroup', payload),
    archiveAssociationGroup: payload => request('archiveAssociationGroup', payload),
    deleteAssociationGroup: payload => request('deleteAssociationGroup', payload),
    listAssociationMembers: payload => request('listAssociationMembers', payload),
    listAssociationNotices: payload => request('listAssociationNotices', payload),
    getAssociationNotice: payload => request('getAssociationNotice', payload),
    publishAssociationNotice: payload => request('publishAssociationNotice', payload),
    updateAssociationNotice: payload => request('updateAssociationNotice', payload),
    withdrawAssociationNotice: payload => request('withdrawAssociationNotice', payload),
    listTrainings: payload => request('listTrainings', payload),
    getTraining: payload => request('getTraining', payload),
    listTrainingRegistrations: payload => request('listTrainingRegistrations', payload),
    publishTraining: payload => request('publishTraining', payload),
    updateTraining: payload => request('updateTraining', payload),
    cancelTraining: payload => request('cancelTraining', payload),
    finishTraining: payload => request('finishTraining', payload),
    registerTraining: payload => request('registerTraining', payload),
    cancelTrainingRegistration: payload => request('cancelTrainingRegistration', payload),
    removeTrainingRegistration: payload => request('removeTrainingRegistration', payload),
    requestTrainingCheckIn: payload => request('requestTrainingCheckIn', payload),
    confirmTrainingCheckIn: payload => request('confirmTrainingCheckIn', payload),
    rejectTrainingCheckIn: payload => request('rejectTrainingCheckIn', payload),
    revokeTrainingCheckIn: payload => request('revokeTrainingCheckIn', payload),
    listSchoolEvents: payload => request('listSchoolEvents', payload),
    setSchoolEventPinned: payload => request('setSchoolEventPinned', payload),
    getSchoolEvent: payload => request('getSchoolEvent', payload),
    // 报名名单：之前漏在门外。`school-event-view.js` 的 loadEventParts（赛事详情页
    // 与名次录入页共用）会调它，云数据源下曾经直接 `api.listSchoolEventSignups is
    // not a function`。服务端一直注册着这个动作（school-event-service.js 有导出），
    // mock 门面也有——只有这一份清单漏写。
    listSchoolEventSignups: payload => request('listSchoolEventSignups', payload),
    publishSchoolEvent: payload => request('publishSchoolEvent', payload),
    signUpSchoolEvent: payload => request('signUpSchoolEvent', payload),
    cancelSchoolEventSignup: payload => request('cancelSchoolEventSignup', payload),
    startSchoolEvent: payload => request('startSchoolEvent', payload),
    drawSchoolEvent: payload => request('drawSchoolEvent', payload),
    checkInSchoolEvent: payload => request('checkInSchoolEvent', payload),
    finishSchoolEvent: payload => request('finishSchoolEvent', payload),
    listSchoolMatches: payload => request('listSchoolMatches', payload),
    getSchoolMatchEntryContext: payload => request('getSchoolMatchEntryContext', payload),
    getSchoolMatch: payload => request('getSchoolMatch', payload),
    submitSchoolMatch: payload => request('submitSchoolMatch', payload),
    confirmSchoolMatch: payload => request('confirmSchoolMatch', payload),
    rejectSchoolMatch: payload => request('rejectSchoolMatch', payload),
    revokeSchoolMatch: payload => request('revokeSchoolMatch', payload),
    forfeitSchoolMatch: payload => request('forfeitSchoolMatch', payload),
    assignSchoolMatchReferee: payload => request('assignSchoolMatchReferee', payload),
    startSchoolLiveScore: payload => request('startSchoolLiveScore', payload),
    recordSchoolRally: payload => request('recordSchoolRally', payload),
    undoSchoolRally: payload => request('undoSchoolRally', payload),
    finishSchoolLiveScore: payload => request('finishSchoolLiveScore', payload),
    getSchoolLiveScores: payload => request('getSchoolLiveScores', payload),
    listCollegeEvents: payload => request('listCollegeEvents', payload),
    getCollegeEvent: payload => request('getCollegeEvent', payload),
    publishCollegeEvent: payload => request('publishCollegeEvent', payload),
    setCollegeEventPinned: payload => request('setCollegeEventPinned', payload),
    listCollegeEntries: payload => request('listCollegeEntries', payload),
    submitCollegeEntry: payload => request('submitCollegeEntry', payload),
    reviewCollegeEntry: payload => request('reviewCollegeEntry', payload),
    listCollegeTies: payload => request('listCollegeTies', payload),
    drawCollegeEvent: payload => request('drawCollegeEvent', payload),
    startCollegeEvent: payload => request('startCollegeEvent', payload),
    listCollegeLineups: payload => request('listCollegeLineups', payload),
    submitCollegeLineup: payload => request('submitCollegeLineup', payload),
    startCollegeTie: payload => request('startCollegeTie', payload),
    assignCollegeTieReferee: payload => request('assignCollegeTieReferee', payload),
    finishCollegeEvent: payload => request('finishCollegeEvent', payload),
    forfeitCollegeTieLeg: payload => request('forfeitCollegeTieLeg', payload),
    listSchoolAnnouncements: payload => request('listSchoolAnnouncements', payload),
    publishSchoolAnnouncement: payload => request('publishSchoolAnnouncement', payload),
    archiveSchoolAnnouncement: payload => request('archiveSchoolAnnouncement', payload),
    listSchoolMembers: payload => request('listSchoolMembers', payload),
    getSchoolMember: payload => request('getSchoolMember', payload),
    getSchoolRanking: payload => request('getSchoolRanking', payload),
    getSchoolMemberStats: payload => request('getSchoolMemberStats', payload),
    getSchoolMemberHonors: payload => request('getSchoolMemberHonors', payload),
    getSchoolMemberProfile: payload => request('getSchoolMemberProfile', payload),
    getSchoolSeason: payload => request('getSchoolSeason', payload),
    resetSchoolSeason: payload => request('resetSchoolSeason', payload),
  });
}

/**
 * 跨校邀请赛客户端（协议 2）。
 * 动作名与服务端 school-exchange-handlers 注册的一致；范围仍取调用者的
 * 学校 + 协会，跨校能力由服务端按「赛事邀请了哪些学校」判定，不由客户端声明。
 */
function forExchange(input) {
  const request = requestFor(schoolScope(input));
  return Object.freeze({
    createExchangeEvent: payload => request('createExchangeEvent', payload),
    respondExchangeInvitation: payload => request('respondExchangeInvitation', payload),
    signUpExchangeEvent: payload => request('signUpExchangeEvent', payload),
    cancelExchangeSignup: payload => request('cancelExchangeSignup', payload),
    removeExchangeSignup: payload => request('removeExchangeSignup', payload),
    checkInExchangeSignup: payload => request('checkInExchangeSignup', payload),
    withdrawExchangeInvitation: payload => request('withdrawExchangeInvitation', payload),
    cancelExchangeEvent: payload => request('cancelExchangeEvent', payload),
    revokeExchangeScore: payload => request('revokeExchangeScore', payload),
    lockExchangeRoster: payload => request('lockExchangeRoster', payload),
    drawExchangeEvent: payload => request('drawExchangeEvent', payload),
    assignExchangeReferee: payload => request('assignExchangeReferee', payload),
    submitExchangeScore: payload => request('submitExchangeScore', payload),
    confirmExchangeRanking: payload => request('confirmExchangeRanking', payload),
    getExchangeEvents: payload => request('getExchangeEvents', payload),
    getExchangeEvent: payload => request('getExchangeEvent', payload),
  });
}

module.exports = { forSchoolIdentity, forAssociationSpace, forExchange };
