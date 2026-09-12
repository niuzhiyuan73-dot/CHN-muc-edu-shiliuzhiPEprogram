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
  LEFT: 3, // 已离校：不再上榜、不可报名，但历史记录与个人页保留
};

const USER_STATUS_LABEL = {
  [USER_STATUS.PENDING]: '待审核',
  [USER_STATUS.ACTIVE]: '正常',
  [USER_STATUS.DISABLED]: '已禁用',
  [USER_STATUS.LEFT]: '已离校',
};

/**
 * 这个账号还算不算「在册会员」。
 *
 * 【为什么离校也算】
 * 离校的人历史比赛还留在流水里。回放引擎按名单重放，名单里少一个人，
 * 遇到他参加过的比赛就会直接抛错——整条回放全废，不只是他一个人的分数没了。
 * 所以「能不能进回放名单」和「能不能上榜」是两件事：
 *   - 本函数判前者，正常与离校都算在册；
 *   - 上榜、报名另用 isRankable / USER_STATUS.ACTIVE 把关。
 *
 * @param {number} [status]
 * @returns {boolean}
 */
function isMemberStatus(status) {
  return status === USER_STATUS.ACTIVE || status === USER_STATUS.LEFT;
}

/**
 * 这个账号该不该出现在榜上。
 *
 * 离校的人不再是「当前会员」，榜首挂着一个已经毕业的账号会让榜失去意义。
 * 但记录仍在、个人页仍能打开——藏起来的是名次，不是痕迹。
 * status 缺失（老数据、单元测试造的假会员）一律当作可上榜。
 *
 * @param {Object} [user]
 * @returns {boolean}
 */
function isRankable(user) {
  return !user || user.status !== USER_STATUS.LEFT;
}

/**
 * 会员性别。
 *
 * 【为什么必须采集，而且不让本人随意改】
 * 性别参与两处业务判断，都不只是「展示一下」：
 *   1. 定级——女会员的初始分比男会员低 genderInitialGap 分（见 elo.js）；
 *   2. 上榜——男单榜 / 女单榜按性别过滤（见 RANK_PROJECT_CONFIG）。
 * 少了它，会员会同时从两张单打榜消失，还会被按男会员的初始分定级。
 * 它又会影响历史成绩的定级，因此与姓名、学号一样属于实名信息：
 * 注册时采集，之后由管理员核改，不在个人可改的白名单里。
 *
 * 取值沿用种子数据里的 'M' / 'F'，便于与既有数据对接。
 */
const GENDER = {
  MALE: 'M',
  FEMALE: 'F',
};

const GENDER_LABEL = {
  [GENDER.MALE]: '男',
  [GENDER.FEMALE]: '女',
};

/** 全部性别。校验「填的性别是否在册」时用它 */
const ALL_GENDERS = Object.values(GENDER);

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

/**
 * 赛事状态机。
 *
 *   报名中 ──开始赛事──▶ 进行中 ──录入名次──▶ 已结束
 *     │                     │
 *     └──── 可报名/取消 ─────┘  可签到
 *
 * 【重要】「已结束」必须保持取值 2：种子赛事写死字面量 2，改动它会让
 * 全部历史赛事变成「未结束」，赛季积分瞬间归零。
 * 新增状态一律往下追加编号，不要复用 2。
 */
const EVENT_STATUS = {
  SIGNUP: 0, // 报名中：可报名、可取消，尚未开始
  ONGOING: 1, // 进行中：报名截止，可签到、可录入名次
  FINISHED: 2, // 已结束：名次已定，可计入赛季积分
};

const EVENT_STATUS_LABEL = {
  [EVENT_STATUS.SIGNUP]: '报名中',
  [EVENT_STATUS.ONGOING]: '进行中',
  [EVENT_STATUS.FINISHED]: '已结束',
};

/** 新发布的赛事先落在「报名中」 */
const DEFAULT_EVENT_STATUS = EVENT_STATUS.SIGNUP;

/**
 * 赛事签表的阶段。
 *
 *   main      —— 主赛（淘汰赛各轮）
 *   bronze    —— 三四名决赛（仅 bronzeMode = playoff 时生成）
 *   group     —— 小组 / 循环赛（同名次赛事里的分组循环部分）
 *   wb        —— 双败淘汰·胜者组
 *   lb        —— 双败淘汰·败者组
 *   gf        —— 双败淘汰·总决赛
 *   placement —— 5–8 名排位赛（「八强倒三角」）
 *
 * 它是比赛记录上的一个字段：同一场赛事下的各阶段比赛靠 stage 区分归属，
 * 读的时候才不会把季军赛混进半决赛的轮次里。
 *
 * 【为什么 main / bronze 的取值一个字都不能改】
 * stage 会拼进比赛编号（见 draw.eventMatchKey），而编号是历史数据的 _id。
 * 改掉这两个值，等于让所有已落库的签表比赛找不到自己。新增阶段只能往后加。
 */
const BRACKET_STAGE = {
  MAIN: 'main',
  BRONZE: 'bronze',
  GROUP: 'group',
  WINNERS: 'wb',
  LOSERS: 'lb',
  GRAND_FINAL: 'gf',
  PLACEMENT: 'placement',
};

/**
 * 赛事赛制。
 *
 *   single_elim    —— 单败淘汰（历史缺省，抽签引擎原先唯一支持的形态）
 *   round_robin    —— 循环赛：单人成组，人人与所有人交手
 *   group_knockout —— 小组循环 + 单败淘汰（复合赛制的第一种）
 *   double_elim    —— 双败淘汰：胜者组 / 败者组 / 总决赛
 *
 * 【为什么是「赛制」而不是继续加布尔开关】
 * 复合赛制（小组打完接着淘汰）要求把多个阶段按顺序串起来。若用开关去拼，
 * 组合数一旦上去，分支就再也理不清。这里把它收成一个有序的阶段序列
 * （见 services/format-plan.js），新增复合形态只是多一行预设。
 */
const EVENT_FORMAT = {
  SINGLE_ELIM: 'single_elim',
  ROUND_ROBIN: 'round_robin',
  GROUP_KNOCKOUT: 'group_knockout',
  DOUBLE_ELIM: 'double_elim',
};

const EVENT_FORMAT_LABEL = {
  [EVENT_FORMAT.SINGLE_ELIM]: '单败淘汰',
  [EVENT_FORMAT.ROUND_ROBIN]: '循环赛',
  [EVENT_FORMAT.GROUP_KNOCKOUT]: '小组赛+淘汰',
  [EVENT_FORMAT.DOUBLE_ELIM]: '双败淘汰',
};

/** 历史赛事没有 format 字段，按单败淘汰处理——缺省即旧行为 */
const DEFAULT_EVENT_FORMAT = EVENT_FORMAT.SINGLE_ELIM;

/** 需要分组的赛制（小组数 / 出线人数只对这些有意义） */
const GROUPED_FORMATS = [EVENT_FORMAT.ROUND_ROBIN, EVENT_FORMAT.GROUP_KNOCKOUT];

/** 会产生淘汰签表的赛制（倒三角排位赛只对这些有意义） */
const KNOCKOUT_FORMATS = [
  EVENT_FORMAT.SINGLE_ELIM,
  EVENT_FORMAT.GROUP_KNOCKOUT,
  EVENT_FORMAT.DOUBLE_ELIM,
];

/**
 * 「八强倒三角」5–8 名排位赛的开关。
 *
 *   none —— 不排：八强战负者并列（与历史口径一致）
 *   top8 —— 排位：八强战负者再打一个小签表，分出第 5–8 名
 */
const EVENT_PLACEMENT_MODE = {
  NONE: 'none',
  TOP8: 'top8',
};

const EVENT_PLACEMENT_MODE_LABEL = {
  [EVENT_PLACEMENT_MODE.NONE]: '不排位',
  [EVENT_PLACEMENT_MODE.TOP8]: '排 5–8 名',
};

/** 历史赛事没有这个字段，按「不排位」处理 */
const DEFAULT_PLACEMENT_MODE = EVENT_PLACEMENT_MODE.NONE;

/** 小组赛的可选参数 */
const GROUP_CONFIG = {
  COUNT_OPTIONS: [2, 4],
  ADVANCE_OPTIONS: [1, 2],
};

/** 缺省小组数 / 每组出线人数（4 人一组、每组前 2 出线是最常见的青少年赛制） */
const DEFAULT_GROUP_COUNT = 2;
const DEFAULT_ADVANCE_PER_GROUP = 2;

/**
 * 三四名赛的两种办赛方式（决策 2.3）。
 *
 *   tied    —— 并列季军：两个半决赛负者都记第 3 名，不再加赛
 *   playoff —— 打三四名：半决赛负者再打一场，分出第 3、第 4 名
 *
 * 【为什么是一个字段而不是两套流程】
 * 两种方式只差「第 4 名有没有人」：名次分表里 3 与 4 各有基准分，
 * 并列时两人都取 3，加赛时一人 3 一人 4。名次录入与积分结算因此
 * 可以共用一条通路，只在保存时校验一次名次是否成对。
 */
const EVENT_BRONZE_MODE = {
  TIED: 'tied', // 并列季军
  PLAYOFF: 'playoff', // 打三四名
};

const EVENT_BRONZE_MODE_LABEL = {
  [EVENT_BRONZE_MODE.TIED]: '并列季军',
  [EVENT_BRONZE_MODE.PLAYOFF]: '打三四名',
};

/** 历史赛事没有这个字段，按「并列季军」处理——种子数据正是并列口径 */
const DEFAULT_BRONZE_MODE = EVENT_BRONZE_MODE.TIED;

/**
 * 报名状态。
 *
 * 记录一旦产生就不再删除：取消了也留着（status 置为 CANCELED），
 * 这样「报了多少人、退了多少人」有据可查，重复报名也能靠同一条
 * 记录翻回来——同一人同一赛事永远只有一条。
 */
const SIGNUP_STATUS = {
  CANCELED: 0, // 已取消报名
  SIGNED: 1, // 已报名
  CHECKED_IN: 2, // 已签到
};

const SIGNUP_STATUS_LABEL = {
  [SIGNUP_STATUS.CANCELED]: '已取消',
  [SIGNUP_STATUS.SIGNED]: '已报名',
  [SIGNUP_STATUS.CHECKED_IN]: '已签到',
};

/**
 * 赛事等级（决策 13、2.1）。
 * 等级决定名次分的倍数，也决定赛事比赛的 elo K 值（见 elo.js）。
 */
const EVENT_LEVEL = {
  FIRST: 1, // 一级赛事
  SECOND: 2, // 二级赛事
  THIRD: 3, // 三级赛事
};

const EVENT_LEVEL_LABEL = {
  [EVENT_LEVEL.FIRST]: '一级赛事',
  [EVENT_LEVEL.SECOND]: '二级赛事',
  [EVENT_LEVEL.THIRD]: '三级赛事',
};

/**
 * 等级 → 名次分倍数（决策 2.1）。
 * 只放大名次分，与等级分（elo）无关——后者见 elo.js 的赛事 K 配置。
 */
const EVENT_LEVEL_MULTIPLIER = {
  [EVENT_LEVEL.FIRST]: 4,
  [EVENT_LEVEL.SECOND]: 2,
  [EVENT_LEVEL.THIRD]: 1,
};

/**
 * 缺省赛事等级。
 * 历史 / 种子赛事没有等级字段时按三级处理（决策 13：默认三级，但新建时必选）。
 */
const DEFAULT_EVENT_LEVEL = EVENT_LEVEL.THIRD;

/**
 * 种子来源（决策 2：创建赛事时必选）。
 *
 *   manual —— 手工指定：管理员在抽签时逐个指定 1 号、2 号…
 *   elo    —— 按等级分：取当前单打池 elo 最高的前若干位
 *   points —— 按赛季积分：取本赛季积分最高的前若干位
 *
 * 【为什么和「三四名赛」一样必须显式选】
 * 它决定谁是种子、进而决定谁在签表里受保护。若留空取默认，一次「忘了选」
 * 就会静默改变整张签表，事后也看不出当初本想按什么排。
 */
const SEED_MODE = {
  MANUAL: 'manual',
  ELO: 'elo',
  POINTS: 'points',
};

const SEED_MODE_LABEL = {
  [SEED_MODE.MANUAL]: '手工指定',
  [SEED_MODE.ELO]: '按等级分',
  [SEED_MODE.POINTS]: '按赛季积分',
};

/** 允许的种子数量（决策 3：只有 2 / 4 / 8，不考虑其它数字） */
const SEED_COUNTS = [2, 4, 8];

/** 默认种子数量（决策 3） */
const DEFAULT_SEED_COUNT = 8;

/** 参赛队伍标识 */
const TEAM = {
  A: 'A',
  B: 'B',
};

/**
 * 排行榜时间范围。
 * 只保留「总榜」与「赛季榜」：周榜、月榜已按决策 2 去掉——
 * 短期尺子奖励的是「最近打得勤」，与「谁强谁在前」的等级分榜讲的是
 * 两件事，混在一起反而让人看不懂名次是怎么来的。
 */
const RANK_PERIOD = {
  ALL: 'all', // 总榜
  SEASON: 'season', // 赛季榜
};

const RANK_PERIOD_LABEL = {
  [RANK_PERIOD.ALL]: '总榜',
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
  isMemberStatus,
  isRankable,
  GENDER,
  GENDER_LABEL,
  ALL_GENDERS,
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
  EVENT_STATUS,
  EVENT_STATUS_LABEL,
  DEFAULT_EVENT_STATUS,
  BRACKET_STAGE,
  EVENT_BRONZE_MODE,
  EVENT_BRONZE_MODE_LABEL,
  DEFAULT_BRONZE_MODE,
  SIGNUP_STATUS,
  SIGNUP_STATUS_LABEL,
  EVENT_LEVEL,
  EVENT_LEVEL_LABEL,
  EVENT_LEVEL_MULTIPLIER,
  DEFAULT_EVENT_LEVEL,
  SEED_MODE,
  SEED_MODE_LABEL,
  SEED_COUNTS,
  DEFAULT_SEED_COUNT,
  EVENT_FORMAT,
  EVENT_FORMAT_LABEL,
  DEFAULT_EVENT_FORMAT,
  GROUPED_FORMATS,
  KNOCKOUT_FORMATS,
  EVENT_PLACEMENT_MODE,
  EVENT_PLACEMENT_MODE_LABEL,
  DEFAULT_PLACEMENT_MODE,
  GROUP_CONFIG,
  DEFAULT_GROUP_COUNT,
  DEFAULT_ADVANCE_PER_GROUP,
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
