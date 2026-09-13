/**
 * 学院赛演示场景（仅本地模拟数据源装载）
 * ============================================================
 * 模拟器的学院赛原本是空的：种子里一场都没有，得从「发布 → 收名单 →
 * 抽签 → 排阵 → 录分」一路点下来才能看到比赛的样子。这个模块把一条
 * 已经推进到半途的赛程直接装进数据源，开机打开学院赛页就能看到：
 *
 *   · 赛事「2026 院际匹克球团体赛」正在进行（16 所学院、团体单败）
 *   · 第一轮 16 进 8 已全部打完
 *   · 第二轮 八进四 已打完三场，只剩法学院那场停在「待排阵」
 *   · 演示账号 u06 赵明宇是法学院干事，本人不参赛
 *
 * 【为什么不是手写一份静态快照】
 * 场景里的每一场比分、每一次晋级都应由真实的赛制规则推出来，才经得起
 * 后人改动规则后的复核。所以这里不落一份写死的 JSON，而是按真人操作
 * 顺序把同一批动作重放一遍（与 tests/college-demo.test.js 曾用过的脚本
 * 同源）。规则一变，装出来的场景跟着变，不会与赛制脱节。
 *
 * 【为什么全同步】
 * mock 的动作函数虽然都声明为 async，但函数体里没有任何 await（整个
 * mock.js 只有 resetSeason 一处 await），调用即完成全部写入，返回值只是
 * 一句已经落定的承诺。因此这里可以同步地把整条链路走完，无需在模块
 * 加载期引入异步时序——同步装好，第一次读到学院赛数据时它就一定在了。
 * 代价是拿不到那些 Promise 的返回值，所以每一步都从台账 store 回读结果，
 * 而不是依赖返回值。
 *
 * 【不进云函数镜像】
 * 这是 mock 专用的演示数据，云端没有对应概念，因此不在
 * tools/sync-cloud-lib.js 的 MANIFEST 里，也不会被镜像到 cloudfunctions。
 * ============================================================
 */

const { playersPerLeg } = require('./college-lineup.js');
const { USER_STATUS, LEG_DISCIPLINE, TIE_ALGO, TIE_NET_MODE } = require('../utils/constants.js');

/** 种子里的管理员，全场规则性操作都由他做 */
const ADMIN_ID = 'u01';
/** 演示账号：赵明宇，本场被任命为法学院干事 */
const LEADER_ID = 'u06';
const LAW_COLLEGE = '法学院';
/** 种子里只有 15 所学院有会员，补的这一所用于凑满 16 签位 */
const EXTRA_MEMBER = {
  realName: '顾清和',
  nickName: '清和',
  gender: 'F',
  studentId: '20240099',
  college: '文学院',
  phone: '13800000099',
};

/**
 * 把学院赛演示场景装进数据源。
 *
 * 纯同步：调用返回时台账已就位。中间任何一步凑不齐（例如种子被改到
 * 凑不出 16 所学院）就安全地停下，留给调用方一个可用的部分场景，绝不抛。
 *
 * @param {Object} deps
 * @param {Function} deps.load 数据源内部的 load()，同步取回当前缓存（含 members）
 * @param {Object} deps.actions mock 的动作函数（只为产生写入，返回值一律忽略）
 * @param {Object} deps.stores 台账：collegeStore / matchStore / userStore
 * @returns {Object|null} 装好的赛事记录；中途放弃时返回 null
 */
function installCollegeDemo(deps) {
  const { load, actions, stores } = deps;
  const { collegeStore, matchStore, userStore } = stores;

  /** 当前在册会员（每次回读，因为前面的写入会重建缓存） */
  const members = () => load().members;

  /** 某学院可以上场的会员编号（在册、且不是干事——干事不参赛） */
  const rosterIdsOf = (college) =>
    members()
      .filter(
        (member) =>
          member.college === college &&
          member.status === USER_STATUS.ACTIVE &&
          member._id !== LEADER_ID
      )
      .map((member) => member._id);

  /** 替某学院排阵的人：法学院的名单交给干事，其余学院由管理员代劳 */
  const lineupActorOf = (college) => (college === LAW_COLLEGE ? LEADER_ID : ADMIN_ID);

  /** 按每个小项需要的人数排人；单打 1 人，双打 2 人（本场景只用到单打） */
  const lineupEntries = (ids, legs) =>
    legs.map((leg) => {
      const need = playersPerLeg(leg.discipline);
      const players = [];
      for (let i = 0; i < need; i += 1) players.push(ids[i % ids.length]);
      return { legNo: leg.legNo, players };
    });

  /** 取某大场里某场小场刚生成的比赛记录（从本地台账回读） */
  const legMatchOf = (tie, legNo) => {
    const leg = tie.legs.find((item) => Number(item.legNo) === Number(legNo));
    if (!leg) return null;
    return matchStore.listSubmitted().find((match) => match._id === leg.matchId) || null;
  };

  /** 录一场 11:5 的比分并由对手确认生效 */
  const settleLeg = (tie, legNo, winnerIsA) => {
    const match = legMatchOf(tie, legNo);
    if (!match) return;
    const winnerId = winnerIsA ? match.teamA[0] : match.teamB[0];
    const loserId = winnerIsA ? match.teamB[0] : match.teamA[0];
    actions.submitMatch({
      id: match._id,
      scoreA: winnerIsA ? ['11'] : ['5'],
      scoreB: winnerIsA ? ['5'] : ['11'],
      actor: winnerId,
    });
    actions.confirmMatch(match._id, loserId);
  };

  /** 打完一场大场：双方排阵 → 管理员开始 → 逐小项录分确认 */
  const playTie = (tie, winCollege) => {
    for (const college of [tie.collegeA, tie.collegeB]) {
      const ids = rosterIdsOf(college);
      // 凑不出名单就整场放弃，避免只排一半留下畸形大场
      if (!ids.length) return;
      actions.submitLineup(
        { tieId: tie._id, college, entries: lineupEntries(ids, tie.legs) },
        lineupActorOf(college)
      );
    }
    actions.startTie(tie._id, ADMIN_ID);

    const started = collegeStore.findTie(tie._id);
    if (!started) return;
    const winIsA = tie.collegeA === winCollege;
    for (const leg of started.legs) settleLeg(started, leg.legNo, winIsA);
  };

  // 1. 补第 16 所学院：种子里只有 15 所学院有会员（注册 → 管理员审核通过）
  actions.registerMember(EXTRA_MEMBER, { now: new Date('2026-08-01T09:00:00') });
  const extra = userStore
    .listAccounts()
    .find((account) => account.studentId === EXTRA_MEMBER.studentId);
  if (!extra) return null;
  actions.approveMember(extra._id, ADMIN_ID);

  // 2. 任命赵明宇为法学院干事（本人不参赛，见 rosterIdsOf 的排除）
  actions.setCollegeLeader(LEADER_ID, ADMIN_ID, true);

  // 3. 发布学院赛：团体单败，一场大场打男单 + 女单
  actions.publishCollegeEvent(
    {
      title: '2026 院际匹克球团体赛',
      description: '16 所学院单败淘汰；当前进度：16 进 8 已打完，八进四进行中',
      legPlan: [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS],
      allowMultiEntry: true,
      rosterMin: 1,
      rosterMax: 20,
      tieAlgo: TIE_ALGO.FULL_POINTS,
      tieNetMode: TIE_NET_MODE.WIN_DIFF,
      startTime: '2026-09-20T09:00:00',
      location: '学校体育馆',
    },
    ADMIN_ID
  );
  const event = collegeStore.listEvents().slice(-1)[0];
  if (!event) return null;

  // 4. 16 所学院交名单（干事本人不进名单）→ 管理员逐份审核通过
  const colleges = Array.from(new Set(members().map((member) => member.college))).sort();
  for (const college of colleges) {
    const memberIds = rosterIdsOf(college);
    if (!memberIds.length) return event;
    actions.submitCollegeEntry({ eventId: event._id, college, memberIds }, ADMIN_ID);
  }
  for (const entry of collegeStore.listEntries(event._id)) {
    actions.reviewCollegeEntry(entry._id, 'approve', '', ADMIN_ID);
  }

  // 5. 抽签（名单就此锁定）→ 赛事级开始，生成首轮 8 场
  actions.drawCollegeEvent(event._id, ADMIN_ID, { seedValue: 20260920 });
  actions.startCollegeEvent(event._id, ADMIN_ID);
  const round1 = collegeStore
    .listTies(event._id)
    .filter((tie) => Number(tie.round) === 1);
  if (round1.length !== 8) return event;

  // 6. 打完 16 进 8，法学院所在的那场让法学院赢
  for (const tie of round1) playTie(tie, LAW_COLLEGE);

  // 7. 八进四：打掉不含法学院的三场，把法学院那场留成「待排阵」
  const round2 = collegeStore
    .listTies(event._id)
    .filter((tie) => Number(tie.round) === 2);
  const lawTie = round2.find(
    (tie) => tie.collegeA === LAW_COLLEGE || tie.collegeB === LAW_COLLEGE
  );
  for (const tie of round2) {
    if (lawTie && tie._id === lawTie._id) continue;
    playTie(tie, tie.collegeA);
  }

  return collegeStore.findEvent(event._id);
}

module.exports = { installCollegeDemo };
