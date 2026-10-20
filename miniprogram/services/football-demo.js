/** 足球演示：保留报名流程，另给一届明确标注的已完赛示例用于查看成绩。 */
const { MEMBER_SEED } = require('./seed.js');
const { schoolKey, teamMemberKey } = require('../utils/school.js');
const { normalizeFootballRules, DEFAULT_PRESET_KEY } = require('../utils/football-rules.js');
const { TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_ENTRY_STATUS, TEAM_EVENT_STATUS } = require('../utils/constants.js');
const { normalizeFootballReport, FIELDS } = require('../utils/football-report');
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
  const completedId = schoolKey('tev', SCOPE.schoolId, SCOPE.association, 'completed-demo');
  const completedEntries = specs.map(spec => ({ ...teamEventEntries.find(e => e.teamId === spec.teamId),
    _id: schoolKey('ten', completedId, spec.teamId), eventId: completedId, status: 'locked',
    lockedAt: ISO, placement: spec === specs[0] ? 1 : 2 }));
  teamEventEntries.push(...completedEntries);
  const reportSides = {};
  for (const [i, key] of ['A', 'B'].entries()) {
    reportSides[key] = { players: completedEntries[i].roster.map((p, index) => ({
      userId: p.userId, starter: index < 11, appeared: index < 11, goalkeeper: index === 0,
      ...Object.fromEntries(Object.keys(FIELDS).map(field => [field, field === 'fouls' ? null : 0])),
      goals: index === 0 ? 1 : 0, ownGoals: key === 'B' && index === 1 ? 1 : 0,
      assists: key === 'A' && index === 1 ? 1 : 0,
      yellowCards: key === 'A' && index === 11 ? 1 : 0,
    })), coverage: Object.fromEntries(Object.keys(FIELDS).map(field => [field, field === 'fouls' ? 'none' : 'full'])),
    substitutions: { status: 'full', regulationCount: 0, regulationOpportunities: 0, halfTimeCount: 0,
      extraTimeCount: 0, extraTimeOpportunities: 0, extraBreakCount: 0, incomingIds: [] } };
  }
  const normalized = normalizeFootballReport({ result: { regulationScore: { A: 2, B: 1 } }, sides: reportSides,
    goalEvents: [{ side: 'A', type: 'normal', scorerId: specs[0].ids[0], assistId: specs[0].ids[1] },
      { side: 'B', type: 'normal', scorerId: specs[1].ids[0] }, { side: 'B', type: 'own_goal', scorerId: specs[1].ids[1] }] },
  { rules, format: 'round_robin', rosters: { A: completedEntries[0].roster, B: completedEntries[1].roster } });
  if (!normalized.ok) throw new Error(normalized.message);
  const placements = specs.map((spec, i) => ({ teamId: spec.teamId, teamName: spec.name, rank: i + 1, note: i ? '亚军' : '冠军' }));
  teamEvents.push({ ...teamEvents[0], _id: completedId, name: '足球循环赛（已完赛演示）', format: 'round_robin',
    status: 'finished', lockedCount: 2, draw: { size: 2, roundCount: 1, slots: specs.map(s => s.teamId) },
    placements, finishedAt: ISO, revision: 5 });
  const matchId = `x_${completedId}_r1_group_0`;
  const teamMatches = [{ _id: matchId, ...SCOPE, eventId: completedId, sportFormat: 'football11', rules,
    teamA: specs[0].teamId, teamB: specs[1].teamId, round: 1, stage: 'group', slot: 0,
    status: 'published', scoreA: 2, scoreB: 1, winner: 'A', forfeit: null, overtime: false,
    footballPublished: normalized.value, footballPublishedRevision: 3, footballDraft: null,
    revision: 3, recordedBy: 'demo_muc_admin', publishedBy: 'demo_muc_admin', publishedAt: ISO,
    matchTime: '2026-10-19T06:00:00.000Z', durationMinutes: 110, location: '校足球场（演示）',
    createdAt: ISO, updatedAt: ISO, simulated: true }];
  // 有效学校成员在启用的协会中默认就是普通会员，不需要额外写角色行。
  // 管理者使用已有 demo_muc_admin 学校角色；不让 u01 等普通演示账号额外升权。
  return { teams, teamMembers, teamEvents, teamEventEntries, teamMatches, teamMatchStats: [], memberships: [] };
}

module.exports = { createFootballDemoContent };
