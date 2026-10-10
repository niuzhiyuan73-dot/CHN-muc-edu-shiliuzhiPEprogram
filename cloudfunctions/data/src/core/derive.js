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
 *
 * 【为什么还有一层落库的排行榜快照】
 * WeakMap 活在容器里：容器一冷启动就没了，第一读仍要全表读 + 两遍回放，
 * 流水越长这笔开销越大。于是把算好的数据集再写一份到 rankings 集合，
 * 键就是上面那串缓存键——写操作让版本号 +1，旧快照自然作废，行为与
 * 内存缓存完全一致。快照是纯缓存：随时可删、写失败不影响读、体积超限
 * 就退回重放（见 SNAPSHOT_MAX_BYTES）。等级分「以流水为唯一事实来源」
 * 这条没有被打破，快照只是把重放结果暂存了一份。
 * ============================================================
 */

const { replaySeason } = require('../../lib/services/replay.js');
const { isEloEligibleMatch } = require('../../lib/services/college-tie.js');
const { findCappedMatchIds } = require('../../lib/services/rating-cap.js');
const { createNameResolver } = require('../../lib/utils/stats.js');
const {
  USER_STATUS,
  ANNOUNCEMENT_STATUS,
  isMemberStatus,
} = require('../../lib/utils/constants.js');
const { loadSeason, ALGO_VERSION } = require('./season.js');
const { effectiveRole } = require('./context.js');
const { belongsToAssociation } = require('../../lib/utils/associations.js');

/**
 * 仓储 → (协会 → { key, dataset })。
 *
 * 【为什么每个协会各存一份】
 * 容器热起来后同一份仓储要同时服务多个协会。若只留一份缓存，乒乓球的读
 * 会顶掉匹克球的缓存，两边轮流失效、次次重放。按协会分开，各自命中各自
 * 的。仓储本身仍是 WeakMap 的键，测试造很多仓储也不会串味。
 */
const memoByRepo = new WeakMap();

/** 取（或新建）某仓储的「按协会」缓存表 */
function memoFor(repo) {
  let byAssoc = memoByRepo.get(repo);
  if (!byAssoc) {
    byAssoc = new Map();
    memoByRepo.set(repo, byAssoc);
  }
  return byAssoc;
}

/**
 * 改造前唯一排行榜快照的 _id。多协会改造后每个协会各一份，取
 * `current_<assoc>`；仅在协会缺省时落回它。
 */
const RANKING_SNAPSHOT_ID = 'current';

/**
 * 某个协会的排行榜快照 _id（快照只是缓存的落库版，随时可删）。
 * @param {string} [association]
 * @returns {string}
 */
function rankingSnapshotId(association) {
  return association ? `current_${association}` : RANKING_SNAPSHOT_ID;
}

/**
 * 快照单文档的体积上限。
 *
 * 【为什么要有这道闸】
 * 云开发单条记录有大小硬限，而这份快照装的是整份数据集：流水越多它越大。
 * 超过闸门就干脆不写——宁可每次重放，也不能让写快照把整个读接口带崩。
 * 真正到流水塞不下的一天，再把快照拆成「按人一行」。
 */
const SNAPSHOT_MAX_BYTES = 900 * 1024;

/**
 * 数据集 → 可落库的快照。
 * nameOf 是函数（createNameResolver 的产物），落不了库，读回来时现建。
 * @param {Object} dataset
 * @returns {Object}
 */
function toSnapshot(dataset) {
  const payload = { ...dataset };
  delete payload.nameOf;
  return payload;
}

/**
 * 快照 → 数据集。补上落库时丢掉的 nameOf。
 * @param {Object} payload
 * @returns {Object}
 */
function fromSnapshot(payload) {
  return { ...payload, nameOf: createNameResolver(payload.users || []) };
}

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
 * @param {string} association 数据所属协会
 * @returns {Promise<Object>}
 */
async function buildDataset(repo, season, association) {
  const [allUsers, allMatches, allEvents, allAnnouncements, allMemberships] = await Promise.all([
    repo.users.list(),
    repo.matches.list(),
    repo.events.list(),
    repo.announcements.list(),
    repo.memberships && typeof repo.memberships.list === 'function'
      ? repo.memberships.list()
      : Promise.resolve([]),
  ]);

  // 内容数据按协会过滤；账号是全局的一份，不过滤（改造前缺 association 的
  // 旧文档视作 pkb，见 associations.belongsToAssociation）。
  const events = allEvents.filter((event) => belongsToAssociation(event, association));
  const announcementDocs = allAnnouncements.filter((doc) =>
    belongsToAssociation(doc, association)
  );
  const scopedMatches = allMatches.filter((match) => belongsToAssociation(match, association));

  // 「在册」= 正常 + 已离校。离校的人不能再上榜、不能报名，但历史比赛
  // 还在流水里，回放名单少了他会直接抛错——所以名单按 isMemberStatus 取，
  // 上榜与报名另有闸门（见 leaderboard.isRankable 与 event.canSignUp）。
  const members = allUsers.filter((user) => isMemberStatus(user.status));
  const applications = allUsers.filter((user) => !isMemberStatus(user.status));

  // 复制一份再动：就地改数据库读回来的对象，会让调用方看到意外变化
  const staged = scopedMatches.map((match) => ({ ...match }));
  // 进回放的只有「计个人等级分」的比赛：已生效、非弃权，且学院赛里只有
  // 单打小场（双打小场只汇总大场，见 college-tie.isEloEligibleMatch）。
  // 台账仍是完整的 staged，录分页按编号取小场不受影响。
  //
  // 再排除防刷分超限的场次（见 rating-cap.js）：一对会员一个赛季最多
  // RATED_PAIR_LIMIT 场日常约球计分，多出来的就不进流水了。与弃权同一路数
  // ——「记录在案，但不计分」，台账仍是完整的 staged。
  const cappedIds = findCappedMatchIds(staged, { seasonStart: season.resetTime });
  const activeOnly = staged.filter(
    (match) => isEloEligibleMatch(match) && !cappedIds.has(String(match._id))
  );

  const replayed = replaySeason({
    members,
    matches: activeOnly,
    events,
    // 锚点由赛季文档钉死；还没定下时传 null，回放会退回「流水里最早一场」。
    // 赛季分界点同样落库，回放据此把分界之前的赛事积分排除在本赛季之外。
    options: {
      seasonStart: season.anchorTime,
      resetTime: season.resetTime || null,
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

  // 会员名单上的 role 要按本协会的成员行换成**有效角色**：账号上的全局 role
  // 只有 MEMBER / ADMIN，学院负责人的身份记在 memberships 里。不下发这一步，
  // 界面上的身份标签与权限入口就与 ctx 里算出来的有效角色对不上。
  const membershipByUser = new Map();
  for (const row of allMemberships) {
    if (belongsToAssociation(row, association) && row.userId) {
      membershipByUser.set(row.userId, row);
    }
  }
  const membersWithRole = replayed.users.map((user) => {
    const row = membershipByUser.get(user._id);
    return row ? { ...user, role: effectiveRole(user.role, row) } : user;
  });

  return {
    ...replayed,
    users: membersWithRole,
    // replayed.users 已带上分数与场次，给它一个与 mock 一致的名字
    members: membersWithRole,
    applications,
    ledger,
    announcements,
    announcementLedger,
    nameOf: createNameResolver(membersWithRole),
  };
}

/**
 * 取数据集，命中缓存就直接返回。
 * @param {Object} ctx 调用上下文
 * @returns {Promise<Object>}
 */
async function getDataset(ctx) {
  const association = ctx.association || '';
  const season = await loadSeason(ctx.repo, association);
  const key = [
    association,
    season._id,
    Number(season.version || 0),
    season.algoVersion,
    // 代码里的算法版本也要进键。只认赛季文档里的 algoVersion 有个缺口：
    // 调完参把常量加一、尚未发生任何写入时，文档里存的还是调参前的旧值，
    // 「算法调参后自动重算」（season.js 头部）就落不了地——容器里若留着
    // 旧缓存，新算法要等到下一次写操作才生效。带上常量，加一即失效。
    ALGO_VERSION,
    season.anchorTime ? new Date(season.anchorTime).getTime() : 'n',
    // 赛季分界也算缓存键的一部分：开始新赛季时版本号已经 +1，这里再显式
    // 带上，是为了让「改了分界点却没动版本号」这种意外不至于命中旧缓存。
    season.resetTime ? new Date(season.resetTime).getTime() : 'n',
  ].join(':');

  const memo = memoFor(ctx.repo);
  const cached = memo.get(association);
  if (cached && cached.key === key) return cached.dataset;

  // 容器内存缓存没命中，再退一步看落库的快照。云函数冷启动时内存缓存
  // 一定是空的，这一层才是「省掉全表读 + 两遍回放」的地方。
  const stored = await readSnapshot(ctx.repo, key, association);
  if (stored) {
    memo.set(association, { key, dataset: stored });
    return stored;
  }

  const dataset = await buildDataset(ctx.repo, season, association);
  memo.set(association, { key, dataset });
  await writeSnapshot(ctx.repo, key, dataset, association);
  return dataset;
}

/**
 * 读排行榜快照。键对不上（写操作让版本号变了）或读失败都当作没有，
 * 交给上层重放——快照只是缓存，绝不能因为读它出错而让接口挂掉。
 *
 * @param {Object} repo
 * @param {string} key
 * @param {string} [association]
 * @returns {Promise<Object|null>}
 */
async function readSnapshot(repo, key, association = '') {
  if (!repo.rankings || typeof repo.rankings.get !== 'function') return null;
  try {
    const doc = await repo.rankings.get(rankingSnapshotId(association));
    // 除了键，还要看必备字段在不在：一条被手工改坏的快照不该让读接口崩
    if (!doc || doc.key !== key || !doc.data) return null;
    if (!Array.isArray(doc.data.users) || !Array.isArray(doc.data.ledger)) return null;
    return fromSnapshot(doc.data);
  } catch (err) {
    return null;
  }
}

/**
 * 把刚算好的数据集写成快照。best-effort：体积超限或写失败都只是静默跳过，
 * 不影响这次读返回正确结果。
 *
 * @param {Object} repo
 * @param {string} key
 * @param {Object} dataset
 * @param {string} [association]
 * @returns {Promise<void>}
 */
async function writeSnapshot(repo, key, dataset, association = '') {
  if (!repo.rankings || typeof repo.rankings.set !== 'function') return;
  try {
    const data = toSnapshot(dataset);
    if (JSON.stringify(data).length > SNAPSHOT_MAX_BYTES) return;
    await repo.rankings.set(rankingSnapshotId(association), {
      key,
      algoVersion: ALGO_VERSION,
      savedAt: new Date(),
      data,
    });
  } catch (err) {
    // 快照写失败不该影响这次读；下一次读会再试
  }
}

/**
 * 清掉某个仓储的缓存。测试用；线上不需要——写操作让版本号变化，缓存自然失效。
 * @param {Object} repo
 */
function resetMemo(repo) {
  memoByRepo.delete(repo);
}

module.exports = { buildDataset, getDataset, resetMemo, rankingSnapshotId };
