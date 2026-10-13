/** S2 身份接口客户端，明确范围，不改变旧业务门面的行为。 */
const { schoolScope } = require('../utils/school.js');
function forSchoolIdentity(input) {
  const scope = schoolScope(input);
  const request = async (action, payload = {}) => {
    if (typeof wx === 'undefined' || !wx.cloud) throw new Error('云开发尚未初始化');
    const { result } = await wx.cloud.callFunction({ name: 'data', data: {
      protocolVersion: 2, ...scope, action, payload,
    } });
    if (!result || !result.ok) throw new Error(result && result.message || '学校接口请求失败');
    return result.data;
  };
  return Object.freeze({
    applySchoolMembership: payload => request('applySchoolMembership', payload),
    reviewSchoolMembership: payload => request('reviewSchoolMembership', payload),
    getMySchoolMembership: () => request('getMySchoolMembership'),
    getSchoolApplications: () => request('getSchoolApplications'),
    getSchoolDirectory: () => request('getSchoolDirectory'),
    getSchoolIdentitySession: () => request('getSchoolIdentitySession'),
  });
}
module.exports = { forSchoolIdentity };
