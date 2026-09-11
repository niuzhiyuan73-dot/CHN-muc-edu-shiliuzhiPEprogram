/**
 * 排行榜页的视图模型
 * ============================================================
 * 和 profile-view.js 同样的思路：取数、整形、算文案都放在这里，
 * 页面只负责渲染和交互。本模块不碰任何 wx API，可以在 Node 里测。
 *
 * 【两种榜】
 *   等级分榜  按等级分排序，谁强谁在前——这是「实力」的尺子
 *   进步榜    按赛季内涨幅排序——这是「成长」的尺子
 * 必须分成两个榜，不能合成一个。原因见 utils/leaderboard.js 里
 * 「进步榜」那段注释：等级分是零和的，总分恒定，「人人都进步」
 * 在这个体系里不可能发生。想表扬进步，只能换一把尺子。
 *
 * 【为什么在这里过滤掉没出过场的人】
 * getLeaderboard 返回的是项目内全体会员，包括一场没打的人（他们的分数
 * 是初始分，男 1500 / 女 1400）。直接展示会有一个问题：榜首下面挂着一排
 * 起点分的僵尸账号，
 * 榜就没法看了。所以展示层统一只保留出场数 > 0 的人。过滤后名次会出现
 * 空档（第 3 名被滤掉就成了 1、2、4），所以要重新编号。
 *
 * 至于「男会员出现在女单榜上」——那在数据层就已经由项目过滤解决了
 * （见 utils/leaderboard.js 的 selectProjectUsers），这里不必再管。
 * ============================================================
 */

const { RANK_PROJECT_LABEL, ALL_RANK_PROJECTS } = require('../utils/constants.js');
const { formatElo, formatSigned, formatPercent } = require('../utils/format.js');
const { getCurrentUser, getLeaderboard, getProgressLeaderboard } = require('./index.js');

/**
 * 榜单类型。
 * 命名成 BOARD 而不是 RANK_PERIOD，是为了和 constants.js 里的
 * 「总榜/周榜/月榜/赛季榜」区分开——那是时间范围，这是排序依据，
 * 两者将来可以叠加（比如「周榜 + 进步榜」）。
 */
const BOARD = {
  ELO: 'elo', // 等级分榜
  PROGRESS: 'progress', // 进步榜
};

const BOARD_LABEL = {
  [BOARD.ELO]: '等级分榜',
  [BOARD.PROGRESS]: '进步榜',
};

/** 榜单顺序，决定标签栏里哪个在前 */
const ALL_BOARDS = [BOARD.ELO, BOARD.PROGRESS];

/**
 * 进步榜的最低出场门槛，与 leaderboard.js 的默认值保持一致。
 * 这里重新声明一份是为了在「你还差几场」的提示里引用它。
 */
const PROGRESS_MIN_MATCHES = 5;

/** 前三名的奖牌样式，其余为空字符串（不额外装饰） */
const MEDALS = ['gold', 'silver', 'bronze'];

/**
 * 名次对应的奖牌。
 * @param {number} rank
 * @returns {string} 'gold' | 'silver' | 'bronze' | ''
 */
function medalOf(rank) {
  return MEDALS[rank - 1] || '';
}

/** 没有头像时用昵称首字占位 */
function avatarOf(nickName) {
  return (nickName || '?').slice(0, 1);
}

/**
 * 「定级中」「不活跃」这两个标记只在等级分榜上有意义：
 * 定级中说明分数还没收敛，不活跃说明分数是旧的。
 * 进步榜上没有这两种状态，因为上榜本身就要求打满场次。
 *
 * @param {string} status leaderboard.js 给出的状态
 * @returns {string} 徽章文案，无状态时返回空串
 */
function badgeOf(status) {
  if (status === 'provisional') return '定级中';
  if (status === 'inactive') return '不活跃';
  return '';
}

/**
 * 过滤掉没在该项目出过场的人，并重新编号。
 *
 * getLeaderboard 已经排好序了，过滤不会打乱相对顺序，
 * 所以这里只需按现有次序重新编 1..n 即可。
 *
 * @param {Array<Object>} board
 * @returns {Array<Object>}
 */
function rankProjectBoard(board) {
  return (Array.isArray(board) ? board : [])
    .filter((row) => (row.matchCount || 0) > 0)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * 把等级分榜的原始数据整形成页面上的一行。
 *
 * @param {Array<Object>} board rankProjectBoard 的结果
 * @param {string|null} myId 当前登录会员，用于高亮「我」那一行
 * @returns {Array<Object>}
 */
function buildEloRows(board, myId) {
  return board.map((row) => ({
    userId: row._id,
    rank: row.rank,
    medal: medalOf(row.rank),
    isMe: row._id === myId,
    nickName: row.nickName,
    avatarText: avatarOf(row.nickName),
    avatarUrl: row.avatarUrl || '',
    // 左侧副标题：战绩。胜率只在右侧小字里出现，避免一行塞三个数字
    detailText: `${row.wins} 胜 ${row.losses} 负`,
    // 统一成字符串：进步榜那边的主数字来自 formatSigned，本来就是字符串。
    // 两个榜的 valueText 类型一致，模板和调用方才不用分情况处理。
    valueText: String(formatElo(row.elo)),
    valueClass: '',
    noteText: `胜率 ${formatPercent(row.winRate)}`,
    badge: badgeOf(row.status),
  }));
}

/**
 * 把进步榜的原始数据整形成页面上的一行。
 *
 * 主数字用涨幅而不是当前分数：既然是进步榜，比的就是涨了多少，
 * 当前分数放在副标题里当背景（1500 → 1680 比单看 +180 更有画面感）。
 *
 * @param {Array<Object>} board buildProgressLeaderboard 的结果（已排序编号）
 * @param {string|null} myId
 * @returns {Array<Object>}
 */
function buildProgressRows(board, myId) {
  return board.map((row) => ({
    userId: row._id,
    rank: row.rank,
    medal: medalOf(row.rank),
    isMe: row._id === myId,
    nickName: row.nickName,
    avatarText: avatarOf(row.nickName),
    avatarUrl: row.avatarUrl || '',
    detailText: `${formatElo(row.startElo)} → ${formatElo(row.currentElo)}`,
    valueText: formatSigned(row.delta),
    valueClass: row.delta >= 0 ? 'is-up' : 'is-down',
    noteText: `${row.matchCount} 场`,
    badge: '',
  }));
}

/**
 * 归一化搜索词：去掉首尾空白，再转小写。
 *
 * 中文没有大小写，但昵称里可能夹着英文或字母（如「Leo」），
 * 统一转小写才能做到「搜 leo 也能找到 Leo」。
 *
 * @param {string} keyword
 * @returns {string} 归一化后的搜索词，空串表示不筛选
 */
function normalizeKeyword(keyword) {
  return String(keyword == null ? '' : keyword).trim().toLowerCase();
}

/**
 * 按昵称筛选榜单行。
 *
 * 【为什么只筛不重新编号】
 * 搜索不是重新排名。搜「张」时张三仍是第 8 名，不该因为前面的人被滤掉
 * 就变成第 1 名——那会让人误以为他的实力涨了。名次是榜单上的绝对坐标，
 * 搜索只决定「看不看得见」，不决定「排第几」。
 *
 * @param {Array<Object>} rows buildEloRows / buildProgressRows 的结果
 * @param {string} keyword 搜索词
 * @returns {Array<Object>} 命中的行，原顺序、原名次
 */
function filterRows(rows, keyword) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = normalizeKeyword(keyword);
  if (!needle) return list;
  return list.filter((row) => String(row.nickName || '').toLowerCase().includes(needle));
}

/**
 * 把筛选结果拼成页面要显示的字段。
 *
 * 页面上的搜索框每敲一个字都会调用它，所以它必须同步、且不碰数据源——
 * 绝不能每次输入都重新拉一遍榜单。
 *
 * @param {Array<Object>} allRows 未筛选的完整榜单行
 * @param {string} keyword 搜索词
 * @returns {Object} { keyword, rows, searching, countText, empty, emptyNote }
 */
function describeSearch(allRows, keyword) {
  const text = String(keyword == null ? '' : keyword).trim();
  const rows = filterRows(allRows, text);
  const searching = text !== '';
  const total = Array.isArray(allRows) ? allRows.length : 0;

  return {
    keyword: text,
    rows,
    searching,
    // 搜索时问的是「找到几个」，正常浏览问的是「几个上榜」，两种语境问法不同
    countText: searching ? `找到 ${rows.length} 人` : `${rows.length} 人上榜`,
    empty: rows.length === 0,
    emptyNote: searching
      ? `没有昵称含「${text}」的会员`
      : total === 0
      ? '这个项目还没有人打过'
      : '',
  };
}

/**
 * 装载排行榜页的全部数据。
 *
 * @param {Object} [options]
 * @param {string} [options.project] 榜单项目，非法或未传时退回第一个项目
 * @param {string} [options.board] 榜单类型，非法或未传时退回等级分榜
 * @returns {Promise<Object>}
 */
async function loadRankView(options = {}) {
  const activeProject = ALL_RANK_PROJECTS.includes(options.project)
    ? options.project
    : ALL_RANK_PROJECTS[0];
  const activeBoard = ALL_BOARDS.includes(options.board) ? options.board : BOARD.ELO;

  const me = await getCurrentUser();
  const myId = me ? me._id : null;

  let rows;
  if (activeBoard === BOARD.PROGRESS) {
    // buildProgressLeaderboard 内部已经过滤门槛并编好名次，直接用
    const board = await getProgressLeaderboard(activeProject, { minMatches: PROGRESS_MIN_MATCHES });
    rows = buildProgressRows(board, myId);
  } else {
    rows = buildEloRows(rankProjectBoard(await getLeaderboard(activeProject)), myId);
  }

  // 我的名次直接从展示的这份榜单里找，而不是另外调 getPercentile。
  // 后者算的是全体会员（含没打过的人），分母和榜上人数对不上，
  // 会出现「第 6 / 24」下面却只列了 20 个人的情况。
  //
  // 末尾的 || null 不能省：find() 找不到时返回 undefined，
  // 而下面几处判断写的是 === null，漏掉 undefined 会直接抛错。
  const myRow = (myId && rows.find((row) => row.isMe)) || null;

  // 空搜索词的筛选结果就是原榜。这里借它算出「N 人上榜」，是为了让
  // 计数文案与页面搜索时的「找到 N 人」出自同一处，不会各写各的。
  const unsearched = describeSearch(rows, '');

  return {
    projectTabs: ALL_RANK_PROJECTS.map((project) => ({
      project,
      label: RANK_PROJECT_LABEL[project],
      active: project === activeProject,
    })),
    boardTabs: ALL_BOARDS.map((board) => ({
      board,
      label: BOARD_LABEL[board],
      active: board === activeBoard,
    })),
    activeProject,
    activeProjectLabel: RANK_PROJECT_LABEL[activeProject],
    activeBoard,
    // 标题栏要显示「男单 · 等级分榜」，得给文案不是 key
    activeBoardLabel: BOARD_LABEL[activeBoard],
    rows: unsearched.rows,
    empty: unsearched.empty,
    playerCountText: unsearched.countText,
    emptyNote: unsearched.emptyNote,
    me:
      myRow === null
        ? null
        : {
            rank: myRow.rank,
            // 分母用上榜人数而不是全体会员：和第 6 / 20 名对得上
            total: rows.length,
            // 分母用总人数：第 1 名显示「超过 95%」比「超过 100%」更像人话
            beatText: `超过 ${formatPercent((rows.length - myRow.rank) / rows.length)} 的会员`,
          },
    // 自己不在榜上时给一句解释。空着会让人以为页面坏了
    meHint:
      myRow !== null
        ? ''
        : activeBoard === BOARD.PROGRESS
        ? `出场满 ${PROGRESS_MIN_MATCHES} 场就能上进步榜`
        : '你还没有参加过这个项目',
  };
}

module.exports = {
  BOARD,
  BOARD_LABEL,
  ALL_BOARDS,
  PROGRESS_MIN_MATCHES,
  medalOf,
  badgeOf,
  rankProjectBoard,
  buildEloRows,
  buildProgressRows,
  normalizeKeyword,
  filterRows,
  describeSearch,
  loadRankView,
};
