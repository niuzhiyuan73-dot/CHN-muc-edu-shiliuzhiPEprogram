/**
 * 赛季锚点与版本号
 * ============================================================
 * 【赛季锚点为什么要落库钉死】
 * 锚点决定谁是「创始会员」、谁是「中途入会者」，进而决定要不要按前五场
 * 对手给他定级。它默认等于流水里最早一场比赛的时间——若让它跟着流水浮动，
 * 管理员撤销最早那场比赛就会让锚点后移，把一批创始会员重新判定成中途
 * 入会者，于是多人被重新定级、分数静默改变。一次「删掉一场录错的比赛」
 * 变成了全站分数漂移。所以锚点首次写入后不再重算。
 * （回归证据见 tests/season-anchor.test.js。）
 *
 * 【版本号是读缓存的唯一凭据】
 * 等级分不落库，而是每次读的时候由比赛流水重放出来（原因见 derive.js）。
 * 重放不便宜，所以结果缓存在云函数容器里。缓存什么时候失效？看版本号：
 * 任何一次写都让它 +1，下一次读发现版本变了就重放。加上「锚点」和
 * 「算法版本」，三者一起构成缓存的键——算法调参后也会自动重算。
 *
 * 【赛季编号绝不能拿版本号顶替】
 * 版本号是「写了几次」的计数器：录一场球、审一位会员、发一条公告都会 +1。
 * 把它当成「第几赛季」显示，界面上的赛季数就会随着日常操作一路狂涨——
 * 管理员什么都没做，赛季却从第四跳到了第六。所以另立一个只由
 * writeSeasonReset（「开始新赛季」）递增的编号 seasonNumber，默认 1，
 * 其余任何写入都不许碰它。
 * ============================================================
 */

/**
 * 改造前唯一赛季文档的 _id。多协会改造后，每个协会各有自己的当前赛季，
 * _id 取 `current_<assoc>`；仅在协会缺省时（旧数据 / 旧调用）才落回它。
 */
const SEASON_ID = 'current';

/**
 * 某个协会的当前赛季文档 _id。
 *
 * 【为什么带协会后缀】
 * 赛季锚点、版本号、赛季编号都是「每协会各一份」——乒乓球的第 3 赛季与
 * 羽毛球毫无关系。若共用一个 `current`，一个协会开新赛季会把另一个协会的
 * 缓存全部冲掉（版本号 +1），读取也会串到一起。
 *
 * @param {string} [association]
 * @returns {string}
 */
function seasonId(association) {
  return association ? `current_${association}` : SEASON_ID;
}

/**
 * 算法版本。改动 ELO 参数、K 值、积分规则、定级规则时都要 +1，
 * 否则容器里缓存的旧结果会被继续沿用，改了算法却不生效。
 *
 * 6：赛季更新不再压缩等级分，只切积分。此前落库的重放缓存是按
 *    「分界处压分」算出来的，语义变了必须让它们全部失效。
 * 7：加入防刷分上限（同一对会员每赛季 15 场，见 rating-cap.js）。
 *    进回放的流水少了一批，等级分随之改变，旧缓存同样必须失效；
 *    日后调整 RATED_PAIR_LIMIT 也要在这里 +1。
 */
// 8：保留停用参赛者回放、保留改分事件历史，作废旧派生快照。
const ALGO_VERSION = 8;

/**
 * 赛季文档的缺省形状。数据库里还没有 seasons 文档时用它顶上，
 * 这样读接口不必先写库就能正常工作。
 * @returns {Object}
 */
function defaultSeason(association = '') {
  return {
    _id: seasonId(association),
    anchorTime: null,
    // 最近一次赛季分界点。null 表示从未开始过新赛季。
    // 参与回放：分界之前的赛事积分不计入本赛季。等级分不受影响。
    resetTime: null,
    // 赛季编号。只有 writeSeasonReset（开始新赛季）能 +1，默认从第一赛季起。
    seasonNumber: 1,
    version: 0,
    algoVersion: ALGO_VERSION,
  };
}

/**
 * 读赛季文档（缺省时返回默认值，不写库）。
 * @param {Object} repo
 * @param {string} [association] 协会 id；缺省落回旧单例 `current`
 * @returns {Promise<Object>}
 */
async function loadSeason(repo, association = '') {
  const doc = await repo.seasons.get(seasonId(association));
  return doc || defaultSeason(association);
}

/**
 * 在事务内把版本号加一，顺带在首次写入时把锚点定下。
 *
 * @param {Object} tx 事务内的仓储
 * @param {Object} [params]
 * @param {string} [params.association] 协会 id；缺省落回旧单例 `current`
 * @param {Date|string|null} [params.anchorTime] 候选锚点（通常是当前最早一场比赛的时间）
 * @param {Date} [params.now]
 * @returns {Promise<Object>} 写入后的赛季文档
 */
async function bumpSeason(tx, { association = '', anchorTime = null, now = new Date() } = {}) {
  const id = seasonId(association);
  const existing = await tx.seasons.get(id);
  const base = existing || defaultSeason(association);

  const next = {
    ...base,
    // 已经有了就绝不改动：这正是「钉死」二字的含义
    anchorTime: base.anchorTime || anchorTime || null,
    // 赛季编号与日常写入无关，原样带过（缺字段的老文档按第一赛季补上）
    seasonNumber: Number(base.seasonNumber || 1),
    version: Number(base.version || 0) + 1,
    algoVersion: ALGO_VERSION,
    updatedAt: now,
  };

  await tx.seasons.set(id, next);
  return next;
}

/** 全局账号变更：每个协会的会员数据都需要重建；包含已停用的协会。 */
async function bumpMemberSeasons(tx, { association = '', now = new Date() } = {}) {
  const { allAssociations } = require('../../lib/utils/associations.js');
  const ids = new Set([association, ...allAssociations().map((item) => item.id)]);
  for (const id of ids) await bumpSeason(tx, { association: id, now });
}

/**
 * 开始新赛季：写入分界点，并把版本号加一。
 *
 * 【为什么这也算一次「写」】
 * 版本号是读缓存的唯一凭据（见文件头）。分界点变了，本赛季的积分
 * 归属就变了，若不 +1，容器里那份旧的重放结果会被继续沿用，界面上
 * 看起来「点了开始新赛季却没反应」。锚点则沿用 bumpSeason 的纪律：
 * 已经有了就不动。
 *
 * @param {Object} tx 事务内的仓储
 * @param {Object} [params]
 * @param {string} [params.association] 协会 id；缺省落回旧单例 `current`
 * @param {Date|string} [params.resetTime] 分界点，通常是服务端此刻
 * @param {Date} [params.now]
 * @returns {Promise<Object>} 写入后的赛季文档
 */
async function writeSeasonReset(tx, { association = '', resetTime, now = new Date() } = {}) {
  const id = seasonId(association);
  const existing = await tx.seasons.get(id);
  const base = existing || defaultSeason(association);

  const next = {
    ...base,
    anchorTime: base.anchorTime || null,
    resetTime: resetTime || now,
    // 「开始新赛季」是唯一让编号前进的操作：第一赛季 → 第二赛季 → …
    seasonNumber: Number(base.seasonNumber || 1) + 1,
    version: Number(base.version || 0) + 1,
    algoVersion: ALGO_VERSION,
    updatedAt: now,
  };

  await tx.seasons.set(id, next);
  return next;
}

module.exports = {
  SEASON_ID,
  seasonId,
  ALGO_VERSION,
  defaultSeason,
  loadSeason,
  bumpSeason,
  bumpMemberSeasons,
  writeSeasonReset,
};
