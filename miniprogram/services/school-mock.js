const { createSchoolDemoSeed, createSchoolDemoContent } = require('./school-seed.js');
const { createSchoolMemoryRepo } = require('./school-memory-repo.js');
const { createSchoolHandlers } = require('./school-membership-service.js');
const { buildSchoolContext } = require('./school-context.js');
const {
  LEGACY_SCHOOL_ID, schoolScope, schoolKey,
  schoolMemberKey, schoolRoleKey, schoolMembershipKey, ratingKey,
} = require('../utils/school.js');
const { ROLE, COLLEGES } = require('../utils/constants.js');
const { MEMBER_SEED, ASSOC_ROLE_SEED } = require('./seed.js');
const exchange = require('./exchange-service.js');
const groupService = require('./association-group-service.js');
const memberService = require('./association-member-service.js');
const noticeService = require('./association-notice-service.js');
const trainingService = require('./association-training-service.js');
const eventService = require('./school-event-service.js');
const matchService = require('./school-match-service.js');
const liveService = require('./school-live-service.js');
const collegeService = require('./school-college-service.js');
const announcementService = require('./school-announcement-service.js');
const schoolMemberService = require('./school-member-service.js');
const rankService = require('./school-rank-service.js');

/** 协会空间处理器集合（仅函数；STATUS 常量等非函数条目不参与分发） */
const spaceHandlers = Object.freeze(Object.fromEntries(
  Object.entries({ ...groupService, ...memberService, ...noticeService, ...trainingService,
    ...eventService, ...matchService, ...liveService, ...collegeService, ...announcementService,
    ...schoolMemberService, ...rankService })
    .filter(([, value]) => typeof value === 'function')));

const DEMO_ACTORS = Object.freeze([
  { id: 'demo_applicant', label: '模拟申请人' },
  { id: 'demo_muc_admin', label: '民大校管理员' },
  { id: 'demo_buaa_admin', label: '北航校管理员' },
  { id: 'demo_muc_member', label: '民大会员' },
  { id: 'demo_buaa_member', label: '北航会员' },
  // 平台管理员排在最后，以免挪动既有演示身份的下标（页面与用例都按下标选择）。
  { id: 'demo_platform_admin', label: '平台管理员' },
  // 学院负责人（民大 c02）：演示「只替本学院交名单 / 排阵」的边界，同样追加在末尾。
  { id: 'demo_muc_college_leader', label: '民大学院负责人' },
]);

/**
 * 把旧版演示账号（u01–u24）接进学校维度。
 *
 * 【为什么需要】
 * 旧版账号（`seed.js`）只在 mock.js 那一套台账里存在；学校维度的页面
 * （协会空间 / 学校身份）与它们互不相识，演示时必须先去「学校身份」页换成
 * 一个 S2 体验身份（demo_muc_admin 之类）才能进协会空间。这里把这批账号
 * 一次性登记成**民大**的在册会员，于是改 `mock.js` 的
 * DEFAULT_CURRENT_USER_ID 就能直接换演示身份，不必再切体验身份。
 *
 * 角色与旧版对齐：
 *   · u01 是旧版全局管理员 → 在民大落成校管理员（schoolRole admin）；
 *   · ASSOC_ROLE_SEED 登记的各协会负责人 / 学院负责人 → 落成对应协会的
 *     membership（leader / staff）；u02 的学院负责人身份只在默认协会 pkb 成立。
 *
 * @param {Object} seed createSchoolDemoSeed() 产出的种子（会被就地补写）
 */
function attachLegacyMembers(seed) {
  const collegeIdOf = new Map(COLLEGES.map((name, index) => [name, `c${String(index + 1).padStart(2, '0')}`]));
  const legacy = MEMBER_SEED.map((item, index) => ({ item, userId: `u${String(index + 1).padStart(2, '0')}` }));
  seed.users = seed.users.concat(legacy.map(({ item, userId }) => ({
    _id: userId, openId: `mock_openid_${userId}`, nickName: item.nickName, realName: item.realName,
    gender: item.gender || '', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: LEGACY_SCHOOL_ID, simulated: true,
  })));
  seed.schoolMembers = seed.schoolMembers.concat(legacy.map(({ item, userId }, index) => ({
    _id: schoolMemberKey(userId, LEGACY_SCHOOL_ID), userId, schoolId: LEGACY_SCHOOL_ID,
    collegeId: collegeIdOf.get(item.college) || '', studentId: '2023' + String(index + 1).padStart(4, '0'),
    status: 'active', simulated: true,
  })));
  seed.schoolRoles = seed.schoolRoles.concat([{
    _id: schoolRoleKey('u01', LEGACY_SCHOOL_ID), userId: 'u01', schoolId: LEGACY_SCHOOL_ID,
    role: 'admin', status: 'active', simulated: true,
  }]);
  const memberships = [];
  for (const [association, roles] of Object.entries(ASSOC_ROLE_SEED)) {
    for (const [userId, role] of Object.entries(roles)) {
      memberships.push({
        _id: schoolMembershipKey(userId, { schoolId: LEGACY_SCHOOL_ID, association }),
        userId, schoolId: LEGACY_SCHOOL_ID, association,
        role: role === ROLE.ADMIN ? 'leader' : 'staff', status: 'active', simulated: true,
      });
    }
  }
  // u02 的学院负责人身份只在默认协会（pkb）成立，与旧版 scopeSeedRoles 同口径。
  memberships.push({
    _id: schoolMembershipKey('u02', { schoolId: LEGACY_SCHOOL_ID, association: 'pkb' }),
    userId: 'u02', schoolId: LEGACY_SCHOOL_ID, association: 'pkb',
    role: 'staff', status: 'active', simulated: true,
  });
  seed.memberships = seed.memberships.concat(memberships);
  seed.memberRatings = seed.memberRatings.concat(legacy.map(({ userId }) => ({
    _id: ratingKey(userId, { schoolId: LEGACY_SCHOOL_ID, association: 'pkb' }),
    userId, schoolId: LEGACY_SCHOOL_ID, association: 'pkb',
    initialElo: null, currentElo: { singles: [], doubles: [] },
  })));
}

/**
 * 学校维度的默认演示身份：跟随旧版 `mock.js` 的 DEFAULT_CURRENT_USER_ID。
 * 从前这里默认是 S2 的「普通访客」demo_applicant（无学校归属），演示
 * u01–u24 时协会空间会被判成无权限；旧版账号接入学校维度后，身份直接由
 * mock.js 那一个常量决定，改编号即换人。
 */
function defaultActorId() {
  return require('./mock.js').DEFAULT_CURRENT_USER_ID;
}

let actorId = DEMO_ACTORS[0].id;
/**
 * 模拟的「当前微信身份」OpenID（B3）。真实设备上 OpenID 由微信给出，换设备即换
 * OpenID；模拟端把它做成一个可变状态：默认空串，客户端按 actorId 解析（与从前
 * 行为一致）。`simulateNewWechat` 把它拨到一个尚无账号的新 OpenID，从而演示
 * 「新微信号注册 → 开通平台账号 → 申请学校身份」的完整链路——这是旧栈
 * `registerMember` 的 S2 对应路径。
 */
let wechatOpenId = '';
let repo;
const handlers = createSchoolHandlers({ claimKey: (schoolId, studentId) => schoolKey('demo-claim', schoolId, studentId) });
/**
 * 重置学校维度内存仓储。
 *
 * 默认连同**民大匹克球协会的演示内容**（公告 / 赛事 / 比赛）一起挂上，协会
 * 空间与排行榜一进去就有东西可看。需要干净台账的用例（如公告页夹具要先自己
 * 摆几条再数条数）传 `{ withDemoContent: false }` 关掉——演示内容与业务数据
 * 混在一起数，会让「一共几条」这类断言随演示内容的多寡漂移。
 *
 * @param {Object} [options]
 * @param {boolean} [options.withDemoContent=true] 是否挂演示内容
 */
function reset(options = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_applicant', openId: 'mock_openid_applicant', nickName: '模拟申请人',
    platformStatus: 'active', platformRole: 'member', simulated: true });
  // 平台管理员：账号级身份，可跨校读、跨校指定权限；不带 primarySchoolId，不占某校身份。
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin', nickName: '平台管理员',
    platformStatus: 'active', platformRole: 'admin', simulated: true });
  // 学院负责人演示身份：民大 c02（民族学与社会学学院）在册会员 + pkb 的 staff 角色。
  // 旧种子里的 staff 身份（ASSOC_ROLE_SEED / u02）都不带 collegeId，推导后只算普通会员；
  // 这一个显式落 collegeId，才能演示「只替本学院交名单 / 排阵」的边界。
  //
  // 【为什么落在 c02 而不是演示账号扎堆的 c01】
  // c01（中华民族共同体学院）只有三个演示账号，且都没写性别；学院赛排阵要按小项
  // 性别筛人（男单只列男队员），落在 c01 会一所学院也排不出阵。c02 有 u10（男）与
  // u24（女）各一名，正好能把「本学院交名单 → 排阵（男单 + 女单）→ 提交」整条链
  // 演示通。学院负责人是「某校某学院某协会」的身份，学校身份、会员记录与协会
  // membership 三处的 collegeId 必须一致（下列三行同落 'c02'）。
  seed.users.push({ _id: 'demo_muc_college_leader', openId: 'mock_openid_college_leader',
    nickName: '学院负责人', platformStatus: 'active', platformRole: 'member',
    primarySchoolId: LEGACY_SCHOOL_ID, simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_college_leader', LEGACY_SCHOOL_ID),
    userId: 'demo_muc_college_leader', schoolId: LEGACY_SCHOOL_ID, collegeId: 'c02',
    studentId: 'demo-college-leader', status: 'active', simulated: true });
  seed.memberships.push({ _id: schoolMembershipKey('demo_muc_college_leader', { schoolId: LEGACY_SCHOOL_ID, association: 'pkb' }),
    userId: 'demo_muc_college_leader', schoolId: LEGACY_SCHOOL_ID, association: 'pkb',
    role: 'staff', collegeId: 'c02', status: 'active', simulated: true });
  attachLegacyMembers(seed);
  if (options.withDemoContent !== false) {
    const content = createSchoolDemoContent();
    for (const key of Object.keys(content)) seed[key] = (seed[key] || []).concat(content[key]);
  }
  repo = createSchoolMemoryRepo(seed);
  actorId = defaultActorId();
  wechatOpenId = '';
}
reset();
/** 旧版演示账号编号（u01–u24）也已接入 S2，可作演示身份切换（B3）。 */
const LEGACY_ACTOR_IDS = Object.freeze(MEMBER_SEED.map((_, index) => `u${String(index + 1).padStart(2, '0')}`));
const isValidActor = (id) => DEMO_ACTORS.some((actor) => actor.id === id) || LEGACY_ACTOR_IDS.includes(id);

function setDemoActor(id) {
  if (!isValidActor(id)) throw new Error('未知模拟身份');
  actorId = id;
  // 演示身份与微信身份只认一个：切回 actor 演示时清掉「新微信号」模拟，
  // 否则两个身份来源并存，写接口与展示会各认一个人。
  wechatOpenId = '';
}
/**
 * 模拟一台「换了新微信号」的设备：把当前微信身份拨到一个尚无账号的 OpenID。
 * 之后身份 / 空间 / 交流客户端都按这个 OpenID 解析（actorId 清空），注册走
 * `registerSchoolAccount` 凭 OpenID 开户，与云端语义一致。
 * @param {string} [openId] 指定 OpenID（测试用）；缺省生成一个不重复的
 * @returns {string} 生效的模拟 OpenID
 */
function simulateNewWechat(openId) {
  wechatOpenId = typeof openId === 'string' && openId ? openId
    : `mock_openid_new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  actorId = '';
  return wechatOpenId;
}
/**
 * 创建身份客户端时绑定的解析入口：有模拟微信身份就按 OpenID（新设备），
 * 否则按演示 actorId（既有演示账号）。两者在同一处收敛，避免身份 / 空间 /
 * 交流三套客户端各认一个人。
 */
function actorBinding() {
  return wechatOpenId ? { actorId: '', openId: wechatOpenId } : { actorId, openId: '' };
}
function forSchoolIdentity(input) {
  const scope = schoolScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, ...binding, scope });
    const result = await handler(payload || {}, ctx);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  }])));
}
module.exports = { forSchoolIdentity, setDemoActor, getDemoActor: () => actorId, simulateNewWechat, DEMO_ACTORS, reset };
function forExchange(input) {
  const target = schoolScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(exchange).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, ...binding, scope: target });
    return (await handler(payload || {}, ctx)).data;
  }])));
}
module.exports.forExchange = forExchange;

function forAssociationSpace(input) {
  const target = schoolScope(input);
  const binding = actorBinding();
  const boundRepo = repo;
  return Object.freeze(Object.fromEntries(Object.entries(spaceHandlers).map(([name, handler]) => [name, async payload => {
    const ctx = await buildSchoolContext({ repo: boundRepo, ...binding, scope: target });
    // isMock 供比赛「对手确认」等口径在本地演示时放宽（见 school-match-service）。
    return (await handler(payload || {}, Object.freeze({ ...ctx, isMock: true }))).data;
  }])));
}
module.exports.forAssociationSpace = forAssociationSpace;
