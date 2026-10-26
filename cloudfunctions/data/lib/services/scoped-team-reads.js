/** Team read primitives shared by both repositories. Every query includes its scope. */
function fieldValues(doc, path) {
  const parts = path.split('.');
  const walk = (value, index) => {
    if (Array.isArray(value)) return value.flatMap(item => walk(item, index));
    if (index === parts.length) return [value];
    return value == null ? [] : walk(value[parts[index]], index + 1);
  };
  return walk(doc, 0);
}
const unique = rows => [...new Map(rows.map(row => [row._id, row])).values()];
function attachTeamReads(surface, { inTx, query, byIds, command }) {
  if (!surface.teamMembers) return;
  const scope = { schoolId: surface.scope.schoolId, association: surface.scope.association };
  const select = async (key, field, values) => {
    if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
    const ids = [...new Set((Array.isArray(values) ? values : []).filter(id => typeof id === 'string' && id))];
    const rows = [];
    for (let index = 0; index < ids.length; index += 100) {
      rows.push(...await query(key, { ...scope, [field]: command.in(ids.slice(index, index + 100)) }));
    }
    return unique(rows);
  };
  for (const key of ['teams', 'teamEvents', 'teamMatches']) {
    surface[key].listByIds = ids => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      return byIds(key, ids, scope);
    };
  }
  surface.teamMembers.listByUser = id => select('teamMembers', 'userId', [id]);
  surface.teamMembers.listByTeams = ids => select('teamMembers', 'teamId', ids);
  surface.teamEventEntries.listForUser = id => select('teamEventEntries', 'roster.userId', [id]);
  // 报名按球队取（2026-10-26 只读审查 P2-7）：单队战绩要先知道「这支队报名了哪几届」，
  // 原先是把本协会**历年**全部报名读回来再按 teamId 过滤。
  surface.teamEventEntries.listByTeam = id => select('teamEventEntries', 'teamId', [id]);
  surface.teamMatches.listByEvents = ids => select('teamMatches', 'eventId', ids);
  surface.teamMatches.listByTeams = async ids => unique((await Promise.all([
    select('teamMatches', 'teamA', ids), select('teamMatches', 'teamB', ids),
  ])).flat());
  surface.teamMatches.listForPlayer = async id => unique((await Promise.all([
    select('teamMatches', 'footballPublished.sides.A.players.userId', [id]),
    select('teamMatches', 'footballPublished.sides.B.players.userId', [id]),
  ])).flat());
  surface.teamMatchStats.listForUser = async id => unique((await Promise.all([
    select('teamMatchStats', 'published.players.userId', [id]),
    select('teamMatchStats', 'published.rows.userId', [id]),
  ])).flat());
}
module.exports = { attachTeamReads, fieldValues, unique };
