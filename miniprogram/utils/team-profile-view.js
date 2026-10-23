/** 独立成绩页与协会内“我的球队”页签共用展示形状，数值仍由后端公开快照计算。 */
const FOOTBALL_FIELDS = [
  ['goals', '进球'], ['assists', '助攻'], ['ownGoals', '乌龙'], ['yellowCards', '黄牌'],
  ['secondYellow', '第二黄罚下'], ['directRed', '直接红牌'], ['dismissals', '罚下合计'], ['fouls', '犯规'],
];
const BASKETBALL_FIELDS = [
  ['points', '得分'], ['rebounds', '篮板'], ['assists', '助攻'], ['steals', '抢断'],
  ['blocks', '盖帽'], ['turnovers', '失误'], ['fouls', '犯规'],
];
function teamProfileView(profile) {
  const isFootball = profile.sportFormat === 'football11';
  const definitions = isFootball ? FOOTBALL_FIELDS : BASKETBALL_FIELDS;
  const totals = profile.totals || {};
  const cellsOf = source => definitions.map(([field, label]) => {
    const total = source[field]; const matches = source[`${field}RecordedMatches`];
    const perGame = source[`${field}PerGameText`] ?? (Number.isInteger(total) && matches > 0
      ? String(Math.round(total / matches * 10) / 10) : '—');
    return { field, label, totalText: source[`${field}Text`] ?? '—', perGameText: perGame,
      recordedMatches: Number.isInteger(matches) ? matches : 0 };
  });
  return { ...profile, isFootball,
    teams: profile.teams || [], events: profile.events || [], honors: profile.honors || [],
    // 出场只有一个口径：服务端给的 appearanceGames。
    // 足球 = 赛后报告里逐场标了「实际出场」的场次；篮球 = 单场名单 ∪ 个人统计。
    // 足球原先退回 totals.games，值其实相同（aggregate 的 games 也只累加
    // appeared 行），但那是**另算一遍**的口径——两边一旦有一处改动就会分叉。
    // 现在统一由服务端给，view 只负责兜底旧接口。
    totals: { ...totals, appearanceGames: totals.appearanceGames ?? totals.games ?? 0 },
    statCells: cellsOf(totals),
    statEvents: (profile.statEvents || []).map(row => ({ ...row, statCells: cellsOf(row) })),
  };
}
module.exports = { teamProfileView };
