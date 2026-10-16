/**
 * 学校维度公告视图模型的自检（协议 2）
 * ============================================================
 * 本文件由旧栈 announcement-view.test.js 迁移而来：协议 1 下线后，旧栈两个
 * 装载器被删除，而这两个 S2 装载器此前**没有任何测试**（页面一直在用，却
 * 无人守护），所以迁移不是「补一份等价文件」，而是把防泄漏与排序口径这两
 * 类守护真正落到 S2 上。
 *
 * 最要紧的一条防线仍在最前面：没有管理权的人，一条已下架公告都不能看到。
 * ============================================================
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ALL_TAB,
  categoryTabs,
  loadSchoolAnnouncementListView,
  loadSchoolAnnouncementManageView,
} = require('../miniprogram/services/announcement-view.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const space = require('../miniprogram/services/association-space.js');
const scope = require('../miniprogram/services/association-scope.js');
const { ANNOUNCEMENT_CATEGORIES } = require('../miniprogram/utils/constants.js');

/** 演示数据落在民大；协会逐个取数，故断言按「学校 muc + 协会」写 */
const SCHOOL_ID = 'muc';
const PKB = { schoolId: SCHOOL_ID, association: 'pkb' };

/** 演示公告条数（见 school-seed 的 DEMO_CONTENT_SPECS），刻意与旧栈种子不同 */
const COUNTS = { pkb: 5, tt: 4, bd: 3 };

const api = (association = 'pkb') => space.forScope({ schoolId: SCHOOL_ID, association });

/** 平台管理员：公告的发布 / 下架只认这一个账号级身份 */
beforeEach(() => {
  schoolMock.reset();
  schoolMock.setDemoActor('demo_platform_admin');
});

/* ============================================================
 * 一、公开列表
 * ============================================================ */

describe('学校公告公开列表 —— 跨协会、顶部协会标签切换', () => {
  test('协会标签：每个启用协会一个，默认停在全局所在协会', async () => {
    const view = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID });

    assert.deepStrictEqual(
      view.associationTabs.map((tab) => tab.associationId),
      ['pkb', 'tt', 'bd'],
      '按注册表次序一协会一个标签'
    );
    assert.deepStrictEqual(
      view.associationTabs.map((tab) => tab.label),
      ['匹克球', '乒乓球', '羽毛球'],
      '标签用三字项目名'
    );
    // 没指定协会时跟随全局所在协会
    assert.strictEqual(view.activeAssociation, scope.getAssociation());
    assert.strictEqual(
      view.associationTabs.find((t) => t.associationId === view.activeAssociation).active, true
    );
    assert.deepStrictEqual(
      view.associationTabs.map((tab) => tab.count),
      [COUNTS.pkb, COUNTS.tt, COUNTS.bd],
      '条数按该协会全部公告算'
    );
    assert.ok(view.themeClass.startsWith('assoc-'), '该带当前协会的主题类');
  });

  test('只展示当前协会的公告，置顶的排最前', async () => {
    const view = await loadSchoolAnnouncementListView(PKB);

    assert.strictEqual(view.activeAssociation, 'pkb');
    assert.strictEqual(view.total, COUNTS.pkb);
    assert.strictEqual(view.rows.length, COUNTS.pkb);
    // 种子里「公告栏开通」是置顶的，服务端已按「置顶优先」排好
    assert.strictEqual(view.rows[0].pinned, true);
    for (const row of view.rows) {
      assert.strictEqual(row.association, 'pkb', '只放当前协会的公告');
    }
  });

  test('切到别的协会：换成那个协会的公告', async () => {
    const view = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID, association: 'tt' });

    assert.strictEqual(view.activeAssociation, 'tt');
    assert.strictEqual(view.total, COUNTS.tt);
    assert.strictEqual(view.associationTabs.find((t) => t.associationId === 'tt').active, true);
    for (const row of view.rows) assert.strictEqual(row.association, 'tt');
  });

  test('非法协会退回全局所在协会，不至于白屏', async () => {
    const view = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID, association: 'nonsense' });
    assert.strictEqual(view.activeAssociation, scope.getAssociation());
    assert.strictEqual(view.total, COUNTS[view.activeAssociation]);
  });

  test('分类标签带数量，计数按当前协会算、当前页被标成 active', async () => {
    const view = await loadSchoolAnnouncementListView(PKB);

    assert.deepStrictEqual(
      view.tabs.map((tab) => tab.tab),
      [ALL_TAB, ...ANNOUNCEMENT_CATEGORIES]
    );
    assert.strictEqual(view.tabs[0].label, '全部');
    assert.strictEqual(view.tabs[0].count, COUNTS.pkb);
    assert.strictEqual(view.tabs[0].active, true);
    // pkb：通知 3、赛事 1、战报 1
    assert.strictEqual(view.tabs.find((t) => t.tab === '通知').count, 3);
    assert.strictEqual(view.tabs.find((t) => t.tab === '赛事').count, 1);
    assert.strictEqual(view.tabs.find((t) => t.tab === '战报').count, 1);
  });

  test('按分类筛选：只留该分类，别的分类计数不归零', async () => {
    const view = await loadSchoolAnnouncementListView({ ...PKB, tab: '赛事' });

    assert.strictEqual(view.activeTab, '赛事');
    assert.strictEqual(view.visibleCount, 1);
    assert.strictEqual(view.rows.length, view.visibleCount);
    for (const row of view.rows) assert.strictEqual(row.category, '赛事');
    // 切到某个分类后，别的分类的计数不该归零
    assert.strictEqual(view.tabs.find((t) => t.tab === '通知').count, 3);
  });

  test('非法分类退回「全部」，不至于白屏', async () => {
    const view = await loadSchoolAnnouncementListView({ ...PKB, tab: 'nonsense' });
    assert.strictEqual(view.activeTab, ALL_TAB);
    assert.strictEqual(view.total, COUNTS.pkb);
  });

  test('公开页绝不出现管理按钮', async () => {
    const view = await loadSchoolAnnouncementListView(PKB);
    assert.ok(view.rows.length > 0);
    // 即便当前身份是平台管理员，公开列表也恒不下发 canArchive
    for (const row of view.rows) assert.strictEqual(row.canArchive, false);
  });

  test('某协会某分类被下架光之后，空态有话说，别的协会不受影响', async () => {
    const before = await loadSchoolAnnouncementListView({ ...PKB, tab: '战报' });
    for (const row of before.rows) {
      await api().archiveSchoolAnnouncement({ announcementId: row.id });
    }

    const view = await loadSchoolAnnouncementListView({ ...PKB, tab: '战报' });
    assert.strictEqual(view.visibleCount, 0);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.emptyText, /战报/);

    const tt = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID, association: 'tt', tab: '战报' });
    assert.strictEqual(tt.visibleCount, 1, '别的协会的战报不该被牵连下架');
  });
});

/* ============================================================
 * 二、管理台账的闸门
 * ============================================================ */

describe('学校公告管理视图 —— 防泄漏', () => {
  test('未登录拿不到任何公告，只拿到一句提示', async () => {
    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: false });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, [], '未登录竟然拿到了公告台账');
    assert.strictEqual(view.total, 0);
    assert.match(view.blockedText, /登录/);
  });

  test('已登录但没有平台管理员身份：提示权限，而不是把台账交出去', async () => {
    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.blockedText, /权限/);
  });

  test('学校管理员也不是平台管理员：公告是全局内容，校管理员管不到', async () => {
    schoolMock.setDemoActor('demo_muc_admin');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

    assert.strictEqual(view.allowed, false);
    assert.deepStrictEqual(view.rows, []);
    assert.match(view.blockedText, /权限/);
  });

  test('即便公告已被下架，无权者仍一条都看不到', async () => {
    const published = await api().listSchoolAnnouncements({});
    await api().archiveSchoolAnnouncement({ announcementId: published.announcements[0].announcementId });

    schoolMock.setDemoActor('demo_muc_member');
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    assert.deepStrictEqual(view.rows, []);
  });
});

/* ============================================================
 * 三、管理台账的内容
 * ============================================================ */

describe('学校公告管理视图 —— 内容', () => {
  test('平台管理员看到本范围全量', async () => {
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

    assert.strictEqual(view.allowed, true);
    assert.strictEqual(view.blockedText, '');
    assert.strictEqual(view.total, COUNTS.pkb);
    assert.strictEqual(view.publishedCount, COUNTS.pkb);
    assert.strictEqual(view.archivedCount, 0);
  });

  test('新发的公告随即出现在台账里', async () => {
    await api().publishSchoolAnnouncement({
      requestId: 'view-test-publish',
      title: '临时通知',
      content: '明天停训一次。',
      category: '通知',
    });

    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    assert.strictEqual(view.total, COUNTS.pkb + 1);
    assert.strictEqual(view.publishedCount, COUNTS.pkb + 1);

    const created = view.rows.find((row) => row.title === '临时通知');
    assert.ok(created, '新发的公告没进台账');
    assert.strictEqual(created.canArchive, true);
    // 置顶的仍在最前：排序口径是「置顶优先」，新发的不该把它顶下去
    assert.strictEqual(view.rows[0].pinned, true);
  });

  test('下架后：公开列表少一条，台账里仍在、沉到底部、不再给按钮', async () => {
    const published = await api().listSchoolAnnouncements({});
    const target = published.announcements[0];
    await api().archiveSchoolAnnouncement({ announcementId: target.announcementId });

    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });
    assert.strictEqual(view.total, COUNTS.pkb);
    assert.strictEqual(view.publishedCount, COUNTS.pkb - 1);
    assert.strictEqual(view.archivedCount, 1);

    const last = view.rows[view.rows.length - 1];
    assert.strictEqual(last.id, target.announcementId);
    assert.strictEqual(last.archived, true);
    assert.strictEqual(last.statusLabel, '已下架');
    assert.strictEqual(last.canArchive, false);

    // 下架的是 pkb 那条：pkb 的公开列表少一条，别的协会不受影响
    const publicView = await loadSchoolAnnouncementListView(PKB);
    assert.strictEqual(publicView.total, COUNTS.pkb - 1);
    assert.ok(!publicView.rows.some((row) => row.id === target.announcementId), '下架的那条不该还在公开列表里');

    const ttView = await loadSchoolAnnouncementListView({ schoolId: SCHOOL_ID, association: 'tt' });
    assert.strictEqual(ttView.total, COUNTS.tt);
  });

  test('每一行都不含 undefined / null / NaN', async () => {
    const view = await loadSchoolAnnouncementManageView({ ...PKB, loggedIn: true });

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
