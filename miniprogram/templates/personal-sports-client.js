const identity = require('../services/school-identity');
const association = require('../services/association-scope');
const { isKnownAssociation } = require('../utils/associations');
function loadPersonalSports(schoolId, payload) {
  return identity.forSchoolIdentity({ schoolId, association: association.getAssociation() }).getMySportsDashboard(payload);
}
function openSportsTarget(target) {
  if (!target || typeof target.kind !== 'string') return false;
  if (target.association && target.association !== 'meet') {
    if (!isKnownAssociation(target.association)) return false;
    association.setAssociation(target.association);
  }
  const id = encodeURIComponent(target.id || '');
  const routes = {
    personal_event: `/packageEvent/event-detail/event-detail?eventId=${id}`,
    college_event: `/packageCollege/college-event-detail/college-event-detail?eventId=${id}`,
    college_entry: `/packageCollege/college-entry/college-entry?eventId=${id}&collegeId=${encodeURIComponent(target.collegeId || '')}`,
    team_event: `/packageTeam/team-event-detail/team-event-detail?eventId=${id}`,
    football_match: `/packageTeam/football-match/football-match?matchId=${id}`,
    personal_match: `/packageMember/my-sports/my-sports?tab=schedule&matchId=${id}&association=${encodeURIComponent(target.association || '')}`,
    confirm_score: `/packageMember/my-sports/my-sports?tab=tasks&matchId=${id}&association=${encodeURIComponent(target.association || '')}`,
    meet_detail: `/packageMeet/meet-detail/meet-detail?meetId=${encodeURIComponent(target.meetId || '')}`,
    meet_score: `/packageMeet/meet-score/meet-score?meetId=${encodeURIComponent(target.meetId || '')}&sessionKey=${encodeURIComponent(target.sessionKey || '')}`,
    school_identity: '/packageMember/school-identity/school-identity',
  };
  if (!Object.prototype.hasOwnProperty.call(routes, target.kind)) return false;
  wx.navigateTo({ url: routes[target.kind] });
  return true;
}
module.exports = { loadPersonalSports, openSportsTarget };
