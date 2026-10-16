/** S2 身份接口客户端，明确范围，不改变旧业务门面的行为。 */
const { schoolScope } = require('../utils/school.js');

/** 绑定范围 + 协议 2 的请求器；身份与协会空间共用一份，避免两处各写一遍。 */
function requestFor(scope) {
  return async (action, payload = {}) => {
    if (typeof wx === 'undefined' || !wx.cloud) throw new Error('云开发尚未初始化');
    const { result } = await wx.cloud.callFunction({ name: 'data', data: {
      protocolVersion: 2, ...scope, action, payload,
    } });
    if (!result || !result.ok) throw new Error(result && result.message || '学校接口请求失败');
    return result.data;
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
  });
}

/** 协会空间客户端：分组与成员名录，动作名与云端 school-request 注册的一致。 */
function forAssociationSpace(input) {
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

module.exports = { forSchoolIdentity, forAssociationSpace };
