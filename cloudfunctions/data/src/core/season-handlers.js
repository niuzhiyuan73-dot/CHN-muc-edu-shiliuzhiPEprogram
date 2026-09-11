/**
 * 赛季管理写/读接口：查看赛季状态、执行软重置
 * ============================================================
 * 【为什么重置要落库而不是客户端算】
 * 软重置会改变全俱乐部每个人的分数。若让客户端自己压一遍再上送，
 * 改一个分数就能凭空多出几百点；而且每台设备算出来的还不一样。
 * 所以服务端只认两件事：谁在操作（OpenID 回查）、现在几点（服务端时钟）。
 * 压分本身由回放引擎统一做，结果自然一致。
 *
 * 【为什么分界点用服务端此刻】
 * 重置 = 「从这一刻起新赛季」。用客户端时钟的话，一台走慢一天的手机
 * 就会把分界点设到过去，上一批比赛被错误地算进新赛季。
 *
 * 【为什么权限门槛是 ADMIN】
 * 见 services/season.js 的说明：重置的影响面比发一条公告大得多。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { loadSeason, writeSeasonReset } = require('./season.js');
const { DEFAULT_RESET_POLICY, canResetSeason } = require('../../lib/services/season.js');

/* ============================================================
 * 读接口：getSeasonState
 *
 * 「谁能重置」不在这里判定，只回报赛季本身的状态。
 * 与其它读接口（read-handlers.js）一致：不拦未登录，也不把权限结论
 * 混进返回值——权限是视图层的事（services/season-view.js 用
 * canResetSeason 自行判定），数据接口只负责给数据。
 * 这样 mock 与云端返回同一形状，页面行为才不会分叉。
 * ============================================================ */

/**
 * 把赛季文档整形成界面要的形状，绝不漏字段给渲染层。
 * @param {Object} season
 * @returns {{anchorTime:*, resetTime:*, policy:Object, version:number}}
 */
function shapeSeason(season) {
  return {
    anchorTime: season.anchorTime || null,
    resetTime: season.resetTime || null,
    // 从未重置过时返回默认策略，界面照样能说明「重置后会怎么压分」
    policy: season.resetPolicy || DEFAULT_RESET_POLICY,
    version: Number(season.version || 0),
  };
}

/**
 * 读取当前赛季状态。管理页据此显示锚点、上次重置时间与压分策略。
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<Object>} {anchorTime, resetTime, policy, version}
 */
async function getSeasonState(payload = {}, ctx) {
  const season = await loadSeason(ctx.repo);
  return ok(shapeSeason(season));
}

/**
 * 执行一次赛季软重置。
 *
 * 只写分界点与策略，不直接改任何人的分数——分数是派生数据，下一次读取
 * 时由回放引擎在分界处统一压分，并把起点分一起刷新（见 replay.js）。
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, season, message}
 */
async function resetSeason(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canResetSeason(ctx.actor, { isMock: false })) {
    return ok({ ok: false, season: null, message: '只有管理员可以执行赛季重置' });
  }

  const season = await ctx.repo.transaction(async (tx) =>
    writeSeasonReset(tx, {
      resetTime: ctx.now,
      policy: DEFAULT_RESET_POLICY,
      now: ctx.now,
    })
  );

  return ok({ ok: true, season: shapeSeason(season), message: '' });
}

module.exports = { getSeasonState, resetSeason };
