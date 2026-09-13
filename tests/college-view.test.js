/**
 * 学院赛小场录分页视图模型 单元测试
 *
 * 这里守的是两个曾经让页面直接崩掉的回归：
 *   1. 找不到比赛时不下发比分行所需的字段，页面按 bestOf 读 scoreA[i] 抛错；
 *   2. 权限布尔量取名与导入函数同名，撞上暂时性死区，闸门为真时抛
 *      ReferenceError（种子数据里没有「待确认 + 有胜方」的比赛，所以线上
 *      才会漏网，这里特意造一场把那条路径走通）。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { loadCollegeMatchView } = require('../miniprogram/services/college-view.js');
const facade = require('../miniprogram/services/index.js');
const { MATCH_TYPE } = require('../miniprogram/utils/constants.js');

/** 写操作会动台账，用例前后各复位一次 */
function cleanStore() {
  facade.resetCache();
  return () => facade.resetCache();
}

describe('loadCollegeMatchView —— 找不到比赛', () => {
  test('如实返回 found:false，并补齐比分行所需的全部字段', async () => {
    const view = await loadCollegeMatchView('不存在的小场');

    assert.equal(view.found, false);
    assert.equal(view.blockReason, '找不到这场比赛');
    assert.equal(view.matchId, '不存在的小场');
    // 页面 refresh 会按 bestOf 逐行读 scoreA/scoreB；缺一个就是读下标抛错
    assert.deepEqual(view.scoreA, []);
    assert.deepEqual(view.scoreB, []);
    assert.deepEqual(view.teamARows, []);
    assert.deepEqual(view.teamBRows, []);
    assert.equal(typeof view.gamePoints, 'number');
    assert.equal(typeof view.bestOf, 'number');
  });
});

describe('loadCollegeMatchView —— 权限布尔量不撞暂时性死区', () => {
  let restore;
  let matchId;

  before(async () => {
    restore = cleanStore();
    // 造一场「待确认 + 有胜方 + 我在场上」的比赛：这正是 TDZ 的触发条件，
    // 种子数据里恰好一场都没有，所以必须自己录一场。
    const result = await facade.submitMatch({
      matchType: MATCH_TYPE.SINGLES,
      teamA: ['u06'],
      teamB: ['u01'],
      scoreA: [11],
      scoreB: [7],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
      location: '学校体育馆 1 号场',
      actor: 'u06',
    });
    matchId = result.match._id;
  });

  after(() => restore());

  test('加载成功，canConfirm / canRevoke 都是布尔量而不是抛错', async () => {
    const view = await loadCollegeMatchView(matchId);

    assert.equal(view.found, true);
    assert.equal(view.blockReason, '');
    assert.equal(typeof view.canConfirm, 'boolean');
    assert.equal(typeof view.canRevoke, 'boolean');
    // 演示口径下参与者即可确认，闸门应当为真——正是这条路以前会崩
    assert.equal(view.canConfirm, true);
  });
});
