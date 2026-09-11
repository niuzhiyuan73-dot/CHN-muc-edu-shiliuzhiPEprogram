/**
 * 录入表单的纯逻辑自检
 * ============================================================
 * 表单里有三类容易出错、又非测不可的地方：
 *
 *   1. 换项目 / 换局制时的「扩容与缩容」——多出来的格子要丢、缺的要补，
 *      但用户已经填过的内容不能跟着一起没。
 *   2. 胜方只能从比分推，不能由用户指定。推不出来时必须老实返回 null，
 *      而不是默认 A 队赢。
 *   3. 表单 → 接口入参的搬运：空选手要滤掉（交给人数的校验去报错），
 *      winner / recorder 一个都不许带——它们由数据层决定。
 *
 * 这些逻辑不碰 wx API，所以能全部用字面量输入钉死在这里。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  MATCH_TYPE_OPTIONS,
  GAME_POINTS_LABELS,
  BEST_OF_LABELS,
  teamSizeOf,
  createForm,
  createTeams,
  resizeTeams,
  resizeScores,
  toScoreRows,
  winnerOf,
  formatTextOf,
  toSubmitParams,
  buildPickerRows,
  pickerEmptyText,
} = require('../miniprogram/services/match-entry-view.js');
const { MATCH_TYPE } = require('../miniprogram/utils/constants.js');
const { GAME_POINTS_OPTIONS, BEST_OF_OPTIONS } = require('../miniprogram/utils/match-format.js');

const ME = { _id: 'u06', nickName: '赵明宇' };

/* ============================================================
 * 一、选项与人数
 * ============================================================ */

test('选项 —— 单打排在双打前面，与全站默认口径一致', () => {
  assert.deepStrictEqual(
    MATCH_TYPE_OPTIONS.map((item) => item.value),
    [MATCH_TYPE.SINGLES, MATCH_TYPE.DOUBLES]
  );
  assert.strictEqual(MATCH_TYPE_OPTIONS[0].label, '单打');
});

test('选项 —— picker 的文案与下标同源，不会错位', () => {
  // picker 吃的是下标，页面再按下标回查常量；两处必须同一份来源
  assert.deepStrictEqual(
    GAME_POINTS_LABELS,
    GAME_POINTS_OPTIONS.map((value) => `${value} 分制`)
  );
  assert.deepStrictEqual(
    BEST_OF_LABELS,
    BEST_OF_OPTIONS.map((value) => ({ 1: '一局一胜', 3: '三局两胜', 5: '五局三胜' }[value]))
  );
});

test('teamSizeOf —— 单打一人、双打两人，未知项目退回一人', () => {
  assert.strictEqual(teamSizeOf(MATCH_TYPE.SINGLES), 1);
  assert.strictEqual(teamSizeOf(MATCH_TYPE.DOUBLES), 2);
  assert.strictEqual(teamSizeOf(undefined), 1);
});

/* ============================================================
 * 二、建表
 * ============================================================ */

test('createForm —— 默认单打、11 分制三局两胜，A 队第一格是自己', () => {
  const form = createForm(ME);

  assert.strictEqual(form.matchType, MATCH_TYPE.SINGLES);
  assert.deepStrictEqual(form.teamA, ['u06']);
  assert.deepStrictEqual(form.teamB, ['']);
  assert.deepStrictEqual(form.scoreA, ['', '', '']);
  assert.deepStrictEqual(form.scoreB, ['', '', '']);
  assert.strictEqual(form.gamePoints, 11);
  assert.strictEqual(form.bestOf, 3);
});

test('createForm —— 没有登录态时第一格留空，而不是写进一个假的自己', () => {
  // 页面会用 blockReason 把整张表挡住；这里留空是为了万一漏挡，
  // 也只会变成「请选择参赛会员」的校验错误，而不是凭空记一场
  const form = createForm(null);
  assert.deepStrictEqual(form.teamA, ['']);
});

test('createTeams —— 双打两队各两格', () => {
  const teams = createTeams(MATCH_TYPE.DOUBLES, ME);
  assert.deepStrictEqual(teams.teamA, ['u06', '']);
  assert.deepStrictEqual(teams.teamB, ['', '']);
});

/* ============================================================
 * 三、换项目 / 换局制时的增删
 * ============================================================ */

test('resizeTeams —— 双打换单打丢掉多出来的队友，前面的保留', () => {
  const form = { teamA: ['u06', 'u01'], teamB: ['u02', 'u03'] };
  const fitted = resizeTeams(form, MATCH_TYPE.SINGLES);

  assert.deepStrictEqual(fitted.teamA, ['u06']);
  assert.deepStrictEqual(fitted.teamB, ['u02']);
});

test('resizeTeams —— 单打换双打补出空格子，填过的搭档不白填', () => {
  const form = { teamA: ['u06'], teamB: ['u02'] };
  const fitted = resizeTeams(form, MATCH_TYPE.DOUBLES);

  assert.deepStrictEqual(fitted.teamA, ['u06', '']);
  assert.deepStrictEqual(fitted.teamB, ['u02', '']);
});

test('resizeTeams —— 缺字段时兜底成空格子，不抛错', () => {
  assert.deepStrictEqual(resizeTeams({}, MATCH_TYPE.SINGLES), { teamA: [''], teamB: [''] });
  assert.deepStrictEqual(resizeTeams({ teamA: null }, MATCH_TYPE.DOUBLES), {
    teamA: ['', ''],
    teamB: ['', ''],
  });
});

test('resizeScores —— 从三局扩到五局补空行，已有比分之一字不动', () => {
  assert.deepStrictEqual(resizeScores(5, ['11', '9']), ['11', '9', '', '', '']);
});

test('resizeScores —— 从五局缩到一局只留第一行', () => {
  assert.deepStrictEqual(resizeScores(1, ['11', '9', '11', '', '']), ['11']);
});

test('resizeScores —— 原值缺失时整排空行', () => {
  assert.deepStrictEqual(resizeScores(3, undefined), ['', '', '']);
});

/* ============================================================
 * 四、比分 → 胜方
 * ============================================================ */

test('toScoreRows —— 两组比分按局配对，短的一边补空串', () => {
  assert.deepStrictEqual(toScoreRows(['11', '9'], ['9']), [
    { index: 0, a: '11', b: '9' },
    { index: 1, a: '9', b: '' },
  ]);
  assert.deepStrictEqual(toScoreRows(null, null), []);
});

test('winnerOf —— 两局拿下就判 A 胜，表单里存的是字符串也认', () => {
  assert.strictEqual(winnerOf(['11', '11'], ['9', '7'], 11, 3), 'A');
  assert.strictEqual(winnerOf(['9', '7'], ['11', '11'], 11, 3), 'B');
});

test('winnerOf —— 局分打平或没打完时返回 null，而不是默认 A 队赢', () => {
  // 1:1 还没分出胜负
  assert.strictEqual(winnerOf(['11', '9'], ['9', '11'], 11, 3), null);
  // 11:10 是没打完的局（先到 11 分还要领先 2 分）
  assert.strictEqual(winnerOf(['11'], ['10'], 11, 3), null);
  // 一行都没填
  assert.strictEqual(winnerOf(['', ''], ['', ''], 11, 3), null);
});

test('winnerOf —— 已经分出胜负却多录了一局，同样不认', () => {
  // 三局两胜录成 11:9 11:9 11:9：第三局开打前比赛其实已经结束了
  assert.strictEqual(winnerOf(['11', '11', '11'], ['9', '9', '9'], 11, 3), null);
});

/* ============================================================
 * 五、赛制文案与提交入参
 * ============================================================ */

test('formatTextOf —— 合法赛制给文案，非法赛制给空串', () => {
  assert.strictEqual(formatTextOf(11, 3), '11 分制 · 三局两胜');
  assert.strictEqual(formatTextOf(21, 5), '21 分制 · 五局三胜');
  assert.strictEqual(formatTextOf(11, 2), '');
});

test('toSubmitParams —— 日期与时间拼成完整时间串', () => {
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06'],
    teamB: ['u02'],
    scoreA: ['11', '11'],
    scoreB: ['9', '7'],
    gamePoints: 11,
    bestOf: 3,
    date: '2026-09-01',
    time: '18:30',
    location: '学校体育馆 1 号场',
  });

  assert.strictEqual(params.matchTime, '2026-09-01T18:30:00');
  assert.strictEqual(params.location, '学校体育馆 1 号场');
});

test('toSubmitParams —— 日期或时间没填时比赛时间为空串，交给校验去报错', () => {
  const base = { matchType: MATCH_TYPE.SINGLES, teamA: ['u06'], teamB: ['u02'] };
  assert.strictEqual(toSubmitParams({ ...base, date: '2026-09-01', time: '' }).matchTime, '');
  assert.strictEqual(toSubmitParams({ ...base, date: '', time: '18:30' }).matchTime, '');
});

test('toSubmitParams —— 空选手滤掉，人数不对交给数据层报错', () => {
  // 在表单层悄悄补一个人，等于替用户签了名；宁可让校验说「请选择参赛会员」
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06', ''],
    teamB: [''],
  });

  assert.deepStrictEqual(params.teamA, ['u06']);
  assert.deepStrictEqual(params.teamB, []);
});

test('toSubmitParams —— 绝不带 winner 与 recorder，它们由数据层说了算', () => {
  const params = toSubmitParams({
    matchType: MATCH_TYPE.SINGLES,
    teamA: ['u06'],
    teamB: ['u02'],
    scoreA: ['9', '7'],
    scoreB: ['11', '11'],
    gamePoints: 11,
    bestOf: 3,
    date: '2026-09-01',
    time: '18:30',
    winner: 'A',
    recorder: 'u02',
  });

  assert.strictEqual('winner' in params, false);
  assert.strictEqual('recorder' in params, false);
  // 比分照搬，胜方让 match-record 从它推——这里输入的是 B 队赢
  assert.deepStrictEqual(params.scoreA, ['9', '7']);
  assert.deepStrictEqual(params.scoreB, ['11', '11']);
});

/* ============================================================
 * 六、找人面板的筛选
 * ============================================================ */

const ROSTER = [
  { id: 'u01', name: '巴特尔' },
  { id: 'u02', name: '张宇轩' },
  { id: 'u03', name: '张伟' },
  { id: 'u04', name: 'Leo' },
];

test('buildPickerRows —— 空搜索词给出全名单', () => {
  const rows = buildPickerRows(ROSTER, '', '');

  assert.strictEqual(rows.length, ROSTER.length);
  assert.deepStrictEqual(
    rows.map((row) => row.id),
    ['u01', 'u02', 'u03', 'u04']
  );
});

test('buildPickerRows —— 按昵称子串筛选，忽略大小写与首尾空格', () => {
  assert.deepStrictEqual(
    buildPickerRows(ROSTER, '张', '').map((row) => row.id),
    ['u02', 'u03']
  );
  assert.deepStrictEqual(
    buildPickerRows(ROSTER, ' le ', '').map((row) => row.id),
    ['u04'],
    '搜 le 应当能命中 Leo'
  );
  assert.deepStrictEqual(buildPickerRows(ROSTER, '王', ''), []);
});

test('buildPickerRows —— 给每行配首字，并标记这一格当前选中的人', () => {
  const rows = buildPickerRows(ROSTER, '', 'u03');

  assert.strictEqual(rows[0].avatarText, '巴');
  const picked = rows.find((row) => row.id === 'u03');
  assert.strictEqual(picked.selected, true);
  assert.strictEqual(rows.filter((row) => row.selected).length, 1, '只该有一个人被打勾');
});

test('buildPickerRows —— 选中的人被搜掉时不抛错，非数组当空名单', () => {
  const rows = buildPickerRows(ROSTER, '张', 'u04');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.some((row) => row.selected), false, 'u04 没被搜出来，自然没有打勾的行');
  assert.deepStrictEqual(buildPickerRows(null, '张', ''), []);
});

test('pickerEmptyText —— 有搜索词时把词写进提示，没有时给通用那句', () => {
  assert.strictEqual(pickerEmptyText('王'), '没有昵称含「王」的会员');
  assert.strictEqual(pickerEmptyText('  王 '), '没有昵称含「王」的会员');
  assert.strictEqual(pickerEmptyText(''), '还没有可选的会员');
  assert.strictEqual(pickerEmptyText(null), '还没有可选的会员');
});
