/**
 * 学院赛：小场出结果后的大场推进
 * ============================================================
 * 这里不是「接口」，没有对应的 action——它是 confirmMatch / recordForfeit
 * 收尾时调用的内部步骤。之所以单列一个文件：dispatch 会把处理器模块的
 * 每个导出都当成可调用动作，把内部函数混在里面，客户端就能凭函数名直接
 * 调它（参数对不上，只会得到一个难查的报错）。
 *
 * 【为什么本轮打完了才排下一轮】
 * 下一轮的对阵由「本轮各签位的胜者」推出来，只有本轮每场都分出胜负，
 * 这个序列才确定。提前排会把还没打完的签位留成空位，排出错误的对阵。
 *
 * 【大场关系不进回放】
 * 大场、轮次都不在 getDataset 的输入里，所以这里不必动赛季版本号；
 * 唯一让缓存失效的是「小场从待确认转生效」，那一刀由调用方负责。
 * ============================================================
 */

const {
  legResultOf,
  summarizeTie,
  nextRoundPairsOf,
  buildTiesForRound,
} = require('../../lib/services/college-tie.js');
const { TIE_STATUS } = require('../../lib/utils/constants.js');

/**
 * 小场有了结果之后：写回大场、定出大场胜负，并在本轮打完时排出下一轮。
 *
 * 只在比赛确认（confirmMatch）或记弃权（recordForfeit）之后调用，此时台账
 * 已是最终态。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 刚生效的小场记录
 * @returns {Promise<{tiePatch:Object, nextTies:Array}|null>}
 */
async function advanceCollegeAfterLeg(ctx, legMatch) {
  if (!legMatch || !legMatch.tieId) return null;

  const tie = await ctx.repo.ties.getById(legMatch.tieId);
  if (!tie) return null;
  const event = await ctx.repo.collegeEvents.getById(tie.eventId);

  // 把这一场的结果写回对应的小项（其余小项原样保留）
  const legs = (Array.isArray(tie.legs) ? tie.legs : []).map((leg) =>
    Number(leg.legNo) === Number(legMatch.legNo) ? { ...leg, ...legResultOf(tie, legMatch) } : leg
  );
  const summary = summarizeTie({ tie: { ...tie, legs }, event });

  const tiePatch = { legs };
  // 未决（净胜两套都平）不算结束：留在进行中等管理员处理，不记假胜者
  if (summary.complete && summary.winnerSide) {
    tiePatch.status = TIE_STATUS.FINISHED;
    tiePatch.winner = summary.winner;
    tiePatch.finishedAt = ctx.now;
  }

  // 下一轮的对阵要在事务外算：事务里不能按赛事条件读取大场
  const allTies = await ctx.repo.ties.listByEvent(tie.eventId);
  const merged = allTies.map((item) => (item._id === tie._id ? { ...item, ...tiePatch } : item));
  const pairs = tiePatch.winner
    ? nextRoundPairsOf({ draw: event.draw, ties: merged, round: tie.round })
    : [];
  const nextTies = pairs.length > 0 ? buildTiesForRound({ event, round: Number(tie.round) + 1, pairs }) : [];

  await ctx.repo.transaction(async (tx) => {
    await tx.ties.update(tie._id, tiePatch);
    for (const draft of nextTies) {
      const existing = await tx.ties.getById(draft._id);
      if (existing) continue; // 排过的轮次不覆盖
      await tx.ties.insert(draft);
    }
  });

  return { tiePatch, nextTies };
}

module.exports = { advanceCollegeAfterLeg };
