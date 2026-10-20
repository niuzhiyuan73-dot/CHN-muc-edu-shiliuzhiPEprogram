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
    totals: { ...totals, appearanceGames: isFootball ? totals.games || 0 : totals.appearanceGames || 0 },
    statCells: cellsOf(totals),
    statEvents: (profile.statEvents || []).map(row => ({ ...row, statCells: cellsOf(row) })),
  };
}
module.exports = { teamProfileView };
