/**
 * 场地分配 端到端自检（M7）
 * ============================================================
 * 纯函数那半边在 court.test.js 里钉死了（同池不重复、可重入、兜底）。
 * 这里走真实数据源，回答纯函数答不了的那个问题：**写路径有没有真的把
 * 场号写进去，写进去的又是不是同一个答案**。
 *
 * 三条链各测一遍：
 *   1. 个人赛抽签 —— 首轮整批一次算完；
 *   2. 晋级 —— 下一轮是「只补不覆盖」重算出来的，场号必须与重算一致，
 *      否则界面上刷新一次场号就跳；
 *   3. 学院赛 —— 大场级分配，下推到名下每一个小场（一个大场占一块场地）。
 *
 * 末尾几条是零回归：约球不带场号，历史赛事没有场地数也不炸。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const facade = require('../miniprogram/services/index.js');
const {
  ROLE,
  MATCH_TYPE,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  DEFAULT_TIE_ALGO,
} = require('../miniprogram/utils/constants.js');
const { planCourts } = require('../miniprogram/services/court.js');
// 旧栈 loadEventDetailView 已随协议 1 下线删除；场地看板的视图级守护
// 迁到了 tests/school-event-view.test.js 的「场地看板」用例（S2 详情装载器）。
const { buildCourtBoard } = require('../miniprogram/services/events-view.js');
const { buildEventRow } = require('../miniprogram/services/event.js');
const { buildRecordRow } = require('../miniprogram/services/match-view.js');

/** 种子里的管理员 */
const ADMIN_ID = 'u01';

beforeEach(() => {
  facade.resetCache();
});

/* ============================================================
 * 个人赛
 * ============================================================ */

/** 一份合法的单打赛事表单 */
function draft(overrides = {}) {
  return {
    title: '场地分配演练赛',
    description: 'M7 场号自检',
    matchType: MATCH_TYPE.SINGLES,
    level: EVENT_LEVEL.SECOND,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    seedMode: SEED_MODE.ELO,
    seedCount: 4,
    startTime: '2026-05-20T09:00:00',
    location: '学校体育馆',
    quota: 8,
    courtCount: 4,
    ...overrides,
  };
}

/** 取某赛事名下的全部比赛 */
async function eventMatches(eventId) {
  return facade.getMatchRecords({ eventId });
}

/**
 * 造一场进行中的单打赛事：发布 → 报名 → 抽签 → 开赛。
 * 只用普通会员当选手——管理员那套绕过规则会掩盖写路径上的问题。
 *
 * @param {number} playerCount 报名人数
 * @param {Object} [overrides] 表单覆盖项
 */
async function setupSingles(playerCount = 8, overrides = {}) {
  const members = await facade.getMembers();
  const players = members
    .filter((member) => member.role === ROLE.MEMBER)
    .slice(0, playerCount)
    .map((member) => member._id);
  assert.strictEqual(players.length, playerCount, `种子里的普通会员不够 ${playerCount} 位`);

  const published = await facade.publishEvent(draft(overrides), ADMIN_ID);
  assert.strictEqual(published.ok, true, `发布赛事失败：${published.firstError}`);

  const eventId = published.record._id;
  for (const userId of players) {
    const signed = await facade.signUpEvent(eventId, userId);
    assert.strictEqual(signed.ok, true, `报名失败：${signed.message}`);
  }

  const drawn = await facade.drawEvent(eventId, ADMIN_ID, { seedValue: 11 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await facade.startEvent(eventId, ADMIN_ID);
  assert.strictEqual(started.ok, true, `开赛失败：${started.message}`);

  return { eventId, players, courtCount: overrides.courtCount || 4 };
}

/** 把某场比赛打完并确认生效，返回下一轮是否随之排出来 */
async function completeMatch(match) {
  const recorded = await facade.submitMatch({
    id: match._id,
    scoreA: ['11', '11'],
    scoreB: ['5', '3'],
    actor: match.teamA[0],
  });
  assert.strictEqual(recorded.ok, true, recorded.firstError);
  const confirmed = await facade.confirmMatch(match._id, match.teamB[0]);
  assert.strictEqual(confirmed.ok, true, confirmed.message);
}

/**
 * 逐场比对：落库的场号必须等于把同一批比赛放回纯函数重算的结果。
 *
 * 【为什么这是最关键的一条】
 * 下一轮的生成走「只补不覆盖」，同一批比赛会被反复重算。分配一旦不可重入，
 * 用户刷新一次页面场号就变一次。纯函数测试钉住了「重算稳定」，这里钉住
 * 「写进去的就是重算的那个值」——两根钉子合起来才立得住。
 */
function assertCourtsMatchPlan(records, courtCount) {
  const plan = planCourts(records, courtCount);
  records.forEach((record, index) => {
    assert.strictEqual(
      record.courtNo,
      plan[index].courtNo,
      `${record._id} 落库场号 ${record.courtNo} 与重算 ${plan[index].courtNo} 不一致`
    );
    assert.ok(
      record.courtNo >= 1 && record.courtNo <= courtCount,
      `${record._id} 的场号 ${record.courtNo} 越出 1..${courtCount}`
    );
  });
}

test('个人赛 —— 抽签后每一场都带场号，且不越出场地数', async () => {
  const { eventId } = await setupSingles(8, { courtCount: 4 });
  const records = await eventMatches(eventId);

  assert.ok(records.length > 0, '抽签应排出比赛');
  records.forEach((record) => {
    assert.ok(
      Number(record.courtNo) >= 1,
      `${record._id} 没有场号：老记录才会缺，新抽的签不该缺`
    );
  });
  assertCourtsMatchPlan(records, 4);
});

test('个人赛 —— 场地够用时同一轮次场号不重复（需求原话）', async () => {
  const { eventId } = await setupSingles(8, { courtCount: 4 });
  const first = (await eventMatches(eventId)).filter((record) => record.round === 1);

  assert.strictEqual(first.length, 4, '8 人单败首轮应有 4 场');
  const courts = first.map((record) => record.courtNo).sort((a, b) => a - b);
  assert.deepStrictEqual(courts, [1, 2, 3, 4], '够用时首轮正好铺满 1~4 号场');
});

test('个人赛 —— 场地不够时同一批内仍不重复，多出来的排到下一批', async () => {
  const { eventId } = await setupSingles(8, { courtCount: 2 });
  const first = (await eventMatches(eventId)).filter((record) => record.round === 1);

  assert.strictEqual(first.length, 4);
  // 池内次序由签位决定，8 人首轮四个签位 → 场号循环 1,2,1,2
  const bySlot = first.slice().sort((a, b) => Number(a.slot) - Number(b.slot));
  assert.deepStrictEqual(bySlot.map((record) => record.courtNo), [1, 2, 1, 2]);

  // 逐批检查：同一块场地在同批里只出现一次
  const waves = new Map();
  bySlot.forEach((record, index) => {
    const wave = Math.floor(index / 2) + 1;
    if (!waves.has(wave)) waves.set(wave, []);
    waves.get(wave).push(record.courtNo);
  });
  waves.forEach((courts, wave) => {
    assert.strictEqual(new Set(courts).size, courts.length, `第 ${wave} 批场号重复：${courts.join(',')}`);
  });
});

test('个人赛 —— 晋级排出来的下一轮同样带场号，且与重算一致', async () => {
  const { eventId } = await setupSingles(8, { courtCount: 4 });

  for (const match of (await eventMatches(eventId)).filter((record) => record.round === 1)) {
    await completeMatch(match);
  }

  const records = await eventMatches(eventId);
  const finals = records.filter((record) => record.round === 2);
  assert.ok(finals.length > 0, '首轮全部出结果后应排出下一轮');
  finals.forEach((record) => {
    assert.ok(Number(record.courtNo) >= 1, `${record._id} 晋级后丢了场号`);
  });
  assertCourtsMatchPlan(records, 4);
});

test('个人赛 —— 场地分配表按场号分组，组内按签表次序排', async () => {
  const { eventId } = await setupSingles(8, { courtCount: 2 });
  const records = await eventMatches(eventId);
  const board = buildCourtBoard({ _id: eventId, courtCount: 2 }, records, records.map((record) => ({
    matchId: record._id,
    courtText: `${record.courtNo} 号场`,
    roundText: `第 ${record.round} 轮`,
  })));

  assert.deepStrictEqual(board.map((group) => group.courtText), ['1 号场', '2 号场']);
  board.forEach((group) => {
    assert.ok(group.rows.length > 0, `${group.courtText} 上没有比赛`);
    group.rows.forEach((row) => {
      const record = records.find((item) => item._id === row.matchId);
      assert.strictEqual(record.courtNo, group.courtNo, '分到这一组的比赛场号必须对得上');
    });
  });
});

test('个人赛 —— 没有场地数时不建表，不抛错', async () => {
  const { eventId } = await setupSingles(4, { courtCount: 2 });
  const records = await eventMatches(eventId);
  assert.deepStrictEqual(buildCourtBoard({ _id: eventId }, records, []), []);
});

/* ============================================================
 * 学院赛
 * ============================================================ */

const COLLEGES = ['体育学院', '信息工程学院', '经济学院', '管理学院'];

async function memberIdsOf(college) {
  const members = await facade.getMembers();
  return members.filter((member) => member.college === college).map((member) => member._id);
}

/** 造一场已开赛的学院赛：发布 → 四院交名单 → 审核 → 抽签 → 开赛 */
async function setupCollege(courtCount = 2) {
  const published = await facade.publishCollegeEvent(
    {
      title: '学院赛场地演练',
      legPlan: ['MS'],
      startTime: '2026-10-01T09:00:00',
      rosterMin: 1,
      rosterMax: 20,
      courtCount,
      tieAlgo: DEFAULT_TIE_ALGO,
    },
    ADMIN_ID
  );
  assert.strictEqual(published.ok, true, `发布学院赛失败：${published.firstError}`);
  const event = published.record;

  for (const college of COLLEGES) {
    const result = await facade.submitCollegeEntry(
      { eventId: event._id, college, memberIds: await memberIdsOf(college) },
      ADMIN_ID
    );
    assert.strictEqual(result.ok, true, `提交 ${college} 名单失败：${result.message}`);
  }
  for (const entry of await facade.getCollegeEntries(event._id)) {
    await facade.reviewCollegeEntry(entry._id, 'approve', '', ADMIN_ID);
  }

  const drawn = await facade.drawCollegeEvent(event._id, ADMIN_ID, { seedValue: 42 });
  assert.strictEqual(drawn.ok, true, `抽签失败：${drawn.message}`);

  const started = await facade.startCollegeEvent(event._id, ADMIN_ID);
  assert.strictEqual(started.ok, true, `开始赛事失败：${started.message}`);

  return { eventId: event._id, courtCount };
}

/** 双方排阵齐后开始大场 */
async function beginTie(tie) {
  const entriesOf = (ids) => tie.legs.map((leg) => ({ legNo: leg.legNo, players: [ids[0]] }));
  const a = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeA, entries: entriesOf(await memberIdsOf(tie.collegeA)) },
    ADMIN_ID
  );
  assert.strictEqual(a.ok, true, `A 排阵失败：${a.message}`);
  const b = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeB, entries: entriesOf(await memberIdsOf(tie.collegeB)) },
    ADMIN_ID
  );
  assert.strictEqual(b.ok, true, `B 排阵失败：${b.message}`);

  const started = await facade.startTie(tie._id, ADMIN_ID);
  assert.strictEqual(started.ok, true, `开始大场失败：${started.message}`);
  return (await facade.getCollegeTies(tie.eventId)).find((item) => item._id === tie._id);
}

test('学院赛 —— 开赛后每个大场都有场号，够用时同轮不重复', async () => {
  const { eventId } = await setupCollege(2);
  const ties = await facade.getCollegeTies(eventId);

  assert.strictEqual(ties.length, 2, '四院单败首轮应有 2 个大场');
  ties.forEach((tie) => {
    assert.ok(Number(tie.courtNo) >= 1, `${tie._id} 没有场号`);
    assert.ok(Number(tie.courtNo) <= 2, `${tie._id} 的场号越界`);
  });
  const courts = ties.map((tie) => tie.courtNo).sort((a, b) => a - b);
  assert.deepStrictEqual(courts, [1, 2], '2 块场地时两个大场各占一块');

  const plan = planCourts(ties, 2);
  ties.forEach((tie, index) => {
    assert.strictEqual(tie.courtNo, plan[index].courtNo, `${tie._id} 与重算不一致`);
  });
});

test('学院赛 —— 场地不够时两个大场共用一块，批内仍不重复', async () => {
  const { eventId } = await setupCollege(1);
  const ties = await facade.getCollegeTies(eventId);

  assert.strictEqual(ties.length, 2);
  ties.forEach((tie) => {
    assert.strictEqual(tie.courtNo, 1, '只有 1 块场地时两个大场都落在 1 号场');
  });
});

test('学院赛 —— 一个大场占一块场地：名下小场继承同一个场号', async () => {
  const { eventId } = await setupCollege(2);
  const tie = (await facade.getCollegeTies(eventId))[0];
  const begun = await beginTie(tie);

  assert.ok(begun.legs.length > 0, '开赛后应生成小场');
  // 先钉住大场自己有场号：少了这一句，「小场 = 大场」在两边都是 0 时也成立，
  // 分配整个没跑起来测试也不会红
  assert.ok(begun.courtNo >= 1 && begun.courtNo <= 2, `大场没有场号：${begun.courtNo}`);
  for (const leg of begun.legs) {
    const records = await facade.getMatchRecords({ id: leg.matchId });
    assert.strictEqual(records.length, 1, `小场 ${leg.matchId} 应能查到`);
    assert.strictEqual(
      records[0].courtNo,
      begun.courtNo,
      '小场的场号必须等于大场的场号（Q7：小项依次在同一块场地打完）'
    );
  }
});

/* ============================================================
 * 零回归
 * ============================================================ */

test('零回归 —— 日常约球没有场号，也不会渲染出「0 号场」', async () => {
  const members = await facade.getMembers();
  const submitted = await facade.submitMatch({
    matchType: MATCH_TYPE.SINGLES,
    teamA: [members[0]._id],
    teamB: [members[1]._id],
    scoreA: ['11'],
    scoreB: ['5'],
    gamePoints: 11,
    bestOf: 1,
    matchTime: '2026-05-01T18:00:00',
    location: '学校体育馆 1 号场',
  });
  assert.strictEqual(submitted.ok, true, submitted.firstError);
  assert.strictEqual(submitted.match.courtNo, undefined, '约球不该凭空多出场地字段');

  const row = buildRecordRow(submitted.match, { userId: members[0]._id });
  assert.strictEqual(row.courtText, '', '没有场号时是空串，模板用 wx:if 挡掉');
});

test('零回归 —— 历史赛事没有场地数字段时显示「未设置」，不抛错', async () => {
  const events = await facade.getEvents();
  assert.ok(events.length > 0, '种子赛事应至少有一条');

  const row = buildEventRow({ ...events[0], courtCount: undefined });
  assert.strictEqual(row.courtCountText, '未设置', '缺字段时显示「未设置」而不是崩溃');
  assert.strictEqual(row.courtCount, 0);
});
