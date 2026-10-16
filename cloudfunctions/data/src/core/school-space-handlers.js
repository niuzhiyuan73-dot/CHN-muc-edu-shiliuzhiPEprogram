/**
 * 协会空间处理器注册表（协议 2）。
 * 与学校身份处理器并列，由 school-request.js 合并分发。业务实现来自共享库镜像，
 * 与 miniprogram 端同一份（见 tools/sync-cloud-lib.js）。
 *
 * 【注册面为什么是显式清单，而不是「全量推导」】
 * 从前这里写的是「把 11 个 service 的所有导出函数都注册」，
 * 于是 27 个内部辅助函数（buildDirectory / isEventDoc / medalOf …）也成了
 * 协议 2 的 action——客户端从不声明它们，`school-request.js` 却会照单执行。
 * 现在改成按 SCHOOL_SPACE_ACTIONS 白名单挑选：注册面**恰好等于客户端会发的
 * 动作集**，多了报错、少了报错，由 tests/school-action-surface.test.js 守护。
 * 清单与本地模拟端（school-mock.js）读的是同一份镜像文件，不会分叉。
 */
const { SCHOOL_SPACE_ACTIONS, pickActions } = require('../../lib/utils/school-actions.js');
const groupService = require('../../lib/services/association-group-service.js');
const memberService = require('../../lib/services/association-member-service.js');
const noticeService = require('../../lib/services/association-notice-service.js');
const trainingService = require('../../lib/services/association-training-service.js');
const eventService = require('../../lib/services/school-event-service.js');
const matchService = require('../../lib/services/school-match-service.js');
const liveService = require('../../lib/services/school-live-service.js');
const collegeService = require('../../lib/services/school-college-service.js');
const announcementService = require('../../lib/services/school-announcement-service.js');
const schoolMemberService = require('../../lib/services/school-member-service.js');
const rankService = require('../../lib/services/school-rank-service.js');

module.exports = Object.freeze(pickActions([
  groupService, memberService, noticeService, trainingService, eventService, matchService,
  liveService, collegeService, announcementService, schoolMemberService, rankService,
], SCHOOL_SPACE_ACTIONS));
