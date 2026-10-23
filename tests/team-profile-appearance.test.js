/**
 * 「已记录出场」为什么和「参赛经历」对不上
 * ============================================================
 * 两个数字的**单位不同**，不是同一个东西算错：
 *   · 已记录出场 = 具体**比赛场次**（赛后报告里逐场标了「实际出场」的场次）；
 *   · 参赛经历 / 团队荣誉 = **赛事**（报名即归属，不要求出场）。
 * 一个赛事有多场比赛，所以「报名 4 项赛事、出场 1 场」完全可能成立。
 *
 * 这条测试钉住两件事：
 *   1. 出场只认报告里的 appeared，**名单里有但未登场（替补）不算出场**；
 *   2. 参赛经历每一行都带「本人出场几场 / 球队这届打了几场」，
 *      让用户能自己把账对上（这正是原来的困惑点）。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/football-fixture');

/** 把某个球员在该场报告里改成「名单内有、实际未登场」，并把门将交给另一名首发。 */
function benchPlayer(report, userId) {
  for (const side of ['A', 'B']) {
    const players = report.sides[side].players;
    const row = players.find(p => p.userId === userId);
    if (!row) continue;
    row.starter = false; row.appeared = false; row.goalkeeper = false;
    // 首发必须有一名门将，否则报告校验不过（原门将是这名被换下的人）
    const keeper = players.find(p => p.starter && p.userId !== userId);
    if (keeper) keeper.goalkeeper = true;
  }
  return report;
}

test('足球：名单里有但我未登场，不算出场；参赛经历逐行给出本人出场数', async () => {
  const f = await fixture({ count: 3 });
  const all = await f.matches();
  const mine = all.filter(m => [m.teamA, m.teamB].includes('ft0')).slice(0, 2);
  assert.equal(mine.length, 2, '三队循环赛里 ft0 要打 2 场');

  // 第 1 场：f0 真的上了（报告按首发 11 人标记出场）
  await f.publish(mine[0], await f.report(mine[0], { regulationScore: { A: 1, B: 0 } }, true));
  // 第 2 场：f0 在报名名单里，但报告标为「未登场」。
  // 少一名首发要写裁判报告说明，否则报告本身校验不过（这是既有规则）。
  await f.publish(mine[1], benchPlayer(
    await f.report(mine[1], { regulationScore: { A: 0, B: 0 }, note: '一名首发临场因伤未登场' }, true), 'f0'));

  const profile = await f.call('getMyTeamProfile', {}, 'f0');
  assert.equal(profile.totals.eligibleMatchCount, 2, '球队已经打完 2 场');
  assert.equal(profile.totals.appearanceGames, 1, '只算真正上场的那 1 场（替补未登场不算）');
  // games 与 appearanceGames 同值：aggregate 的 games 也只累加 appeared 行，
  // 差别只在「报告里有我这一行」的是 recordedMatches（2 场）——那更不能当出场。
  assert.equal(profile.totals.games, 1);
  assert.equal(profile.totals.recordedMatches, 2, '两场报告里都列了我，但只有 1 场真上场');

  // 参赛经历只有 1 项赛事，但它有 2 场：赛事数与场次数本来就不同
  assert.equal(profile.events.length, 1);
  assert.equal(profile.events[0].eligibleMatchCount, 2, '这届赛事球队打了 2 场');
  assert.equal(profile.events[0].appearedMatches, 1, '我在这届出场 1 场');
});

test('足球：只录比分不标记上场时，出场为 0（不推定）', async () => {
  const f = await fixture({ count: 2 });
  const match = (await f.matches())[0];
  // withPlayers = false：报告只有比分，没有个人行
  await f.publish(match, await f.report(match, { regulationScore: { A: 2, B: 0 } }, false));

  const profile = await f.call('getMyTeamProfile', {}, 'f0');
  assert.equal(profile.totals.eligibleMatchCount, 1, '球队打了 1 场');
  assert.equal(profile.totals.appearanceGames, 0, '没有出场证据就不编出场数');
  assert.equal(profile.events[0].appearedMatches, 0);
});
