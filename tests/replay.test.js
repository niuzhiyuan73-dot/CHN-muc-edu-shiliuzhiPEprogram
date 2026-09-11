/**
 * 回放引擎 单元测试
 *
 * 回放是整个模拟数据的「地基」：比赛流水是原始事实，等级分是它推导出的
 * 结果。这里重点验证三件事：
 *   1. 分数链条严丝合缝——上一场的赛后分必须等于下一场的赛前分
 *   2. 池隔离——打双打不会动到单打的一分一毫
 *   3. 不污染入参——回放结束后原始数据必须原封不动
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { replaySeason, isLateJoiner } = require('../miniprogram/services/replay.js');
const { generateSeed } = require('../miniprogram/services/seed.js');
const { getPoolRating } = require('../miniprogram/utils/rating.js');
const { DEFAULT_CONFIG, initialRatingFor } = require('../miniprogram/utils/elo.js');
const {
  ALL_RATING_POOLS,
  MATCH_TYPE,
  RATING_POOL,
  MATCH_STATUS,
  EVENT_STATUS,
  EVENT_LEVEL,
} = require('../miniprogram/utils/constants.js');

/**
 * 当前默认初始分（男 1450 / 女 1300）。断言值从配置推导，
 * 调参后不必逐处改测试；无 gender 的会员按男会员处理。
 */
const MALE_START = DEFAULT_CONFIG.initialRating;
const FEMALE_START = initialRatingFor('F', DEFAULT_CONFIG);

/** 构造比赛记录 */
function match(id, matchType, teamA, teamB, winner, day = 1, eventId = null) {
  return {
    _id: id,
    matchType,
    teamA,
    teamB,
    winner,
    matchTime: new Date(`2026-05-${String(day).padStart(2, '0')}T18:00:00`),
    eventId,
    status: MATCH_STATUS.ACTIVE,
  };
}

const men = (id, teamA, teamB, winner, day, eventId) =>
  match(id, MATCH_TYPE.SINGLES, teamA, teamB, winner, day, eventId);

/**
 * 造一场已结束的赛事。积分只认「已结束」的赛事，所以默认就带上这个状态；
 * 要测「没结束不计分」时再覆盖 status。
 */
function event(id, matchType, results, patch = {}) {
  return {
    _id: id,
    matchType,
    endTime: new Date('2026-05-10T18:00:00'),
    status: EVENT_STATUS.FINISHED,
    results,
    ...patch,
  };
}

/** 按 id 取回放后的用户 */
const userOf = (result, id) => result.users.find((u) => u._id === id);

describe('replaySeason —— 基本行为', () => {
  test('没有任何比赛时，所有人停留在初始分且零场次', () => {
    const members = [{ _id: 'a', nickName: '甲' }, { _id: 'b', nickName: '乙' }];
    const result = replaySeason({ members, matches: [] });

    assert.equal(result.matches.length, 0);
    for (const user of result.users) {
      assert.equal(getPoolRating(user, RATING_POOL.SINGLES).elo, MALE_START);
      assert.equal(getPoolRating(user, RATING_POOL.SINGLES).matchCount, 0);
      assert.equal(user.points, 0);
    }
  });

  test('一场比赛后胜者加分、负者减分', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({ members, matches: [men('m1', ['a'], ['b'], 'A', 1)] });

    assert.equal(getPoolRating(userOf(result, 'a'), RATING_POOL.SINGLES).elo, MALE_START + 16);
    assert.equal(getPoolRating(userOf(result, 'b'), RATING_POOL.SINGLES).elo, MALE_START - 16);
  });

  test('场次与胜负记录正确累计', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1), men('m2', ['a'], ['b'], 'B', 2)],
    });

    const a = getPoolRating(userOf(result, 'a'), RATING_POOL.SINGLES);
    const b = getPoolRating(userOf(result, 'b'), RATING_POOL.SINGLES);
    assert.equal(a.matchCount, 2);
    assert.equal(a.wins, 1);
    assert.equal(a.losses, 1);
    assert.equal(b.matchCount, 2);
    assert.equal(b.wins, 1);
    assert.equal(b.losses, 1);
  });

  test('记录赛前与赛后的分数，便于展示「这一场加了几分」', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({ members, matches: [men('m1', ['a'], ['b'], 'A', 1)] });

    const [detail] = result.matches[0].players;
    assert.equal(detail.userId, 'a');
    assert.equal(detail.side, 'A');
    assert.equal(detail.isWin, true);
    assert.equal(detail.eloBefore, MALE_START);
    assert.equal(detail.eloAfter, MALE_START + 16);
    assert.equal(detail.eloDelta, 16);
    assert.equal(detail.eloBefore + detail.eloDelta, detail.eloAfter);
  });

  test('比赛被标记为已生效并带上所属池', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({ members, matches: [men('m1', ['a'], ['b'], 'A', 1)] });
    assert.equal(result.matches[0].status, MATCH_STATUS.ACTIVE);
    assert.equal(result.matches[0].pool, RATING_POOL.SINGLES);
  });
});

describe('replaySeason —— 分数链条', () => {
  test('上一场的赛后分等于下一场的赛前分', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
    const matches = [
      men('m1', ['a'], ['b'], 'A', 1),
      men('m2', ['a'], ['c'], 'B', 2),
      men('m3', ['b'], ['c'], 'A', 3),
      men('m4', ['a'], ['b'], 'B', 4),
    ];
    const result = replaySeason({ members, matches });

    const lastSeen = {};
    for (const m of result.matches) {
      for (const p of m.players) {
        const key = p.userId + '|' + p.pool;
        if (lastSeen[key] !== undefined) {
          assert.equal(
            p.eloBefore,
            lastSeen[key],
            `${p.userId} 在比赛 ${m._id} 的赛前分与上一场赛后分对不上`
          );
        }
        lastSeen[key] = p.eloAfter;
      }
    }
  });

  test('入参乱序也能正确处理（内部会按时间重排）', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const ordered = [men('m1', ['a'], ['b'], 'A', 1), men('m2', ['a'], ['b'], 'A', 5)];
    const shuffledInput = [ordered[1], ordered[0]];

    const a = replaySeason({ members, matches: ordered });
    const b = replaySeason({ members, matches: shuffledInput });
    assert.deepEqual(a.users, b.users);
    assert.deepEqual(a.matches.map((m) => m._id), ['m1', 'm2']);
  });

  test('最终分数与逐场明细的累加结果一致', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1), men('m2', ['b'], ['a'], 'B', 2)],
    });

    for (const user of result.users) {
      const deltas = result.matches
        .flatMap((m) => m.players)
        .filter((p) => p.userId === user._id)
        .reduce((sum, p) => sum + p.eloDelta, 0);
      assert.equal(getPoolRating(user, RATING_POOL.SINGLES).elo, MALE_START + deltas);
    }
  });
});

describe('replaySeason —— 池隔离', () => {
  const fourPlayers = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }, { _id: 'd' }];

  test('打双打不会影响单打的分数和场次', () => {
    const result = replaySeason({
      members: fourPlayers,
      matches: [match('m1', MATCH_TYPE.DOUBLES, ['a', 'b'], ['c', 'd'], 'A', 1)],
    });

    for (const user of result.users) {
      assert.equal(getPoolRating(user, RATING_POOL.SINGLES).elo, MALE_START, `${user._id} 的单打被污染`);
      assert.equal(getPoolRating(user, RATING_POOL.SINGLES).matchCount, 0);
    }
  });

  test('双打同队两人获得完全相同的分数变动', () => {
    const result = replaySeason({
      members: fourPlayers,
      matches: [match('m1', MATCH_TYPE.DOUBLES, ['a', 'b'], ['c', 'd'], 'A', 1)],
    });

    const a = getPoolRating(userOf(result, 'a'), RATING_POOL.DOUBLES);
    const b = getPoolRating(userOf(result, 'b'), RATING_POOL.DOUBLES);
    const c = getPoolRating(userOf(result, 'c'), RATING_POOL.DOUBLES);
    assert.equal(a.elo, b.elo);
    assert.equal(c.elo, a.elo - 32); // 一加一减，差值正好是两倍变动量
  });

  test('双打池的分数总和守恒', () => {
    const result = replaySeason({
      members: fourPlayers,
      matches: [match('m1', MATCH_TYPE.DOUBLES, ['a', 'b'], ['c', 'd'], 'A', 1)],
    });
    const total = result.users.reduce(
      (sum, u) => sum + getPoolRating(u, RATING_POOL.DOUBLES).elo,
      0
    );
    assert.equal(total, 4 * MALE_START);
  });

  test('两个池互不干扰：各自的场次独立统计', () => {
    const result = replaySeason({
      members: fourPlayers,
      matches: [
        men('m1', ['a'], ['b'], 'A', 1),
        match('m2', MATCH_TYPE.DOUBLES, ['a', 'b'], ['c', 'd'], 'A', 2),
      ],
    });

    const a = userOf(result, 'a');
    assert.equal(getPoolRating(a, RATING_POOL.SINGLES).matchCount, 1);
    assert.equal(getPoolRating(a, RATING_POOL.DOUBLES).matchCount, 1);
  });
});

describe('replaySeason —— 元老一律从默认初始分起步', () => {
  test('无论首场排在第几场，元老的起点分都严格等于默认初始分', () => {
    // 这些会员都没有 joinDate，按规则属于「赛季一开始就在册」的元老。
    // 元老不适用新人定级规则，起点分必须是初始分（当前 1450）——如果按池内
    // 中位数兜底，先出场的人先定级、后出场的人就会被带偏。
    const members = [
      { _id: 'a' }, { _id: 'b' }, { _id: 'c' },
      { _id: 'd' }, { _id: 'e' }, { _id: 'f' },
      { _id: 'g' },
    ];

    // 前五场让 a 连胜 b/c/d/e/f，池内分数已经散开；
    // g 直到第六场才第一次出场，此时若按中位数定级必然偏离初始分。
    const warmup = ['b', 'c', 'd', 'e', 'f'].map((opponent, i) =>
      men('w' + i, ['a'], [opponent], 'A', i + 1)
    );
    const result = replaySeason({
      members,
      matches: [...warmup, men('m1', ['g'], ['a'], 'B', 6)],
    });

    const g = getPoolRating(userOf(result, 'g'), RATING_POOL.SINGLES);
    assert.equal(g.startElo, MALE_START, '元老即使很晚才首秀，起点也必须是初始分');

    // 顺带确认池内确实已经散开，否则这条断言没有区分度
    const peerRatings = ['a', 'b', 'c', 'd', 'e', 'f'].map(
      (id) => getPoolRating(userOf(result, id), RATING_POOL.SINGLES).elo
    );
    assert.ok(Math.max(...peerRatings) > MALE_START, '池中应已有人高于初始分');
    assert.ok(Math.min(...peerRatings) < MALE_START, '池中应已有人低于初始分');
  });

  test('各池分别起步：只打过单打的人，双打起点分同样是默认初始分', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1)],
    });

    const a = userOf(result, 'a');
    assert.equal(getPoolRating(a, RATING_POOL.SINGLES).startElo, MALE_START);
    assert.equal(getPoolRating(a, RATING_POOL.DOUBLES).startElo, MALE_START);
    assert.equal(getPoolRating(a, RATING_POOL.DOUBLES).matchCount, 0);
  });

  test('自定义初始分会一路贯穿到所有人的起点分', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1)],
      options: { eloConfig: { initialRating: 1200 } },
    });
    assert.equal(getPoolRating(userOf(result, 'a'), RATING_POOL.SINGLES).elo, 1216);
    assert.equal(getPoolRating(userOf(result, 'b'), RATING_POOL.SINGLES).elo, 1184);
  });
});

describe('replaySeason —— 新人定级', () => {
  const FOUNDED = '2026-01-01T00:00:00';
  const LATE = '2026-05-10T00:00:00';

  /** 赛季开始前就在册的元老 */
  const founder = (id) => ({ _id: id, joinDate: FOUNDED });

  // 六位元老先在五月打出一批有区分度的分数：
  //   a 连胜 b 五场 → a≈1567，b≈1433；
  //   c 胜 d 一场   → c≈1516，d≈1484。
  // 后加入者 g 紧接着和这些人交手，就能验证「按对手水平定级」。
  const roster = [
    founder('a'), founder('b'), founder('c'),
    founder('d'), founder('e'), founder('f'),
    { _id: 'g', joinDate: LATE },
  ];

  const warmup = [
    ...[1, 2, 3, 4, 5].map((day) => men('wb' + day, ['a'], ['b'], 'A', day)),
    men('wd', ['c'], ['d'], 'A', 1),
  ];

  /** 取某场比赛里某位选手的赛前分 */
  const eloBeforeOf = (result, matchId, userId) =>
    result.matches.find((m) => m._id === matchId).players.find((p) => p.userId === userId)
      .eloBefore;

  test('后加入者击败对手后，按赢过的最高对手分向下取到 50 的倍数定级', () => {
    const result = replaySeason({
      members: roster,
      matches: [...warmup, men('g1', ['g'], ['a'], 'A', 20)],
    });

    const opponentBefore = eloBeforeOf(result, 'g1', 'a');
    const expected = Math.floor(opponentBefore / 50) * 50;
    assert.ok(expected > MALE_START, `对手赛前分 ${opponentBefore} 不足以验证「按对手定级」`);

    assert.equal(result.meta.placements.g.singles, expected);
    assert.equal(getPoolRating(userOf(result, 'g'), RATING_POOL.SINGLES).startElo, expected);
    // 定级结果要落到第一场上：他的第一场比赛就是从定级分起步
    assert.equal(eloBeforeOf(result, 'g1', 'g'), expected);
  });

  test('后加入者一场未胜时按最低对手分定级，并封顶在默认初始分', () => {
    // 输给高分对手 a（约 1517）：按最低对手分向下取整是 1500，
    // 但全败者不能凭「输给高手」证明自己强，因此被默认初始分 1450 封顶。
    const result = replaySeason({
      members: roster,
      matches: [...warmup, men('g1', ['g'], ['a'], 'B', 20)],
    });

    const opponentBefore = eloBeforeOf(result, 'g1', 'a');
    assert.ok(Math.floor(opponentBefore / 50) * 50 > MALE_START, '需要对手分足够高才能验证封顶');

    assert.equal(result.meta.placements.g.singles, MALE_START);
    assert.equal(getPoolRating(userOf(result, 'g'), RATING_POOL.SINGLES).startElo, MALE_START);
  });

  test('后加入者全败且对手较弱时，按最低对手分向下取整（不触发封顶）', () => {
    // 输给弱手 b（约 1383）→ 向下取整 1350，低于封顶值，说明封顶只在
    // 对手分本就高于默认初始分时才起作用。
    const result = replaySeason({
      members: roster,
      matches: [...warmup, men('g1', ['g'], ['b'], 'B', 20)],
    });

    const opponentBefore = eloBeforeOf(result, 'g1', 'b');
    const expected = Math.floor(opponentBefore / 50) * 50;
    assert.ok(expected < MALE_START, `对手赛前分 ${opponentBefore} 应低于初始分才有区分度`);

    assert.equal(result.meta.placements.g.singles, expected);
    assert.equal(getPoolRating(userOf(result, 'g'), RATING_POOL.SINGLES).startElo, expected);
  });

  test('定级只看前 5 场：第 6 场战胜强手也不会抬高初始分', () => {
    // 前五场全败给弱手 b，第六场才赢下强手 a。
    // 若把第六场也算进定级依据，初始分会明显更高；只取前五场则应看 b 的分。
    const losses = [11, 12, 13, 14, 15].map((day, i) =>
      men('gl' + i, ['g'], ['b'], 'B', day)
    );
    const result = replaySeason({
      members: roster,
      matches: [...warmup, ...losses, men('gw', ['g'], ['a'], 'A', 20)],
    });

    const bBefore = eloBeforeOf(result, 'gl0', 'b');
    const expected = Math.floor(bBefore / 50) * 50;
    const aBefore = eloBeforeOf(result, 'gw', 'a');

    assert.equal(result.meta.placements.g.singles, expected);
    assert.ok(
      Math.floor(aBefore / 50) * 50 > expected,
      '第 6 场对手更强，若被计入定级，结果会不同——这样才能证明窗口确实截在前 5 场'
    );
  });

  test('meta.placements 只记录后加入者，并按池分别给出初始分', () => {
    const result = replaySeason({
      members: roster,
      matches: [
        ...warmup,
        men('g1', ['g'], ['a'], 'A', 20),
        match('g2', MATCH_TYPE.DOUBLES, ['g', 'b'], ['c', 'd'], 'B', 21),
      ],
    });

    // 元老不在定级记录里
    assert.equal(result.meta.placements.a, undefined);
    assert.deepEqual(Object.keys(result.meta.placements), ['g']);

    // 单打、双打各自定级，且都向下取到 50 的倍数
    assert.deepEqual(
      Object.keys(result.meta.placements.g).sort(),
      [RATING_POOL.DOUBLES, RATING_POOL.SINGLES]
    );
    for (const rating of Object.values(result.meta.placements.g)) {
      assert.equal(rating % 50, 0, `定级分 ${rating} 不是 50 的倍数`);
    }
    // 单打：赢过元老 a（赛前约 1517）→ 向下取整 1500。
    // 双打：全败给 c/d（赛前均分约 1450）→ 1450，正好等于默认初始分。
    assert.equal(result.meta.placements.g.singles, 1500);
    assert.equal(result.meta.placements.g.doubles, MALE_START);
  });

  test('没有比赛时不产生任何定级记录', () => {
    const result = replaySeason({ members: roster, matches: [] });
    assert.deepEqual(result.meta.placements, {});
  });

  test('isLateJoiner 以「严格晚于赛季首场」为界', () => {
    const seasonStart = new Date('2026-05-01T18:00:00').getTime();
    assert.equal(isLateJoiner({ joinDate: '2026-04-30T00:00:00' }, seasonStart), false);
    // 与首场比赛同一时刻入会算元老，不算中途入会
    assert.equal(isLateJoiner({ joinDate: '2026-05-01T18:00:00' }, seasonStart), false);
    assert.equal(isLateJoiner({ joinDate: '2026-05-02T00:00:00' }, seasonStart), true);
    // 缺字段时保守判定为元老，避免误把数据不全的人当成新人定级
    assert.equal(isLateJoiner({}, seasonStart), false);
    assert.equal(isLateJoiner({ joinDate: '2026-05-02T00:00:00' }, NaN), false);
  });
});

describe('replaySeason —— 积分', () => {
  test('日常比赛不产生任何积分（决策 9）', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [
        men('m1', ['a'], ['b'], 'A', 1),
        men('m2', ['a'], ['b'], 'B', 2),
        men('m3', ['a'], ['b'], 'A', 3),
      ],
    });
    // 赢也好输也好，约球都不给分
    assert.equal(userOf(result, 'a').points, 0);
    assert.equal(userOf(result, 'b').points, 0);
  });

  test('赛事按最终名次计分：冠军 2 + 20，亚军 2 + 14', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1, 'e01')],
      events: [
        event('e01', MATCH_TYPE.SINGLES, [
          { userId: 'a', placement: 1 },
          { userId: 'b', placement: 2 },
        ]),
      ],
    });
    assert.equal(userOf(result, 'a').points, 22);
    assert.equal(userOf(result, 'b').points, 16);
  });

  test('等级赛事放大名次分：一级赛冠军 2 + 20 × 4', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1, 'e01')],
      events: [
        event(
          'e01',
          MATCH_TYPE.SINGLES,
          [{ userId: 'a', placement: 1 }],
          { level: EVENT_LEVEL.FIRST }
        ),
      ],
    });
    assert.equal(userOf(result, 'a').points, 82);
  });

  test('双打赛事不计分（决策 3）', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }, { _id: 'd' }];
    const result = replaySeason({
      members,
      matches: [
        match('m1', MATCH_TYPE.DOUBLES, ['a', 'b'], ['c', 'd'], 'A', 1, 'e01'),
      ],
      events: [
        event('e01', MATCH_TYPE.DOUBLES, [
          { userId: 'a', placement: 1 },
          { userId: 'b', placement: 1 },
        ]),
      ],
    });
    assert.equal(userOf(result, 'a').points, 0);
    assert.equal(userOf(result, 'b').points, 0);
  });

  test('未结束的赛事不计分', () => {
    const members = [{ _id: 'a' }];
    const result = replaySeason({
      members,
      matches: [],
      events: [
        event('e01', MATCH_TYPE.SINGLES, [{ userId: 'a', placement: 1 }], { status: 1 }),
      ],
    });
    assert.equal(userOf(result, 'a').points, 0);
  });

  test('赛季分界之前的赛事属于上个赛季，不计入本赛季', () => {
    const members = [{ _id: 'a' }];
    const result = replaySeason({
      members,
      matches: [],
      events: [
        // 重置日 6月1日；这场赛事 5月10日结束，早于分界
        event('e_old', MATCH_TYPE.SINGLES, [{ userId: 'a', placement: 1 }]),
        event(
          'e_new',
          MATCH_TYPE.SINGLES,
          [{ userId: 'a', placement: 1 }],
          { endTime: new Date('2026-06-05T18:00:00') }
        ),
      ],
      options: { resetTime: '2026-06-01T00:00:00' },
    });
    // 只有分界之后那场算数
    assert.equal(userOf(result, 'a').points, 22);
  });

  test('赛事归属按结束时刻（finishedAt）算，不被计划开赛时间带偏', () => {
    const members = [{ _id: 'a' }];
    const result = replaySeason({
      members,
      matches: [],
      events: [
        // 计划 5/20 开赛（早于 6/1 分界），实际 6/3 才录入名次收尾。
        // app 里发布的赛事只有计划开赛时间，若拿它当结束时间，这场就被
        // 错算进上个赛季——积分凭空消失。
        event('e01', MATCH_TYPE.SINGLES, [{ userId: 'a', placement: 1 }], {
          startTime: new Date('2026-05-20T18:00:00'),
          finishedAt: new Date('2026-06-03T18:00:00'),
        }),
      ],
      options: { resetTime: '2026-06-01T00:00:00' },
    });
    assert.equal(userOf(result, 'a').points, 22);
  });

  test('历史 / 种子赛事没有 finishedAt，退回 endTime 判归属', () => {
    const members = [{ _id: 'a' }];
    const result = replaySeason({
      members,
      matches: [],
      events: [
        // 只有 endTime（5/10），早于 6/1 分界 → 属于上个赛季
        event('e_old', MATCH_TYPE.SINGLES, [{ userId: 'a', placement: 1 }]),
      ],
      options: { resetTime: '2026-06-01T00:00:00' },
    });
    assert.equal(userOf(result, 'a').points, 0);
  });

  test('同一赛事打多轮，积分只结在最后一场（2.5）', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
    const result = replaySeason({
      members,
      matches: [
        men('m1', ['a'], ['b'], 'A', 1, 'e01'),
        men('m2', ['a'], ['c'], 'A', 2, 'e01'),
      ],
      events: [
        event('e01', MATCH_TYPE.SINGLES, [
          { userId: 'a', placement: 1 },
          { userId: 'b', placement: 2 },
          { userId: 'c', placement: 3 },
        ]),
      ],
    });

    const deltaOn = (matchId, userId) =>
      result.matches
        .find((m) => m._id === matchId)
        .players.find((p) => p.userId === userId).pointDelta;

    // 冠军的 22 分结在决赛（m2），半决赛那场是 0
    assert.equal(deltaOn('m1', 'a'), 0);
    assert.equal(deltaOn('m2', 'a'), 22);
    // 亚军只打了一场，就结在那一场
    assert.equal(deltaOn('m1', 'b'), 16);
    assert.equal(userOf(result, 'c').points, 12);
  });

  test('总分等于各场积分变动之和', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
    const result = replaySeason({
      members,
      matches: [
        men('m1', ['a'], ['b'], 'A', 1, 'e01'),
        men('m2', ['b'], ['c'], 'A', 2, 'e01'),
        men('m3', ['a'], ['c'], 'B', 3, 'e02'),
      ],
      events: [
        event('e01', MATCH_TYPE.SINGLES, [
          { userId: 'a', placement: 1 },
          { userId: 'b', placement: 2 },
        ]),
        event('e02', MATCH_TYPE.SINGLES, [{ userId: 'c', placement: 1 }]),
      ],
    });

    for (const user of result.users) {
      const sum = result.matches
        .flatMap((m) => m.players)
        .filter((p) => p.userId === user._id)
        .reduce((acc, p) => acc + p.pointDelta, 0);
      assert.equal(user.points, sum, `${user._id} 的积分与明细对不上`);
    }
  });
});

describe('replaySeason —— 数据卫生', () => {
  test('不修改传入的 members 与 matches', () => {
    const members = [
      { _id: 'a', nickName: '甲', trueSkill: 1600 },
      { _id: 'b', nickName: '乙', trueSkill: 1200 },
    ];
    const matches = [men('m1', ['a'], ['b'], 'A', 1)];

    const membersSnapshot = JSON.stringify(members);
    const matchesSnapshot = JSON.stringify(matches);

    replaySeason({ members, matches });

    assert.equal(JSON.stringify(members), membersSnapshot);
    assert.equal(JSON.stringify(matches), matchesSnapshot);
  });

  test('隐藏实力等内部字段不出现在对外数据中', () => {
    const members = [{ _id: 'a', nickName: '甲', trueSkill: 1600, joinWeek: 3 }];
    const result = replaySeason({ members, matches: [] });

    assert.equal(result.users[0].trueSkill, undefined);
    assert.equal(result.users[0].joinWeek, undefined);
    assert.equal(result.users[0].nickName, '甲');
  });

  test('赛事数据原样透传', () => {
    const events = [{ _id: 'e01', title: '四月男子单打赛' }];
    const result = replaySeason({ members: [{ _id: 'a' }], matches: [], events });
    assert.deepEqual(result.events, events);
    // 是副本，不是同一个引用
    assert.notEqual(result.events[0], events[0]);
  });

  test('meta 汇总了回放规模与时间范围', () => {
    const members = [{ _id: 'a' }, { _id: 'b' }];
    const result = replaySeason({
      members,
      matches: [men('m2', ['a'], ['b'], 'A', 5), men('m1', ['a'], ['b'], 'A', 1)],
    });
    assert.equal(result.meta.matchCount, 2);
    assert.equal(result.meta.userCount, 2);
    assert.deepEqual(result.meta.firstMatchTime, new Date('2026-05-01T18:00:00'));
    assert.deepEqual(result.meta.lastMatchTime, new Date('2026-05-05T18:00:00'));
  });
});

describe('replaySeason —— 异常输入', () => {
  test('members 不是数组时抛出错误', () => {
    assert.throws(() => replaySeason({ members: null, matches: [] }), /members 必须是数组/);
  });

  test('matches 不是数组时抛出错误', () => {
    assert.throws(() => replaySeason({ members: [], matches: null }), /matches 必须是数组/);
  });

  test('比赛引用了不存在的会员时抛出错误', () => {
    assert.throws(
      () =>
        replaySeason({
          members: [{ _id: 'a' }],
          matches: [men('m1', ['a'], ['ghost'], 'A', 1)],
        }),
      /不在会员名单中/
    );
  });

  test('未知的比赛类型时抛出错误', () => {
    assert.throws(
      () =>
        replaySeason({
          members: [{ _id: 'a' }, { _id: 'b' }],
          matches: [match('m1', 99, ['a'], ['b'], 'A', 1)],
        }),
      /无法映射到等级分池/
    );
  });
});

describe('回放真实模拟数据 —— 端到端', () => {
  const raw = generateSeed();
  const result = replaySeason(raw);

  test('产出规模与输入一致', () => {
    assert.equal(result.users.length, raw.members.length);
    assert.equal(result.matches.length, raw.matches.length);
  });

  test('每位参赛者都至少有一场比赛记录', () => {
    // 除了从未出场的会员，其余人应有战绩
    const played = result.users.filter((u) =>
      ALL_RATING_POOLS.some((p) => getPoolRating(u, p).matchCount > 0)
    );
    assert.ok(played.length >= result.users.length - 1);
  });

  test('总场次与比赛流水吻合', () => {
    for (const user of result.users) {
      const count = ALL_RATING_POOLS
        .reduce((sum, p) => sum + getPoolRating(user, p).matchCount, 0);
      const appearances = result.matches
        .flatMap((m) => m.players)
        .filter((p) => p.userId === user._id).length;
      assert.equal(count, appearances, `${user.nickName} 的场次统计对不上`);
    }
  });

  test('等级分与隐藏真实水平高度相关（回放确实收敛了）', () => {
    // 这条断言是整个模拟方案的价值所在：如果等级分和真实水平无关，
    // 说明算法或参数出了问题，生成的数据也就失去意义。
    const truth = {};
    for (const m of raw.members) truth[m._id] = m.trueSkill;

    const rows = result.users
      .map((u) => ({
        elo: getPoolRating(u, RATING_POOL.DOUBLES).elo,
        truth: truth[u._id],
        count: getPoolRating(u, RATING_POOL.DOUBLES).matchCount,
      }))
      .filter((r) => r.count >= 20);

    const n = rows.length;
    const mx = rows.reduce((s, r) => s + r.elo, 0) / n;
    const my = rows.reduce((s, r) => s + r.truth, 0) / n;
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (const r of rows) {
      cov += (r.elo - mx) * (r.truth - my);
      vx += (r.elo - mx) ** 2;
      vy += (r.truth - my) ** 2;
    }
    const correlation = cov / Math.sqrt(vx * vy);
    assert.ok(correlation > 0.6, `双打等级分与真实水平的相关系数仅 ${correlation.toFixed(3)}`);
  });

  test('每个池的分数总和守恒（零和未被打破）', () => {
    // 起点分按性别取（男 1450 / 女 1300），基准值不再是简单的「起点 × 人数」，
    // 而要把每位会员自己的初始分加总。新人定级会在这个基准上再引入少量偏移，
    // 但只要零和没被打破，总偏移就只等于「定级分 − 初始分」之和，不随时间膨胀。
    const ideal = raw.members.reduce(
      (sum, m) => sum + initialRatingFor(m.gender, DEFAULT_CONFIG),
      0
    );

    for (const pool of ALL_RATING_POOLS) {
      const total = result.users.reduce((s, u) => s + getPoolRating(u, pool).elo, 0);
      assert.ok(
        Math.abs(total - ideal) < 500,
        `${pool} 总分 ${total}，偏离基准 ${ideal} 过多`
      );
    }
  });

  test('只有中途入会者进入 placements，且定级分都是 50 的倍数', () => {
    // 赛季首场的时间就是「元老 / 新人」的分界线
    const seasonStart = Math.min(
      ...raw.matches.map((m) => new Date(m.matchTime).getTime())
    );
    const lateIds = raw.members
      .filter((m) => new Date(m.joinDate).getTime() > seasonStart)
      .map((m) => m._id)
      .sort();

    assert.ok(lateIds.length > 0, '整份数据里没有中途入会者，这条测试没有区分度');
    assert.deepEqual(Object.keys(result.meta.placements).sort(), lateIds);

    for (const pools of Object.values(result.meta.placements)) {
      for (const rating of Object.values(pools)) {
        assert.equal(rating % 50, 0, `定级分 ${rating} 不是 50 的倍数`);
      }
    }
  });

  test('榜单具备区分度：头尾分差足够大', () => {
    const elos = result.users
      .map((u) => getPoolRating(u, RATING_POOL.DOUBLES).elo)
      .sort((a, b) => a - b);
    const spread = elos[elos.length - 1] - elos[0];
    assert.ok(spread > 150, `双打榜头尾只差 ${spread} 分，榜单看不出差距`);
  });
});

describe('replaySeason —— 按性别取初始分', () => {
  test('创始会员分性别起步：男 1450，女 1300', () => {
    const members = [
      { _id: 'a', nickName: '男甲', gender: 'M' },
      { _id: 'b', nickName: '女甲', gender: 'F' },
    ];
    const result = replaySeason({
      members,
      matches: [men('m1', ['a'], ['b'], 'A', 1)],
    });

    assert.equal(
      getPoolRating(userOf(result, 'a'), RATING_POOL.SINGLES).startElo,
      MALE_START,
      '男会员起点应为男会员默认初始分'
    );
    assert.equal(
      getPoolRating(userOf(result, 'b'), RATING_POOL.SINGLES).startElo,
      FEMALE_START,
      '女会员起点应为女会员默认初始分'
    );
    // 没打过的池同样按性别起步，否则个人主页会突然冒出一个偏高的双打分
    assert.equal(
      getPoolRating(userOf(result, 'b'), RATING_POOL.DOUBLES).startElo,
      FEMALE_START,
      '女会员的双打起点也应是女会员默认初始分'
    );
  });

  test('定级分优先于性别初始分：女新人赢过球就按赢过的最强者入场', () => {
    // 元老先打出高分，作为女新人定级的参照物
    const members = [
      { _id: 'a', joinDate: '2026-01-01T00:00:00' },
      { _id: 'b', joinDate: '2026-01-01T00:00:00' },
      { _id: 'g', gender: 'F', joinDate: '2026-05-05T00:00:00' },
    ];

    const warmup = [
      ...[1, 2, 3, 4, 5].map((day) => men('w' + day, ['a'], ['b'], 'A', day)),
      men('g1', ['g'], ['a'], 'A', 6),
      ...[7, 8, 9, 10].map((day) => men('g' + day, ['g'], ['b'], 'A', day)),
    ];

    const result = replaySeason({ members, matches: warmup });
    const start = getPoolRating(userOf(result, 'g'), RATING_POOL.SINGLES).startElo;

    assert.equal(
      start,
      result.meta.placements.g.singles,
      '起点分必须等于定级算出来的分数'
    );
    assert.ok(start > FEMALE_START, `赢了球的女新人应高于女会员默认初始分，实际 ${start}`);
  });

  test('全败的女新人封顶在女会员初始分，而不是男会员初始分', () => {
    const members = [
      { _id: 'a', joinDate: '2026-01-01T00:00:00' },
      { _id: 'b', joinDate: '2026-01-01T00:00:00' },
      { _id: 'g', gender: 'F', joinDate: '2026-05-05T00:00:00' },
    ];

    // 元老先连胜把分数打到默认初始分以上，女新人再连败五场。
    // 她的对手全在初始分之上，若不按性别封顶，最低对手向下取整必然高于女会员初始分。
    const warmup = [
      ...[1, 2, 3, 4, 5].map((day) => men('w' + day, ['a'], ['b'], 'A', day)),
      ...[6, 7, 8, 9, 10].map((day) => men('g' + day, ['g'], ['a'], 'B', day)),
    ];

    const result = replaySeason({ members, matches: warmup });
    const start = getPoolRating(userOf(result, 'g'), RATING_POOL.SINGLES).startElo;

    assert.equal(start, FEMALE_START, '一场未胜的女新人应被封顶在女会员初始分');
  });
});
