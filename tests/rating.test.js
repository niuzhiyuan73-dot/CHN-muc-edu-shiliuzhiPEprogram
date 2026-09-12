/**
 * 多池等级分状态管理单元测试
 *
 * 重点验证：男单、女单、双打三个池严格隔离，互不影响。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEmptyPoolRating,
  createEmptyRatings,
  getPoolRating,
  applyMatchResult,
  revertMatchResult,
  applySeasonalResetToUser,
  hasPlayedPool,
  summarizeCareer,
} = require('../miniprogram/utils/rating.js');

const { RATING_POOL, ALL_RATING_POOLS } = require('../miniprogram/utils/constants.js');
const { calculateMatchRatings, DEFAULT_CONFIG } = require('../miniprogram/utils/elo.js');

/** 未指定初始分时的默认值（当前 1450），随配置变化 */
const DEFAULT_ELO = DEFAULT_CONFIG.initialRating;

/** 构造一个新会员 */
const newUser = (id = 'u1', initialElo = 1500) => ({
  _id: id,
  nickName: `会员${id}`,
  points: 0,
  ratings: createEmptyRatings({ initialElo }),
});

describe('createEmptyRatings —— 初始化', () => {
  test('为全部两个池创建初始分数', () => {
    const ratings = createEmptyRatings();
    assert.deepEqual(Object.keys(ratings).sort(), ALL_RATING_POOLS.slice().sort());
    assert.equal(Object.keys(ratings).length, 2);
  });

  test('每个池的初始结构完整', () => {
    const ratings = createEmptyRatings();
    for (const pool of ALL_RATING_POOLS) {
      assert.equal(ratings[pool].elo, DEFAULT_ELO);
      assert.equal(ratings[pool].matchCount, 0);
      assert.equal(ratings[pool].wins, 0);
      assert.equal(ratings[pool].losses, 0);
      assert.equal(ratings[pool].lastMatchTime, null);
    }
  });

  test('支持自定义初始分（用于动态初始分规则）', () => {
    const ratings = createEmptyRatings({ initialElo: 1150 });
    for (const pool of ALL_RATING_POOLS) {
      assert.equal(ratings[pool].elo, 1150);
    }
  });

  test('创建的池之间互相独立，不是同一个对象引用', () => {
    const ratings = createEmptyRatings();
    ratings[ RATING_POOL.DOUBLES ].elo = 1300;
    // 两个池必须是不同的对象，改一个不能影响另一个
    assert.notEqual(ratings[RATING_POOL.SINGLES], ratings[RATING_POOL.DOUBLES]);
    assert.equal(ratings[RATING_POOL.SINGLES].elo, DEFAULT_ELO);
  });
});

describe('getPoolRating —— 容错读取', () => {
  test('正常读取已有分数', () => {
    const user = newUser();
    user.ratings[RATING_POOL.DOUBLES].elo = 1250;
    assert.equal(getPoolRating(user, RATING_POOL.DOUBLES).elo, 1250);
  });

  test('池数据缺失时返回默认值而非 undefined（防止榜单崩溃）', () => {
    const user = { _id: 'u1', ratings: {} };
    const result = getPoolRating(user, RATING_POOL.SINGLES);
    assert.equal(result.elo, DEFAULT_ELO);
    assert.equal(result.matchCount, 0);
  });

  test('完全没有 ratings 字段时也不报错', () => {
    const result = getPoolRating({ _id: 'u1' }, RATING_POOL.DOUBLES);
    assert.equal(result.elo, DEFAULT_ELO);
  });

  test('传入 null 时也不报错', () => {
    assert.equal(getPoolRating(null, RATING_POOL.DOUBLES).elo, DEFAULT_ELO);
  });

  test('补齐老数据中缺失的字段，避免后续计算出现 NaN', () => {
    const user = { _id: 'u1', ratings: { doubles: { elo: 1200 } } };
    const result = getPoolRating(user, RATING_POOL.DOUBLES);
    assert.equal(result.elo, 1200);
    assert.equal(result.matchCount, 0);
    assert.equal(result.wins, 0);
    assert.equal(result.losses, 0);
  });
});

describe('池隔离 —— 本系统最核心的约束', () => {
  test('打一场双打，单打分数纹丝不动', () => {
    const user = newUser();
    const before = getPoolRating(user, RATING_POOL.SINGLES).elo;

    const ratings = applyMatchResult({
      user,
      pool: RATING_POOL.DOUBLES,
      delta: 18,
      isWin: true,
      matchTime: new Date('2026-09-01'),
    });

    const updated = { ...user, ratings };
    assert.equal(getPoolRating(updated, RATING_POOL.DOUBLES).elo, 1518);
    // 单打分数必须完全没变
    assert.equal(getPoolRating(updated, RATING_POOL.SINGLES).elo, before);
  });

  test('打一场单打，双打分纹丝不动', () => {
    const user = newUser();
    const ratings = applyMatchResult({
      user,
      pool: RATING_POOL.SINGLES,
      delta: 12,
      isWin: true,
      matchTime: new Date('2026-09-01'),
    });
    const updated = { ...user, ratings };

    assert.equal(getPoolRating(updated, RATING_POOL.SINGLES).elo, 1512);
    assert.equal(getPoolRating(updated, RATING_POOL.DOUBLES).elo, 1500);
  });

  test('各池的胜负场次也独立统计', () => {
    let user = newUser();
    user = { ...user, ratings: applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: 10, isWin: true }) };
    user = { ...user, ratings: applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: -5, isWin: false }) };
    user = { ...user, ratings: applyMatchResult({ user, pool: RATING_POOL.SINGLES, delta: 12, isWin: true }) };

    assert.equal(getPoolRating(user, RATING_POOL.DOUBLES).wins, 1);
    assert.equal(getPoolRating(user, RATING_POOL.DOUBLES).losses, 1);
    assert.equal(getPoolRating(user, RATING_POOL.DOUBLES).matchCount, 2);

    assert.equal(getPoolRating(user, RATING_POOL.SINGLES).wins, 1);
    assert.equal(getPoolRating(user, RATING_POOL.SINGLES).losses, 0);
    assert.equal(getPoolRating(user, RATING_POOL.SINGLES).matchCount, 1);
  });

  test('双打打得再多，也不影响单打的场次统计', () => {
    // 一位会员打了 20 场双打，但从未打过单打
    let user = newUser();
    for (let i = 0; i < 20; i += 1) {
      user = {
        ...user,
        ratings: applyMatchResult({
          user,
          pool: RATING_POOL.DOUBLES,
          delta: i % 2 === 0 ? 12 : -12,
          isWin: i % 2 === 0,
        }),
      };
    }

    // 双打已累计 20 场
    assert.equal(getPoolRating(user, RATING_POOL.DOUBLES).matchCount, 20);
    // 但单打仍是 0 场：两个池的场次互不影响
    assert.equal(getPoolRating(user, RATING_POOL.SINGLES).matchCount, 0);
  });
});

describe('applyMatchResult —— 更新分数', () => {
  test('不修改传入的 user 对象（不可变原则）', () => {
    const user = newUser();
    const originalElo = getPoolRating(user, RATING_POOL.DOUBLES).elo;

    applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: 18, isWin: true });

    assert.equal(getPoolRating(user, RATING_POOL.DOUBLES).elo, originalElo);
  });

  test('正确累加场次与胜负', () => {
    const user = newUser();
    const ratings = applyMatchResult({
      user,
      pool: RATING_POOL.SINGLES,
      delta: 12,
      isWin: true,
      matchTime: new Date('2026-09-01'),
    });
    assert.equal(ratings[RATING_POOL.SINGLES].matchCount, 1);
    assert.equal(ratings[RATING_POOL.SINGLES].wins, 1);
    assert.equal(ratings[RATING_POOL.SINGLES].losses, 0);
    assert.deepEqual(ratings[RATING_POOL.SINGLES].lastMatchTime, new Date('2026-09-01'));
  });

  test('失利时记录 negative 场次', () => {
    const user = newUser();
    const ratings = applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: -12, isWin: false });
    assert.equal(ratings[RATING_POOL.DOUBLES].losses, 1);
    assert.equal(ratings[RATING_POOL.DOUBLES].wins, 0);
  });

  test('未传 matchTime 时保留原有时间', () => {
    const user = newUser();
    const t = new Date('2026-08-01');
    user.ratings[RATING_POOL.DOUBLES].lastMatchTime = t;
    const ratings = applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: 10, isWin: true });
    assert.deepEqual(ratings[RATING_POOL.DOUBLES].lastMatchTime, t);
  });
});

describe('revertMatchResult —— 撤销比赛', () => {
  test('撤销后分数回到比赛前的状态', () => {
    const user = newUser();
    const afterMatch = applyMatchResult({
      user,
      pool: RATING_POOL.DOUBLES,
      delta: 18,
      isWin: true,
    });
    const afterRevert = revertMatchResult({
      user: { ...user, ratings: afterMatch },
      pool: RATING_POOL.DOUBLES,
      delta: 18,
      isWin: true,
    });

    assert.equal(afterRevert[RATING_POOL.DOUBLES].elo, 1500);
    assert.equal(afterRevert[RATING_POOL.DOUBLES].matchCount, 0);
    assert.equal(afterRevert[RATING_POOL.DOUBLES].wins, 0);
  });

  test('撤销不会把场次减成负数（防止数据被搞坏）', () => {
    const user = newUser();
    const result = revertMatchResult({
      user,
      pool: RATING_POOL.DOUBLES,
      delta: 18,
      isWin: true,
    });
    assert.equal(result[RATING_POOL.DOUBLES].matchCount, 0);
    assert.equal(result[RATING_POOL.DOUBLES].wins, 0);
    assert.ok(result[RATING_POOL.DOUBLES].matchCount >= 0);
  });

  test('撤销只影响目标池', () => {
    const user = newUser();
    const withDoubles = applyMatchResult({
      user,
      pool: RATING_POOL.DOUBLES,
      delta: 18,
      isWin: true,
    });
    const withBoth = applyMatchResult({
      user: { ...user, ratings: withDoubles },
      pool: RATING_POOL.SINGLES,
      delta: 12,
      isWin: true,
    });

    const reverted = revertMatchResult({
      user: { ...user, ratings: withBoth },
      pool: RATING_POOL.DOUBLES,
      delta: 18,
      isWin: true,
    });

    // 双打回到初始，单打保持不变
    assert.equal(reverted[RATING_POOL.DOUBLES].elo, 1500);
    assert.equal(reverted[RATING_POOL.SINGLES].elo, 1512);
  });
});

describe('applySeasonalResetToUser —— 赛季软重置', () => {
  test('只重置打过球的池，未参赛的池保持初始分', () => {
    const user = newUser();
    user.ratings[RATING_POOL.SINGLES].elo = 1400;
    user.ratings[RATING_POOL.SINGLES].matchCount = 30;
    // 双打从未参赛，分数仍是 1500

    const reset = applySeasonalResetToUser(user.ratings, {
      resetFn: (elo) => Math.round(elo * 0.75 + 1500 * 0.25),
    });

    assert.equal(reset[RATING_POOL.SINGLES].elo, 1425); // 1400 → 1425
    assert.equal(reset[RATING_POOL.DOUBLES].elo, 1500); // 未参赛，不变
  });

  test('重置只动分数，场次统计原样保留', () => {
    const user = newUser();
    user.ratings[RATING_POOL.SINGLES].elo = 1400;
    user.ratings[RATING_POOL.SINGLES].matchCount = 30;

    const reset = applySeasonalResetToUser(user.ratings, {
      resetFn: (elo) => Math.round(elo * 0.75 + 1500 * 0.25),
    });

    assert.equal(reset[RATING_POOL.SINGLES].matchCount, 30);
  });

  test('起点分随重置后的分数一起刷新（进步榜不能把上赛季积累算进来）', () => {
    const user = newUser();
    user.ratings[RATING_POOL.SINGLES].elo = 1400;
    user.ratings[RATING_POOL.SINGLES].startElo = 1500;
    user.ratings[RATING_POOL.SINGLES].matchCount = 30;

    const reset = applySeasonalResetToUser(user.ratings, {
      resetFn: (elo) => Math.round(elo * 0.75 + 1500 * 0.25),
    });

    assert.equal(reset[RATING_POOL.SINGLES].elo, 1425);
    // 只改 elo 不改 startElo 的话，新赛季第一天就会显示「已进步 75 分」
    assert.equal(reset[RATING_POOL.SINGLES].startElo, 1425);
  });

  test('未参赛的池连起点分也不动', () => {
    const user = newUser();
    user.ratings[RATING_POOL.SINGLES].elo = 1400;
    user.ratings[RATING_POOL.SINGLES].startElo = 1500;
    user.ratings[RATING_POOL.SINGLES].matchCount = 30;

    const reset = applySeasonalResetToUser(user.ratings, {
      resetFn: (elo) => Math.round(elo * 0.75 + 1500 * 0.25),
    });

    assert.equal(reset[RATING_POOL.DOUBLES].startElo, 1500);
    assert.equal(reset[RATING_POOL.DOUBLES].elo, 1500);
  });

  test('未传 resetFn 时抛出错误', () => {
    assert.throws(
      () => applySeasonalResetToUser(createEmptyRatings(), {}),
      /需要传入 resetFn/
    );
  });
});

describe('hasPlayedPool —— 判断是否参赛过', () => {
  test('从未参赛返回 false', () => {
    assert.equal(hasPlayedPool(newUser(), RATING_POOL.DOUBLES), false);
  });

  test('参赛过返回 true', () => {
    const user = newUser();
    const ratings = applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: 10, isWin: true });
    assert.equal(hasPlayedPool({ ...user, ratings }, RATING_POOL.DOUBLES), true);
    // 其它池仍未参赛
    assert.equal(hasPlayedPool({ ...user, ratings }, RATING_POOL.SINGLES), false);
  });
});

describe('summarizeCareer —— 生涯汇总', () => {
  test('汇总两个池的总战绩', () => {
    let user = newUser();
    user = { ...user, ratings: applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: 10, isWin: true }) };
    user = { ...user, ratings: applyMatchResult({ user, pool: RATING_POOL.DOUBLES, delta: -10, isWin: false }) };
    user = { ...user, ratings: applyMatchResult({ user, pool: RATING_POOL.SINGLES, delta: 12, isWin: true }) };

    const summary = summarizeCareer(user);
    assert.equal(summary.totalMatches, 3);
    assert.equal(summary.totalWins, 2);
    assert.equal(summary.totalLosses, 1);
    assert.equal(Number(summary.winRate.toFixed(4)), Number((2 / 3).toFixed(4)));
  });

  test('零场次时胜率为 0 而非 NaN', () => {
    const summary = summarizeCareer(newUser());
    assert.equal(summary.totalMatches, 0);
    assert.equal(summary.winRate, 0);
    assert.ok(!Number.isNaN(summary.winRate));
  });
});

describe('端到端：一场完整的比赛如何改变分数', () => {
  test('双打比赛只更新双方的双打分', () => {
    // 甲、乙搭档对抗丙、丁，四人分数相同
    const players = ['a', 'b', 'c', 'd'].map((id) => newUser(id));

    const result = calculateMatchRatings({
      teamA: players.slice(0, 2).map((p) => ({
        rating: getPoolRating(p, RATING_POOL.DOUBLES).elo,
        matchCount: 0,
      })),
      teamB: players.slice(2, 4).map((p) => ({
        rating: getPoolRating(p, RATING_POOL.DOUBLES).elo,
        matchCount: 0,
      })),
      winner: 'A',
    });

    const updated = players.map((p, i) => {
      const isTeamA = i < 2;
      const delta = isTeamA ? result.teamA[i].delta : result.teamB[i - 2].delta;
      return {
        ...p,
        ratings: applyMatchResult({
          user: p,
          pool: RATING_POOL.DOUBLES,
          delta,
          isWin: isTeamA,
          matchTime: new Date('2026-09-01'),
        }),
      };
    });

    // 同队两人分数变动一致
    assert.equal(updated[0].ratings[RATING_POOL.DOUBLES].elo, updated[1].ratings[RATING_POOL.DOUBLES].elo);
    // 四人总分守恒
    const totalElo = updated.reduce(
      (sum, p) => sum + p.ratings[RATING_POOL.DOUBLES].elo,
      0
    );
    assert.equal(totalElo, 6000);
    // 所有人的单打分完全没动
    for (const p of updated) {
      assert.equal(p.ratings[RATING_POOL.SINGLES].elo, 1500);
      assert.equal(p.ratings[RATING_POOL.SINGLES].matchCount, 0);
    }
  });
});
