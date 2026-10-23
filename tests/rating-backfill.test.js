/**
 * 评级冗余字段回填（2026-10-23 方案 A 第 1 步）
 * ============================================================
 * 这一层要钉住的是**回填的语义**，不是 SQL 写得好不好看：
 *   · 老文档缺 `gender` / `memberStatus` → 按权威表补齐（否则切读后榜单为空）；
 *   · 已经一致的文档一条都不写（幂等，「跑第二遍 updated 必须是 0」是验收判据）；
 *   · 名册/账号缺失的孤儿文档不猜、不写，只计数——它们要么该清、要么该补名册；
 *   · 游标分页与 dry-run 的行为。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { backfillBatch, backfillAll } = require('../tools/rating-backfill-core.js');

const SCHOOL = 'muc';

/** 造一份「回填前」的评级文档：只有评分事实，没有冗余档案字段。 */
function legacyRating(userId, pool, { gender, memberStatus } = {}) {
  const row = {
    _id: `mr:${SCHOOL}:pkb:${userId}:${pool}`,
    schoolId: SCHOOL,
    association: 'pkb',
    userId,
    pool,
    elo: 1500,
    startElo: 1500,
    matchCount: 3,
    version: 3,
  };
  if (gender !== undefined) row.gender = gender;
  if (memberStatus !== undefined) row.memberStatus = memberStatus;
  return row;
}

function makeAdapter({ ratings, users, members }) {
  const writes = [];
  const store = ratings.map(row => ({ ...row }));
  return {
    store,
    writes,
    async listRatings({ schoolId, cursor, limit }) {
      const all = store
        .filter(row => row.schoolId === schoolId)
        .sort((a, b) => (a._id < b._id ? -1 : 1))
        .filter(row => !cursor || row._id > cursor);
      const rows = all.slice(0, limit);
      return { rows, nextCursor: rows.length ? rows[rows.length - 1]._id : null };
    },
    async usersByIds(ids) {
      const set = new Set(ids);
      return users.filter(user => set.has(user._id));
    },
    async membersByIds(ids, schoolId) {
      const set = new Set(ids);
      return members.filter(member => set.has(member.userId) && member.schoolId === schoolId);
    },
    async saveRating(id, patch) {
      writes.push({ id, patch });
      const row = store.find(item => item._id === id);
      if (row) Object.assign(row, patch);
    },
  };
}

const USERS = [
  { _id: 'u1', gender: 'M' },
  { _id: 'u2', gender: 'F' },
  { _id: 'u3', gender: 'M' },
];
const MEMBERS = [
  { _id: `sm:${SCHOOL}:u1`, userId: 'u1', schoolId: SCHOOL, status: 'active' },
  { _id: `sm:${SCHOOL}:u2`, userId: 'u2', schoolId: SCHOOL, status: 'transferred' },
  { _id: `sm:${SCHOOL}:u3`, userId: 'u3', schoolId: SCHOOL, status: 'active' },
];

describe('评级冗余字段回填', () => {
  test('老文档缺字段：按 users.gender 与 school_members.status 补齐', async () => {
    const adapter = makeAdapter({
      ratings: [legacyRating('u1', 'singles'), legacyRating('u2', 'doubles')],
      users: USERS,
      members: MEMBERS,
    });
    const stats = await backfillBatch(adapter, { schoolId: SCHOOL, dryRun: false, now: '2026-10-23T02:00:00Z' });
    assert.equal(stats.scanned, 2);
    assert.equal(stats.updated, 2);
    assert.equal(stats.unchanged, 0);
    assert.equal(stats.done, true);
    const u1 = adapter.store.find(row => row.userId === 'u1');
    assert.equal(u1.gender, 'M');
    assert.equal(u1.memberStatus, 'active');
    const u2 = adapter.store.find(row => row.userId === 'u2');
    assert.equal(u2.gender, 'F');
    assert.equal(u2.memberStatus, 'transferred', '已转出的人要落 transferred，否则原校榜单仍算他');
    assert.equal(u1.profileSyncedAt, '2026-10-23T02:00:00.000Z');
  });

  test('幂等：连跑两遍，第二遍一条都不写', async () => {
    const adapter = makeAdapter({
      ratings: [legacyRating('u1', 'singles'), legacyRating('u2', 'singles')],
      users: USERS,
      members: MEMBERS,
    });
    const first = await backfillAll(adapter, { schoolId: SCHOOL, dryRun: false, limit: 100 });
    assert.equal(first.updated, 2);
    const writesAfterFirst = adapter.writes.length;
    const second = await backfillAll(adapter, { schoolId: SCHOOL, dryRun: false, limit: 100 });
    assert.equal(second.updated, 0, '第二遍必须 0 变更，这是「回填完成」的验收判据');
    assert.equal(second.unchanged, 2);
    assert.equal(adapter.writes.length, writesAfterFirst, '没有变化就不该产生写请求');
  });

  test('dry-run 只统计不落库', async () => {
    const adapter = makeAdapter({
      ratings: [legacyRating('u1', 'singles')],
      users: USERS,
      members: MEMBERS,
    });
    const stats = await backfillBatch(adapter, { schoolId: SCHOOL, limit: 100 });
    assert.equal(stats.dryRun, true);
    assert.equal(stats.updated, 1);
    assert.equal(adapter.writes.length, 0);
    assert.equal(adapter.store[0].gender, undefined, 'DB 上没有这个字段');
  });

  test('已一致与待改混排：只写待改的那条', async () => {
    const adapter = makeAdapter({
      ratings: [
        legacyRating('u1', 'singles', { gender: 'M', memberStatus: 'active' }),
        legacyRating('u3', 'singles', { gender: 'F', memberStatus: 'active' }),
      ],
      users: USERS,
      members: MEMBERS,
    });
    const stats = await backfillBatch(adapter, { schoolId: SCHOOL, dryRun: false });
    assert.equal(stats.updated, 1);
    assert.equal(stats.unchanged, 1);
    assert.equal(adapter.writes.length, 1);
    assert.ok(adapter.writes[0].id.includes('u3'), '写的是性别对不上的那条');
  });

  test('名册里查不到人的评级：计入 orphanMember，不猜状态', async () => {
    const adapter = makeAdapter({
      ratings: [legacyRating('ghost', 'singles')],
      users: [...USERS, { _id: 'ghost', gender: 'M' }],
      members: MEMBERS,
    });
    const stats = await backfillBatch(adapter, { schoolId: SCHOOL, dryRun: false });
    assert.equal(stats.orphanMember, 1);
    assert.equal(stats.updated, 0);
    assert.equal(adapter.writes.length, 0);
    assert.equal(adapter.store[0].memberStatus, undefined);
  });

  test('账号已不存在的评级：计入 orphanUser', async () => {
    const adapter = makeAdapter({
      ratings: [legacyRating('gone', 'singles')],
      users: USERS,
      members: [...MEMBERS, { userId: 'gone', schoolId: SCHOOL, status: 'active' }],
    });
    const stats = await backfillBatch(adapter, { schoolId: SCHOOL, dryRun: false });
    assert.equal(stats.orphanUser, 1);
    assert.equal(stats.updated, 0);
  });

  test('游标分页：小批量跑完不重不漏', async () => {
    const ratings = [];
    for (const user of ['u1', 'u2', 'u3']) {
      for (const pool of ['singles', 'doubles']) ratings.push(legacyRating(user, pool));
    }
    const adapter = makeAdapter({ ratings, users: USERS, members: MEMBERS });
    const total = await backfillAll(adapter, { schoolId: SCHOOL, dryRun: false, limit: 2 });
    // 6 条按 2 条一批：满页时无法判定「后面还有没有」，必然多探一页空批。
    assert.equal(total.batches, 4, '3 个满页 + 1 次空页探测');
    assert.equal(total.scanned, 6);
    assert.equal(total.updated, 6);
    assert.equal(new Set(adapter.writes.map(w => w.id)).size, 6, '没有重复写');
  });

  test('只回填指定学校，别校文档不受影响', async () => {
    const other = { ...legacyRating('u1', 'singles'), _id: 'mr:buaa:pkb:u1:singles', schoolId: 'buaa' };
    const adapter = makeAdapter({
      ratings: [legacyRating('u1', 'singles'), other],
      users: USERS,
      members: MEMBERS,
    });
    const stats = await backfillBatch(adapter, { schoolId: SCHOOL, dryRun: false });
    assert.equal(stats.scanned, 1);
    assert.equal(adapter.store.find(row => row.schoolId === 'buaa').gender, undefined);
  });
});
