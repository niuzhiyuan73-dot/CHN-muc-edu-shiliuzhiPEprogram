/**
 * 导入器契约 —— 导出的 JSON 真能被小程序吃下去
 * ============================================================
 * tools/import-matches.py 是独立进程：它读不了 JS，只能把赛制校验、胜方推导、
 * 自然键这几套口径各写一份。两份实现一旦漂移，症状是「导入成功了，但分数
 * 不对」——最难发现的那一类错。所以这里不测 Python 怎么读表（那是
 * tools/test_import_matches.py 的事），只做一件事：把 Python 产出的真实 JSON
 * 逐条喂给小程序自己的校验器与回放引擎，看它认不认。
 *
 * 三处对齐要点：
 *   1. 每份文档都能过 buildMatchRecord（赛制、人数、比分、时间窗全部合法）；
 *   2. winner / pool 与小程序推导出的完全一致（Python 不许自己拿主意）；
 *   3. _id 与云端 idempotency.matchNaturalKey 逐字节相同——这条最要紧：
 *      不一致的话，同一张表导入两次会产生两份记录，而等级分是零和的，
 *      同一个人会被重复计分两次。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildMatchRecord } = require('../miniprogram/services/match-record.js');
const { matchNaturalKey } = require('../cloudfunctions/data/src/core/idempotency.js');
const { validateMatchScore } = require('../miniprogram/utils/match-format.js');
const { replaySeason } = require('../miniprogram/services/replay.js');
const { generateSeed } = require('../miniprogram/services/seed.js');
const {
  MATCH_STATUS,
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  RATING_POOL,
} = require('../miniprogram/utils/constants.js');

const FIXTURE = path.join(__dirname, '..', 'tools', 'fixtures', 'import-sample.json');
const documents = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** 样例表里那四位会员。入会日期早于首场，都是创始会员 */
const MEMBERS = [
  { _id: 'u01', nickName: '巴特尔', gender: 'M', joinDate: '2026-03-01T00:00:00' },
  { _id: 'u02', nickName: '张宇轩', gender: 'M', joinDate: '2026-03-01T00:00:00' },
  { _id: 'u03', nickName: '李思远', gender: 'F', joinDate: '2026-03-01T00:00:00' },
  { _id: 'u04', nickName: '王浩然', gender: 'F', joinDate: '2026-03-01T00:00:00' },
].map((member) => ({ ...member, avatarUrl: '', role: 0, status: 1, points: 0 }));

/** 赛季锚点：对照表里最早的一场 */
const SEASON_START = '2026-04-08T18:00:00';
/** 一个晚于全部样例比赛的「现在」 */
const NOW = '2026-06-01T12:00:00';

/** 把一份导入文档还原成 buildMatchRecord 的入参 */
function toParams(doc) {
  return {
    matchType: doc.matchType,
    teamA: doc.teamA,
    teamB: doc.teamB,
    scoreA: doc.scoreA,
    scoreB: doc.scoreB,
    gamePoints: doc.gamePoints,
    bestOf: doc.bestOf,
    matchTime: doc.matchTime,
    location: doc.location,
    recorder: doc.recorder,
  };
}

test('样例流水非空，且没有重复的比赛', () => {
  assert.ok(documents.length > 0);
  const ids = documents.map((doc) => doc._id);
  assert.equal(new Set(ids).size, ids.length, '同一场比赛被导出了两次');
});

test('每份文档都能过小程序的录入校验', () => {
  for (const doc of documents) {
    const result = buildMatchRecord(toParams(doc), {
      members: MEMBERS,
      now: NOW,
      minMatchTime: SEASON_START,
    });

    assert.equal(
      result.ok,
      true,
      `比赛 ${doc._id} 被小程序判为非法：${result.firstError}（比分 ${doc.scoreA} : ${doc.scoreB}）`
    );
  }
});

test('字段集与种子数据完全一致 —— 不多不少', () => {
  // 用真实种子数据当基准，而不是在这里手抄一份字段名：
  // 手抄的那份迟早会与 seed.js 分家，然后这条断言就变成了自我安慰
  const [seedMatch] = generateSeed({ weeks: 4, casualPerWeek: 6 }).matches;
  const expected = Object.keys(seedMatch).sort();

  for (const doc of documents) {
    assert.deepEqual(
      Object.keys(doc).sort(),
      expected,
      `比赛 ${doc._id} 的字段集与种子数据不一致`
    );
  }
});

test('胜方由比分推出，与小程序算出的完全一致', () => {
  for (const doc of documents) {
    const result = validateMatchScore(doc.scoreA, doc.scoreB, {
      gamePoints: doc.gamePoints,
      bestOf: doc.bestOf,
    });

    assert.equal(result.valid, true, `比赛 ${doc._id} 的比分本身就不合法`);
    assert.equal(
      doc.winner,
      result.winner,
      `比赛 ${doc._id} 的胜方不是从比分推出来的`
    );
  }
});

test('池由比赛类型推出，不采信表格里的值', () => {
  for (const doc of documents) {
    assert.equal(doc.pool, MATCH_TYPE_TO_POOL[doc.matchType]);
    assert.ok([RATING_POOL.SINGLES, RATING_POOL.DOUBLES].includes(doc.pool));
  }
});

test('比赛类型只用单打与双打两种', () => {
  for (const doc of documents) {
    assert.ok(
      [MATCH_TYPE.SINGLES, MATCH_TYPE.DOUBLES].includes(doc.matchType),
      `比赛 ${doc._id} 的项目类型 ${doc.matchType} 不在允许范围内`
    );
  }
});

test('_id 与云端的自然键逐字节一致', () => {
  // 这是 Python 与 JS 两套实现之间最硬的一条约束。改了任何一边的
  // 字段顺序、分隔符或时间格式，这一条立刻红。
  for (const doc of documents) {
    assert.equal(
      doc._id,
      matchNaturalKey(doc),
      `比赛 ${doc._id} 的自然键与云端对不上：同一场比赛会被导入两次`
    );
  }
});

test('历史成绩一律记为已生效', () => {
  for (const doc of documents) {
    assert.equal(doc.status, MATCH_STATUS.ACTIVE, '历史比赛录进来时就该是已生效');
  }
});

test('样例流水能直接喂给回放引擎算出四个人的分数', () => {
  // 前面几条都是「形状对不对」。这一条是真跑一遍：只要有一场比赛的
  // 队伍、比分或时间有问题，回放要么抛错，要么算不出这四个人的分数。
  const result = replaySeason({ members: MEMBERS, matches: documents });

  assert.equal(result.matches.length, documents.length, '回放丢掉了比赛');

  for (const member of MEMBERS) {
    const user = result.users.find((item) => item._id === member._id);
    assert.ok(user, `${member.nickName} 没进回放结果`);

    for (const pool of [RATING_POOL.SINGLES, RATING_POOL.DOUBLES]) {
      const rating = user.ratings[pool];
      assert.ok(Number.isFinite(rating.elo), `${member.nickName} 的 ${pool} 分数不是数字`);
      assert.ok(rating.elo > 0, `${member.nickName} 的 ${pool} 分数成了非正数`);
    }
  }

  // 四个人都上过场，单打池的分数就不该还停在初始值
  const singles = result.users.map((user) => user.ratings[RATING_POOL.SINGLES].elo);
  assert.ok(new Set(singles).size > 1, '打完比赛后大家的分数还是一模一样，回放没算分');
});

test('回放结果里没有中途入会者 —— 样例的四人都是创始会员', () => {
  const result = replaySeason({ members: MEMBERS, matches: documents });

  const placed = Object.keys(result.meta.placements || {});
  assert.deepEqual(placed, [], '四人入会都早于赛季首场，不该有人被按前五场对手定级');
});
