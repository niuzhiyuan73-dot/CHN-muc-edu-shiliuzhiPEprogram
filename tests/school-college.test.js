/**
 * 学校维度：学院赛「发布 → 名单 → 抽签 → 开赛 → 排阵 → 名次结束」
 * （迁移清单 M2-a / M2-b / M2-c）
 *
 * 守的是：
 *   1. 学院赛主记录、名单、大场与小场都钉在 `schoolId + association` 上，跨校读不到、写不进；
 *   2. 学院目录改为**每校独立**：主键用稳定 `collegeId`，判权与校验仍按本校全名，
 *      复用旧栈纯规则（college-event.js / college-entry.js / college-draw.js /
 *      college-tie.js / college-lineup.js），不另抄一份；
 *   3. 发布权仅管理员、名单提交限本学院负责人（管理员可代交）、审核仅管理员、
 *      退回须理由——与旧栈同一口径；
 *   4. 抽签 / 开赛同样仅管理员，必须按顺序（报名中→抽签→待开赛→开赛），抽签只收
 *      已通过名单的学院，开赛只铺首轮且「只补不覆盖」；
 *   5. 排阵限本大场参赛学院（管理员可代交），排阵齐才能开大场，开大场铺出的小场
 *      写进 matches 集合并带范围；名次只记已通过审核的学院、冠军唯一。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/school-college-service');
const { collegeTieKey } = require('../miniprogram/services/college-draw');
const { collegeLegKey, tieStatusOf } = require('../miniprogram/services/college-tie');
const {
  schoolMemberKey, schoolMembershipKey, collegeEventKey, collegeEntryKey, collegeKey,
  collegeLineupKey,
} = require('../miniprogram/utils/school');
const {
  COLLEGES, COLLEGE_EVENT_STATUS, COLLEGE_ENTRY_STATUS, TIE_STATUS,
  LEG_DISCIPLINE, TIE_ALGO, TIE_NET_MODE, MATCH_COMPETITION,
} = require('../miniprogram/utils/constants');

const NOW = new Date('2026-10-13T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = offset => new Date(NOW.getTime() + offset).toISOString();

const C01 = 'c01';            // 中华民族共同体学院
const C02 = 'c02';            // 民族学与社会学学院
const NAME_C01 = COLLEGES[0];
const NAME_C02 = COLLEGES[1];

/**
 * 演示仓储：民大有三个学院负责人 / 会员分布在 c01、c02。
 *   · demo_muc_admin      —— 校管理员（可发布 / 审核 / 代交任何学院）
 *   · demo_muc_member     —— c01 普通会员
 *   · demo_muc_member_2   —— c01 普通会员
 *   · demo_muc_member_3   —— c02 学院负责人（membership.role=staff + collegeId=c02）
 *   · demo_muc_member_4   —— c02 普通会员
 */
function fixture() {
  const seed = createSchoolDemoSeed();
  const add = (id, collegeId) => {
    seed.users.push({ _id: id, openId: `mock_openid_${id}`, nickName: id, gender: 'M',
      platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
    seed.schoolMembers.push({ _id: schoolMemberKey(id, 'muc'), userId: id, schoolId: 'muc',
      collegeId, studentId: id, status: 'active', simulated: true });
  };
  add('demo_muc_member_2', C01);
  add('demo_muc_member_3', C02);
  add('demo_muc_member_4', C02);
  // c02 的学院负责人：staff + collegeId，与学校身份页授予的「学院负责人」同形。
  seed.memberships.push({
    _id: schoolMembershipKey('demo_muc_member_3', { schoolId: 'muc', association: 'pkb' }),
    userId: 'demo_muc_member_3', schoolId: 'muc', association: 'pkb',
    role: 'staff', collegeId: C02, status: 'active', simulated: true,
  });
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await handlers[action](payload, ctx)).data;
}

const valid = (extra = {}) => ({
  title: '院际杯羽毛球赛', description: '学院团体赛',
  legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.XD], allowMultiEntry: true,
  rosterMin: 1, rosterMax: 5, tieAlgo: TIE_ALGO.FULL_POINTS, tieNetMode: TIE_NET_MODE.WIN_DIFF,
  startTime: at(DAY), location: '综合体育馆', courtCount: 2, ...extra,
});

async function publish(repo, token, extra = {}, opts = {}) {
  const result = await call(repo, 'publishCollegeEvent', { requestId: token, ...valid(extra) }, opts);
  assert.equal(result.ok, true, result.message);
  return result.event;
}

/* ------------------------------------------------------------ 发布 */

test('置顶：审计失败整体回滚，不能留下半次写入', async () => {
  const repo = fixture();
  const event = await publish(repo, 'pin-rollback');
  const before = await repo.collegeEvents.getById(event.eventId);
  const transaction = repo.transaction;
  repo.transaction = fn => transaction(async tx => {
    tx.audit.append = async () => { throw new Error('audit unavailable'); };
    return fn(tx);
  });
  await assert.rejects(call(repo, 'setCollegeEventPinned', { eventId: event.eventId, pinned: true }), /audit unavailable/);
  assert.deepEqual(await repo.collegeEvents.getById(event.eventId), before);
});

test('置顶：事务执行前管理权被撤销，重新判权后拒绝', async () => {
  const repo = fixture();
  const event = await publish(repo, 'pin-permission');
  const transaction = repo.transaction;
  repo.transaction = async fn => {
    const user = await repo.users.getById('demo_muc_admin');
    await repo.users.set(user._id, { ...user, platformStatus: 'disabled' });
    return transaction(fn);
  };
  const result = await call(repo, 'setCollegeEventPinned', { eventId: event.eventId, pinned: true });
  assert.equal(result.ok, false);
  assert.equal(Boolean((await repo.collegeEvents.getById(event.eventId)).pinned), false);
});

test('发布：仅管理员可发，会员被拒；发布落在报名中', async () => {
  const repo = fixture();
  const byMember = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  // 学院负责人也不能发布（发布权收口到管理员，与个人赛同一门槛）。
  const byLeader = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() },
    { actor: 'demo_muc_member_3' });
  assert.equal(byLeader.ok, false);
  assert.match(byLeader.message, /管理员/);

  const byAdmin = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() });
  assert.equal(byAdmin.ok, true, byAdmin.message);
  assert.equal(byAdmin.event.status, COLLEGE_EVENT_STATUS.SIGNUP);
  assert.equal(byAdmin.event.canManage, true);
});

test('发布：请求编号幂等，改内容重发被拒；非法编号与非法表单被拒', async () => {
  const repo = fixture();
  const first = await publish(repo, 'r1');
  const again = await call(repo, 'publishCollegeEvent', { requestId: 'r1', ...valid() });
  assert.equal(again.ok, true);
  assert.equal(again.event.eventId, first.eventId);

  const changed = await call(repo, 'publishCollegeEvent',
    { requestId: 'r1', ...valid({ title: '改了名字的赛事' }) });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /已使用/);

  const badToken = await call(repo, 'publishCollegeEvent', { requestId: '非法 编号', ...valid() });
  assert.equal(badToken.ok, false);
  assert.match(badToken.message, /编号无效/);

  const noLeg = await call(repo, 'publishCollegeEvent', { requestId: 'r2', ...valid({ legPlan: [] }) });
  assert.equal(noLeg.ok, false);
  assert.match(noLeg.message, /小项/);

  const noCourt = await call(repo, 'publishCollegeEvent', { requestId: 'r3', ...valid({ courtCount: '' }) });
  assert.equal(noCourt.ok, false);
  assert.match(noCourt.message, /场地/);
});

/* ------------------------------------------------------------ 列表 / 详情 */

test('列表 / 详情：本协会可读，跨校读不到', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const mine = await call(repo, 'listCollegeEvents', {});
  assert.equal(mine.ok, true);
  assert.equal(mine.events.length, 1);
  assert.equal(mine.events[0].eventId, t.eventId);

  const detail = await call(repo, 'getCollegeEvent', { eventId: t.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(detail.ok, true);
  assert.equal(detail.event.eventId, t.eventId);
  assert.equal(detail.canManage, false, '普通会员不能管理');

  const buaaList = await call(repo, 'listCollegeEvents', {},
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaaList.events.length, 0);

  const buaaGet = await call(repo, 'getCollegeEvent', { eventId: t.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaaGet.ok, false);
  assert.match(buaaGet.message, /不存在/);
});

/* ------------------------------------------------------------ 名单提交 */

test('名单：学院负责人只能交本学院，管理员可代交', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const wrongCollege = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(wrongCollege.ok, false);
  assert.match(wrongCollege.message, /本学院/);

  const byLeader = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member_4'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(byLeader.ok, true, byLeader.message);
  assert.equal(byLeader.entry.college, NAME_C02, '落库按本校学院全名');
  assert.equal(byLeader.entry.status, COLLEGE_ENTRY_STATUS.PENDING);

  const byAdmin = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] });
  assert.equal(byAdmin.ok, true, byAdmin.message);
  assert.equal(byAdmin.entry.college, NAME_C01);
});

test('名单：跨院凑人与人数上下限被拒', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1', { rosterMin: 2, rosterMax: 3 });

  const crossCollege = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(crossCollege.ok, false);
  assert.match(crossCollege.message, /不属于本学院/);

  const tooFew = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /至少 2 人/);

  // 名单里混入外校会员：在本校在册名录里查不到，被拒。
  const foreign = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01,
      memberIds: ['demo_muc_member', 'demo_muc_member_2', 'demo_buaa_member'] },
    { actor: 'demo_muc_admin' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /查不到|不属于本学院/);
});

test('名单：重复提交覆盖同一条，不新增记录', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member_4'] },
    { actor: 'demo_muc_member_3' });
  const again = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.entry.memberCount, 1, '第二次提交覆盖为 1 人');

  const rows = await repo.collegeEntries.list();
  assert.equal(rows.length, 1, '同「赛事 + 学院」只有一条');
  assert.equal(rows[0].revision, 2, '同一条名单版本递增');

  const listed = await call(repo, 'listCollegeEntries', { eventId: t.eventId });
  assert.equal(listed.entries.length, 1);
});

/* ------------------------------------------------------------ 名单审核 */

test('审核：仅管理员；通过后不可再动；退回须理由', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });

  const byMember = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C02, action: 'approve' }, { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const approved = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C02, action: 'approve' });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.entry.status, COLLEGE_ENTRY_STATUS.APPROVED);

  const again = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C02, action: 'approve' });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经处理过/);

  // 换一个学院：退回必须先给理由。
  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] });
  const noReason = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C01, action: 'reject' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /理由/);

  const returned = await call(repo, 'reviewCollegeEntry',
    { eventId: t.eventId, collegeId: C01, action: 'reject', reason: '名单人数不足' });
  assert.equal(returned.ok, true, returned.message);
  assert.equal(returned.entry.status, COLLEGE_ENTRY_STATUS.RETURNED);
  assert.equal(returned.entry.reason, '名单人数不足');
});

/* ------------------------------------------------------------ 范围隔离 */

test('跨校：外校提交读不到赛事，也写不进名单', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');

  const buaa = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_buaa_member'] },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaa.ok, false);
  assert.match(buaa.message, /不存在/);

  const buaaEntries = await call(repo, 'listCollegeEntries', { eventId: t.eventId },
    { schoolId: 'buaa', actor: 'demo_buaa_member' });
  assert.equal(buaaEntries.entries.length, 0);
});

test('主键带范围：学院赛 / 名单都含 schoolId + association', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  const storedEvent = await repo.collegeEvents.getById(t.eventId);
  assert.equal(storedEvent.schoolId, 'muc');
  assert.equal(storedEvent.association, 'pkb');

  await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C02, memberIds: ['demo_muc_member_3'] },
    { actor: 'demo_muc_member_3' });
  const key = collegeEntryKey(t.eventId, C02, { schoolId: 'muc', association: 'pkb' });
  const storedEntry = await repo.collegeEntries.getById(key);
  assert.equal(storedEntry.schoolId, 'muc');
  assert.equal(storedEntry.association, 'pkb');
  assert.equal(storedEntry.collegeId, C02);

  // 键确实由范围 + 学院编号构成，换个学院编号就是另一条。
  assert.notEqual(key, collegeEntryKey(t.eventId, C01, { schoolId: 'muc', association: 'pkb' }));
  // 学院赛键：换范围即换键。
  assert.notEqual(t.eventId, collegeEventKey('x', { schoolId: 'buaa', association: 'pkb' }));
  assert.equal(await repo.colleges.getById(collegeKey('muc', C02)).then(c => c.collegeId), C02);
});

test('学校目录：每校独立——北航用本校学院名（不在全局 COLLEGES 里）也能过', async () => {
  const buaa = { schoolId: 'buaa', actor: 'demo_buaa_admin' };
  const repo = fixture();
  // 民大目录即全局 COLLEGES；提交一个不在目录里的学院名被拒。
  const muc = await publish(repo, 'r1');
  const ghost = await call(repo, 'submitCollegeEntry',
    { eventId: muc.eventId, college: '不存在的学院', memberIds: ['demo_muc_member'] });
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /学院无效/);

  // 北航目录是「航空学院（模拟）」等，均不在全局 COLLEGES 里；仍能发布并按本校目录入名单。
  const buaaEvent = await publish(repo, 'r2', {}, buaa);
  const entry = await call(repo, 'submitCollegeEntry',
    { eventId: buaaEvent.eventId, collegeId: 'c01', memberIds: ['demo_buaa_member'] }, buaa);
  assert.equal(entry.ok, true, entry.message);
  assert.equal(entry.entry.college, '航空学院（模拟）');
});

/* ------------------------------------------------------------ 抽签 / 开赛 */

/** 交一份本学院名单并让管理员通过——抽签只收已通过的学院。 */
async function approveCollege(repo, eventId, collegeId, memberIds, opts = {}) {
  const submitted = await call(repo, 'submitCollegeEntry', { eventId, collegeId, memberIds }, opts);
  assert.equal(submitted.ok, true, submitted.message);
  const approved = await call(repo, 'reviewCollegeEntry', { eventId, collegeId, action: 'approve' }, opts);
  assert.equal(approved.ok, true, approved.message);
}

test('抽签：仅管理员、报名中、抽完转待开赛并锁名单', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);

  // 学院负责人 / 会员都不能抽签（与发布同一门槛）。
  const byMember = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 1 },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const drawn = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  assert.equal(drawn.ok, true, drawn.message);
  assert.equal(drawn.event.status, COLLEGE_EVENT_STATUS.READY);
  // 两个已通过学院都进了签表。
  assert.deepEqual(drawn.draw.slots.filter(Boolean).sort(), [NAME_C01, NAME_C02].sort());

  // 抽签顺带锁名单：转待开赛后名单不可再改（提交权只看「是否报名中」）。
  const late = await call(repo, 'submitCollegeEntry',
    { eventId: t.eventId, collegeId: C01, memberIds: ['demo_muc_member'] });
  assert.equal(late.ok, false);

  // 待开赛再抽签被拒。
  const again = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 43 });
  assert.equal(again.ok, false);
  assert.match(again.message, /报名阶段/);
});

test('抽签：已通过学院不足 2 个被拒；种子必须是已通过学院', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);

  const tooFew = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 7 });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.message, /不足 2 个/);

  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);
  const badSeed = await call(repo, 'drawCollegeEvent',
    { eventId: t.eventId, seedValue: 7, seedColleges: ['非本赛学院'] });
  assert.equal(badSeed.ok, false);
  assert.match(badSeed.message, /种子/);

  const okSeed = await call(repo, 'drawCollegeEvent',
    { eventId: t.eventId, seedValue: 7, seedColleges: [NAME_C01] });
  assert.equal(okSeed.ok, true, okSeed.message);
  assert.deepEqual(okSeed.draw.seeds, [NAME_C01]);
});

test('开赛：先抽签才能开；开赛铺首轮大场带范围，重开被拒', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);

  // 没抽签不能开。
  const tooEarly = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.message, /还没有抽签/);

  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });

  const byMember = await call(repo, 'startCollegeEvent', { eventId: t.eventId },
    { actor: 'demo_muc_member' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const started = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.event.status, COLLEGE_EVENT_STATUS.ONGOING);
  // 两个学院只出一场大场，键由签位决定（赛事 + 轮次 + 阶段 + 签位）。
  assert.equal(started.ties.length, 1);
  assert.equal(started.ties[0].tieId, collegeTieKey(t.eventId, 1, 0));

  const stored = await repo.ties.getById(collegeTieKey(t.eventId, 1, 0));
  assert.equal(stored.schoolId, 'muc');
  assert.equal(stored.association, 'pkb');
  assert.equal(stored.status, TIE_STATUS.PENDING_LINEUP, '首轮大场等双方排阵');

  // 已经进行中，再点开始被拒（与旧栈同口径：非「待开赛」一律不能开始）。
  const again = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(again.ok, false);
  assert.match(again.message, /不能开始/);

  const listed = await call(repo, 'listCollegeTies', { eventId: t.eventId });
  assert.equal(listed.ties.length, 1);
  assert.ok(listed.ties[0].collegeA && listed.ties[0].collegeB);
});

test('跨校：外校读不到大场，也抽不了签', async () => {
  const repo = fixture();
  const t = await publish(repo, 'r1');
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3']);
  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  await call(repo, 'startCollegeEvent', { eventId: t.eventId });

  const buaa = { schoolId: 'buaa', actor: 'demo_buaa_admin' };
  const ties = await call(repo, 'listCollegeTies', { eventId: t.eventId }, buaa);
  assert.equal(ties.ties.length, 0);

  const drawOther = await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 1 }, buaa);
  assert.equal(drawOther.ok, false);
  assert.match(drawOther.message, /不存在/);

  const startOther = await call(repo, 'startCollegeEvent', { eventId: t.eventId }, buaa);
  assert.equal(startOther.ok, false);
  assert.match(startOther.message, /不存在/);
});

/* ------------------------------------------------------------ 排阵 / 开大场 / 名次 */

/** 走到「已开赛、首轮大场等排阵」这一步：发布 → 双方名单通过 → 抽签 → 开赛。 */
async function toTieReady(repo, extra = {}) {
  const t = await publish(repo, 'r1', { legPlan: [LEG_DISCIPLINE.MS], ...extra });
  await approveCollege(repo, t.eventId, C01, ['demo_muc_member_2']);
  await approveCollege(repo, t.eventId, C02, ['demo_muc_member_3', 'demo_muc_member_4']);
  await call(repo, 'drawCollegeEvent', { eventId: t.eventId, seedValue: 42 });
  const started = await call(repo, 'startCollegeEvent', { eventId: t.eventId });
  assert.equal(started.ok, true, started.message);
  return { eventId: t.eventId, tieId: started.ties[0].tieId };
}

test('排阵：本大场参赛学院各自提交，大场转待开，主键带范围', async () => {
  const repo = fixture();
  const { tieId } = await toTieReady(repo);

  // 普通会员不能替学院排阵。
  const byMember = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] },
    { actor: 'demo_muc_member_2' });
  assert.equal(byMember.ok, false);

  // 管理员代交 c01 男单。
  const c01 = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  assert.equal(c01.ok, true, c01.message);
  assert.equal(c01.lineup.college, NAME_C01);
  // 只翻自己那一侧：c02 还没交，大场仍是等排阵。
  assert.equal((await repo.ties.getById(tieId)).lineupA, true);
  assert.equal((await repo.ties.getById(tieId)).lineupB, false);

  // c02 学院负责人交自己那份。
  const c02 = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] },
    { actor: 'demo_muc_member_3' });
  assert.equal(c02.ok, true, c02.message);

  const stored = await repo.ties.getById(tieId);
  assert.equal(stored.lineupA, true);
  assert.equal(stored.lineupB, true);
  // 与旧栈同口径：落库仍是待排阵，状态由 lineupA/lineupB 推导为待开。
  assert.equal(tieStatusOf(stored), TIE_STATUS.READY, '双方齐 → 待开大场');

  // 主键由范围 + 大场 + 学院编号派生。
  const key = collegeLineupKey(tieId, C01, { schoolId: 'muc', association: 'pkb' });
  const row = await repo.lineups.getById(key);
  assert.equal(row.schoolId, 'muc');
  assert.equal(row.association, 'pkb');
  assert.equal(row.collegeId, C01);

  // 重复提交覆盖同一条，每学院恒一条。
  const again = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_4'] }] },
    { actor: 'demo_muc_member_3' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.lineup.entries[0].players[0], 'demo_muc_member_4');
  assert.equal((await repo.lineups.list()).length, 2);

  const listed = await call(repo, 'listCollegeLineups', { tieId });
  assert.equal(listed.lineups.length, 2);
});

test('排阵：没排满 / 替无关学院排 / 名单外的人都被拒', async () => {
  const repo = fixture();
  const { tieId } = await toTieReady(repo);

  // 男单必须排 1 人；空排被拒。
  const empty = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: [] }] });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /排满/);

  // 名单外的队员（这里是 c02 的人）不能替 c01 上场。
  const foreign = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] });
  assert.equal(foreign.ok, false);
  assert.match(foreign.message, /名单/);

  // 替不在本大场的学院排阵被拒（c03 存在但没参赛）。
  const outsider = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: 'c03', entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  assert.equal(outsider.ok, false);
  assert.match(outsider.message, /本学院/);
});

test('开大场：双方排阵齐才能开，铺小场带范围；重开被拒', async () => {
  const repo = fixture();
  const { eventId, tieId } = await toTieReady(repo);

  // 排阵没交齐不能开。
  const early = await call(repo, 'startCollegeTie', { tieId });
  assert.equal(early.ok, false);
  assert.match(early.message, /排阵/);

  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] },
    { actor: 'demo_muc_member_3' });

  // 会员不能替管理员开大场。
  const byMember = await call(repo, 'startCollegeTie', { tieId }, { actor: 'demo_muc_member_2' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  const started = await call(repo, 'startCollegeTie', { tieId });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.tie.status, TIE_STATUS.ONGOING);

  // 小场写进 matches，带范围与参赛双方。
  const legKey = collegeLegKey(eventId, tieId, 1);
  const leg = await repo.matches.getById(legKey);
  assert.equal(leg.schoolId, 'muc');
  assert.equal(leg.association, 'pkb');
  assert.equal(leg.competition, MATCH_COMPETITION.COLLEGE);
  assert.deepEqual(leg.teamA, ['demo_muc_member_2']);
  assert.deepEqual(leg.teamB, ['demo_muc_member_3']);

  const again = await call(repo, 'startCollegeTie', { tieId });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经开始/);
});

test('裁判 / 名次：仅管理员指派，名次只记参赛学院且冠军唯一', async () => {
  const repo = fixture();
  const { eventId, tieId } = await toTieReady(repo);
  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] });
  await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C02, entries: [{ legNo: 1, players: ['demo_muc_member_3'] }] },
    { actor: 'demo_muc_member_3' });
  await call(repo, 'startCollegeTie', { tieId });

  // 会员不能指派裁判。
  const byMember = await call(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'demo_muc_member' },
    { actor: 'demo_muc_member_2' });
  assert.equal(byMember.ok, false);
  assert.match(byMember.message, /管理员/);

  // 指派到不在册的人被拒。
  const ghost = await call(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'nobody' });
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /找不到/);

  const assigned = await call(repo, 'assignCollegeTieReferee', { tieId, refereeId: 'demo_muc_member' });
  assert.equal(assigned.ok, true, assigned.message);
  assert.equal(assigned.tie.referee, 'demo_muc_member');
  // 裁判同时下推到小场。
  assert.equal((await repo.matches.getById(collegeLegKey(eventId, tieId, 1))).referee, 'demo_muc_member');

  // 名次录给不在参赛学院里的名字被拒。
  const badPlacement = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: '不存在的学院', placement: 1 }] });
  assert.equal(badPlacement.ok, false);
  assert.match(badPlacement.message, /参赛学院/);

  // 没有唯一冠军被拒。
  const noChampion = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: NAME_C01, placement: 2 }, { college: NAME_C02, placement: 2 }] });
  assert.equal(noChampion.ok, false);
  assert.match(noChampion.message, /冠军/);

  const finished = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: NAME_C01, placement: 1 }, { college: NAME_C02, placement: 2 }] });
  assert.equal(finished.ok, true, finished.message);
  assert.equal(finished.event.status, COLLEGE_EVENT_STATUS.FINISHED);
  assert.equal(finished.results.length, 2);

  // 结束后再录名次被拒。
  const again = await call(repo, 'finishCollegeEvent',
    { eventId, results: [{ college: NAME_C01, placement: 1 }] });
  assert.equal(again.ok, false);
  assert.match(again.message, /已经结束/);
});

test('跨校：外校读不到排阵，也排不了阵 / 开不了大场', async () => {
  const repo = fixture();
  const { tieId } = await toTieReady(repo);
  const buaa = { schoolId: 'buaa', actor: 'demo_buaa_admin' };

  const lineups = await call(repo, 'listCollegeLineups', { tieId }, buaa);
  assert.equal(lineups.lineups.length, 0);

  const submit = await call(repo, 'submitCollegeLineup',
    { tieId, collegeId: C01, entries: [{ legNo: 1, players: ['demo_muc_member_2'] }] }, buaa);
  assert.equal(submit.ok, false);
  assert.match(submit.message, /找不到/);

  const start = await call(repo, 'startCollegeTie', { tieId }, buaa);
  assert.equal(start.ok, false);
  assert.match(start.message, /找不到/);
});

/* ------------------------------------------------------------------ 小组限制（B6-b） */

const groupHandlers = require('../miniprogram/services/association-group-service');

async function callGroup(repo, action, payload = {}, opts = {}) {
  const { actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb', now = NOW } = opts;
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now });
  return (await groupHandlers[action](payload, ctx)).data;
}

async function makeGroup(repo, token, memberIds) {
  const created = await callGroup(repo, 'createAssociationGroup',
    { requestId: token, name: `院队组${token}`, memberIds });
  assert.equal(created.ok, true, created.message);
  return created.group.groupId;
}

test('B6-b 发布学院赛带小组限制：非法拒绝，合法落库并在 DTO 下发', async () => {
  const repo = fixture();
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member']);

  const empty = await call(repo, 'publishCollegeEvent',
    { requestId: 'r1', ...valid({ audienceMode: 'groups', audienceGroupIds: [] }) });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /至少选择一个小组/);

  const mixed = await call(repo, 'publishCollegeEvent',
    { requestId: 'r2', ...valid({ audienceMode: 'all', audienceGroupIds: [groupId] }) });
  assert.equal(mixed.ok, false);
  assert.match(mixed.message, /不能指定小组/);

  const event = await publish(repo, 'r3', { audienceMode: 'groups', audienceGroupIds: [groupId] });
  assert.equal(event.audienceMode, 'groups');
  assert.deepEqual(event.audienceGroupIds, [groupId]);

  const plain = await publish(repo, 'r4');
  assert.equal(plain.audienceMode, 'all');
  assert.deepEqual(plain.audienceGroupIds, []);
});

test('B6-b G08：名单里仅一人不在限定小组 → 整份提交失败；负责人本人入组不能替代选手资格', async () => {
  const repo = fixture();
  // 组里有 demo_muc_member（c01）与 c02 负责人 demo_muc_member_3；
  // c01 的 demo_muc_member_2 与 c02 的 demo_muc_member_4 不在组里。
  const groupId = await makeGroup(repo, 'g1', ['demo_muc_member', 'demo_muc_member_3']);
  const event = await publish(repo, 'r1', { audienceMode: 'groups', audienceGroupIds: [groupId] });

  // c01 名单：仅 member_2 一人不符 → 整份失败（不是只把那一人剔除）
  const c01 = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member', 'demo_muc_member_2'] },
    { actor: 'demo_muc_admin' });
  assert.equal(c01.ok, false);
  assert.match(c01.message, /小组/);

  // c02 负责人自己交：本人入组不能替代选手资格，member_4 不符 → 整份失败
  const c02 = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C02, memberIds: ['demo_muc_member_3', 'demo_muc_member_4'] },
    { actor: 'demo_muc_member_3' });
  assert.equal(c02.ok, false);
  assert.match(c02.message, /小组/);

  // 全员在组（或名单只含组内成员）才能提交成功
  const ok = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member'] },
    { actor: 'demo_muc_admin' });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.entry.status, COLLEGE_ENTRY_STATUS.PENDING);

  // 跨范围：外校同一名单提交不进去
  const buaa = await call(repo, 'submitCollegeEntry',
    { eventId: event.eventId, collegeId: C01, memberIds: ['demo_muc_member'] },
    { actor: 'demo_buaa_admin', schoolId: 'buaa' });
  assert.equal(buaa.ok, false);
});
