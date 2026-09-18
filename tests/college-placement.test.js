/**
 * 学院名次录入与结束（M5-1）／学院名次与个人分隔离（M5-2）自检
 * ============================================================
 * 这里走完整链路：发布 → 四院交名单 → 审核通过 → 抽签 → 开赛 → 录名次并结束。
 * 纯校验（validateCollegePlacements 等）已在 college-event.test.js 里逐条钉死，
 * 本文件只看数据源与视图模型两端：
 *
 *   1. 结束赛事 —— 管理员录名次后赛事置为已结束、名次按学院落库（M5-1）；
 *   2. 守门 —— 干事 / 会员无权，未开始与已结束都拒下，只能给参赛学院记；
 *   3. 隔离 —— 录名次不产生任何个人等级分与积分变化，也不进个人赛集合（M5-2）；
 *   4. 视图模型 —— 名次页与详情页把权限、候选学院、名次文案算好（M5-1）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const facade = require('../miniprogram/services/index.js');
const { loadCollegePlacementView, loadCollegeEventDetailView } = require('../miniprogram/services/college-view.js');
const {
  ROLE,
  USER_STATUS,
  COLLEGE_EVENT_STATUS,
} = require('../miniprogram/utils/constants.js');

/** 管理员；status 必须为「正常」，否则 canManage 不放行 */
const ADMIN = { _id: 'u01', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };

/** 种子数据里有会员的四个学院 */
const COLLEGES = ['体育学院', '信息工程学院', '经济学院', '管理学院'];

beforeEach(() => {
  facade.resetCache();
});

/** 取某学院在册会员的编号 */
async function memberIdsOf(college) {
  const members = await facade.getMembers();
  return members.filter((member) => member.college === college).map((member) => member._id);
}

/**
 * 造一场「进行中」的学院赛。
 * @param {Array<string>} [legPlan]
 * @returns {Promise<{event:Object, ties:Array}>}
 */
async function setupOngoing(legPlan = ['MS', 'MD']) {
  const published = await facade.publishCollegeEvent(
    {
      title: '学院团体赛测试',
      legPlan,
      startTime: '2026-10-01T09:00:00',
      rosterMin: 1,
      rosterMax: 20,
      courtCount: 4,
    },
    ADMIN._id
  );
  assert.strictEqual(published.ok, true, `发布学院赛失败：${published.firstError}`);
  const event = published.record;

  for (const college of COLLEGES) {
    const result = await facade.submitCollegeEntry(
      { eventId: event._id, college, memberIds: await memberIdsOf(college) },
      ADMIN._id
    );
    assert.strictEqual(result.ok, true, `提交 ${college} 名单失败：${result.message}`);
  }
  for (const entry of await facade.getCollegeEntries(event._id)) {
    await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN._id);
  }

  const drawn = await facade.drawCollegeEvent(event._id, ADMIN._id, { seedValue: 42 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await facade.startCollegeEvent(event._id, ADMIN._id);
  assert.strictEqual(started.ok, true, `开始赛事失败：${started.message}`);

  return { event: drawn.record, ties: started.ties };
}

/** 一份合法名次：冠军 + 亚军 */
function resultsOf() {
  return [
    { college: COLLEGES[0], placement: 1 },
    { college: COLLEGES[1], placement: 2 },
  ];
}

/* ============================================================
 * 一、结束赛事与名次落库（M5-1）
 * ============================================================ */

test('结束赛事 —— 管理员录入名次后赛事置为已结束', async () => {
  const { event } = await setupOngoing();

  const result = await facade.finishCollegeEvent(event._id, resultsOf(), ADMIN._id);
  assert.strictEqual(result.ok, true, result.message);

  const saved = await facade.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.FINISHED);
  assert.deepStrictEqual(saved.results, resultsOf(), '名次按学院原样落库');
});

test('结束赛事 —— 名次里允许缺项，但必须有一位冠军', async () => {
  const { event } = await setupOngoing();

  // 只记冠军，其余学院可能没到场
  const onlyChampion = await facade.finishCollegeEvent(
    event._id,
    [{ college: COLLEGES[0], placement: 1 }],
    ADMIN._id
  );
  assert.strictEqual(onlyChampion.ok, true, onlyChampion.message);
  assert.strictEqual((await facade.getCollegeEvent(event._id)).results.length, 1);
});

test('结束赛事 —— 干事与会员都无权', async () => {
  const { event } = await setupOngoing();

  for (const actor of ['u02', 'u06']) {
    const result = await facade.finishCollegeEvent(event._id, resultsOf(), actor);
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /只有管理员/);
  }
  // 一次都没落库
  assert.strictEqual((await facade.getCollegeEvent(event._id)).status, COLLEGE_EVENT_STATUS.ONGOING);
});

test('结束赛事 —— 未开始与已结束都不能录名次', async () => {
  // 报名中：还没有任何大场结果
  const published = await facade.publishCollegeEvent(
    { title: '还没开始的学院赛', legPlan: ['MS'], startTime: '2026-10-01T09:00:00', rosterMin: 1, rosterMax: 20, courtCount: 4 },
    ADMIN._id
  );
  const notStarted = await facade.finishCollegeEvent(
    published.record._id,
    [{ college: COLLEGES[0], placement: 1 }],
    ADMIN._id
  );
  assert.strictEqual(notStarted.ok, false);
  assert.match(notStarted.message, /还没开始/);

  // 已结束：不能重录
  const { event } = await setupOngoing();
  await facade.finishCollegeEvent(event._id, resultsOf(), ADMIN._id);
  const again = await facade.finishCollegeEvent(event._id, resultsOf(), ADMIN._id);
  assert.strictEqual(again.ok, false);
  assert.match(again.message, /已经结束/);
});

test('结束赛事 —— 只能给已通过名单的学院记名次', async () => {
  const { event } = await setupOngoing();

  const outsider = await facade.finishCollegeEvent(
    event._id,
    [{ college: '哲学学院', placement: 1 }],
    ADMIN._id
  );
  assert.strictEqual(outsider.ok, false);
  assert.match(outsider.message, /参赛学院/);
  // 拒下时赛事仍是进行中，名次没有半途落库
  const saved = await facade.getCollegeEvent(event._id);
  assert.strictEqual(saved.status, COLLEGE_EVENT_STATUS.ONGOING);
  assert.deepStrictEqual(saved.results, []);
});

test('结束赛事 —— 缺冠军或重名次都被拒下', async () => {
  const { event } = await setupOngoing();

  const noChampion = await facade.finishCollegeEvent(
    event._id,
    [
      { college: COLLEGES[0], placement: 2 },
      { college: COLLEGES[1], placement: 3 },
    ],
    ADMIN._id
  );
  assert.strictEqual(noChampion.ok, false);
  assert.match(noChampion.message, /冠军/);

  const twice = await facade.finishCollegeEvent(
    event._id,
    [
      { college: COLLEGES[0], placement: 1 },
      { college: COLLEGES[0], placement: 2 },
    ],
    ADMIN._id
  );
  assert.strictEqual(twice.ok, false);
  assert.match(twice.message, /每院只记一次/);
});

/* ============================================================
 * 二、学院名次与个人分隔离（M5-2）
 * ============================================================ */

test('隔离 —— 录入学院名次不改变任何人的等级分与积分', async () => {
  const { event } = await setupOngoing();

  const beforeMembers = await facade.getMembers();
  // 先确认基线非零：若 seed 里 points 本来就是 0，deepEqual 就证明不了什么
  assert.ok(
    beforeMembers.some((member) => member.points > 0),
    '演示数据里应已有个人积分，隔离用例才有意义'
  );

  const result = await facade.finishCollegeEvent(
    event._id,
    [
      { college: COLLEGES[0], placement: 1 },
      { college: COLLEGES[1], placement: 2 },
      { college: COLLEGES[2], placement: 3 },
    ],
    ADMIN._id
  );
  assert.strictEqual(result.ok, true, result.message);

  const afterMembers = await facade.getMembers();
  assert.deepStrictEqual(afterMembers, beforeMembers, '学院名次不该动任何个人的等级分与积分');
});

test('隔离 —— 学院赛不进个人赛事集合', async () => {
  const { event } = await setupOngoing();
  await facade.finishCollegeEvent(event._id, resultsOf(), ADMIN._id);

  const personalEvents = await facade.getEvents();
  assert.strictEqual(
    personalEvents.some((item) => item._id === event._id),
    false,
    '学院赛写在 college_events 集合，个人赛事读路径里不应出现'
  );
});

/* ============================================================
 * 三、视图模型（M5-1）
 * ============================================================ */

test('名次页视图 —— 管理员在赛事进行中可提交，候选只有参赛学院', async () => {
  const { event } = await setupOngoing();

  const view = await loadCollegePlacementView(event._id, { user: ADMIN });
  assert.strictEqual(view.found, true);
  assert.strictEqual(view.canSubmit, true);
  assert.strictEqual(view.blockReason, '');
  assert.deepStrictEqual(
    view.rows.map((row) => row.college).sort(),
    [...COLLEGES].sort(),
    '一行一所已通过名单的学院'
  );
  assert.ok(view.rows.every((row) => row.placementText === ''), '还没录过名次，输入框留空');
});

test('名次页视图 —— 未开始 / 已结束 / 无权限各有各的拦截文案', async () => {
  const notStarted = await facade.publishCollegeEvent(
    { title: '报名中的学院赛', legPlan: ['MS'], startTime: '2026-10-01T09:00:00', rosterMin: 1, rosterMax: 20, courtCount: 4 },
    ADMIN._id
  );
  const signupView = await loadCollegePlacementView(notStarted.record._id, { user: ADMIN });
  assert.strictEqual(signupView.canSubmit, false);
  assert.match(signupView.blockReason, /还没开始/);

  const { event } = await setupOngoing();
  const staff = { _id: 'u02', role: ROLE.STAFF, status: USER_STATUS.ACTIVE, college: COLLEGES[0] };
  const staffView = await loadCollegePlacementView(event._id, { user: staff });
  assert.strictEqual(staffView.canSubmit, false);
  assert.match(staffView.blockReason, /只有管理员/);

  const guestView = await loadCollegePlacementView(event._id, { user: null });
  assert.strictEqual(guestView.canSubmit, false);
  assert.match(guestView.blockReason, /请先登录/);

  await facade.finishCollegeEvent(event._id, resultsOf(), ADMIN._id);
  const doneView = await loadCollegePlacementView(event._id, { user: ADMIN });
  assert.strictEqual(doneView.canSubmit, false);
  assert.match(doneView.blockReason, /已经结束/);
});

test('详情页视图 —— 进行中给录入入口，结束后展示名次文案', async () => {
  const { event } = await setupOngoing();

  const ongoing = await loadCollegeEventDetailView(event._id, { user: ADMIN });
  assert.strictEqual(ongoing.canFinish, true, '进行中的赛事给管理员录入入口');
  assert.strictEqual(ongoing.hasResults, false);

  await facade.finishCollegeEvent(
    event._id,
    [
      { college: COLLEGES[0], placement: 1 },
      { college: COLLEGES[1], placement: 2 },
      { college: COLLEGES[2], placement: 3 },
    ],
    ADMIN._id
  );

  const finished = await loadCollegeEventDetailView(event._id, { user: ADMIN });
  assert.strictEqual(finished.isFinished, true);
  assert.strictEqual(finished.canFinish, false, '已结束不再给录入入口');
  assert.strictEqual(finished.hasResults, true);
  assert.deepStrictEqual(
    finished.resultRows.map((row) => [row.college, row.placementText]),
    [
      [COLLEGES[0], '冠军'],
      [COLLEGES[1], '亚军'],
      [COLLEGES[2], '四强'],
    ]
  );
});
