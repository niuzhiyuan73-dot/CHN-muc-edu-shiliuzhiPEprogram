/**
 * 协会空间处理器注册表（协议 2）。
 * 与学校身份处理器并列，由 school-request.js 合并分发。业务实现来自共享库镜像，
 * 与 miniprogram 端同一份（见 tools/sync-cloud-lib.js）。
 */
const groupService = require('../../lib/services/association-group-service.js');
const memberService = require('../../lib/services/association-member-service.js');

module.exports = Object.fromEntries(
  Object.entries({ ...groupService, ...memberService }).filter(([, value]) => typeof value === 'function'));
