const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../miniprogram/services/match-store.js');
const { MATCH_STATUS } = require('../miniprogram/utils/constants.js');

/** 台账是模块级状态，每条用例都从干净的一页开始 */
beforeEach(() => store.reset());

/** 一份最小的比赛草稿 */
function draft(overrides = {}) {
  return {
    matchType: 1,
    pool: 'singles',
    teamA: ['u01'],
    teamB: ['u02'],
    scoreA: [11, 11],
    scoreB: [9, 7],
    gamePoints: 11,
    bestOf: 3,
    winner: 'A',
    matchTime: new Date('2026-05-01T18:00:00'),
    recorder: 'u01',
    eventId: null,
    ...overrides,
  };
}

test('addMatch —— 第一场编号是 lm0001，状态强制待确认', () => {
  const record = store.addMatch(draft());

  assert.strictEqual(record._id, 'lm0001');
  // 草稿里就算写了已生效也不能当真：录完就生效等于自己给自己盖章
  assert.strictEqual(record.status, MATCH_STATUS.PENDING);
  assert.strictEqual(store.addMatch(draft())._id, 'lm0002');
});

test('addMatch —— 即使草稿自带 status 也会被改写成待确认', () => {
  const record = store.addMatch(draft({ status: MATCH_STATUS.ACTIVE }));
  assert.strictEqual(record.status, MATCH_STATUS.PENDING);
});

test('addMatch —— 不就地修改传入的草稿', () => {
  const source = draft();
  store.addMatch(source);

  assert.strictEqual(source._id, undefined, '不该往调用方的对象上塞 _id');
  assert.strictEqual(source.status, undefined);
});

test('addMatch —— 返回的是副本，改它动不到台账', () => {
  const record = store.addMatch(draft());
  record.status = MATCH_STATUS.ACTIVE;
  record.teamA.push('u99');

  const [stored] = store.listSubmitted();
  assert.strictEqual(stored.status, MATCH_STATUS.PENDING);
  assert.deepStrictEqual(stored.teamA, ['u01']);
});

test('saveMatch —— 用自带的编号入账，状态同样是待确认', () => {
  const record = store.saveMatch(draft({ _id: 'x_e9_r1_main_0' }));
  assert.strictEqual(record._id, 'x_e9_r1_main_0');
  assert.strictEqual(record.status, MATCH_STATUS.PENDING);
});

test('saveMatch —— 同一编号再写一次是覆盖，不是追加（重抽换人不换签位）', () => {
  store.saveMatch(draft({ _id: 'x_e9_r1_main_0', teamA: ['u01'], teamB: ['u02'] }));
  store.saveMatch(draft({ _id: 'x_e9_r1_main_0', teamA: ['u03'], teamB: ['u04'] }));

  const list = store.listSubmitted();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].teamA, ['u03']);
  assert.deepStrictEqual(list[0].teamB, ['u04']);
});

test('saveMatch —— 覆盖时把比分清掉，重抽后的对阵是干净的', () => {
  store.saveMatch(draft({ _id: 'x_e9_r1_main_0', scoreA: [11], scoreB: [9] }));
  store.saveMatch(draft({ _id: 'x_e9_r1_main_0', scoreA: [], scoreB: [], winner: null }));

  const [stored] = store.listSubmitted();
  assert.deepStrictEqual(stored.scoreA, []);
  assert.deepStrictEqual(stored.scoreB, []);
  assert.strictEqual(stored.winner, null);
});

test('saveMatch —— 覆盖时清掉旧改判，重抽后不会仍被盖成「已撤销」', () => {
  // 抽签 → 这一场被撤销 → 重抽。编号是确定的，重抽落到同一个 _id 上。
  // 若覆盖时不清改判，旧的那条 REVOKED 会被 buildCache 重新盖回来，
  // 这一场就永远录不了分，重抽多少次都解不开。
  store.saveMatch(draft({ _id: 'x_e9_r1_main_0' }));
  store.setStatus('x_e9_r1_main_0', {
    status: MATCH_STATUS.REVOKED,
    action: 'revoke',
    reason: '录错了',
  });

  store.saveMatch(draft({ _id: 'x_e9_r1_main_0', teamA: ['u03'], teamB: ['u04'] }));

  assert.strictEqual(store.overrideOf('x_e9_r1_main_0'), null, '旧改判应随覆盖作废');
});

test('listSubmitted —— 返回副本，外部改不动内部', () => {
  store.addMatch(draft());

  const list = store.listSubmitted();
  list[0].status = MATCH_STATUS.REVOKED;
  list.push({ _id: 'fake' });

  assert.strictEqual(store.listSubmitted().length, 1);
  assert.strictEqual(store.listSubmitted()[0].status, MATCH_STATUS.PENDING);
});

test('overrideOf —— 没有改判时返回 null', () => {
  assert.strictEqual(store.overrideOf('lm0001'), null);
  assert.strictEqual(store.overrideOf('m0007'), null);
});

test('setStatus —— 写入改判并能读回来', () => {
  store.setStatus('lm0001', {
    status: MATCH_STATUS.ACTIVE,
    action: 'confirm',
    actor: 'u03',
    actedAt: '2026-05-02T10:00:00',
  });

  const patch = store.overrideOf('lm0001');
  assert.strictEqual(patch.status, MATCH_STATUS.ACTIVE);
  assert.strictEqual(patch.action, 'confirm');
  assert.strictEqual(patch.actor, 'u03');
});

test('setStatus —— 多次改判合并且以最后一次为准', () => {
  // 先驳回再撤销，第二次不该把第一次的字段整片抹掉
  store.setStatus('m0007', { status: MATCH_STATUS.REVOKED, action: 'reject', reason: '比分不对' });
  store.setStatus('m0007', { status: MATCH_STATUS.ACTIVE, action: 'confirm', actor: 'u03' });

  const patch = store.overrideOf('m0007');
  assert.strictEqual(patch.status, MATCH_STATUS.ACTIVE);
  assert.strictEqual(patch.action, 'confirm');
  assert.strictEqual(patch.actor, 'u03');
});

test('overrideOf —— 返回副本，改它动不到台账', () => {
  store.setStatus('m0007', { status: MATCH_STATUS.REVOKED, reason: '比分不对' });

  const patch = store.overrideOf('m0007');
  patch.status = MATCH_STATUS.ACTIVE;
  patch.reason = '被改掉了';

  assert.strictEqual(store.overrideOf('m0007').status, MATCH_STATUS.REVOKED);
  assert.strictEqual(store.overrideOf('m0007').reason, '比分不对');
});

test('reset —— 清空新增与改判，并把编号复位', () => {
  store.addMatch(draft());
  store.setStatus('m0007', { status: MATCH_STATUS.REVOKED, reason: '比分不对' });

  store.reset();

  assert.deepStrictEqual(store.listSubmitted(), []);
  assert.strictEqual(store.overrideOf('m0007'), null);
  // 序号也要复位，否则测试里「第一场是 lm0001」的断言会随执行顺序飘移
  assert.strictEqual(store.addMatch(draft())._id, 'lm0001');
});
