/**
 * 学院赛模拟场景 —— 16 进 8 已打完，八进四进行中
 * ============================================================
 * 这不是一条「验证某个函数」的单元测试，而是一份可运行的**场景快照**：
 * 模拟数据源在首次读到学院赛数据时，会按真人操作顺序把一场学院赛推到
 * 指定进度（见 miniprogram/services/college-demo.js），这里断言这个进度
 * 上的关键事实，并把它打印出来，便于人工核对页面该长什么样。
 *
 * 因为场景已经「开机就带着」，本文件不再自己造数据，只负责**验收**这份
 * 默认装好的场景。也因此刻意不调用 resetCache——那会把演示场景关掉
 * （resetCache 是测试专用复位，见 mock.js），本文件要的正是带着场景的
 * 那份数据。
 *
 * 场景设定（与需求一一对应）：
 *   · 赛事正在进行，赛制为团体单败、每场大场两个小项（男单 + 女单）
 *   · 第一轮「16 进 8」已全部打完
 *   · 第二轮「八进四」进行中，已打完三场，只剩一场没开打
 *   · 演示账号 u06「赵明宇」所在的法学院已进八强
 *   · 赵明宇是法学院的负责人，本人不参赛
 *   · 法学院那场八进四还没提交出场名单（大场停在「待排阵」）
 *
 * 怎么看到它：
 *   npm test 会跑到本文件；单独看这一份可以
 *     node --test tests/college-demo.test.js
 *   运行后终端会打印一段场景摘要（见 scenarioText）。
 *
 * 想在小程序模拟器里看同一份场景：直接打开学院赛页/赛事页即可，数据源
 * 会在首次读取时自动装载，无需任何按钮。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const facade = require('../miniprogram/services/index.js');
const {
  ROLE,
  COLLEGE_EVENT_STATUS,
  COLLEGE_EVENT_STATUS_LABEL,
  TIE_STATUS,
  TIE_STATUS_LABEL,
  LEG_DISCIPLINE,
  LEG_DISCIPLINE_LABEL,
} = require('../miniprogram/utils/constants.js');
const { canManageCollegeEvent } = require('../miniprogram/services/college-event.js');
const { canSubmitLineup } = require('../miniprogram/services/college-lineup.js');
// 视图模型不在数据源门面上（门面只透传 mock 的函数），要从 college-view 直接取
const { loadCollegeLineupView } = require('../miniprogram/services/college-view.js');

/** 演示账号：赵明宇，本场被任命为法学院负责人 */
const LEADER_ID = 'u06';
const LAW_COLLEGE = '法学院';
/** 演示赛事的标题，用来在列表里认出这一场 */
const DEMO_TITLE = '2026 院际匹克球团体赛';

/* ============================================================
 * 取场景（数据源已自动装好，这里只把它读出来）
 * ============================================================ */

let demoPromise = null;

/** 读出默认装好的演示场景；整个文件共用一份 */
function demo() {
  if (!demoPromise) demoPromise = loadDemo();
  return demoPromise;
}

async function loadDemo() {
  const events = await facade.getCollegeEvents();
  const event = events.find((item) => item.title === DEMO_TITLE);
  assert.ok(event, `数据源里应当带着演示学院赛「${DEMO_TITLE}」`);

  const entries = await facade.getCollegeEntries(event._id);
  const ties = await facade.getCollegeTies(event._id);
  const round1 = ties.filter((tie) => Number(tie.round) === 1);
  const round2 = ties.filter((tie) => Number(tie.round) === 2);
  const lawTie = round2.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );

  return { event, entries, ties, round1, round2, lawTie };
}

/* ============================================================
 * 打印：把场景摊成一段人话
 * ============================================================ */

/** 大场状态文案（进行中的大场按存储状态读，不用再推一遍） */
function statusTextOf(tie) {
  if (tie.status === TIE_STATUS.FINISHED) return '已结束';
  if (tie.status === TIE_STATUS.ONGOING) return '进行中';
  if (tie.status === TIE_STATUS.READY) return '待开赛（双方已排阵）';
  return TIE_STATUS_LABEL[TIE_STATUS.PENDING_LINEUP];
}

function tieLine(tie, mark = '') {
  const result = tie.winner ? `，${tie.winner} 晋级` : '';
  return `  · ${tie.collegeA} vs ${tie.collegeB} —— ${statusTextOf(tie)}${result}${mark}`;
}

/** 生成场景摘要文本 */
async function scenarioText({ event, entries, round1, round2, lawTie }) {
  const lawEntry = entries.find((entry) => entry.college === LAW_COLLEGE);
  const leader = await facade.getMember(LEADER_ID);
  const byId = new Map((await facade.getMembers()).map((member) => [member._id, member]));
  const nameOf = (id) => {
    const member = byId.get(id);
    return member ? member.nickName || member.realName || id : id;
  };
  const opponent = lawTie.collegeA === LAW_COLLEGE ? lawTie.collegeB : lawTie.collegeA;
  const ownRound1 = round1.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );

  const lines = [];
  lines.push('');
  lines.push('════════════ 学院赛模拟场景 ════════════');
  lines.push(`赛事：${event.title}`);
  lines.push(
    `状态：${COLLEGE_EVENT_STATUS_LABEL[event.status]}　` +
      `小项：${event.legPlan.map((item) => LEG_DISCIPLINE_LABEL[item]).join(' · ')}　` +
      `参赛学院：${entries.length} 所`
  );
  lines.push('');
  lines.push(`【第一轮 · 16 进 8】已全部打完（${round1.length} 场）`);
  if (ownRound1) lines.push(tieLine(ownRound1, '　← 法学院在这一场'));
  lines.push('');
  lines.push(`【第二轮 · 八进四】进行中（${round2.length} 场）`);
  for (const tie of round2) {
    lines.push(tieLine(tie, tie._id === lawTie._id ? '　← 还没开打' : ''));
  }
  lines.push('');
  lines.push(`【法学院视角】${leader.nickName}（${leader.realName} / ${leader._id}）`);
  lines.push(
    `  身份：${lawEntry ? LAW_COLLEGE : ''}负责人（${leader.role === ROLE.STAFF ? '学院负责人' : '非学院负责人'}）　` +
      `是否参赛：否（不在法学院名单内）`
  );
  lines.push(
    `  法学院参赛名单：${lawEntry.members.map(nameOf).join('、')}（共 ${lawEntry.members.length} 人）`
  );
  lines.push(`  八进四对手：${opponent}`);
  lines.push(
    `  本场排阵：尚未提交（大场状态「${statusTextOf(lawTie)}」；排阵页会沿用上一轮人选作默认）`
  );
  lines.push('════════════════════════════════════════');
  lines.push('');
  return lines.join('\n');
}

/* ============================================================
 * 用例
 * ============================================================ */

test('学院赛模拟场景 —— 16 进 8 已打完、八进四进行中，法学院进八强待排阵', async () => {
  const state = await demo();
  const { event, entries, ties, round1, round2, lawTie } = state;

  // ---- 赛事整体 ----
  assert.strictEqual(event.status, COLLEGE_EVENT_STATUS.ONGOING, '赛事应当进行中');
  assert.deepStrictEqual(event.legPlan, [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS]);

  // ---- 16 进 8 已结束 ----
  assert.strictEqual(round1.length, 8);
  for (const tie of round1) {
    assert.strictEqual(tie.status, TIE_STATUS.FINISHED, `${tie.collegeA}/${tie.collegeB} 应已结束`);
    assert.ok(tie.winner, '已结束的大场必须有胜者');
  }
  const lawRound1 = round1.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );
  assert.ok(lawRound1, '法学院打过首轮');
  assert.strictEqual(lawRound1.winner, LAW_COLLEGE, '法学院赢下 16 进 8');

  // ---- 八进四进行中：三场打完，法学院那场待排阵 ----
  assert.ok(lawTie, '法学院应当晋级八强');
  assert.strictEqual(round2.length, 4);
  const finishedRound2 = round2.filter((tie) => tie.status === TIE_STATUS.FINISHED);
  assert.strictEqual(finishedRound2.length, 3, '八进四已打完三场');
  assert.strictEqual(lawTie.status, TIE_STATUS.PENDING_LINEUP, '法学院这场还没排阵');
  assert.strictEqual(lawTie.lineupA, false, 'A 方未交名单');
  assert.strictEqual(lawTie.lineupB, false, 'B 方未交名单');

  // 这场大场名下一条排阵记录都没有
  const lineups = await facade.getCollegeLineups(event._id);
  assert.strictEqual(
    lineups.filter((item) => item.tieId === lawTie._id).length,
    0,
    '法学院这场没有任何排阵记录'
  );

  // 本轮没打完，不该冒出半决赛
  assert.strictEqual(
    ties.filter((tie) => Number(tie.round) === 3).length,
    0,
    '八进四没打完不排半决赛'
  );

  // ---- 16 所学院都交了名单 ----
  assert.strictEqual(entries.length, 16, '应当正好 16 所学院参赛');

  // ---- 赵明宇：法学院负责人，且不参赛 ----
  const leader = await facade.getMember(LEADER_ID);
  assert.strictEqual(leader.nickName, '明宇');
  assert.strictEqual(leader.realName, '赵明宇');
  assert.strictEqual(leader.role, ROLE.STAFF, '赵明宇是学院负责人');
  assert.strictEqual(leader.college, LAW_COLLEGE);

  const lawEntry = entries.find((entry) => entry.college === LAW_COLLEGE);
  assert.ok(lawEntry, '法学院交了名单');
  assert.ok(!lawEntry.members.includes(LEADER_ID), '学院负责人本人不在参赛名单里');

  // 打印场景，便于人工核对
  console.log(await scenarioText(state));
});

test('学院赛模拟场景 —— 学院负责人能替本学院排八进四，但发布与开赛仍归管理员', async () => {
  const { event, lawTie } = await demo();
  const leader = await facade.getMember(LEADER_ID);

  // 学院负责人能替法学院交这场八进四的排阵
  assert.strictEqual(
    canSubmitLineup(lawTie, leader, { college: LAW_COLLEGE, event }),
    true,
    '学院负责人可以替本学院排阵'
  );

  // 但发布学院赛 / 抽签 / 开始大场这些规则性操作只归管理员
  assert.strictEqual(canManageCollegeEvent(leader), false, '学院负责人不能管理学院赛');
  const refuseStart = await facade.startTie(lawTie._id, LEADER_ID);
  assert.strictEqual(refuseStart.ok, false, '学院负责人开不了大场');
  assert.match(refuseStart.message, /管理员|排阵/);

  // 排阵页视图：站在赵明宇的视角看，这场是可以提交的，且还没排人
  const view = await loadCollegeLineupView(lawTie._id, {
    user: leader,
    eventId: event._id,
  });
  assert.strictEqual(view.found, true);
  assert.strictEqual(view.canSubmit, true, `排阵页应当可提交：${view.blockReason}`);
  assert.strictEqual(view.blockReason, '');
  assert.strictEqual(view.hasLineup, false, '本场尚未提交过排阵');
  assert.strictEqual(view.statusLabel, TIE_STATUS_LABEL[TIE_STATUS.PENDING_LINEUP]);
  assert.strictEqual(view.rosterCount, 2, '法学院名单是孙悦 + 补入的男队员（男单要有男的可派）');
  // 本场确实没交过排阵（hasLineup 为 false），但页面会把上一轮的人沿用成默认值，
  // 所以每个小项显示的是上一轮那位队员，而不是「未排人」——排阵页正是靠这个
  // 让学院负责人少点几下。想让场景停在「一个人都没排」，得让她上一轮也没上过。
  assert.match(view.carryHint, /沿用/, '页面提示已沿用上一轮排阵');
  assert.ok(view.legs.length > 0);
  for (const leg of view.legs) {
    assert.notStrictEqual(leg.pickedText, '未排人', '已沿用上一轮人选');
    assert.ok(leg.pickedText.length > 0, `第 ${leg.legNo} 项列出了沿用的人选`);
  }
});
