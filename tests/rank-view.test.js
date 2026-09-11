const test = require('node:test');
const assert = require('node:assert');

const {
  BOARD,
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
} = require('../miniprogram/services/rank-view.js');
const {
  RANK_PROJECT,
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
} = require('../miniprogram/utils/constants.js');
const { getMembers, getProgressLeaderboard } = require('../miniprogram/services/index.js');

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('medalOf —— 前三名给奖牌，第四名开始不给', () => {
  assert.strictEqual(medalOf(1), 'gold');
  assert.strictEqual(medalOf(2), 'silver');
  assert.strictEqual(medalOf(3), 'bronze');
  // 铜牌以下不做任何装饰，否则整张榜都是花花绿绿的
  assert.strictEqual(medalOf(4), '');
  assert.strictEqual(medalOf(24), '');
});

test('badgeOf —— 只翻译页面认识的两种状态', () => {
  assert.strictEqual(badgeOf('provisional'), '定级中');
  assert.strictEqual(badgeOf('inactive'), '不活跃');
  // 正常在训的人不需要挂一个「正常」的牌子
  assert.strictEqual(badgeOf('active'), '');
  assert.strictEqual(badgeOf(undefined), '');
});

test('rankProjectBoard —— 滤掉没出过场的人，并把名次重新编号', () => {
  const board = [
    { _id: 'a', elo: 1300, matchCount: 10 },
    { _id: 'b', elo: 1200, matchCount: 0 }, // 一场没打，不该出现在榜上
    { _id: 'c', elo: 1100, matchCount: 4 },
  ];
  const rows = rankProjectBoard(board);

  assert.deepStrictEqual(
    rows.map((r) => r._id),
    ['a', 'c']
  );
  // 关键：滤掉 b 之后名次必须是 1、2，而不是留下 1、3 的空档
  assert.deepStrictEqual(
    rows.map((r) => r.rank),
    [1, 2]
  );
});

test('rankProjectBoard —— 传入非数组时返回空数组而不是抛错', () => {
  assert.deepStrictEqual(rankProjectBoard(null), []);
  assert.deepStrictEqual(rankProjectBoard(undefined), []);
});

test('buildEloRows —— 主数字是等级分，副行是战绩', () => {
  const rows = buildEloRows(
    [
      {
        _id: 'u01',
        rank: 1,
        nickName: '巴特尔',
        avatarUrl: '',
        elo: 1234.56,
        wins: 12,
        losses: 3,
        winRate: 0.8,
        status: 'active',
      },
    ],
    'u01'
  );

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].rank, 1);
  assert.strictEqual(rows[0].medal, 'gold');
  assert.strictEqual(rows[0].isMe, true);
  assert.strictEqual(rows[0].avatarText, '巴'); // 没头像时用昵称首字
  assert.strictEqual(rows[0].detailText, '12 胜 3 负');
  assert.strictEqual(rows[0].noteText, '胜率 80%');
  assert.strictEqual(rows[0].valueText, '1235'); // 等级分取整展示
  assert.strictEqual(rows[0].badge, '');
});

test('buildEloRows —— 不是我那一行不会高亮', () => {
  const rows = buildEloRows([{ _id: 'u01', rank: 1, nickName: '巴特尔' }], 'u06');
  assert.strictEqual(rows[0].isMe, false);
});

test('buildProgressRows —— 主数字是涨幅，带上正负号', () => {
  const rows = buildProgressRows(
    [
      { _id: 'u02', rank: 1, nickName: '张宇轩', startElo: 1000, currentElo: 1180, delta: 180, matchCount: 30 },
      { _id: 'u03', rank: 2, nickName: '李思远', startElo: 1400, currentElo: 1350, delta: -50, matchCount: 30 },
    ],
    null
  );

  assert.strictEqual(rows[0].valueText, '+180');
  assert.strictEqual(rows[0].valueClass, 'is-up');
  // 起点和终点都写出来，光看 +180 没有画面感
  assert.strictEqual(rows[0].detailText, '1000 → 1180');
  assert.strictEqual(rows[0].noteText, '30 场');

  assert.strictEqual(rows[1].valueText, '-50');
  assert.strictEqual(rows[1].valueClass, 'is-down');
  assert.strictEqual(rows[1].medal, 'silver');
});

test('normalizeKeyword —— 去空白、转小写，空值当作不筛选', () => {
  assert.strictEqual(normalizeKeyword('  张三 '), '张三');
  assert.strictEqual(normalizeKeyword('Leo'), 'leo', '英文昵称要能不分大小写地搜到');
  assert.strictEqual(normalizeKeyword(''), '');
  assert.strictEqual(normalizeKeyword(null), '');
  assert.strictEqual(normalizeKeyword(undefined), '');
});

test('filterRows —— 按昵称子串命中，前后空格与大小写都不影响', () => {
  const rows = [
    { userId: 'u1', rank: 1, nickName: '张宇轩' },
    { userId: 'u2', rank: 2, nickName: 'Leo' },
    { userId: 'u3', rank: 3, nickName: '李思远' },
  ];

  assert.deepStrictEqual(
    filterRows(rows, '张').map((r) => r.userId),
    ['u1']
  );
  assert.deepStrictEqual(
    filterRows(rows, 'le').map((r) => r.userId),
    ['u2'],
    '搜 le 应当能命中 Leo'
  );
  assert.deepStrictEqual(
    filterRows(rows, '  远 ').map((r) => r.userId),
    ['u3']
  );
  assert.deepStrictEqual(filterRows(rows, '不存在'), []);
});

test('filterRows —— 只筛不重新编号，名次保持榜单上的绝对名次', () => {
  const rows = [
    { userId: 'u1', rank: 1, nickName: '张三' },
    { userId: 'u2', rank: 2, nickName: '李四' },
    { userId: 'u3', rank: 3, nickName: '张五' },
  ];
  const hit = filterRows(rows, '张');

  assert.deepStrictEqual(
    hit.map((r) => r.rank),
    [1, 3],
    '搜索不是重新排名，张五仍该是第 3 名'
  );
});

test('filterRows —— 空搜索词原样返回，非数组当空榜处理', () => {
  const rows = [{ userId: 'u1', rank: 1, nickName: '张三' }];
  assert.strictEqual(filterRows(rows, ''), rows);
  assert.strictEqual(filterRows(rows, '   '), rows);
  assert.deepStrictEqual(filterRows(null, '张'), []);
  assert.deepStrictEqual(filterRows(undefined, '张'), []);
});

test('describeSearch —— 不搜索时给「N 人上榜」，空榜才提示没人打过', () => {
  const rows = [{ userId: 'u1', rank: 1, nickName: '张三' }];

  const idle = describeSearch(rows, '');
  assert.strictEqual(idle.searching, false);
  assert.strictEqual(idle.keyword, '');
  assert.strictEqual(idle.rows.length, 1);
  assert.strictEqual(idle.countText, '1 人上榜');
  assert.strictEqual(idle.empty, false);
  assert.strictEqual(idle.emptyNote, '', '正常浏览时不该冒出一句提示');

  const blank = describeSearch([], '');
  assert.strictEqual(blank.empty, true);
  assert.strictEqual(blank.emptyNote, '这个项目还没有人打过');
});

test('describeSearch —— 搜索时给「找到 N 人」，无命中时把搜索词写进提示', () => {
  const rows = [
    { userId: 'u1', rank: 1, nickName: '张宇轩' },
    { userId: 'u2', rank: 2, nickName: '李思远' },
  ];

  const hit = describeSearch(rows, ' 张 ');
  assert.strictEqual(hit.searching, true);
  assert.strictEqual(hit.keyword, '张', '搜索词要去掉首尾空白');
  assert.strictEqual(hit.countText, '找到 1 人');
  assert.strictEqual(hit.empty, false);

  const miss = describeSearch(rows, '王');
  assert.strictEqual(miss.rows.length, 0);
  assert.strictEqual(miss.empty, true);
  assert.strictEqual(miss.countText, '找到 0 人');
  assert.strictEqual(miss.emptyNote, '没有昵称含「王」的会员');
});

/* ============================================================
 * 二、接真实模拟数据的端到端部分
 * ============================================================ */

test('排行榜 —— 默认展示第一个项目的等级分榜', async () => {
  const view = await loadRankView();

  assert.strictEqual(view.activeProject, ALL_RANK_PROJECTS[0]);
  assert.strictEqual(view.activeProjectLabel, RANK_PROJECT_LABEL[ALL_RANK_PROJECTS[0]]);
  assert.strictEqual(view.activeBoard, BOARD.ELO);
  assert.ok(view.rows.length > 0);
  assert.strictEqual(view.empty, false);
});

test('排行榜 —— 三个项目的标签始终都在，且只有一个选中', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });

  assert.strictEqual(view.projectTabs.length, ALL_RANK_PROJECTS.length);
  assert.strictEqual(
    view.projectTabs.filter((tab) => tab.active).length,
    1
  );
  assert.strictEqual(view.projectTabs.find((tab) => tab.active).project, RANK_PROJECT.DOUBLES);
});

test('排行榜 —— 两种榜单的标签都在，且只有一个选中', async () => {
  const view = await loadRankView({ board: BOARD.PROGRESS });

  assert.strictEqual(view.boardTabs.length, 2);
  assert.strictEqual(
    view.boardTabs.filter((tab) => tab.active).length,
    1
  );
  assert.strictEqual(view.boardTabs.find((tab) => tab.active).board, BOARD.PROGRESS);
});

test('排行榜 —— 项目名非法时回退到第一个项目，不白屏', async () => {
  const view = await loadRankView({ project: '不存在的项目' });
  assert.strictEqual(view.activeProject, ALL_RANK_PROJECTS[0]);
});

test('排行榜 —— 榜单类型非法时回退到等级分榜', async () => {
  const view = await loadRankView({ board: '不存在的榜' });
  assert.strictEqual(view.activeBoard, BOARD.ELO);
});

test('排行榜 —— 名次连续，且只列该项目真正出过场的人', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });

  view.rows.forEach((row, index) => {
    assert.strictEqual(row.rank, index + 1, '名次必须从 1 连续排下来，不能有空档');
    assert.ok(row.nickName, '每一行都要有名字');
  });
});

test('排行榜 —— 榜单按等级分从高到低', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });
  const elos = view.rows.map((row) => Number(row.valueText));
  const sorted = [...elos].sort((a, b) => b - a);
  assert.deepStrictEqual(elos, sorted);
});

test('排行榜 —— 男单榜上不会出现女会员', async () => {
  const members = await getMembers();
  const womenIds = new Set(members.filter((m) => m.gender === 'F').map((m) => m._id));

  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });
  const leaked = view.rows.filter((row) => womenIds.has(row.userId));

  assert.deepStrictEqual(leaked, [], '男单榜混进了女会员');
});

test('排行榜 —— 女单榜上不会出现男会员', async () => {
  const members = await getMembers();
  const menIds = new Set(members.filter((m) => m.gender === 'M').map((m) => m._id));

  const view = await loadRankView({ project: RANK_PROJECT.WOMEN_SINGLES });
  const leaked = view.rows.filter((row) => menIds.has(row.userId));

  assert.deepStrictEqual(leaked, [], '女单榜混进了男会员');
});

test('排行榜 —— 双打榜不区分男女，两边都能上', async () => {
  const members = await getMembers();
  const genderOf = new Map(members.map((m) => [m._id, m.gender]));

  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });
  const genders = new Set(view.rows.map((row) => genderOf.get(row.userId)));

  assert.ok(genders.has('M'), '双打榜应当有男会员');
  assert.ok(genders.has('F'), '双打榜应当有女会员');
});

test('排行榜 —— 当前会员在榜上时，给出与行内一致的名次', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });

  assert.ok(view.me, '默认会员（赵明宇）打过男单，应该榜上有名');
  const myRow = view.rows.find((row) => row.isMe);
  assert.ok(myRow, '榜上要有一行标记为「我」');
  assert.strictEqual(view.me.rank, myRow.rank);
  // 分母必须是上榜人数，否则「第 6 / 24」和下面只列了 20 行的榜对不上
  assert.strictEqual(view.me.total, view.rows.length);
  assert.strictEqual(view.meHint, '');
});

test('排行榜 —— 我不在这个项目时，不给空白而是在榜下留一句话', async () => {
  // 赵明宇是男会员，不会出现在女单榜上
  const view = await loadRankView({ project: RANK_PROJECT.WOMEN_SINGLES });

  assert.strictEqual(view.me, null);
  assert.strictEqual(view.meHint, '你还没有参加过这个项目');
  assert.ok(view.rows.length > 0, '我不在榜上不代表榜是空的');
});

test('排行榜 —— 进步榜只收满门槛场次的人', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES, board: BOARD.PROGRESS });

  assert.ok(view.rows.length > 0);
  for (const row of view.rows) {
    const matchCount = Number(row.noteText.replace(' 场', ''));
    assert.ok(
      matchCount >= PROGRESS_MIN_MATCHES,
      `${row.nickName} 只有 ${matchCount} 场，不该出现在进步榜`
    );
  }
});

test('排行榜 —— 进步榜按涨幅从高到低，且与原始数据一致', async () => {
  const project = RANK_PROJECT.MEN_SINGLES;
  const view = await loadRankView({ project, board: BOARD.PROGRESS });
  const raw = await getProgressLeaderboard(project, { minMatches: PROGRESS_MIN_MATCHES });

  assert.strictEqual(view.rows.length, raw.length);

  view.rows.forEach((row, index) => {
    assert.strictEqual(row.userId, raw[index]._id);
    // 展示的涨幅必须等于「当前分 - 起点分」，不能是另算的一个数
    assert.strictEqual(Number(row.valueText), raw[index].delta);
    assert.strictEqual(row.valueClass, raw[index].delta >= 0 ? 'is-up' : 'is-down');
  });

  const deltas = raw.map((entry) => entry.delta);
  assert.deepStrictEqual(deltas, [...deltas].sort((a, b) => b - a));
});

test('排行榜 —— 进步榜里我可能不在榜上，此时提示差几场', async () => {
  // 赵明宇的双打场次未必够门槛，这里直接验证提示逻辑的另一种分支
  const view = await loadRankView({ project: RANK_PROJECT.WOMEN_SINGLES, board: BOARD.PROGRESS });
  assert.strictEqual(view.me, null);
  assert.strictEqual(view.meHint, `出场满 ${PROGRESS_MIN_MATCHES} 场就能上进步榜`);
});

test('排行榜 —— 榜上人数与文案一致', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });
  assert.strictEqual(view.playerCountText, `${view.rows.length} 人上榜`);
});

test('排行榜 —— 每一行都带得动「点进主页」所需的 userId', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });
  for (const row of view.rows) {
    assert.ok(row.userId, '缺 userId 就点不进对方主页');
    assert.strictEqual(typeof row.avatarText, 'string');
    assert.strictEqual(typeof row.avatarUrl, 'string');
  }
});

test('排行榜 —— 在真实榜单上按名字筛选，命中的人名次不变', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });
  const someone = view.rows[0];

  const search = describeSearch(view.rows, someone.nickName);

  assert.ok(search.rows.length >= 1, '至少要搜到榜首本人');
  assert.ok(
    search.rows.every((row) => row.nickName.includes(someone.nickName)),
    '搜出来的每一行昵称都要含搜索词'
  );
  const sameRow = search.rows.find((row) => row.userId === someone.userId);
  assert.strictEqual(sameRow.rank, someone.rank, '筛选不能改动名次');
  assert.strictEqual(
    search.countText,
    `找到 ${search.rows.length} 人`
  );
});
