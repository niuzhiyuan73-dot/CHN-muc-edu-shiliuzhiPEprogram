const test = require('node:test');
const assert = require('node:assert');

const {
  sideOf,
  isParticipant,
  isRecorder,
  canConfirm,
  canRevoke,
  normalizeScores,
  buildMatchRecord,
} = require('../miniprogram/services/match-record.js');
const { MATCH_TYPE, MATCH_STATUS, ROLE } = require('../miniprogram/utils/constants.js');

/* ============================================================
 * 一、位置与身份
 * ============================================================ */

const DOUBLES = {
  _id: 'm1',
  matchType: MATCH_TYPE.DOUBLES,
  teamA: ['u01', 'u02'],
  teamB: ['u03', 'u04'],
  recorder: 'u01',
  status: MATCH_STATUS.PENDING,
};

test('sideOf —— 分辨站在 A 队、B 队还是没上场', () => {
  assert.strictEqual(sideOf(DOUBLES, 'u02'), 'A');
  assert.strictEqual(sideOf(DOUBLES, 'u03'), 'B');
  assert.strictEqual(sideOf(DOUBLES, 'u99'), null);
  assert.strictEqual(sideOf(null, 'u01'), null);
  assert.strictEqual(sideOf(DOUBLES, ''), null);
});

test('isParticipant / isRecorder —— 参赛与录入是两回事', () => {
  assert.strictEqual(isParticipant(DOUBLES, 'u04'), true);
  assert.strictEqual(isParticipant(DOUBLES, 'u99'), false);

  assert.strictEqual(isRecorder(DOUBLES, 'u01'), true);
  // 搭档在场上，但不是他录的
  assert.strictEqual(isRecorder(DOUBLES, 'u02'), false);
  assert.strictEqual(isRecorder(DOUBLES, 'u03'), false);
});

/* ============================================================
 * 二、确认权
 * ============================================================ */

test('canConfirm —— 对手方可以确认', () => {
  assert.strictEqual(canConfirm(DOUBLES, 'u03'), true);
  assert.strictEqual(canConfirm(DOUBLES, 'u04'), true);
});

test('canConfirm —— 录入方不能自己给自己盖章', () => {
  // 这是防刷分的第一道闸门：能自证的话，一个人就能凭空造出一场胜利
  assert.strictEqual(canConfirm(DOUBLES, 'u01'), false);
  // 录的人是对手，自己站在录入者对面，则可以确认
  assert.strictEqual(canConfirm(DOUBLES, 'u03'), true);
});

test('canConfirm —— 没上场的人、已生效或已撤销的都免谈', () => {
  assert.strictEqual(canConfirm(DOUBLES, 'u99'), false);
  assert.strictEqual(canConfirm({ ...DOUBLES, status: MATCH_STATUS.ACTIVE }, 'u03'), false);
  assert.strictEqual(canConfirm({ ...DOUBLES, status: MATCH_STATUS.REVOKED }, 'u03'), false);
  assert.strictEqual(canConfirm(null, 'u03'), false);
});

test('canConfirm —— mock 单账号下放宽为「参与即可」，并能看出这是放宽来的', () => {
  // 本地演示只有一个账号，严格按对手确认的话没有任何一场能确认成功
  assert.strictEqual(canConfirm(DOUBLES, 'u01', { isMock: true }), true);
  // 但没上场的人仍然不行，放宽不是放水
  assert.strictEqual(canConfirm(DOUBLES, 'u99', { isMock: true }), false);
});

test('canConfirm —— 录入者不在场上时不做额外限制', () => {
  const orphan = { ...DOUBLES, recorder: 'u99' };
  assert.strictEqual(canConfirm(orphan, 'u01'), true);
});

/* ============================================================
 * 三、撤销权
 * ============================================================ */

test('canRevoke —— 管理员可以撤任意一场', () => {
  assert.strictEqual(canRevoke(DOUBLES, 'u03', { role: ROLE.ADMIN }), true);
  assert.strictEqual(canRevoke(DOUBLES, 'u99', { role: ROLE.ADMIN }), true);
});

test('canRevoke —— 普通会员只能撤自己录的', () => {
  // 挡的是「输家删掉自己的败绩来刷分」
  assert.strictEqual(canRevoke(DOUBLES, 'u01', { role: ROLE.MEMBER }), true);
  assert.strictEqual(canRevoke(DOUBLES, 'u03', { role: ROLE.MEMBER }), false);
  assert.strictEqual(canRevoke(DOUBLES, 'u01'), true, '角色缺省即普通会员');
  assert.strictEqual(canRevoke(null, 'u01'), false);
});

/* ============================================================
 * 四、比分整理
 * ============================================================ */

test('normalizeScores —— 去掉尾部空行，转成数字', () => {
  // 三局两胜渲染三行，一局一胜的人只会填第一行
  assert.deepStrictEqual(normalizeScores(['11', '9', '', '']), [11, 9]);
  assert.deepStrictEqual(normalizeScores(['11', ' 9 ']), [11, 9]);
  assert.deepStrictEqual(normalizeScores([11, 9]), [11, 9]);
  assert.deepStrictEqual(normalizeScores(['', '', '']), []);
  assert.deepStrictEqual(normalizeScores(null), []);
});

test('normalizeScores —— 中间的空行保留成 null，不被悄悄跳过', () => {
  // 跳过的话，多录的一局会被挤掉，比分与赛制就对不上了
  assert.deepStrictEqual(normalizeScores(['11', '', '11']), [11, null, 11]);
});

test('normalizeScores —— 非数字变成 NaN（而不是 0）', () => {
  // 当成 0 的话，「11:0」和「没填」在数据里长得一模一样
  const result = normalizeScores(['11', 'abc']);
  assert.strictEqual(result[0], 11);
  assert.ok(Number.isNaN(result[1]));
});

/* ============================================================
 * 五、录入校验
 * ============================================================ */

const NOW = '2026-05-10T00:00:00';
const MIN = '2026-04-06T00:00:00';

/** 一份合法的单打录入参数 */
function singlesParams(overrides = {}) {
  return {
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u01'],
    teamB: ['u02'],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    matchTime: '2026-05-01T18:00:00',
    location: '学校体育馆 1 号场',
    ...overrides,
  };
}

test('buildMatchRecord —— 合法单打能组装出完整记录', () => {
  const result = buildMatchRecord(singlesParams(), { now: NOW, minMatchTime: MIN });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.firstError, '');
  assert.deepStrictEqual(result.scoreErrors, []);

  const record = result.record;
  assert.strictEqual(record.matchType, MATCH_TYPE.SINGLES);
  // 池漏了会被 getMatches({ pool }) 静默过滤掉，录进去却查不到
  assert.strictEqual(record.pool, 'singles');
  assert.deepStrictEqual(record.scoreA, [11, 11]);
  assert.deepStrictEqual(record.scoreB, [9, 7]);
  assert.strictEqual(record.gamePoints, 11);
  assert.strictEqual(record.bestOf, 3);
  assert.strictEqual(record.winner, 'A');
  assert.strictEqual(record.recorder, 'u01', '录入者默认是 A 队第一位');
  assert.strictEqual(record.eventId, null, '赛事成绩不由这里录入');
});

test('buildMatchRecord —— 胜负由比分推出，不接受外部指定', () => {
  const bWins = buildMatchRecord(
    singlesParams({ scoreA: ['9', '7'], scoreB: ['11', '11'] }),
    { now: NOW, minMatchTime: MIN }
  );
  assert.strictEqual(bWins.record.winner, 'B');
});

test('buildMatchRecord —— 双打两两配对合法', () => {
  const result = buildMatchRecord(
    {
      matchType: MATCH_TYPE.DOUBLES,
      teamA: ['u01', 'u02'],
      teamB: ['u03', 'u04'],
      scoreA: ['11'],
      scoreB: ['9'],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
    },
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.record.pool, 'doubles');
  assert.strictEqual(result.record.recorder, 'u01');
});

test('buildMatchRecord —— 双打少一个人要被拦下', () => {
  const result = buildMatchRecord(
    {
      matchType: MATCH_TYPE.DOUBLES,
      teamA: ['u01'],
      teamB: ['u03', 'u04'],
      scoreA: ['11'],
      scoreB: ['9'],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
    },
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamA, /双打每队需要 2 位会员/);
  assert.strictEqual(result.firstError, result.errors.teamA);
});

test('buildMatchRecord —— 一个人不能同时出现在两队', () => {
  const result = buildMatchRecord(
    singlesParams({ teamB: ['u01'] }),
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamB, /不能同时出现在两队/);
});

test('buildMatchRecord —— 同一队里不能有重复的人', () => {
  const result = buildMatchRecord(
    {
      matchType: MATCH_TYPE.DOUBLES,
      teamA: ['u01', 'u01'],
      teamB: ['u03', 'u04'],
      scoreA: ['11'],
      scoreB: ['9'],
      gamePoints: 11,
      bestOf: 1,
      matchTime: '2026-05-01T18:00:00',
    },
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamA, /不能重复/);
});

test('buildMatchRecord —— 传了名单时校验参赛者都在名单里', () => {
  // 本地注册账号不在种子里，回放时会直接抛错，所以必须在这里先拦住
  const result = buildMatchRecord(singlesParams(), {
    now: NOW,
    minMatchTime: MIN,
    members: [{ _id: 'u01' }, { _id: 'u99' }],
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.teamB, /不在名单中/);
});

test('buildMatchRecord —— 没选项目时先提示选项目', () => {
  const result = buildMatchRecord(singlesParams({ matchType: undefined }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.matchType, '请选择单打或双打');
  assert.strictEqual(result.firstError, '请选择单打或双打');
});

test('buildMatchRecord —— 赛制不合法时只报赛制，不报一堆连带错误', () => {
  const result = buildMatchRecord(singlesParams({ gamePoints: 9, bestOf: 3 }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.format, '请选择有效的分制与局制');
  assert.deepStrictEqual(result.scoreErrors, [], '赛制都不对，比分的报错没有意义');
});

test('buildMatchRecord —— 比分没打完会逐条列出', () => {
  const result = buildMatchRecord(
    singlesParams({ scoreA: ['11', '11'], scoreB: ['10', '7'] }),
    { now: NOW, minMatchTime: MIN }
  );

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.scoreErrors, ['第 1 局胜方必须领先 2 分（11:10）']);
  assert.strictEqual(result.firstError, result.scoreErrors[0]);
});

test('buildMatchRecord —— 空比分拦下', () => {
  const result = buildMatchRecord(singlesParams({ scoreA: ['', ''], scoreB: ['', ''] }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.scoreErrors, ['至少要录入 1 局比分']);
});

test('buildMatchRecord —— 同样不能打平', () => {
  const result = buildMatchRecord(singlesParams({ scoreA: ['11', '11'], scoreB: ['11', '9'] }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.scoreErrors.some((e) => e.includes('不能打平')));
});

/* ============================================================
 * 六、时间窗
 * ============================================================ */

test('buildMatchRecord —— 没填时间要拦下', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: undefined }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.matchTime, '请选择比赛时间');
});

test('buildMatchRecord —— 时间不能录到赛季首场之前', () => {
  // 一旦允许，回放的定级锚点会前移，全体中途入会者的初始分被静默重算
  const result = buildMatchRecord(singlesParams({ matchTime: '2026-03-01T18:00:00' }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.matchTime, /不能早于本赛季首场/);
});

test('buildMatchRecord —— 时间不能录到未来', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: '2026-06-01T18:00:00' }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.errors.matchTime, /不能晚于现在/);
});

test('buildMatchRecord —— 时间边界正好取到首场那一刻也算合法', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: MIN }), {
    now: NOW,
    minMatchTime: MIN,
  });

  assert.strictEqual(result.ok, true);
});

test('buildMatchRecord —— 不注入时间时跳过时间校验，不偷读系统时钟', () => {
  const result = buildMatchRecord(singlesParams({ matchTime: '2099-01-01T18:00:00' }));
  assert.strictEqual(result.ok, true);
});

/* ============================================================
 * 七、错误顺序
 * ============================================================ */

test('buildMatchRecord —— 报错顺序从粗到细，先说该做的事', () => {
  const result = buildMatchRecord(
    { matchType: undefined, teamA: [], teamB: [], scoreA: [], scoreB: [], gamePoints: 11, bestOf: 3 },
    { now: NOW, minMatchTime: MIN }
  );

  // 什么都没填时，先提醒选项目，而不是甩一条比分错误
  assert.strictEqual(result.firstError, '请选择单打或双打');
});
