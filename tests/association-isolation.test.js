/**
 * 数据隔离内核 —— 有效角色、单例按协会、自然键并入协会
 * ============================================================
 * P1 只做「内核」：账号一份、成员行按协会、赛季与快照按协会、顶层内容自然键
 * 并入协会。处理器层的读过滤/写盖章是 P2 的事，这里先把下列边界钉死：
 *
 *   1. 有效角色：全局管理员、协会负责人（= ADMIN）、学院负责人、普通会员，
 *      以及「账号上的 STAFF 不再直接生效」这条新规。
 *   2. 赛季单例：各协会各一份 `current_<assoc>`，互不串味。
 *   3. 排行榜快照：各协会各一份，数据集只含本协会的内容。
 *   4. 自然键：同一内容跨协会必不同；缺 association 的旧文档沿用旧键。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildContext, effectiveRole } = require('../cloudfunctions/data/src/core/context.js');
const {
  membershipKey,
  matchNaturalKey,
  announcementNaturalKey,
} = require('../cloudfunctions/data/src/core/idempotency.js');
const {
  seasonId,
  bumpSeason,
  loadSeason,
} = require('../cloudfunctions/data/src/core/season.js');
const { getDataset, rankingSnapshotId, resetMemo } = require('../cloudfunctions/data/src/core/derive.js');
const { belongsToAssociation, LEGACY_ASSOCIATION_ID } = require('../miniprogram/utils/associations.js');
const {
  ROLE,
  ASSOC_ROLE,
  USER_STATUS,
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
} = require('../miniprogram/utils/constants.js');
const { createMemoryRepo } = require('./helpers/memory-repo.js');
const { USERS, NOW, contextFor } = require('./helpers/cloud-fixture.js');

/* ============================================================
 * 一、有效角色解析
 * ============================================================ */

test('effectiveRole —— 全局角色、协会角色与兜底会员', () => {
  assert.equal(effectiveRole(ROLE.ADMIN, null), ROLE.ADMIN, '全局管理员');
  assert.equal(effectiveRole(ROLE.ADMIN, { role: ASSOC_ROLE.LEADER }), ROLE.ADMIN, '都是管理员');
  assert.equal(effectiveRole(ROLE.MEMBER, { role: ASSOC_ROLE.LEADER }), ROLE.ADMIN, '协会负责人等同管理员');
  assert.equal(effectiveRole(ROLE.MEMBER, { role: ASSOC_ROLE.STAFF }), ROLE.STAFF, '学院负责人');
  assert.equal(effectiveRole(ROLE.MEMBER, null), ROLE.MEMBER, '无成员行 = 普通会员');
  // 账号上的旧 STAFF 不再直接生效（改造后全局角色只有 MEMBER / ADMIN）
  assert.equal(effectiveRole(ROLE.STAFF, null), ROLE.MEMBER, '旧全局 STAFF 按会员处理');
});

test('buildContext —— 协会负责人以有效角色 ADMIN 覆盖回 actor，全局身份单独留痕', async () => {
  const repo = createMemoryRepo({
    users: USERS,
    memberships: [
      { _id: membershipKey('u01', 'tt'), userId: 'u01', association: 'tt', role: ASSOC_ROLE.LEADER },
      { _id: membershipKey('u02', 'tt'), userId: 'u02', association: 'tt', role: ASSOC_ROLE.STAFF },
    ],
  });

  // u01 在 tt 是协会负责人：有效角色 ADMIN，但全局角色仍是会员
  const leader = await buildContext({ repo, openId: 'openid-u01', now: NOW, association: 'tt' });
  assert.equal(leader.role, ROLE.ADMIN);
  assert.equal(leader.actor.role, ROLE.ADMIN, '有效角色覆盖回 actor，既有 canManage 零改动');
  assert.equal(leader.globalRole, ROLE.MEMBER);
  assert.equal(leader.isGlobalAdmin, false, '协会负责人不是全局管理员——任免协会负责人要挡住他');
  assert.equal(leader.membership.role, ASSOC_ROLE.LEADER);

  // 同一个 u01 换到 pkb（无成员行）就只是会员——角色按协会各算各的
  const member = await buildContext({ repo, openId: 'openid-u01', now: NOW, association: 'pkb' });
  assert.equal(member.role, ROLE.MEMBER);

  // u02 在 tt 是学院负责人
  const staff = await buildContext({ repo, openId: 'openid-u02', now: NOW, association: 'tt' });
  assert.equal(staff.role, ROLE.STAFF);

  // 全局管理员在任何协会都是管理员
  const admin = await buildContext({ repo, openId: 'openid-admin', now: NOW, association: 'tt' });
  assert.equal(admin.role, ROLE.ADMIN);
  assert.equal(admin.globalRole, ROLE.ADMIN);
  assert.equal(admin.isGlobalAdmin, true);
});

test('buildContext —— 缺省协会走兜底，未登录时角色为会员且无成员行', async () => {
  const repo = createMemoryRepo({ users: USERS });
  const anon = await buildContext({ repo, openId: '', now: NOW });
  assert.equal(anon.association, LEGACY_ASSOCIATION_ID, '缺省协会取兜底 pkb');
  assert.equal(anon.actor, null);
  assert.equal(anon.role, ROLE.MEMBER);
  assert.equal(anon.membership, null);
  assert.equal(anon.isGlobalAdmin, false);
});

/* ============================================================
 * 二、赛季单例按协会
 * ============================================================ */

test('seasonId —— 协会各一份，缺省落回旧单例', () => {
  assert.equal(seasonId('pkb'), 'current_pkb');
  assert.equal(seasonId('tt'), 'current_tt');
  assert.equal(seasonId(''), 'current');
});

test('bumpSeason —— 写本协会的赛季文档，不动别家协会的', async () => {
  const repo = createMemoryRepo({ users: USERS });

  await repo.transaction((tx) => bumpSeason(tx, { association: 'pkb', anchorTime: NOW, now: NOW }));
  await repo.transaction((tx) => bumpSeason(tx, { association: 'pkb', anchorTime: NOW, now: NOW }));
  await repo.transaction((tx) => bumpSeason(tx, { association: 'tt', anchorTime: NOW, now: NOW }));

  const pkb = await loadSeason(repo, 'pkb');
  const tt = await loadSeason(repo, 'tt');
  assert.equal(pkb._id, 'current_pkb');
  assert.equal(tt._id, 'current_tt');
  assert.equal(pkb.version, 2, 'pkb 写了两次');
  assert.equal(tt.version, 1, 'tt 只写了一次，没被 pkb 带跑');
});

/* ============================================================
 * 三、排行榜快照按协会，数据集只含本协会内容
 * ============================================================ */

/** 造一场已生效的单打，直接写明 winner，省得再算局分 */
function activeMatch(id, association, a, b, time) {
  return {
    _id: id,
    association,
    matchType: MATCH_TYPE.SINGLES,
    pool: MATCH_TYPE_TO_POOL[MATCH_TYPE.SINGLES],
    teamA: [a],
    teamB: [b],
    scoreA: [11],
    scoreB: [9],
    gamePoints: 11,
    bestOf: 1,
    winner: 'A',
    location: '',
    matchTime: time,
    recorder: a,
    eventId: null,
    status: MATCH_STATUS.ACTIVE,
  };
}

test('getDataset —— 跨协会互不可见，快照各写各的', async () => {
  const repo = createMemoryRepo({
    users: USERS,
    matches: [
      activeMatch('m_pkb', 'pkb', 'u01', 'u02', '2026-04-08T18:00:00'),
      activeMatch('m_tt', 'tt', 'u03', 'u04', '2026-04-09T18:00:00'),
    ],
  });

  const pkb = await getDataset(await contextFor(repo, 'openid-u01', NOW, 'pkb'));
  const tt = await getDataset(await contextFor(repo, 'openid-u01', NOW, 'tt'));

  assert.deepEqual(
    pkb.ledger.map((m) => m._id),
    ['m_pkb'],
    'pkb 的数据集只能看到 pkb 的比赛'
  );
  assert.deepEqual(
    tt.ledger.map((m) => m._id),
    ['m_tt'],
    'tt 的数据集只能看到 tt 的比赛'
  );

  const pkbSnap = await repo.rankings.get(rankingSnapshotId('pkb'));
  const ttSnap = await repo.rankings.get(rankingSnapshotId('tt'));
  assert.ok(pkbSnap && ttSnap, '两个协会各留一份快照');
  assert.equal(pkbSnap.data.ledger.length, 1);
  assert.equal(ttSnap.data.ledger.length, 1);
});

test('getDataset —— 快照键含协会，冷启动后不拿别家协会的旧快照糊弄', async () => {
  const repo = createMemoryRepo({
    users: USERS,
    matches: [
      activeMatch('m_pkb', 'pkb', 'u01', 'u02', '2026-04-08T18:00:00'),
      activeMatch('m_tt', 'tt', 'u03', 'u04', '2026-04-09T18:00:00'),
    ],
  });

  await getDataset(await contextFor(repo, 'openid-u01', NOW, 'pkb'));
  resetMemo(repo); // 模拟冷启动：内存缓存清空，只剩数据库快照

  const tt = await getDataset(await contextFor(repo, 'openid-u01', NOW, 'tt'));
  assert.deepEqual(tt.ledger.map((m) => m._id), ['m_tt']);
});

/* ============================================================
 * 四、自然键并入协会
 * ============================================================ */

const MATCH_BASE = {
  pool: 'singles',
  teamA: ['u01'],
  teamB: ['u02'],
  scoreA: [11],
  scoreB: [9],
  matchTime: '2026-04-08T18:00:00',
  recorder: 'u01',
};

test('matchNaturalKey —— 同一内容跨协会必不同，缺 association 沿用旧键', () => {
  const withPkb = matchNaturalKey({ ...MATCH_BASE, association: 'pkb' });
  const withTt = matchNaturalKey({ ...MATCH_BASE, association: 'tt' });
  const legacy = matchNaturalKey({ ...MATCH_BASE });

  assert.notEqual(withPkb, withTt, '跨协会同名内容永不碰撞');
  assert.notEqual(withPkb, legacy, '带上协会后是新键，与旧文档不冲突');
  assert.equal(legacy, matchNaturalKey({ ...MATCH_BASE, association: '' }), '缺字段保持旧算法');
});

test('announcementNaturalKey —— 同理并入协会', () => {
  const record = { publisherId: 'u_admin', title: '招新', content: '本周六' };
  assert.notEqual(
    announcementNaturalKey({ ...record, association: 'pkb' }),
    announcementNaturalKey({ ...record, association: 'bd' })
  );
  assert.equal(announcementNaturalKey(record), announcementNaturalKey({ ...record }));
});

test('membershipKey —— 一人多协会各有一行，不同键', () => {
  assert.notEqual(membershipKey('u01', 'pkb'), membershipKey('u01', 'tt'));
  assert.equal(membershipKey('u01', 'pkb'), membershipKey('u01', 'pkb'));
});

/* ============================================================
 * 五、belongsToAssociation —— 读路径的统一谓词
 * ============================================================ */

test('belongsToAssociation —— 缺字段视作旧协会，字段不符挡住', () => {
  assert.equal(belongsToAssociation({ _id: 'x' }, LEGACY_ASSOCIATION_ID), true, '旧文档归 pkb');
  assert.equal(belongsToAssociation({ _id: 'x' }, 'tt'), false, '旧文档不属于新协会');
  assert.equal(belongsToAssociation({ association: 'tt' }, 'tt'), true);
  assert.equal(belongsToAssociation({ association: 'tt' }, 'pkb'), false, '字段存在即严格相等');
  assert.equal(belongsToAssociation(null, 'pkb'), false);
});

/* 一处细节：夹具账号状态正常，确保上面的角色用例不会被账号状态干扰 */
test('前提：夹具会员账号可用', () => {
  assert.equal(USERS[0].status, USER_STATUS.ACTIVE);
});
