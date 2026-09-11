const test = require('node:test');
const assert = require('node:assert');

const {
  TAB,
  TAB_LABEL,
  TAB_EMPTY,
  DEFAULT_LIMIT,
  statusTagOf,
  buildRecordRow,
  filterRecords,
  loadMatchView,
} = require('../miniprogram/services/match-view.js');
const { MATCH_STATUS, MATCH_TYPE, ROLE } = require('../miniprogram/utils/constants.js');
const facade = require('../miniprogram/services/index.js');

const ME = 'u06';
const RIVAL = 'u01';

/** 一条待确认的单打记录（字面量，不依赖种子） */
function pendingRecord(overrides = {}) {
  return {
    _id: 'lm0001',
    matchType: MATCH_TYPE.SINGLES,
    pool: 'singles',
    teamA: [ME],
    teamB: [RIVAL],
    scoreA: [11, 9],
    scoreB: [9, 11],
    gamePoints: 11,
    bestOf: 3,
    winner: 'B',
    location: '学校体育馆 1 号场',
    matchTime: '2026-05-01T18:00:00',
    recorder: ME,
    eventId: null,
    status: MATCH_STATUS.PENDING,
    ...overrides,
  };
}

/** 编号 → 昵称，替掉真实的数据源 */
function fakeNameOf(id) {
  return { [ME]: '我', [RIVAL]: '对手' }[id] || id;
}

/** 写操作会动台账，用例前后各复位一次 */
function withCleanStore(fn) {
  return async () => {
    facade.resetCache();
    try {
      await fn();
    } finally {
      facade.resetCache();
    }
  };
}

/* ============================================================
 * 一、纯函数部分
 * ============================================================ */

test('statusTagOf —— 三种状态各自的文案', () => {
  assert.deepStrictEqual(statusTagOf(MATCH_STATUS.PENDING), {
    label: '待确认',
    className: 'is-pending',
  });
  assert.deepStrictEqual(statusTagOf(MATCH_STATUS.ACTIVE), {
    label: '已生效',
    className: 'is-active',
  });
});

test('statusTagOf —— 驳回与撤销共用终态，靠 action 区分文案', () => {
  // 为驳回单开一个枚举值会波及所有「判断是否作废」的地方，
  // 所以终态一样，只让文案不一样
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED, 'reject').label, '已驳回');
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED, 'revoke').label, '已撤销');
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED).label, '已撤销');
  assert.strictEqual(statusTagOf(MATCH_STATUS.REVOKED, 'reject').className, 'is-revoked');
});

test('statusTagOf —— 未知状态不返回 undefined', () => {
  assert.strictEqual(statusTagOf(99).label, '未知状态');
  assert.strictEqual(statusTagOf(99).className, 'is-unknown');
});

test('buildRecordRow —— 赛制按 P3 口径渲染成「11 分制 · 三局两胜」', () => {
  const row = buildRecordRow(pendingRecord(), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.formatText, '11 分制 · 三局两胜');
});

test('buildRecordRow —— 缺赛制字段时 formatText 是空串而不是 undefined', () => {
  // 老数据没有 gamePoints / bestOf，模板靠 wx:if 挡住，
  // 空串能挡住，undefined 也能，但空串不会在页面上留下一截悬空分隔符
  const row = buildRecordRow(pendingRecord({ gamePoints: undefined, bestOf: undefined }), {
    userId: ME,
    nameOf: fakeNameOf,
  });
  assert.strictEqual(row.formatText, '');
});

test('buildRecordRow —— 队名按昵称拼接，空队给「待定」', () => {
  const row = buildRecordRow(pendingRecord({ teamB: [] }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.teamAText, '我');
  assert.strictEqual(row.teamBText, '待定');
});

test('buildRecordRow —— 比分逐局配对展示', () => {
  const row = buildRecordRow(pendingRecord(), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.scoreText, '11:9  9:11');
});

test('buildRecordRow —— 自己是败方时标「负」', () => {
  const row = buildRecordRow(pendingRecord({ winner: 'B' }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.isMine, true);
  assert.strictEqual(row.isWin, false);
  assert.strictEqual(row.resultText, '负');
});

test('buildRecordRow —— 自己是胜方时标「胜」', () => {
  const row = buildRecordRow(pendingRecord({ winner: 'A' }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.isWin, true);
  assert.strictEqual(row.resultText, '胜');
});

test('buildRecordRow —— 旁观者的比赛不标胜负', () => {
  // 看别人的比赛却给人标一个「负」，是很容易忽略的一类错误
  const row = buildRecordRow(pendingRecord(), { userId: 'u99', nameOf: fakeNameOf });
  assert.strictEqual(row.isMine, false);
  assert.strictEqual(row.resultText, '');
  assert.strictEqual(row.isWin, false);
});

test('buildRecordRow —— 尚未分出胜负时不标胜负', () => {
  const row = buildRecordRow(pendingRecord({ winner: null }), { userId: ME, nameOf: fakeNameOf });
  assert.strictEqual(row.resultText, '');
});

test('buildRecordRow —— 录入者本人不能自证，权限只来自演示口径', () => {
  const row = buildRecordRow(pendingRecord(), {
    userId: ME,
    nameOf: fakeNameOf,
    isMock: true,
  });

  // mock 放宽后才可确认，且必须标明这不是真实规则
  assert.strictEqual(row.canConfirm, true);
  assert.strictEqual(row.confirmRelaxed, true);
});

test('buildRecordRow —— 对手确认不属于放宽，不该被打上演示口径', () => {
  const row = buildRecordRow(pendingRecord(), {
    userId: RIVAL,
    nameOf: fakeNameOf,
    isMock: true,
  });

  assert.strictEqual(row.canConfirm, true);
  assert.strictEqual(row.confirmRelaxed, false);
});

test('buildRecordRow —— 严格口径下录入者不能确认', () => {
  const row = buildRecordRow(pendingRecord(), {
    userId: ME,
    nameOf: fakeNameOf,
    isMock: false,
  });

  assert.strictEqual(row.canConfirm, false);
  assert.strictEqual(row.confirmRelaxed, false);
});

test('buildRecordRow —— 已生效的比赛不再提供确认按钮', () => {
  const row = buildRecordRow(pendingRecord({ status: MATCH_STATUS.ACTIVE }), {
    userId: ME,
    nameOf: fakeNameOf,
  });
  assert.strictEqual(row.canConfirm, false);
});

test('buildRecordRow —— 抽签比赛没录分时给「录分」而不是「确认」', () => {
  const row = buildRecordRow(pendingRecord({ scoreA: [], scoreB: [], winner: null }), {
    userId: ME,
    nameOf: fakeNameOf,
    isMock: true,
  });

  assert.strictEqual(row.needsScore, true);
  assert.strictEqual(row.canRecord, true, '参赛者可以录分');
  assert.strictEqual(row.canConfirm, false, '确认要按胜方计分，没比分就无从确认');
});

test('buildRecordRow —— 录分权与写入口径一致：参赛者或管理员', () => {
  const waiting = pendingRecord({ scoreA: [], scoreB: [], winner: null });
  const base = { nameOf: fakeNameOf, isMock: false };

  assert.strictEqual(
    buildRecordRow(waiting, { ...base, userId: ME, role: ROLE.MEMBER }).canRecord,
    true,
    '参赛者'
  );
  assert.strictEqual(
    buildRecordRow(waiting, { ...base, userId: 'u99', role: ROLE.ADMIN }).canRecord,
    true,
    '管理员可以代为录分'
  );
  assert.strictEqual(
    buildRecordRow(waiting, { ...base, userId: 'u99', role: ROLE.MEMBER }).canRecord,
    false,
    '非参赛的普通会员不行'
  );
});

test('buildRecordRow —— 已经有比分的比赛不再给「录分」', () => {
  const row = buildRecordRow(pendingRecord(), { userId: ME, nameOf: fakeNameOf, isMock: true });
  assert.strictEqual(row.needsScore, false);
  assert.strictEqual(row.canRecord, false);
});

test('buildRecordRow —— 撤销权：录入者可撤，管理员可撤，旁人不可撤', () => {
  const base = { userId: ME, nameOf: fakeNameOf, role: ROLE.MEMBER };
  assert.strictEqual(buildRecordRow(pendingRecord(), base).canRevoke, true);

  // 输家不能单方面删掉已确认的败绩来刷分
  assert.strictEqual(
    buildRecordRow(pendingRecord(), { ...base, userId: RIVAL }).canRevoke,
    false
  );
  assert.strictEqual(
    buildRecordRow(pendingRecord(), { ...base, userId: 'u99', role: ROLE.ADMIN }).canRevoke,
    true
  );
});

test('buildRecordRow —— 撤销理由随行带出，界面才显示得出原因', () => {
  const row = buildRecordRow(
    pendingRecord({
      status: MATCH_STATUS.REVOKED,
      action: 'revoke',
      reason: '比分记反了',
    }),
    { userId: ME, nameOf: fakeNameOf }
  );

  assert.strictEqual(row.statusLabel, '已撤销');
  assert.strictEqual(row.statusReason, '比分记反了');
});

test('filterRecords —— 三个标签页各自的筛选口径', () => {
  const mine = pendingRecord({ _id: 'm1' });
  const others = pendingRecord({ _id: 'm2', teamA: ['u01'], teamB: ['u02'], recorder: 'u01' });
  const done = pendingRecord({ _id: 'm3', status: MATCH_STATUS.ACTIVE });
  const list = [mine, others, done];

  assert.deepStrictEqual(
    filterRecords(list, TAB.ALL, ME).map((m) => m._id),
    ['m1', 'm2', 'm3']
  );
  assert.deepStrictEqual(
    filterRecords(list, TAB.MINE, ME).map((m) => m._id),
    ['m1', 'm3']
  );
  // 待确认标签只看「还没生效且我参与」的
  assert.deepStrictEqual(
    filterRecords(list, TAB.PENDING, ME).map((m) => m._id),
    ['m1']
  );
});

test('filterRecords —— 非法输入退回空数组，不抛错', () => {
  assert.deepStrictEqual(filterRecords(null, TAB.ALL, ME), []);
  assert.deepStrictEqual(filterRecords(undefined, TAB.MINE, ME), []);
  // 未知标签按「全部」处理
  assert.deepStrictEqual(filterRecords([pendingRecord()], 'nope', ME).length, 1);
});

/* ============================================================
 * 二、真实模拟数据的端到端部分
 * ============================================================ */

test('loadMatchView —— 查无此人时如实返回 found:false', async () => {
  assert.deepStrictEqual(await loadMatchView({ userId: 'u99' }), { found: false });
});

test('loadMatchView —— 不传 userId 时看的是当前登录会员', async () => {
  const view = await loadMatchView();
  assert.strictEqual(view.found, true);
  assert.strictEqual(view.viewer.userId, ME);
  assert.strictEqual(view.viewer.loggedIn, true);
});

test('loadMatchView —— 访客不会被当成演示会员，权限一概没有', async () => {
  // 页面把全局登录态传进来；传 null 就是访客。若这里自己去问数据源
  // 「当前用户是谁」，mock 永远答 u06，访客会凭空获得确认与撤销权
  const view = await loadMatchView({ user: null });

  assert.strictEqual(view.found, true);
  assert.strictEqual(view.viewer.userId, null);
  assert.strictEqual(view.viewer.loggedIn, false);
  assert.ok(view.records.length > 0, '访客仍可看成绩公示');
  assert.ok(view.records.every((row) => row.canConfirm === false));
  assert.ok(view.records.every((row) => row.canRevoke === false));
  assert.ok(view.records.every((row) => row.isMine === false));
  assert.strictEqual(view.demoNotice, '');
});

test('loadMatchView —— 访客看不到待确认与已撤销的比赛', async () => {
  // 流转中的成绩是临时的，不该进入对外公示口径
  const view = await loadMatchView({ user: null, limit: 5000 });
  assert.ok(view.records.every((row) => row.status === MATCH_STATUS.ACTIVE));
  assert.deepStrictEqual((await loadMatchView({ user: null, tab: TAB.PENDING })).records, []);
  assert.deepStrictEqual((await loadMatchView({ user: null, tab: TAB.MINE })).records, []);
});

test('loadMatchView —— 三个标签里恰好有一个是选中的', async () => {
  const view = await loadMatchView();
  assert.strictEqual(view.tabs.length, Object.keys(TAB).length);

  const active = view.tabs.filter((item) => item.active);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].tab, view.activeTab);
});

test('loadMatchView —— 非法标签退回「全部」，不给空白页', async () => {
  const view = await loadMatchView({ tab: 'nope' });
  assert.strictEqual(view.activeTab, TAB.ALL);
  assert.strictEqual(view.emptyText, TAB_EMPTY[TAB.ALL]);
});

test('loadMatchView —— 顺序与台账一致，且不超过默认上限', async () => {
  const raw = await facade.getMatchRecords();
  const view = await loadMatchView();

  assert.ok(raw.length > 0);
  // 台账是时间倒序，页面这一份必须原样沿用，不能重排
  assert.deepStrictEqual(
    view.records.map((row) => row.matchId),
    raw.slice(0, DEFAULT_LIMIT).map((match) => match._id)
  );
  // total 报的是筛选后的总数，不是这一页的条数——页面据此提示「只显示最近 N 场」
  assert.strictEqual(view.total, raw.length);
  assert.strictEqual(view.hasMore, raw.length > DEFAULT_LIMIT);
});

test('loadMatchView —— 「我参与的」里每一行都确实有我', async () => {
  const view = await loadMatchView({ tab: TAB.MINE });
  assert.ok(view.records.length > 0, '默认会员应当参加过比赛');
  assert.ok(view.records.every((row) => row.isMine));
  assert.ok(view.records.every((row) => row.resultText !== ''), '自己的比赛都该有胜负');
});

test('loadMatchView —— 种子里没有待确认的比赛，待确认标签为空', async () => {
  const view = await loadMatchView({ tab: TAB.PENDING });
  assert.deepStrictEqual(view.records, []);
  assert.strictEqual(view.pendingCount, 0);
  // 没有任何记录来自演示口径，就不该挂出演示提示
  assert.strictEqual(view.demoNotice, '');
});

test('loadMatchView —— 已生效的比赛带出赛制文案', async () => {
  const view = await loadMatchView();
  const withFormat = view.records.filter((row) => row.formatText !== '');
  assert.ok(withFormat.length > 0, '种子比赛都带赛制，应当能渲染出来');
  assert.match(withFormat[0].formatText, /^\d+ 分制 · (一局一胜|三局两胜|五局三胜)$/);
});

test('loadMatchView —— 条数受 limit 限制，并如实报告还有更多', async () => {
  const view = await loadMatchView({ limit: 2 });
  assert.strictEqual(view.records.length, 2);
  assert.strictEqual(view.hasMore, true);

  const all = await loadMatchView({ limit: 5000 });
  assert.strictEqual(all.hasMore, false);
  assert.strictEqual(all.records.length, all.total);
});

test(
  'loadMatchView —— 录一场之后，待确认标签出现它并挂出演示口径提示',
  withCleanStore(async () => {
    const submitted = await facade.submitMatch({
      matchType: MATCH_TYPE.SINGLES,
      teamA: [ME],
      teamB: [RIVAL],
      scoreA: ['11', '11'],
      scoreB: ['9', '7'],
      gamePoints: 11,
      bestOf: 3,
      matchTime: '2026-05-01T18:00:00',
    });
    assert.strictEqual(submitted.ok, true, submitted.firstError);

    const view = await loadMatchView({ tab: TAB.PENDING });
    assert.strictEqual(view.records.length, 1);
    assert.strictEqual(view.pendingCount, 1);

    const [row] = view.records;
    assert.strictEqual(row.statusLabel, '待确认');
    assert.strictEqual(row.canConfirm, true);
    assert.strictEqual(row.confirmRelaxed, true);
    assert.strictEqual(row.formatText, '11 分制 · 三局两胜');
    // 确认权来自 mock 放宽，必须在界面上说清楚
    assert.match(view.demoNotice, /演示/);
  })
);

test(
  'loadMatchView —— 确认后状态变为已生效，且不再可确认',
  withCleanStore(async () => {
    const { match } = await facade.submitMatch({
      matchType: MATCH_TYPE.SINGLES,
      teamA: [ME],
      teamB: [RIVAL],
      scoreA: ['11', '11'],
      scoreB: ['9', '7'],
      gamePoints: 11,
      bestOf: 3,
      // 排在种子最后一场（8 月 22 日）之后，因而必然落在最近一批里，
      // 不受 DEFAULT_LIMIT 截断影响
      matchTime: '2026-09-01T10:00:00',
    });
    await facade.confirmMatch(match._id, RIVAL);

    const view = await loadMatchView({ tab: TAB.MINE });
    const row = view.records.find((item) => item.matchId === match._id);

    assert.ok(row);
    assert.strictEqual(row.statusLabel, '已生效');
    assert.strictEqual(row.canConfirm, false);
    assert.strictEqual(row.resultText, '胜');
  })
);
