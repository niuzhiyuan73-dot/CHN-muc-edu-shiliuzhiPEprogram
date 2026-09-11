/**
 * 单打实验脚本
 * ============================================================
 * 回答四个问题：
 *   1. 回放出来的单打分数，能不能还原出隐藏的真实水平？
 *   2. 男女真实水平的差距（约 170 分），在等级分上要多久才能显出来？
 *   3. 如果单打里没有男女对打，男榜和女榜还比不比得了？
 *   4. 让女会员从低 100 分起步（genderInitialGap），到底补上了多少差距？
 *
 * 【为什么只看单打】
 * 双打不分性别（一队里可能同时有男女），性别差异在里面被稀释掉了，
 * 拿它考察男女水平差没有意义。单打才是男女直接对抗的项目。
 *
 * 【为什么要把混打比例做成可调】
 * 合并成一个池之后，男组和女组之间只有通过「男女对打」这几场才有
 * 分数往来。把混打比例从 0 一路调到 1，就能看出两组的分数是各自
 * 封闭（比例 0）还是完全融合（比例 1），以及中间取值差多少。
 * 每个比例都跑多个随机种子取平均，避免单次抽样的偶然性。
 *
 * 用法：node tools/singles-experiment.js <输出 json 路径>
 * ============================================================
 */

const fs = require('fs');

const { generateSeed } = require('../miniprogram/services/seed.js');
const { replaySeason } = require('../miniprogram/services/replay.js');
const { RATING_POOL } = require('../miniprogram/utils/constants.js');
const { getPoolRating } = require('../miniprogram/utils/rating.js');
const { DEFAULT_CONFIG } = require('../miniprogram/utils/elo.js');

const SINGLES = RATING_POOL.SINGLES;
const DAY_MS = 86400000;

/** 基准生成参数，与 mock.js 保持一致，保证实验数据就是小程序里跑的那套 */
const BASE_OPTIONS = {
  seed: 20260901,
  startDate: '2026-04-06',
  weeks: 20,
  casualPerWeek: 30,
};

/** 混打比例扫描用的取值 */
const SWEEP_RATIOS = [0, 0.1, 0.25, 0.5, 0.75, 1];

/** 每个比例重复多少个随机种子 */
const SWEEP_SEEDS = [20260901, 20260902, 20260903, 20260904, 20260905,
  20260906, 20260907, 20260908, 20260909, 20260910];

/** 观察性别差距收敛过程的时间点（第几周） */
const CHECKPOINT_WEEKS = [2, 4, 8, 12, 16, 20];

/**
 * 初始分扫描用的取值。
 *
 * 零和池有一个绕不开的性质：所有人的起点相同，池内总分就守恒，
 * 池的平均分永远停在初始分上。因此初始分定得离「全池真实平均」
 * 多远，全体分数就整体偏高或偏低多少。俱乐部真实水平均值约 1390，
 * 这里从 1300 扫到 1600，看初始分取 1500 会带来多大的系统性偏差。
 */
const ANCHOR_VALUES = [1300, 1350, 1400, 1450, 1500, 1600];

/** 初始分扫描重复多少个随机种子 */
const ANCHOR_SEEDS = SWEEP_SEEDS;

/**
 * 性别起点差扫描用的取值。
 *
 * 男会员起点的绝对位置基本不影响「男女差距」这件事，真正起作用的是
 * 女会员比男会员低多少分（genderInitialGap）。从 0（男女同起点）扫到 200，
 * 看差距还原度、整体误差和两张榜的重叠程度怎么变。
 */
const GAP_VALUES = [0, 50, 100, 150, 200];

const mean = (values) => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length);

const stdev = (values) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
};

/** 皮尔逊相关系数：衡量等级分与真实水平的线性吻合程度 */
function pearson(xs, ys) {
  if (xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

const round = (value, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/**
 * 把一次回放的结果整理成逐人明细。
 *
 * @param {Object} members generateSeed 产出的会员列表（带 trueSkill）
 * @param {Object} result replaySeason 的结果
 * @returns {Array<Object>}
 */
function perMemberRows(members, result) {
  const byId = new Map(members.map((m) => [m._id, m]));

  return result.users
    .map((user) => {
      const src = byId.get(user._id);
      const bucket = getPoolRating(user, SINGLES);
      return {
        _id: user._id,
        nickName: user.nickName,
        gender: user.gender,
        trueSkill: src ? src.trueSkill : null,
        startElo: bucket.startElo,
        elo: bucket.elo,
        error: src ? bucket.elo - src.trueSkill : null,
        absError: src ? Math.abs(bucket.elo - src.trueSkill) : null,
        matchCount: bucket.matchCount,
        wins: bucket.wins,
        losses: bucket.losses,
      };
    })
    .filter((row) => row.matchCount > 0)
    .sort((a, b) => b.elo - a.elo);
}

/**
 * 汇总一组逐人明细：两组均值、差距、误差、相关系数。
 *
 * @param {Array<Object>} rows
 * @returns {Object}
 */
function summarize(rows) {
  const men = rows.filter((r) => r.gender === 'M');
  const women = rows.filter((r) => r.gender === 'F');

  const menMeanElo = mean(men.map((r) => r.elo));
  const womenMeanElo = mean(women.map((r) => r.elo));
  const menMeanSkill = mean(men.map((r) => r.trueSkill));
  const womenMeanSkill = mean(women.map((r) => r.trueSkill));
  const observedGap = menMeanElo - womenMeanElo;
  const trueGap = menMeanSkill - womenMeanSkill;

  // 中位数用得着：少数极端值会把均值带偏
  const menSorted = [...men].sort((a, b) => b.elo - a.elo);
  const medianManElo = menSorted.length
    ? menSorted[Math.floor(menSorted.length / 2)].elo
    : 0;

  return {
    memberCount: rows.length,
    menCount: men.length,
    womenCount: women.length,
    menMeanElo: round(menMeanElo),
    womenMeanElo: round(womenMeanElo),
    menMeanSkill: round(menMeanSkill),
    womenMeanSkill: round(womenMeanSkill),
    observedGap: round(observedGap),
    trueGap: round(trueGap),
    // 观察到的差距只还原了真实差距的几成
    convergence: trueGap === 0 ? 0 : round(observedGap / trueGap, 3),
    mae: round(mean(rows.map((r) => r.absError))),
    maeMen: round(mean(men.map((r) => r.absError))),
    maeWomen: round(mean(women.map((r) => r.absError))),
    // 带符号的偏差：正数表示分数被高估。零和池里它主要由初始分决定。
    bias: round(mean(rows.map((r) => r.error))),
    biasMen: round(mean(men.map((r) => r.error))),
    biasWomen: round(mean(women.map((r) => r.error))),
    pearson: round(pearson(rows.map((r) => r.trueSkill), rows.map((r) => r.elo)), 3),
    // 有多少女生的分数高过男生的中位数——直观反映两张榜「掺在一起」的程度
    womenAboveMedianMan: women.filter((r) => r.elo > medianManElo).length,
    medianManElo: round(medianManElo),
  };
}

/* ---------- 实验一：基准跑一遍，看收敛与逐人明细 ---------- */

function runBaseline() {
  const seedData = generateSeed(BASE_OPTIONS);
  const result = replaySeason(seedData);
  const rows = perMemberRows(seedData.members, result);

  return {
    options: BASE_OPTIONS,
    memberCount: seedData.members.length,
    rows,
    summary: summarize(rows),
  };
}

/* ---------- 实验二：性别差距随时间的收敛 ---------- */

function runCheckpoints() {
  const seedData = generateSeed(BASE_OPTIONS);
  const baseDate = new Date(BASE_OPTIONS.startDate + 'T18:00:00');

  return CHECKPOINT_WEEKS.map((week) => {
    const cutoff = new Date(baseDate.getTime() + week * 7 * DAY_MS);
    const trimmed = seedData.matches.filter((m) => new Date(m.matchTime) <= cutoff);
    const result = replaySeason({ ...seedData, matches: trimmed });
    const rows = perMemberRows(seedData.members, result).filter(
      // 早期周次里有些人还没打过球，剔掉，否则均值里混进 1500 的僵尸分
      (r) => r.matchCount >= 3
    );
    return { week, matchCount: trimmed.length, ...summarize(rows) };
  });
}

/* ---------- 实验三：混打比例扫描 ---------- */

function runSweep() {
  return SWEEP_RATIOS.map((ratio) => {
    const summaries = SWEEP_SEEDS.map((seed) => {
      const seedData = generateSeed({ ...BASE_OPTIONS, seed, mixedRatio: ratio });
      const result = replaySeason(seedData);
      return summarize(perMemberRows(seedData.members, result));
    });

    const pick = (key) => summaries.map((s) => s[key]);
    return {
      ratio,
      runCount: summaries.length,
      observedGapMean: round(mean(pick('observedGap'))),
      observedGapStd: round(stdev(pick('observedGap'))),
      convergenceMean: round(mean(pick('convergence')), 3),
      maeMean: round(mean(pick('mae'))),
      maeMenMean: round(mean(pick('maeMen'))),
      maeWomenMean: round(mean(pick('maeWomen'))),
      pearsonMean: round(mean(pick('pearson')), 3),
      womenAboveMedianManMean: round(mean(pick('womenAboveMedianMan')), 2),
      trueGap: summaries[0].trueGap,
    };
  });
}

/* ---------- 实验四：初始分（锚点）对系统性偏差的影响 ---------- */

function runAnchorSweep() {
  return ANCHOR_VALUES.map((anchor) => {
    const summaries = ANCHOR_SEEDS.map((seed) => {
      const seedData = generateSeed({ ...BASE_OPTIONS, seed });
      const result = replaySeason({ ...seedData, options: { eloConfig: { initialRating: anchor } } });
      return summarize(perMemberRows(seedData.members, result));
    });

    const pick = (key) => summaries.map((s) => s[key]);
    return {
      anchor,
      runCount: summaries.length,
      maeMean: round(mean(pick('mae'))),
      maeMenMean: round(mean(pick('maeMen'))),
      maeWomenMean: round(mean(pick('maeWomen'))),
      biasMean: round(mean(pick('bias'))),
      biasMenMean: round(mean(pick('biasMen'))),
      biasWomenMean: round(mean(pick('biasWomen'))),
      observedGapMean: round(mean(pick('observedGap'))),
      convergenceMean: round(mean(pick('convergence')), 3),
      pearsonMean: round(mean(pick('pearson')), 3),
    };
  });
}

/* ---------- 实验五：性别起点差（genderInitialGap）扫描 ---------- */

function runGapSweep() {
  return GAP_VALUES.map((gap) => {
    const summaries = ANCHOR_SEEDS.map((seed) => {
      const seedData = generateSeed({ ...BASE_OPTIONS, seed });
      const result = replaySeason({
        ...seedData,
        options: { eloConfig: { genderInitialGap: gap } },
      });
      return summarize(perMemberRows(seedData.members, result));
    });

    const pick = (key) => summaries.map((s) => s[key]);
    return {
      gap,
      runCount: summaries.length,
      observedGapMean: round(mean(pick('observedGap'))),
      observedGapStd: round(stdev(pick('observedGap'))),
      convergenceMean: round(mean(pick('convergence')), 3),
      maeMean: round(mean(pick('mae'))),
      maeMenMean: round(mean(pick('maeMen'))),
      maeWomenMean: round(mean(pick('maeWomen'))),
      biasMean: round(mean(pick('bias'))),
      biasMenMean: round(mean(pick('biasMen'))),
      biasWomenMean: round(mean(pick('biasWomen'))),
      pearsonMean: round(mean(pick('pearson')), 3),
      womenAboveMedianManMean: round(mean(pick('womenAboveMedianMan')), 2),
      trueGap: summaries[0].trueGap,
    };
  });
}

/* ---------- 实验六：中途入会者的定级明细 ---------- */

function runPlacements() {
  const seedData = generateSeed(BASE_OPTIONS);
  const result = replaySeason(seedData);
  const byId = new Map(seedData.members.map((m) => [m._id, m]));
  const placements = result.meta.placements;

  const lateJoiners = seedData.members.filter((m) => placements[m._id]);

  return lateJoiners.map((member) => {
    const placed = placements[member._id];
    const before = result.matches.filter(
      (m) => [...m.teamA, ...m.teamB].includes(member._id)
    );
    const firstFive = before.slice(0, 5);
    const wins = firstFive.filter((m) => {
      const side = m.teamA.includes(member._id) ? 'A' : 'B';
      return m.winner === side;
    }).length;

    const user = result.users.find((u) => u._id === member._id);
    const singles = getPoolRating(user, SINGLES);

    // 定级所用的对手：第一遍回放里「该会员前五场」碰到的对方赛前分数
    const opponents = firstFive.map((m) => {
      const mine = m.players.find((p) => p.userId === member._id);
      const others = m.players.filter((p) => p.userId !== member._id);
      return {
        matchId: m._id,
        pool: m.pool,
        eloBefore: mine ? mine.eloBefore : null,
        opponentAverage: others.length
          ? Math.round(mean(others.map((p) => p.eloBefore)))
          : null,
        won: m.teamA.includes(member._id) ? m.winner === 'A' : m.winner === 'B',
      };
    });

    return {
      _id: member._id,
      nickName: member.nickName,
      gender: member.gender,
      trueSkill: member.trueSkill,
      singlesPlacement: placed.singles === undefined ? null : placed.singles,
      doublesPlacement: placed.doubles === undefined ? null : placed.doubles,
      entries: placements[member._id] ? Object.keys(placements[member._id]).length : 0,
      firstFiveWins: wins,
      firstFiveCount: firstFive.length,
      singlesFinalElo: singles.elo,
      singlesMatchCount: singles.matchCount,
      finalError: singles.elo - member.trueSkill,
      opponents,
    };
  });
}

/* ---------- 汇总与输出 ---------- */

function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    throw new Error('用法：node tools/singles-experiment.js <输出 json 路径>');
  }

  const baseline = runBaseline();
  const checkpoints = runCheckpoints();
  const sweep = runSweep();
  const anchorSweep = runAnchorSweep();
  const gapSweep = runGapSweep();
  const placements = runPlacements();

  const payload = {
    generatedAt: new Date().toISOString(),
    baseOptions: BASE_OPTIONS,
    // 记录这次实验采用的默认参数，表格里据实打印男/女起点，
    // 避免调参后表格标题与数据对不上
    eloConfig: {
      initialRating: DEFAULT_CONFIG.initialRating,
      genderInitialGap: DEFAULT_CONFIG.genderInitialGap,
    },
    memberCount: baseline.memberCount,
    sweepRatios: SWEEP_RATIOS,
    sweepSeeds: SWEEP_SEEDS,
    anchorValues: ANCHOR_VALUES,
    gapValues: GAP_VALUES,
    checkpointWeeks: CHECKPOINT_WEEKS,
    members: { rows: baseline.rows, summary: baseline.summary },
    checkpoints,
    sweep,
    anchorSweep,
    gapSweep,
    placements,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  // 顺手在终端打一份要点，方便直接核对
  const s = baseline.summary;
  console.log('单打逐人收敛：');
  console.log(`  真实差距 ${s.trueGap} 分，等级分差距 ${s.observedGap} 分，还原度 ${(s.convergence * 100).toFixed(0)}%`);
  console.log(`  平均绝对误差 ${s.mae} 分（男 ${s.maeMen} / 女 ${s.maeWomen}），相关系数 ${s.pearson}`);
  console.log('混打比例扫描：');
  for (const row of sweep) {
    console.log(
      `  比例 ${String(row.ratio).padEnd(5)} → 观察差距 ${String(row.observedGapMean).padStart(6)}（还原 ${(row.convergenceMean * 100).toFixed(0)}%），MAE ${row.maeMean}`
    );
  }
  console.log(`初始分（男会员锚点，女会员低 ${DEFAULT_CONFIG.genderInitialGap} 分）扫描：`);
  for (const row of anchorSweep) {
    console.log(
      `  锚点 ${String(row.anchor).padEnd(5)} → 整体偏差 ${String(row.biasMean).padStart(6)}，MAE ${String(row.maeMean).padStart(5)}（男 ${row.maeMenMean} / 女 ${row.maeWomenMean}），相关 ${row.pearsonMean}`
    );
  }
  console.log('性别起点差（女比男低多少分）扫描：');
  for (const row of gapSweep) {
    console.log(
      `  低 ${String(row.gap).padEnd(4)} 分 → 观察差距 ${String(row.observedGapMean).padStart(6)}（还原 ${(row.convergenceMean * 100).toFixed(0)}%），MAE ${String(row.maeMean).padStart(5)}（男 ${row.maeMenMean} / 女 ${row.maeWomenMean}），女高过男中位数 ${row.womenAboveMedianManMean} 人`
    );
  }
  console.log('中途入会定级：');
  for (const row of placements) {
    console.log(
      `  ${row.nickName}（真实 ${row.trueSkill}）单打定级 ${row.singlesPlacement}，双打定级 ${row.doublesPlacement}`
    );
  }
  console.log(`\n已写入 ${outPath}`);
}

main();
