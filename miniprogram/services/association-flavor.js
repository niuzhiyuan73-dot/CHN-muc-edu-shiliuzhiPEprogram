/**
 * 各协会模拟数据的「口味」
 * ============================================================
 * 多协会改造后，各协会的数据本就互不可见，但**长什么样**还是一样的：默认
 * 生成参数对所有协会一视同仁，于是切到乒乓、羽球，赛事标题、公告文案都与
 * 匹克球一字不差，演示时看不出「这是另一个协会」。
 *
 * 这个表按协会给出一小撮差异，让每个协会在本地模拟里各是各的一摊：
 *   · startDate        — 起始日期错开，赛事月份随之不同（不再都是九月）
 *   · eventTitlePrefix — 赛事标题的协会前缀，一眼能认出归属
 *   · announcements    — 本协会自己的公告（提到自己的项目）
 *   · college          — 学院赛演示场景的标题 / 场地，去掉「匹克球」味
 *
 * 【为什么默认协会 pkb 不在这张表里】
 * 默认协会沿用改造前那套生成参数，与既有测试、既有界面对齐（逐字节不变）。
 * 差异只加在其余协会头上——这样既拉开了区别，又不动默认协会的基线。
 *
 * 【为什么不放进 utils/associations.js】
 * 那是「协会是什么」的注册表，要镜像进云函数（见 sync-cloud-lib 清单）；
 * 这里只是**模拟数据**的口味，云端没有对应概念，故单列且不进镜像。
 * ============================================================
 */

/**
 * 公告种子。结构与 seed.js 的 ANNOUNCEMENT_SEED 一致：
 * week 是相对赛季起始的第几周，publishTime 由它推导。
 */
const TT_ANNOUNCEMENTS = [
  {
    week: 0,
    category: '通知',
    pinned: true,
    title: '2026 春季乒乓球训练安排',
    content:
      '每周一、周四 19:00 在乒乓球馆常规训练，协会提供球拍与球。新会员请先在小程序内完成报名。',
  },
  {
    week: 3,
    category: '赛事',
    pinned: false,
    title: '乒乓球单打积分赛报名开始',
    content: '本周六举行本赛季首场乒乓球单打积分赛，11 分制三局两胜，取前八名计分，名额有限。',
  },
  {
    week: 7,
    category: '战报',
    pinned: false,
    title: '乒乓球单打积分赛战报',
    content: '首场乒乓球单打积分赛结束，完整名次与等级分变动已录入排行榜，可在个人主页查看。',
  },
  {
    week: 12,
    category: '通知',
    pinned: false,
    title: '乒乓球馆场地调整通知',
    content: '因场馆检修，本周训练改到大学生活动中心二层，时间不变，请相互转告。',
  },
];

const BD_ANNOUNCEMENTS = [
  {
    week: 0,
    category: '通知',
    pinned: true,
    title: '羽毛球协会新赛季招新',
    content: '新赛季招新进行中，每周二、周六 18:30 在体育馆训练，欢迎报名试训，协会提供训练用球。',
  },
  {
    week: 4,
    category: '赛事',
    pinned: false,
    title: '羽毛球双打联赛报名开始',
    content: '本赛季羽毛球双打联赛开始报名，21 分制三局两胜，自由组队，名额有限先到先得。',
  },
  {
    week: 9,
    category: '战报',
    pinned: false,
    title: '羽毛球双打联赛战报',
    content: '羽毛球双打联赛结束，名次与赛季积分已录入，可在排行榜与个人主页查看。',
  },
  {
    week: 14,
    category: '通知',
    pinned: false,
    title: '羽毛球协会器材借用说明',
    content: '协会新增一批训练用球与球拍，可凭会员身份在活动中心登记借用，用后请及时归还。',
  },
];

/**
 * 协会 → 口味。键是协会 id，值是 generateSeed 的参数子集，
 * 外加 college（学院赛演示场景参数，由 college-demo 读取）。
 */
const FLAVORS = {
  tt: {
    startDate: '2026-03-02',
    eventTitlePrefix: '乒乓球·',
    announcements: TT_ANNOUNCEMENTS,
    college: {
      title: '2026 院际乒乓球团体赛',
      location: '乒乓球馆',
    },
  },
  bd: {
    // 五月起：常规赛事落在 5~8 月，正在进行的那场落在十月。
    // 起始日期不能太靠后——「进行中」的赛事按起始日 + 22 周推出来，若推到了
    // 未来，界面上会出现一场「进行中却还没开赛」的赛，看着就不对。
    startDate: '2026-05-04',
    eventTitlePrefix: '羽毛球·',
    announcements: BD_ANNOUNCEMENTS,
    college: {
      title: '2026 院际羽毛球团体赛',
      location: '羽毛球馆',
    },
  },
};

/**
 * 取某协会的口味。默认协会（及未登记口味的协会）返回 null，表示「照旧」。
 *
 * @param {string} association 协会 id
 * @returns {Object|null}
 */
function flavorOf(association) {
  return FLAVORS[association] || null;
}

module.exports = { FLAVORS, flavorOf };
