/**
 * 赛季管理写/读接口：查看赛季状态、开始新赛季
 * ============================================================
 * 【为什么分界点要落库而不是客户端算】
 * 分界点决定哪些赛事算进本赛季。若让客户端自己定，改一个时间就能
 * 把上一赛季的积分算进来；而且每台设备算出来的还不一样。
 * 所以服务端只认两件事：谁在操作（OpenID 回查）、现在几点（服务端时钟）。
 *
 * 【为什么分界点用服务端此刻】
 * 开始新赛季 = 「从这一刻起算」。用客户端时钟的话，一台走慢一天的手机
 * 就会把分界点设到过去，上一批比赛被错误地算进新赛季。
 *
 * 【为什么权限门槛是 ADMIN】
 * 见 services/season.js 的说明：影响面比发一条公告大得多。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { loadSeason, writeSeasonReset } = require('./season.js');
const { canResetSeason } = require('../../lib/services/season.js');

/* ============================================================
 * 读接口：getSeasonState
 *
 * 「谁能重置」不在这里判定，只回报赛季本身的状态。
 * 与其它读接口（read-handlers.js）一致：不拦未登录，也不把权限结论
 * 混进返回值。小程序内的赛季管理页已移除，重置改为管理员在云控制台
 * 手动调用 resetSeason；读接口仍供赛事页显示「第 N 赛季」。
 * ============================================================ */

/**
 * 把赛季文档整形成界面要的形状，绝不漏字段给渲染层。
 * @param {Object} season
 * @returns {{anchorTime:*, resetTime:*, seasonNumber:number, version:number}}
 */
function shapeSeason(season) {
  return {
    anchorTime: season.anchorTime || null,
    resetTime: season.resetTime || null,
    // 界面上的「第 N 赛季」读这个编号，读到的绝不是写缓存用的 version
    seasonNumber: Number(season.seasonNumber || 1),
    version: Number(season.version || 0),
  };
}

/**
 * 读取当前赛季状态。赛事页据此显示「第 N 赛季」与本赛季起算时间。
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<Object>} {anchorTime, resetTime, seasonNumber, version}
 */
async function getSeasonState(payload = {}, ctx) {
  const season = await loadSeason(ctx.repo, ctx.association);
  return ok(shapeSeason(season));
}

/**
 * 开始新赛季。
 *
 * 只写分界点与赛季编号，不直接改任何人的积分——积分是派生数据，下一次
 * 读取时由回放引擎按分界点切分（见 replay.js 的 applyEventPoints）。
 * 等级分跨赛季连续累计，不参与重置。
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, season, message}
 */
async function resetSeason(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canResetSeason(ctx.actor, { isMock: false })) {
    return ok({ ok: false, season: null, message: '只有管理员可以开始新赛季' });
  }

  const season = await ctx.repo.transaction(async (tx) =>
    writeSeasonReset(tx, { association: ctx.association, resetTime: ctx.now, now: ctx.now })
  );

  return ok({ ok: true, season: shapeSeason(season), message: '' });
}

module.exports = { getSeasonState, resetSeason };
