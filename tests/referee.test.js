/**
 * 裁判指派端到端演练（M6）
 * ============================================================
 * 裁判是一层「收口」：没指派时一切照旧，指派之后录分权与确认权都
 * 落到裁判本人 + 管理员头上。这条链走真实数据源，把两件事钉死：
 *
 *   1. 个人赛小场 —— 管理员指派 → 旁人录不了分 → 裁判录分并确认；
 *   2. 学院赛大场 —— 指派一次下发到名下所有小场 → 小场同样收口。
 *
 * 另覆盖零回归、权限、边界与「指派不动等级分」几条底线。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { beforeEach } = require('node:test');

const facade = require('../miniprogram/services/index.js');
const {
  ROLE,
  MATCH_TYPE,
  MATCH_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  SEED_MODE,
  TIE_STATUS,
} = require('../miniprogram/utils/constants.js');

/** 种子里的管理员 */
const ADMIN_ID = 'u01';

beforeEach(() => {
  facade.resetCache();
});

/* ============================================================
 * 个人赛小场
 * ============================================================ */

/** 一份合法的单打赛事表单 */
function draft(overrides = {}) {
  return {
    title: '裁判演练赛',
    description: 'M6 裁判派发自检',
    matchType: MATCH_TYPE.SINGLES,
    level: EVENT_LEVEL.SECOND,
    bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
    seedMode: SEED_MODE.ELO,
    seedCount: 4,
    startTime: '2026-05-20T09:00:00',
    location: '学校体育馆',
    quota: 4,
    courtCount: 4,
    ...overrides,
  };
}

/** 取某赛事名下的全部比赛 */
async function eventMatches(eventId) {
  return facade.getMatchRecords({ eventId });
}

/** 一组选手当前的等级分（单打 / 双打两池） */
async function ratingsOf(userIds) {
  const members = await facade.getMembers();
  const out = {};
  for (const id of userIds) {
    const member = members.find((item) => item._id === id);
    out[id] = { singles: member.ratings.singles.elo, doubles: member.ratings.doubles.elo };
  }
  return out;
}

/**
 * 造一场进行中的 4 人单败赛事：发布 → 报名 → 抽签 → 开赛。
 * @returns {Promise<{eventId:string, players:string[], outsider:string}>}
 */
async function setupSingles(overrides = {}) {
  const members = await facade.getMembers();
  // 只用普通会员：种子里 u01 是管理员、u02 是干事，把他们当「选手」，
  // 管理员那套绕过规则会掩盖裁判这道闸门是否真的生效
  const plain = members.filter((member) => member.role === ROLE.MEMBER);
  const players = plain.slice(0, 4).map((member) => member._id);
  const outsider = plain[4]._id;

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

  return { eventId, players, outsider };
}

test('裁判 —— 未指派时录分权与今天完全一致（零回归）', async () => {
  const { eventId } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);
  const me = match.teamA[0];

  const recorded = await facade.submitMatch({
    id: match._id,
    scoreA: ['11', '11'],
    scoreB: ['5', '3'],
    actor: me,
  });
  assert.strictEqual(recorded.ok, true, recorded.firstError);
});

test('裁判 —— 指派后只有裁判与管理员能录分、确认', async () => {
  const { eventId, outsider } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);
  const me = match.teamA[0];
  const rival = match.teamB[0];

  const assigned = await facade.assignMatchReferee(match._id, outsider, ADMIN_ID);
  assert.strictEqual(assigned.ok, true, assigned.message);
  assert.strictEqual(assigned.match.referee, outsider);
  assert.strictEqual(assigned.match.refereeBy, ADMIN_ID);

  // 参赛者本人录不了——这场比赛已经交给他执法
  const byPlayer = await facade.submitMatch({
    id: match._id,
    scoreA: ['11', '11'],
    scoreB: ['5', '3'],
    actor: me,
  });
  assert.strictEqual(byPlayer.ok, false);
  assert.match(byPlayer.firstError, /参赛者/);

  // 裁判可以录
  const byReferee = await facade.submitMatch({
    id: match._id,
    scoreA: ['11', '11'],
    scoreB: ['5', '3'],
    actor: outsider,
  });
  assert.strictEqual(byReferee.ok, true, byReferee.firstError);

  // 对手不能替裁判确认
  const byRival = await facade.confirmMatch(match._id, rival);
  assert.strictEqual(byRival.ok, false, '指派裁判后确认权也收口到裁判');

  // 裁判自己盖章，成绩生效
  const byRefereeConfirm = await facade.confirmMatch(match._id, outsider);
  assert.strictEqual(byRefereeConfirm.ok, true, byRefereeConfirm.message);

  const after = (await eventMatches(eventId)).find((item) => item._id === match._id);
  assert.strictEqual(after.status, MATCH_STATUS.ACTIVE);
  assert.strictEqual(after.referee, outsider, '生效后裁判仍留痕');
  assert.strictEqual(after.recorder, outsider);
});

test('裁判 —— 取消指派后又回到「人人照旧」', async () => {
  const { eventId, outsider } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);
  const me = match.teamA[0];

  await facade.assignMatchReferee(match._id, outsider, ADMIN_ID);
  const cleared = await facade.assignMatchReferee(match._id, '', ADMIN_ID);
  assert.strictEqual(cleared.ok, true, cleared.message);
  assert.strictEqual(cleared.match.referee, '');

  const recorded = await facade.submitMatch({
    id: match._id,
    scoreA: ['11', '11'],
    scoreB: ['5', '3'],
    actor: me,
  });
  assert.strictEqual(recorded.ok, true, recorded.firstError);
});

test('裁判 —— 只有管理员能指派，旁人一律被拒', async () => {
  const { eventId, outsider } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);
  const me = match.teamA[0];

  const byPlayer = await facade.assignMatchReferee(match._id, outsider, me);
  assert.strictEqual(byPlayer.ok, false);
  assert.match(byPlayer.message, /管理员/);

  const after = (await eventMatches(eventId)).find((item) => item._id === match._id);
  assert.strictEqual(after.referee, undefined, '被拒后记录不动');
});

test('裁判 —— 已生效的比赛不能再改派', async () => {
  const { eventId, outsider } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);
  const me = match.teamA[0];
  const rival = match.teamB[0];

  await facade.submitMatch({ id: match._id, scoreA: ['11', '11'], scoreB: ['5', '3'], actor: me });
  await facade.confirmMatch(match._id, rival);

  const result = await facade.assignMatchReferee(match._id, outsider, ADMIN_ID);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /已生效/);
});

test('裁判 —— 查无此人与不能执法的人分开报错', async () => {
  const { eventId, outsider } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);

  const ghost = await facade.assignMatchReferee(match._id, 'u999', ADMIN_ID);
  assert.strictEqual(ghost.ok, false);
  assert.match(ghost.message, /找不到这位会员/);

  // 造一个待审核账号：待审核的人不该出现在赛场上执法
  const pending = await facade.registerMember({
    nickName: '待审核裁判',
    realName: '还没转正',
    studentId: '20239999',
    gender: 'M',
    college: '体育学院',
    phone: '13700002222',
  });
  assert.strictEqual(pending.ok, true, pending.firstError);

  const result = await facade.assignMatchReferee(match._id, pending.account._id, ADMIN_ID);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /正常在册/);

  // 合法的那位仍然指派成功，说明前两次拒绝没有污染数据
  const ok = await facade.assignMatchReferee(match._id, outsider, ADMIN_ID);
  assert.strictEqual(ok.ok, true, ok.message);
});

test('裁判 —— 指派不改变任何人的等级分（不进回放）', async () => {
  const { eventId, players, outsider } = await setupSingles();
  const match = (await eventMatches(eventId)).find((item) => item.round === 1);
  const before = await ratingsOf([...players, outsider]);

  await facade.assignMatchReferee(match._id, outsider, ADMIN_ID);

  assert.deepStrictEqual(await ratingsOf([...players, outsider]), before);
});

/* ============================================================
 * 学院赛大场
 * ============================================================ */

/** 演示数据里有在册会员的四个学院，够撑起两轮单败签表 */
const COLLEGES = ['体育学院', '信息工程学院', '经济学院', '管理学院'];

/** 取某学院在册会员的编号 */
async function memberIdsOf(college) {
  const members = await facade.getMembers();
  return members.filter((member) => member.college === college).map((member) => member._id);
}

/** 造一场进行中的学院赛：发布 → 四院交名单 → 审核通过 → 抽签 → 开赛 */
async function setupOngoing(legPlan = ['MS']) {
  const published = await facade.publishCollegeEvent(
    {
      title: '学院赛裁判演练',
      legPlan,
      startTime: '2026-10-01T09:00:00',
      rosterMin: 1,
      rosterMax: 20,
      courtCount: 4,
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

  return { event: drawn.record, ties: started.ties };
}

/** 按小项人数排一份阵容：单打 1 人、双打 2 人 */
function lineupEntries(ids, legs) {
  return legs.map((leg) => ({
    legNo: leg.legNo,
    players: leg.discipline.endsWith('S') ? [ids[0]] : ids.slice(0, 2),
  }));
}

/** 取最新的某大场记录 */
async function tieOf(eventId, tieId) {
  return (await facade.getCollegeTies(eventId)).find((item) => item._id === tieId);
}

/** 双方排阵齐后开始大场，返回该大场的小场信息 */
async function beginTie(tie) {
  const aIds = await memberIdsOf(tie.collegeA);
  const bIds = await memberIdsOf(tie.collegeB);

  const lineupA = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeA, entries: lineupEntries(aIds, tie.legs) },
    ADMIN_ID
  );
  assert.strictEqual(lineupA.ok, true, `A 排阵失败：${lineupA.message}`);
  const lineupB = await facade.submitLineup(
    { tieId: tie._id, college: tie.collegeB, entries: lineupEntries(bIds, tie.legs) },
    ADMIN_ID
  );
  assert.strictEqual(lineupB.ok, true, `B 排阵失败：${lineupB.message}`);

  const started = await facade.startTie(tie._id, ADMIN_ID);
  assert.strictEqual(started.ok, true, `开始大场失败：${started.message}`);

  return { tie: await tieOf(tie.eventId, tie._id), aIds, bIds };
}

/** 取某大场里某场小场的比赛记录 */
async function legMatchOf(tie, legNo) {
  const leg = tie.legs.find((item) => Number(item.legNo) === Number(legNo));
  const records = await facade.getMatchRecords({ id: leg.matchId });
  return records[0] || null;
}

test('学院赛裁判 —— 指派一次下发到名下所有小场', async () => {
  // 两个男单小项：演示数据里这四个学院都至少有一名男队员，排得齐
  const { event } = await setupOngoing(['MS', 'MS']);
  const tie = (await facade.getCollegeTies(event._id))[0];
  const referee = (await memberIdsOf('经济学院'))[0];

  const assigned = await facade.assignTieReferee(tie._id, referee, ADMIN_ID);
  assert.strictEqual(assigned.ok, true, assigned.message);
  assert.strictEqual(assigned.record.referee, referee);
  assert.strictEqual(assigned.matches.length, 0, '排阵前还没生成小场，自然没有可改的小场');

  const begun = await beginTie(await tieOf(event._id, tie._id));
  assert.strictEqual(begun.tie.referee, referee, '大场裁判留在记录上');

  const first = await legMatchOf(begun.tie, 1);
  const second = await legMatchOf(begun.tie, 2);
  assert.strictEqual(first.referee, referee, '每个小场都跟着拿到裁判');
  assert.strictEqual(second.referee, referee);
});

test('学院赛裁判 —— 小场录分收口到裁判，参赛选手被挡下', async () => {
  const { event } = await setupOngoing(['MS']);
  const tie = (await facade.getCollegeTies(event._id))[0];
  const referee = (await memberIdsOf('经济学院'))[0];

  const assigned = await facade.assignTieReferee(tie._id, referee, ADMIN_ID);
  assert.strictEqual(assigned.ok, true, assigned.message);

  const begun = await beginTie(await tieOf(event._id, tie._id));
  const singles = await legMatchOf(begun.tie, 1);
  // 挑一个真正在场的普通会员：管理员本来就能代录，拿他当「选手」测不出闸门
  const player = [...singles.teamA, ...singles.teamB].find((id) => id !== ADMIN_ID);

  const byPlayer = await facade.submitMatch({
    id: singles._id,
    scoreA: ['11'],
    scoreB: ['5'],
    actor: player,
  });
  assert.strictEqual(byPlayer.ok, false, '选手不能自己录分');

  const byReferee = await facade.submitMatch({
    id: singles._id,
    scoreA: ['11'],
    scoreB: ['5'],
    actor: referee,
  });
  assert.strictEqual(byReferee.ok, true, byReferee.firstError);

  const confirmed = await facade.confirmMatch(singles._id, referee);
  assert.strictEqual(confirmed.ok, true, confirmed.message);
});

test('学院赛裁判 —— 开赛后仍可改派，改派即刻覆盖未生效的小场', async () => {
  const { event } = await setupOngoing(['MS']);
  const tie = (await facade.getCollegeTies(event._id))[0];
  const first = (await memberIdsOf('经济学院'))[0];
  const second = (await memberIdsOf('管理学院'))[0];
  assert.notStrictEqual(first, second);

  await facade.assignTieReferee(tie._id, first, ADMIN_ID);
  const begun = await beginTie(await tieOf(event._id, tie._id));

  const reassigned = await facade.assignTieReferee(tie._id, second, ADMIN_ID);
  assert.strictEqual(reassigned.ok, true, reassigned.message);
  assert.strictEqual(reassigned.matches.length, 1, '已生成的小场跟着改派');

  const singles = await legMatchOf(await tieOf(event._id, tie._id), 1);
  assert.strictEqual(singles.referee, second);

  // 原裁判录不了分，新裁判可以
  const byOld = await facade.submitMatch({ id: singles._id, scoreA: ['11'], scoreB: ['5'], actor: first });
  assert.strictEqual(byOld.ok, false);
  const byNew = await facade.submitMatch({ id: singles._id, scoreA: ['11'], scoreB: ['5'], actor: second });
  assert.strictEqual(byNew.ok, true, byNew.firstError);
});

test('学院赛裁判 —— 只有管理员能指派大场裁判', async () => {
  const { event } = await setupOngoing(['MS']);
  const tie = (await facade.getCollegeTies(event._id))[0];
  const referee = (await memberIdsOf('经济学院'))[0];

  const result = await facade.assignTieReferee(tie._id, referee, referee);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /管理员/);
});

test('学院赛裁判 —— 已结束的大场不能再改派', async () => {
  const { event } = await setupOngoing(['MS']);
  const tie = (await facade.getCollegeTies(event._id))[0];
  const referee = (await memberIdsOf('经济学院'))[0];

  // 走真实链路把唯一的小场打完，大场随之结束
  await beginTie(await tieOf(event._id, tie._id));
  const singles = await legMatchOf(await tieOf(event._id, tie._id), 1);
  await facade.submitMatch({ id: singles._id, scoreA: ['11'], scoreB: ['5'], actor: ADMIN_ID });
  await facade.confirmMatch(singles._id, ADMIN_ID);

  const finished = await tieOf(event._id, tie._id);
  assert.strictEqual(finished.status, TIE_STATUS.FINISHED, '小场打完后大场应已结束');

  const result = await facade.assignTieReferee(tie._id, referee, ADMIN_ID);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /已经结束/);
});

test('学院赛裁判 —— 未派裁判时小场照常由选手录分（零回归）', async () => {
  const { event } = await setupOngoing(['MS']);
  const tie = (await facade.getCollegeTies(event._id))[0];
  const begun = await beginTie(await tieOf(event._id, tie._id));
  const singles = await legMatchOf(begun.tie, 1);

  assert.ok(!singles.referee, '没派人时小场不带裁判');
  const player = singles.teamA[0];
  const byPlayer = await facade.submitMatch({
    id: singles._id,
    scoreA: ['11'],
    scoreB: ['5'],
    actor: player,
  });
  assert.strictEqual(byPlayer.ok, true, byPlayer.firstError);
});

