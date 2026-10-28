/** 只整形已获授权的展示数据，不推导写权限、不触发读取。 */
function eventProgress(kind, event = {}) {
  let labels, index = -1;
  if (kind === 'college') { labels = ['学院报名', '抽签锁定', '排阵比赛', '名次']; index = [0, 1, 2, 3].indexOf(event.status); }
  else if (kind === 'team') {
    labels = ['球队报名', '名单锁定', '赛程', '比赛审核', '名次'];
    index = ({ registration: 0, locked: 1, scheduled: 2, running: 3, finished: 4 })[event.status];
  } else if (kind === 'meet') {
    labels = ['筹备', '报名', '赛程', '录分发布', '总榜'];
    index = ({ draft: 0, registration: 1, scheduled: 2, running: 3, finished: 4, archived: 4 })[event.status];
  } else {
    labels = ['报名', '抽签', '比赛', '名次'];
    index = event.status === 2 ? 3 : event.status === 1 ? 2 : event.status === 0 ? (event.drawn || event.draw ? 1 : 0) : -1;
  }
  return labels.map((label, position) => ({ label, position, current: position === index, done: Number.isInteger(index) && position < index }));
}

function errorItems(errors = {}, labels = {}) {
  return Object.keys(errors).filter(key => errors[key]).map(key => ({ key, label: labels[key] || key, message: String(errors[key]) }));
}

function selectedMembers(rows = [], ids = []) {
  const byId = new Map(rows.map(row => [row.userId || row.memberId || row._id, row]));
  return [...new Set(ids)].map(id => {
    const row = byId.get(id);
    return { userId: id, name: row ? row.nickName || row.name || id : '已选会员（待核实）', available: Boolean(row) };
  });
}

const reportFields = { ownGoals: '乌龙', fouls: '犯规', secondYellow: '第二黄罚下', directRed: '直接红牌', goals: '进球', assists: '助攻', yellowCards: '黄牌', redCards: '红牌', saves: '扑救',
  starter: '首发', appeared: '出场', goalkeeper: '守门员', minutesPlayed: '出场分钟', shots: '射门', shotsOnTarget: '射正' };
const resultFields = { regulationScore: '常规比分', halfTimeScore: '半场比分', extraTimeScore: '加时比分', shootoutScore: '点球比分',
  awardedScore: '判定比分', kind: '比赛结果', note: '报告说明', extraTimeCompleted: '加时完成', refereeConfirmed: '裁判点球核对', forfeit: '弃权方' };
function displayValue(value) {
  if (value === null || value === undefined || value === '') return '未统计';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value && typeof value === 'object' && ('A' in value || 'B' in value)) return `${displayValue(value.A)} : ${displayValue(value.B)}`;
  const values = { completed: '正常完赛', forfeit: '弃权', interrupted: '中断', none: '未记录', partial: '部分记录', full: '完整记录' };
  return Object.prototype.hasOwnProperty.call(values, value) ? values[value] : String(value);
}
function reportDifferences(before, after, names = {}) {
  if (!before || !after) return { rows: [], total: 0, hasMore: false };
  const rows = [];
  const add = (key, label, a, b) => { if (displayValue(a) !== displayValue(b)) rows.push({ key, label, before: displayValue(a), after: displayValue(b) }); };
  Object.keys(resultFields).forEach(field => add(field, resultFields[field], before.result?.[field], after.result?.[field]));
  for (const side of ['A', 'B']) {
    const oldPlayers = new Map((before.sides?.[side]?.players || []).map(player => [player.userId, player]));
    const newPlayers = new Map((after.sides?.[side]?.players || []).map(player => [player.userId, player]));
    for (const id of new Set([...oldPlayers.keys(), ...newPlayers.keys()])) {
      const a = oldPlayers.get(id), b = newPlayers.get(id), name = names[id] || id;
      if (!a || !b) add(`${side}-${id}`, `${side}队 · ${name} · 名单`, a ? '在名单' : '不在名单', b ? '在名单' : '不在名单');
      else Object.keys(reportFields).forEach(field => add(`${side}-${id}-${field}`, `${side}队 · ${name} · ${reportFields[field]}`, a[field], b[field]));
    }
    if (JSON.stringify(before.sides?.[side]?.coverage) !== JSON.stringify(after.sides?.[side]?.coverage)) {
      rows.push({ key: `${side}-coverage`, label: `${side}队 · 统计覆盖范围`, before: '原报告范围', after: '覆盖范围已调整，请核对' });
    }
    if (JSON.stringify(before.sides?.[side]?.substitutions) !== JSON.stringify(after.sides?.[side]?.substitutions)) {
      rows.push({ key: `${side}-substitutions`, label: `${side}队 · 换人摘要`, before: '原报告摘要', after: '换人摘要已调整，请核对' });
    }
  }
  if (JSON.stringify(before.goalEvents || []) !== JSON.stringify(after.goalEvents || [])) rows.push({ key: 'goals', label: '进球明细', before: `${(before.goalEvents || []).length}条`, after: `${(after.goalEvents || []).length}条 · 内容有变化` });
  return { rows: rows.slice(0, 60), total: rows.length, hasMore: rows.length > 60 };
}
module.exports = { eventProgress, errorItems, selectedMembers, displayValue, reportDifferences };
