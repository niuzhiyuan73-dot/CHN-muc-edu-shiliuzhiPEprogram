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
    applySchoolMembership: payload => request('applySchoolMembership', payload),
    reviewSchoolMembership: payload => request('reviewSchoolMembership', payload),
    getMySchoolMembership: () => request('getMySchoolMembership'),
    getSchoolApplications: () => request('getSchoolApplications'),
    getSchoolDirectory: () => request('getSchoolDirectory'),
    getSchoolIdentitySession: () => request('getSchoolIdentitySession'),
    getSchoolMembers: () => request('getSchoolMembers'),
    grantSchoolPermission: payload => request('grantSchoolPermission', payload),
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
    listAssociationMembers: payload => request('listAssociationMembers', payload),
  });
}

module.exports = { forSchoolIdentity, forAssociationSpace };
