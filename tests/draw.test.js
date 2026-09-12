/**
 * 赛事抽签服务
 * ============================================================
 * utils/bracket.js 保证「签位怎么摆」；这一层保证「摆谁进去」不出错：
 *   1. 谁参赛——未取消的报名者，不看签到，退赛的人不许再进签表；
 *   2. 谁是种子、什么顺序——三种来源各按各的规矩；
 *   3. 结果可复核——同一个 seedValue 必得同一张签表。
 * 再钉住几个「不该抽签」的场景（双打、非报名阶段、人不够）。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  entryIdsOf,
  actualSeedCount,
  seedRankOf,
  resolveSeeds,
  planDraw,
  buildDrawRecord,
  eventMatchKey,
  buildBracketMatches,
  planNextRound,
  buildRoundMatches,
  canRedraw,
} = require('../miniprogram/services/draw.js');
const {
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_BRONZE_MODE,
  BRACKET_STAGE,
  SEED_MODE,
  RATING_POOL,
  SIGNUP_STATUS,
  EVENT_FORMAT,
} = require('../miniprogram/utils/constants.js');
const { DEFAULT_FORMAT } = require('../miniprogram/utils/match-format.js');

/** 一位带单打等级分与赛季积分的会员 */
function member(id, { elo = 1450, points = 0 } = {}) {
  return {
    _id: id,
    points,
    ratings: { [RATING_POOL.SINGLES]: { elo } },
  };
}

/** 一条报名记录 */
function signup(userId, status = SIGNUP_STATUS.SIGNED) {
  return { userId, status };
}

/** 一场单打赛事，报名中 */
function singlesEvent(overrides = {}) {
  return {
    _id: 'e1',
    matchType: MATCH_TYPE.SINGLES,
    status: EVENT_STATUS.SIGNUP,
    seedMode: SEED_MODE.ELO,
    seedCount: 8,
    ...overrides,
  };
}

describe('entryIdsOf —— 参赛者口径', () => {
  test('已取消的人不进签表，不论其余人报名先后', () => {
    const signups = [
      signup('u3'),
      signup('u1', SIGNUP_STATUS.CANCELED),
      signup('u2', SIGNUP_STATUS.CHECKED_IN),
      signup('u4', SIGNUP_STATUS.CANCELED),
    ];
    assert.deepEqual(entryIdsOf(signups), ['u2', 'u3']);
  });

  test('重复记录与空值被剔除', () => {
    const signups = [signup('u1'), signup('u1'), signup(undefined), null];
    assert.deepEqual(entryIdsOf(signups), ['u1']);
  });

  test('签到与否不改变参赛资格', () => {
    const signed = [signup('u1'), signup('u2')];
    const checked = [signup('u1', SIGNUP_STATUS.CHECKED_IN), signup('u2', SIGNUP_STATUS.CHECKED_IN)];
    assert.deepEqual(entryIdsOf(signed), entryIdsOf(checked));
  });
});

describe('actualSeedCount —— 实际种子数取两者较小', () => {
  test('人数多时按选定数量', () => {
    assert.equal(actualSeedCount(8, 16), 8);
    assert.equal(actualSeedCount(4, 5), 4);
  });

  test('人数不超过种子数时人人都是种子', () => {
    assert.equal(actualSeedCount(8, 3), 3);
    assert.equal(actualSeedCount(2, 2), 2);
  });

  test('空名单与非法数量归零', () => {
    assert.equal(actualSeedCount(8, 0), 0);
    assert.equal(actualSeedCount(-1, 8), 0);
  });
});

describe('seedRankOf —— 排序依据', () => {
  test('elo 取单打池的等级分', () => {
    const m = member('u1', { elo: 1700 });
    assert.equal(seedRankOf(m, SEED_MODE.ELO), 1700);
  });

  test('points 取赛季积分，缺失时按 0', () => {
    assert.equal(seedRankOf(member('u1', { points: 42 }), SEED_MODE.POINTS), 42);
    assert.equal(seedRankOf({ _id: 'u2' }, SEED_MODE.POINTS), 0);
  });
});

describe('resolveSeeds —— 三种种子来源', () => {
  const entries = ['u1', 'u2', 'u3', 'u4'];
  const members = [
    member('u1', { elo: 1500 }),
    member('u2', { elo: 1800 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1700 }),
  ];

  test('按等级分降序取前 S 名', () => {
    const res = resolveSeeds({ entries, members, mode: SEED_MODE.ELO, seedCount: 2 });
    assert.equal(res.firstError, '');
    assert.deepEqual(res.seeds, ['u2', 'u4']);
  });

  test('按赛季积分降序取前 S 名，与等级分无关', () => {
    const pointed = [
      member('u1', { elo: 1900, points: 3 }),
      member('u2', { elo: 1400, points: 30 }),
      member('u3', { elo: 1450, points: 10 }),
      member('u4', { elo: 1450, points: 20 }),
    ];
    const res = resolveSeeds({ entries, members: pointed, mode: SEED_MODE.POINTS, seedCount: 2 });
    assert.deepEqual(res.seeds, ['u2', 'u4']);
  });

  test('同分时按编号定序——随机只该来自 seedValue', () => {
    const tied = entries.map((id) => member(id, { elo: 1500 }));
    const res = resolveSeeds({ entries, members: tied, mode: SEED_MODE.ELO, seedCount: 2 });
    assert.deepEqual(res.seeds, ['u1', 'u2']);
  });

  test('手工指定原样采用管理员的顺序', () => {
    const res = resolveSeeds({
      entries,
      members,
      mode: SEED_MODE.MANUAL,
      seedCount: 2,
      manualOrder: ['u4', 'u1'],
    });
    assert.equal(res.firstError, '');
    assert.deepEqual(res.seeds, ['u4', 'u1']);
  });

  test('手工指定的人数不够时明确报错', () => {
    const res = resolveSeeds({
      entries,
      members,
      mode: SEED_MODE.MANUAL,
      seedCount: 4,
      manualOrder: ['u1'],
    });
    assert.match(res.firstError, /4 位种子/);
  });

  test('手工指定的种子必须在参赛者之中', () => {
    const res = resolveSeeds({
      entries,
      members,
      mode: SEED_MODE.MANUAL,
      seedCount: 2,
      manualOrder: ['u9', 'u1'],
    });
    assert.match(res.firstError, /参赛者/);
  });

  test('种子数量不在 2/4/8 之内直接拒绝', () => {
    const res = resolveSeeds({ entries, members, mode: SEED_MODE.ELO, seedCount: 3 });
    assert.match(res.firstError, /2 \/ 4 \/ 8/);
  });
});

describe('planDraw —— 整体与拒绝条件', () => {
  const members = [
    member('u1', { elo: 1800 }),
    member('u2', { elo: 1700 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1500 }),
    member('u5', { elo: 1400 }),
    member('u6', { elo: 1300 }),
  ];
  const signups = members.map((m) => signup(m._id));
  // 6 人配 2 个种子：既有种子落位，也有 4 个非种子参与洗牌
  const seededEvent = () => singlesEvent({ seedCount: 2 });

  test('同一个 seedValue 必得同一张签表（可复核）', () => {
    const a = planDraw({ event: seededEvent(), signups, members, seedValue: 20260911 });
    const b = planDraw({ event: seededEvent(), signups, members, seedValue: 20260911 });
    assert.equal(a.ok, true);
    assert.deepEqual(a.slots, b.slots);
    assert.deepEqual(a.byes, b.byes);
  });

  test('不同 seedValue 会得到不同的非种子落位', () => {
    const a = planDraw({ event: seededEvent(), signups, members, seedValue: 1 });
    const b = planDraw({ event: seededEvent(), signups, members, seedValue: 2 });
    assert.notDeepEqual(a.slots, b.slots);
  });

  test('6 人补到 8 签，两个轮空都给了高种子', () => {
    const plan = planDraw({ event: seededEvent(), signups, members, seedValue: 7 });
    assert.equal(plan.size, 8);
    assert.equal(plan.slots.length, 8);
    assert.equal(plan.byes.length, 2);
    // 轮空只能落在种子身上
    assert.ok(plan.byes.every((id) => plan.seeds.includes(id)));
    assert.deepEqual([...plan.byes].sort(), ['u1', 'u2']);
  });

  test('人数不超过种子数时人人按来源顺序排位，不再随机（决策 9.3）', () => {
    const wide = singlesEvent({ seedCount: 8 });
    const a = planDraw({ event: wide, signups, members, seedValue: 1 });
    const b = planDraw({ event: wide, signups, members, seedValue: 2 });
    assert.deepEqual(a.slots, b.slots, '6 人配 8 个种子，没有非种子可洗牌');
    assert.deepEqual(a.seeds, ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  });

  test('1 号与 2 号种子分处上下半区，决赛前不相遇', () => {
    const plan = planDraw({ event: seededEvent(), signups, members, seedValue: 7 });
    const half = plan.size / 2;
    const posOf = (id) => plan.slots.indexOf(id);
    const top = posOf(plan.seeds[0]) < half;
    const second = posOf(plan.seeds[1]) < half;
    assert.notEqual(top, second);
  });

  test('双打赛事拒绝抽签', () => {
    const event = singlesEvent({ matchType: MATCH_TYPE.DOUBLES });
    const plan = planDraw({ event, signups, members, seedValue: 1 });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /双打/);
  });

  test('已开赛或已结束都不许抽签', () => {
    for (const status of [EVENT_STATUS.ONGOING, EVENT_STATUS.FINISHED]) {
      const plan = planDraw({ event: singlesEvent({ status }), signups, members, seedValue: 1 });
      assert.equal(plan.ok, false);
      assert.match(plan.message, /报名阶段/);
    }
  });

  test('不足 2 人拒绝抽签', () => {
    const plan = planDraw({ event: singlesEvent(), signups: [signup('u1')], members, seedValue: 1 });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /不足 2 人/);
  });

  test('取消报名的人不算数，可能因此凑不够 2 人', () => {
    const plan = planDraw({
      event: singlesEvent(),
      signups: [signup('u1'), signup('u2', SIGNUP_STATUS.CANCELED)],
      members,
      seedValue: 1,
    });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /不足 2 人/);
  });

  test('赛事不存在时明确报错', () => {
    const plan = planDraw({ event: null, signups, members, seedValue: 1 });
    assert.equal(plan.ok, false);
    assert.match(plan.message, /不存在/);
  });
});

describe('buildDrawRecord —— 落库形状', () => {
  test('算法内容与台账信息拼成 draw 字段', () => {
    const plan = planDraw({
      event: singlesEvent(),
      signups: ['u1', 'u2', 'u3', 'u4'].map((id) => signup(id)),
      members: [member('u1'), member('u2'), member('u3'), member('u4')],
      seedValue: 99,
    });
    const drawnAt = new Date('2026-09-11T10:00:00');
    const record = buildDrawRecord(plan, { drawnAt, drawnBy: 'admin', drawCount: 2 });

    assert.equal(record.seedMode, SEED_MODE.ELO);
    assert.equal(record.seedCount, 8);
    assert.equal(record.seedValue, 99);
    assert.equal(record.drawCount, 2);
    assert.equal(record.drawnBy, 'admin');
    assert.deepEqual(record.drawnAt, drawnAt);
    assert.equal(record.size, plan.size);
    assert.deepEqual(record.slots, plan.slots);
    assert.deepEqual(record.seeds, plan.seeds);
    assert.deepEqual(record.byes, plan.byes);
  });

  test('分组赛的 draw 落库带组信息，单败淘汰不落 groups（保持旧形状）', () => {
    const entries = ['u1', 'u2', 'u3', 'u4'];
    const grouped = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.ROUND_ROBIN }),
      signups: entries.map((id) => signup(id)),
      members: entries.map((id) => member(id)),
      seedValue: 5,
    });
    const groupedRecord = buildDrawRecord(grouped, { drawnAt: new Date('2026-09-11T10:00:00'), drawnBy: 'admin' });

    assert.equal(groupedRecord.format, EVENT_FORMAT.ROUND_ROBIN);
    assert.equal(groupedRecord.groupCount, 1);
    assert.deepEqual(groupedRecord.groups, [{ group: 0, entries: grouped.groups[0].entries }]);

    const solo = planDraw({
      event: singlesEvent(),
      signups: entries.map((id) => signup(id)),
      members: entries.map((id) => member(id)),
      seedValue: 5,
    });
    const soloRecord = buildDrawRecord(solo, { drawnAt: new Date('2026-09-11T10:00:00'), drawnBy: 'admin' });

    assert.equal(soloRecord.format, EVENT_FORMAT.SINGLE_ELIM);
    assert.equal(soloRecord.groups, undefined);
  });
});

describe('eventMatchKey —— 确定性编号', () => {
  test('同一场赛事的同一签位恒得同一个编号', () => {
    assert.equal(eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 0), eventMatchKey('e1', 1, 'main', 0));
  });

  test('赛事、轮次、阶段、签位任一变则编号变', () => {
    const base = eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 0);
    assert.notEqual(base, eventMatchKey('e2', 1, BRACKET_STAGE.MAIN, 0));
    assert.notEqual(base, eventMatchKey('e1', 2, BRACKET_STAGE.MAIN, 0));
    assert.notEqual(base, eventMatchKey('e1', 1, BRACKET_STAGE.BRONZE, 0));
    assert.notEqual(base, eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 1));
  });

  test('缺省阶段按主赛处理', () => {
    assert.equal(eventMatchKey('e1', 1, null, 2), eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 2));
  });

  test('四参调用与旧版逐字节一致（历史比赛的 _id 不能变）', () => {
    assert.equal(eventMatchKey('e1', 1, BRACKET_STAGE.MAIN, 0), 'x_e1_r1_main_0');
    assert.equal(eventMatchKey('e1', 2, BRACKET_STAGE.BRONZE, 0), 'x_e1_r2_bronze_0');
  });

  test('带上小组段：同轮同签位不同组是两场比赛', () => {
    assert.equal(eventMatchKey('e1', 2, BRACKET_STAGE.GROUP, 1, 0), 'x_e1_g0_r2_group_1');
    assert.notEqual(
      eventMatchKey('e1', 2, BRACKET_STAGE.GROUP, 1, 0),
      eventMatchKey('e1', 2, BRACKET_STAGE.GROUP, 1, 1)
    );
  });
});

describe('planDraw —— 循环 / 小组赛改走分组排期', () => {
  const members = [
    member('u1', { elo: 1800 }),
    member('u2', { elo: 1700 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1500 }),
    member('u5', { elo: 1400 }),
    member('u6', { elo: 1300 }),
  ];
  const signups = members.map((m) => signup(m._id));

  test('循环赛：收起成单组，六人排五轮', () => {
    const plan = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.ROUND_ROBIN }),
      signups,
      members,
      seedValue: 5,
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.format, EVENT_FORMAT.ROUND_ROBIN);
    assert.equal(plan.slots.length, 0, '不摆签表');
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].group, 0);
    assert.equal(plan.groups[0].entries.length, 6);
    assert.equal(plan.groups[0].rounds.length, 5);
  });

  test('小组赛：蛇形分组，种子被摊到不同组', () => {
    const plan = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2 }),
      signups,
      members,
      seedValue: 5,
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.groups.length, 2);
    // 成员全是种子，顺序即 elo 序，蛇形分组的落位完全确定
    assert.deepEqual(plan.groups[0].entries, ['u1', 'u4', 'u5']);
    assert.deepEqual(plan.groups[1].entries, ['u2', 'u3', 'u6']);
  });

  test('不传组数按缺省 2 组；组数超过人数则收敛', () => {
    const byDefault = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT }),
      signups,
      members,
      seedValue: 5,
    });
    assert.equal(byDefault.groups.length, 2);

    const three = planDraw({
      event: singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 4 }),
      signups: signups.slice(0, 3),
      members: members.slice(0, 3),
      seedValue: 5,
    });
    assert.equal(three.groups.length, 3, '不超过人数，免得出现空组');
  });

  test('同一个 seedValue 的分组结果可复核', () => {
    const event = singlesEvent({ format: EVENT_FORMAT.GROUP_KNOCKOUT, groupCount: 2 });
    const a = planDraw({ event, signups, members, seedValue: 42 });
    const b = planDraw({ event, signups, members, seedValue: 42 });
    assert.deepEqual(a.groups, b.groups);
  });
});

describe('buildBracketMatches —— 首轮比赛生成', () => {
  const members = [
    member('u1', { elo: 1800 }),
    member('u2', { elo: 1700 }),
    member('u3', { elo: 1600 }),
    member('u4', { elo: 1500 }),
    member('u5', { elo: 1400 }),
    member('u6', { elo: 1300 }),
  ];
  const signups = members.map((m) => signup(m._id));
  // 6 人配 2 个种子 → 8 签、4 个签位对、其中 2 对含轮空
  const planned = (seedValue = 7, seedCount = 2) =>
    planDraw({ event: singlesEvent({ seedCount }), signups, members, seedValue });
  const theEvent = (overrides = {}) =>
    singlesEvent({ _id: 'e9', location: '体育馆', startTime: '2026-09-20T09:00:00', ...overrides });

  test('有一方轮空的签位不生成比赛', () => {
    const plan = planned();
    const drafts = buildBracketMatches(plan, { event: theEvent() });
    const playable = plan.pairs.filter(([a, b]) => a && b).length;

    assert.equal(plan.byes.length, 2);
    assert.equal(drafts.length, playable);
    assert.equal(drafts.length, 2);
  });

  test('轮空者不出现在任何一场比赛里', () => {
    const plan = planned();
    const drafts = buildBracketMatches(plan, { event: theEvent() });
    const playing = new Set(drafts.flatMap((d) => [...d.teamA, ...d.teamB]));
    assert.ok(plan.byes.every((id) => !playing.has(id)));
  });

  test('每场都带 eventId 与轮次/阶段/签位，且签位互不重复', () => {
    const plan = planned();
    const drafts = buildBracketMatches(plan, { event: theEvent() });

    const slots = drafts.map((d) => d.slot);
    assert.equal(new Set(slots).size, slots.length);

    for (const draft of drafts) {
      assert.equal(draft.eventId, 'e9');
      assert.equal(draft.round, 1);
      assert.equal(draft.stage, BRACKET_STAGE.MAIN);
      assert.equal(draft.matchType, MATCH_TYPE.SINGLES);
      assert.equal(draft.pool, MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES]);
      assert.equal(draft.teamA.length, 1);
      assert.equal(draft.teamB.length, 1);
      // 还没开打：比分空、胜方未知、录入人待赛后补
      assert.deepEqual(draft.scoreA, []);
      assert.deepEqual(draft.scoreB, []);
      assert.equal(draft.winner, null);
      assert.equal(draft.recorder, null);
      assert.equal(draft.location, '体育馆');
      assert.equal(new Date(draft.matchTime).toISOString(), new Date('2026-09-20T09:00:00').toISOString());
      assert.equal(draft.gamePoints, DEFAULT_FORMAT.gamePoints);
      assert.equal(draft.bestOf, DEFAULT_FORMAT.bestOf);
    }
  });

  test('同一签位上的编号与抽签结果无关——重抽才能覆盖而不是追加', () => {
    const a = buildBracketMatches(planned(1), { event: theEvent() });
    const b = buildBracketMatches(planned(2), { event: theEvent() });
    assert.deepEqual(
      a.map((d) => d._id).sort(),
      b.map((d) => d._id).sort()
    );
  });

  test('对局双方都来自参赛者', () => {
    const plan = planned();
    const entries = new Set(plan.entries);
    for (const draft of buildBracketMatches(plan, { event: theEvent() })) {
      assert.ok(entries.has(draft.teamA[0]));
      assert.ok(entries.has(draft.teamB[0]));
      assert.notEqual(draft.teamA[0], draft.teamB[0]);
    }
  });

  test('抽签失败或赛事缺失时不产出任何比赛', () => {
    assert.deepEqual(buildBracketMatches({ ok: false }, { event: theEvent() }), []);
    assert.deepEqual(buildBracketMatches(null, { event: theEvent() }), []);
    assert.deepEqual(buildBracketMatches(planned(), { event: null }), []);
  });
});

describe('canRedraw —— 重抽前置', () => {
  test('尚无比赛时可重抽', () => {
    assert.equal(canRedraw([]), true);
  });

  test('全部尚未确认时仍可重抽', () => {
    assert.equal(canRedraw([{ status: MATCH_STATUS.PENDING }]), true);
  });

  test('已有比赛生效（已计 elo）即禁止重抽', () => {
    assert.equal(
      canRedraw([{ status: MATCH_STATUS.PENDING }, { status: MATCH_STATUS.ACTIVE }]),
      false
    );
  });
});

/* ============================================================
 * 逐轮推进（决策 5.2）
 * ============================================================ */

/** 该赛事的一场既有比赛：编号由轮次 / 阶段 / 签位确定 */
function eventMatchRecord(eventId, round, stage, slot, winner, status = MATCH_STATUS.ACTIVE) {
  return { _id: eventMatchKey(eventId, round, stage, slot), round, stage, slot, winner, status };
}

describe('planNextRound —— 逐轮推进', () => {
  const eventId = 'e1';
  // 4 人 4 签：首轮两场，胜者会师决赛
  const fourDraw = { size: 4, slots: ['u1', 'u2', 'u3', 'u4'] };

  test('首轮没打完，排不出下一轮', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      matches: [eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A')],
    });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.rounds, []);
  });

  test('待确认的比赛不算打完，照样排不出下一轮', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A', MATCH_STATUS.PENDING),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
      ],
    });
    assert.equal(plan.ok, false);
  });

  test('首轮全部生效，按签位排出决赛对阵', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'), // u1 胜 u2
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'), // u4 胜 u3
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.rounds.length, 1);
    assert.deepEqual(plan.rounds[0], {
      round: 2,
      stage: BRACKET_STAGE.MAIN,
      pairs: [['u1', 'u4']],
    });
  });

  test('打三四名：半决赛结束同时排出决赛与季军赛', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'), // 负者 u2
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'), // 负者 u3
      ],
    });
    const bronze = plan.rounds.find((round) => round.stage === BRACKET_STAGE.BRONZE);
    assert.deepEqual(bronze, {
      round: 2,
      stage: BRACKET_STAGE.BRONZE,
      pairs: [['u2', 'u3']],
    });
  });

  test('并列季军：只排决赛，不生成季军赛', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
      ],
    });
    assert.equal(plan.rounds.length, 1);
    assert.equal(plan.rounds[0].stage, BRACKET_STAGE.MAIN);
  });

  test('下一轮已排过（哪怕还只是待确认）就不再返回，免得抹掉已录比分', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
        eventMatchRecord(eventId, 2, BRACKET_STAGE.MAIN, 0, null, MATCH_STATUS.PENDING),
      ],
    });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.rounds, []);
  });

  test('决赛打完，签表到头，不再产出任何对阵', () => {
    const plan = planNextRound({
      eventId,
      draw: fourDraw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 0, 'A'),
        eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'B'),
        eventMatchRecord(eventId, 2, BRACKET_STAGE.MAIN, 0, 'A'),
      ],
    });
    assert.equal(plan.ok, false);
  });

  test('轮空的一方直接晋级，只等另一半区打完', () => {
    // 4 签少一人：u1 首轮轮空
    const draw = { size: 4, slots: ['u1', null, 'u3', 'u4'] };
    const plan = planNextRound({
      eventId,
      draw,
      bronzeMode: EVENT_BRONZE_MODE.TIED,
      matches: [eventMatchRecord(eventId, 1, BRACKET_STAGE.MAIN, 1, 'A')], // u3 胜 u4
    });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.rounds[0].pairs, [['u1', 'u3']]);
  });

  test('没有签表就排不出对阵', () => {
    assert.equal(planNextRound({ eventId, draw: null }).ok, false);
    assert.equal(planNextRound({ eventId, draw: { slots: ['u1'] } }).ok, false);
  });
});

describe('buildRoundMatches —— 逐轮对阵生成', () => {
  const event = { _id: 'e7', location: '体育馆', startTime: '2026-06-10T09:00:00' };

  test('按对阵生成草稿，编号带轮次与阶段', () => {
    const drafts = buildRoundMatches(event, {
      round: 2,
      stage: BRACKET_STAGE.BRONZE,
      pairs: [['u2', 'u3']],
    });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]._id, eventMatchKey('e7', 2, BRACKET_STAGE.BRONZE, 0));
    assert.deepEqual(drafts[0].teamA, ['u2']);
    assert.deepEqual(drafts[0].teamB, ['u3']);
    assert.equal(drafts[0].winner, null);
    assert.deepEqual(drafts[0].scoreA, []);
    assert.equal(drafts[0].stage, BRACKET_STAGE.BRONZE);
    assert.equal(drafts[0].eventId, 'e7');
  });

  test('缺赛事或缺对阵一律返回空数组', () => {
    assert.deepEqual(buildRoundMatches(null, { round: 1, pairs: [['u1', 'u2']] }), []);
    assert.deepEqual(buildRoundMatches(event, { round: 1 }), []);
  });
});
