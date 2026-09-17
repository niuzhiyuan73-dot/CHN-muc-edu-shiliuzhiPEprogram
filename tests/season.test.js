/**
 * 赛季软重置单元测试
 *
 * 注：早期版本这里还测过「动态初始分」（新人按池内中位数入场）。
 * 该规则已被「按性别的初始分起步 + 中途入会者按前五场对手定级」取代，
 * 函数连同其依赖的中位数工具一并删除，相关测试也随之移除。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { applySeasonalReset, DEFAULT_CONFIG } = require('../miniprogram/utils/elo.js');

/** 默认锚定分（当前 1450），断言值随配置变化，避免调参后测试跟着改 */
const ANCHOR = DEFAULT_CONFIG.initialRating;
/** 按公式算出期望结果，与实现保持同一套取整口径 */
const resetTo = (rating, retentionFactor = 0.75, anchorRating = ANCHOR) =>
  Math.round(rating * retentionFactor + anchorRating * (1 - retentionFactor));

describe('applySeasonalReset —— 赛季软重置', () => {
  test('1400 分向默认锚定分回归 25%', () => {
    assert.equal(applySeasonalReset(1400), resetTo(1400));
    assert.equal(applySeasonalReset(1400), 1413);
  });

  test('700 分同样向默认锚定分靠拢', () => {
    assert.equal(applySeasonalReset(700), resetTo(700));
    assert.equal(applySeasonalReset(700), 888);
  });

  test('正好是锚定分时保持不变', () => {
    assert.equal(applySeasonalReset(ANCHOR), ANCHOR);
  });

  test('保留系数 0.5 时回归幅度更大', () => {
    assert.equal(applySeasonalReset(1400, { retentionFactor: 0.5 }), resetTo(1400, 0.5));
    assert.equal(applySeasonalReset(1400, { retentionFactor: 0.5 }), 1425);
  });

  test('保留系数为 0 时全部归到锚定分', () => {
    assert.equal(applySeasonalReset(1400, { retentionFactor: 0 }), ANCHOR);
  });

  test('保留系数为 1 时分数完全不变', () => {
    assert.equal(applySeasonalReset(1400, { retentionFactor: 1 }), 1400);
  });

  test('自定义锚定分生效', () => {
    assert.equal(applySeasonalReset(1400, { anchorRating: 1200, retentionFactor: 0.5 }), 1300);
  });

  test('重置保持相对顺序：强者依然高于弱者', () => {
    const before = [1700, 1400, 1000, 800, 600];
    const after = before.map((r) => applySeasonalReset(r));
    for (let i = 0; i < before.length - 1; i += 1) {
      assert.ok(
        after[i] > after[i + 1],
        `重置后 ${after[i]} 应仍大于 ${after[i + 1]}`
      );
    }
  });

  test('重置压缩分差：所有人的分数向中间靠拢', () => {
    const spreadBefore = 1700 - 600;
    const spreadAfter = applySeasonalReset(1700) - applySeasonalReset(600);
    assert.ok(spreadAfter < spreadBefore, '软重置应缩小分差，给落后的人追赶机会');
  });

  test('输入非数字时抛出错误', () => {
    assert.throws(() => applySeasonalReset('1400'), /必须是有效数字/);
    assert.throws(() => applySeasonalReset(NaN), /必须是有效数字/);
  });

  test('保留系数超出范围时抛出错误', () => {
    assert.throws(() => applySeasonalReset(1400, { retentionFactor: 1.5 }), /必须位于 0 到 1 之间/);
    assert.throws(() => applySeasonalReset(1400, { retentionFactor: -0.1 }), /必须位于 0 到 1 之间/);
  });

  test('保留系数非数字时抛出错误，不静默压分', () => {
    // null 曾经能从范围检查里溜过去：null < 0 与 null > 1 都是 false，
    // 于是 1400 × null 归零，全季所有人都被压成基准分——一声不吭。
    for (const bad of [null, NaN, '0.5', {}, []]) {
      assert.throws(
        () => applySeasonalReset(1400, { retentionFactor: bad }),
        /retentionFactor 必须是有效数字/,
        `retentionFactor=${JSON.stringify(bad)} 应被拒`
      );
    }
    // 不传 / 传 undefined 仍走默认值，不是错误
    assert.equal(applySeasonalReset(1400, { retentionFactor: undefined }), resetTo(1400));
    assert.equal(applySeasonalReset(1400, {}), resetTo(1400));
  });

  test('基准分非数字时抛出错误，不静默压分', () => {
    for (const bad of [null, NaN, '1000', {}]) {
      assert.throws(
        () => applySeasonalReset(1400, { anchorRating: bad }),
        /anchorRating 必须是有效数字/,
        `anchorRating=${JSON.stringify(bad)} 应被拒`
      );
    }
    assert.equal(applySeasonalReset(1400, { anchorRating: undefined }), resetTo(1400));
  });

  test('结果始终是整数', () => {
    for (const r of [1001, 1234, 1567, 1899, 777]) {
      assert.ok(Number.isInteger(applySeasonalReset(r)));
    }
  });
});

