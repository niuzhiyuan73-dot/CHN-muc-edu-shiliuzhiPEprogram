/**
 * 积分算法单元测试
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_POINT_CONFIG,
  calculateStreakBonus,
  calculateMatchPoints,
  calculateStreak,
} = require('../miniprogram/utils/points.js');

describe('calculateStreakBonus —— 连胜奖励', () => {
  test('连胜不足 3 场时不触发奖励', () => {
    assert.equal(calculateStreakBonus(0), 0);
    assert.equal(calculateStreakBonus(1), 0);
    assert.equal(calculateStreakBonus(2), 0);
  });

  test('第 3 场连胜触发 +1', () => {
    assert.equal(calculateStreakBonus(3), 1);
  });

  test('第 4 场连胜累加到 +2', () => {
    assert.equal(calculateStreakBonus(4), 2);
  });

  test('第 5 场起封顶于 +3', () => {
    assert.equal(calculateStreakBonus(5), 3);
    assert.equal(calculateStreakBonus(6), 3);
    assert.equal(calculateStreakBonus(100), 3);
  });
});

describe('calculateMatchPoints —— 单场积分', () => {
  test('普通获胜：3 分', () => {
    const result = calculateMatchPoints({ isWin: true });
    assert.deepEqual(result, { base: 3, streakBonus: 0, eventBonus: 0, total: 3 });
  });

  test('普通落败：仍有 1 分参与分', () => {
    const result = calculateMatchPoints({ isWin: false });
    assert.deepEqual(result, { base: 1, streakBonus: 0, eventBonus: 0, total: 1 });
  });

  test('落败时不计算连胜奖励', () => {
    const result = calculateMatchPoints({ isWin: false, currentStreak: 5 });
    assert.equal(result.streakBonus, 0);
    assert.equal(result.total, 1);
  });

  test('3 连胜中的第 3 场：3 + 1 = 4 分', () => {
    const result = calculateMatchPoints({ isWin: true, currentStreak: 3 });
    assert.equal(result.total, 4);
  });

  test('参加正式赛事获胜：3 + 2 = 5 分', () => {
    const result = calculateMatchPoints({ isWin: true, isEvent: true });
    assert.equal(result.eventBonus, 2);
    assert.equal(result.total, 5);
  });

  test('正式赛事 + 5 连胜：3 + 3 + 2 = 8 分', () => {
    const result = calculateMatchPoints({ isWin: true, currentStreak: 5, isEvent: true });
    assert.equal(result.total, 8);
  });

  test('自定义配置生效', () => {
    const result = calculateMatchPoints({
      isWin: true,
      config: { win: 10, eventParticipate: 5 },
      isEvent: true,
    });
    assert.equal(result.total, 15);
  });

  test('返回的总分恒等于各项之和', () => {
    for (const isWin of [true, false]) {
      for (const currentStreak of [0, 3, 4, 9]) {
        for (const isEvent of [true, false]) {
          const r = calculateMatchPoints({ isWin, currentStreak, isEvent });
          assert.equal(r.total, r.base + r.streakBonus + r.eventBonus);
        }
      }
    }
  });

  test('积分恒为正数：参与即得分，体现鼓励参与的设计意图', () => {
    for (const isWin of [true, false]) {
      assert.ok(calculateMatchPoints({ isWin }).total > 0);
    }
  });

  test('默认配置与策划书表 4-2 一致', () => {
    assert.equal(DEFAULT_POINT_CONFIG.win, 3);
    assert.equal(DEFAULT_POINT_CONFIG.loss, 1);
    assert.equal(DEFAULT_POINT_CONFIG.eventParticipate, 2);
    assert.equal(DEFAULT_POINT_CONFIG.streakBonusThreshold, 3);
    assert.equal(DEFAULT_POINT_CONFIG.streakBonusMax, 3);
    assert.equal(DEFAULT_POINT_CONFIG.absencePenalty, -2);
  });
});

describe('calculateStreak —— 连胜场次统计', () => {
  test('连续三场获胜返回 3', () => {
    const matches = [{ isWin: true }, { isWin: true }, { isWin: true }];
    assert.equal(calculateStreak(matches), 3);
  });

  test('遇到失利立即中断计数', () => {
    const matches = [{ isWin: true }, { isWin: true }, { isWin: false }, { isWin: true }];
    assert.equal(calculateStreak(matches), 2);
  });

  test('最近一场失利则连胜为 0', () => {
    assert.equal(calculateStreak([{ isWin: false }, { isWin: true }]), 0);
  });

  test('空战绩返回 0', () => {
    assert.equal(calculateStreak([]), 0);
  });
});
