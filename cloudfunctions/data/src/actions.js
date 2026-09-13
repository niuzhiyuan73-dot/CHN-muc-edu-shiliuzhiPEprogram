/**
 * 云函数操作名单
 * ============================================================
 * 与前端 services/cloud.js 里的调用名必须一字不差。那份文件把全部
 * 接口钉死成 { action, payload }，这里的名单就是服务端的对应表。
 *
 * tests/cloud-core.test.js 会把它与 cloud.js 导出的函数名逐一比对：
 * 前端加了一个接口却忘了在云端实现，测试立刻红——而不是等上线后
 * 用户点出一个「未知的操作」。
 * ============================================================
 */

/** 只读接口（27 个） */
const READ_ACTIONS = [
  'getCurrentUser',
  'getMembers',
  'getMember',
  'getMemberApplications',
  'getMatches',
  'getEvents',
  'getAnnouncements',
  'getAnnouncementRecords',
  'getLeaderboard',
  'getProgressLeaderboard',
  'getPercentile',
  'getMatchHistory',
  'getHeadToHead',
  'getPartnerRecord',
  'getEventRecord',
  'getRatingHistory',
  'getForm',
  'getMyProjects',
  'getHomeSummary',
  'getMatchRecords',
  'getSeasonState',
  'getEventSignups',
  'getCollegeEvents',
  'getCollegeEvent',
  'getCollegeEntries',
  'getCollegeTies',
  'getCollegeLineups',
];

/** 写接口（29 个）。这些要走事务，权限一律在服务端判定。 */
const WRITE_ACTIONS = [
  'submitMatch',
  'confirmMatch',
  'rejectMatch',
  'revokeMatch',
  'forfeitMatch',
  'registerMember',
  'approveMember',
  'rejectMember',
  'setCollegeLeader',
  'publishAnnouncement',
  'archiveAnnouncement',
  'updateProfile',
  'resetSeason',
  'publishEvent',
  'startEvent',
  'setEventPinned',
  'drawEvent',
  'signUpEvent',
  'cancelSignupEvent',
  'checkInEvent',
  'finishEvent',
  'publishCollegeEvent',
  'submitCollegeEntry',
  'reviewCollegeEntry',
  'drawCollegeEvent',
  'startCollegeEvent',
  'setCollegeEventPinned',
  'submitLineup',
  'startTie',
  'recordForfeit',
  'finishCollegeEvent',
];

/** 全部 56 个操作 */
const ALL_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS];

module.exports = { READ_ACTIONS, WRITE_ACTIONS, ALL_ACTIONS };
