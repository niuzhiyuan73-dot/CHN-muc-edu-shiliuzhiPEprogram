/**
 * 赛季读接口：查看赛季状态
 * ============================================================
 * 赛季锚点决定谁是「创始会员」、谁是「中途入会者」（见 season.js），
 * 界面据此说明「本赛季从哪一刻起算」。赛事页的赛季文案读这里。
 *
 * 与其它读接口（read-handlers.js）一致：不拦未登录，也不把权限结论
 * 混进返回值。
 * ============================================================
 */

const { ok } = require('../envelope.js');
const { loadSeason } = require('./season.js');

/**
 * 把赛季文档整形成界面要的形状，绝不漏字段给渲染层。
 * @param {Object} season
 * @returns {{anchorTime:*}}
 */
function shapeSeason(season) {
  return { anchorTime: season.anchorTime || null };
}

/**
 * 读取当前赛季状态。
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<Object>} {anchorTime}
 */
async function getSeasonState(payload = {}, ctx) {
  const season = await loadSeason(ctx.repo);
  return ok(shapeSeason(season));
}

module.exports = { getSeasonState };
