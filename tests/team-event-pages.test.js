/**
 * 团队赛事两页的装配测试（team-event-list / team-event-detail）
 * ============================================================
 * 后端（team-event-service）已由 tests/team-event.test.js 覆盖到全流程。
 * 这里守的是界面这一层：动作接到哪个接口、带什么参数、失败时给什么话、
 * 轮次标题算得对不对。
 *
 * 与 team-pages.test.js 共用 tests/helpers/page-harness.js 的工装。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi, withWx } = require('./helpers/page-harness.js');

const EVENT = {
  eventId: 'tev_1',
  name: '秋季联赛',
  format: 'single_elim',
  status: 'locked',
  statusLabel: '名单已锁定',
  rulesText: '4 节 × 10 分钟 · 个人 5 犯离场 · 全队每节第 5 犯起罚球 · 加时 5 分钟',
  rules: { presetKey: 'fiba-4x10' },
  entryCount: 4,
  canManage: true,
  createdAt: '2026-10-19T10:00:00.000Z',
};

function matchOf(round, slot, extra = {}) {
  return {
    matchId: `x_tev_1_r${round}_main_${slot}`,
    round,
    stage: 'main',
    slot,
    teamA: `tm_${round}${slot}a`,
    teamB: `tm_${round}${slot}b`,
    teamAName: `甲队${round}${slot}`,
    teamBName: `乙队${round}${slot}`,
    scoreA: null,
    scoreB: null,
    scoreText: '—',
    overtime: false,
    forfeit: null,
    winner: null,
    status: 'scheduled',
    statusLabel: '未开赛',
    canRecord: true,
    canPublish: true,
    ...extra,
  };
}

/* ============================================================
 * team-event-list
 * ============================================================ */

test('赛事列表 —— 首屏取列表，空态与可建赛标记落到 data', () => withApi({
  listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.events, []);
  assert.equal(page.data.canManage, true);
  assert.equal(calls[0][0], 'listTeamEvents');
}));

test('赛事列表 —— 建赛带上赛制与规则预设，成功后收起表单并刷新', () => withApi({
  listTeamEvents: () => ({ ok: true, events: [EVENT], canManage: true }),
  createTeamEvent: () => ({ ok: true, eventId: 'tev_1' }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await page.onLoad();

  page.onOpenCreate();
  page.onInputName({ detail: { value: '秋季联赛' } });
  page.onPickFormat({ detail: { value: 1 } }); // 循环赛
  page.onPickPreset({ detail: { value: 1 } }); // 校园 2×20
  await page.onSubmitCreate();

  const created = calls.find(call => call[0] === 'createTeamEvent');
  assert.equal(created[1].name, '秋季联赛');
  assert.equal(created[1].format, 'round_robin');
  assert.equal(created[1].presetKey, 'campus-2x20');
  assert.match(created[1].requestId, /^tev_/, '请求编号由页面生成');
  assert.equal(page.data.creating, false);
  assert.match(page.data.notice, /报名/);
  assert.equal(calls.filter(call => call[0] === 'listTeamEvents').length, 2, '建完要刷新列表');
}));

test('赛事列表 —— 建赛失败把服务端原话留在页面上，表单不收起', () => withApi({
  listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
  createTeamEvent: () => ({ ok: false, message: '同协会已有同名赛事' }),
}, async () => {
  const page = instantiate(loadPage('team-event-list/team-event-list.js'));
  await page.onLoad();

  page.onOpenCreate();
  page.onInputName({ detail: { value: '秋季联赛' } });
  await page.onSubmitCreate();

  assert.equal(page.data.creating, true, '失败不能把用户填的东西收掉');
  assert.equal(page.data.notice, '同协会已有同名赛事');
  assert.equal(page.data.noticeError, true);
}));

test('赛事列表 —— 点一行打开详情', async () => {
  await withApi({
    listTeamEvents: () => ({ ok: true, events: [EVENT], canManage: false }),
  }, async () => {
    await withWx(async ({ navigations }) => {
      const page = instantiate(loadPage('team-event-list/team-event-list.js'));
      await page.onLoad();
      page.onOpenEvent({ currentTarget: { dataset: { eventid: 'tev_1' } } });
      assert.match(navigations[0], /team-event-detail\?eventId=tev_1/);
    });
  });
});

/* ============================================================
 * team-event-detail
 * ============================================================ */

/** 一份四队淘汰赛的详情：两场半决赛 + 一场决赛 */
function detailFixture(overrides = {}) {
  return {
    ok: true,
    event: EVENT,
    entries: [
      {
        teamId: 'tm_a', teamName: '热浪队', status: 'locked', statusLabel: '已锁定', rosterCount: 6, placement: null,
      },
      {
        teamId: 'tm_b', teamName: '闪电队', status: 'submitted', statusLabel: '待审核', rosterCount: 5, placement: null,
      },
    ],
    matches: [
      matchOf(1, 0),
      matchOf(1, 1),
      matchOf(2, 0),
    ],
    table: [],
    placements: [],
    ...overrides,
  };
}

test('赛事详情 —— 按轮次分组，四队签表的第 1 轮叫半决赛、第 2 轮叫决赛', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'scheduled', draw: { size: 4 } },
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.rounds.map(round => round.label), ['半决赛', '决赛']);
  assert.equal(page.data.rounds[0].matches.length, 2);
  assert.equal(page.data.rounds[1].matches.length, 1);
}));

test('赛事详情 —— 缺少赛事编号时给一句人话，不发请求', () => withApi({}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({});

  assert.equal(page.data.loading, false);
  assert.match(page.data.error, /缺少赛事编号/);
  assert.equal(calls.length, 0);
}));

test('赛事详情 —— 报名审核与锁定名单接的是对应接口', () => withApi({
  getTeamEvent: () => detailFixture({ event: { ...EVENT, status: 'registration' } }),
  reviewTeamEntry: () => ({ ok: true }),
  lockTeamEntries: () => ({ ok: true, locked: 2 }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onApproveEntry({ currentTarget: { dataset: { teamid: 'tm_b' } } });
  const approved = calls.find(call => call[0] === 'reviewTeamEntry');
  assert.deepEqual(approved[1], { eventId: 'tev_1', teamId: 'tm_b', approve: true });

  await page.onRejectEntry({ currentTarget: { dataset: { teamid: 'tm_b' } } });
  const rejected = calls.filter(call => call[0] === 'reviewTeamEntry')[1];
  assert.equal(rejected[1].approve, false);

  await page.onLock();
  assert.equal(calls.filter(call => call[0] === 'lockTeamEntries').length, 1);
}));

test('赛事详情 —— 抽签、排下一轮、结算都带赛事编号', () => withApi({
  getTeamEvent: () => detailFixture(),
  drawTeamEvent: () => ({ ok: true, matchCount: 2 }),
  advanceTeamRound: () => ({ ok: true, matchCount: 1 }),
  settleTeamEvent: () => ({ ok: true, placements: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onDraw();
  await page.onAdvance();
  await page.onSettle();

  ['drawTeamEvent', 'advanceTeamRound', 'settleTeamEvent'].forEach((name) => {
    const call = calls.find(item => item[0] === name);
    assert.ok(call, `${name} 没被调用`);
    assert.equal(call[1].eventId, 'tev_1');
  });
}));

test('赛事详情 —— 录分浮层带上对阵，提交把两个比分传成数字语义的字符串', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: true, warnings: [] }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  assert.ok(page.data.recording, '应当打开浮层');
  assert.equal(page.data.recording.teamAName, '甲队10');
  assert.equal(page.data.scoreA, '', '没录过分的比赛不该预填 0');

  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '86' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '80' } });
  page.onToggleOvertime({ detail: { value: true } });
  await page.onSubmitScore();

  const recorded = calls.find(call => call[0] === 'recordTeamMatch');
  assert.equal(recorded[1].matchId, 'x_tev_1_r1_main_0');
  assert.equal(recorded[1].scoreA, '86');
  assert.equal(recorded[1].scoreB, '80');
  assert.equal(recorded[1].overtime, true);
  assert.equal(page.data.recording, null, '提交成功后浮层收起');
}));

test('赛事详情 —— 服务端提醒（个人合计与球队得分不符）显示出来而不是吞掉', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: true, warnings: ['个人得分合计 58，球队 60，差 2 分待归属'] }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '60' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '58' } });
  await page.onSubmitScore();

  assert.match(page.data.notice, /差 2 分待归属/);
  assert.equal(page.data.noticeError, false, '这是提醒，不是错误');
}));

test('赛事详情 —— 录分失败时浮层不收起，把原因留在页面上', () => withApi({
  getTeamEvent: () => detailFixture(),
  recordTeamMatch: () => ({ ok: false, message: '篮球不允许平局，请打加时后再录' }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  page.onOpenRecord({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  page.onInputScore({ currentTarget: { dataset: { side: 'A' } }, detail: { value: '80' } });
  page.onInputScore({ currentTarget: { dataset: { side: 'B' } }, detail: { value: '80' } });
  await page.onSubmitScore();

  assert.ok(page.data.recording, '失败别把浮层关掉，用户还得改比分');
  assert.match(page.data.notice, /平局/);
  assert.equal(page.data.noticeError, true);
}));

test('赛事详情 —— 发布与驳回带 approve 标记', () => withApi({
  getTeamEvent: () => detailFixture({
    matches: [matchOf(1, 0, { status: 'reviewing', statusLabel: '待审核', scoreA: 86, scoreB: 80, scoreText: '86 : 80' })],
  }),
  publishTeamMatch: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  await page.onPublish({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });
  await page.onRejectScore({ currentTarget: { dataset: { matchid: 'x_tev_1_r1_main_0' } } });

  const callsPublish = calls.filter(call => call[0] === 'publishTeamMatch');
  assert.equal(callsPublish[0][1].approve, true);
  assert.equal(callsPublish[1][1].approve, false);
}));

test('赛事详情 —— 已结算的赛事展示名次与积分表', () => withApi({
  getTeamEvent: () => detailFixture({
    event: { ...EVENT, status: 'finished', statusLabel: '已结束' },
    table: [
      {
        rank: 1, teamId: 'tm_a', teamName: '热浪队', played: 2, wins: 2, losses: 0, diff: 12,
      },
    ],
    placements: [
      { rank: 1, teamId: 'tm_a', teamName: '热浪队', note: '冠军' },
      { rank: 2, teamId: 'tm_c', teamName: '磐石队', note: '亚军' },
    ],
  }),
}, async () => {
  const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
  await page.onLoad({ eventId: 'tev_1' });

  assert.equal(page.data.placements.length, 2);
  assert.equal(page.data.placements[0].note, '冠军');
  assert.equal(page.data.table[0].diff, 12);
}));
