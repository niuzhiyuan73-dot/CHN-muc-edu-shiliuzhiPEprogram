/**
 * 学校维度的演示内容（仅用于本地模拟数据源）
 * ============================================================
 * 首页 / 排行榜 / 比赛这几页的数据本来是**跨协会聚合**的——那套数据属于民大
 * （多协会改造前唯一的那所学校），与学校无关。多校之后若切到别的学校还是这套，
 * 会让人以为「切了没反应」。这里为**模拟学校**（北航）造一份演示内容：切到北航
 * 即展示北航自己的公告、榜单与比赛，并整体处于只读浏览（不提供任何写入口）。
 *
 * 【为什么真学校不在这里造数据】
 * 民大展示的就是应用本身的数据（聚合视图），不是演示。各 accessor 对其返回
 * null，调用方回落到真实视图——「本校看真实数据、外校看演示」这条口径才清楚。
 *
 * 【为什么是纯静态】
 * 北航是测试样本（seed 里标了 simulated），没有真实数据源。几组示例内容写在
 * 这里，免得为了假数据去动集合与协议。它不碰 wx、不碰 I/O，是纯计算模块；
 * 当前浏览的是哪所学校由调用方（页面）传入，本模块不自己读会话。
 * ============================================================
 */

const { ALL_RANK_PROJECTS, RANK_PROJECT_LABEL } = require('../utils/constants.js');

/** 榜单标题里的名字，与 rank-view 保持一致 */
const BOARD_LABEL = '等级分榜';
/** 榜单最多展示多少名，与 rank-view 保持一致 */
const TOP_LIMIT = 10;
/** 前三名的奖牌样式 */
const MEDALS = ['gold', 'silver', 'bronze'];

/**
 * 模拟学校的演示数据。
 * key 是 schoolId；只有在这里登记过的学校才会进入「外校只读浏览」的分支。
 *
 * rank[项目] 里的一行是「榜面字段」，rank 行/avatar/名次由 schoolRank 统一补；
 * matches 里的一行已经是 buildRecordRow 的产出口径，权限位一律置假（只读）。
 */
const DEMO_SCHOOLS = {
  buaa: {
    shortName: '北航',
    glyph: '航',

    home: {
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

    rank: {
      men_singles: [
        { nickName: '李昊', realName: '李昊然', record: '14 胜 2 负', elo: '1712', winRate: '88%', status: '' },
        { nickName: '陈子恒', realName: '陈子恒', record: '11 胜 4 负', elo: '1668', winRate: '73%', status: '' },
        { nickName: '王岩', realName: '王岩', record: '10 胜 5 负', elo: '1642', winRate: '67%', status: '' },
        { nickName: '赵一鸣', realName: '赵一鸣', record: '8 胜 6 负', elo: '1601', winRate: '57%', status: 'provisional' },
        { nickName: '孙睿', realName: '孙睿', record: '7 胜 7 负', elo: '1577', winRate: '50%', status: '' },
        { nickName: '周子墨', realName: '周子墨', record: '5 胜 9 负', elo: '1520', winRate: '36%', status: 'inactive' },
      ],
      women_singles: [
        { nickName: '林晓', realName: '林晓', record: '13 胜 1 负', elo: '1698', winRate: '93%', status: '' },
        { nickName: '周雨桐', realName: '周雨桐', record: '10 胜 4 负', elo: '1650', winRate: '71%', status: '' },
        { nickName: '吴桐', realName: '吴桐', record: '8 胜 5 负', elo: '1612', winRate: '62%', status: 'provisional' },
        { nickName: '许晴', realName: '许晴', record: '6 胜 8 负', elo: '1556', winRate: '43%', status: '' },
      ],
      doubles: [
        { nickName: '李昊 / 王岩', realName: '', record: '16 胜 3 负', elo: '1740', winRate: '84%', status: '' },
        { nickName: '陈子恒 / 孙睿', realName: '', record: '12 胜 5 负', elo: '1689', winRate: '71%', status: '' },
        { nickName: '林晓 / 周雨桐', realName: '', record: '9 胜 6 负', elo: '1631', winRate: '60%', status: '' },
      ],
    },

    matches: [
      { matchId: 'buaa_m1', typeLabel: '男单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-12 19:30',
        locationText: '学院路体育馆 3 号场', teamAText: '李昊', teamBText: '王岩', winnerSide: 'A',
        scoreText: '11:7 11:9', statusLabel: '已生效', statusClass: 'is-active' },
      { matchId: 'buaa_m2', typeLabel: '女单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-12 20:10',
        locationText: '学院路体育馆 3 号场', teamAText: '林晓', teamBText: '周雨桐', winnerSide: 'A',
        scoreText: '9:11 11:6 11:8', statusLabel: '已生效', statusClass: 'is-active' },
      { matchId: 'buaa_m3', typeLabel: '双打', formatText: '11 分制 · 三局两胜', dateText: '2026-10-10 18:00',
        locationText: '沙河校区球场', teamAText: '李昊、王岩', teamBText: '陈子恒、孙睿', winnerSide: 'B',
        scoreText: '11:13 9:11', statusLabel: '已生效', statusClass: 'is-active' },
      { matchId: 'buaa_m4', typeLabel: '男单', formatText: '11 分制 · 三局两胜', dateText: '2026-10-08 19:00',
        locationText: '学院路体育馆 1 号场', teamAText: '赵一鸣', teamBText: '孙睿', winnerSide: '',
        scoreText: '', statusLabel: '待确认', statusClass: 'is-pending' },
    ],
  },
};

/** 状态 → 徽章文案，与 rank-view.badgeOf 同口径 */
function badgeText(status) {
  if (status === 'provisional') return '定级中';
  if (status === 'inactive') return '不活跃';
  return '';
}

/** 昵称首字占位头像 */
function avatarOf(nickName) {
  return (nickName || '?').slice(0, 1);
}

/** 该校是否有演示内容。页面据此决定是走演示视图还是回落到真实视图 */
function hasSchoolDemo(schoolId) {
  return Boolean(DEMO_SCHOOLS[schoolId]);
}

/** 演示学校里的一行榜面数据 → 页面渲染行 */
function rankRowOf(schoolId, project, entry, index) {
  const rank = index + 1;
  return {
    // 演示选手没有真实账号，编号只用于 wx:key，点了不跳转（页面会拦住）
    userId: `demo_${schoolId}_${project}_${rank}`,
    rank,
    medal: MEDALS[rank - 1] || '',
    isMe: false,
    nickName: entry.nickName,
    realName: entry.realName || '',
    avatarText: avatarOf(entry.nickName),
    avatarUrl: '',
    detailText: entry.record,
    valueText: String(entry.elo),
    valueClass: '',
    noteText: `胜率 ${entry.winRate}`,
    badge: badgeText(entry.status),
  };
}

/**
 * 取某校的首页演示视图。没有演示内容的学校返回 null，由调用方回落到聚合视图。
 *
 * @param {string} schoolId
 * @returns {{loggedIn: boolean, announcements: Object, upcomingEvents: Array, summary: Object}|null}
 */
function schoolHome(schoolId) {
  const school = DEMO_SCHOOLS[schoolId];
  if (!school || !school.home) return null;
  const feed = school.home;
  // 每条都贴上所属学校，首页卡片上的角标便能显示成「航 北航」而不是空
  const chip = { association: schoolId, associationName: school.shortName, associationGlyph: school.glyph };
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

/**
 * 取某校的排行榜演示视图。形状与 rank-view.loadRankView 一致，但没有「我」
 * ——浏览者不是该校会员，me 恒为 null，页面据此出只读口径。
 *
 * @param {string} schoolId
 * @param {Object} [options]
 * @param {string} [options.project] 榜单项目，非法或未传时退回第一个项目
 * @returns {Object|null}
 */
function schoolRank(schoolId, options = {}) {
  const school = DEMO_SCHOOLS[schoolId];
  if (!school || !school.rank) return null;

  const activeProject = ALL_RANK_PROJECTS.includes(options.project) ? options.project : ALL_RANK_PROJECTS[0];
  const fullBoard = (school.rank[activeProject] || []).map((entry, index) =>
    rankRowOf(schoolId, activeProject, entry, index)
  );
  const rows = fullBoard.slice(0, TOP_LIMIT);
  const total = fullBoard.length;

  return {
    schoolName: school.shortName,
    projectTabs: ALL_RANK_PROJECTS.map((project) => ({
      project,
      label: RANK_PROJECT_LABEL[project],
      active: project === activeProject,
    })),
    activeProject,
    activeProjectLabel: RANK_PROJECT_LABEL[activeProject],
    activeBoardLabel: BOARD_LABEL,
    rows,
    allRows: fullBoard,
    total,
    hasMore: total > rows.length,
    empty: rows.length === 0,
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: rows.length === 0 ? '这个项目还没有人打过' : '',
    me: null,
    meHint: `${school.shortName}的榜单仅作演示浏览`,
  };
}

/**
 * 演示比赛行：在演示数据之上补齐 buildRecordRow 那套字段，权限位一律置假，
 * 于是页面上不会出现任何「确认 / 撤销 / 录分 / 指派」入口。
 */
function matchRowOf(school, entry) {
  const asList = (text) => (text ? text.split('、').map((name, i) => ({ userId: `demo_${i}_${name}`, nickName: name })) : []);
  return {
    matchId: entry.matchId,
    typeLabel: entry.typeLabel,
    formatText: entry.formatText,
    dateText: entry.dateText,
    locationText: entry.locationText,
    courtText: '',
    teamAText: entry.teamAText,
    teamBText: entry.teamBText,
    teamAList: asList(entry.teamAText),
    teamBList: asList(entry.teamBText),
    winnerSide: entry.winnerSide,
    scoreText: entry.scoreText,
    live: null,
    liveActive: false,
    isMine: false,
    isWin: false,
    resultText: '',
    isEvent: true,
    status: entry.status,
    statusLabel: entry.statusLabel,
    statusClass: entry.statusClass,
    statusReason: '',
    action: '',
    // 只读：所有写入口一律关闭
    canConfirm: false,
    confirmRelaxed: false,
    needsScore: false,
    canRecord: false,
    canRevoke: false,
    canForfeit: false,
    hasReferee: false,
    referee: '',
    refereeName: '',
    refereeIsParticipant: false,
    refereeNotice: '',
    canAssignReferee: false,
  };
}

/**
 * 取某校的比赛页演示视图。形状与 match-view.loadMatchView 一致：只有一排
 * 「全部比赛」标签（浏览者不是该校会员，没有「我的比赛」可言），且全部只读。
 *
 * @param {string} schoolId
 * @param {Object} [options]
 * @param {boolean} [options.loggedIn] 浏览者是否已登录，仅用于视角提示
 * @returns {Object|null}
 */
function schoolMatches(schoolId, options = {}) {
  const school = DEMO_SCHOOLS[schoolId];
  if (!school || !school.matches) return null;

  const records = school.matches.map((entry) => matchRowOf(school, entry));
  return {
    schoolName: school.shortName,
    found: true,
    readOnly: true,
    viewer: { userId: '', roleLabel: '访客', loggedIn: Boolean(options.loggedIn) },
    tabs: [{ tab: 'mine', label: '全部比赛', active: true }],
    activeTab: 'mine',
    records,
    total: records.length,
    hasMore: false,
    emptyText: '',
    needLogin: false,
    pendingCount: 0,
    demoNotice: `${school.shortName}的比赛记录仅作演示浏览，不能在这里确认或撤销`,
  };
}

module.exports = { hasSchoolDemo, schoolHome, schoolRank, schoolMatches };
