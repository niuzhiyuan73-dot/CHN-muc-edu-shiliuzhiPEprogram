/**
 * 运动会处理器注册表（协议 2 · 学校级，不带协会）。
 *
 * 与身份 / 协会空间 / 跨校三面并列，由 school-request.js 的 **meet 分支**分发：
 * 运动会请求只带 schoolId（+ 可选 meetId），没有 association，所以不能走
 * handleSchoolRequest 里那段「必须指定学校和项目」的校验。
 *
 * 注册面同样是显式白名单（SCHOOL_MEET_ACTIONS），由
 * tests/school-action-surface.test.js 与客户端门面双向守护。
 */
const { SCHOOL_MEET_ACTIONS, pickActions } = require('../../lib/utils/school-actions.js');
const meetService = require('../../lib/services/meet-service.js');
const leadService = require('../../lib/services/meet-college-lead-service.js');

module.exports = Object.freeze(pickActions([meetService, leadService], SCHOOL_MEET_ACTIONS));
