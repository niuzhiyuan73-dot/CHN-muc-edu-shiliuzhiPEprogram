/**
 * 公告页视图模型的自检
 * ============================================================
 * 两份装载器，两条最要紧的防线：
 *   - 管理台账：没有发布权的人，一行（尤其是已下架的）都不能看到
 *   - 公开列表：任何人都能看，但绝不能冒出管理按钮
 *
 * 其余与别处同一个套路：
 *   - 权限算进数据（canArchive），模板不写业务逻辑
 *   - 渲染字段里不许出现 undefined / null / NaN
 * ============================================================
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ALL_TAB,
  categoryTabs,
  loadAnnouncementListView,
  loadAnnouncementManageView,
} = require('../miniprogram/services/announcement-view.js');
const facade = require('../miniprogram/services/index.js');
const { ROLE, USER_STATUS, ANNOUNCEMENT_CATEGORIES } = require('../miniprogram/utils/constants.js');

/** 有发布权的干事。不再按数据源放宽，只有干事及以上才看得到台账 */
const PUBLISHER = { _id: 'u02', nickName: '张宇轩', role: ROLE.STAFF, status: USER_STATUS.ACTIVE };

/** 每条用例都从「只有种子公告」的基线开始 */
beforeEach(() => facade.resetCache());

/* ============================================================
 * 一、公开列表
 * ============================================================ */

describe('公告公开列表 —— 谁都能看', () => {
  test('列出全部未下架的公告，置顶在最前', async () => {
    const view = await loadAnnouncementListView();

    assert.strictEqual(view.total, 6);
    assert.strictEqual(view.rows.length, 6);
    // 种子里的「开训通知」是置顶的，即便不是最新的也要在最前
    assert.strictEqual(view.rows[0].pinned, true);
  });

  test('分类标签带数量，当前页被标成 active', async () => {
    const view = await loadAnnouncementListView();

    assert.deepStrictEqual(
      view.tabs.map((tab) => tab.tab),
      [ALL_TAB, ...ANNOUNCEMENT_CATEGORIES]
    );
    assert.strictEqual(view.tabs[0].label, '全部');
    assert.strictEqual(view.tabs[0].count, 6);
    assert.strictEqual(view.tabs[0].active, true);
    // 通知、赛事、战报各两条
    for (const tab of view.tabs.slice(1)) assert.strictEqual(tab.count, 2);
  });

  test('按分类筛选，行数与标签计数对上', async () => {
    const view = await loadAnnouncementListView({ tab: '赛事' });

    assert.strictEqual(view.activeTab, '赛事');
    assert.strictEqual(view.rows.length, 2);
    for (const row of view.rows) assert.strictEqual(row.category, '赛事');
    // 切到某个分类后，别的分类的计数不该归零
    assert.strictEqual(view.tabs.find((t) => t.tab === '通知').count, 2);
  });

  test('非法分类退回「全部」，不至于白屏', async () => {
    const view = await loadAnnouncementListView({ tab: 'nonsense' });
    assert.strictEqual(view.activeTab, ALL_TAB);
    assert.strictEqual(view.rows.length, 6);
  });

  test('公开页绝不出现管理按钮', async () => {
    const view = await loadAnnouncementListView();
    // 行里连 canArchive 都是恒假的——actor 传的是 null
    for (const row of view.rows) assert.strictEqual(row.canArchive, false);
  });

  test('某个分类被下架光之后，空态有话说', async () => {
    await facade.archiveAnnouncement('a04', PUBLISHER._id); // 战报
    await facade.archiveAnnouncement('a06', PUBLISHER._id); // 战报

    const view = await loadAnnouncementListView({ tab: '战报' });
    assert.strictEqual(view.rows.length, 0);
    assert.match(view.emptyText, /战报/);
  });
});

/* ============================================================
 * 二、管理台账的闸门
 * ============================================================ */

describe('公告管理视图 —— 防泄漏', () => {
  test('访客拿不到任何公告，只拿到一句提示', async () => {
    const view = await loadAnnouncementManageView({ user: null });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, [], '访客竟然拿到了公告台账');
    assert.strictEqual(view.total, 0);
    assert.match(view.blockedText, /登录/);
  });

  test('干脆不传 user 也按访客处理，不悄悄回退成演示会员', async () => {
    const view = await loadAnnouncementManageView({});

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.strictEqual(view.viewer.loggedIn, false);
  });

  test('还没转正的账号没有管理权', async () => {
    const pendingUser = { _id: 'local_demo01', role: ROLE.MEMBER, status: USER_STATUS.PENDING };
    const view = await loadAnnouncementManageView({ user: pendingUser });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.blockedText, /权限/);
  });

  test('访客即便公告已被下架，也一条都看不到', async () => {
    await facade.archiveAnnouncement('a01', PUBLISHER._id);

    const view = await loadAnnouncementManageView({ user: null });
    assert.deepStrictEqual(view.rows, []);
  });
});

/* ============================================================
 * 三、管理台账的内容
 * ============================================================ */

describe('公告管理视图 —— 内容', () => {
  test('干事看到全量，不必再标演示口径', async () => {
    const view = await loadAnnouncementManageView({ user: PUBLISHER });

    assert.strictEqual(view.allowed, true);
    assert.strictEqual(view.blockedText, '');
    assert.strictEqual(view.total, 6);
    assert.strictEqual(view.publishedCount, 6);
    assert.strictEqual(view.archivedCount, 0);
  });

  test('新发的公告随即出现在台账里', async () => {
    await facade.publishAnnouncement(
      { title: '临时通知', content: '明天停训一次。', category: '通知' },
      PUBLISHER._id
    );

    const view = await loadAnnouncementManageView({ user: PUBLISHER });
    assert.strictEqual(view.total, 7);
    assert.strictEqual(view.publishedCount, 7);

    const created = view.rows.find((row) => row.title === '临时通知');
    assert.ok(created, '新发的公告没进台账');
    assert.strictEqual(created.canArchive, true);
    // 置顶的仍在最前：排序口径是「置顶优先」，新发的不该把它顶下去
    assert.strictEqual(view.rows[0].pinned, true);
  });

  test('下架后：公开列表少一条，台账里仍在、沉到底部、不再给按钮', async () => {
    await facade.archiveAnnouncement('a01', PUBLISHER._id);

    const view = await loadAnnouncementManageView({ user: PUBLISHER });
    assert.strictEqual(view.total, 6);
    assert.strictEqual(view.publishedCount, 5);
    assert.strictEqual(view.archivedCount, 1);

    // 已下架的沉到底部，好让还能操作的先被看到
    const last = view.rows[view.rows.length - 1];
    assert.strictEqual(last.id, 'a01');
    assert.strictEqual(last.archived, true);
    assert.strictEqual(last.statusLabel, '已下架');
    assert.strictEqual(last.canArchive, false);

    const publicView = await loadAnnouncementListView();
    assert.strictEqual(publicView.total, 5);
  });

  test('每一行都不含 undefined / null / NaN', async () => {
    await facade.archiveAnnouncement('a02', PUBLISHER._id);
    const view = await loadAnnouncementManageView({ user: PUBLISHER });

    assert.ok(view.rows.length > 0);
    for (const row of view.rows) {
      for (const [key, value] of Object.entries(row)) {
        assert.notStrictEqual(value, null, `${key} 是 null`);
        assert.notStrictEqual(value, undefined, `${key} 是 undefined`);
        if (typeof value === 'string') {
          assert.ok(!/undefined|NaN/.test(value), `${key} 渲染出了「${value}」`);
        }
      }
      assert.strictEqual(typeof row.archived, 'boolean');
      assert.strictEqual(typeof row.canArchive, 'boolean');
    }
  });
});

/* ============================================================
 * 四、纯函数
 * ============================================================ */

test('categoryTabs —— 计数按全量算，不随当前标签变化', () => {
  const rows = [
    { category: '通知' },
    { category: '通知' },
    { category: '赛事' },
  ];
  const tabs = categoryTabs(rows, '通知');

  assert.strictEqual(tabs[0].count, 3);
  assert.strictEqual(tabs.find((t) => t.tab === '通知').count, 2);
  assert.strictEqual(tabs.find((t) => t.tab === '赛事').count, 1);
  assert.strictEqual(tabs.find((t) => t.tab === '战报').count, 0);
  assert.strictEqual(tabs.find((t) => t.tab === '通知').active, true);
});
