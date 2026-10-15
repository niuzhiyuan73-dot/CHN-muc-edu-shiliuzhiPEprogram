/**
 * 学校维度：学院赛小场出结果后的大场推进（协议 2，M2-c2）
 * ============================================================
 * 与云端 `core/college-advance.js` 同一把尺子，只把数据边界换成 S2 仓储：
 *   · 大场是 `ties` 里带 `schoolId + association` 的记录（见 school-college-service）；
 *   · 小场是 `matches` 里 `competition = college`、带 `tieId + legNo` 的记录；
 *   · 汇总 / 晋级 / 撤销全部复用纯模块 `college-tie.js`（legResultOf / summarizeTie /
 *     nextRoundPairsOf / buildTiesForRound / revertLegResult），一行规则都不重写。
 *
 * 【为什么不进处理器注册表】这里没有对应 action——它是 confirm / forfeit / revoke
 * 收尾时调用的内部步骤。混进处理器模块的公开导出里，客户端就能凭函数名直接调它
 * （参数对不上，只会得到一个难查的报错）。云端为此单列一个 core 文件，此处同。
 *
 * 【为什么下一轮在事务之间算】S2 仓储与云端同一条纪律：事务内禁止整表查询。所以
 * 「取本赛事全部大场 → 推下一轮对阵」放在两次事务之间：第一次事务把小场结果写回
 * 大场，事务外算出下一轮对阵，第二次事务「只补不覆盖」地插入。多算一次是安全的。
 *
 * 【为什么小场写回要在事务内重读大场】`legs` 是整份数组的一次整体写入。若拿事务外
 * 的快照去算，同一大场两场小项几乎同时确认时，后写的会把先写的冲掉——大场永远差
 * 一场，晋级名单也排不出来。重读后在事务里合并，两次写入才串成一条链。
 * ============================================================
 */

const {
  legResultOf, revertLegResult, summarizeTie, nextRoundPairsOf, buildTiesForRound,
} = require('./college-tie.js');
const { belongsToSchoolScope } = require('../utils/school.js');
const { TIE_STATUS, MATCH_COMPETITION } = require('../utils/constants.js');

const iso = value => new Date(value).toISOString();
const isLegMatch = doc => Boolean(doc && doc.competition === MATCH_COMPETITION.COLLEGE && doc.tieId);
const belongsTo = (doc, ctx) => Boolean(doc) && belongsToSchoolScope(doc, ctx);

/**
 * 小场有了结果之后：写回大场、定出大场胜负，并在本轮打完时排出下一轮。
 *
 * 只在比赛确认（confirmSchoolMatch）或记弃权（forfeitSchoolMatch）之后调用，
 * 此时台账已是最终态；小场经 `submitScheduledMatch` 补录、对手确认后转 ACTIVE。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 刚生效的小场记录（matches 原始文档）
 * @returns {Promise<{tiePatch:Object, nextTies:Array}|null>}
 */
async function advanceCollegeAfterLeg(ctx, legMatch) {
  if (!isLegMatch(legMatch)) return null;

  // 先取一次只为拿 eventId；小项本身要在事务里重读（见文件头注）。
  const snapshot = await ctx.repo.ties.getById(legMatch.tieId);
  if (!belongsTo(snapshot, ctx)) return null;
  const event = await ctx.repo.collegeEvents.getById(snapshot.eventId);
  if (!belongsTo(event, ctx)) return null;

  let tiePatch = null;
  await ctx.repo.transaction(async tx => {
    const tie = await tx.ties.getById(legMatch.tieId);
    if (!tie) return;

    const legs = (Array.isArray(tie.legs) ? tie.legs : []).map(leg =>
      Number(leg.legNo) === Number(legMatch.legNo) ? { ...leg, ...legResultOf(tie, legMatch) } : leg);
    const summary = summarizeTie({ tie: { ...tie, legs }, event });

    tiePatch = { legs };
    // 未决（净胜两套都平）不算结束：留在进行中等管理员处理，不记假胜者
    if (summary.complete && summary.winnerSide) {
      tiePatch.status = TIE_STATUS.FINISHED;
      tiePatch.winner = summary.winner;
      tiePatch.finishedAt = ctx.now;
    }
    await tx.ties.set(tie._id, { ...tie, ...tiePatch,
      revision: Number(tie.revision || 1) + 1, updatedAt: iso(ctx.now) });
  });

  if (!tiePatch || !tiePatch.winner) return { tiePatch: tiePatch || {}, nextTies: [] };

  // 下一轮的对阵要在事务外算（事务里不能按赛事条件读大场）。插入仍走「只补不覆盖」，
  // 所以这里多算一次是安全的。
  const allTies = (await ctx.repo.forScope(ctx).ties.list())
    .filter(item => item.eventId === snapshot.eventId);
  const merged = allTies.map(item => (item._id === snapshot._id ? { ...item, ...tiePatch } : item));
  const pairs = nextRoundPairsOf({ draw: event.draw, ties: merged, round: snapshot.round });
  const drafts = pairs.length > 0
    ? buildTiesForRound({ event, round: Number(snapshot.round) + 1, pairs })
    : [];

  const nextTies = [];
  if (drafts.length > 0) {
    const nowIso = iso(ctx.now);
    await ctx.repo.transaction(async tx => {
      for (const draft of drafts) {
        const existing = await tx.ties.getById(draft._id);
        if (existing) continue; // 排过的轮次不覆盖
        const doc = { ...draft, schoolId: ctx.schoolId, association: ctx.association,
          revision: 1, updatedAt: nowIso };
        await tx.ties.set(draft._id, doc);
        nextTies.push(doc);
      }
    });
  }

  return { tiePatch, nextTies };
}

/**
 * 撤销一场学院赛小场之前：这道撤销会不会把签表留在悬空状态。
 *
 * 与个人赛的「已排进下一轮就撤不动」同一个道理（见 match-record.findDependentMatches）：
 * 分数撤得回，签表撤不回。大场一旦结束，下一轮大场就按它的胜者落成了真实记录，而
 * 写入侧只给 upsert / patch、没有删除，那个推进又是「只补不覆盖」。撤下去只会让下一轮
 * 顶着一个作废的晋级者留在台账里，因此要求管理员从最后一轮往前撤。
 *
 * 另一种拦法在大场那一侧：撤的是决定性的那一场时，大场会再也打不完——小场作废即终态，
 * 既不能重录也不能重开（见 revertLegResult）。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 待撤销的小场（matches 原始文档）
 * @returns {Promise<string>} 拒绝理由；可以撤时给空串
 */
async function collegeLegRevokeBlocker(ctx, legMatch) {
  if (!isLegMatch(legMatch)) return '';

  const tie = await ctx.repo.ties.getById(legMatch.tieId);
  if (!belongsTo(tie, ctx)) return ''; // 大场查不到：不拦，撤销本身没问题

  const ties = (await ctx.repo.forScope(ctx).ties.list()).filter(item => item.eventId === tie.eventId);
  const ahead = ties.filter(item => Number(item.round) > Number(tie.round));
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
 * 要在比赛记录已经作废之后再调——撤销失败时不该动大场。
 *
 * @param {Object} ctx
 * @param {Object} legMatch 已作废的小场（matches 原始文档）
 * @returns {Promise<Object|null>} 写回大场的字段，没动过大场时给 null
 */
async function revertCollegeAfterRevoke(ctx, legMatch) {
  if (!isLegMatch(legMatch)) return null;

  let tiePatch = null;
  await ctx.repo.transaction(async tx => {
    // 与 advanceCollegeAfterLeg 同理：legs 是整份数组的整体写入，必须在事务里重读，
    // 否则两场小项一前一后地撤会互相冲掉。
    const tie = await tx.ties.getById(legMatch.tieId);
    if (!tie) return;
    const event = await tx.collegeEvents.getById(tie.eventId);
    const reverted = revertLegResult({ tie, event, legNo: legMatch.legNo });
    // 拦截已经在前置检查里做过；这里再判一次是为了「查到什么就是什么」
    if (!reverted || !reverted.patch) return;

    tiePatch = reverted.patch;
    await tx.ties.set(tie._id, { ...tie, ...tiePatch,
      revision: Number(tie.revision || 1) + 1, updatedAt: iso(ctx.now) });
  });
  return tiePatch;
}

module.exports = { advanceCollegeAfterLeg, collegeLegRevokeBlocker, revertCollegeAfterRevoke };
