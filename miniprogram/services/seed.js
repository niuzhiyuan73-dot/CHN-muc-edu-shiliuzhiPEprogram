/**
 * 模拟数据种子生成器
 * ============================================================
 * 【核心思路：隐藏实力 + 胜负模拟】
 *
 * 不直接给每个人编一个等级分，而是：
 *   1. 先给每人一个「隐藏真实水平」（trueSkill），对外不展示
 *   2. 用真实水平之差算出各自的胜率，据此模拟比赛胜负
 *   3. 再用 ELO 算法从零开始逐场回放，让等级分自动「长出来」
 *
 * 这样做的价值：
 *   - 生成的等级分是真实的比赛结果推出来的，不是手编的，数据自洽
 *   - 可以反过来检验算法：等级分应当收敛到接近真实水平
 *   - 回放引擎与将来云端的计分逻辑是同一套，等于提前验证了生产代码
 *
 * 所有随机都走固定种子，保证每次生成的数据完全一致。
 * ============================================================
 */

const { createSeededRandom, randomInt, pick, shuffle } = require('../utils/random.js');
const {
  MATCH_TYPE,
  MATCH_TYPE_LABEL,
  MATCH_STATUS,
  MATCH_TYPE_TO_POOL,
} = require('../utils/constants.js');
const { DEFAULT_FORMAT, gamesToWin } = require('../utils/match-format.js');

/** 默认随机种子。换一个数字就能得到一整套完全不同的模拟数据。 */
const DEFAULT_SEED = 20260901;

/** 数据起始日期（周一） */
const DEFAULT_START_DATE = '2026-04-06';

/**
 * 日常约球的赛制分布。
 *
 * 以 11 分制三局两胜为主——这是俱乐部最常用的打法；场地紧张时打一局
 * 定胜负，偶尔也换 15 分制。重复出现的项即代表出现频次更高。
 */
const CASUAL_FORMATS = [
  { gamePoints: 11, bestOf: 3 },
  { gamePoints: 11, bestOf: 3 },
  { gamePoints: 11, bestOf: 3 },
  { gamePoints: 11, bestOf: 1 },
  { gamePoints: 15, bestOf: 3 },
];

/** 常去的几个场地 */
const VENUES = [
  '学校体育馆 1 号场',
  '学校体育馆 2 号场',
  '学校体育馆 3 号场',
  '校门外匹克球场',
  '大学生活动中心',
];

/**
 * 公告种子数据。
 * ============================================================
 * week 表示第几周发布，与赛事安排对齐：赛前发报名通知，赛后发战报。
 * pinned 的公告在首页置顶——招新、规则变更这类信息必须让所有人看到，
 * 沉在列表里等于没发。
 *
 * 【为什么不写死日期】
 * 与赛事标题同理：发布日期由 baseDate 与 week 推导，改了起始日期，
 * 公告时间会自动跟着走，不会出现「公告日期在赛季开始之前」这种矛盾。
 * ============================================================
 */
const ANNOUNCEMENT_SEED = [
  {
    week: 0,
    category: '通知',
    pinned: true,
    title: '2026 春季学期开训通知',
    content:
      '本周起每周三、周五 18:00 在体育馆 1 号场常规训练，新老会员均可参加。请自备球拍，活动用球由俱乐部提供。',
  },
  {
    week: 3,
    category: '赛事',
    pinned: false,
    title: '男子单打赛报名开始',
    content:
      '本周六举行本赛季首场男子单打赛，11 分制三局两胜，取前八名。请在小程序内报名，名额有限。',
  },
  {
    week: 5,
    category: '赛事',
    pinned: false,
    title: '女子单打赛报名开始',
    content: '本周六举行女子单打赛，15 分制三局两胜。欢迎各位女会员踊跃参加。',
  },
  {
    week: 8,
    category: '战报',
    pinned: false,
    title: '首场单打赛战报',
    content:
      '男子、女子单打赛已结束，完整名次与分数变动已录入小程序「排行榜」，可在个人主页查看自己的逐场战绩。',
  },
  {
    week: 12,
    category: '通知',
    pinned: false,
    title: '等级分计算规则说明',
    content:
      '等级分采用 ELO 算法，单打与双打各自独立计分，互不影响。新会员的前 10 场为定级期，分数变动会略大，属正常现象。',
  },
  {
    week: 16,
    category: '战报',
    pinned: false,
    title: '双打赛战报',
    content:
      '双打赛不区分性别，男双、女双、混双同池竞技。本场名次已更新，双打分数与单打完全独立。',
  },
];

/**
 * 生成公告列表。
 *
 * @param {Date} baseDate 赛季起始时刻
 * @returns {Array<Object>} 按发布时间倒序（最新的在前）
 */
function buildAnnouncements(baseDate) {
  return ANNOUNCEMENT_SEED.map((item, index) => {
    const publishTime = addDays(baseDate, item.week * 7);
    // 公告在中午发布，与晚上的比赛时间错开，时间线上不会挤在一起
    publishTime.setHours(12, 0, 0, 0);
    return {
      _id: 'a' + String(index + 1).padStart(2, '0'),
      title: item.title,
      content: item.content,
      category: item.category,
      pinned: item.pinned,
      publishTime,
    };
  }).sort((a, b) => b.publishTime - a.publishTime);
}

/**
 * 会员种子数据。
 * trueSkill 是隐藏的真实水平，仅用于模拟比赛结果，不对外展示。
 * 数值参考业余匹克球爱好者的大致分布：新手 1100 上下，高手 1700 上下。
 *
 * 【nickName 与 realName 的分工】
 * realName 是注册时登记的实名，nickName 是展示用的昵称。界面上昵称在
 * 前、真名小一号缀在旁边（见 templates/member-view.wxml）。校园社团里
 * 昵称多半就是名字本身或名字的后两字，所以这里：
 *   三字姓名 → 昵称取后两字（张宇轩 → 宇轩）
 *   两字姓名 → 昵称与真名相同，头卡上不重复显示
 * 这样既演示了「昵称 + 真名」的展示，又不会被硬凑出来的花名弄得失真。
 *
 * 【男女之间为什么刻意留出差距】
 * 男女单打合并成一个池之后，男女分数可以直接比较，这时候如果两组人的
 * 真实水平完全一样，实验就观察不到任何差异，「合并计算会不会埋没女生」
 * 这类问题也无从回答。因此这里按真实校园社团的普遍情况设定：
 *   男队：均值约 1470，最高 1690
 *   女队：均值约 1300，最高 1500
 * 整体差距约 170 分，落在 150~200 分的预期区间内。这个差距只体现在
 * 隐藏的 trueSkill 上，等级分仍然要靠回放自己长出来。
 */
const MEMBER_SEED = [
  { nickName: '巴特尔', realName: '巴特尔', gender: 'M', college: '体育学院', trueSkill: 1690 },
  { nickName: '宇轩', realName: '张宇轩', gender: 'M', college: '信息工程学院', trueSkill: 1655 },
  { nickName: '思远', realName: '李思远', gender: 'M', college: '经济学院', trueSkill: 1620 },
  { nickName: '浩然', realName: '王浩然', gender: 'M', college: '管理学院', trueSkill: 1585 },
  { nickName: '子涵', realName: '刘子涵', gender: 'M', college: '理学院', trueSkill: 1550 },
  { nickName: '明宇', realName: '赵明宇', gender: 'M', college: '法学院', trueSkill: 1510 },
  { nickName: '俊杰', realName: '吴俊杰', gender: 'M', college: '历史文化学院', trueSkill: 1475 },
  { nickName: '凯文', realName: '郑凯文', gender: 'M', college: '信息工程学院', trueSkill: 1440 },
  { nickName: '伟豪', realName: '黄伟豪', gender: 'M', college: '生命与环境科学学院', trueSkill: 1405 },
  { nickName: '小龙', realName: '马小龙', gender: 'M', college: '民族学与社会学学院', trueSkill: 1365 },
  { nickName: '志强', realName: '高志强', gender: 'M', college: '体育学院', trueSkill: 1320 },
  { nickName: '天磊', realName: '谢天磊', gender: 'M', college: '教育学院', trueSkill: 1280 },
  { nickName: '曹阳', realName: '曹阳', gender: 'M', college: '外国语学院', trueSkill: 1235 },
  { nickName: '卓玛', realName: '卓玛', gender: 'F', college: '中国少数民族语言文学学院', trueSkill: 1500 },
  { nickName: '陈曦', realName: '陈曦', gender: 'F', college: '美术学院', trueSkill: 1455 },
  { nickName: '阿依古丽', realName: '阿依古丽·买买提', gender: 'F', college: '音乐学院', trueSkill: 1425 },
  { nickName: '雨桐', realName: '周雨桐', gender: 'F', college: '经济学院', trueSkill: 1385 },
  { nickName: '孙悦', realName: '孙悦', gender: 'F', college: '法学院', trueSkill: 1350 },
  { nickName: '林清', realName: '林清', gender: 'F', college: '哲学与宗教学学院', trueSkill: 1300 },
  { nickName: '梦琪', realName: '徐梦琪', gender: 'F', college: '管理学院', trueSkill: 1255 },
  { nickName: '静怡', realName: '何静怡', gender: 'F', college: '教育学院', trueSkill: 1225 },
  // 以下会员在中途加入俱乐部。
  // 他们的初始分不走固定值，而是按「入会后前五场对手的水平」定出来，
  // 这样进步榜才有真实意义：可以衡量他们入会之后的涨分幅度。
  { nickName: '雨欣', realName: '罗雨欣', gender: 'F', college: '外国语学院', trueSkill: 1180, joinWeek: 5 },
  { nickName: '韩雪', realName: '韩雪', gender: 'F', college: '历史文化学院', trueSkill: 1140, joinWeek: 5 },
  { nickName: '紫琳', realName: '邓紫琳', gender: 'F', college: '民族学与社会学学院', trueSkill: 1085, joinWeek: 10 },
];

/**
 * 单打对局中「男女对打」的占比。
 *
 * 【为什么一定要留出男女对打】
 * 男女单打合并成一个池，只有真的产生过男女之间的对局，两条分数才在
 * 同一把尺子上量过。若单打永远同性对打，男榜和女榜虽然共用池子，
 * 实际上仍是两个互不相通的封闭系统，分数不可比——那还不如分成两个池。
 *
 * 取四分之一：既能保证每个人隔一段时间就会碰到异性对手，又不至于让
 * 对局构成过于失真（现实中大多数时候还是同性之间约球）。
 */
const SINGLES_MIXED_RATIO = 0.25;

/** 赛事名称里的性别前缀 */
const GENDER_LABEL = {
  M: '男子',
  F: '女子',
};

const DAY_MS = 86400000;

/**
 * 在基准日期上增加天数。
 * @param {Date} base
 * @param {number} days
 * @returns {Date}
 */
function addDays(base, days) {
  return new Date(base.getTime() + days * DAY_MS);
}

/**
 * 校验某场赛事的候选人数是否够用。
 *
 * 中途入会的会员在早期周次尚未加入，若人数不足，slice 会静默生成出
 * 残缺的对阵表（比如 8 人赛事只排出 3 场），回放时才发现就晚了。
 * 因此在生成阶段直接抛错，让问题立刻暴露。
 *
 * @param {Array<Object>} candidates 候选会员
 * @param {number} needed 需要的名额
 * @param {string} title 赛事名称，用于错误提示
 * @throws {Error} 人数不足时抛出
 */
function assertEnough(candidates, needed, title) {
  if (candidates.length < needed) {
    throw new Error(
      `「${title}」需要 ${needed} 名会员，但当时只有 ${candidates.length} 名可用`
    );
  }
}

/**
 * 计算 A 战胜 B 的概率。
 *
 * 用与 ELO 相同的 400 分刻度，含义是「实力高 400 分者胜率约 10:1」。
 * 这里作用于隐藏真实水平，而不是当前等级分——这正是模拟的关键：
 * 等级分是对真实水平的「估计」，而比赛结果由真实水平决定。
 *
 * @param {number} skillA A 的真实水平
 * @param {number} skillB B 的真实水平
 * @returns {number} A 的获胜概率
 */
function winProbability(skillA, skillB) {
  return 1 / (1 + Math.pow(10, (skillB - skillA) / 400));
}

/**
 * 生成一局的比分。
 *
 * @param {Function} random
 * @param {number} winnerWinProb 胜方的胜率，越接近 1 分差越大
 * @param {number} [gamePoints=11] 该局的目标分（11 / 15 / 21）
 * @returns {{winner:number, loser:number}}
 */
function generateGameScore(random, winnerWinProb, gamePoints = 11) {
  // dominance: 0 表示势均力敌，1 表示碾压
  const dominance = Math.min(1, Math.abs(winnerWinProb - 0.5) * 2);

  // 平分线：11 分制是 10，15 分制是 14，21 分制是 20。
  // 到了这条线就必须净胜 2 分，且不封顶。
  const deuceLine = gamePoints - 1;

  // 败方得分：碾压时约为平分线的三成，势均力敌时贴着平分线
  let loser = Math.round(deuceLine - dominance * deuceLine * 0.7 + (random() - 0.5) * 2);
  loser = Math.max(1, Math.min(deuceLine, loser));

  // 匹克球规则：先到目标分且领先 2 分获胜；平分之后一路加上去
  const winner = loser >= deuceLine ? loser + 2 : gamePoints;
  return { winner, loser };
}

/**
 * 生成一场比赛的逐局比分。
 *
 * 【为什么要把决胜局固定放在最后】
 * 输赢是先定的，比分要反过来「讲得通」。曾经的写法是随机挑一局让败方赢，
 * 结果会出现「胜方先赢两局、第三局却还在打」这种根本不可能发生的比分
 * （642 场里错了 100 场）。正确的构造是：
 *   先摆好「胜方 need-1 局 + 败方若干局」，打乱，最后再补上决胜局。
 * 这样无论怎么打乱，比赛都是在胜方拿到第 need 局时恰好结束。
 *
 * @param {Function} random
 * @param {boolean} teamAWins A 队是否获胜
 * @param {number} probA A 队的胜率
 * @param {Object} [format] 赛制 { gamePoints, bestOf }
 * @returns {{scoreA:number[], scoreB:number[]}}
 */
function generateMatchScore(random, teamAWins, probA, format = DEFAULT_FORMAT) {
  const { gamePoints, bestOf } = format;
  const need = gamesToWin(bestOf);

  const winnerProb = teamAWins ? probA : 1 - probA;
  // 势均力敌时败方更可能抢下一局
  const closeness = 1 - Math.min(1, Math.abs(winnerProb - 0.5) * 2);
  // 败方最多抢下 need-1 局，再多赢的就是败方了
  const maxLoserGames = need - 1;
  const loserTakesGames = maxLoserGames > 0 && random() < closeness * 0.65;
  const loserGames = loserTakesGames ? randomInt(random, 1, maxLoserGames) : 0;

  const order = shuffle(random, [
    ...Array(need - 1).fill(teamAWins),
    ...Array(loserGames).fill(!teamAWins),
  ]);
  order.push(teamAWins); // 决胜局由胜方拿下

  const scoreA = [];
  const scoreB = [];
  for (const aWinsGame of order) {
    const { winner, loser } = generateGameScore(random, winnerProb, gamePoints);
    scoreA.push(aWinsGame ? winner : loser);
    scoreB.push(aWinsGame ? loser : winner);
  }

  return { scoreA, scoreB };
}

/**
 * 把一场对局的信息组装成比赛记录。
 *
 * @param {Object} params
 * @returns {Object} 比赛记录（不含等级分变动，那由回放引擎填入）
 */
function buildMatch({ id, matchType, teamA, teamB, teamAWins, probA, matchTime, recorder, eventId, random, location, format = DEFAULT_FORMAT }) {
  const { scoreA, scoreB } = generateMatchScore(random, teamAWins, probA, format);

  return {
    _id: id,
    matchType,
    pool: MATCH_TYPE_TO_POOL[matchType],
    teamA,
    teamB,
    scoreA,
    scoreB,
    // 赛制必须跟着比分一起存：脱离赛制就看不出 11:9 到底是打完没有，
    // 一场 21 分制的比赛和一局 11 分制的比赛，同样的数字含义完全不同
    gamePoints: format.gamePoints,
    bestOf: format.bestOf,
    winner: teamAWins ? 'A' : 'B',
    location: location || pick(random, VENUES),
    matchTime,
    recorder: recorder || teamA[0],
    status: MATCH_STATUS.ACTIVE,
    eventId: eventId || null,
  };
}

/**
 * 模拟一场对局，返回胜方与双方胜率。
 *
 * @param {Function} random
 * @param {number} skillA A 队平均真实水平
 * @param {number} skillB B 队平均真实水平
 * @returns {{teamAWins:boolean, probA:number}}
 */
function simulateOutcome(random, skillA, skillB) {
  const probA = winProbability(skillA, skillB);
  return { teamAWins: random() < probA, probA };
}

/**
 * 生成标准种子排位表。
 *
 * 【为什么不能按实力两两相邻配对】
 * 若把 8 人按实力排成 1,2,3,4,5,6,7,8 再 (1,2)(3,4)(5,6)(7,8) 配对，
 * 头号种子与二号种子第一轮就要碰面，最强的两人必有一个首轮出局，
 * 赛事含金量大打折扣。标准排位把强手分散到不同半区，让高种子在决赛前
 * 都遇不上彼此，这才是真实赛事的编排习惯。
 *
 * 返回「位置 → 种子序号」的数组。8 人时为 [1,8,4,5,2,7,3,6]，
 * 即 (1 对 8)(4 对 5)(2 对 7)(3 对 6)。
 *
 * 递推构造：规模每扩大一倍，原有序列中每个种子 s 后面补一个
 * (新规模 + 1 - s)，凑成「和为 新规模+1」的对称对。
 *
 * @param {number} size 参赛规模，必须是 2 的幂次
 * @returns {number[]} 各位置应放置的种子序号（从 1 开始）
 */
function standardSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const roundSize = order.length * 2;
    const next = [];
    for (const seed of order) {
      next.push(seed);
      next.push(roundSize + 1 - seed);
    }
    order = next;
  }
  return order;
}

/**
 * 运行单败淘汰赛。
 *
 * 采用标准种子排位（1 对 8、4 对 5、2 对 7、3 对 6），
 * 让高水平选手在早期轮次避开彼此，符合真实赛事编排习惯。
 *
 * @param {Object} params
 * @param {Array<Object>} params.entries 参赛条目，每项 { key, players:[userId], skill }
 * @param {Function} params.random
 * @param {Date} params.startTime 赛事开始时间
 * @param {number} params.matchType 比赛类型
 * @param {string} params.eventId 所属赛事编号
 * @param {Object} [params.format] 该赛事采用的赛制
 * @returns {{matches:Array, placements:Object}} placements 为 { 条目key: 名次 }
 */
function simulateBracket({ entries, random, startTime, matchType, eventId, format = DEFAULT_FORMAT }) {
  const seeded = [...entries].sort((a, b) => b.skill - a.skill);
  const totalRounds = Math.log2(seeded.length);

  if (!Number.isInteger(totalRounds)) {
    throw new Error('淘汰赛参赛条目数必须是 2 的幂次，当前为 ' + seeded.length);
  }

  const matches = [];
  const placements = {};
  // 按标准种子顺序重新摆放，而不是简单地按实力两两相邻
  let roundEntries = standardSeedOrder(seeded.length).map((seed) => seeded[seed - 1]);
  let matchCounter = 0;

  for (let round = 0; round < totalRounds; round += 1) {
    const nextRound = [];

    for (let i = 0; i < roundEntries.length; i += 2) {
      const a = roundEntries[i];
      const b = roundEntries[i + 1];
      const { teamAWins, probA } = simulateOutcome(random, a.skill, b.skill);
      const winnerEntry = teamAWins ? a : b;
      const loserEntry = teamAWins ? b : a;

      matches.push(
        buildMatch({
          id: `${eventId}-m${matchCounter}`,
          matchType,
          teamA: a.players,
          teamB: b.players,
          teamAWins,
          probA,
          // 同一轮次内错开时间，越靠后的轮次日期越晚
          matchTime: addDays(startTime, round),
          recorder: a.players[0],
          eventId,
          format,
          random,
        })
      );
      matchCounter += 1;

      // 名次公式：第 r 轮出局者名次为 2^(总轮数-r-1) + 1
      placements[loserEntry.key] = Math.pow(2, totalRounds - round - 1) + 1;
      nextRound.push(winnerEntry);
    }

    roundEntries = nextRound;
  }

  // 最后一轮的胜者即冠军
  if (roundEntries.length === 1) {
    placements[roundEntries[0].key] = 1;
  }

  return { matches, placements };
}

/**
 * 生成全部模拟数据。
 *
 * 【为什么场次要给到这个量级】
 * ELO 收敛得比直觉慢得多。以 K=32 估算，一个人在某池里大约要打
 * 三四十场，分数才贴近真实水平；只打七八场的话，所有人都会挤在
 * 1500 分附近，榜单看不出任何区分度。所以这里按「每周 30 场、
 * 持续 20 周」的强度生成，让每位会员在每个池里都能积累约 30 场。
 *
 * @param {Object} [options]
 * @param {number} [options.seed] 随机种子，换数字即可得到一整套新数据
 * @param {string} [options.startDate] 起始日期
 * @param {number} [options.weeks=20] 模拟周数
 * @param {number} [options.casualPerWeek=30] 每周约球场次
 * @param {number} [options.mixedRatio] 单打里男女对打的占比，默认值见 SINGLES_MIXED_RATIO。
 *        单独开这个口子是为了做「混打比例 → 男女分数可比性」的对照实验：
 *        把比例调到 0 就能看到两个性别组各自封闭时会是什么结果。
 * @returns {{members:Array, matches:Array, events:Array, meta:Object}}
 */
function generateSeed(options = {}) {
  const {
    seed = DEFAULT_SEED,
    startDate = DEFAULT_START_DATE,
    weeks = 20,
    casualPerWeek = 30,
    mixedRatio = SINGLES_MIXED_RATIO,
  } = options;

  const random = createSeededRandom(seed);
  const baseDate = new Date(startDate + 'T18:00:00');

  // ---------- 1. 会员 ----------
  const members = MEMBER_SEED.map((item, index) => ({
    _id: 'u' + String(index + 1).padStart(2, '0'),
    // 昵称在前，真名缀在旁边——两者的分工见 MEMBER_SEED 的说明
    nickName: item.nickName,
    realName: item.realName,
    // 学号是实名信息，不可修改；这里按序号编一个稳定的号码供演示
    studentId: '2023' + String(index + 1).padStart(4, '0'),
    gender: item.gender,
    college: item.college,
    avatarUrl: '',
    points: 0,
    role: 0,
    status: 1,
    joinDate: addDays(baseDate, (item.joinWeek || 0) * 7),
    // 以下两个字段仅供模拟使用，回放结束时会被剔除，不进入对外数据
    trueSkill: item.trueSkill,
    joinWeek: item.joinWeek || 0,
  }));

  const byId = {};
  for (const m of members) {
    byId[m._id] = m;
  }

  const men = members.filter((m) => m.gender === 'M');
  const women = members.filter((m) => m.gender === 'F');

  /**
   * 截至第 week 周时已经入会的会员。
   *
   * 中途入会的人不能出现在入会之前的比赛里，否则会产生
   * 「人还没入会就有战绩」这种自相矛盾的数据。
   *
   * @param {number} week 周序号（从 0 开始）
   * @param {Array<Object>} [pool] 可选的候选分组，默认全体会员
   * @returns {Array<Object>} 该周可参加比赛的会员
   */
  const activeAt = (week, pool) => (pool || members).filter((m) => m.joinWeek <= week);

  const matches = [];
  let matchSeq = 0;
  const nextMatchId = () => 'm' + String((matchSeq += 1)).padStart(3, '0');

  /** 计算一组选手的平均真实水平 */
  const avgSkill = (ids) => ids.reduce((s, id) => s + byId[id].trueSkill, 0) / ids.length;

  // ---------- 2. 每周日常约球 ----------
  for (let week = 0; week < weeks; week += 1) {
    for (let i = 0; i < casualPerWeek; i += 1) {
      // 每天安排若干场，时间分散在一周内
      const day = week * 7 + randomInt(random, 0, 5);
      // 起始时刻就是 18:00，约球时间必须落在 18 点及以后。
      // 若允许 17 点，第 w 周第一天的 17:xx 会排到起始时刻之前，
      // 按「距起始时刻过了几周」折算就成了第 w-1 周，于是当晚刚入会的人
      // 会出现在入会前的比赛里——测试里那条「入会前不得出场」正是这么挂的。
      const hour = randomInt(random, 18, 21);
      const matchTime = new Date(addDays(baseDate, day).setHours(hour, randomInt(random, 0, 59)));

      // 双打最受欢迎，其余都是单打。
      // 单打不再拆成「男单 / 女单」两种比赛类型——合并成一个池之后，
      // 区分只在「谁和谁打」上体现，不再影响分数的归属。
      const matchType = random() < 0.45 ? MATCH_TYPE.DOUBLES : MATCH_TYPE.SINGLES;

      let teamA;
      let teamB;

      if (matchType === MATCH_TYPE.DOUBLES) {
        // 双打：四名随机会员，不分性别
        const four = shuffle(random, activeAt(week)).slice(0, 4);
        teamA = [four[0]._id, four[1]._id];
        teamB = [four[2]._id, four[3]._id];
      } else {
        // 单打：同性对打为主，留四分之一给男女对打
        const menNow = activeAt(week, men);
        const womenNow = activeAt(week, women);

        let two;
        if (random() < mixedRatio) {
          two = [pick(random, menNow), pick(random, womenNow)];
        } else {
          // 同性对打时按两组的人数分配场次，否则人少的一组会「吃不饱」，
          // 分数永远定不下来，男榜女榜的可比性也就无从谈起。
          const menShare = menNow.length / (menNow.length + womenNow.length);
          const group = random() < menShare ? menNow : womenNow;
          two = shuffle(random, group).slice(0, 2);
        }

        teamA = [two[0]._id];
        teamB = [two[1]._id];
      }

      const { teamAWins, probA } = simulateOutcome(random, avgSkill(teamA), avgSkill(teamB));

      matches.push(
        buildMatch({
          id: nextMatchId(),
          matchType,
          teamA,
          teamB,
          teamAWins,
          probA,
          matchTime,
          recorder: teamA[0],
          eventId: null,
          format: pick(random, CASUAL_FORMATS),
          random,
        })
      );
    }
  }

  // ---------- 3. 赛事（单败淘汰） ----------
  // 六场赛事刻意用满三种分制和三种局制：赛事是赛制最容易被改来改去的地方，
  // 让模拟数据先覆盖全，界面上「11 分制 · 三局两胜」这类文案才有各种样本可看。
  //
  // 单打赛事仍然分男子组和女子组：分数池合并了，但比赛本身还是分组的，
  // 就像现实中的校赛——同一个池只是让两个组的名次能放在一起比较。
  const eventPlan = [
    { week: 3, matchType: MATCH_TYPE.SINGLES, gender: 'M', size: 8, format: { gamePoints: 11, bestOf: 3 } },
    { week: 5, matchType: MATCH_TYPE.SINGLES, gender: 'F', size: 8, format: { gamePoints: 15, bestOf: 3 } },
    { week: 7, matchType: MATCH_TYPE.DOUBLES, size: 8, format: { gamePoints: 11, bestOf: 5 } },
    { week: 11, matchType: MATCH_TYPE.SINGLES, gender: 'M', size: 8, format: { gamePoints: 21, bestOf: 1 } },
    { week: 12, matchType: MATCH_TYPE.SINGLES, gender: 'F', size: 8, format: { gamePoints: 15, bestOf: 5 } },
    { week: 15, matchType: MATCH_TYPE.DOUBLES, size: 8, format: { gamePoints: 21, bestOf: 3 } },
  ];

  const events = [];

  eventPlan.forEach((plan, eventIndex) => {
    const eventId = 'e' + String(eventIndex + 1).padStart(2, '0');
    const startTime = addDays(baseDate, plan.week * 7);
    // 赛事名由实际日期推导，而不是写死「五月」「六月」。
    // 这样改了起始日期或周次安排，标题也会自动跟着对，不会名不副实。
    const scope = plan.gender ? GENDER_LABEL[plan.gender] : '';
    const title = `${startTime.getMonth() + 1}月${scope}${MATCH_TYPE_LABEL[plan.matchType]}赛`;

    // 挑选参赛者：单打按组别挑人，双打从全体中抽签组队
    let entries;
    if (plan.matchType === MATCH_TYPE.DOUBLES) {
      // 双打需要 2 × size 名会员两两组队
      const candidates = shuffle(random, activeAt(plan.week));
      assertEnough(candidates, plan.size * 2, title);
      entries = [];
      for (let i = 0; i < plan.size; i += 1) {
        const players = [candidates[i * 2]._id, candidates[i * 2 + 1]._id];
        entries.push({ key: players.join('+'), players, skill: avgSkill(players) });
      }
    } else {
      const group = plan.gender === 'M' ? men : women;
      const candidates = shuffle(random, activeAt(plan.week, group));
      assertEnough(candidates, plan.size, title);
      entries = candidates.slice(0, plan.size).map((m) => ({
        key: m._id,
        players: [m._id],
        skill: m.trueSkill,
      }));
    }

    const { matches: eventMatches, placements } = simulateBracket({
      entries,
      random,
      startTime,
      matchType: plan.matchType,
      eventId,
      format: plan.format,
    });

    // 把名次摊平到每位参赛者身上
    const results = [];
    for (const entry of entries) {
      for (const userId of entry.players) {
        results.push({ userId, placement: placements[entry.key] });
      }
    }

    matches.push(...eventMatches);
    events.push({
      _id: eventId,
      title,
      description: '俱乐部常规赛事，单败淘汰制，取胜者晋级',
      matchType: plan.matchType,
      pool: MATCH_TYPE_TO_POOL[plan.matchType],
      location: '学校体育馆 1 号场',
      startTime,
      endTime: addDays(startTime, 1),
      // quota 一律按「人数」计。双打 8 支队伍即 16 人，
      // 这样 results.length 恒等于 quota，界面直接显示「16/16」即可，
      // 不必再区分项目类型做换算。
      quota: results.length,
      status: 2, // 已结束
      results,
    });
  });

  // 全部对局按时间升序排列，回放引擎依赖这个顺序
  matches.sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime));

  return {
    members,
    matches,
    events,
    announcements: buildAnnouncements(baseDate),
    meta: {
      seed,
      weeks,
      generatedAt: baseDate,
      memberCount: members.length,
      matchCount: matches.length,
      eventCount: events.length,
    },
  };
}

module.exports = {
  DEFAULT_SEED,
  MEMBER_SEED,
  VENUES,
  ANNOUNCEMENT_SEED,
  buildAnnouncements,
  winProbability,
  generateGameScore,
  generateMatchScore,
  simulateBracket,
  generateSeed,
};
