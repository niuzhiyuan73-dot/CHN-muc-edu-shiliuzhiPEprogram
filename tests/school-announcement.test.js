/**
 * 学校维度：全校公告「发布 → 列表 → 下架」（迁移清单 M3-a）
 *
 * 守的是：
 *   1. 公告主记录钉在 `schoolId + association` 上，跨校读不到、写不进；
 *   2. 发布权收归**平台管理员**——校级 / 协会 / 学院负责人都不能发（复用旧栈
 *      announcement.canPublish 同一把尺子，只把「全局管理员」换成账号级身份）；
 *   3. 内容校验、落库记录、排序全部复用旧栈（validateAnnouncement /
 *      buildAnnouncementRecord / sortAnnouncements），不另抄一份；
 *   4. 会员只见「已发布」，平台管理员可见含已下架的管理台账；
 *   5. 发布用 requestId 派生稳定编号：同编号重试返回同一条，改内容则拒绝；
 *      编号带范围，同一请求编号在不同学校互不覆盖。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-announcement-service');
const { schoolKey, schoolAnnouncementKey } = require('../miniprogram/utils/school');
const { ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_STATUS } = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const PLATFORM_ADMIN = 'demo_platform_admin';

/**
 * 演示仓储：种子只带双校的 admin / member，平台管理员是账号级身份
 * （platformRole=admin，不带 primarySchoolId），需按 school-mock 同形补上。
 */
function fixture() {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: PLATFORM_ADMIN, openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = PLATFORM_ADMIN, schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '关于举办秋季联赛的通知', content: '请各学院于本月内完成报名。',
  category: ANNOUNCEMENT_CATEGORIES[0], pinned: false, ...extra,
});

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishSchoolAnnouncement', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.announcement;
}

/* ------------------------------------------------------------ 发布 */

test('发布：仅平台管理员可发，校管理员 / 会员被拒；发布落在已发布', async () => {
  const repo = fixture();

  const byMember = await call(repo, 'publishSchoolAnnouncement', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /平台管理员/);

  // 校管理员也不行：公告是发给全校的「定盘子」信息，只归账号级全局管理员。
  const bySchoolAdmin = await call(repo, 'publishSchoolAnnouncement', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_admin' });
  assert.equal(bySchoolAdmin.ok, false);
  assert.match(bySchoolAdmin.message, /平台管理员/);

  const byPlatform = await call(repo, 'publishSchoolAnnouncement', { requestId: 'r1', ...valid() });
  assert.equal(byPlatform.ok, true, byPlatform.message);
  assert.equal(byPlatform.announcement.status, ANNOUNCEMENT_STATUS.PUBLISHED);
  assert.equal(byPlatform.announcement.canArchive, true);
  assert.equal(byPlatform.announcement.publisherName, '平台管理员');
});

test('发布：请求编号幂等，改内容重发被拒；非法编号与非法表单被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1');
  const again = await call(repo, 'publishSchoolAnnouncement', { requestId: 'r1', ...valid() });
  assert.equal(again.ok, true);
  assert.equal(again.announcement.announcementId, first.announcementId);

  const changed = await call(repo, 'publishSchoolAnnouncement',
    { requestId: 'r1', ...valid({ title: '改了名字的公告' }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /请求编号已使用/);

  const badToken = await call(repo, 'publishSchoolAnnouncement',
    { requestId: '带空格 的编号', ...valid() });
  assert.equal(badToken.ok, false);
  assert.match(badToken.message, /编号无效/);

  const badForm = await call(repo, 'publishSchoolAnnouncement',
    { requestId: 'r2', ...valid({ title: 'A' }) });
  assert.equal(badForm.ok, false);
  assert.ok(badForm.errors && badForm.errors.title);
});

/* ------------------------------------------------------------ 列表 */

test('列表：会员只见已发布、管理员可见下架；分类过滤与置顶排序', async () => {
  const repo = fixture();
  await publish(repo, 'r1', { title: '普通通知一号' });
  await publish(repo, 'r2', { title: '置顶赛事二号', category: ANNOUNCEMENT_CATEGORIES[1], pinned: true });
  const third = await publish(repo, 'r3', { title: '待下架的战报三号', category: ANNOUNCEMENT_CATEGORIES[2] });

  const archived = await call(repo, 'archiveSchoolAnnouncement', { announcementId: third.announcementId });
  assert.equal(archived.ok, true, archived.message);

  // 会员：只见「已发布」，置顶在前；不可管。
  const memberView = await call(repo, 'listSchoolAnnouncements', {}, { actor: 'demo_muc_member' });
  assert.equal(memberView.ok, true);
  assert.equal(memberView.canManage, false);
  assert.deepEqual(memberView.announcements.map(row => row.title), ['置顶赛事二号', '普通通知一号']);
  assert.equal(memberView.announcements.every(row => row.canArchive === false), true);

  // 平台管理员：含已下架的管理台账。
  const adminView = await call(repo, 'listSchoolAnnouncements', {});
  assert.equal(adminView.canManage, true);
  assert.equal(adminView.announcements.length, 3);
  const archivedRow = adminView.announcements.find(row => row.title === '待下架的战报三号');
  assert.equal(archivedRow.archived, true);
  assert.equal(archivedRow.canArchive, false);

  // 分类过滤。
  const byCategory = await call(repo, 'listSchoolAnnouncements', { category: ANNOUNCEMENT_CATEGORIES[2] });
  assert.deepEqual(byCategory.announcements.map(row => row.title), ['待下架的战报三号']);
});

/* ------------------------------------------------------------ 下架 */

test('下架：仅平台管理员；重复下架被拒；找不到为拒', async () => {
  const repo = fixture();
  const one = await publish(repo, 'r1');

  const byMember = await call(repo, 'archiveSchoolAnnouncement', { announcementId: one.announcementId },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /平台管理员/);

  const bySchoolAdmin = await call(repo, 'archiveSchoolAnnouncement', { announcementId: one.announcementId },
    { actor: 'demo_muc_admin' });
  assert.equal(bySchoolAdmin.ok, false);
  assert.match(bySchoolAdmin.message, /平台管理员/);

  const done = await call(repo, 'archiveSchoolAnnouncement', { announcementId: one.announcementId });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.announcement.status, ANNOUNCEMENT_STATUS.ARCHIVED);
  assert.equal(done.announcement.revision, 2);

  const twice = await call(repo, 'archiveSchoolAnnouncement', { announcementId: one.announcementId });
  assert.equal(twice.ok, false);
  assert.match(twice.message, /已经下架/);

  const missing = await call(repo, 'archiveSchoolAnnouncement', { announcementId: 'ann:none' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /找不到/);
});

/* ------------------------------------------------------------ 跨校隔离 */

test('跨校隔离：buaa 名下读不到 muc 的公告，也管不了；外校连读都不给', async () => {
  const repo = fixture();
  const mucOne = await publish(repo, 'r1');

  // 北航会员读北航空间：读得到空间，但看不到民大的公告。
  const buaaView = await call(repo, 'listSchoolAnnouncements', {},
    { actor: 'demo_buaa_member', schoolId: 'buaa' });
  assert.equal(buaaView.ok, true);
  assert.deepEqual(buaaView.announcements, []);

  // 外校会员读民大空间：连读都不给。
  const crossRead = await call(repo, 'listSchoolAnnouncements', {},
    { actor: 'demo_buaa_member', schoolId: 'muc' });
  assert.equal(crossRead.ok, false);
  assert.match(crossRead.message, /没有读取协会空间/);

  // 平台管理员在北航范围下架民大公告：先过读权限，再因归属不符被拒。
  const crossArchive = await call(repo, 'archiveSchoolAnnouncement', { announcementId: mucOne.announcementId },
    { schoolId: 'buaa' });
  assert.equal(crossArchive.ok, false);
  assert.match(crossArchive.message, /找不到/);

  // 民大范围内该公告仍在，未被改动。
  const mucView = await call(repo, 'listSchoolAnnouncements', {});
  assert.equal(mucView.announcements[0].archived, false);
});

test('编号带范围：同一请求编号在不同学校互不覆盖', async () => {
  const repo = fixture();
  const mucOne = await publish(repo, 'r1');
  const buaaOne = await publish(repo, 'r1', {}, { schoolId: 'buaa' });
  assert.notEqual(mucOne.announcementId, buaaOne.announcementId);
  assert.equal(mucOne.announcementId,
    schoolAnnouncementKey(schoolKey('a', PLATFORM_ADMIN, 'r1'), { schoolId: 'muc', association: 'pkb' }));
});
