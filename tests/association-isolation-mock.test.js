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
  EVENT_STATUS,
  SEED_MODE,
  ROLE,
} = require('../miniprogram/utils/constants.js');

/** 种子里点名的学院负责人：u02 张宇轩 */
const STAFF_ID = 'u02';

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

  test('各协会的赛事与公告各是各的（前缀 / 月份 / 文案都拉开）', async () => {
    scope.setAssociation(PKB);
    const pkbEvents = await facade.getEvents();
    const pkbAnnouncements = await facade.getAnnouncements();

    scope.setAssociation(TT);
    const ttEvents = await facade.getEvents();
    const ttAnnouncements = await facade.getAnnouncements();

    scope.setAssociation(BD);
    const bdEvents = await facade.getEvents();
    const bdAnnouncements = await facade.getAnnouncements();

    // 默认协会标题不带前缀，仍由实际月份推导，逐字节不变
    assert.ok(pkbEvents.every((e) => !e.title.includes('·')), 'pkb 标题不带协会前缀');
    // 其余协会标题带自己的前缀，一眼认得出归属
    assert.ok(ttEvents.every((e) => e.title.startsWith('乒乓球·')), 'tt 标题带乒乓前缀');
    assert.ok(bdEvents.every((e) => e.title.startsWith('羽毛球·')), 'bd 标题带羽球前缀');

    // 正在进行的那场各协会落在不同月份（曾反馈过「每个协会都是九月单打赛」）
    const ongoingMonthOf = (list) => {
      const ongoing = list.find((e) => e.status === EVENT_STATUS.ONGOING);
      assert.ok(ongoing, '每个协会都该有一场进行中的赛事');
      return new Date(ongoing.startTime).getMonth() + 1;
    };
    const months = [ongoingMonthOf(pkbEvents), ongoingMonthOf(ttEvents), ongoingMonthOf(bdEvents)];
    assert.equal(new Set(months).size, 3, `三个协会的进行中赛事应落在不同月份，实为 ${months}`);

    // 公告各说各的项目
    assert.ok(ttAnnouncements.some((a) => a.title.includes('乒乓球')), 'tt 公告提到乒乓球');
    assert.ok(bdAnnouncements.some((a) => a.title.includes('羽毛球')), 'bd 公告提到羽毛球');
    assert.ok(
      !pkbAnnouncements.some((a) => a.title.includes('乒乓球') || a.title.includes('羽毛球')),
      'pkb 公告不提乒乓/羽球'
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

/* ============================================================
 * 四、按协会分身份：学院负责人与初始等级分
 * ============================================================
 * 身份与初始分都不是「账号的属性」，而是「某人在某协会里的属性」。
 * 这里盯住两件事落了地：
 *   1. 种子里的学院负责人只在默认协会成立，换协会即退回普通会员。
 *   2. 手工指定的初始等级分只落当前协会，另一个协会看不到、也不受影响。
 * 一旦漏掉，表现就是「在 A 协会当干事管到了 B 协会的人」「在 A 定的初始分
 * 跑到 B 去了」——不会报错，只会越权与串味，所以每条都在这里变红。
 * ============================================================ */

describe('mock —— 学院负责人按协会', () => {
  test('种子里的学院负责人只在默认协会成立，换协会即退回普通会员', async () => {
    scope.setAssociation(PKB);
    assert.equal((await facade.getMember(STAFF_ID)).role, ROLE.STAFF, 'pkb 里他是学院负责人');

    scope.setAssociation(TT);
    assert.equal((await facade.getMember(STAFF_ID)).role, ROLE.MEMBER, 'tt 里他只是普通会员');

    scope.setAssociation(BD);
    assert.equal((await facade.getMember(STAFF_ID)).role, ROLE.MEMBER);

    // 切回默认协会身份仍在——各协会各存各的，不是被永久抹掉
    scope.setAssociation(PKB);
    assert.equal((await facade.getMember(STAFF_ID)).role, ROLE.STAFF);
  });

  test('管理员在非默认协会任免学院负责人，只改那个协会', async () => {
    scope.setAssociation(TT);
    const set = await facade.setCollegeLeader('u06', ADMIN_ID, true);
    assert.equal(set.ok, true, set.message);
    assert.equal((await facade.getMember('u06')).role, ROLE.STAFF, 'tt 里已是学院负责人');

    // pkb 里 u06 仍是普通会员
    scope.setAssociation(PKB);
    assert.equal((await facade.getMember('u06')).role, ROLE.MEMBER, 'pkb 不该受影响');

    // 切回 tt 任免仍在
    scope.setAssociation(TT);
    assert.equal((await facade.getMember('u06')).role, ROLE.STAFF);
  });
});

describe('mock —— 初始等级分按协会', () => {
  /** 在指定协会注册并通过一位新会员，返回其编号（新会员无比赛，可改初始分） */
  async function freshMember(association) {
    scope.setAssociation(association);
    const reg = await facade.registerMember(REGISTER_DRAFT);
    assert.equal(reg.ok, true, reg.firstError);
    const approved = await facade.approveMember(reg.account._id, ADMIN_ID);
    assert.equal(approved.ok, true, approved.message);
    return reg.account._id;
  }

  test('手工指定初始分只落当前协会，另一个协会不受影响', async () => {
    const id = await freshMember(TT);
    // 新会员默认没有指定初始分，走自动定级
    assert.equal((await facade.getMember(id)).initialElo, undefined, '默认自动定级');

    const edited = await facade.setMemberInitialElo(id, 1600, ADMIN_ID);
    assert.equal(edited.ok, true, edited.message);
    assert.equal((await facade.getMember(id)).initialElo, 1600, 'tt 里已指定 1600');

    // pkb 里根本没有这位新会员（本地账号按协会分桶）
    scope.setAssociation(PKB);
    assert.equal(await facade.getMember(id), null);

    // 切回 tt 初值还在
    scope.setAssociation(TT);
    assert.equal((await facade.getMember(id)).initialElo, 1600);
  });

  test('清除初始分把本协会那一档删掉，回到自动定级', async () => {
    const id = await freshMember(TT);
    await facade.setMemberInitialElo(id, 1600, ADMIN_ID);
    assert.equal((await facade.getMember(id)).initialElo, 1600);

    const cleared = await facade.setMemberInitialElo(id, null, ADMIN_ID);
    assert.equal(cleared.ok, true, cleared.message);
    assert.equal((await facade.getMember(id)).initialElo, undefined, '清除后回到自动定级');
  });

  test('打过比赛的会员初始分锁死，改不动', async () => {
    // u03 是种子老会员，回放后已有场次
    scope.setAssociation(PKB);
    assert.ok((await facade.getMember('u03')).ratings, '前提：种子会员有回放战绩');
    const denied = await facade.setMemberInitialElo('u03', 1500, ADMIN_ID);
    assert.equal(denied.ok, false);
    assert.match(denied.message, /已经打过比赛/);
  });

  test('普通会员无权调整初始分', async () => {
    const id = await freshMember(TT);
    // u06 在 tt 是普通会员（未任免）
    const denied = await facade.setMemberInitialElo(id, 1600, 'u06');
    assert.equal(denied.ok, false);
    assert.match(denied.message, /只有管理员或本协会负责人/);
  });
});

/* ============================================================
 * 五、演示账号在各协会的身份（seed.ASSOC_ROLE_SEED）
 * ============================================================
 * 种子登记了几位跨协会的演示账号，用来在模拟器里演「同一个人在不同协会
 * 身份不同」。这里把每个协会的角色钉死，免得哪天改了登记表却没人发现。
 * 编号与身份的对照见 docs/mock演示账号.md 与 seed.js 的 ASSOC_ROLE_SEED。
 */

describe('mock —— 演示账号在各协会的身份', () => {
  /** 取某人在当前协会的有效角色 */
  async function roleOf(id) {
    return (await facade.getMember(id)).role;
  }

  test('全局管理员 u01：各协会都是管理员，且 isGlobalAdmin 为真', async () => {
    for (const assoc of [PKB, TT, BD]) {
      scope.setAssociation(assoc);
      const m = await facade.getMember(ADMIN_ID);
      assert.equal(m.role, ROLE.ADMIN, `${assoc} 里应是管理员`);
      assert.equal(m.isGlobalAdmin, true, `${assoc} 里应是全局管理员`);
    }
  });

  test('pkb 负责人 u09：只有 pkb 是管理员，且不是全局管理员', async () => {
    scope.setAssociation(PKB);
    const m = await facade.getMember('u09');
    assert.equal(m.role, ROLE.ADMIN, 'pkb 里 u09 是协会负责人');
    // 协会负责人的有效角色也是 ADMIN，但不是全局管理员——只有靠 isGlobalAdmin
    // 这条，前端才分得出「协会负责人」与「全局管理员」（见 profile-view）
    assert.equal(m.isGlobalAdmin, false, '协会负责人 ≠ 全局管理员');

    scope.setAssociation(TT);
    assert.equal(await roleOf('u09'), ROLE.MEMBER, 'tt 里只是普通会员');
    scope.setAssociation(BD);
    assert.equal(await roleOf('u09'), ROLE.MEMBER, 'bd 里只是普通会员');
  });

  test('u04：tt 负责人 + bd 学院负责人（跨协会两种身份）', async () => {
    scope.setAssociation(TT);
    assert.equal(await roleOf('u04'), ROLE.ADMIN, 'tt 里是协会负责人');
    scope.setAssociation(BD);
    assert.equal(await roleOf('u04'), ROLE.STAFF, 'bd 里是学院负责人');
    scope.setAssociation(PKB);
    assert.equal(await roleOf('u04'), ROLE.MEMBER, 'pkb 里什么都不是');
  });

  test('u10：两个协会的学院负责人', async () => {
    scope.setAssociation(PKB);
    assert.equal(await roleOf('u10'), ROLE.STAFF);
    scope.setAssociation(TT);
    assert.equal(await roleOf('u10'), ROLE.STAFF);
    scope.setAssociation(BD);
    assert.equal(await roleOf('u10'), ROLE.MEMBER);
  });

  test('三个各协会的学院负责人：pkb u05 / tt u08 / bd u11', async () => {
    scope.setAssociation(PKB);
    assert.equal(await roleOf('u05'), ROLE.STAFF);
    scope.setAssociation(TT);
    assert.equal(await roleOf('u08'), ROLE.STAFF);
    scope.setAssociation(BD);
    assert.equal(await roleOf('u11'), ROLE.STAFF);
  });

  test('u07：bd 负责人，其余协会是普通会员', async () => {
    scope.setAssociation(BD);
    assert.equal(await roleOf('u07'), ROLE.ADMIN);
    scope.setAssociation(PKB);
    assert.equal(await roleOf('u07'), ROLE.MEMBER);
    scope.setAssociation(TT);
    assert.equal(await roleOf('u07'), ROLE.MEMBER);
  });

  test('默认登录种子 u06 在各协会都是普通会员', async () => {
    for (const assoc of [PKB, TT, BD]) {
      scope.setAssociation(assoc);
      assert.equal(await roleOf('u06'), ROLE.MEMBER);
    }
  });

  test('运行时任免盖得住种子登记——撤销种子里的协会负责人', async () => {
    scope.setAssociation(PKB);
    assert.equal(await roleOf('u09'), ROLE.ADMIN, '前提：u09 是种子里的 pkb 负责人');
    const revoked = await facade.setAssociationLeader('u09', ADMIN_ID, false);
    assert.equal(revoked.ok, true, revoked.message);
    assert.equal(await roleOf('u09'), ROLE.MEMBER, '撤销后回到普通会员');
  });
});
