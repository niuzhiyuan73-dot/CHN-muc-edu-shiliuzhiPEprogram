/**
 * 赛季锚点（season 首场比赛时间）
 * ============================================================
 * 锚点决定谁算「创始会员」、谁算「中途入会者」，进而决定要不要定级。
 * 它默认取比赛流水里最早的一场——但那个值会随流水变化。
 *
 * 这组测试盯住两件事：
 *   1. replaySeason 的 seasonStart 选项确实能钉死锚点；
 *   2. 不钉死时，撤销最早那场比赛会把中途入会者误判成创始会员。
 *      第 2 条是「为什么云端必须把锚点落库」的证据，不是待修的行为。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { replaySeason } = require('../miniprogram/services/replay.js');
const { MATCH_TYPE } = require('../miniprogram/utils/constants.js');

// 三人：u01/u02 是创始会员，u03 晚一个月入会。
const MEMBERS = [
  { _id: 'u01', gender: 'M', joinDate: '2026-04-01T00:00:00' },
  { _id: 'u02', gender: 'M', joinDate: '2026-04-01T00:00:00' },
  { _id: 'u03', gender: 'M', joinDate: '2026-05-01T00:00:00' },
];

/** 造一场单打比赛 */
function singles(id, time, winnerId, loserId) {
  return {
    _id: id,
    matchType: MATCH_TYPE.SINGLES,
    teamA: [winnerId],
    teamB: [loserId],
    scoreA: [11],
    scoreB: [9],
    winner: 'A',
    matchTime: time,
    eventId: null,
  };
}

// 最早的一场，在 2026-04-08
const M1 = singles('m1', '2026-04-08T18:00:00', 'u01', 'u02');
// u03 入会后的两场
const M2 = singles('m2', '2026-05-10T18:00:00', 'u03', 'u01');
const M3 = singles('m3', '2026-05-12T18:00:00', 'u03', 'u02');

const ALL = [M1, M2, M3];
// 模拟「撤销最早那场」之后的流水
const WITHOUT_M1 = [M2, M3];

function replay(matches, options) {
  return replaySeason({ members: MEMBERS, matches, options });
}

test('seasonStart —— 传入时按钉死的值使用，并出现在 meta 里', () => {
  const pinned = '2026-04-08T18:00:00';
  const { meta } = replay(ALL, { seasonStart: pinned });

  assert.equal(
    new Date(meta.seasonStart).getTime(),
    new Date(pinned).getTime(),
    'meta.seasonStart 应当是调用方传入的那个值'
  );
});

test('seasonStart —— 不传时回落到流水里最早的一场', () => {
  const { meta } = replay(ALL);

  assert.equal(
    new Date(meta.seasonStart).getTime(),
    new Date(meta.firstMatchTime).getTime(),
    '不传 seasonStart 时应当等价于 meta.firstMatchTime'
  );
});

test('seasonStart —— 接受 Date 对象，不只是字符串', () => {
  const when = new Date('2026-04-08T18:00:00');
  const { meta } = replay(ALL, { seasonStart: when });

  assert.equal(new Date(meta.seasonStart).getTime(), when.getTime());
});

test('赛季锚点钉死 —— 撤销最早一场后，中途入会者仍然是中途入会者', () => {
  const pinned = M1.matchTime;

  // 撤销前：u03 在锚点之后入会，属于中途入会者，拿得到定级分
  const before = replay(ALL, { seasonStart: pinned });
  assert.ok(
    Object.prototype.hasOwnProperty.call(before.meta.placements, 'u03'),
    '撤销前 u03 应当被认定为中途入会者并产生定级分'
  );

  // 撤销最早一场后：锚点被钉住不动，u03 的定性不应改变
  const after = replay(WITHOUT_M1, { seasonStart: pinned });
  assert.ok(
    Object.prototype.hasOwnProperty.call(after.meta.placements, 'u03'),
    '锚点钉死后，撤销最早一场不应把 u03 重新分类成创始会员'
  );
});

test('赛季锚点浮动 —— 不钉死锚点，撤销最早一场会把中途入会者误判成创始会员（需钉死的理由）', () => {
  // 流水里去掉 m1 之后，最早一场变成 m2（2026-05-10）
  const { meta } = replay(WITHOUT_M1);

  assert.equal(
    new Date(meta.firstMatchTime).getTime(),
    new Date(M2.matchTime).getTime(),
    '先说清楚前提：去掉 m1 后锚点确实后移到了 m2'
  );

  // u03 的入会日期 2026-05-01 早于新锚点 2026-05-10，
  // 于是被当成创始会员，定级分凭空消失。
  assert.ok(
    !Object.prototype.hasOwnProperty.call(meta.placements, 'u03'),
    '锚点浮动时 u03 会被误判成创始会员——这正是云端要把锚点落库钉死的原因'
  );
});
