/** 独立的双校试点目录，不自动写入云端，也不接管现有页面。 */
const {
  COLLEGES, MATCH_TYPE, MATCH_STATUS, MATCH_COMPETITION, MATCH_OUTCOME,
  EVENT_STATUS, EVENT_LEVEL, ANNOUNCEMENT_STATUS,
} = require('../utils/constants.js');
const { allAssociations } = require('../utils/associations.js');
const {
  schoolAssociationKey, collegeKey, schoolMemberKey, schoolRoleKey, ratingKey,
  schoolEventKey, schoolMatchKey, schoolAnnouncementKey,
} = require('../utils/school.js');
// 记录组装复用旧栈纯规则模块（同一把尺子）——演示内容里的事件 / 比赛 / 公告
// 因此与页面点出来的形状一字不差，不会各写一份、慢慢分叉。
const { buildAnnouncementRecord } = require('./announcement.js');
const { buildEventRecord } = require('./event.js');
const { buildMatchRecord } = require('./match-record.js');

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

function createSchoolDemoSeed() {
  const seed = createSchoolSeed();
  seed.users = ['muc', 'buaa'].flatMap((schoolId) => ['admin', 'member'].map((type) => ({
    _id: `demo_${schoolId}_${type}`, openId: `mock_openid_${schoolId}_${type}`,
    nickName: `${schoolId === 'muc' ? '民大' : '北航'}模拟${type === 'admin' ? '管理员' : '会员'}`,
    platformStatus: 'active', platformRole: 'member', primarySchoolId: schoolId, simulated: true,
  })));
  seed.schoolMembers = seed.users.map((user) => ({
    _id: schoolMemberKey(user._id, user.primarySchoolId), userId: user._id,
    schoolId: user.primarySchoolId, collegeId: 'c01',
    studentId: user._id.endsWith('admin') ? 'TEST001' : 'TEST002',
    status: 'active', simulated: true,
  }));
  seed.schoolRoles = seed.users.filter((user) => user._id.endsWith('admin')).map((user) => ({
    _id: schoolRoleKey(user._id, user.primarySchoolId), userId: user._id,
    schoolId: user.primarySchoolId, role: 'admin', status: 'active', simulated: true,
  }));
  seed.memberships = [];
  seed.memberRatings = seed.users.map((user) => ({
    _id: ratingKey(user._id, { schoolId: user.primarySchoolId, association: 'pkb' }),
    userId: user._id, schoolId: user.primarySchoolId, association: 'pkb',
    initialElo: null, currentElo: { singles: [], doubles: [] },
  }));
  return seed;
}

/* ============================================================
 * 演示内容（公告 / 赛事 / 比赛）—— 民大匹克球协会
 * ============================================================
 * 【为什么与目录种子分开】
 * createSchoolDemoSeed 只造「人」——学校、学院、会员、角色，被近二十个用例
 * 直接调用，形状一变就牵动一大片。演示内容单独成函数，谁要谁接：本地演示由
 * school-mock.reset() 默认挂上；需要干净台账的用例（如公告页夹具）用
 * reset({ withDemoContent: false }) 关掉。
 *
 * 【为什么只落在民大 + 默认协会】
 * 北航是「模拟学校」，其页面走 school-demo.js 那套静态演示数据，不从这里取。
 * 民大是真实学校，协会空间的排行榜 / 赛事 / 公告都得有东西可看。比赛特意让
 * 默认登录身份 u06 在列，榜单上还能看到「我」。
 *
 * 【时间为什么钉死】
 * 用固定锚点而不是 Date.now()：同一份种子每次 reset 得到完全相同的内容，
 * 用例才能对着确切条数与名次断言。
 * ============================================================ */

/** 演示内容的时间锚点（固定值，保证可复现）。 */
const DEMO_CONTENT_NOW = new Date('2026-03-01T09:00:00Z');
const DEMO_CONTENT_SCOPE = Object.freeze({ schoolId: 'muc', association: 'pkb' });
/** 发布者取自种子用户里已存在的账号，台账里「谁发的」才追溯得到。 */
const CONTENT_ANNOUNCER = Object.freeze({ _id: 'demo_platform_admin', nickName: '平台管理员' });
const CONTENT_PUBLISHER = Object.freeze({ _id: 'demo_muc_admin', nickName: '民大模拟管理员' });

const DAY_MS = 24 * 60 * 60 * 1000;

/** 取构建结果里的记录；表单写错时把第一个错误抛出来，别把半截记录塞进种子。 */
function builtRecordOf(built, what) {
  if (!built.ok) throw new Error(`演示${what}构造失败：${built.firstError}`);
  return built.record;
}

/** 民大公告三条：分类覆盖 通知 / 赛事 / 战报，一条置顶。 */
function demoAnnouncementDocs(scope, now) {
  const at = iso(now);
  const forms = [
    { rawId: 'welcome', title: '民大匹克球协会公告栏开通', content: '协会公告、赛事与战报都会在这里发布，请留意。', category: '通知', pinned: true },
    { rawId: 'singles-open', title: '男子单打赛报名本周六截止', content: '面向全校男会员，名额有限，先到先得。', category: '赛事', pinned: false },
    { rawId: 'first-report', title: '春季杯首场战报', content: '名次已录入，等级分同步更新。', category: '战报', pinned: false },
  ];
  return forms.map(({ rawId, ...form }) => ({
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

/** 民大个人赛事两条：一条报名中，一条已结束（带名次）。 */
function demoEventDocs(scope, now) {
  const at = iso(now);
  const base = {
    description: '协会常规个人赛', matchType: MATCH_TYPE.SINGLES, level: EVENT_LEVEL.THIRD,
    format: 'single_elim', bronzeMode: 'tied', seedMode: 'elo', seedCount: 4,
    courtCount: 2, quota: 16, location: '民大体育馆',
  };
  const specs = [
    { rawId: 'open-singles', extra: {},
      form: { ...base, title: '民大男单公开赛', startTime: new Date(now.getTime() + 7 * DAY_MS) } },
    { rawId: 'spring-cup',
      extra: {
        status: EVENT_STATUS.FINISHED, finishedAt: at,
        results: [
          { userId: 'u03', placement: 1 }, { userId: 'u05', placement: 2 },
          { userId: 'u06', placement: 3 }, { userId: 'u07', placement: 4 },
        ],
      },
      form: { ...base, title: '民大春季杯男单赛', startTime: new Date(now.getTime() - 14 * DAY_MS) } },
  ];
  return specs.map(({ rawId, form, extra }) => {
    const record = {
      ...builtRecordOf(buildEventRecord(form, { actor: CONTENT_PUBLISHER, now }), '赛事'), ...extra,
    };
    return {
      ...record,
      _id: schoolEventKey(rawId, scope),
      schoolId: scope.schoolId, association: scope.association,
      startTime: iso(record.startTime),
      publishTime: iso(record.publishTime),
      pinned: false, signupCount: 0,
      fingerprint: JSON.stringify([record.title, record.matchType, record.level, record.startTime]),
      revision: 1, updatedAt: at,
    };
  });
}

/** 民大比赛流水：男单 / 女单各给足人，双打一场，三个榜单项目都有人。 */
function demoMatchDocs(scope, now) {
  const at = iso(now);
  const plan = [
    // 男单：u03 / u05 / u06 / u07 打一轮循环（默认身份 u06 在列）
    { rawId: 'ms-1', teamA: ['u03'], teamB: ['u06'], scoreA: [11, 11], scoreB: [8, 9], ago: 6 },
    { rawId: 'ms-2', teamA: ['u05'], teamB: ['u07'], scoreA: [9, 11, 11], scoreB: [11, 8, 9], ago: 6 },
    { rawId: 'ms-3', teamA: ['u03'], teamB: ['u05'], scoreA: [11, 9, 11], scoreB: [9, 11, 8], ago: 5 },
    { rawId: 'ms-4', teamA: ['u06'], teamB: ['u07'], scoreA: [11, 11], scoreB: [7, 6], ago: 5 },
    { rawId: 'ms-5', teamA: ['u03'], teamB: ['u07'], scoreA: [11, 11], scoreB: [9, 7], ago: 4 },
    { rawId: 'ms-6', teamA: ['u05'], teamB: ['u06'], scoreA: [10, 11, 9], scoreB: [12, 9, 11], ago: 4 },
    // 女单：u14 / u15 / u16
    { rawId: 'ws-1', teamA: ['u14'], teamB: ['u15'], scoreA: [11, 11], scoreB: [6, 8], ago: 3 },
    { rawId: 'ws-2', teamA: ['u15'], teamB: ['u16'], scoreA: [11, 9, 11], scoreB: [8, 11, 6], ago: 3 },
    // 双打
    { rawId: 'md-1', teamA: ['u03', 'u05'], teamB: ['u06', 'u07'], scoreA: [11, 11], scoreB: [9, 7], ago: 2 },
  ];
  return plan.map((item) => {
    const matchTime = new Date(now.getTime() - item.ago * DAY_MS);
    const record = builtRecordOf(buildMatchRecord({
      matchType: item.teamA.length === 2 ? MATCH_TYPE.DOUBLES : MATCH_TYPE.SINGLES,
      teamA: item.teamA, teamB: item.teamB, scoreA: item.scoreA, scoreB: item.scoreB,
      gamePoints: 11, bestOf: 3, matchTime, location: '民大体育馆', recorder: item.teamA[0],
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

/**
 * 民大匹克球协会的演示内容：公告 / 赛事 / 比赛各一批，绑定 muc + pkb。
 * 由 school-mock.reset() 默认挂进内存仓储，供协会空间与排行榜演示。
 *
 * @returns {{announcements: Array<Object>, events: Array<Object>, matches: Array<Object>}}
 */
function createSchoolDemoContent() {
  const scope = DEMO_CONTENT_SCOPE;
  const now = DEMO_CONTENT_NOW;
  return {
    announcements: demoAnnouncementDocs(scope, now),
    events: demoEventDocs(scope, now),
    matches: demoMatchDocs(scope, now),
  };
}

module.exports = { createSchoolSeed, createSchoolDemoSeed, createSchoolDemoContent };
