/**
 * 全局常量定义
 * ============================================================
 * 全项目共用一套枚举值，避免在代码里散落魔法数字。
 *
 * 【为什么用数字而不是字符串存数据库】
 * 数字占用空间小，且比较效率高。但直接在代码里写 `status === 1`
 * 很难维护，所以统一在这里定义具名常量。
 *
 * 【重要】这些数值一旦上线就不可随意改动，否则历史数据会错乱。
 * 新增状态请追加编号，不要复用已删除的编号。
 * ============================================================
 */

/** 用户角色 */
const ROLE = {
  MEMBER: 0, // 普通会员
  STAFF: 1, // 干事
  ADMIN: 2, // 管理员
};

const ROLE_LABEL = {
  [ROLE.MEMBER]: '会员',
  [ROLE.STAFF]: '干事',
  [ROLE.ADMIN]: '管理员',
};

/** 用户账号状态 */
const USER_STATUS = {
  PENDING: 0, // 待审核：刚注册，尚未通过实名审核
  ACTIVE: 1, // 正常：可正常使用全部功能
  DISABLED: 2, // 已禁用：违规被封禁
};

const USER_STATUS_LABEL = {
  [USER_STATUS.PENDING]: '待审核',
  [USER_STATUS.ACTIVE]: '正常',
  [USER_STATUS.DISABLED]: '已禁用',
};

/**
 * 比赛项目类型
 * 【重要】编号 2 曾用于「女子单打」，现已废弃，不要复用。
 *   男女单打合并计算后，两者共用一个单打池；性别差异体现在
 *   排行榜的展示维度（见 RANK_PROJECT）而不是比赛类型上。
 */
const MATCH_TYPE = {
  SINGLES: 1, // 单打（不分男女，男女可以互相对打）
  DOUBLES: 3, // 双打
};

const MATCH_TYPE_LABEL = {
  [MATCH_TYPE.SINGLES]: '单打',
  [MATCH_TYPE.DOUBLES]: '双打',
};

/**
 * 等级分池
 * ============================================================
 * 【核心设计】每位会员在不同池中持有完全独立的等级分。
 *   单打的分数不影响双打。一个从没打过双打的人，他的双打分数
 *   始终是初始分，不会因为单打打得好而虚高。
 *
 * 【为什么男女单打合并成一个池】
 * 男女选手之间会互相打单打比赛，如果分成两个池，一场男女对打
 * 就没法同时更新两个人的分数；而且两个池互不相通，女生打得再好
 * 也无法和男生比较。合并成一个池后，所有单打都在同一把尺子上
 * 比较，男女水平的真实差距也能被分数反映出来。
 *
 * 【排行榜为什么仍然分开】
 * 分数池是「计算口径」，排行榜是「展示口径」，两者不必一致。
 *   排行榜按 RANK_PROJECT 拆分出男单榜和女单榜，只是展示时按性别
 *   过滤，取的仍然是同一个单打池里的分数——所以一个女生在女单榜
 *   排第一，她的分数和男单榜第一名是直接可比的。
 *
 * 【为什么双打不区分男女】
 * 双打比赛不按性别分组，男双、女双、混双在同一个池里竞争，
 * 因此只设一个双打池。若将来要拆分，在此处新增池并补充映射即可，
 * 业务代码无需改动——这正是把池定义抽成配置的目的。
 * ============================================================
 */
const RATING_POOL = {
  SINGLES: 'singles', // 单打池（男女合并计算）
  DOUBLES: 'doubles', // 双打池（不分男女）
};

const RATING_POOL_LABEL = {
  [RATING_POOL.SINGLES]: '单打',
  [RATING_POOL.DOUBLES]: '双打',
};

/** 全部等级分池。遍历池时一律用它，避免漏掉某个池。 */
const ALL_RATING_POOLS = Object.values(RATING_POOL);

/**
 * 比赛类型 → 等级分池。
 * 这是「一场比赛该更新哪个池」的唯一判定依据。
 */
const MATCH_TYPE_TO_POOL = {
  [MATCH_TYPE.SINGLES]: RATING_POOL.SINGLES,
  [MATCH_TYPE.DOUBLES]: RATING_POOL.DOUBLES,
};

/**
 * 排行榜项目（展示口径）
 * ============================================================
 * 排行榜按「项目」拆分展示，一个项目 = 一个分数池 + 一个性别过滤条件。
 *   men_singles  → 单打池里的男生
 *   women_singles→ 单打池里的女生
 *   doubles      → 双打池里的所有人
 *
 * gender 为 null 表示不做性别过滤。项目与池是「多对一」的关系：
 * 男单榜和女单榜共用同一个单打池，因此两张榜上的分数可以互相比较。
 * ============================================================
 */
const RANK_PROJECT = {
  MEN_SINGLES: 'men_singles',
  WOMEN_SINGLES: 'women_singles',
  DOUBLES: 'doubles',
};

const RANK_PROJECT_LABEL = {
  [RANK_PROJECT.MEN_SINGLES]: '男单',
  [RANK_PROJECT.WOMEN_SINGLES]: '女单',
  [RANK_PROJECT.DOUBLES]: '双打',
};

/** 全部排行榜项目。遍历项目时一律用它，避免漏掉某个项目。 */
const ALL_RANK_PROJECTS = Object.values(RANK_PROJECT);

/**
 * 排行榜项目配置：项目 → 取哪个池的分数 + 只保留哪个性别。
 * 这是「一个项目该展示哪些人、用哪套分数」的唯一判定依据。
 */
const RANK_PROJECT_CONFIG = {
  [RANK_PROJECT.MEN_SINGLES]: { pool: RATING_POOL.SINGLES, gender: 'M' },
  [RANK_PROJECT.WOMEN_SINGLES]: { pool: RATING_POOL.SINGLES, gender: 'F' },
  [RANK_PROJECT.DOUBLES]: { pool: RATING_POOL.DOUBLES, gender: null },
};

/** 比赛记录状态 */
const MATCH_STATUS = {
  PENDING: 0, // 待确认：已录入，等待对手确认或管理员审核
  ACTIVE: 1, // 已生效：成绩已确认，已计入排名
  REVOKED: 2, // 已撤销：成绩作废，分数已回滚
};

const MATCH_STATUS_LABEL = {
  [MATCH_STATUS.PENDING]: '待确认',
  [MATCH_STATUS.ACTIVE]: '已生效',
  [MATCH_STATUS.REVOKED]: '已撤销',
};

/** 参赛队伍标识 */
const TEAM = {
  A: 'A',
  B: 'B',
};

/** 排行榜维度 */
const RANK_PERIOD = {
  ALL: 'all', // 总榜
  WEEK: 'week', // 周榜
  MONTH: 'month', // 月榜
  SEASON: 'season', // 赛季榜
};

const RANK_PERIOD_LABEL = {
  [RANK_PERIOD.ALL]: '总榜',
  [RANK_PERIOD.WEEK]: '周榜',
  [RANK_PERIOD.MONTH]: '月榜',
  [RANK_PERIOD.SEASON]: '赛季榜',
};

/** 排行榜排序依据 */
const RANK_SORT_BY = {
  ELO: 'elo', // 按等级分
  POINTS: 'points', // 按积分
};

/** 数据库集合名。集中定义便于后续改名或迁移。 */
const COLLECTION = {
  USERS: 'users',
  MATCHES: 'matches',
  RANKINGS: 'rankings',
  EVENTS: 'events',
  EVENT_SIGNUPS: 'event_signups',
  ANNOUNCEMENTS: 'announcements',
  AUDIT_LOGS: 'audit_logs',
  SEASONS: 'seasons',
};

/** 本地缓存键名 */
const STORAGE_KEY = {
  USER_INFO: 'userInfo', // 登录后的用户信息
  SETTINGS: 'settings', // 本地设置项
};

/**
 * 数据源模式。
 * mock：使用本地模拟数据，无需云开发环境即可完整预览（开发初期使用）
 * cloud：调用真实云函数与云数据库（拿到 AppID 并开通云开发后切换）
 */
const DATA_SOURCE = {
  MOCK: 'mock',
  CLOUD: 'cloud',
};

/**
 * 公告分类。
 * 收敛成固定几项，而不是让发布者随手写：自由文本很快就会出现
 * 「通知」「通知 」「比赛通知」并存，筛选和统计都没法做。
 */
const ANNOUNCEMENT_CATEGORIES = ['通知', '赛事', '战报'];

/**
 * 公告状态。
 * 「下架」不等于「删除」：记录仍留在管理列表里，只是不再对外展示。
 * 与比赛「撤销」保留记录是同一思路——话已经发出去了，收不回来，至少要留痕。
 */
const ANNOUNCEMENT_STATUS = {
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
};

const ANNOUNCEMENT_STATUS_LABEL = {
  [ANNOUNCEMENT_STATUS.PUBLISHED]: '已发布',
  [ANNOUNCEMENT_STATUS.ARCHIVED]: '已下架',
};

module.exports = {
  ROLE,
  ROLE_LABEL,
  USER_STATUS,
  USER_STATUS_LABEL,
  MATCH_TYPE,
  MATCH_TYPE_LABEL,
  RATING_POOL,
  RATING_POOL_LABEL,
  ALL_RATING_POOLS,
  MATCH_TYPE_TO_POOL,
  RANK_PROJECT,
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
  RANK_PROJECT_CONFIG,
  MATCH_STATUS,
  MATCH_STATUS_LABEL,
  TEAM,
  RANK_PERIOD,
  RANK_PERIOD_LABEL,
  RANK_SORT_BY,
  COLLECTION,
  STORAGE_KEY,
  DATA_SOURCE,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_STATUS,
  ANNOUNCEMENT_STATUS_LABEL,
};
