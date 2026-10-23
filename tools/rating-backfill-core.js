/**
 * 评级冗余字段回填 · 核心逻辑（2026-10-23 方案 A 第 1 步）
 * ============================================================
 * 【要解决什么】
 * 榜单与个人主页的排名要按「项目（性别）」筛、要排除已转出的人，而这两个字段
 * 原本只存在 `users` / `school_members` 里。数据库不能跨集合 join，于是只能把
 * 8000 条评级读回来在内存里算（80 页）。方案 A 把 `gender` 与 `memberStatus`
 * 冗余进 `member_ratings`，让排序与计数能下推。
 *
 * 但**历史文档没有这两个字段**。读路径一旦按 `memberStatus: 'active'` 过滤，
 * 缺字段的老文档会被整体排除——榜单直接空。所以上线顺序是死的：
 * **先回填、后切读**。
 *
 * 【为什么不在云函数里做】
 * 回填要遍历全部评级并逐条写，一次跑完会撞云函数超时；做成小程序接口又要
 * 给客户端开一个「全库写」的入口，鉴权面太大。放到离线脚本、按游标分批跑，
 * 每次几十秒，中断了从上次的 cursor 续上即可。
 *
 * 【为什么不依赖任何 SDK】
 * 这里只认一个窄接口（见下方 BackfillAdapter），云适配器与内存适配器各写一份。
 * 好处是同一份逻辑能被单测钉住幂等性，而不必连真实云环境。
 *
 * 【幂等性】
 * 只写「与权威值不同」的文档。目标值与文档一致时一条都不写，因此重复执行
 * 是安全的：第二遍的 updated 必然为 0，可以作为「回填完成」的验收判据。
 * ============================================================
 */

/**
 * 适配器接口（实现见 backfill-rating-profile.js 与 tests/rating-backfill.test.js）：
 *
 *   listRatings({ schoolId, cursor, limit }) → { rows, nextCursor }
 *     按 `_id` 升序游标分页取该校评级文档。cursor 为 null 表示第一页。
 *
 *   usersByIds(ids) → rows           账号批读（取 gender）；缺失的人可以不出现在结果里
 *   membersByIds(ids, schoolId) → rows 名册批读（取 status）
 *   saveRating(id, patch) → void     按主键部分字段更新
 */

/** 单次批量的上限：云开发单次查询 100 条，写也不宜再多。 */
const MAX_BATCH = 100;

/**
 * 回填一批。
 *
 * @param {Object} adapter 见文件头的接口说明
 * @param {Object} options
 * @param {string} options.schoolId 只回填这一所学校
 * @param {string|null} [options.cursor] 上一批返回的 nextCursor
 * @param {number} [options.limit] 本批条数（1~100）
 * @param {boolean} [options.dryRun] 只统计不写（默认 true——先看清要改多少再落笔）
 * @param {Date|string|number} [options.now] 写进 profileSyncedAt 的时间
 * @returns {Promise<Object>} 统计与下一页游标
 */
async function backfillBatch(adapter, options = {}) {
  const schoolId = options.schoolId;
  if (!schoolId || typeof schoolId !== 'string') throw new Error('回填必须指定学校');
  const limit = clampLimit(options.limit);
  const dryRun = options.dryRun !== false;
  const syncedAt = options.now === undefined || options.now === null
    ? null : new Date(options.now).toISOString();

  const page = await adapter.listRatings({ schoolId, cursor: options.cursor || null, limit });
  const rows = Array.isArray(page && page.rows) ? page.rows : [];
  const nextCursor = (page && page.nextCursor) || null;

  // 一页里的评级多半来自几十个人（每人每池一条），批读去重后只有几十个 RPC。
  const userIds = [...new Set(rows.map(row => row.userId).filter(Boolean))];
  const [users, members] = await Promise.all([
    userIds.length ? adapter.usersByIds(userIds) : [],
    userIds.length ? adapter.membersByIds(userIds, schoolId) : [],
  ]);
  const genderById = new Map((users || []).map(user => [user._id, user.gender || '']));
  const statusById = new Map((members || []).map(member => [member.userId, member.status]));

  const stats = {
    schoolId,
    scanned: rows.length,
    updated: 0,
    unchanged: 0,
    orphanUser: 0,   // 评级在、账号没了
    orphanMember: 0, // 评级在、名册没了（人已离校但评级残留）
    samples: [],
    cursor: options.cursor || null,
    nextCursor,
    done: rows.length < limit || !nextCursor,
    dryRun,
  };

  for (const row of rows) {
    const userId = row.userId;
    if (!userId || !genderById.has(userId)) {
      stats.orphanUser += 1;
      continue;
    }
    if (!statusById.has(userId)) {
      stats.orphanMember += 1;
      continue;
    }
    const gender = genderById.get(userId);
    const memberStatus = statusById.get(userId);
    if (row.gender === gender && row.memberStatus === memberStatus) {
      stats.unchanged += 1;
      continue;
    }
    if (stats.samples.length < 5) {
      stats.samples.push({
        id: row._id,
        before: { gender: row.gender, memberStatus: row.memberStatus },
        after: { gender, memberStatus },
      });
    }
    if (!dryRun) {
      await adapter.saveRating(row._id, {
        gender, memberStatus, profileSyncedAt: syncedAt,
      });
    }
    stats.updated += 1;
  }

  return stats;
}

/**
 * 一直跑到结束。CLI 的默认行为；测试里也用它验「跑完两遍第二遍 0 条变更」。
 *
 * @param {Object} adapter
 * @param {Object} options 同 backfillBatch，另加
 * @param {number} [options.maxBatches] 上限保护（防手滑跑穿整个集合）
 * @param {Function} [options.onBatch] 每批回调，用于打印进度
 * @returns {Promise<Object>} 累计统计
 */
async function backfillAll(adapter, options = {}) {
  const maxBatches = Number.isInteger(options.maxBatches) && options.maxBatches > 0
    ? options.maxBatches : 200;
  const total = {
    batches: 0, scanned: 0, updated: 0, unchanged: 0,
    orphanUser: 0, orphanMember: 0, done: false, cursor: null, dryRun: options.dryRun !== false,
  };
  let cursor = options.cursor || null;
  for (let i = 0; i < maxBatches; i += 1) {
    const stats = await backfillBatch(adapter, { ...options, cursor });
    total.batches += 1;
    total.scanned += stats.scanned;
    total.updated += stats.updated;
    total.unchanged += stats.unchanged;
    total.orphanUser += stats.orphanUser;
    total.orphanMember += stats.orphanMember;
    cursor = stats.nextCursor;
    total.cursor = cursor;
    if (typeof options.onBatch === 'function') options.onBatch(stats, total.batches);
    if (stats.done) { total.done = true; break; }
    // 没有游标又不能算完，说明适配器没给分页信息，继续跑只会重复读第一页。
    if (!cursor) break;
  }
  return total;
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return MAX_BATCH;
  return Math.min(Math.floor(n), MAX_BATCH);
}

module.exports = { backfillBatch, backfillAll, MAX_BATCH };
