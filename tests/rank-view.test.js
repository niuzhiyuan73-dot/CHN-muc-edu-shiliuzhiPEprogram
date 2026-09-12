const test = require('node:test');
const assert = require('node:assert');

const {
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
} = require('../miniprogram/services/rank-view.js');
const {
  RANK_PROJECT,
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
} = require('../miniprogram/utils/constants.js');
const { getMembers } = require('../miniprogram/services/index.js');

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
  assert.strictEqual(view.activeBoardLabel, BOARD_LABEL);
  assert.ok(view.rows.length > 0);
  assert.strictEqual(view.empty, false);
});

test('排行榜 —— 榜单最多只列前 10 名', async () => {
  for (const project of ALL_RANK_PROJECTS) {
    const view = await loadRankView({ project });
    assert.ok(
      view.rows.length <= TOP_LIMIT,
      `${project} 榜列了 ${view.rows.length} 行，超过前 ${TOP_LIMIT} 名`
    );
    assert.strictEqual(view.rows.length, Math.min(TOP_LIMIT, view.total));
  }
});

test('排行榜 —— 前十之外还有人时，计数如实交代总数', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });

  if (view.total > TOP_LIMIT) {
    assert.strictEqual(view.hasMore, true);
    assert.strictEqual(view.playerCountText, `前 ${TOP_LIMIT} 名 · 共 ${view.total} 人`);
  } else {
    assert.strictEqual(view.hasMore, false);
    assert.strictEqual(view.playerCountText, `${view.total} 人上榜`);
  }
});

test('排行榜 —— 名次在完整榜单上算，不因只显示前 10 而被截断', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });

  // 榜上每行的名次必须与它在完整榜单里的位置一致：前 10 行就是 1..10
  view.rows.forEach((row, index) => {
    assert.strictEqual(row.rank, index + 1);
  });
  assert.ok(view.total >= view.rows.length, '完整榜单人数不能少于显示出来的行数');
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

test('排行榜 —— 项目名非法时回退到第一个项目，不白屏', async () => {
  const view = await loadRankView({ project: '不存在的项目' });
  assert.strictEqual(view.activeProject, ALL_RANK_PROJECTS[0]);
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
  // 用完整榜单而非截断后的前十：展示只给前 10 是界面取舍，
  // 而「双打不区分男女」说的是榜单口径，不该被截断与否左右
  const genders = new Set(view.allRows.map((row) => genderOf.get(row.userId)));

  assert.ok(genders.has('M'), '双打榜应当有男会员');
  assert.ok(genders.has('F'), '双打榜应当有女会员');
});

test('排行榜 —— 当前会员在榜上时，给出与完整榜单一致的名次', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.MEN_SINGLES });

  assert.ok(view.me, '默认会员（赵明宇）打过男单，应该榜上有名');
  // 我可能排在前十之外（列表里看不到），但「我的排名」必须照样给名次
  if (view.me.rank <= TOP_LIMIT) {
    const myRow = view.rows.find((row) => row.isMe);
    assert.ok(myRow, '排在前十就该在列表里出现');
    assert.strictEqual(view.me.rank, myRow.rank);
  }
  // 分母是完整榜单人数，不是截断后的 10 行——否则会写出「第 20 / 10」
  assert.strictEqual(view.me.total, view.total);
  assert.strictEqual(view.meHint, '');
});

test('排行榜 —— 前十之外的人也能拿到自己的名次', async () => {
  // 挑一个行数超过前十的项目，验证「我的排名」走的是完整榜单
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });

  if (view.me && view.me.rank > TOP_LIMIT) {
    assert.ok(
      !view.rows.some((row) => row.isMe),
      '前十之外的我不该出现在列表里'
    );
    assert.ok(view.me.rank > view.rows.length, '名次必须来自完整榜单');
    assert.strictEqual(view.me.total, view.total);
  } else {
    // 女单榜里赵明宇必然没有出场，换一条分支验证提示
    const women = await loadRankView({ project: RANK_PROJECT.WOMEN_SINGLES });
    assert.strictEqual(women.me, null);
    assert.strictEqual(women.meHint, '你还没有参加过这个项目');
  }
});

test('排行榜 —— 我不在这个项目时，不给空白而是在榜下留一句话', async () => {
  // 赵明宇是男会员，不会出现在女单榜上
  const view = await loadRankView({ project: RANK_PROJECT.WOMEN_SINGLES });

  assert.strictEqual(view.me, null);
  assert.strictEqual(view.meHint, '你还没有参加过这个项目');
  assert.ok(view.rows.length > 0, '我不在榜上不代表榜是空的');
});

test('排行榜 —— 计数文案与完整榜单人数一致', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });

  if (view.total > TOP_LIMIT) {
    assert.strictEqual(view.playerCountText, `前 ${TOP_LIMIT} 名 · 共 ${view.total} 人`);
  } else {
    assert.strictEqual(view.playerCountText, `${view.total} 人上榜`);
  }
  // rows 是截断后的显示行，total 才是完整人数
  assert.strictEqual(view.rows.length, Math.min(TOP_LIMIT, view.total));
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
  const someone = view.allRows[0];

  const search = describeSearch(view.allRows, someone.nickName);

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

test('排行榜 —— 完整榜单供搜索用，人数与 total 对得上', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });

  assert.strictEqual(view.allRows.length, view.total, 'allRows 必须是完整榜单');
  // 每一行的名次与它在完整榜单里的位置一致，前十之外也不断档
  view.allRows.forEach((row, index) => {
    assert.strictEqual(row.rank, index + 1);
  });
});

test('排行榜 —— 搜索能查到前十之外的会员，名次仍是榜单上的绝对名次', async () => {
  const view = await loadRankView({ project: RANK_PROJECT.DOUBLES });

  // 这份榜单不足 11 人就验证不了「前十之外」，跳过（种子数据下不该发生）
  if (view.total <= TOP_LIMIT) return;

  const outside = view.allRows[TOP_LIMIT];

  // 默认展示的 rows 里没有他……
  assert.ok(!view.rows.some((row) => row.userId === outside.userId));
  // ……但在完整榜单里搜得到，且名次保持榜单上的绝对名次
  const search = describeSearch(view.allRows, outside.nickName);
  const hit = search.rows.find((row) => row.userId === outside.userId);
  assert.ok(hit, '前十之外的人必须能被搜到');
  assert.strictEqual(hit.rank, outside.rank);
  assert.ok(hit.rank > TOP_LIMIT);
});
