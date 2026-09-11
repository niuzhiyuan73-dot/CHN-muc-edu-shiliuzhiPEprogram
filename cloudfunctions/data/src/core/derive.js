/**
 * 数据集派生（服务端版的 mock.buildCache）
 * ============================================================
 * 【为什么等级分不落库】
 * 分数是比赛流水的派生结果：流水与算法一定，分数就唯一确定。一旦把分数
 * 单独存一份，就有了「流水改了、分数没跟着改」的可能——而这种不一致在
 * 撤销比赛、调整算法参数时几乎必然发生。
 *
 * 所以这里照搬本地 mock 的做法：把「已生效」的比赛按时间重放一遍，让
 * 分数自己长出来。差别只在数据从数据库读、以及锚点由赛季文档钉死。
 *
 * 【为什么要有缓存】
 * 重放要跑两遍（先探定级依据，再正式算），600 场大约几十毫秒。每次读
 * 都重算，云函数的计费时长会很难看。于是按「仓储 + 算法版本 + 锚点」
 * 做缓存，写操作让版本号 +1 从而让缓存失效。
 *
 * 【缓存为什么用 WeakMap 挂在仓储上】
 * 测试会造很多个互不相干的内存仓储，用模块级单变量缓存会互相串味。
 * 挂在仓储对象上，天然隔离；云函数那边仓储是容器级的单例，缓存也就
 * 自然地在热容器里留存下来。
 * ============================================================
 */

const { replaySeason } = require('../../lib/services/replay.js');
const { createNameResolver } = require('../../lib/utils/stats.js');
const {
  MATCH_STATUS,
  USER_STATUS,
  ANNOUNCEMENT_STATUS,
} = require('../../lib/utils/constants.js');
const { loadSeason } = require('./season.js');

/** 仓储 → { key, dataset } */
const memoByRepo = new WeakMap();

/**
 * 从数据库读原始数据，重放成一份完整数据集。
 *
 * 与 mock.buildCache 一一对应：
 *   会员 = 审核通过的人；待审核 / 已驳回的归入「申请」，不进回放名单。
 *   台账 = 全部比赛（含待确认、已撤销），已生效的取回放结果（带逐人明细）。
 *   公告 = 全部公告按发布时间倒序；对外列表剔掉已下架的。
 *
 * 【为什么「已生效」的比赛要先筛掉再回放】
 * 回放引擎会把每一场无条件改写成 ACTIVE（见 replay.js 的 runReplay），
 * 一场待确认的比赛只要进了回放就会被静默激活并计入等级分，「对手确认」
 * 这道闸门等于白设。
 *
 * @param {Object} repo
 * @param {Object} season
 * @returns {Promise<Object>}
 */
async function buildDataset(repo, season) {
  const [allUsers, allMatches, events, announcementDocs] = await Promise.all([
    repo.users.list(),
    repo.matches.list(),
    repo.events.list(),
    repo.announcements.list(),
  ]);

  const members = allUsers.filter((user) => user.status === USER_STATUS.ACTIVE);
  const applications = allUsers.filter((user) => user.status !== USER_STATUS.ACTIVE);

  // 复制一份再动：就地改数据库读回来的对象，会让调用方看到意外变化
  const staged = allMatches.map((match) => ({ ...match }));
  const activeOnly = staged.filter((match) => match.status === MATCH_STATUS.ACTIVE);

  const replayed = replaySeason({
    members,
    matches: activeOnly,
    events,
    // 锚点由赛季文档钉死；还没定下时传 null，回放会退回「流水里最早一场」。
    // 软重置的分界点与策略同样落库，回放据此在分界处压分并刷新起点分。
    options: {
      seasonStart: season.anchorTime,
      resetTime: season.resetTime || null,
      resetPolicy: season.resetPolicy || null,
    },
  });

  const replayedById = new Map(replayed.matches.map((match) => [match._id, match]));
  const ledger = staged.map((match) => replayedById.get(match._id) || match);

  const announcementLedger = [...announcementDocs].sort(
    (a, b) => new Date(b.publishTime) - new Date(a.publishTime)
  );
  const announcements = announcementLedger.filter(
    (item) => item.status !== ANNOUNCEMENT_STATUS.ARCHIVED
  );

  return {
    ...replayed,
    // replayed.users 已带上分数与场次，给它一个与 mock 一致的名字
    members: replayed.users,
    applications,
    ledger,
    announcements,
    announcementLedger,
    nameOf: createNameResolver(replayed.users),
  };
}

/**
 * 取数据集，命中缓存就直接返回。
 * @param {Object} ctx 调用上下文
 * @returns {Promise<Object>}
 */
async function getDataset(ctx) {
  const season = await loadSeason(ctx.repo);
  const key = [
    season._id,
    Number(season.version || 0),
    season.algoVersion,
    season.anchorTime ? new Date(season.anchorTime).getTime() : 'n',
    // 重置分界也算缓存键的一部分：写重置时版本号已经 +1，这里再显式带上，
    // 是为了让「改了分界点却没动版本号」这种意外不至于悄悄命中旧缓存。
    season.resetTime ? new Date(season.resetTime).getTime() : 'n',
  ].join(':');

  const cached = memoByRepo.get(ctx.repo);
  if (cached && cached.key === key) return cached.dataset;

  const dataset = await buildDataset(ctx.repo, season);
  memoByRepo.set(ctx.repo, { key, dataset });
  return dataset;
}

/**
 * 清掉某个仓储的缓存。测试用；线上不需要——写操作让版本号变化，缓存自然失效。
 * @param {Object} repo
 */
function resetMemo(repo) {
  memoByRepo.delete(repo);
}

module.exports = { buildDataset, getDataset, resetMemo };
