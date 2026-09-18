/**
 * 录入比赛表单的纯逻辑
 * ============================================================
 * 表单里有几件容易写错、又特别值得测的事：
 *
 *   1. 换单打 / 双打时，队伍格子要从 1 格变 2 格（或反过来），
 *      比分输入行要跟着局制变。凭空重算会把用户已填的内容清掉。
 *   2. 比分行的数量由局制决定，但「一局一胜却填了三行」这种必须先
 *      把尾部空行去掉再校验（见 match-record.normalizeScores）。
 *   3. 胜方不由用户选，只能从比分推——这是全案的基石。
 *
 * 这些都不碰 wx API，放在这里就能用字面量输入逐条测；页面只负责
 * 把 setData 的结果渲染出来。
 * ============================================================
 */

const { MATCH_TYPE } = require('../utils/constants.js');
const {
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  BEST_OF_LABEL,
  DEFAULT_FORMAT,
  formatMatchFormat,
  validateMatchScore,
} = require('../utils/match-format.js');
const { normalizeScores } = require('./match-record.js');

/** 项目选项。顺序固定：单打在先，与全站默认口径一致 */
const MATCH_TYPE_OPTIONS = [
  { value: MATCH_TYPE.SINGLES, label: '单打' },
  { value: MATCH_TYPE.DOUBLES, label: '双打' },
];

/** 分制选项，picker 直接吃 */
const GAME_POINTS_LABELS = GAME_POINTS_OPTIONS.map((value) => `${value} 分制`);

/** 局制选项，picker 直接吃 */
const BEST_OF_LABELS = BEST_OF_OPTIONS.map((value) => BEST_OF_LABEL[value]);

/** 每队几人。单打 1 人，双打 2 人 */
function teamSizeOf(matchType) {
  return matchType === MATCH_TYPE.DOUBLES ? 2 : 1;
}

/**
 * 建一份空表单。
 * A 队第一格锁定当前登录会员——录的是自己的比赛，这一格不该让用户选错。
 *
 * @param {Object|null} user 当前登录会员
 * @returns {Object}
 */
function createForm(user) {
  const teams = createTeams(MATCH_TYPE.SINGLES, user);
  return {
    matchType: MATCH_TYPE.SINGLES,
    ...teams,
    scoreA: new Array(DEFAULT_FORMAT.bestOf).fill(''),
    scoreB: new Array(DEFAULT_FORMAT.bestOf).fill(''),
    gamePoints: DEFAULT_FORMAT.gamePoints,
    bestOf: DEFAULT_FORMAT.bestOf,
    date: '',
    time: '',
    location: '',
  };
}

/**
 * 用抽签排定的比赛记录建一份录入表单。
 *
 * 对阵、赛制、时间、场地全部照抄那条记录，一个字都不给改——抽签生成的
 * 比赛在签表里占着一个位置，若在这里改了对手或赛制，录进去的比分就与
 * 签表里那一场对不上，签表会自相矛盾。
 *
 * @param {Object} record 比赛记录（来自 getMatchRecords）
 * @returns {Object} 与 createForm 同形状的表单
 */
function scheduledForm(record) {
  const bestOf = Number(record && record.bestOf) || DEFAULT_FORMAT.bestOf;
  const gamePoints = Number(record && record.gamePoints) || DEFAULT_FORMAT.gamePoints;
  // '2026-05-20T09:00:00' → 日期与时分，交给 picker 的展示格式
  const [date, clock] = String((record && record.matchTime) || '').split('T');

  return {
    matchType: (record && record.matchType) || MATCH_TYPE.SINGLES,
    teamA: [...((record && record.teamA) || [])],
    teamB: [...((record && record.teamB) || [])],
    scoreA: new Array(bestOf).fill(''),
    scoreB: new Array(bestOf).fill(''),
    gamePoints,
    bestOf,
    date: date || '',
    time: clock ? clock.slice(0, 5) : '',
    location: (record && record.location) || '',
  };
}

/**
 * 按项目建队伍格子。
 * @param {number} matchType
 * @param {Object|null} user
 * @returns {{teamA: string[], teamB: string[]}}
 */
function createTeams(matchType, user) {
  const size = teamSizeOf(matchType);
  const teamA = new Array(size).fill('');
  if (user) teamA[0] = user._id;
  return { teamA, teamB: new Array(size).fill('') };
}

/**
 * 换项目时重建队伍。
 * 双打换单打多出来的那个人必须丢掉；单打换双打则补一个空格子。
 * 前 size 位原样保留，用户填过的人不会白填。
 *
 * @param {Object} form
 * @param {number} matchType
 * @returns {{teamA: string[], teamB: string[]}}
 */
function resizeTeams(form, matchType) {
  const size = teamSizeOf(matchType);
  const fit = (team) => {
    const list = Array.isArray(team) ? team : [];
    const out = [];
    for (let i = 0; i < size; i += 1) out.push(list[i] || '');
    return out;
  };
  return { teamA: fit(form.teamA), teamB: fit(form.teamB) };
}

/**
 * 按局制调整比分输入行数，已填的比分之一保留。
 * @param {number} bestOf
 * @param {Array<*>} previous
 * @returns {Array<* >}
 */
function resizeScores(bestOf, previous) {
  const list = Array.isArray(previous) ? previous : [];
  const out = [];
  for (let i = 0; i < bestOf; i += 1) out.push(list[i] === undefined ? '' : list[i]);
  return out;
}

/** 把两组比分并成模板要渲染的行 */
function toScoreRows(scoreA, scoreB) {
  const a = Array.isArray(scoreA) ? scoreA : [];
  const b = Array.isArray(scoreB) ? scoreB : [];
  return a.map((value, index) => ({
    index,
    a: value,
    b: b[index] === undefined ? '' : b[index],
  }));
}

/**
 * 从比分推出胜方，推不出来返回 null。
 * 表单上实时显示「谁会赢」用的就是它——用户不用自己心算。
 */
function winnerOf(scoreA, scoreB, gamePoints, bestOf) {
  const result = validateMatchScore(normalizeScores(scoreA), normalizeScores(scoreB), {
    gamePoints,
    bestOf,
  });
  return result.valid ? result.winner : null;
}

/** 赛制文案：11 分制 · 三局两胜 */
function formatTextOf(gamePoints, bestOf) {
  return formatMatchFormat({ gamePoints, bestOf });
}

/**
 * 表单 → submitMatch 的入参。
 * 只做搬运与清洗：空选手去掉（交给人数的校验去报错），
 * 日期与时间拼成完整的时间串，胜方**不带**——由数据层从比分推。
 *
 * @param {Object} form
 * @returns {Object}
 */
function toSubmitParams(form) {
  return {
    matchType: form.matchType,
    teamA: (Array.isArray(form.teamA) ? form.teamA : []).filter(Boolean),
    teamB: (Array.isArray(form.teamB) ? form.teamB : []).filter(Boolean),
    scoreA: form.scoreA,
    scoreB: form.scoreB,
    gamePoints: form.gamePoints,
    bestOf: form.bestOf,
    matchTime: form.date && form.time ? `${form.date}T${form.time}:00` : '',
    location: form.location,
  };
}

/**
 * 把会员名单整成「找人面板」的行。
 *
 * 面板要能在几十个名字里按关键字找到一个人，所以筛选必须发生在展示之前。
 * 原生 picker 做不到这一点（它只吃一个静态数组），才另起了这套面板。
 *
 * 【为什么昵称与真实姓名都要匹配】
 * 面板上显示昵称，但昵称常只是真名的一部分（真名「赵明宇」，昵称可能是
 * 「明宇」）。只按昵称搜，输入「赵」就找不到人。两个都匹配，输入昵称或
 * 真名都能定位到同一个人；真实姓名只用于匹配，面板上显示的仍是昵称。
 *
 * 【为什么还要把本赛季的交手场次带出来】
 * 防刷分对「同一对会员一个赛季」有名额上限，满了就不让再录（见 rating-cap.js
 * 的 checkSubmitAllowed）。用户看到名单时就该知道谁快打满了，而不是填完比分
 * 提交时才被拦下。数字由 getSeasonPairCounts 给出，与服务端闸门同一份算法。
 *
 * 只有选对手那一边传 pairInfo：名额只数跨队相对的人，同队的搭档之间不算一对，
 * 在搭档面板上显示场次只会让人以为「跟他搭档也算名额」。
 *
 * @param {Array<{id: string, name: string, realName?: string}>} members 完整会员名单
 * @param {string} keyword 搜索词
 * @param {string} selectedId 这一格已经选的人，用来打勾
 * @param {Object|null} [pairInfo] { counts: {会员编号: 场次}, limit: 上限 }
 * @returns {Array<Object>} 命中的行，含展示用的首字、选中标记与交手场次
 */
function buildPickerRows(members, keyword, selectedId, pairInfo = null) {
  const list = Array.isArray(members) ? members : [];
  const needle = String(keyword == null ? '' : keyword).trim().toLowerCase();
  const counts = (pairInfo && pairInfo.counts) || {};
  const limit = Number(pairInfo && pairInfo.limit);

  return list
    .filter((item) => {
      if (!needle) return true;
      return [item.name, item.realName].some((name) =>
        String(name || '').toLowerCase().includes(needle)
      );
    })
    .map((item) => {
      // 一场没打过的不挂徽标：名单里大多数人都是 0，全标出来只是噪音
      const count = Number(counts[item.id]) || 0;
      return {
        id: item.id,
        name: item.name,
        // 没有头像，用名字首字当一块占位的圆牌
        avatarText: (item.name || '?').slice(0, 1),
        selected: item.id === selectedId,
        pairCount: count,
        // 打满的标红：选了他也提交不上去，先说清楚
        pairFull: count > 0 && Number.isFinite(limit) && limit > 0 && count >= limit,
      };
    });
}

/**
 * 面板里一个人都没搜到时给一句解释。
 * 有搜索词时把词写进去，用户才知道是自己搜错了还是名单里真没有。
 *
 * @param {string} keyword
 * @returns {string}
 */
function pickerEmptyText(keyword) {
  const text = String(keyword == null ? '' : keyword).trim();
  return text ? `没有名字含「${text}」的会员` : '还没有可选的会员';
}

module.exports = {
  MATCH_TYPE_OPTIONS,
  GAME_POINTS_LABELS,
  BEST_OF_LABELS,
  teamSizeOf,
  createForm,
  scheduledForm,
  createTeams,
  resizeTeams,
  resizeScores,
  toScoreRows,
  winnerOf,
  formatTextOf,
  toSubmitParams,
  buildPickerRows,
  pickerEmptyText,
};
