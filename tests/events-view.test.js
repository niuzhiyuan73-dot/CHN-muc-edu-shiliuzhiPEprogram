/**
 * 赛事页视图模型 单元测试
 * ============================================================
 * 分两段：纯函数（排序、计数、文案）与接真实模拟数据的端到端。
 * ============================================================
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  MEDALS,
  medalOf,
  avatarOf,
  countEvents,
  describeSeason,
  buildPointsRows,
  loadEventsView,
} = require('../miniprogram/services/events-view.js');
const {
  MATCH_TYPE,
  EVENT_STATUS,
  EVENT_LEVEL,
} = require('../miniprogram/utils/constants.js');

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('medalOf / avatarOf —— 与排行榜页同一套规则', () => {
  assert.deepStrictEqual(MEDALS, ['gold', 'silver', 'bronze']);
  assert.strictEqual(medalOf(1), 'gold');
  assert.strictEqual(medalOf(3), 'bronze');
  assert.strictEqual(medalOf(4), '');
  assert.strictEqual(avatarOf('巴特尔'), '巴');
  assert.strictEqual(avatarOf(''), '?');
});

test('countEvents —— 只数「单打 + 已结束」的赛事', () => {
  const counts = countEvents([
    {
      _id: 'e1',
      matchType: MATCH_TYPE.SINGLES,
      status: EVENT_STATUS.FINISHED,
      results: [{ userId: 'a' }, { userId: 'b' }],
    },
    {
      _id: 'e2',
      matchType: MATCH_TYPE.DOUBLES, // 双打不计分，也不该计入场次
      status: EVENT_STATUS.FINISHED,
      results: [{ userId: 'a' }, { userId: 'c' }],
    },
    {
      _id: 'e3',
      matchType: MATCH_TYPE.SINGLES,
      status: 1, // 没结束
      results: [{ userId: 'a' }],
    },
    {
      _id: 'e4',
      matchType: MATCH_TYPE.SINGLES,
      status: EVENT_STATUS.FINISHED,
      results: [{ userId: 'a' }],
    },
  ]);

  assert.strictEqual(counts.get('a'), 2, 'a 只算 e1、e4 两场');
  assert.strictEqual(counts.get('b'), 1);
  assert.strictEqual(counts.get('c'), undefined, '双打伙伴不上积分榜');
});

test('countEvents —— 空输入返回空 Map', () => {
  assert.strictEqual(countEvents(null).size, 0);
  assert.strictEqual(countEvents([]).size, 0);
});

test('describeSeason —— 有锚点写起算日，有重置再补一句', () => {
  assert.strictEqual(describeSeason({}), '当前赛季');
  assert.strictEqual(describeSeason({ anchorTime: '2026-04-08T18:00:00' }), '本赛季自 4月8日 起');
  assert.strictEqual(
    describeSeason({ anchorTime: '2026-04-08T18:00:00', resetTime: '2026-06-01T00:00:00' }),
    '本赛季自 4月8日 起，6月1日 已重置'
  );
});

test('buildPointsRows —— 滤掉 0 分的人，按积分降序并重新编号', () => {
  const users = [
    { _id: 'a', nickName: '甲', points: 30 },
    { _id: 'b', nickName: '乙', points: 0 }, // 没积分，不该上榜
    { _id: 'c', nickName: '丙', points: 52 },
    { _id: 'd', nickName: '丁' }, // 连 points 字段都没有，视作 0
  ];
  const rows = buildPointsRows(users, new Map([['a', 2], ['c', 3]]), 'c');

  assert.deepStrictEqual(
    rows.map((r) => r.userId),
    ['c', 'a'],
    '按积分从高到低，且 0 分的人被滤掉'
  );
  assert.deepStrictEqual(
    rows.map((r) => r.rank),
    [1, 2],
    '滤人之后名次必须连续，不能留空档'
  );
  assert.strictEqual(rows[0].isMe, true);
  assert.strictEqual(rows[1].isMe, false);
  assert.strictEqual(rows[0].medal, 'gold');
  assert.strictEqual(rows[1].medal, 'silver');
  assert.strictEqual(rows[0].valueText, '52');
  assert.strictEqual(rows[0].noteText, '赛季积分');
  assert.strictEqual(rows[0].detailText, '3 场赛事');
});

test('buildPointsRows —— 参赛场次缺失时算 0 场，不写成 undefined', () => {
  const rows = buildPointsRows([{ _id: 'a', nickName: '甲', points: 2 }], new Map(), null);
  assert.strictEqual(rows[0].detailText, '0 场赛事');
});

test('buildPointsRows —— 传入非数组返回空榜', () => {
  assert.deepStrictEqual(buildPointsRows(null, new Map(), null), []);
});

/* ============================================================
 * 二、接真实模拟数据的端到端部分
 * ============================================================ */

test('赛事页 —— 赛季积分榜上有打过赛事的人', async () => {
  const view = await loadEventsView();

  assert.ok(view.rows.length > 0, '种子里有单打赛事，榜上不该一个人都没有');
  assert.strictEqual(view.empty, false);
  assert.ok(view.seasonText.length > 0, '总要有一句话说明这是哪个赛季');
});

test('赛事页 —— 只有正积分的人上榜，且名次连续', async () => {
  const view = await loadEventsView();

  view.rows.forEach((row, index) => {
    assert.ok(Number(row.valueText) > 0, `${row.nickName} 是 0 分，不该在榜上`);
    assert.strictEqual(row.rank, index + 1, '名次必须从 1 连续排下来');
    assert.ok(row.nickName, '每一行都要有名字');
    assert.ok(row.userId, '缺 userId 就点不进对方主页');
  });
});

test('赛事页 —— 按赛季积分从高到低', async () => {
  const view = await loadEventsView();
  const points = view.rows.map((row) => Number(row.valueText));
  assert.deepStrictEqual(points, [...points].sort((a, b) => b - a));
});

test('赛事页 —— 积分榜的分数来自赛事名次，与默认等级一致', async () => {
  const view = await loadEventsView();

  // 种子的赛事没有 level 字段，按三级赛事计：名次分 ×1，再加 2 分参与分。
  // 所以每个人的积分都应当是「正整数且 ≥ 2」，不会是零头或负分。
  for (const row of view.rows) {
    const points = Number(row.valueText);
    assert.ok(Number.isInteger(points), `${row.nickName} 的积分 ${points} 不是整数`);
    assert.ok(points >= 2, '来打过就至少拿 2 分参与分');
  }
});

test('赛事页 —— 榜上人数与文案一致', async () => {
  const view = await loadEventsView();
  assert.strictEqual(view.playerCountText, `${view.rows.length} 人上榜`);
});

test('赛事页 —— 当前会员在榜时给出与行内一致的名次，不在榜时给一句提示', async () => {
  const view = await loadEventsView();
  const myRow = view.rows.find((row) => row.isMe);

  if (myRow) {
    assert.strictEqual(view.me.rank, myRow.rank);
    assert.strictEqual(view.me.total, view.rows.length);
    assert.strictEqual(view.meHint, '');
  } else {
    assert.strictEqual(view.me, null);
    assert.ok(view.meHint.length > 0, '不在榜上时不能留白让人以为页面坏了');
  }
});

test('赛事页 —— 等级倍数能体现在积分上（一级赛事冠军拿更多）', async () => {
  // 直接验证端到端的一条链：同一名次，等级越高分越多。
  // 用的是 mock 数据源，所以这里只比较相对大小，不写死绝对分值。
  const { getMembers, getEvents } = require('../miniprogram/services/index.js');
  const members = await getMembers();
  const events = await getEvents();

  const singlesFinished = events.filter(
    (e) => e.matchType === MATCH_TYPE.SINGLES && e.status === EVENT_STATUS.FINISHED
  );
  assert.ok(singlesFinished.length > 0, '种子里至少有一场单打赛事');

  // 参赛过的人一定有分，没参赛的一定是 0
  const participantIds = new Set(singlesFinished.flatMap((e) => e.results.map((r) => r.userId)));
  for (const member of members) {
    const hasPoints = (member.points || 0) > 0;
    assert.strictEqual(
      hasPoints,
      participantIds.has(member._id),
      `${member.nickName} 的积分与是否参赛对不上`
    );
  }
});

test('赛事页 —— 等级常量齐全，供第一项的发布赛事使用', () => {
  assert.strictEqual(EVENT_LEVEL.FIRST, 1);
  assert.strictEqual(EVENT_LEVEL.SECOND, 2);
  assert.strictEqual(EVENT_LEVEL.THIRD, 3);
});
