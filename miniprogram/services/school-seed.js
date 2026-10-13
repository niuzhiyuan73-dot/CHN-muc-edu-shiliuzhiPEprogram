/** 独立的双校试点目录，不自动写入云端，也不接管现有页面。 */
const { COLLEGES } = require('../utils/constants.js');
const { allAssociations } = require('../utils/associations.js');
const { schoolAssociationKey, collegeKey, schoolMemberKey, schoolRoleKey, ratingKey } = require('../utils/school.js');

function createSchoolSeed() {
  const schools = [
    { _id: 'muc', schoolId: 'muc', name: '中央民族大学', shortName: '民大', status: 'active', configVersion: 1 },
    { _id: 'buaa', schoolId: 'buaa', name: '北京航空航天大学', shortName: '北航', status: 'active', configVersion: 1, simulated: true },
  ];
  const schoolAssociations = schools.flatMap((school) => allAssociations().map((sport) => ({
    _id: schoolAssociationKey({ schoolId: school._id, association: sport.id }),
    schoolId: school._id, association: sport.id, name: `${school.name}${sport.sportName}协会`,
    status: 'active', simulated: school.simulated === true,
  })));
  // 北航学院仅为测试样本，不能作为真实学校组织目录直接上线。
  const colleges = schools.flatMap((school) =>
    (school._id === 'muc' ? COLLEGES : ['航空学院（模拟）', '计算机学院（模拟）', COLLEGES[0]])
      .map((name, index) => {
        const collegeId = `c${String(index + 1).padStart(2, '0')}`;
        return { _id: collegeKey(school._id, collegeId), schoolId: school._id, collegeId,
          name, status: 'active', simulated: school.simulated === true };
      })
  );
  return { schools, schoolAssociations, colleges };
}

function createSchoolDemoSeed() {
  const seed = createSchoolSeed();
  seed.users = ['muc', 'buaa'].flatMap((schoolId) => ['admin', 'member'].map((type) => ({
    _id: `demo_${schoolId}_${type}`, openId: `mock_openid_${schoolId}_${type}`,
    nickName: `${schoolId === 'muc' ? '民大' : '北航'}模拟${type === 'admin' ? '管理员' : '会员'}`,
    platformStatus: 'active', platformRole: 'member', primarySchoolId: schoolId, simulated: true,
  })));
  seed.schoolMembers = seed.users.map((user) => ({
    _id: schoolMemberKey(user._id, user.primarySchoolId), userId: user._id,
    schoolId: user.primarySchoolId, collegeId: 'c01',
    studentId: user._id.endsWith('admin') ? 'TEST001' : 'TEST002',
    status: 'active', simulated: true,
  }));
  seed.schoolRoles = seed.users.filter((user) => user._id.endsWith('admin')).map((user) => ({
    _id: schoolRoleKey(user._id, user.primarySchoolId), userId: user._id,
    schoolId: user.primarySchoolId, role: 'admin', status: 'active', simulated: true,
  }));
  seed.memberships = [];
  seed.memberRatings = seed.users.map((user) => ({
    _id: ratingKey(user._id, { schoolId: user.primarySchoolId, association: 'pkb' }),
    userId: user._id, schoolId: user.primarySchoolId, association: 'pkb',
    initialElo: null, currentElo: { singles: [], doubles: [] },
  }));
  return seed;
}

module.exports = { createSchoolSeed, createSchoolDemoSeed };
