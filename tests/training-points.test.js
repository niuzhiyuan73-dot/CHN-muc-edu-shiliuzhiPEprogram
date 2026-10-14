/**
 * 训练积分事实 单元测试
 *
 * 训练积分不落成可增减的余额，而是从「已确认的报名记录」推导出一批事实，
 * 再由回放引擎统一叠加到赛季总分上（见 training-points.js 顶部注释）。
 * 这里验证三件事：
 *   1. 事实归一：只有「有效报名 + 已确认签到 + 训练未取消」才产生事实；
 *   2. 赛季边界：按训练发生时间（effectiveAt）切分，边界等于 resetTime 算新赛季；
 *   3. 叠加进回放：只动 points，绝不动 ELO / 场数 / 胜负（T18 / T23）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTrainingPointFacts,
  factsInSeason,
  applyTrainingPointFacts,
  TRAINING_POINT_AMOUNT,
  ATTENDANCE_STATUS,
} = require('../miniprogram/services/training-points.js');
const { replaySeason } = require('../miniprogram/services/replay.js');
const { getPoolRating } = require('../miniprogram/utils/rating.js');
const { DEFAULT_CONFIG } = require('../miniprogram/utils/elo.js');
const { RATING_POOL, MATCH_TYPE } = require('../miniprogram/utils/constants.js');

const MALE_START = DEFAULT_CONFIG.initialRating;

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-05-10T18:00:00Z').getTime();
const at = offset => new Date(T0 + offset).toISOString();

/** 一条训练主记录（只放积分会用到的字段） */
const training = (id, startAt, patch = {}) => ({ _id: id, startAt, status: 'published', ...patch });

/** 一条报名记录 */
const reg = (trainingId, userId, patch = {}) => ({
  trainingId,
  userId,
  signupStatus: 'registered',
  attendanceStatus: ATTENDANCE_STATUS.CONFIRMED,
  ...patch,
});

const userOf = (result, id) => result.users.find(u => u._id === id);
const ELO = u => getPoolRating(u, RATING_POOL.SINGLES);

describe('buildTrainingPointFacts —— 事实归一', () => {
  test('有效报名 + 已确认签到 + 训练未取消 → 一条事实，额度固定 1 分', () => {
    const facts = buildTrainingPointFacts({
      trainings: [training('t1', at(0))],
      registrations: [reg('t1', 'a')],
    });
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0], {
      sourceType: 'training',
      sourceId: 't1',
      userId: 'a',
      amount: TRAINING_POINT_AMOUNT,
      effectiveAt: at(0),
    });
    assert.equal(TRAINING_POINT_AMOUNT, 1);
  });

  test('未确认 / 未报名 / 训练取消 / 训练缺失，一律不产生事实', () => {
    const trainings = [training('t1', at(0)), training('t2', at(0), { status: 'canceled' })];
    const facts = buildTrainingPointFacts({
      trainings,
      registrations: [
        reg('t1', 'pending_user', { attendanceStatus: ATTENDANCE_STATUS.PENDING }),
        reg('t1', 'not_signed', { signupStatus: 'canceled' }),
        reg('t2', 'canceled_training'),
        reg('t_missing', 'ghost'),
      ],
    });
    assert.equal(facts.length, 0);
  });

  test('同一用户在同一训练上最多一条事实（脏数据去重）', () => {
    const facts = buildTrainingPointFacts({
      trainings: [training('t1', at(0))],
      registrations: [reg('t1', 'a'), reg('t1', 'a')],
    });
    assert.equal(facts.length, 1);
  });

  test('事实的 effectiveAt 跟随记在报名上的 pointEffectiveAt，缺失才退回训练 startAt', () => {
    const facts = buildTrainingPointFacts({
      trainings: [training('t1', at(0))],
      registrations: [
        reg('t1', 'a', { pointEffectiveAt: at(-DAY) }),
        reg('t1', 'b'),
      ],
    });
    const byUser = Object.fromEntries(facts.map(f => [f.userId, f.effectiveAt]));
    assert.equal(byUser.a, at(-DAY), '确认时从不可变 startAt 复制的归属时间优先');
    assert.equal(byUser.b, at(0), '缺失则退回训练 startAt');
  });
});

describe('factsInSeason —— 赛季边界（T16）', () => {
  const boundary = at(0);
  const facts = [
    { userId: 'a', amount: 1, effectiveAt: at(-DAY) },
    { userId: 'b', amount: 1, effectiveAt: boundary },
    { userId: 'c', amount: 1, effectiveAt: at(DAY) },
  ];

  test('无边界（从未重置）时统计全部', () => {
    assert.equal(factsInSeason(facts, null).length, 3);
  });

  test('边界等于 resetTime 算新赛季，更早的不计', () => {
    const within = factsInSeason(facts, boundary);
    assert.deepEqual(within.map(f => f.userId).sort(), ['b', 'c']);
  });

  test('effectiveAt 非法或缺失的事实，在有边界时一律不计', () => {
    const within = factsInSeason(
      [{ userId: 'x', amount: 1, effectiveAt: null }, { userId: 'y', amount: 1, effectiveAt: 'nope' }],
      boundary
    );
    assert.equal(within.length, 0);
  });
});

describe('applyTrainingPointFacts —— 只动积分', () => {
  test('按用户累加额度，未命中的会员原样返回（T20 隔离性）', () => {
    const users = [
      { _id: 'a', points: 5, ratings: { singles: { elo: 1500, matchCount: 3, wins: 2, losses: 1 } } },
      { _id: 'b', points: 9, ratings: { singles: { elo: 1400, matchCount: 1, wins: 0, losses: 1 } } },
    ];
    const before = JSON.parse(JSON.stringify(users[1]));
    const out = applyTrainingPointFacts(users, [
      { userId: 'a', amount: 1 },
      { userId: 'a', amount: 1 },
    ]);
    assert.equal(out[0].points, 7, '同一人多条事实累加');
    assert.deepEqual(out[1], before, '未被命中的会员一个字节都不变');
    assert.deepEqual(users[0].ratings, out[0].ratings, '等级分不受训练影响');
    assert.deepEqual(users[1].ratings, out[1].ratings);
  });

  test('带赛季边界时只叠加本赛季事实', () => {
    const users = [{ _id: 'a', points: 0 }];
    const facts = [
      { userId: 'a', amount: 1, effectiveAt: at(-DAY) },
      { userId: 'a', amount: 1, effectiveAt: at(0) },
    ];
    assert.equal(applyTrainingPointFacts(users, facts, { resetTime: at(0) })[0].points, 1);
  });

  test('事实数为 0 时原对象返回，不做无谓复制', () => {
    const users = [{ _id: 'a', points: 3 }];
    assert.equal(applyTrainingPointFacts(users, []), users);
  });

  test('事实超过 100 条也全部计入（重算不受翻页上限影响，T21）', () => {
    const users = [{ _id: 'a', points: 0 }];
    const facts = Array.from({ length: 150 }, () => ({ userId: 'a', amount: 1 }));
    assert.equal(applyTrainingPointFacts(users, facts)[0].points, 150);
  });
});

describe('replaySeason 叠加训练积分', () => {
  const members = [
    { _id: 'a', nickName: '甲' },
    { _id: 'b', nickName: '乙' },
  ];

  test('T23：无任何比赛但有一次确认训练 → 积分为 1，等级分保持初始值', () => {
    const facts = buildTrainingPointFacts({
      trainings: [training('t1', at(0))],
      registrations: [reg('t1', 'a')],
    });
    const result = replaySeason({ members, matches: [], options: { trainingPointFacts: facts } });

    const a = userOf(result, 'a');
    assert.equal(a.points, 1);
    assert.equal(ELO(a).elo, MALE_START, '训练不改变等级分');
    assert.equal(ELO(a).matchCount, 0);
    assert.equal(userOf(result, 'b').points, 0);
  });

  test('T19：同一用户不同训练各确认一次 → 每个训练各 +1', () => {
    const facts = buildTrainingPointFacts({
      trainings: [training('t1', at(0)), training('t2', at(DAY))],
      registrations: [reg('t1', 'a'), reg('t2', 'a')],
    });
    const result = replaySeason({ members, matches: [], options: { trainingPointFacts: facts } });
    assert.equal(userOf(result, 'a').points, 2);
  });

  test('T18：完整重算不丢不重复，且 ELO / 胜率 / 场数不受训练影响', () => {
    const matches = [
      { _id: 'm1', matchType: MATCH_TYPE.SINGLES, teamA: ['a'], teamB: ['b'], winner: 'A',
        matchTime: new Date(T0 - 2 * DAY), status: 'active' },
      { _id: 'm2', matchType: MATCH_TYPE.SINGLES, teamA: ['a'], teamB: ['b'], winner: 'B',
        matchTime: new Date(T0 - DAY), status: 'active' },
    ];
    const facts = buildTrainingPointFacts({
      trainings: [training('t1', at(0)), training('t2', at(DAY))],
      registrations: [reg('t1', 'a'), reg('t2', 'a')],
    });

    const without = replaySeason({ members, matches });
    const first = replaySeason({ members, matches, options: { trainingPointFacts: facts } });
    const second = replaySeason({ members, matches, options: { trainingPointFacts: facts } });

    for (const id of ['a', 'b']) {
      const clean = userOf(without, id);
      const scored = userOf(first, id);
      assert.deepEqual(ELO(scored).elo, ELO(clean).elo, `${id} 等级分不受训练影响`);
      assert.equal(ELO(scored).matchCount, ELO(clean).matchCount);
      assert.equal(ELO(scored).wins, ELO(clean).wins);
      assert.equal(ELO(scored).losses, ELO(clean).losses);
      assert.deepEqual({ ...scored.ratings }, { ...clean.ratings });
    }
    assert.equal(userOf(first, 'a').points, userOf(without, 'a').points + 2);
    assert.deepEqual(first.users, second.users, '同一批输入重算结果一致（不重复累加）');
  });

  test('赛季边界：训练发生在 resetTime 之前不计入本赛季（T16）', () => {
    const facts = buildTrainingPointFacts({
      trainings: [training('old', at(-DAY)), training('new', at(0))],
      registrations: [reg('old', 'a'), reg('new', 'a')],
    });
    const result = replaySeason({
      members,
      matches: [],
      options: { trainingPointFacts: facts, resetTime: at(0) },
    });
    assert.equal(userOf(result, 'a').points, 1, '只有边界当刻及之后的那次训练计分');
  });
});
