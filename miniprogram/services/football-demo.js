/** 足球 F1 演示数据工厂，由 school-seed 按集合追加合并。
 * 只生成球队及报名阶段赛事，不虚构 F2 尚未交付的比赛成绩和个人技术统计。
 */
const { MEMBER_SEED } = require('./seed.js');
const { schoolKey, teamMemberKey } = require('../utils/school.js');
const { normalizeFootballRules, DEFAULT_PRESET_KEY } = require('../utils/football-rules.js');
const { TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_ENTRY_STATUS, TEAM_EVENT_STATUS } = require('../utils/constants.js');
const SCOPE = Object.freeze({ schoolId: 'muc', association: 'fb' });
const ISO = '2026-10-20T01:00:00.000Z';
const idOf = index => `u${String(index + 1).padStart(2, '0')}`;
const nameOf = userId => {
  const member = MEMBER_SEED[Number(userId.slice(1)) - 1];
  return member ? member.realName || member.nickName || userId : userId;
};

function createFootballDemoContent() {
  const specs = [
    { slug: 'pomegranate', name: '石榴红足球队', ids: Array.from({ length: 12 }, (_, index) => idOf(index)) },
    { slug: 'campus', name: '绿茵同行队', ids: Array.from({ length: 12 }, (_, index) => idOf(index + 12)) },
  ];
  const teams = [];
  const teamMembers = [];
  specs.forEach(spec => {
    const teamId = schoolKey('tm', SCOPE.schoolId, SCOPE.association, spec.slug);
    spec.teamId = teamId;
    teams.push({ _id: teamId, ...SCOPE, sport: 'football', name: spec.name, college: '',
      captainId: spec.ids[0], status: TEAM_STATUS.ACTIVE, revision: 1, createdAt: ISO, updatedAt: ISO, simulated: true });
    spec.ids.forEach((userId, index) => {
      const key = teamMemberKey(teamId, userId);
      teamMembers.push({ _id: key, ...SCOPE, teamId, userId, role: index === 0 ? 'captain' : 'member',
        status: TEAM_MEMBER_STATUS.ACTIVE, joinedAt: ISO, updatedAt: ISO, simulated: true });
    });
  });
  const pendingId = schoolKey('tm', SCOPE.schoolId, SCOPE.association, 'recruiting');
  teams.push({ _id: pendingId, ...SCOPE, sport: 'football', name: '校园新星队（待审核）', college: '',
    captainId: 'u06', status: TEAM_STATUS.PENDING, revision: 1, createdAt: ISO, updatedAt: ISO, simulated: true });
  const pendingMember = teamMemberKey(pendingId, 'u06');
  teamMembers.push({ _id: pendingMember, ...SCOPE, teamId: pendingId, userId: 'u06', role: 'captain',
    status: TEAM_MEMBER_STATUS.ACTIVE, joinedAt: ISO, updatedAt: ISO, simulated: true });
  const rules = normalizeFootballRules({ presetKey: DEFAULT_PRESET_KEY });
  const eventId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'campus-cup');
  const teamEvents = [{ _id: eventId, ...SCOPE, name: '自由组队足球杯（报名中）', sportFormat: 'football11',
    rules, format: 'single_elim', statPolicy: 'basic', bronzeMode: 'playoff', status: TEAM_EVENT_STATUS.REGISTRATION,
    entryMin: rules.eventRosterMin, entryMax: rules.eventRosterMax, lockedCount: 0,
    startTime: '2026-11-01T01:00:00.000Z', location: '校足球场', revision: 1,
    createdBy: 'demo_muc_admin', createdAt: ISO, updatedAt: ISO, simulated: true }];
  const teamEventEntries = specs.map((spec, index) => ({
    _id: schoolKey('ten', eventId, spec.teamId), ...SCOPE, eventId, teamId: spec.teamId,
    status: index === 0 ? TEAM_ENTRY_STATUS.APPROVED : TEAM_ENTRY_STATUS.SUBMITTED,
    roster: spec.ids.map((userId, playerIndex) => ({ userId, name: nameOf(userId), no: playerIndex + 1 })),
    submittedBy: spec.ids[0], submittedAt: ISO,
    reviewedBy: index === 0 ? 'demo_muc_admin' : null, reviewedAt: index === 0 ? ISO : null,
    lockedAt: null, placement: null, updatedAt: ISO, simulated: true,
  }));
  // 有效学校成员在启用的协会中默认就是普通会员，不需要额外写角色行。
  // 管理者使用已有 demo_muc_admin 学校角色；不让 u01 等普通演示账号额外升权。
  return { teams, teamMembers, teamEvents, teamEventEntries, teamMatches: [], teamMatchStats: [], memberships: [] };
}

module.exports = { createFootballDemoContent };
