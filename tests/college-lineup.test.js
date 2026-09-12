/**
 * 学院赛排阵规则的纯逻辑自检
 * ============================================================
 * 排阵回答「本大场每个小项谁上」，是名单与比分之间的最后一环。每条边界
 * 都用字面量钉死：
 *
 *   1. 排阵权 —— 干事限本学院、管理员通行；大场已开始或赛事没开始都不行；
 *   2. 提交校验 —— 每个小项必须排满且不超员（D40），人必须出自名单（D37），
 *      禁兼项时同一个人不能出现在两个小项里（D20）；
 *   3. 自动沿用上次 —— 本场已交的优先，其次最近一次，最后空（D30）；
 *   4. 行数据整形与主键。
 *
 * 不碰 wx API、不碰数据源，所以能全部在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  SINGLES_DISCIPLINES,
  playersPerLeg,
  canSubmitLineup,
  validateLineup,
  buildLineupRecord,
  carriedEntriesOf,
  defaultLineupEntries,
  buildLineupRow,
  lineupKey,
} = require('../miniprogram/services/college-lineup.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  TIE_STATUS,
  LEG_DISCIPLINE,
} = require('../miniprogram/utils/constants.js');

/** 管理员 */
const ADMIN = { _id: 'u01', nickName: '巴特尔', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };

/** 体育学院的干事 */
const STAFF = {
  _id: 'u02',
  nickName: '张宇轩',
  role: ROLE.STAFF,
  status: USER_STATUS.ACTIVE,
  college: '体育学院',
};

/** 信息工程学院的干事 —— 用来验证「他院被拒」 */
const OTHER_STAFF = { ...STAFF, _id: 'u04', college: '信息工程学院' };

/** 普通会员 */
const MEMBER = { _id: 'u03', nickName: '李明', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE };

/** 一场进行中的学院赛 */
function event(overrides = {}) {
  return {
    _id: 'ce01',
    title: '2026 学院杯',
    legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.MD, LEG_DISCIPLINE.XD],
    allowMultiEntry: true,
    status: COLLEGE_EVENT_STATUS.ONGOING,
    ...overrides,
  };
}

/** 一场待排阵的大场 */
function tie(overrides = {}) {
  return {
    _id: 't_ce01_1_main_0',
    eventId: 'ce01',
    round: 1,
    slot: 0,
    collegeA: '体育学院',
    collegeB: '信息工程学院',
    legs: [
      { legNo: 1, discipline: LEG_DISCIPLINE.MS },
      { legNo: 2, discipline: LEG_DISCIPLINE.MD },
      { legNo: 3, discipline: LEG_DISCIPLINE.XD },
    ],
    status: TIE_STATUS.PENDING_LINEUP,
    lineupA: false,
    lineupB: false,
    ...overrides,
  };
}

/** 体育学院已通过的名单 */
const ENTRY = {
  _id: 'cen_ce01_体育学院',
  eventId: 'ce01',
  college: '体育学院',
  members: ['m1', 'm2', 'm3', 'm4', 'm5'],
  status: COLLEGE_ENTRY_STATUS.APPROVED,
};

/** 一份合法排阵：男单 1 人、男双 1 组、混双 1 组 */
function payload(overrides = {}) {
  return {
    college: '体育学院',
    entries: [
      { legNo: 1, players: ['m1'] },
      { legNo: 2, players: ['m1', 'm2'] },
      { legNo: 3, players: ['m3', 'm4'] },
    ],
    ...overrides,
  };
}

/* ============================================================
 * 一、人数口径
 * ============================================================ */

test('playersPerLeg —— 单打 1 人、双打 2 人', () => {
  assert.strictEqual(playersPerLeg(LEG_DISCIPLINE.MS), 1);
  assert.strictEqual(playersPerLeg(LEG_DISCIPLINE.WS), 1);
  assert.strictEqual(playersPerLeg(LEG_DISCIPLINE.MD), 2);
  assert.strictEqual(playersPerLeg(LEG_DISCIPLINE.WD), 2);
  assert.strictEqual(playersPerLeg(LEG_DISCIPLINE.XD), 2);
  // 单打项目池与 playersPerLeg 口径一致
  assert.deepStrictEqual(SINGLES_DISCIPLINES, [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS]);
});

/* ============================================================
 * 二、排阵权
 * ============================================================ */

test('canSubmitLineup —— 干事只能给本大场的本学院排阵', () => {
  assert.strictEqual(canSubmitLineup(tie(), STAFF, { college: '体育学院', event: event() }), true);
  // 大场里没有的学院，谁都不能替他排
  assert.strictEqual(
    canSubmitLineup(tie(), ADMIN, { college: '经济学院', event: event() }),
    false
  );
  assert.strictEqual(
    canSubmitLineup(tie(), OTHER_STAFF, { college: '体育学院', event: event() }),
    false
  );
});

test('canSubmitLineup —— 管理员可以替任一方兜底，会员与访客都不行', () => {
  assert.strictEqual(canSubmitLineup(tie(), ADMIN, { college: '信息工程学院', event: event() }), true);
  assert.strictEqual(canSubmitLineup(tie(), MEMBER, { college: '体育学院', event: event() }), false);
  assert.strictEqual(canSubmitLineup(tie(), null, { college: '体育学院', event: event() }), false);
});

test('canSubmitLineup —— 大场已开始 / 已结束都不能再改', () => {
  for (const status of [TIE_STATUS.ONGOING, TIE_STATUS.FINISHED]) {
    assert.strictEqual(
      canSubmitLineup(tie({ status }), STAFF, { college: '体育学院', event: event() }),
      false,
      `status=${status}`
    );
  }
});

test('canSubmitLineup —— 赛事没开始不能排阵', () => {
  assert.strictEqual(
    canSubmitLineup(tie(), STAFF, { college: '体育学院', event: event({ status: COLLEGE_EVENT_STATUS.READY }) }),
    false
  );
  assert.strictEqual(canSubmitLineup(null, STAFF, { college: '体育学院' }), false);
});

/* ============================================================
 * 三、提交校验
 * ============================================================ */

test('validateLineup —— 合法排阵通过，逐项保留并带上项目名', () => {
  const result = validateLineup(payload(), { tie: tie(), event: event(), actor: STAFF, entry: ENTRY });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.college, '体育学院');
  assert.deepStrictEqual(result.entries, [
    { legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['m1'] },
    { legNo: 2, discipline: LEG_DISCIPLINE.MD, players: ['m1', 'm2'] },
    { legNo: 3, discipline: LEG_DISCIPLINE.XD, players: ['m3', 'm4'] },
  ]);
});

test('validateLineup —— 缺人不能提交（D40）', () => {
  const result = validateLineup(
    payload({ entries: [{ legNo: 1, players: [] }, { legNo: 2, players: ['m1', 'm2'] }, { legNo: 3, players: ['m3', 'm4'] }] }),
    { tie: tie(), event: event(), actor: STAFF, entry: ENTRY }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /第 1 场还没排满 1 名队员/);
});

test('validateLineup —— 双打只排一人也算没排满', () => {
  const result = validateLineup(
    payload({ entries: [{ legNo: 1, players: ['m1'] }, { legNo: 2, players: ['m1'] }, { legNo: 3, players: ['m3', 'm4'] }] }),
    { tie: tie(), event: event(), actor: STAFF, entry: ENTRY }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /第 2 场还没排满 2 名队员/);
});

test('validateLineup —— 超过小项人数被拒', () => {
  const result = validateLineup(
    payload({ entries: [{ legNo: 1, players: ['m1', 'm2'] }, { legNo: 2, players: ['m1', 'm2'] }, { legNo: 3, players: ['m3', 'm4'] }] }),
    { tie: tie(), event: event(), actor: STAFF, entry: ENTRY }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /第 1 场最多只能排 1 名队员/);
});

test('validateLineup —— 排阵里的人必须出自本学院名单（D37）', () => {
  const result = validateLineup(
    payload({ entries: [{ legNo: 1, players: ['ghost'] }, { legNo: 2, players: ['m1', 'm2'] }, { legNo: 3, players: ['m3', 'm4'] }] }),
    { tie: tie(), event: event(), actor: STAFF, entry: ENTRY }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不在本学院名单内/);
});

test('validateLineup —— 名单没通过审核不能排阵', () => {
  for (const status of [COLLEGE_ENTRY_STATUS.PENDING, COLLEGE_ENTRY_STATUS.RETURNED]) {
    const result = validateLineup(payload(), {
      tie: tie(),
      event: event(),
      actor: STAFF,
      entry: { ...ENTRY, status },
    });
    assert.strictEqual(result.ok, false, `status=${status}`);
    assert.match(result.message, /尚未通过审核/);
  }
  const missing = validateLineup(payload(), { tie: tie(), event: event(), actor: STAFF, entry: null });
  assert.match(missing.message, /尚未通过审核/);
});

test('validateLineup —— 默认允许兼项', () => {
  // m1 同时出现在男单与男双，默认（allowMultiEntry 缺省）应放行
  const result = validateLineup(payload(), { tie: tie(), event: event(), actor: STAFF, entry: ENTRY });
  assert.strictEqual(result.ok, true);
});

test('validateLineup —— 关掉兼项后同一个人不能打两个小项（D20）', () => {
  const result = validateLineup(payload(), {
    tie: tie(),
    event: event({ allowMultiEntry: false }),
    actor: STAFF,
    entry: ENTRY,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /不允许兼项/);
});

test('validateLineup —— 同一小项里重复点同一个人会被去重', () => {
  const result = validateLineup(
    payload({ entries: [{ legNo: 1, players: ['m1'] }, { legNo: 2, players: ['m2', 'm2'] }, { legNo: 3, players: ['m3', 'm4'] }] }),
    { tie: tie(), event: event(), actor: STAFF, entry: ENTRY }
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /第 2 场还没排满 2 名队员/);
});

test('validateLineup —— 大场没有小项 / 找不到大场都有明确说法', () => {
  const noLegs = validateLineup(payload(), {
    tie: tie({ legs: [] }),
    event: event(),
    actor: STAFF,
    entry: ENTRY,
  });
  assert.match(noLegs.message, /还没有小项/);

  const noTie = validateLineup(payload(), { tie: null, event: event(), actor: STAFF, entry: ENTRY });
  assert.match(noTie.message, /找不到这个大场/);
});

/* ============================================================
 * 四、装配记录
 * ============================================================ */

test('buildLineupRecord —— 落库记录带提交人与沿用来源', () => {
  const now = new Date('2026-09-12T10:00:00');
  const result = buildLineupRecord(payload(), {
    tie: tie(),
    event: event(),
    actor: STAFF,
    entry: ENTRY,
    now,
    carriedFrom: 'ln_prev',
  });

  assert.strictEqual(result.ok, true);
  const record = result.record;
  assert.strictEqual(record.eventId, 'ce01');
  assert.strictEqual(record.tieId, 't_ce01_1_main_0');
  assert.strictEqual(record.college, '体育学院');
  assert.strictEqual(record.submittedBy, 'u02');
  assert.strictEqual(record.submittedName, '张宇轩');
  assert.strictEqual(record.submitTime, now);
  assert.strictEqual(record.carriedFrom, 'ln_prev');
  assert.strictEqual(record.entries.length, 3);
});

test('buildLineupRecord —— 校验不过时不产出记录', () => {
  const result = buildLineupRecord(
    payload({ entries: [{ legNo: 1, players: [] }] }),
    { tie: tie(), event: event(), actor: STAFF, entry: ENTRY }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.record, null);
});

/* ============================================================
 * 五、自动沿用上次
 * ============================================================ */

/** 两份历史排阵：A 学院更早、更晚各一份 */
const HISTORY = [
  {
    _id: 'ln_old',
    tieId: 't_prev_1',
    college: '体育学院',
    submitTime: new Date('2026-09-01T10:00:00'),
    entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['m1'] }],
  },
  {
    _id: 'ln_new',
    tieId: 't_prev_2',
    college: '体育学院',
    submitTime: new Date('2026-09-05T10:00:00'),
    entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['m2'] }],
  },
  {
    _id: 'ln_other',
    tieId: 't_prev_3',
    college: '信息工程学院',
    submitTime: new Date('2026-09-06T10:00:00'),
    entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['x1'] }],
  },
];

test('carriedEntriesOf —— 取本学院最近一次提交，不看他院', () => {
  const carried = carriedEntriesOf(HISTORY, '体育学院');
  assert.deepStrictEqual(carried[0].players, ['m2']);
});

test('carriedEntriesOf —— 自己学院没有历史时给 null', () => {
  assert.strictEqual(carriedEntriesOf(HISTORY, '经济学院'), null);
  assert.strictEqual(carriedEntriesOf(null, '体育学院'), null);
});

test('carriedEntriesOf —— 可排除某个大场，重进本页时带出自己已交的那份', () => {
  const lineups = [
    ...HISTORY,
    {
      _id: 'ln_here',
      tieId: 't_ce01_1_main_0',
      college: '体育学院',
      submitTime: new Date('2026-09-12T10:00:00'),
      entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['m5'] }],
    },
  ];
  // 不排除：取到最新的（本大场这份）
  assert.deepStrictEqual(carriedEntriesOf(lineups, '体育学院')[0].players, ['m5']);
  // 排除本大场：回退到最近一次历史
  assert.deepStrictEqual(
    carriedEntriesOf(lineups, '体育学院', 't_ce01_1_main_0')[0].players,
    ['m2']
  );
});

test('defaultLineupEntries —— 本大场已交的优先，其次沿用上次，最后空', () => {
  const own = [
    {
      _id: 'ln_here',
      tieId: 't_ce01_1_main_0',
      college: '体育学院',
      submitTime: new Date('2026-09-12T10:00:00'),
      entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['m5'] }],
    },
  ];
  const withOwn = defaultLineupEntries({
    tie: tie(),
    college: '体育学院',
    lineups: [...HISTORY, ...own],
  });
  assert.strictEqual(withOwn.source, 'own');
  assert.deepStrictEqual(withOwn.entries[0].players, ['m5']);

  const carried = defaultLineupEntries({ tie: tie(), college: '体育学院', lineups: HISTORY });
  assert.strictEqual(carried.source, 'carried');
  assert.deepStrictEqual(carried.entries[0].players, ['m2']);

  const empty = defaultLineupEntries({ tie: tie(), college: '经济学院', lineups: HISTORY });
  assert.strictEqual(empty.source, 'empty');
  // 空的时候也要把小项铺出来，页面才有可勾的地方
  assert.deepStrictEqual(
    empty.entries.map((row) => row.legNo),
    [1, 2, 3]
  );
  assert.deepStrictEqual(empty.entries.map((row) => row.players), [[], [], []]);
});

/* ============================================================
 * 六、行数据与主键
 * ============================================================ */

test('buildLineupRow —— 队员编号翻成姓名，我方高亮', () => {
  const members = new Map([
    ['m1', { _id: 'm1', nickName: '宇轩' }],
    ['m2', { _id: 'm2', nickName: '浩然' }],
  ]);
  const row = buildLineupRow(
    {
      _id: 'ln_here',
      eventId: 'ce01',
      tieId: 't_ce01_1_main_0',
      college: '体育学院',
      submittedName: '张宇轩',
      submitTime: '2026-09-12T10:05:00',
      entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['m1', 'm2'] }],
    },
    { actor: STAFF, members }
  );

  assert.strictEqual(row.lineupId, 'ln_here');
  assert.strictEqual(row.college, '体育学院');
  assert.strictEqual(row.isMine, true);
  assert.strictEqual(row.submitTimeText, '2026-09-12T10:05');
  assert.strictEqual(row.entries[0].playersText, '宇轩、浩然');
});

test('buildLineupRow —— 缺会员档案时退回编号，不渲染 undefined', () => {
  const row = buildLineupRow(
    {
      college: '信息工程学院',
      entries: [{ legNo: 1, discipline: LEG_DISCIPLINE.MS, players: ['ghost'] }],
    },
    { actor: STAFF }
  );
  assert.strictEqual(row.entries[0].playersText, 'ghost');
  assert.strictEqual(row.isMine, false);
});

test('lineupKey —— 同一大场同一学院恒为一条', () => {
  assert.strictEqual(lineupKey('t1', '体育学院'), 'ln_t1_体育学院');
  assert.strictEqual(lineupKey('t1', '体育学院'), lineupKey('t1', '体育学院'));
  assert.notStrictEqual(lineupKey('t1', '体育学院'), lineupKey('t1', '信息工程学院'));
});
