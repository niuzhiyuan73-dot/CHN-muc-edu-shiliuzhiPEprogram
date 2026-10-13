/**
 * 学校维度的首页演示内容（仅用于本地模拟数据源）
 * ============================================================
 * 首页的公告 / 近期赛事 / 概况本来是**跨协会聚合**的——那套数据属于民大
 * （多协会改造前唯一的那所学校）。多校之后若切到别的学校还是这套，会让人
 * 以为「切了没反应」。这里为**模拟学校**（北航）造一份演示内容：切到北航
 * 即展示北航自己的公告与赛事，并整体处于只读浏览（不提供任何写入口）。
 *
 * 【为什么真学校不在这里造数据】
 * 民大展示的就是应用本身的数据（聚合视图），不是演示。schoolHome() 对它返回
 * null，调用方回落到聚合视图——「本校看真实数据、外校看演示」这条口径才清楚。
 *
 * 【为什么是纯静态】
 * 北航是测试样本（seed 里标了 simulated），没有真实数据源。几条示例内容写在
 * 这里，免得为了假公告去动数据集合与协议。它不碰 wx、不碰 I/O，是纯计算模块。
 * ============================================================
 */

const DEMO_HOME = {
  buaa: {
    shortName: '北航',
    glyph: '航',
    announcements: [
      { id: 'buaa_a1', title: '北航匹克球协会 2026 秋季招新', category: '招新', pinned: true, dateText: '2026-10-20',
        content: '面向全体在校生招募新会员，11 月 1 日前到体育部登记即可，欢迎零基础加入。' },
      { id: 'buaa_a2', title: '体育馆匹克球场开放时间调整', category: '通知', pinned: false, dateText: '2026-10-15',
        content: '即日起工作日 18:00–22:00 开放，周末全天开放；高峰时段请在群里预约。' },
      { id: 'buaa_a3', title: '北航校队选拔赛开始报名', category: '赛事', pinned: false, dateText: '2026-10-08',
        content: '校级代表队选拔，面向各院系好手，报名截止 10 月 30 日。' },
    ],
    events: [
      { id: 'buaa_e1', title: '北航新生杯匹克球赛', statusLabel: '报名中', isOngoing: false,
        timeText: '2026-11-05 09:00', location: '学院路校区体育馆', quotaText: '限 32 人' },
      { id: 'buaa_e2', title: '北航院系友谊联赛', statusLabel: '进行中', isOngoing: true,
        timeText: '2026-10-28 14:00', location: '沙河校区球场', quotaText: '已满 16 人' },
    ],
    summary: { memberCount: 46, matchCount: 128, eventCount: 5, seasonText: '2026-09-01 — 2026-12-31' },
  },
};

/**
 * 取某校的首页演示视图。没有演示内容的学校返回 null，由调用方回落到聚合视图。
 *
 * @param {string} schoolId
 * @returns {{loggedIn: boolean, announcements: Object, upcomingEvents: Array, summary: Object}|null}
 */
function schoolHome(schoolId) {
  const feed = DEMO_HOME[schoolId];
  if (!feed) return null;
  // 每条都贴上所属学校，首页卡片上的角标便能显示成「航 北航」而不是空
  const chip = { association: schoolId, associationName: feed.shortName, associationGlyph: feed.glyph };
  return {
    // loggedIn 只是占位，由调用方按当前登录态覆盖
    loggedIn: true,
    announcements: {
      rows: feed.announcements.map((row) => ({ ...row, ...chip })),
      total: feed.announcements.length,
      hasMore: false,
    },
    upcomingEvents: feed.events.map((row) => ({ ...row, ...chip, signedUp: false })),
    summary: { ...feed.summary },
  };
}

module.exports = { schoolHome };
