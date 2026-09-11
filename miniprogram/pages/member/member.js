/**
 * 会员主页（看别人）
 * ============================================================
 * 与「我的」页共用同一套界面和行为，唯一区别是从地址栏取 userId。
 *
 * 【为什么单独做一个页面而不是给「我的」页传参】
 * 「我的」挂在 tabBar 上，而 tabBar 页面只能用 wx.switchTab 打开，
 * switchTab 不支持携带查询参数。想从排行榜点进某个人的主页，
 * 就必须有一个普通页面来承载。于是有了这个页面。
 * ============================================================
 */

const { createMemberPage } = require('../../templates/member-view.js');

Page(
  createMemberPage({
    // 取不到 userId 时返回 undefined，行为退化成「看自己」，
    // 总比白屏好——正常路径下这个参数一定存在
    resolveUserId: (query) => (query && query.userId) || undefined,
    // 顺着交锋记录一路点进来会有好几层，标题里写上名字才知道在看谁
    titleFromMember: true,
  })
);
