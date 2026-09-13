/**
 * 实时比分的展示整形（M7 第四期）
 * ============================================================
 * 查看端把「进行中那一场」显示在终局比分的位置上，整形只此一份（live-view.js），
 * 比赛页、赛事详情、学院赛详情三处共用。这里钉三件事：
 *
 *   1. describeLive —— 字段口径（第几局 +1、进行中 / 已结束、没有实时态返回 null）；
 *   2. applyLiveRows —— 按 matchId 贴回单层行，没变动的行保持原引用；
 *   3. applyLiveTies —— 行藏在大场 → 小项两层里，同样按 matchId 对齐。
 *
 * 「没变动的行保持原引用」是刻意钉的：轮询一拍回来若逐行新建对象，
 * setData 会把整屏都当作变了。这条不变量一旦被改坏，省下的重渲染就没了。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { describeLive, applyLiveRows, applyLiveTies } = require('../miniprogram/services/live-view.js');

/** liveScoreOf 的一小份样例：gameIndex 自 0 起 */
function liveOf(overrides = {}) {
  return {
    matchId: 'mm',
    pointsA: 11,
    pointsB: 9,
    gamesA: 1,
    gamesB: 0,
    gameIndex: 1,
    status: 'live',
    finished: false,
    leading: 'A',
    gamePoints: 11,
    bestOf: 3,
    ...overrides,
  };
}

describe('describeLive —— 一条实时态翻成页面字段', () => {
  test('进行中：局分、第几局（+1）、领先方都照实翻出来', () => {
    const row = describeLive(liveOf());
    assert.equal(row.matchId, 'mm');
    assert.equal(row.scoreText, '11 : 9');
    assert.equal(row.gamesText, '1 : 0');
    assert.equal(row.gameIndex, 1);
    assert.equal(row.gameIndexText, '第 2 局');
    assert.equal(row.leading, 'A');
    assert.equal(row.finished, false);
    assert.equal(row.statusLabel, '进行中');
  });

  test('已结束：statusLabel 换字，finished 跟上', () => {
    const row = describeLive(liveOf({ finished: true, status: 'finished' }));
    assert.equal(row.finished, true);
    assert.equal(row.statusLabel, '已结束');
  });

  test('没有实时态返回 null —— 行上照旧显示终局比分', () => {
    assert.equal(describeLive(null), null);
    assert.equal(describeLive(undefined), null);
  });

  test('可选字段缺失时给默认：0:0 从「第 1 局」起，无领先方', () => {
    const row = describeLive({ matchId: 'mm', pointsA: 0, pointsB: 0, gamesA: 0, gamesB: 0 });
    assert.equal(row.scoreText, '0 : 0');
    assert.equal(row.gamesText, '0 : 0');
    assert.equal(row.gameIndexText, '第 1 局');
    assert.equal(row.leading, '');
    assert.equal(row.finished, false);
  });
});

describe('applyLiveRows —— 按 matchId 贴回单层行', () => {
  test('命中就挂 live 与 liveActive，未命中的行原样不动', () => {
    const hit = { matchId: 'a', scoreText: '' };
    const miss = { matchId: 'b', scoreText: '' };
    const rows = applyLiveRows([hit, miss], [liveOf({ matchId: 'a' })]);

    assert.equal(rows[0].liveActive, true);
    assert.equal(rows[0].live.scoreText, '11 : 9');
    // 未命中：连引用都不换，setData 才不会被整屏惊动
    assert.equal(rows[1], miss);
    assert.equal(rows[1].liveActive, undefined);
  });

  test('没有实时视图时原样返回，不白造新数组内容', () => {
    const rows = [{ matchId: 'a' }];
    assert.deepEqual(applyLiveRows(rows, []), rows);
  });

  test('入参不是数组也不抛错', () => {
    assert.deepEqual(applyLiveRows(null, [liveOf()]), []);
    assert.deepEqual(applyLiveRows([{ matchId: 'a' }], null), [{ matchId: 'a' }]);
  });
});

describe('applyLiveTies —— 行藏在大场 → 小项两层里', () => {
  test('只贴中招的小项，其余大场与小项保持原引用', () => {
    const legHit = { legNo: 1, matchId: 'a' };
    const legMiss = { legNo: 2, matchId: 'b' };
    const tie = { tieId: 't1', legRows: [legHit, legMiss] };

    const ties = applyLiveTies([tie], [liveOf({ matchId: 'a' })]);

    assert.equal(ties[0].legRows[0].liveActive, true);
    assert.equal(ties[0].legRows[0].live.scoreText, '11 : 9');
    assert.equal(ties[0].legRows[1], legMiss);
  });

  test('没有实时视图时原样返回', () => {
    const ties = [{ tieId: 't1', legRows: [{ legNo: 1, matchId: 'a' }] }];
    assert.deepEqual(applyLiveTies(ties, []), ties);
  });

  test('趟不过去的行（没有 legRows）不抛错', () => {
    const ties = [{ tieId: 't1' }, null];
    assert.deepEqual(applyLiveTies(ties, [liveOf()]), ties);
  });
});
