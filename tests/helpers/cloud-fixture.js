/**
 * 云函数测试夹具（仅测试用）
 * ============================================================
 * 一套小而确定的数据：五位正式会员（含一位管理员、两位女会员）、一位
 * 待审核申请人、四场已生效的比赛、一条赛事、三条公告（含一条已下架）。
 *
 * 【为什么不用 mock 的种子数据】
 * mock 每次生成六百多场随机比赛，断言只能写成「大于零」这类含糊的话；
 * 而且它自带缓存与本地写入台账，测起来要不停地 reset。真正要盯住的是
 * 「云端的筛选、排序、权限口径对不对」，用一个能一眼算清的夹具最省事。
 *
 * 【为什么四个人打来打去】
 * u01/u02 是男会员，u03/u04 是女会员。这样男单榜、女单榜、双打榜都
 * 有人有分，男女单打共用一个池这件事也能在断言里看出来。
 * ============================================================
 */

const { createMemoryRepo } = require('./memory-repo.js');
const { buildContext } = require('../../cloudfunctions/data/src/core/context.js');
const {
  ROLE,
  USER_STATUS,
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  RATING_POOL,
  ANNOUNCEMENT_STATUS,
} = require('../../miniprogram/utils/constants.js');

/** 固定「现在」，让所有与时间有关的判断都能复现 */
const NOW = new Date('2026-06-01T12:00:00');
/** 赛季首场，也是所有人入会的日子——于是没有人是「中途入会者」 */
const SEASON_START = '2026-04-08T18:00:00';
const JOIN_DATE = '2026-04-01T00:00:00';

function account(id, openId, nickName, gender, role, patch = {}) {
  return {
    _id: id,
    openId,
    nickName,
    avatarUrl: '',
    realName: nickName,
    studentId: '2026000000',
    college: '体育学院',
    phone: '13800000000',
    points: 0,
    role,
    // 性别决定初始分（男 1450 / 女 1300），也决定男女单打榜的归属
    gender,
    status: USER_STATUS.ACTIVE,
    joinDate: JOIN_DATE,
    ratings: {},
    ...patch,
  };
}

const USERS = [
  account('u_admin', 'openid-admin', '管理员', 'M', ROLE.ADMIN),
  account('u01', 'openid-u01', '甲', 'M', ROLE.MEMBER),
  account('u02', 'openid-u02', '乙', 'M', ROLE.MEMBER),
  account('u03', 'openid-u03', '丙', 'F', ROLE.MEMBER),
  account('u04', 'openid-u04', '丁', 'F', ROLE.MEMBER),
  account('u_pending', 'openid-pending', '待审', 'M', ROLE.MEMBER, {
    status: USER_STATUS.PENDING,
    joinDate: '2026-05-20T00:00:00',
  }),
];

/**
 * 造一条已生效的比赛。winner 直接写明，省得在夹具里再算一遍局分。
 */
function activeMatch(id, matchType, teamA, teamB, winner, matchTime, scoreA, scoreB) {
  return {
    _id: id,
    matchType,
    pool: MATCH_TYPE_TO_POOL[matchType],
    teamA,
    teamB,
    scoreA,
    scoreB,
    gamePoints: 11,
    bestOf: 1,
    winner,
    location: '',
    matchTime,
    recorder: teamA[0],
    eventId: null,
    status: MATCH_STATUS.ACTIVE,
  };
}

const MATCHES = [
  activeMatch('m1', MATCH_TYPE.SINGLES, ['u01'], ['u02'], 'A', '2026-04-08T18:00:00', [11], [9]),
  activeMatch('m2', MATCH_TYPE.SINGLES, ['u03'], ['u04'], 'A', '2026-04-09T18:00:00', [11], [7]),
  activeMatch(
    'm3',
    MATCH_TYPE.DOUBLES,
    ['u01', 'u02'],
    ['u03', 'u04'],
    'A',
    '2026-04-10T18:00:00',
    [11],
    [5]
  ),
  activeMatch('m4', MATCH_TYPE.SINGLES, ['u02'], ['u01'], 'A', '2026-04-11T18:00:00', [11], [8]),
];

const EVENTS = [
  {
    _id: 'ev1',
    title: '春季联赛',
    matchType: MATCH_TYPE.SINGLES,
    pool: RATING_POOL.SINGLES,
    location: '体育馆',
    startTime: '2026-04-15T09:00:00',
    // 赛事积分只认「已结束」的赛事（决策 9 / §2.5），没有这个状态就一分不发
    status: EVENT_STATUS.FINISHED,
    results: [
      { userId: 'u01', placement: 1 },
      { userId: 'u02', placement: 2 },
    ],
  },
];

const ANNOUNCEMENTS = [
  {
    _id: 'a1',
    title: '招新通知',
    content: '本周六开始招新。',
    category: '通知',
    pinned: true,
    publishTime: '2026-04-20T10:00:00',
    publisherId: 'u_admin',
    publisherName: '管理员',
    status: ANNOUNCEMENT_STATUS.PUBLISHED,
  },
  {
    _id: 'a2',
    title: '比赛战报',
    content: '甲连胜两场。',
    category: '战报',
    pinned: false,
    publishTime: '2026-04-25T10:00:00',
    publisherId: 'u_admin',
    publisherName: '管理员',
    status: ANNOUNCEMENT_STATUS.PUBLISHED,
  },
  {
    _id: 'a3',
    title: '已下架的通知',
    content: '这条不该出现在公开列表里。',
    category: '通知',
    pinned: false,
    publishTime: '2026-04-10T10:00:00',
    publisherId: 'u_admin',
    publisherName: '管理员',
    status: ANNOUNCEMENT_STATUS.ARCHIVED,
  },
];

/** 一份可直接喂给 createMemoryRepo 的种子 */
function seed(overrides = {}) {
  return {
    users: USERS,
    matches: MATCHES,
    events: EVENTS,
    announcements: ANNOUNCEMENTS,
    ...overrides,
  };
}

/** 建一个装好夹具的仓储 */
function createFixtureRepo(overrides) {
  return createMemoryRepo(seed(overrides));
}

/**
 * 造一份调用上下文。
 *
 * @param {Object} repo
 * @param {string|null} openId 传 null 表示未登录（查不到账号）
 * @param {Date} [now]
 * @param {string} [association] 协会 id；缺省走兜底协会（pkb）
 */
function contextFor(repo, openId, now = NOW, association = '') {
  return buildContext({ repo, openId: openId || '', now, association });
}

module.exports = {
  NOW,
  SEASON_START,
  JOIN_DATE,
  USERS,
  MATCHES,
  EVENTS,
  ANNOUNCEMENTS,
  seed,
  createFixtureRepo,
  contextFor,
};
