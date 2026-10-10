/**
 * 客户端多协会隔离 —— 会话作用域、按协会分桶、mock 命名空间化
 * ============================================================
 * P3 把多协会从「云端内核」推进到「客户端整套数据源」：当前协会是一份
 * 会话状态（association-scope），各台账按协会分桶，mock 的缓存按协会分份。
 * 这一组就盯三件事：
 *
 *   1. 会话作用域：默认协会、设定的校验、未知协会当场抛错不静默退回。
 *   2. 分桶隔离：一个协会里的注册、任免、发布、改资料，另一个协会一概看不见，
 *      且两边的自增编号各自从 0001 起。
 *   3. 缓存分份：同一协会内引用复用（不重复算那 600 场回放），跨协会另起一份；
 *      各协会的模拟战绩错开（种子按注册表次序偏移），但会员身份共享。
 *
 * 这些边界一旦漏掉，表现就是「切了协会却还看着上一个协会的数据」——
 * 不会报错，只会悄悄串味，所以每条都在这里变红。
 * ============================================================
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mock = require('../miniprogram/services/mock.js');
const facade = require('../miniprogram/services/index.js');
const scope = require('../miniprogram/services/association-scope.js');
const { perAssociation } = require('../miniprogram/services/association-scope.js');
const { defaultAssociationId } = require('../miniprogram/utils/associations.js');
const {
  MATCH_TYPE,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  ROLE,
} = require('../miniprogram/utils/constants.js');

const ADMIN_ID = 'u01';
const PKB = 'pkb';
const TT = 'tt';
const BD = 'bd';

/** 一份合法的实名信息 */
const REGISTER_DRAFT = {
  realName: '测试同学',
  gender: 'M',
  studentId: '20240099',
  college: '法学院',
  phone: '13700001111',
};

/** 一份合法的赛事表单（与 datasource.test.js 同款） */
const eventDraft = (overrides = {}) => ({
  title: '秋季单打赛',
  description: '面向全体会员的单打赛事',
  matchType: MATCH_TYPE.SINGLES,
  level: EVENT_LEVEL.SECOND,
  bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
  seedMode: SEED_MODE.ELO,
  seedCount: 8,
  startTime: '2026-05-20T09:00:00',
  location: '学校体育馆',
  quota: 8,
  courtCount: 4,
  ...overrides,
});

/**
 * 每条用例前复位：清空各协会缓存与台账、关闭演示场景、把会话打回未设定。
 * 于是每条都从「默认协会 + 24 人干净基线」起，断言不必去减演示数据。
 */
beforeEach(() => {
  mock.resetCache();
  scope.resetAssociation();
});

/* ============================================================
 * 一、会话作用域 association-scope
 * ============================================================ */

describe('association-scope —— 当前协会', () => {
  test('未设定时回落到默认协会（首个启用协会）', () => {
    scope.resetAssociation();
    assert.equal(defaultAssociationId(), PKB, '默认协会应当是匹克球');
    assert.equal(scope.getAssociation(), PKB);
  });

  test('设定已知协会即生效，设定未知协会当场抛错', () => {
    assert.equal(scope.setAssociation(TT), TT);
    assert.equal(scope.getAssociation(), TT);
    assert.equal(scope.setAssociation(BD), BD);

    assert.throws(() => scope.setAssociation('nope'), /未知的协会 id/);
    assert.throws(() => scope.setAssociation(''), /未知的协会 id/);
    // 抛错不该顺手把当前值改掉——失败要「什么都没发生」，而不是落到半个态
    assert.equal(scope.getAssociation(), BD);
  });
});

/* ============================================================
 * 二、分桶助手 perAssociation
 * ============================================================ */

describe('perAssociation —— 按协会分桶的台账容器', () => {
  test('各协会各持一桶，互不串味', () => {
    const buckets = perAssociation(() => ({ items: [] }));

    scope.setAssociation(PKB);
    buckets.current().items.push('pkb');
    scope.setAssociation(TT);
    assert.deepEqual(buckets.current().items, [], 'tt 的桶不该有 pkb 的东西');
    buckets.current().items.push('tt');

    scope.setAssociation(PKB);
    assert.deepEqual(buckets.current().items, ['pkb']);
    scope.setAssociation(TT);
    assert.deepEqual(buckets.current().items, ['tt']);
  });

  test('clear 一次清空全部协会的桶', () => {
    const buckets = perAssociation(() => ({ items: [] }));

    scope.setAssociation(PKB);
    buckets.current().items.push('pkb');
    scope.setAssociation(TT);
    buckets.current().items.push('tt');

    buckets.clear();

    scope.setAssociation(PKB);
    assert.deepEqual(buckets.current().items, []);
    scope.setAssociation(TT);
    assert.deepEqual(buckets.current().items, []);
  });
});

/* ============================================================
 * 三、mock 数据源命名空间化
 * ============================================================ */

describe('mock —— 各协会数据互不可见', () => {
  test('缓存按协会分份：同一协会引用复用，跨协会另起一份', async () => {
    scope.setAssociation(PKB);
    const a = await facade.getMembers();
    const a2 = await facade.getMembers();
    assert.equal(a, a2, '同一协会内应复用同一份缓存，不重复回放');

    scope.setAssociation(TT);
    const b = await facade.getMembers();
    assert.notEqual(a, b, '换了协会就该是另一份缓存');

    scope.setAssociation(PKB);
    assert.equal(await facade.getMembers(), a, '切回来仍是原来那一份');
  });

  test('会员身份共享，但各协会的模拟战绩不同（种子错开）', async () => {
    scope.setAssociation(PKB);
    const pkbMembers = await facade.getMembers();
    scope.setAssociation(TT);
    const ttMembers = await facade.getMembers();

    // 账号是全局的：两个协会看到的是同一批人（同一套 _id）
    assert.deepEqual(
      pkbMembers.map((m) => m._id),
      ttMembers.map((m) => m._id),
      '会员身份应当共享'
    );
    // 内容是各协会自己的：种子错开，战绩自然不同
    assert.notDeepEqual(
      pkbMembers.map((m) => m.ratings),
      ttMembers.map((m) => m.ratings),
      '各协会的模拟战绩不该完全一致'
    );
  });

  test('本地注册与审核只在当前协会生效', async () => {
    // 在 tt 下注册并通过审核
    scope.setAssociation(TT);
    const reg = await facade.registerMember(REGISTER_DRAFT);
    assert.equal(reg.ok, true, reg.firstError);
    const approved = await facade.approveMember(reg.account._id, ADMIN_ID);
    assert.equal(approved.ok, true, approved.message);

    assert.equal((await facade.getMembers()).length, 25, 'tt 多了一位新会员');
    assert.ok((await facade.getMembers()).some((m) => m._id === reg.account._id));

    // pkb 看不到这个人
    scope.setAssociation(PKB);
    assert.equal((await facade.getMembers()).length, 24, 'pkb 仍是干净基线');
    assert.ok(!(await facade.getMembers()).some((m) => m._id === reg.account._id));
    assert.ok(
      !(await facade.getMemberApplications()).some((a) => a.studentId === REGISTER_DRAFT.studentId),
      'pkb 的申请名单里不该有 tt 的注册'
    );

    // 切回 tt 他还在
    scope.setAssociation(TT);
    assert.ok((await facade.getMembers()).some((m) => m._id === reg.account._id));
  });

  test('任免只在当前协会生效', async () => {
    // 在 tt 下把 u06 提为协会负责人（= 管理员，见 mock.setAssociationLeader）
    scope.setAssociation(TT);
    const set = await facade.setAssociationLeader('u06', ADMIN_ID, true);
    assert.equal(set.ok, true, set.message);
    assert.equal((await facade.getMember('u06')).role, ROLE.ADMIN);

    // pkb 里 u06 仍是普通会员
    scope.setAssociation(PKB);
    assert.equal((await facade.getMember('u06')).role, ROLE.MEMBER);

    // 切回 tt 任免仍在
    scope.setAssociation(TT);
    assert.equal((await facade.getMember('u06')).role, ROLE.ADMIN);
  });

  test('资料修改只在当前协会生效', async () => {
    scope.setAssociation(TT);
    const changed = await facade.updateProfile({ nickName: '乒乓专属' }, 'u06');
    assert.equal(changed.ok, true, changed.firstError);
    assert.equal((await facade.getMember('u06')).nickName, '乒乓专属');

    scope.setAssociation(PKB);
    assert.notEqual((await facade.getMember('u06')).nickName, '乒乓专属');
  });

  test('新发赛事只在当前协会可见，且编号各自从 le0001 起', async () => {
    // tt 发一场
    scope.setAssociation(TT);
    const ttPub = await facade.publishEvent(eventDraft(), ADMIN_ID);
    assert.equal(ttPub.ok, true, ttPub.firstError);
    assert.equal(ttPub.record._id, 'le0001');
    assert.ok((await facade.getEvents()).some((e) => e._id === 'le0001'));

    // pkb 看不到 tt 的 le0001，自己发一场也拿到 le0001（编号随桶复位）
    scope.setAssociation(PKB);
    assert.ok(
      !(await facade.getEvents()).some((e) => e._id === 'le0001'),
      'pkb 不该看到 tt 新发的赛事'
    );
    const pkbPub = await facade.publishEvent(eventDraft(), ADMIN_ID);
    assert.equal(pkbPub.ok, true, pkbPub.firstError);
    assert.equal(pkbPub.record._id, 'le0001', '两个协会的编号各自从 le0001 起');

    // 切回 tt，只有 tt 自己那一场
    scope.setAssociation(TT);
    const ttEvents = await facade.getEvents();
    assert.equal(ttEvents.filter((e) => e._id === 'le0001').length, 1);
    assert.equal(ttEvents.find((e) => e._id === 'le0001').title, '秋季单打赛');
  });

  test('resetCache 一次清空全部协会的缓存与台账', async () => {
    scope.setAssociation(TT);
    await facade.publishEvent(eventDraft(), ADMIN_ID);
    scope.setAssociation(PKB);
    await facade.publishEvent(eventDraft(), ADMIN_ID);

    mock.resetCache();

    scope.setAssociation(TT);
    assert.ok(!(await facade.getEvents()).some((e) => e._id === 'le0001'));
    scope.setAssociation(PKB);
    assert.ok(!(await facade.getEvents()).some((e) => e._id === 'le0001'));
  });
});
