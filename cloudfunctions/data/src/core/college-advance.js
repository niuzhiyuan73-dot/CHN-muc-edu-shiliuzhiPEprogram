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
  revertLegResult,
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

  // 先取一次只是为了拿 eventId 与赛事配置（轮次、赛制在这场里不会变）。
  // 小项本身要在事务里重读——见下。
  const snapshot = await ctx.repo.ties.getById(legMatch.tieId);
  if (!snapshot) return null;
  const event = await ctx.repo.collegeEvents.getById(snapshot.eventId);

  let tiePatch = null;
  await ctx.repo.transaction(async (tx) => {
    // 【为什么必须在事务内重读】
    // legs 是「整份小项数组」的一次整体写入。若拿事务外的快照来算，同一个
    // 大场两场小项几乎同时确认时，两边的快照都还没有对方那一场，后写的
    // 会把先写的冲掉——大场永远差一场，晋级名单也排不出来。重读之后在
    // 事务里合并，两次写入才会串成一条链。
    const tie = await tx.ties.getById(legMatch.tieId);
    if (!tie) return;

    // 把这一场的结果写回对应的小项（其余小项按重读到的现状保留）
    const legs = (Array.isArray(tie.legs) ? tie.legs : []).map((leg) =>
      Number(leg.legNo) === Number(legMatch.legNo) ? { ...leg, ...legResultOf(tie, legMatch) } : leg
    );
    const summary = summarizeTie({ tie: { ...tie, legs }, event });

    tiePatch = { legs };
    // 未决（净胜两套都平）不算结束：留在进行中等管理员处理，不记假胜者
    if (summary.complete && summary.winnerSide) {
      tiePatch.status = TIE_STATUS.FINISHED;
      tiePatch.winner = summary.winner;
      tiePatch.finishedAt = ctx.now;
    }

    await tx.ties.update(tie._id, tiePatch);
  });

  if (!tiePatch || !tiePatch.winner) return { tiePatch: tiePatch || {}, nextTies: [] };

  // 下一轮的对阵要在事务外算：事务里不能按赛事条件读取大场。
  // 插入仍走「只补不覆盖」，所以这里多算一次是安全的。
  const allTies = await ctx.repo.ties.listByEvent(snapshot.eventId);
  const merged = allTies.map((item) => (item._id === snapshot._id ? { ...item, ...tiePatch } : item));
  const pairs = nextRoundPairsOf({ draw: event.draw, ties: merged, round: snapshot.round });
  const nextTies = pairs.length > 0 ? buildTiesForRound({ event, round: Number(snapshot.round) + 1, pairs }) : [];

  if (nextTies.length > 0) {
    await ctx.repo.transaction(async (tx) => {
      for (const draft of nextTies) {
        const existing = await tx.ties.getById(draft._id);
        if (existing) continue; // 排过的轮次不覆盖
        await tx.ties.insert({ ...draft, association: ctx.association });
      }
    });
  }

  return { tiePatch, nextTies };
}

/**
 * 撤销一场学院赛小场之前：这道撤销会不会把签表留在悬空状态。
 *
 * 与个人赛的 findDependentMatches 同一个道理（见 match-handlers.revokeMatch）：
 * 分数撤得回，签表撤不回。大场一旦结束，下一轮大场就按它的胜者落成了真实
 * 记录（advanceCollegeAfterLeg），而写入侧只给 upsert / patch、没有删除，
 * 那个推进又是「只补不覆盖」。撤下去只会让下一轮顶着一个作废的晋级者留在
 * 台账里。挡在这里，要求管理员从最后一轮往前撤。
 *
 * 另一种拦法在大场那一侧：撤的是决定性的那一场时，大场会再也打不完——小场
 * 作废即终态，既不能重录也不能重开（见 revertLegResult）。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 待撤销的小场
 * @returns {Promise<string>} 拒绝理由；可以撤时给空串
 */
async function collegeLegRevokeBlocker(ctx, legMatch) {
  if (!legMatch || !legMatch.tieId) return '';

  const tie = await ctx.repo.ties.getById(legMatch.tieId);
  if (!tie) return ''; // 小场挂在一个查不到的大场上：不拦，撤销本身没问题

  const ties = await ctx.repo.ties.listByEvent(tie.eventId);
  const ahead = ties.filter((item) => Number(item.round) > Number(tie.round));
  if (ahead.length > 0) {
    return `这场大场的结果已经排进了第 ${ahead[0].round} 轮，请从最后一轮往前依次撤销`;
  }

  const event = await ctx.repo.collegeEvents.getById(tie.eventId);
  const reverted = revertLegResult({ tie, event, legNo: legMatch.legNo });
  return reverted && reverted.blocked ? reverted.blocked : '';
}

/**
 * 撤销一场学院赛小场之后：把结果从大场里收回来（详见 revertLegResult）。
 *
 * 要在比赛记录已经作废之后再调——撤销失败（例如并发下已被别人撤掉）时不该
 * 动大场。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 已作废的小场
 * @returns {Promise<Object|null>} 写回大场的字段，没动过大场时给 null
 */
async function revertCollegeAfterRevoke(ctx, legMatch) {
  if (!legMatch || !legMatch.tieId) return null;

  let tiePatch = null;
  await ctx.repo.transaction(async (tx) => {
    // 与 advanceCollegeAfterLeg 同理：legs 是整份数组的整体写入，必须在事务里
    // 重读，否则两场小项一前一后地撤会互相冲掉。
    const tie = await tx.ties.getById(legMatch.tieId);
    if (!tie) return;
    const event = await ctx.repo.collegeEvents.getById(tie.eventId);
    const reverted = revertLegResult({ tie, event, legNo: legMatch.legNo });
    // 拦截已经在前置检查里做过；这里再判一次是为了「查到什么就是什么」
    if (!reverted || !reverted.patch) return;

    tiePatch = reverted.patch;
    await tx.ties.update(tie._id, tiePatch);
  });
  return tiePatch;
}

module.exports = { advanceCollegeAfterLeg, collegeLegRevokeBlocker, revertCollegeAfterRevoke };
