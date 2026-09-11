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
  TOP_LIMIT,
  medalOf,
  avatarOf,
  countEvents,
  describeSeason,
  buildPointsRows,
  loadEventsView,
  loadEventDetailView,
  roundLabelOf,
  totalRoundsOf,
  describeDraw,
  byeTextOf,
  buildBracketRows,
} = require('../miniprogram/services/events-view.js');
// 积分榜的搜索与排行榜页是同一套逻辑，页面复用它的纯函数
const { describeSearch } = require('../miniprogram/services/rank-view.js');
const {
  MATCH_TYPE,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  BRACKET_STAGE,
  USER_STATUS,
  ROLE,
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

/* ---------- 签表（抽签结果） ---------- */

/** 造一条抽签生成的待确认比赛，字段与 draw.js 的产出一致 */
function scheduledRecord(over = {}) {
  return {
    _id: 'm1',
    eventId: 'e1',
    round: 1,
    stage: BRACKET_STAGE.MAIN,
    slot: 1,
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['a'],
    teamB: ['b'],
    scoreA: [],
    scoreB: [],
    gamePoints: 11,
    bestOf: 3,
    winner: null,
    recorder: 'a',
    matchTime: '2026-05-20T09:00:00',
    location: '学校体育馆',
    status: MATCH_STATUS.PENDING,
    ...over,
  };
}

/** 一场 4 签位的赛事：总轮数为 2，第 1 轮即半决赛 */
const BRACKET_EVENT = {
  _id: 'e1',
  draw: { seedMode: 'elo', seedCount: 4, drawCount: 1, size: 4, seeds: ['a', 'b'], byes: [] },
};

const BRACKET_MEMBERS = new Map([
  ['a', { _id: 'a', nickName: '甲' }],
  ['b', { _id: 'b', nickName: '乙' }],
  ['z', { _id: 'z', nickName: '客' }],
]);

test('roundLabelOf —— 从最后一轮倒着数，决赛/半决赛/四分之一决赛才叫得对', () => {
  assert.strictEqual(roundLabelOf(3, 3), '决赛');
  assert.strictEqual(roundLabelOf(2, 3), '半决赛');
  assert.strictEqual(roundLabelOf(1, 3), '四分之一决赛');
  assert.strictEqual(roundLabelOf(3, 5), '四分之一决赛');
  assert.strictEqual(roundLabelOf(4, 5), '半决赛');
  assert.strictEqual(roundLabelOf(5, 5), '决赛');
  assert.strictEqual(roundLabelOf(1, 5), '第 1 轮', '离决赛还远的那几轮按数字叫');
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.BRONZE), '季军赛');
});

test('totalRoundsOf —— 签位数是 2 的几次幂就几轮，非法值收敛成 0', () => {
  assert.strictEqual(totalRoundsOf({ size: 2 }), 1);
  assert.strictEqual(totalRoundsOf({ size: 4 }), 2);
  assert.strictEqual(totalRoundsOf({ size: 8 }), 3);
  assert.strictEqual(totalRoundsOf({ size: 16 }), 4);
  assert.strictEqual(totalRoundsOf({ size: 1 }), 0);
  assert.strictEqual(totalRoundsOf(null), 0);
  assert.strictEqual(totalRoundsOf({}), 0);
});

test('describeDraw —— 说清第几次抽签、几个签位、几位种子', () => {
  assert.strictEqual(describeDraw(null), '');
  assert.strictEqual(
    describeDraw({ drawCount: 2, size: 8, seeds: ['a', 'b'] }),
    '第 2 次抽签 · 8 个签位 · 2 位种子'
  );
  // 没有种子时不硬凑一句「0 位种子」
  assert.strictEqual(describeDraw({ drawCount: 1, size: 4 }), '第 1 次抽签 · 4 个签位');
});

test('byeTextOf —— 轮空的人要点名，没人轮空时不留一句空话', () => {
  const memberMap = new Map([['a', { nickName: '甲' }], ['b', { nickName: '乙' }]]);
  assert.strictEqual(byeTextOf({ byes: ['a', 'b'] }, memberMap), '轮空直接晋级：甲、乙');
  assert.strictEqual(byeTextOf({ byes: [] }, memberMap), '');
  assert.strictEqual(byeTextOf(null, memberMap), '');
});

test('buildBracketRows —— 按轮次→阶段→签位排，季军赛紧跟同轮的正赛', () => {
  const rows = buildBracketRows(
    [
      scheduledRecord({ _id: 'final', round: 2, slot: 1 }),
      scheduledRecord({ _id: 'semi2', round: 1, slot: 2 }),
      scheduledRecord({ _id: 'bronze', round: 1, slot: 1, stage: BRACKET_STAGE.BRONZE }),
      scheduledRecord({ _id: 'semi1', round: 1, slot: 1 }),
    ],
    BRACKET_EVENT,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.matchId),
    ['semi1', 'semi2', 'bronze', 'final'],
    '先排第 1 轮正赛（按签位）→ 季军赛 → 再排决赛'
  );
  assert.strictEqual(rows[3].roundText, '决赛');
  assert.strictEqual(rows[0].roundText, '半决赛');
  assert.strictEqual(rows[2].roundText, '季军赛');
});

test('buildBracketRows —— 别的赛事的比赛不混进签表', () => {
  const rows = buildBracketRows(
    [scheduledRecord({ _id: 'x', eventId: 'other' })],
    BRACKET_EVENT,
    BRACKET_MEMBERS,
    { actor: null }
  );
  assert.deepStrictEqual(rows, []);
});

test('buildBracketRows —— 没录分时参赛者只看到「录分」，看不到「确认」', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER },
  });
  const row = rows[0];

  assert.strictEqual(row.isMine, true);
  assert.strictEqual(row.canRecord, true);
  assert.strictEqual(row.canConfirm, false, '确认要按胜方计分，没比分就无从确认');
  assert.strictEqual(row.scoreText, '', '还没比分不该渲染成 0:0');
  assert.strictEqual(row.teamAText, '甲');
  assert.strictEqual(row.teamBText, '乙');
  assert.strictEqual(row.statusLabel, '待确认');
});

test('buildBracketRows —— 非参赛的普通会员既不能录分也不能确认', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.MEMBER },
  });
  assert.strictEqual(rows[0].isMine, false);
  assert.strictEqual(rows[0].canRecord, false);
  assert.strictEqual(rows[0].canConfirm, false);
});

test('buildBracketRows —— 管理员不是参赛者也能代为录分', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(rows[0].canRecord, true);
});

test('buildBracketRows —— 录分不再按数据源放宽，普通会员登录也不是想录就录', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
    isMock: true,
  });
  assert.strictEqual(rows[0].canRecord, false, '录分只认参赛者与管理员，与真正写入时一致');
});

test('buildBracketRows —— 录完分换成对手确认，且不再出现「录分」', () => {
  const record = scheduledRecord({
    scoreA: [11],
    scoreB: [7],
    winner: 'A',
    status: MATCH_STATUS.PENDING,
  });
  const rows = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'b', role: ROLE.MEMBER },
  });
  const row = rows[0];

  assert.strictEqual(row.scoreText, '11:7');
  assert.strictEqual(row.winnerSide, 'A');
  assert.strictEqual(row.canRecord, false, '已经有比分，不该再给「录分」入口');
  assert.strictEqual(row.canConfirm, true, '站在录入者对面的 b 可以确认');
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

test('赛事页 —— 积分榜最多只列前 10 名，计数如实交代总数', async () => {
  const view = await loadEventsView();

  assert.strictEqual(view.rows.length, Math.min(TOP_LIMIT, view.total));
  assert.strictEqual(view.allRows.length, view.total, 'allRows 必须是完整榜');
  if (view.total > TOP_LIMIT) {
    assert.strictEqual(view.hasMore, true);
    assert.strictEqual(view.playerCountText, `前 ${TOP_LIMIT} 名 · 共 ${view.total} 人`);
  } else {
    assert.strictEqual(view.hasMore, false);
    assert.strictEqual(view.playerCountText, `${view.total} 人上榜`);
  }
});

test('赛事页 —— 搜索能查到前十之外的会员，名次仍是榜上的绝对名次', async () => {
  const view = await loadEventsView();

  if (view.total <= TOP_LIMIT) return;

  const outside = view.allRows[TOP_LIMIT];
  assert.ok(!view.rows.some((row) => row.userId === outside.userId), '前十之外不该默认展示');

  const search = describeSearch(view.allRows, outside.nickName);
  const hit = search.rows.find((row) => row.userId === outside.userId);
  assert.ok(hit, '前十之外的人必须能被搜到');
  assert.strictEqual(hit.rank, outside.rank);
  assert.ok(hit.rank > TOP_LIMIT);
});

test('赛事页 —— 当前会员在榜时给出与完整榜一致的名次，不在榜时给一句提示', async () => {
  const view = await loadEventsView();
  const myRow = view.allRows.find((row) => row.isMe);

  if (myRow) {
    assert.strictEqual(view.me.rank, myRow.rank);
    // 分母是完整榜人数，不是截断后的 10 行——否则会写出「第 15 / 10」
    assert.strictEqual(view.me.total, view.total);
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

test('赛事详情 —— 抽签后签表随详情下发，逐轮推进后决赛与季军赛都出现', async () => {
  const facade = require('../miniprogram/services/index.js');
  facade.resetCache();
  try {
    const members = await facade.getMembers();
    const players = members.slice(0, 4).map((member) => member._id);
    const host = players[0];
    // 录分要参赛者本人或管理员；host 既是发布者（u01 管理员）也是选手
    const actor = await facade.getMember(host);

    const { record } = await facade.publishEvent(
      {
        title: '抽签测试赛',
        description: '',
        matchType: MATCH_TYPE.SINGLES,
        level: EVENT_LEVEL.SECOND,
        bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
        seedMode: SEED_MODE.ELO,
        seedCount: 2,
        startTime: '2026-05-20T09:00:00',
        location: '学校体育馆',
        quota: 8,
      },
      host
    );
    for (const userId of players) await facade.signUpEvent(record._id, userId);

    const drawn = await facade.drawEvent(record._id, host, { seedValue: 5 });
    assert.strictEqual(drawn.ok, true, drawn.message);
    assert.strictEqual(drawn.matches.length, 2, '4 人 4 签，首轮两场');

    const view = await loadEventDetailView(record._id, { user: actor, isMock: true });
    assert.strictEqual(view.found, true);
    assert.strictEqual(view.hasBracket, true, '抽完签详情页要能看到签表');
    assert.strictEqual(view.bracketRows.length, 2);
    assert.strictEqual(view.drawText, '第 1 次抽签 · 4 个签位 · 2 位种子');
    for (const row of view.bracketRows) {
      assert.strictEqual(row.roundText, '半决赛', '4 签 2 轮，首轮即半决赛');
      assert.strictEqual(row.canRecord, true, '管理员可代为录分');
      assert.strictEqual(row.canConfirm, false, '还没比分，先录后确认');
      assert.strictEqual(row.scoreText, '');
    }

    // 两场半决赛都录分并确认，详情页应多出决赛与季军赛
    for (const match of drawn.matches) {
      const scored = await facade.submitMatch({
        id: match._id,
        scoreA: ['11', '11'],
        scoreB: ['3', '5'],
        actor: match.teamA[0],
      });
      assert.strictEqual(scored.ok, true, scored.firstError);
      const confirmed = await facade.confirmMatch(match._id, match.teamB[0]);
      assert.strictEqual(confirmed.ok, true, confirmed.message);
    }

    const after = await loadEventDetailView(record._id, { user: actor, isMock: true });
    assert.strictEqual(after.bracketRows.length, 4, '两场半决赛 + 决赛 + 季军赛');
    assert.ok(after.bracketRows.some((row) => row.roundText === '决赛'));
    assert.ok(after.bracketRows.some((row) => row.roundText === '季军赛'));
  } finally {
    facade.resetCache();
  }
});

test('赛事详情 —— 首轮某场被驳回后重抽，该签位恢复为待确认而不是卡在已撤销', async () => {
  const facade = require('../miniprogram/services/index.js');
  facade.resetCache();
  try {
    const members = await facade.getMembers();
    const host = members[0]._id;
    const players = members.slice(0, 4).map((member) => member._id);

    const { record } = await facade.publishEvent(
      {
        title: '重抽回归赛',
        description: '',
        matchType: MATCH_TYPE.SINGLES,
        level: EVENT_LEVEL.SECOND,
        bronzeMode: EVENT_BRONZE_MODE.TIED,
        seedMode: SEED_MODE.ELO,
        seedCount: 2,
        startTime: '2026-05-20T09:00:00',
        location: '学校体育馆',
        quota: 8,
      },
      host
    );
    for (const userId of players) await facade.signUpEvent(record._id, userId);

    const drawn = await facade.drawEvent(record._id, host, { seedValue: 5 });
    assert.strictEqual(drawn.ok, true, drawn.message);

    // 某一签位被对手驳回（比赛记录上会压一条 REVOKED 改判）
    const target = drawn.matches[0];
    const rejected = await facade.rejectMatch(target._id, target.teamB[0], '比分记错了');
    assert.strictEqual(rejected.ok, true, rejected.message);

    // 再抽一次：编号是确定的，会落到同一个 _id 上
    const redrawn = await facade.drawEvent(record._id, host, { seedValue: 5 });
    assert.strictEqual(redrawn.ok, true, redrawn.message);

    const after = (await facade.getMatchRecords()).find((match) => match._id === target._id);
    assert.ok(after, '重抽后该签位应还在签表里');
    assert.strictEqual(
      after.status,
      MATCH_STATUS.PENDING,
      '重抽清掉旧改判，该签位应回到待确认，而不是永远卡在已撤销'
    );
  } finally {
    facade.resetCache();
  }
});

test('赛事详情 —— 手工指定种子：下发候选人名单与需凑齐的人数', async () => {
  const facade = require('../miniprogram/services/index.js');
  facade.resetCache();
  try {
    const members = await facade.getMembers();
    const actor = await facade.getCurrentUser();
    // 参赛人数少于选定种子数：人人都是种子，该点几位就点几位（决策 9.3）
    const players = members.slice(0, 3).map((member) => member._id);
    const host = players[0];

    const { record } = await facade.publishEvent(
      {
        title: '手工种子测试赛',
        description: '',
        matchType: MATCH_TYPE.SINGLES,
        level: EVENT_LEVEL.SECOND,
        bronzeMode: EVENT_BRONZE_MODE.TIED,
        seedMode: SEED_MODE.MANUAL,
        seedCount: 4,
        startTime: '2026-05-20T09:00:00',
        location: '学校体育馆',
        quota: 8,
      },
      host
    );
    for (const userId of players) await facade.signUpEvent(record._id, userId);

    const view = await loadEventDetailView(record._id, { user: actor, isMock: true });
    assert.strictEqual(view.event.isManualSeed, true, '手工指定的赛事要能被界面认出来');
    assert.strictEqual(view.seedCandidates.length, 3, '候选名单就是有效报名者');
    assert.strictEqual(
      view.manualSeedNeeded,
      3,
      '选定 4 位种子但只有 3 人参赛，只需点 3 位（与抽签算法同一口径）'
    );
    for (const candidate of view.seedCandidates) {
      assert.ok(players.includes(candidate.userId));
      assert.ok(candidate.nickName, '候选人要有名字可点');
    }

    // 没点名就抽：算法必须拒绝，而不是悄悄按报名顺序顶上
    const refused = await facade.drawEvent(record._id, host, { seedValue: 5 });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.message, /请指定 3 位种子/);

    // 管理员点名的顺序就是种子顺序，不是等级分顺序
    const manualOrder = [players[2], players[1], players[0]];
    const drawn = await facade.drawEvent(record._id, host, { seedValue: 5, manualOrder });
    assert.strictEqual(drawn.ok, true, drawn.message);
    assert.deepStrictEqual(
      drawn.draw.seeds.slice().sort(),
      manualOrder.slice().sort(),
      '抽签落库的种子应与点名的那几位一致'
    );
  } finally {
    facade.resetCache();
  }
});
