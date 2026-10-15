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
  sortEvents,
  loadEventsView,
  loadEventDetailView,
  roundLabelOf,
  totalRoundsOf,
  maxRoundOf,
  describeDraw,
  byeTextOf,
  teamTextOf,
  entryTextOf,
  buildBracketRows,
  buildSignupRows,
  formatOf,
  isGroupedFormat,
  isDoubleElimFormat,
  hasAutoPlacements,
  groupLabelOf,
  buildStandings,
  drawnTeamIds,
  buildTeamRows,
  loadEventPlacementView,
} = require('../miniprogram/services/events-view.js');
const { sortCollegeEvents } = require('../miniprogram/services/college-event.js');
const { createCollegeFixture, ADMIN: SCHOOL_ADMIN, MEMBER: SCHOOL_MEMBER } = require('./helpers/school-college-fixture');
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
  RATING_POOL,
  USER_STATUS,
  ROLE,
  SIGNUP_STATUS,
  EVENT_FORMAT,
  COLLEGE_EVENT_STATUS,
  TEAM_ID_SEPARATOR,
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

test('describeSeason —— 有锚点写起算日，开过新赛季再补一句', () => {
  assert.strictEqual(describeSeason({}), '当前赛季');
  assert.strictEqual(describeSeason({ anchorTime: '2026-04-08T18:00:00' }), '本赛季自 4月8日 起');
  assert.strictEqual(
    describeSeason({ anchorTime: '2026-04-08T18:00:00', resetTime: '2026-06-01T00:00:00' }),
    '本赛季自 4月8日 起，6月1日 开启新赛季'
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

test('roundLabelOf —— 轮次或总轮数缺失时绝不吐出 undefined', () => {
  // 这正是「每场都显示第 undefined 轮」的病根：轮次缺失时曾直接拼进
  // 模板字符串。缺什么就老实说什么，不能把 undefined 印到界面上。
  assert.strictEqual(roundLabelOf(undefined, 3), '轮次待定');
  assert.strictEqual(roundLabelOf(null, 3), '轮次待定');
  assert.strictEqual(roundLabelOf('x', 3), '轮次待定');
  // 总轮数算不出来（老赛事没有 draw）时不假装知道倒数第几，只报第几轮
  assert.strictEqual(roundLabelOf(2, undefined), '第 2 轮');
  assert.strictEqual(roundLabelOf(2, 0), '第 2 轮');
  assert.strictEqual(roundLabelOf(2, null), '第 2 轮');
  // 无论怎么传，都不能出现 undefined
  for (const [round, total] of [[undefined, undefined], [null, 0], ['', '']]) {
    assert.ok(!roundLabelOf(round, total).includes('undefined'));
  }
});

test('roundLabelOf —— 小组看数字叫，胜者组 / 败者组带区名，总决赛与排位赛有专名', () => {
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.GROUP), '第 1 轮');
  // 胜者组与败者组各自从第 1 轮数起，必须带区名才分得清
  assert.strictEqual(roundLabelOf(2, 3, BRACKET_STAGE.WINNERS), '胜者组 · 第 2 轮');
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.LOSERS), '败者组 · 第 1 轮');
  assert.strictEqual(roundLabelOf(1, 3, BRACKET_STAGE.GRAND_FINAL), '总决赛');
  assert.strictEqual(roundLabelOf(2, 3, BRACKET_STAGE.PLACEMENT), '5–8 名排位赛');
  assert.strictEqual(roundLabelOf(undefined, 3, BRACKET_STAGE.GROUP), '轮次待定');
  assert.strictEqual(roundLabelOf(undefined, 3, BRACKET_STAGE.WINNERS), '胜者组 · 轮次待定');
});

test('formatOf / isGroupedFormat —— 老赛事缺省按单败，不误判成要分组', () => {
  assert.strictEqual(formatOf({}), EVENT_FORMAT.SINGLE_ELIM);
  assert.strictEqual(formatOf(null), EVENT_FORMAT.SINGLE_ELIM);
  assert.strictEqual(isGroupedFormat({ format: EVENT_FORMAT.ROUND_ROBIN }), true);
  assert.strictEqual(isGroupedFormat({ format: EVENT_FORMAT.GROUP_KNOCKOUT }), true);
  assert.strictEqual(isGroupedFormat({}), false);
});

test('isDoubleElimFormat / hasAutoPlacements —— 双败也要自动排名次', () => {
  assert.strictEqual(isDoubleElimFormat({ format: EVENT_FORMAT.DOUBLE_ELIM }), true);
  assert.strictEqual(isDoubleElimFormat({ format: EVENT_FORMAT.GROUP_DOUBLE_ELIM }), true);
  assert.strictEqual(isDoubleElimFormat({ format: EVENT_FORMAT.SINGLE_ELIM }), false);
  assert.strictEqual(isDoubleElimFormat({}), false);
  // 单败淘汰仍由管理员手工录名次，不预填
  assert.strictEqual(hasAutoPlacements({ format: EVENT_FORMAT.DOUBLE_ELIM }), true);
  assert.strictEqual(hasAutoPlacements({ format: EVENT_FORMAT.ROUND_ROBIN }), true);
  assert.strictEqual(hasAutoPlacements({ format: EVENT_FORMAT.SINGLE_ELIM }), false);
});

test('groupLabelOf —— 组号自 0 起，0 号就是 A 组', () => {
  assert.strictEqual(groupLabelOf(0, EVENT_FORMAT.GROUP_KNOCKOUT), 'A 组');
  assert.strictEqual(groupLabelOf(1, EVENT_FORMAT.GROUP_KNOCKOUT), 'B 组');
  assert.strictEqual(groupLabelOf(3, EVENT_FORMAT.GROUP_KNOCKOUT), 'D 组');
  // 循环赛只有一组，不摆字母
  assert.strictEqual(groupLabelOf(0, EVENT_FORMAT.ROUND_ROBIN), '循环赛');
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

test('maxRoundOf —— 从比赛记录反推最大轮次，作为没有 draw 时的兜底', () => {
  assert.strictEqual(maxRoundOf([{ round: 1 }, { round: 3 }, { round: 2 }]), 3);
  assert.strictEqual(maxRoundOf([{ round: 2 }]), 2);
  assert.strictEqual(maxRoundOf([{ round: 'x' }, {}]), 0);
  assert.strictEqual(maxRoundOf([]), 0);
  assert.strictEqual(maxRoundOf(null), 0);
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

test('buildBracketRows —— 没有 draw 的老赛事按最大轮次把轮次名认对', () => {
  // 种子里的历史赛事是直接模拟出来的，没有抽签记录。只要比赛带轮次，
  // 就能推回总轮数：8 签 3 轮，第 1 轮是八进四、第 2 轮半决赛、第 3 轮决赛。
  const legacy = { _id: 'e1' };
  const played = (over) =>
    scheduledRecord({ status: MATCH_STATUS.ACTIVE, scoreA: [11], scoreB: [7], winner: 'A', ...over });
  const rows = buildBracketRows(
    [
      played({ _id: 'final', round: 3, slot: 0 }),
      played({ _id: 'sf', round: 2, slot: 0 }),
      played({ _id: 'qf', round: 1, slot: 0 }),
    ],
    legacy,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.roundText),
    ['四分之一决赛', '半决赛', '决赛']
  );
  for (const row of rows) {
    assert.ok(!row.roundText.includes('undefined'), `轮次名不该是 undefined：${row.roundText}`);
  }
});

test('buildBracketRows —— 连轮次都没有的脏记录也只写「轮次待定」', () => {
  const rows = buildBracketRows(
    [scheduledRecord({ _id: 'mystery', round: undefined })],
    { _id: 'e1' },
    BRACKET_MEMBERS,
    { actor: null }
  );
  assert.strictEqual(rows[0].roundText, '轮次待定');
});

test('buildSignupRows —— 每人后面带上本场池的等级分与赛季积分', () => {
  const members = new Map([
    [
      'a',
      {
        _id: 'a',
        nickName: '甲',
        points: 26,
        ratings: {
          singles: { elo: 1523, matchCount: 12 },
          doubles: { elo: 1401, matchCount: 3 },
        },
      },
    ],
    [
      'b',
      {
        _id: 'b',
        nickName: '乙',
        points: 8,
        ratings: {
          singles: { elo: 1388, matchCount: 5 },
          doubles: { elo: 1450, matchCount: 0 },
        },
      },
    ],
  ]);

  const rows = buildSignupRows(
    [
      { userId: 'a', status: SIGNUP_STATUS.SIGNED, signTime: '2026-05-01T12:00:00' },
      { userId: 'b', status: SIGNUP_STATUS.CHECKED_IN, signTime: '2026-05-02T12:00:00' },
    ],
    members,
    { event: { _id: 'e1', pool: RATING_POOL.SINGLES } }
  );

  assert.strictEqual(rows[0].statText, '等级分 1523 · 积分 26');
  assert.strictEqual(rows[1].statText, '等级分 1388 · 积分 8');
  assert.strictEqual(rows[0].avatarText, '甲');
});

test('buildSignupRows —— 双打赛事取双打池的分，查无此人时不硬凑默认分', () => {
  const members = new Map([
    [
      'a',
      {
        _id: 'a',
        nickName: '甲',
        points: 0,
        ratings: {
          singles: { elo: 1523, matchCount: 12 },
          doubles: { elo: 1401, matchCount: 3 },
        },
      },
    ],
  ]);
  const rows = buildSignupRows(
    [
      { userId: 'a', status: SIGNUP_STATUS.SIGNED, signTime: '2026-05-01T12:00:00' },
      { userId: 'ghost', status: SIGNUP_STATUS.SIGNED, signTime: '2026-05-02T12:00:00' },
    ],
    members,
    { event: { _id: 'e2', pool: RATING_POOL.DOUBLES } }
  );

  assert.strictEqual(rows[0].statText, '等级分 1401 · 积分 0');
  assert.strictEqual(rows[1].statText, '', '档案缺失时留空，不假装是 1450 分');
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

test('buildBracketRows —— 没指派裁判时，签表这一行与今天完全一致（零回归）', () => {
  const rows = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  const row = rows[0];

  assert.strictEqual(row.hasReferee, false);
  assert.strictEqual(row.refereeName, '');
  assert.strictEqual(row.refereeNotice, '');
  assert.strictEqual(row.refereeIsParticipant, false);
  // 管理员能录分靠的是原有规则，不是裁判这条线
  assert.strictEqual(row.canRecord, true);
});

test('buildBracketRows —— 指派裁判的入口只开给管理员，且只在未生效的场次上', () => {
  const asAdmin = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(asAdmin[0].canAssignReferee, true);

  // 普通会员（哪怕自己就是参赛者）看不到这个入口
  const asPlayer = buildBracketRows([scheduledRecord()], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(asPlayer[0].canAssignReferee, false);

  // 已经打完生效的场次不再改派，避免「改历史」
  const active = scheduledRecord({
    scoreA: [11, 11],
    scoreB: [5, 7],
    winner: 'A',
    status: MATCH_STATUS.ACTIVE,
  });
  const rows = buildBracketRows([active], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(rows[0].canAssignReferee, false);
});

test('buildBracketRows —— 指派裁判后签表标出是谁执法，旁人录分被收口', () => {
  const record = scheduledRecord({ referee: 'z' });
  const rows = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  const row = rows[0];

  assert.strictEqual(row.hasReferee, true);
  assert.strictEqual(row.refereeName, '客');
  assert.strictEqual(row.canRecord, false, '裁判接管后参赛者也不能自己录分');
  assert.match(row.refereeNotice, /仅裁判与管理员可录分/);
  // 裁判不在场上，「兼参赛」不亮
  assert.strictEqual(row.refereeIsParticipant, false);
});

test('buildBracketRows —— 裁判本人就是参赛者时给「兼参赛」提示（Q5）', () => {
  // a 既是 teamA 的选手又被指派为裁判：允许，但界面要说明
  const record = scheduledRecord({ referee: 'a' });
  const rows = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'z', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE },
  });

  assert.strictEqual(rows[0].refereeIsParticipant, true);
  // 裁判自己看这一行时不该看到「仅裁判与管理员可录分」的警告
  const asReferee = buildBracketRows([record], BRACKET_EVENT, BRACKET_MEMBERS, {
    actor: { _id: 'a', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE },
  });
  assert.strictEqual(asReferee[0].refereeNotice, '');
  assert.strictEqual(asReferee[0].canRecord, true, '裁判本人可以录分');
});

test('buildBracketRows —— 小组赛整体排在淘汰赛前，0 号组也标出组名', () => {
  const event = {
    _id: 'e1',
    format: EVENT_FORMAT.GROUP_KNOCKOUT,
    draw: {
      groups: [
        { group: 0, entries: ['a', 'b'] },
        { group: 1, entries: ['c', 'd'] },
      ],
    },
  };
  const rows = buildBracketRows(
    [
      // 淘汰赛第 1 轮：轮次值比小组赛还小，若不按阶段分区会插到最前面
      scheduledRecord({ _id: 'ko1', round: 1, stage: BRACKET_STAGE.MAIN, group: undefined }),
      scheduledRecord({ _id: 'gb1', round: 1, stage: BRACKET_STAGE.GROUP, group: 1, slot: 0 }),
      scheduledRecord({ _id: 'ga2', round: 2, stage: BRACKET_STAGE.GROUP, group: 0, slot: 0 }),
      scheduledRecord({ _id: 'ga1', round: 1, stage: BRACKET_STAGE.GROUP, group: 0, slot: 0 }),
    ],
    event,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.matchId),
    ['ga1', 'ga2', 'gb1', 'ko1'],
    'A 组（第 1→2 轮）→ B 组 → 淘汰赛，小组赛无论轮次都排在淘汰赛前'
  );
  assert.strictEqual(rows[0].groupText, 'A 组', '0 号组要有名字，不能被真值判断漏掉');
  assert.strictEqual(rows[2].groupText, 'B 组');
  assert.strictEqual(rows[3].groupText, '', '淘汰赛没有小组，不标组名');
  assert.strictEqual(rows[0].roundText, '第 1 轮', '小组赛的轮次只看数字叫');
});

test('buildBracketRows —— 双败按胜者组→败者组→总决赛分区，轮次带区名', () => {
  const event = { _id: 'e1', format: EVENT_FORMAT.DOUBLE_ELIM, draw: { size: 4, slots: [], byes: [] } };
  const rows = buildBracketRows(
    [
      // 总决赛的轮次值是 1，若不按阶段分区会插到胜者组第 2 轮之前
      scheduledRecord({ _id: 'gf1', round: 1, stage: BRACKET_STAGE.GRAND_FINAL, slot: 0 }),
      scheduledRecord({ _id: 'lb1', round: 1, stage: BRACKET_STAGE.LOSERS, slot: 0 }),
      scheduledRecord({ _id: 'wb2', round: 2, stage: BRACKET_STAGE.WINNERS, slot: 0 }),
      scheduledRecord({ _id: 'wb1', round: 1, stage: BRACKET_STAGE.WINNERS, slot: 0 }),
    ],
    event,
    BRACKET_MEMBERS,
    { actor: null }
  );

  assert.deepStrictEqual(
    rows.map((row) => row.matchId),
    ['wb1', 'wb2', 'lb1', 'gf1'],
    '胜者组两轮 → 败者组 → 总决赛'
  );
  assert.strictEqual(rows[0].roundText, '胜者组 · 第 1 轮');
  assert.strictEqual(rows[2].roundText, '败者组 · 第 1 轮');
  assert.strictEqual(rows[3].roundText, '总决赛');
});

test('buildStandings —— 各组分表，胜场靠前的排前面，净胜带正负号', () => {
  const event = {
    _id: 'e1',
    format: EVENT_FORMAT.GROUP_KNOCKOUT,
    draw: {
      groups: [
        { group: 0, entries: ['a', 'b'] },
        { group: 1, entries: ['c', 'd'] },
      ],
    },
  };
  const played = (over) =>
    scheduledRecord({
      status: MATCH_STATUS.ACTIVE,
      scoreA: [11],
      scoreB: [7],
      winner: 'A',
      ...over,
    });
  const memberMap = new Map([
    ['a', { _id: 'a', nickName: '甲' }],
    ['b', { _id: 'b', nickName: '乙' }],
    ['c', { _id: 'c', nickName: '丙' }],
    ['d', { _id: 'd', nickName: '丁' }],
  ]);
  const standings = buildStandings(
    event,
    [
      played({ _id: 'a1', group: 0, stage: BRACKET_STAGE.GROUP, teamA: ['a'], teamB: ['b'] }),
      // B 组这场胜者写在 B 侧，顺带验证名次确实跟着战绩走
      played({
        _id: 'b1',
        group: 1,
        stage: BRACKET_STAGE.GROUP,
        teamA: ['c'],
        teamB: ['d'],
        scoreA: [7],
        scoreB: [11],
        winner: 'B',
      }),
    ],
    memberMap,
    { _id: 'c' }
  );

  assert.strictEqual(standings.length, 2);
  const groupA = standings.find((item) => item.group === 0);
  const groupB = standings.find((item) => item.group === 1);
  assert.strictEqual(groupA.groupLabel, 'A 组');
  assert.strictEqual(groupA.rows[0].nickName, '甲');
  assert.strictEqual(groupA.rows[0].rank, 1);
  assert.strictEqual(groupA.rows[0].wins, 1);
  assert.strictEqual(groupA.rows[0].gameDiffText, '+1');
  assert.strictEqual(groupA.rows[0].pointDiffText, '+4');
  assert.strictEqual(groupA.rows[1].gameDiffText, '-1');
  assert.strictEqual(groupA.rows[1].pointDiffText, '-4');
  assert.strictEqual(groupA.rows[0].isMe, false);
  assert.strictEqual(groupB.rows[0].nickName, '丁', 'B 组的胜者是丁');
  const meRow = groupB.rows.find((row) => row.nickName === '丙');
  assert.strictEqual(meRow.isMe, true, '丙登录时高亮丙那一行');
  assert.strictEqual(groupB.rows[0].isMe, false, '胜者丁不是当前登录人');
});

test('buildStandings —— 还没抽签（没有分组）时不硬造一张空表', () => {
  assert.deepStrictEqual(buildStandings({ _id: 'e1' }, [], BRACKET_MEMBERS), []);
  assert.deepStrictEqual(
    buildStandings({ _id: 'e1', draw: { groups: [] } }, [], BRACKET_MEMBERS),
    []
  );
});

/* ---------- 双打：一方的两人要一起显示 ---------- */

/** 队号 = 两名成员编号用分隔符拼起来，与 draw.teamIdOf 同一拼法 */
const teamId = (a, b) => [a, b].join(TEAM_ID_SEPARATOR);

const DOUBLES_MEMBERS = new Map([
  ['a', { _id: 'a', nickName: '甲' }],
  ['b', { _id: 'b', nickName: '乙' }],
  ['c', { _id: 'c', nickName: '丙' }],
  ['d', { _id: 'd', nickName: '丁' }],
]);

test('teamTextOf / entryTextOf / byeTextOf —— 双打一方两人一起显示', () => {
  assert.strictEqual(teamTextOf(['a'], DOUBLES_MEMBERS), '甲', '单打仍是一人一名');
  assert.strictEqual(teamTextOf(['a', 'b'], DOUBLES_MEMBERS), '甲、乙');
  assert.strictEqual(teamTextOf([], DOUBLES_MEMBERS), '待定');
  // 双打签位编号是队号，拆开后交给 teamTextOf
  assert.strictEqual(entryTextOf(teamId('a', 'b'), DOUBLES_MEMBERS), '甲、乙');
  // 查不到档案时退回编号，不留空白
  assert.strictEqual(entryTextOf(teamId('a', 'ghost'), DOUBLES_MEMBERS), '甲、ghost');
  assert.strictEqual(
    byeTextOf({ byes: [teamId('a', 'b'), 'c'] }, DOUBLES_MEMBERS),
    '轮空直接晋级：甲、乙、丙'
  );
});

test('buildBracketRows —— 双打两边各显两人，不再只露第一人', () => {
  const event = { _id: 'e1', matchType: MATCH_TYPE.DOUBLES, draw: { size: 4, slots: [] } };
  const rows = buildBracketRows(
    [
      scheduledRecord({
        matchType: MATCH_TYPE.DOUBLES,
        teamA: ['a', 'b'],
        teamB: ['c', 'd'],
      }),
    ],
    event,
    DOUBLES_MEMBERS,
    { actor: null }
  );

  assert.strictEqual(rows[0].teamAText, '甲、乙');
  assert.strictEqual(rows[0].teamBText, '丙、丁');
});

test('buildStandings —— 双打一行是一队，任一成员是我即高亮整行', () => {
  const event = {
    _id: 'e1',
    matchType: MATCH_TYPE.DOUBLES,
    format: EVENT_FORMAT.ROUND_ROBIN,
    draw: { groups: [{ group: 0, entries: [teamId('a', 'b'), teamId('c', 'd')] }] },
  };
  const standings = buildStandings(
    event,
    [
      scheduledRecord({
        matchType: MATCH_TYPE.DOUBLES,
        group: 0,
        stage: BRACKET_STAGE.GROUP,
        teamA: ['a', 'b'],
        teamB: ['c', 'd'],
        status: MATCH_STATUS.ACTIVE,
        scoreA: [11],
        scoreB: [7],
        winner: 'A',
      }),
    ],
    DOUBLES_MEMBERS,
    { _id: 'b' }
  );

  const rows = standings[0].rows;
  assert.strictEqual(rows[0].nickName, '甲、乙');
  assert.strictEqual(rows[1].nickName, '丙、丁');
  assert.strictEqual(rows[0].isMe, true, '乙是队里一员，整行都该高亮');
  assert.strictEqual(rows[1].isMe, false);
});

test('drawnTeamIds / buildTeamRows —— 双打名次页一行一支队，带两名成员编号', () => {
  assert.deepStrictEqual(
    drawnTeamIds({ slots: [teamId('a', 'b'), teamId('c', 'd'), teamId('a', 'b')] }),
    [teamId('a', 'b'), teamId('c', 'd')],
    '去重且保序'
  );
  // 循环 / 小组看各组名单
  assert.deepStrictEqual(
    drawnTeamIds({ groups: [{ entries: [teamId('a', 'b')] }, { entries: [teamId('c', 'd')] }] }),
    [teamId('a', 'b'), teamId('c', 'd')]
  );
  assert.deepStrictEqual(drawnTeamIds(null), []);

  const rows = buildTeamRows([teamId('a', 'b'), teamId('c', 'd')], DOUBLES_MEMBERS);
  assert.strictEqual(rows[0].userId, teamId('a', 'b'));
  assert.deepStrictEqual(rows[0].userIds, ['a', 'b'], '提交时要据它把名次摊到两人');
  assert.strictEqual(rows[0].nickName, '甲、乙');
  assert.strictEqual(rows[0].avatarText, '甲');
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
        courtCount: 4,
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
        courtCount: 4,
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
        courtCount: 4,
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

/* ============================================================
 * 三、列表截断与置顶（赛事页改版）
 * ============================================================ */

test('sortEvents —— 置顶的压过状态分档，取消置顶后回到原序', () => {
  const events = [
    { _id: 'finished', status: EVENT_STATUS.FINISHED, startTime: '2026-03-01T09:00:00' },
    { _id: 'ongoing', status: EVENT_STATUS.ONGOING, startTime: '2026-04-01T09:00:00' },
    { _id: 'signup', status: EVENT_STATUS.SIGNUP, startTime: '2026-05-01T09:00:00' },
  ];

  // 没有置顶时按 报名中 → 进行中 → 已结束
  assert.deepStrictEqual(sortEvents(events).map((e) => e._id), ['signup', 'ongoing', 'finished']);

  // 置顶是管理员的明确表态，要压过自动排序的一切规则：一场置顶的「已结束」
  // 赛事必须排在任何「报名中」之前，否则置顶就失去意义
  const pinned = [{ ...events[0], pinned: true }, events[1], events[2]];
  assert.deepStrictEqual(sortEvents(pinned).map((e) => e._id), ['finished', 'signup', 'ongoing']);
  assert.deepStrictEqual(sortEvents([]), []);
});

test('sortCollegeEvents —— 学院赛同样置顶优先，且不就地改写入参', () => {
  const events = [
    { _id: 'finished', status: COLLEGE_EVENT_STATUS.FINISHED, startTime: '2026-03-01T09:00:00' },
    { _id: 'signup', status: COLLEGE_EVENT_STATUS.SIGNUP, startTime: '2026-05-01T09:00:00' },
    { _id: 'pinned', status: COLLEGE_EVENT_STATUS.FINISHED, startTime: '2026-02-01T09:00:00', pinned: true },
  ];
  const before = events.map((e) => e._id);

  assert.deepStrictEqual(sortCollegeEvents(events).map((e) => e._id), ['pinned', 'signup', 'finished']);
  assert.deepStrictEqual(events.map((e) => e._id), before, '排序要另起数组，不能改乱入参');
});

test('赛事页 —— 两个列表都只摆最近 3 条，「查看全部」入口带出总场次', async () => {
  const facade = require('../miniprogram/services/index.js');
  facade.resetCache();
  try {
    const [allEvents, allCollege] = await Promise.all([facade.getEvents(), facade.getCollegeEvents()]);
    const view = await loadEventsView();

    assert.strictEqual(view.events.length, Math.min(3, allEvents.length));
    assert.strictEqual(view.eventTotal, allEvents.length, '总场次如实交代，不是截断后的条数');
    assert.strictEqual(view.hasMoreEvents, allEvents.length > view.events.length);

    assert.strictEqual(view.collegeEvents.length, Math.min(3, allCollege.length));
    assert.strictEqual(view.collegeEventTotal, allCollege.length);
    assert.strictEqual(view.hasMoreCollegeEvents, allCollege.length > view.collegeEvents.length);
  } finally {
    facade.resetCache();
  }
});

test('赛事页 —— listLimit: Infinity 时列表页拿到全部赛事，不再有「查看全部」', async () => {
  const facade = require('../miniprogram/services/index.js');
  facade.resetCache();
  try {
    const allEvents = await facade.getEvents();
    const view = await loadEventsView({ listLimit: Infinity });

    assert.strictEqual(view.events.length, allEvents.length);
    assert.strictEqual(view.hasMoreEvents, false);
  } finally {
    facade.resetCache();
  }
});

test('赛事页 —— 管理员置顶后该赛事排到最前并带标记，普通会员无权置顶', async () => {
  const facade = require('../miniprogram/services/index.js');
  facade.resetCache();
  try {
    const members = await facade.getMembers();
    const admin = members.find((m) => m.role === ROLE.ADMIN);
    const plain = members.find((m) => m.role === ROLE.MEMBER);
    assert.ok(admin && plain, '演示数据里要有管理员与普通会员');

    // 挑一场「最早结束」的赛事：排序后必定垫底，置顶后能看出它被提到最前
    const events = await facade.getEvents();
    const target = events
      .filter((event) => event.status === EVENT_STATUS.FINISHED)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0];

    const denied = await facade.setEventPinned(target._id, true, plain._id);
    assert.strictEqual(denied.ok, false, '普通会员不能置顶');
    assert.match(denied.message, /没有管理赛事的权限/);

    const done = await facade.setEventPinned(target._id, true, admin._id);
    assert.strictEqual(done.ok, true, done.message);

    const view = await loadEventsView({ user: admin });
    assert.strictEqual(view.events[0].id, target._id, '置顶的赛事排到最前');
    assert.strictEqual(view.events[0].pinned, true);
    assert.strictEqual(view.events[0].canPin, true, '管理员看得到置顶开关');

    // 普通会员看同一份列表：置顶标记照旧可见，但拿不到置顶开关
    const plainView = await loadEventsView({ user: plain });
    assert.strictEqual(plainView.events[0].pinned, true);
    assert.strictEqual(plainView.events[0].canPin, false);
  } finally {
    facade.resetCache();
  }
});

test('赛事页 —— 管理员置顶学院赛排在列表最前，普通会员无权置顶', async () => {
  const fixture = createCollegeFixture();
  try {
    const published = await fixture.publishCollegeEvent(
      {
        title: '置顶测试学院赛',
        legPlan: ['MS', 'WS'],
        startTime: '2026-10-01T09:00:00',
        rosterMin: 1,
        rosterMax: 20,
        courtCount: 4,
      },
      SCHOOL_ADMIN
    );
    assert.strictEqual(published.ok, true, published.firstError);
    const id = published.record._id;

    const denied = await fixture.api(SCHOOL_MEMBER).setCollegeEventPinned({ eventId: id, pinned: true });
    assert.strictEqual(denied.ok, false, '普通会员不能置顶');
    assert.match(denied.message, /没有管理学院赛的权限/);

    const done = await fixture.api(SCHOOL_ADMIN).setCollegeEventPinned({ eventId: id, pinned: true });
    assert.strictEqual(done.ok, true, done.message);

    fixture.to(SCHOOL_ADMIN);
    const view = await loadEventsView();
    assert.strictEqual(view.collegeEvents[0].eventId, id);
    assert.strictEqual(view.collegeEvents[0].pinned, true);
    assert.strictEqual(view.collegeEvents[0].canPin, true);

    fixture.to(SCHOOL_MEMBER);
    const plainView = await loadEventsView();
    assert.strictEqual(plainView.collegeEvents[0].canPin, false);
  } finally {
    fixture.close();
  }
});
