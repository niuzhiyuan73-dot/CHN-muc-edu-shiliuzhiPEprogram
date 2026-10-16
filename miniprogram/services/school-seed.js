/** 独立的双校试点目录，不自动写入云端，也不接管现有页面。 */
const {
  COLLEGES, MATCH_TYPE, MATCH_STATUS, MATCH_COMPETITION, MATCH_OUTCOME,
  EVENT_STATUS, EVENT_LEVEL, ANNOUNCEMENT_STATUS, SIGNUP_STATUS,
  EVENT_FORMAT, EVENT_BRONZE_MODE, EVENT_PLACEMENT_MODE, DEFAULT_GF_RESET,
} = require('../utils/constants.js');
const { allAssociations } = require('../utils/associations.js');
const {
  schoolAssociationKey, collegeKey, schoolMemberKey, schoolRoleKey,
  schoolMembershipKey, schoolEventKey, schoolEventSignupKey, schoolMatchKey,
  schoolAnnouncementKey, schoolKey,
} = require('../utils/school.js');
// 记录组装复用旧栈纯规则模块（同一把尺子）——演示内容里的事件 / 比赛 / 公告
// 因此与页面点出来的形状一字不差，不会各写一份、慢慢分叉。
const { buildAnnouncementRecord } = require('./announcement.js');
const { buildEventRecord } = require('./event.js');
const { buildMatchRecord } = require('./match-record.js');
const { buildSchoolApplication } = require('./school-member.js');
// 演示邀请赛的签表由**赛制引擎现算**（两个都是纯函数），与 drawExchangeEvent
// 走同一段代码；手写签表迟早与引擎分叉，演示数据一旦分叉就会误导人。
const { planExchangeDraw, planExchangeMatches } = require('./exchange-plan.js');

const iso = value => new Date(value).toISOString();

function createSchoolSeed() {
  const schools = [
    { _id: 'muc', schoolId: 'muc', name: '中央民族大学', shortName: '民大', status: 'active', configVersion: 1 },
    { _id: 'buaa', schoolId: 'buaa', name: '北京航空航天大学', shortName: '北航', status: 'active', configVersion: 1, simulated: true },
  ];
  const schoolAssociations = schools.flatMap((school) => allAssociations().map((sport) => ({
    _id: schoolAssociationKey({ schoolId: school._id, association: sport.id }),
    schoolId: school._id, association: sport.id, name: `${school.name}${sport.sportName}协会`,
    status: 'active', simulated: school.simulated === true,
  })));
  // 北航学院仅为测试样本，不能作为真实学校组织目录直接上线。
  const colleges = schools.flatMap((school) =>
    (school._id === 'muc' ? COLLEGES : ['航空学院（模拟）', '计算机学院（模拟）', COLLEGES[0]])
      .map((name, index) => {
        const collegeId = `c${String(index + 1).padStart(2, '0')}`;
        return { _id: collegeKey(school._id, collegeId), schoolId: school._id, collegeId,
          name, status: 'active', simulated: school.simulated === true };
      })
  );
  return { schools, schoolAssociations, colleges };
}

/**
 * 双校演示账号。
 *
 * 【为什么北航要有一整套】
 * 演示「跨校差异」时，只切学校却没有对方学校的人可用，就演不出「对方学校的会员
 * 报名 / 被审核 / 有战绩」。所以北航与民大一样备齐：校管理员、普通会员（2～3 位，
 * 战绩各不相同）、学院负责人、协会负责人。
 *
 * 【性别为什么显式写】
 * 单打榜按性别分池（男单 / 女单），没有性别的人在两张榜上都会消失；
 * 学院赛排阵也要按小项性别筛人。演示账号必须带性别，榜单与排阵才有东西可看。
 */
const DEMO_ACCOUNTS = [
  { id: 'demo_muc_admin', schoolId: 'muc', nickName: '民大模拟管理员', gender: 'M', role: 'admin', collegeId: 'c01', studentId: 'TEST001' },
  { id: 'demo_muc_member', schoolId: 'muc', nickName: '民大模拟会员', gender: 'M', collegeId: 'c01', studentId: 'TEST002' },
  // 四校本账号的学号保持不变（既有用例拿 TEST001 / TEST002 演「学号已被占用」），
  // 新增账号从 TEST003 往后排。
  { id: 'demo_buaa_admin', schoolId: 'buaa', nickName: '北航模拟管理员', gender: 'M', role: 'admin', collegeId: 'c01', studentId: 'TEST001' },
  { id: 'demo_buaa_member', schoolId: 'buaa', nickName: '北航模拟会员', gender: 'M', collegeId: 'c01', studentId: 'TEST002' },
  // 北航扩充（2026-10-16）：会员二 / 三、学院负责人、协会负责人——跨校也有差异性
  { id: 'demo_buaa_member_2', schoolId: 'buaa', nickName: '北航模拟会员二', gender: 'M', collegeId: 'c02', studentId: 'TEST003' },
  { id: 'demo_buaa_member_3', schoolId: 'buaa', nickName: '北航模拟会员三', gender: 'F', collegeId: 'c02', studentId: 'TEST004' },
  { id: 'demo_buaa_college_leader', schoolId: 'buaa', nickName: '北航学院负责人', gender: 'M', collegeId: 'c01', studentId: 'TEST005',
    membership: { role: 'staff', collegeId: 'c01' } },
  { id: 'demo_buaa_leader', schoolId: 'buaa', nickName: '北航协会负责人', gender: 'M', collegeId: 'c01', studentId: 'TEST006',
    membership: { role: 'leader' } },
  // 民大扩充（2026-10-16）：北航有会员二 / 三，民大只有一位会员，两校人数不对称；
  // 跨校邀请赛演示因此凑不出「两校各两人」的四人签表。补一位民大会员二。
  //
  // 【为什么这一位还带着转校演示】
  // 另一位「民大模拟会员」要保持**干净**——演示时必须能当场走一遍「提交转校申请」；
  // 这一位则预置一条**已提交、待北航审批**的转校申请（见 demoTransferApplication），
  // 于是「北航管理员审批转校」也是一步直达，两条路径各有一个专属账号。
  { id: 'demo_muc_member_2', schoolId: 'muc', nickName: '民大模拟会员二', gender: 'F', collegeId: 'c01', studentId: 'TEST007' },
];

function createSchoolDemoSeed() {
  const seed = createSchoolSeed();
  seed.users = DEMO_ACCOUNTS.map((account) => ({
    // openId 沿用既有约定「mock_openid_ + 去掉 demo_ 前缀的编号」：
    // 云端入口与用例都按 openId 认人（mock_openid_muc_admin 等），不能改名。
    _id: account.id, openId: `mock_openid_${account.id.replace(/^demo_/, '')}`,
    nickName: account.nickName, gender: account.gender,
    platformStatus: 'active', platformRole: 'member',
    primarySchoolId: account.schoolId, simulated: true,
  }));
  seed.schoolMembers = DEMO_ACCOUNTS.map((account) => ({
    _id: schoolMemberKey(account.id, account.schoolId), userId: account.id,
    schoolId: account.schoolId, collegeId: account.collegeId, studentId: account.studentId,
    status: 'active', simulated: true,
  }));
  seed.schoolRoles = DEMO_ACCOUNTS.filter((account) => account.role === 'admin').map((account) => ({
    _id: schoolRoleKey(account.id, account.schoolId), userId: account.id,
    schoolId: account.schoolId, role: 'admin', status: 'active', simulated: true,
  }));
  // 协会身份：学院负责人（staff + collegeId）/ 协会负责人（leader）。
  // 与学校身份页授予的角色同形，页面判权走的仍是同一把尺子。
  seed.memberships = DEMO_ACCOUNTS.filter((account) => account.membership).map((account) => ({
    _id: schoolMembershipKey(account.id, { schoolId: account.schoolId, association: 'pkb' }),
    userId: account.id, schoolId: account.schoolId, association: 'pkb',
    role: account.membership.role,
    ...(account.membership.collegeId ? { collegeId: account.membership.collegeId } : {}),
    status: 'active', simulated: true,
  }));
  return seed;
}

/* ============================================================
 * 演示内容（公告 / 赛事 / 比赛 / 报名）—— 多范围，各有各的口味
 * ============================================================
 * 【为什么与目录种子分开】
 * createSchoolDemoSeed 只造「人」——学校、学院、会员、角色，被近二十个用例
 * 直接调用，形状一变就牵动一大片。演示内容单独成函数，谁要谁接：本地演示由
 * school-mock.reset() 默认挂上；需要干净台账的用例（如公告页夹具）用
 * reset({ withDemoContent: false }) 关掉。
 *
 * 【为什么按范围各造一份（2026-10-16 扩充）】
 * 只造民大匹克球时，切协会 / 切学校看到的还是同一批内容，容易被当成「切了没反应」。
 * 现在每个范围一份规格，三层差异性都落在数据上：
 *   · 不同协会：公告标题、分类、条数与赛事数量各不相同（民大匹克球 5 公告 / 3 赛事，
 *     乒乓 4 / 2，羽球 3 / 1）；
 *   · 不同演示账号：比赛分给不同会员，谁的战绩多、等级分高，切身份就看得出；
 *   · 跨校：北航也有整套账号与自己的公告 / 赛事 / 比赛，切到北航不再是空态。
 *
 * 【时间为什么钉死】
 * 用固定锚点而不是 Date.now()：同一份种子每次 reset 得到完全相同的内容，
 * 用例才能对着确切条数与名次断言。
 * ============================================================ */

/** 演示内容的时间锚点（固定值，保证可复现）。 */
const DEMO_CONTENT_NOW = new Date('2026-03-01T09:00:00Z');
/** 民大匹克球协会：既有用例（首页 / 榜单 / 公告）默认落在这里。 */
const DEMO_CONTENT_SCOPE = Object.freeze({ schoolId: 'muc', association: 'pkb' });
/** 发布者取自种子用户里已存在的账号，台账里「谁发的」才追溯得到。 */
const CONTENT_ANNOUNCER = Object.freeze({ _id: 'demo_platform_admin', nickName: '平台管理员' });
const CONTENT_PUBLISHERS = Object.freeze({
  muc: Object.freeze({ _id: 'demo_muc_admin', nickName: '民大模拟管理员' }),
  buaa: Object.freeze({ _id: 'demo_buaa_admin', nickName: '北航模拟管理员' }),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** 取构建结果里的记录；表单写错时把第一个错误抛出来，别把半截记录塞进种子。 */
function builtRecordOf(built, what) {
  if (!built.ok) throw new Error(`演示${what}构造失败：${built.firstError}`);
  return built.record;
}

/** 各范围的演示内容规格：公告 / 赛事 / 比赛 / 报名四张表，条数与标题刻意拉开。 */
const DEMO_CONTENT_SPECS = Object.freeze([
  {
    schoolId: 'muc', association: 'pkb', venue: '民大体育馆',
    announcements: [
      { rawId: 'welcome', title: '民大匹克球协会公告栏开通', content: '协会公告、赛事与战报都会在这里发布，请留意。', category: '通知', pinned: true },
      { rawId: 'singles-open', title: '男子单打公开赛报名本周六截止', content: '面向全校男会员，名额有限，先到先得。', category: '赛事', pinned: false },
      { rawId: 'first-report', title: '春季杯首场战报', content: '名次已录入，等级分同步更新。', category: '战报', pinned: false },
      { rawId: 'holiday-court', title: '五一假期场地开放时间调整', content: '假期内 1 号场与 2 号场全天开放，3 号场检修。', category: '通知', pinned: false },
      { rawId: 'gear-pickup', title: '新会员队服与球拍领取说明', content: '凭学生证到体育馆器材室领取，每人限一套。', category: '通知', pinned: false },
    ],
    events: [
      // 报名（signups）：报名中的赛事给 2～6 人，取本范围流水里出现过的会员；
      // 已结束赛事的 signups 必须覆盖 results——名次页与详情页的姓名全靠这条链，
      // 名单为空时构建器只能拿 results 里的编号当昵称显示。
      { rawId: 'open-singles', title: '民大男单公开赛', startOffsetDays: 7, quota: 16,
        signups: ['u03', 'u05', 'u09', 'u10', 'u11'] },
      { rawId: 'spring-cup', title: '民大春季杯男单赛', startOffsetDays: -14, quota: 16,
        signups: ['u03', 'u05', 'u06', 'u07'],
        results: [
          { userId: 'u03', placement: 1 }, { userId: 'u05', placement: 2 },
          { userId: 'u06', placement: 3 }, { userId: 'u07', placement: 4 },
        ] },
      { rawId: 'doubles-challenge', title: '民大匹克球双打挑战赛', startOffsetDays: 14, quota: 24,
        signups: ['u07', 'u11', 'u14', 'u15'] },
    ],
    matches: [
      // 男单：八位会员各打若干场（谁的战绩厚，切身份就看得出）
      { rawId: 'ms-1', teamA: ['u03'], teamB: ['u06'], scoreA: [11, 11], scoreB: [8, 9], ago: 6 },
      { rawId: 'ms-2', teamA: ['u05'], teamB: ['u07'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 6 },
      { rawId: 'ms-3', teamA: ['u01'], teamB: ['u09'], scoreA: [11, 6, 11], scoreB: [9, 11, 7], ago: 5 },
      { rawId: 'ms-4', teamA: ['u03'], teamB: ['u05'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 5 },
      { rawId: 'ms-5', teamA: ['u06'], teamB: ['u07'], scoreA: [11, 11], scoreB: [7, 6], ago: 5 },
      { rawId: 'ms-6', teamA: ['u09'], teamB: ['u10'], scoreA: [11, 9, 13], scoreB: [9, 11, 11], ago: 4 },
      { rawId: 'ms-7', teamA: ['u01'], teamB: ['u11'], scoreA: [11, 11], scoreB: [5, 8], ago: 4 },
      { rawId: 'ms-8', teamA: ['u06'], teamB: ['u10'], scoreA: [12, 11], scoreB: [10, 9], ago: 3 },
      // 女单：三位女会员
      { rawId: 'ws-1', teamA: ['u14'], teamB: ['u15'], scoreA: [11, 11], scoreB: [6, 8], ago: 3 },
      { rawId: 'ws-2', teamA: ['u15'], teamB: ['u16'], scoreA: [11, 9, 11], scoreB: [8, 11, 6], ago: 3 },
      { rawId: 'ws-3', teamA: ['u16'], teamB: ['u24'], scoreA: [11, 7, 11], scoreB: [9, 11, 8], ago: 2 },
      // 双打：三场，男女各半
      { rawId: 'md-1', teamA: ['u03', 'u05'], teamB: ['u06', 'u07'], scoreA: [11, 11], scoreB: [9, 7], ago: 2 },
      { rawId: 'md-2', teamA: ['u01', 'u09'], teamB: ['u10', 'u11'], scoreA: [11, 8, 11], scoreB: [8, 11, 6], ago: 2 },
      { rawId: 'md-3', teamA: ['u14', 'u15'], teamB: ['u16', 'u24'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 1 },
    ],
  },
  {
    schoolId: 'muc', association: 'tt', venue: '民大乒乓球馆',
    announcements: [
      { rawId: 'tt-welcome', title: '民大乒乓球协会训练安排', content: '每周二、四 19:00 常规训练，请提前十分钟到场。', category: '通知', pinned: true },
      { rawId: 'tt-points-open', title: '乒乓球单打积分赛报名开始', content: '本月积分赛开放报名，限 32 人。', category: '赛事', pinned: false },
      { rawId: 'tt-report', title: '上周积分赛战报', content: '四强出炉，等级分榜前五名次有变动。', category: '战报', pinned: false },
      { rawId: 'tt-court-adjust', title: '乒乓球馆场地调整通知', content: '3 号台检修，请使用 1、2、4 号台。', category: '通知', pinned: false },
    ],
    events: [
      { rawId: 'tt-points-cup', title: '民大乒乓球单打积分赛', startOffsetDays: 10, quota: 32,
        signups: ['u04', 'u08', 'u12', 'u22', 'u23'] },
      { rawId: 'tt-spring-league', title: '民大乒乓球春季联赛', startOffsetDays: -20, quota: 16,
        signups: ['u04', 'u08', 'u10', 'u11'],
        results: [
          { userId: 'u04', placement: 1 }, { userId: 'u08', placement: 2 },
          { userId: 'u10', placement: 3 }, { userId: 'u11', placement: 4 },
        ] },
    ],
    matches: [
      { rawId: 'tt-ms-1', teamA: ['u04'], teamB: ['u08'], scoreA: [11, 11], scoreB: [7, 9], ago: 7 },
      { rawId: 'tt-ms-2', teamA: ['u10'], teamB: ['u11'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 7 },
      { rawId: 'tt-ms-3', teamA: ['u12'], teamB: ['u13'], scoreA: [11, 11], scoreB: [9, 6], ago: 6 },
      { rawId: 'tt-ms-4', teamA: ['u08'], teamB: ['u12'], scoreA: [11, 8, 11], scoreB: [8, 11, 9], ago: 6 },
      { rawId: 'tt-ms-5', teamA: ['u04'], teamB: ['u11'], scoreA: [11, 11], scoreB: [6, 8], ago: 5 },
      { rawId: 'tt-ws-1', teamA: ['u22'], teamB: ['u23'], scoreA: [11, 9, 11], scoreB: [9, 11, 7], ago: 5 },
      { rawId: 'tt-md-1', teamA: ['u04', 'u12'], teamB: ['u08', 'u13'], scoreA: [11, 11], scoreB: [9, 8], ago: 4 },
      { rawId: 'tt-md-2', teamA: ['u22', 'u23'], teamB: ['u10', 'u11'], scoreA: [11, 7, 11], scoreB: [7, 11, 9], ago: 3 },
    ],
  },
  {
    schoolId: 'muc', association: 'bd', venue: '民大羽毛球馆',
    announcements: [
      { rawId: 'bd-recruit', title: '民大羽毛球协会新赛季招新', content: '欢迎零基础同学加入，每周三晚有教练带训。', category: '通知', pinned: true },
      { rawId: 'bd-doubles-open', title: '羽毛球双打联赛报名开始', content: '自由组队，每队 2 人，限 16 队。', category: '赛事', pinned: false },
      { rawId: 'bd-gear', title: '羽毛球协会器材借用说明', content: '球拍与羽毛球可在器材室登记借用，当日归还。', category: '通知', pinned: false },
    ],
    events: [
      { rawId: 'bd-doubles-invite', title: '民大羽毛球双打邀请赛', startOffsetDays: 21, quota: 32,
        signups: ['u07', 'u12', 'u19', 'u21'] },
    ],
    matches: [
      { rawId: 'bd-ms-1', teamA: ['u07'], teamB: ['u11'], scoreA: [11, 11], scoreB: [8, 6], ago: 8 },
      { rawId: 'bd-ms-2', teamA: ['u12'], teamB: ['u13'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 8 },
      { rawId: 'bd-ms-3', teamA: ['u07'], teamB: ['u12'], scoreA: [11, 9, 11], scoreB: [9, 11, 7], ago: 6 },
      { rawId: 'bd-ws-1', teamA: ['u19'], teamB: ['u21'], scoreA: [11, 11], scoreB: [7, 9], ago: 6 },
      { rawId: 'bd-md-1', teamA: ['u07', 'u11'], teamB: ['u12', 'u13'], scoreA: [11, 11], scoreB: [9, 7], ago: 4 },
      { rawId: 'bd-md-2', teamA: ['u19', 'u21'], teamB: ['u22', 'u23'], scoreA: [11, 8, 11], scoreB: [8, 11, 9], ago: 3 },
    ],
  },
  {
    schoolId: 'buaa', association: 'pkb', venue: '北航学院路体育馆',
    announcements: [
      { rawId: 'buaa-recruit', title: '北航匹克球协会秋季招新', content: '面向全体在校生招募新会员，11 月 1 日前到体育部登记。', category: '通知', pinned: true },
      { rawId: 'buaa-freshman-cup', title: '北航新生杯匹克球赛报名', content: '新生杯开始报名，各院系限报 4 人。', category: '赛事', pinned: false },
      { rawId: 'buaa-court-open', title: '体育馆匹克球场地开放调整', content: '工作日 18:00–22:00 开放，周末全天开放。', category: '通知', pinned: false },
      { rawId: 'buaa-report', title: '校队选拔赛战报', content: '选拔结束，六名队员进入校队集训名单。', category: '战报', pinned: false },
    ],
    events: [
      { rawId: 'buaa-freshman', title: '北航新生杯匹克球赛', startOffsetDays: 9, quota: 32,
        signups: ['demo_buaa_member', 'demo_buaa_member_2', 'demo_buaa_member_3', 'demo_buaa_leader'] },
      { rawId: 'buaa-friendlies', title: '北航院系匹克球友谊赛', startOffsetDays: -12, quota: 16,
        signups: ['demo_buaa_member', 'demo_buaa_member_2', 'demo_buaa_admin', 'demo_buaa_member_3'],
        results: [
          { userId: 'demo_buaa_member', placement: 1 }, { userId: 'demo_buaa_member_2', placement: 2 },
          { userId: 'demo_buaa_admin', placement: 3 }, { userId: 'demo_buaa_member_3', placement: 4 },
        ] },
    ],
    matches: [
      { rawId: 'buaa-ms-1', teamA: ['demo_buaa_member'], teamB: ['demo_buaa_member_2'], scoreA: [11, 11], scoreB: [9, 7], ago: 6 },
      { rawId: 'buaa-ms-2', teamA: ['demo_buaa_admin'], teamB: ['demo_buaa_leader'], scoreA: [11, 8, 11], scoreB: [8, 11, 9], ago: 6 },
      { rawId: 'buaa-ms-3', teamA: ['demo_buaa_member_2'], teamB: ['demo_buaa_member_3'], scoreA: [11, 11], scoreB: [6, 8], ago: 5 },
      { rawId: 'buaa-ms-4', teamA: ['demo_buaa_member'], teamB: ['demo_buaa_college_leader'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 5 },
      { rawId: 'buaa-ms-5', teamA: ['demo_buaa_member_2'], teamB: ['demo_buaa_leader'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 4 },
      { rawId: 'buaa-ms-6', teamA: ['demo_buaa_member_3'], teamB: ['demo_buaa_member'], scoreA: [11, 11], scoreB: [9, 7], ago: 3 },
      { rawId: 'buaa-md-1', teamA: ['demo_buaa_member', 'demo_buaa_member_2'], teamB: ['demo_buaa_admin', 'demo_buaa_leader'], scoreA: [11, 11], scoreB: [8, 9], ago: 2 },
      { rawId: 'buaa-md-2', teamA: ['demo_buaa_member_3', 'demo_buaa_college_leader'], teamB: ['demo_buaa_member', 'demo_buaa_member_2'], scoreA: [11, 9, 11], scoreB: [9, 11, 7], ago: 1 },
    ],
  },
  {
    schoolId: 'buaa', association: 'tt', venue: '北航沙河校区乒乓球室',
    announcements: [
      { rawId: 'buaa-tt-training', title: '北航乒乓球协会周末训练', content: '周六 15:00 沙河校区乒乓球室，器材自备。', category: '通知', pinned: true },
      { rawId: 'buaa-tt-open', title: '北航乒乓球积分赛报名', content: '积分赛开放报名，前八名计入校队选拔。', category: '赛事', pinned: false },
    ],
    events: [
      { rawId: 'buaa-tt-cup', title: '北航乒乓球公开赛', startOffsetDays: 15, quota: 24,
        signups: ['demo_buaa_member', 'demo_buaa_leader', 'demo_buaa_admin', 'demo_buaa_member_2'] },
    ],
    matches: [
      { rawId: 'buaa-tt-1', teamA: ['demo_buaa_member'], teamB: ['demo_buaa_leader'], scoreA: [11, 11], scoreB: [8, 6], ago: 7 },
      { rawId: 'buaa-tt-2', teamA: ['demo_buaa_admin'], teamB: ['demo_buaa_member_2'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 5 },
      { rawId: 'buaa-tt-3', teamA: ['demo_buaa_member', 'demo_buaa_admin'], teamB: ['demo_buaa_leader', 'demo_buaa_member_2'], scoreA: [11, 7, 11], scoreB: [7, 11, 9], ago: 2 },
    ],
  },
]);

/** 某范围的公告：分类覆盖 / 置顶 / 标题都按规格走。 */
function demoAnnouncementDocs(spec, now) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  const at = iso(now);
  return spec.announcements.map(({ rawId, ...form }) => ({
    ...builtRecordOf(buildAnnouncementRecord(form, { actor: CONTENT_ANNOUNCER, now }), '公告'),
    _id: schoolAnnouncementKey(rawId, scope),
    schoolId: scope.schoolId, association: scope.association,
    status: ANNOUNCEMENT_STATUS.PUBLISHED,
    publishTime: at,
    fingerprint: JSON.stringify([form.title, form.content, form.category, Boolean(form.pinned)]),
    revision: 1,
    updatedAt: at,
  }));
}

/**
 * 一场演示赛事的报名名单规格。
 *
 * 【为什么没有报名记录也要能造赛事】
 * 历史规格缺 `signups` 时按「没人报名」处理，赛事本身照常成立——报名记录是
 * 另一张表，不该反过来把赛事卡住。
 */
const signupsOf = item => (Array.isArray(item.signups) ? item.signups : []);

/** 某范围的个人赛事：一条报名中、按规格可带已结束（含名次）的。 */
function demoEventDocs(spec, now) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  const at = iso(now);
  const publisher = CONTENT_PUBLISHERS[spec.schoolId] || CONTENT_PUBLISHERS.muc;
  const base = {
    description: '协会常规个人赛', matchType: MATCH_TYPE.SINGLES, level: EVENT_LEVEL.THIRD,
    format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
    courtCount: 2, location: spec.venue,
  };
  return spec.events.map((item) => {
    const form = {
      ...base, title: item.title, quota: item.quota || 16,
      startTime: new Date(now.getTime() + item.startOffsetDays * DAY_MS),
    };
    const extra = item.results
      ? { status: EVENT_STATUS.FINISHED, finishedAt: at, results: item.results }
      : {};
    const record = {
      ...builtRecordOf(buildEventRecord(form, { actor: publisher, now }), '赛事'), ...extra,
    };
    return {
      ...record,
      _id: schoolEventKey(item.rawId, scope),
      schoolId: scope.schoolId, association: scope.association,
      startTime: iso(record.startTime),
      publishTime: iso(record.publishTime),
      pinned: Boolean(item.pinned),
      // 人数与报名记录同源：写死 0 会让列表出现「四个名次、0 人」这种自相矛盾的画面，
      // 而读端一旦在台账里找到本场报名就只认台账，主记录上的计数只是个影子。
      signupCount: signupsOf(item).length,
      fingerprint: JSON.stringify([record.title, record.matchType, record.level, record.startTime]),
      revision: 1, updatedAt: at,
    };
  });
}

/**
 * 某范围的报名记录：逐条对应赛事规格里的 `signups`。
 *
 * 【为什么必须有这张表（2026-10-16 用户实测）】
 * 详情页 / 名次页的姓名走「报名名单 → 会员档案」这条链：名单为空时，名次行
 * 取不到档案，只能把 `results` 里的 userId 当昵称显示——用户看到的「名次里
 * 全是 u03 / u05」正是这一步回退。所以**已结束赛事的报名记录与名次同源**：
 * results 里出现的每个人，规格的 signups 里都必须有，人数也应等于名次人数。
 *
 * 【为什么一律落「已报名」】
 * 签到是赛事当天的动作（进行中的赛事才让代签），种子里预置签到态会让
 * 「谁能替谁签到」的演示失去可操作的对象；因此 checkInTime 一律为 null。
 *
 * 【时间为什么钉在锚点上】
 * 与公告 / 赛事 / 比赛同一条纪律：只从 DEMO_CONTENT_NOW 加固定偏移取时间，
 * 不用 Date.now()，同一份种子每次 reset 得到一模一样的记录。报名时间一律排在
 * 开赛之前（已结束的赛事排在开赛日之前，报名中的赛事排在锚点当日之前）。
 */
function demoSignupDocs(spec, now) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  return spec.events.flatMap((item) => {
    const eventId = schoolEventKey(item.rawId, scope);
    // 开赛在锚点之后的（报名中），报到锚点当天为止；已结束的报到开赛日为止。
    const latest = Math.min(now.getTime() + item.startOffsetDays * DAY_MS, now.getTime());
    const rows = signupsOf(item);
    return rows.map((userId, index) => ({
      _id: schoolEventSignupKey(eventId, userId, scope),
      schoolId: scope.schoolId, association: scope.association,
      eventId, userId,
      status: SIGNUP_STATUS.SIGNED,
      // 按规格顺序由早到晚排：名单读出来与名次表同序（第一个人在名次里也排在最前）。
      signTime: iso(new Date(latest - (rows.length - index) * DAY_MS)),
      checkInTime: null, actorId: userId, cancelTime: null, revision: 1,
    }));
  });
}

/**
 * 某范围的比赛流水：单打 / 双打混排，分给不同演示账号。
 * 谁的战绩厚、等级分高，切演示身份进个人页与榜单就看得出。
 */
function demoMatchDocs(spec, now) {
  const scope = { schoolId: spec.schoolId, association: spec.association };
  const at = iso(now);
  return spec.matches.map((item) => {
    const matchTime = new Date(now.getTime() - item.ago * DAY_MS);
    const record = builtRecordOf(buildMatchRecord({
      matchType: item.teamA.length === 2 ? MATCH_TYPE.DOUBLES : MATCH_TYPE.SINGLES,
      teamA: item.teamA, teamB: item.teamB, scoreA: item.scoreA, scoreB: item.scoreB,
      gamePoints: 11, bestOf: 3, matchTime, location: spec.venue, recorder: item.teamA[0],
    }), '比赛');
    return {
      ...record,
      _id: schoolMatchKey(item.rawId, scope),
      schoolId: scope.schoolId, association: scope.association,
      competition: MATCH_COMPETITION.PERSONAL, status: MATCH_STATUS.ACTIVE, outcome: MATCH_OUTCOME.NORMAL,
      matchTime: iso(matchTime),
      action: 'seed', actor: 'demo-seed', actedAt: at, revision: 1,
    };
  });
}

/* ============================================================
 * 跨校邀请赛演示（2026-10-16）：一进页面就有赛事可看、可操作
 * ============================================================
 * 【为什么要预置】
 * 邀请赛原先只能靠演示者自己「创建 → 邀请 → 报名 → 锁定 → 抽签」把整条链
 * 摆一遍，页面初始永远是空的。这里直接落两场，覆盖两个最有代表性的状态：
 *   · 报名中（单败淘汰）：两校各一人已报名，可演报名 / 取消 / 移出 /
 *     撤回邀请 / 锁定名单；
 *   · 已抽签（小组赛+淘汰）：四人小组赛已排期，可演录分 → 淘汰赛出来 →
 *     录分 → 确认名次，顺带把新加的赛制也演示到。
 *
 * 【开赛时间为什么钉在 2030】
 * 报名与锁定都拿**真实当前时间**与 startTime 比大小（见 changeSignup 与
 * lockExchangeRoster 的入口条件）。种子统一的时间锚点 DEMO_CONTENT_NOW 是
 * 2026-03-01，照它加偏移得到的开赛时间早就过期，报名一定被拒。所以这两场
 * 用固定但远在未来（2030）的开赛时间：既让报名走得通，又仍是常量而不是
 * Date.now()——同一份种子每次 reset 结果完全一致。
 *
 * 【对阵为什么现算而不是手写】
 * draw 与 matches 调 exchange-plan 的 planExchangeDraw / planExchangeMatches
 * 现算（两个都是纯函数），与云端 drawExchangeEvent 走同一段代码。手写签表
 * 迟早与引擎分叉，而演示数据一旦分叉最误导人。
 * ============================================================ */

/** 演示邀请赛的开赛时间：固定常量，且远在任何可预见的「当前时间」之后 */
const EXCHANGE_DEMO_START = '2030-03-01T10:00:00Z';
const EXCHANGE_DEMO_START_LATER = '2030-03-08T10:00:00Z';
/** 演示签表的随机种子：固定值，签位每次 reset 完全一样 */
const DEMO_EXCHANGE_SEED = 20261016;

/** 参赛者一律取已在册的演示账号，读端才按昵称显示得出人 */
const EXCHANGE_DEMO_ENTRANTS = Object.freeze({
  open: Object.freeze([
    Object.freeze({ userId: 'demo_muc_member', schoolId: 'muc' }),
    Object.freeze({ userId: 'demo_buaa_member', schoolId: 'buaa' }),
  ]),
  drawn: Object.freeze([
    Object.freeze({ userId: 'demo_muc_admin', schoolId: 'muc' }),
    Object.freeze({ userId: 'demo_muc_member_2', schoolId: 'muc' }),
    Object.freeze({ userId: 'demo_buaa_member', schoolId: 'buaa' }),
    Object.freeze({ userId: 'demo_buaa_member_2', schoolId: 'buaa' }),
  ]),
});

const DEMO_ACCOUNT_BY_ID = new Map(DEMO_ACCOUNTS.map(account => [account.id, account]));

/** 两场演示邀请赛的赛事 / 邀请索引 / 报名 / 对阵四张表 */
function demoExchangeDocs(now, schoolNames) {
  const at = iso(now);
  const participantSchoolIds = ['buaa', 'muc'];
  const base = {
    schoolId: 'muc', association: 'pkb', participantSchoolIds, schoolNames,
    quota: 4, schoolQuotas: { buaa: 2, muc: 2 },
    eventScope: 'inter_school', ratingPolicy: 'unrated', matchType: 'singles',
    createdBy: 'demo_muc_admin', createdAt: at,
  };
  const events = [];
  const invitations = [];
  const signups = [];
  const matches = [];
  // 邀请索引与报名记录的键、字段都照 exchange-service 的写入原样复刻，
  // 少一个字段读端就会当它不存在（例如报名少了 nickName，对阵里只剩编号）。
  const invitationOf = (eventId, schoolId) => ({ _id: schoolKey('xi', eventId, schoolId),
    eventId, schoolId, association: 'pkb' });
  const signupOf = (event, entrant) => {
    const account = DEMO_ACCOUNT_BY_ID.get(entrant.userId) || {};
    return { _id: schoolKey('xs', event._id, entrant.userId),
      eventId: event._id, schoolId: event.schoolId, association: 'pkb',
      userId: entrant.userId, representedSchoolId: entrant.schoolId,
      schoolMemberId: schoolMemberKey(entrant.userId, entrant.schoolId),
      nickName: account.nickName || entrant.userId,
      schoolName: schoolNames[entrant.schoolId] || entrant.schoolId,
      status: 'signed', updatedAt: at, revision: 1 };
  };

  // 1) 报名中：两校各一人，等齐了就能锁定名单
  const openId = schoolKey('xe', 'muc', 'pkb', 'demo-seed', 'invite-open');
  const openEvent = { ...base, _id: openId, title: '民大北航匹克球交流赛（报名中）',
    location: '民大体育馆', startTime: EXCHANGE_DEMO_START, status: 'signup',
    invitations: { buaa: 'accepted', muc: 'accepted' },
    schoolCounts: { buaa: 1, muc: 1 }, signupCount: 2,
    format: EVENT_FORMAT.SINGLE_ELIM, bronzeMode: EVENT_BRONZE_MODE.TIED,
    placementMode: EVENT_PLACEMENT_MODE.NONE, gfReset: DEFAULT_GF_RESET,
    fingerprint: JSON.stringify([openId]), revision: 1 };
  events.push(openEvent);
  for (const schoolId of participantSchoolIds) invitations.push(invitationOf(openId, schoolId));
  for (const entrant of EXCHANGE_DEMO_ENTRANTS.open) signups.push(signupOf(openEvent, entrant));

  // 2) 已抽签：小组赛 + 淘汰。签表与对阵由赛制引擎现算，与云端抽签同一段代码
  const drawnId = schoolKey('xe', 'muc', 'pkb', 'demo-seed', 'invite-drawn');
  const entrants = EXCHANGE_DEMO_ENTRANTS.drawn;
  const drawnEvent = { ...base, _id: drawnId, title: '民大北航匹克球邀请赛（已抽签）',
    location: '民大体育馆', startTime: EXCHANGE_DEMO_START_LATER, status: 'drawn',
    invitations: { buaa: 'accepted', muc: 'accepted' },
    schoolCounts: { buaa: 2, muc: 2 }, signupCount: entrants.length,
    format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2, advancePerGroup: 1,
    bronzeMode: EVENT_BRONZE_MODE.TIED, placementMode: EVENT_PLACEMENT_MODE.NONE,
    gfReset: DEFAULT_GF_RESET, fingerprint: JSON.stringify([drawnId]), revision: 2 };
  const planned = planExchangeDraw({ entries: entrants.map(row => ({ userId: row.userId })),
    seedValue: DEMO_EXCHANGE_SEED, format: drawnEvent.format,
    groupCount: drawnEvent.groupCount, advancePerGroup: drawnEvent.advancePerGroup });
  if (!planned.ok) throw new Error(`演示邀请赛签表构造失败：${planned.message}`);
  drawnEvent.draw = { ...planned.draw, createdAt: at, createdBy: 'demo_muc_admin' };
  const entrantsById = new Map(entrants.map(row => [row.userId,
    { userId: row.userId, schoolId: row.schoolId }]));
  const built = planExchangeMatches({ event: drawnEvent, draw: drawnEvent.draw, entrantsById, matches: [] });
  for (const match of built.matches) {
    matches.push({ ...match, schoolId: drawnEvent.schoolId, association: drawnEvent.association });
  }
  events.push(drawnEvent);
  for (const schoolId of participantSchoolIds) invitations.push(invitationOf(drawnId, schoolId));
  for (const entrant of entrants) signups.push(signupOf(drawnEvent, entrant));

  return { events, invitations, signups, matches };
}

/**
 * 转校演示：预置一条「已提交、待转入学校审批」的转校申请。
 *
 * 【为什么需要一个专属账号】
 * 「提交转校申请」与「审批转校申请」是两条不同的演示路径，共用一个账号就只能
 * 二选一：申请一旦提交，那个账号再点进去看到的是「已提交，等待审核」，演示
 * 「当场提交一份申请」就无从下手。于是分成两位民大会员：
 *   · demo_muc_member    —— 干净的会员，用来当场演示提交转校申请；
 *   · demo_muc_member_2  —— 本函数预置了一条待北航审批的申请。
 * 申请只落在北航那一侧（schoolId: 'buaa'），账号归属仍在民大，与
 * applySchoolTransfer 的落库形状一致，因此北航管理员一进「学校身份」就能审。
 */
function demoTransferApplication(now) {
  return {
    ...buildSchoolApplication({
      userId: 'demo_muc_member_2',
      school: { schoolId: 'buaa', status: 'active', name: '北京航空航天大学' },
      college: { collegeId: 'c01', schoolId: 'buaa', status: 'active', name: '航空学院（模拟）' },
      studentId: 'TEST007', now,
    }),
    transferFrom: 'muc', revision: 1,
  };
}

/**
 * 全部演示内容：旧栈的公告 / 赛事 / 比赛 / 报名四批之外，再挂跨校邀请赛
 * （赛事 / 邀请索引 / 报名 / 对阵四表）与一条待审转校申请。
 * 由 school-mock.reset() 默认挂进内存仓储，供协会空间、排行榜、学校身份与
 * 跨校邀请赛四处演示。
 *
 * 【为什么报名记录由本函数一起产出】
 * 报名要与赛事同一次 reset 落库：分成两处造，早晚出现「赛事在、名单不在」的
 * 半截演示（名次里全是编号）。school-mock.reset() 按 content 的键名整批挂表，
 * 新增 exchangeEvents / schoolMembers 等键不需要它改一行代码。
 *
 * @returns {{announcements: Array<Object>, events: Array<Object>, matches: Array<Object>,
 *   eventSignups: Array<Object>, exchangeEvents: Array<Object>,
 *   exchangeInvitations: Array<Object>, exchangeSignups: Array<Object>,
 *   exchangeMatches: Array<Object>, schoolMembers: Array<Object>}}
 */
function createSchoolDemoContent() {
  const now = DEMO_CONTENT_NOW;
  const content = { announcements: [], events: [], matches: [], eventSignups: [] };
  for (const spec of DEMO_CONTENT_SPECS) {
    content.announcements.push(...demoAnnouncementDocs(spec, now));
    content.events.push(...demoEventDocs(spec, now));
    content.matches.push(...demoMatchDocs(spec, now));
    content.eventSignups.push(...demoSignupDocs(spec, now));
  }
  const schoolNames = Object.fromEntries(createSchoolSeed().schools.map(row => [row._id, row.name]));
  const exchange = demoExchangeDocs(now, schoolNames);
  content.exchangeEvents = exchange.events;
  content.exchangeInvitations = exchange.invitations;
  content.exchangeSignups = exchange.signups;
  content.exchangeMatches = exchange.matches;
  // 待审转校申请挂在 schoolMembers 上（与真实落库同一张表），reset() 会追加到已有会员之后
  content.schoolMembers = [demoTransferApplication(now)];
  return content;
}

module.exports = { createSchoolSeed, createSchoolDemoSeed, createSchoolDemoContent, DEMO_ACCOUNTS, DEMO_CONTENT_SPECS };
