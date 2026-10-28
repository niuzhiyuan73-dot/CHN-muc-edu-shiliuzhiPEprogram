/** S2 比赛页面适配：纯构建器负责展示，服务端 DTO 决定能力。 */
const { buildRecordRow, TAB, TAB_LABEL, TAB_EMPTY, DEFAULT_LIMIT } = require('./match-view');
const { MATCH_STATUS } = require('../utils/constants');
const { resolveRouteId } = require('../utils/route-query');

const recordOf = dto => ({ ...dto, _id: dto.matchId });
const authOf = context => ({ loggedIn: Boolean(context.viewer), canRecord: context.canRecord,
  notice: context.message || '' });

async function loadSchoolMatchView(api, tab, options = {}) {
  let focused = null;
  if (options.matchId) {
    const resolved = await resolveRouteId(options.matchId, async matchId => {
      const result = await api.getSchoolMatch({ matchId, presentation: true });
      return result.ok ? result : null;
    });
    if (!resolved.result) throw new Error('比赛已变化或无法访问，请刷新待办');
    focused = resolved.result;
  }
  const context = focused ? { ok: true, viewer: focused.viewer, members: focused.members || [], canRecord: focused.match.canRecord } : await api.getSchoolMatchEntryContext({});
  if (!context.ok) throw new Error(context.message || '比赛读取失败');
  const auth = authOf(context);
  const activeTab = TAB_LABEL[tab] ? tab : TAB.MINE;
  const viewerId = context.viewer && context.viewer.userId;
  // 无有效学校身份时不拉内部台账，给出身份提示。
  const result = focused ? { ok: true, matches: [focused.match], total: 1, pendingCount: focused.match.status === MATCH_STATUS.PENDING ? 1 : 0, hasMore: false } : context.members.length ? await api.listSchoolMatches({ userId: viewerId,
    ...(activeTab === TAB.PENDING ? { status: MATCH_STATUS.PENDING } : {}), limit: DEFAULT_LIMIT })
    : { ok: true, matches: [], total: 0, pendingCount: 0, hasMore: false };
  if (!result.ok) throw new Error(result.message || '比赛读取失败');
  const names = new Map(context.members.map(member => [member.userId, member.nickName || member.userId]));
  const records = result.matches.map(dto => {
    const row = buildRecordRow(recordOf(dto), { userId: viewerId, nameOf: id => names.get(id) || id, isMock: false });
    for (const key of ['canRecord', 'canConfirm', 'canForfeit', 'canAssignReferee', 'confirmRelaxed']) row[key] = Boolean(dto[key]);
    row.refereeNotice = dto.hasReferee && !dto.canSubmitScore && !dto.canConfirm
      ? `本场由 ${row.refereeName} 裁判执法，仅裁判与管理员可录分` : '';
    return row;
  });
  return { auth, context, found: true, viewer: { userId: viewerId, loggedIn: auth.loggedIn },
    tabs: Object.values(TAB).map(key => ({ tab: key, label: TAB_LABEL[key], active: key === activeTab })),
    activeTab, records, total: result.total, hasMore: result.hasMore, pendingCount: result.pendingCount,
    emptyText: context.message || TAB_EMPTY[activeTab], needLogin: !auth.loggedIn,
    demoNotice: records.some(row => row.confirmRelaxed) ? '当前为演示数据源：参与者可确认比分，正式环境需由对手确认' : '' };
}

module.exports = { loadSchoolMatchView, recordOf, authOf };
