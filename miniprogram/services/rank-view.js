/**
 * 排行榜页的视图模型
 * ============================================================
 * 和 profile-view.js 同样的思路：取数、整形、算文案都放在这里，
 * 页面只负责渲染和交互。本模块不碰任何 wx API，可以在 Node 里测。
 *
 * 【为什么只剩等级分榜】
 * 曾经并列过「进步榜」（按赛季内涨幅排序）。界面精简后只留一把尺子：
 * 等级分榜。涨幅那套依赖「零和的等级分」这个前提（见 utils/leaderboard.js
 * 里进步榜那段注释），对普通会员来说理解成本高于它带来的信息。
 * getProgressLeaderboard 仍在数据层保留，只是排行榜页不再用它。
 *
 * 【为什么只展示前 10 名】
 * 榜单是给人一个「谁最强」的印象，不是完整名册。六百多场堆出来的一长串
 * 名字没人会翻到底，前十足够。但**「我的排名」卡不能被截断**——一个排第
 * 20 的人如果既不在列表里、又拿不到自己的名次，这个页面就对他毫无用处。
 * 所以名次始终在**完整榜单**上算，前 10 只是显示层的截断。
 *
 * 【为什么在这里过滤掉没出过场的人】
 * getLeaderboard 返回的是项目内全体会员，包括一场没打的人（他们的分数
 * 是初始分，男 1450 / 女 1300）。直接展示会有一个问题：榜首下面挂着一排
 * 起点分的僵尸账号，
 * 榜就没法看了。所以展示层统一只保留出场数 > 0 的人。过滤后名次会出现
 * 空档（第 3 名被滤掉就成了 1、2、4），所以要重新编号。
 *
 * 至于「男会员出现在女单榜上」——那在数据层就已经由项目过滤解决了
 * （见 utils/leaderboard.js 的 selectProjectUsers），这里不必再管。
 * ============================================================
 */

const { RANK_PROJECT_LABEL, ALL_RANK_PROJECTS } = require('../utils/constants.js');
const { formatElo, formatPercent } = require('../utils/format.js');
const { getCurrentUser, getLeaderboard, getMembers } = require('./index.js');

/** 榜单标题里的名字。只剩等级分这一把尺子，不再是可切换的维度 */
const BOARD_LABEL = '等级分榜';

/**
 * 等级榜最多展示多少名。
 * 写死而不是做成配置：这是「界面精简」定下的口径，不是一个可调参数。
 */
const TOP_LIMIT = 10;

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
 * 「定级中」「不活跃」这两个标记在等级分榜上有意义：
 * 定级中说明分数还没收敛，不活跃说明分数是旧的。
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
    // 只参与搜索，不渲染。页面上显示的一律是昵称
    realName: row.realName || '',
    avatarText: avatarOf(row.nickName),
    avatarUrl: row.avatarUrl || '',
    // 左侧副标题：战绩。胜率只在右侧小字里出现，避免一行塞三个数字
    detailText: `${row.wins} 胜 ${row.losses} 负`,
    valueText: String(formatElo(row.elo)),
    valueClass: '',
    noteText: `胜率 ${formatPercent(row.winRate)}`,
    badge: badgeOf(row.status),
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
 * 按名字筛选榜单行：昵称与真实姓名都参与匹配。
 *
 * 【为什么两个名字都要看】
 * 榜单上显示的是昵称，但昵称是各人自己起的，往往只用了名字的一部分
 * （真实姓名「赵明宇」，昵称可能就叫「明宇」）。只按昵称搜，输入「赵」
 * 就找不到这个人——可用户脑子里想的正是真名。两个都匹配，才能做到
 * 「输入赵或明宇都能找到同一个人」。命中后显示的仍是昵称，真实姓名
 * 只作为搜索依据，不上榜面。
 *
 * 【为什么只筛不重新编号】
 * 搜索不是重新排名。搜「张」时张三仍是第 8 名，不该因为前面的人被滤掉
 * 就变成第 1 名——那会让人误以为他的实力涨了。名次是榜单上的绝对坐标，
 * 搜索只决定「看不看得见」，不决定「排第几」。
 *
 * 【搜索范围是全量，展示默认只给前 10】
 * 列表默认截断到前 10 是为了精简，但「想找某个人」是另一回事：排行榜
 * 页面的搜索框就是为了定位到具体的人，只在前 10 里搜等于查不到大多数人。
 * 所以页面搜索时喂进来的是 allRows（完整榜单），默认展示的才是 rows。
 *
 * @param {Array<Object>} rows 待筛选的榜单行（页面搜索时传完整榜单）
 * @param {string} keyword 搜索词
 * @returns {Array<Object>} 命中的行，原顺序、原名次
 */
function filterRows(rows, keyword) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = normalizeKeyword(keyword);
  if (!needle) return list;
  return list.filter((row) =>
    [row.nickName, row.realName].some((name) =>
      String(name || '').toLowerCase().includes(needle)
    )
  );
}

/**
 * 把筛选结果拼成页面要显示的字段。
 *
 * 页面上的搜索框每敲一个字都会调用它，所以它必须同步、且不碰数据源——
 * 绝不能每次输入都重新拉一遍榜单。
 *
 * @param {Array<Object>} allRows 待筛选的榜单行（搜索时给完整榜单）
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
      ? `没有名字含「${text}」的会员`
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
 * @returns {Promise<Object>}
 */
async function loadRankView(options = {}) {
  const activeProject = ALL_RANK_PROJECTS.includes(options.project)
    ? options.project
    : ALL_RANK_PROJECTS[0];

  // 真实姓名取自会员名单，而不是榜单本身。榜单行的投影刻意只留展示字段
  //（见 leaderboard.extractPoolStats 与 pool-leaderboard.test.js 的隐私用例），
  // 但昵称常只是真名的一部分（赵明宇的昵称是「明宇」），搜索要能「输入赵也找到
  // 他」，就必须把真名带上。realName 本就是公开数据——会员名单 getMembers 会
  // 把它下发给任意访客，隐私字段只有 phone / openId（见 read-handlers.publicMember）。
  const [me, board, members] = await Promise.all([
    getCurrentUser(),
    getLeaderboard(activeProject),
    getMembers(),
  ]);
  const myId = me ? me._id : null;

  const realNameById = new Map();
  (Array.isArray(members) ? members : []).forEach((item) => {
    if (item && item._id) realNameById.set(item._id, item.realName || '');
  });

  // 把真名补进榜单行（只供搜索用），再整形成页面行。
  // 名次先在完整榜单上算好，再截断显示——顺序不能反，
  // 否则前十之外的人拿不到自己的名次
  const searchable = rankProjectBoard(board).map((row) => ({
    ...row,
    realName: realNameById.get(row._id) || '',
  }));
  const fullBoard = buildEloRows(searchable, myId);
  const rows = fullBoard.slice(0, TOP_LIMIT);

  // 我的名次从完整榜单里找，不能只在截断后的前十行里找
  //
  // 末尾的 || null 不能省：find() 找不到时返回 undefined，
  // 而下面几处判断写的是 === null，漏掉 undefined 会直接抛错。
  const myRow = (myId && fullBoard.find((row) => row.isMe)) || null;

  // 空搜索词的筛选结果就是原榜。这里借它算出空态，是为了让
  // 计数文案与页面搜索时的「找到 N 人」出自同一处，不会各写各的。
  const unsearched = describeSearch(rows, '');
  const total = fullBoard.length;

  return {
    projectTabs: ALL_RANK_PROJECTS.map((project) => ({
      project,
      label: RANK_PROJECT_LABEL[project],
      active: project === activeProject,
    })),
    activeProject,
    activeProjectLabel: RANK_PROJECT_LABEL[activeProject],
    // 标题栏要显示「男单 · 等级分榜」，给文案而不是 key
    activeBoardLabel: BOARD_LABEL,
    rows: unsearched.rows,
    // 完整榜单。它不参与默认渲染（默认只给前 10），但页面的搜索框要在
    // 全量里找人——只搜前 10 的话，绝大多数会员都查不到
    allRows: fullBoard,
    // 完整榜单的人数。列表只列前 10，但「我的排名」与计数都要用它做分母
    total,
    hasMore: total > rows.length,
    empty: unsearched.empty,
    // 前十之外还有人就如实交代，不能只报 10
    playerCountText: total > TOP_LIMIT ? `前 ${TOP_LIMIT} 名 · 共 ${total} 人` : `${total} 人上榜`,
    emptyNote: unsearched.emptyNote,
    me:
      myRow === null
        ? null
        : {
            rank: myRow.rank,
            // 分母用完整榜单人数：即使我排在第 20、列表里看不到我，
            // 也该知道自己是第 20 / 24，而不是第 20 / 10
            total,
            // 分母用总人数：第 1 名显示「超过 95%」比「超过 100%」更像人话
            beatText: `超过 ${formatPercent((total - myRow.rank) / total)} 的会员`,
          },
    // 自己不在榜上时给一句解释。空着会让人以为页面坏了
    meHint: myRow !== null ? '' : '你还没有参加过这个项目',
  };
}

/**
 * 学校维度的榜单装载器（B4-a）。
 *
 * 取数走绑定范围的 S2 客户端（association-space forScope 的 getSchoolRanking）：
 * 服务端返回的形状与 loadRankView 一致（多 schoolName），纯整形仍在
 * school-rank-service 里完成，这里只做「调用 + 失败上抛」。无读取权限时
 * 客户端抛错，由页面清空旧榜单并展示拒绝原因——不再用外校静态演示榜单
 * 掩盖访问拒绝（指南 §8）。
 *
 * @param {Object} api 绑定学校 / 协会的协会空间客户端
 * @param {Object} [options]
 * @param {string} [options.project] 榜单项目，非法或未传时退回第一个项目
 * @returns {Promise<Object>}
 */
async function loadSchoolRankView(api, options = {}) {
  const result = await api.getSchoolRanking({ project: options.project });
  if (!result.ok) throw new Error(result.message || '排行榜读取失败');
  return result;
}

module.exports = {
  BOARD_LABEL,
  TOP_LIMIT,
  medalOf,
  badgeOf,
  rankProjectBoard,
  buildEloRows,
  normalizeKeyword,
  filterRows,
  describeSearch,
  loadRankView,
  loadSchoolRankView,
};
