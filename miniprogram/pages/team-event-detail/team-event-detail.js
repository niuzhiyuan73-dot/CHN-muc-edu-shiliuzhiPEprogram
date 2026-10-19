/**
 * 团队赛事：详情（报名 → 锁定 → 抽签 → 录分 → 发布 → 结算）
 * ============================================================
 * 一页承载一届赛事的全部操作，按状态显示该做的事：
 *
 *   报名中   → 审核报名、锁定名单
 *   已锁定   → 抽签
 *   赛程已发布/进行中 → 录分、发布、排下一轮
 *   全部打完 → 结算名次
 *
 * 【为什么不拆成多个页面】
 * 这几步是串联的，拆开后每一步都要重新取数、重新判断「上一步做完没有」，
 * 而用户往往是一路点下来。一页做完，状态只有一个来源。
 *
 * 【页面不判权】
 * 「能不能录这一场」由服务端在每场比赛上下发 `canRecord` / `canPublish`。
 * 页面只知道「显示哪些按钮」，真正拦人的是接口。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 轮次的名字：淘汰赛的最后两轮值得单独叫出来，其余按序号 */
function roundLabelOf(round, totalRounds, format) {
  if (format === 'round_robin') return `第 ${round} 轮`;
  if (totalRounds && round === totalRounds) return '决赛';
  if (totalRounds && round === totalRounds - 1) return '半决赛';
  return `第 ${round} 轮`;
}

Page({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    eventId: '',
    event: null,
    entries: [],
    /** 我能替哪几支队报名（服务端算，已报过的不在里面） */
    submitCandidates: [],
    /** 按轮次分组的赛程：[{ round, label, matches: [] }] */
    rounds: [],
    table: [],
    placements: [],
    canManage: false,
    /** 当前要录分的那一场 */
    recording: null,
    scoreA: '',
    scoreB: '',
    overtime: false,
    busy: false,
    notice: '',
    noticeError: false,
  },

  onLoad(options = {}) {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    this.scope = { schoolId, association: associationScope.getAssociation() };
    this.setData({ themeClass: currentThemeClass(), eventId: options.eventId || '' });
    return this.refresh();
  },

  /** 取详情。所有动作做完都回到这里，页面状态永远只有一个来源 */
  async refresh() {
    if (!this.data.eventId) {
      this.setData({ loading: false, error: '缺少赛事编号' });
      return undefined;
    }
    this.setData({ loading: true, error: '' });
    try {
      const result = await space.forScope(this.scope).getTeamEvent({ eventId: this.data.eventId });
      if (!result.ok) {
        this.setData({ loading: false, error: result.message || '赛事加载失败' });
        return undefined;
      }
      const event = result.event;
      const totalRounds = event.draw && event.draw.size
        ? Math.round(Math.log2(event.draw.size))
        : 0;
      const grouped = [];
      (result.matches || []).forEach((match) => {
        let bucket = grouped.find(item => item.round === match.round);
        if (!bucket) {
          bucket = {
            round: match.round,
            label: roundLabelOf(match.round, totalRounds, event.format),
            matches: [],
          };
          grouped.push(bucket);
        }
        bucket.matches.push(match);
      });
      this.setData({
        loading: false,
        event,
        entries: result.entries || [],
        submitCandidates: result.submitCandidates || [],
        rounds: grouped,
        table: result.table || [],
        placements: result.placements || [],
        canManage: event.canManage === true,
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 加载失败', err);
      this.setData({ loading: false, error: '赛事加载失败，请稍后重试' });
      return undefined;
    }
  },

  /** 统一处理「调接口 → 提示 → 刷新」，避免每个动作复制一遍 */
  async run(action, payload, successText) {
    if (this.data.busy) return undefined;
    this.setData({ busy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope)[action](payload);
      if (!result || result.ok !== true) {
        this.setData({
          busy: false,
          notice: (result && result.message) || '操作失败',
          noticeError: true,
        });
        return result;
      }
      this.setData({ busy: false, notice: successText || '', noticeError: false });
      await this.refresh();
      return result;
    } catch (err) {
      console.error(`[team-event-detail] ${action} 失败`, err);
      this.setData({ busy: false, notice: '操作失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /* ---------------- 报名 ---------------- */

  onApproveEntry(event) {
    const { teamid } = event.currentTarget.dataset;
    return this.run('reviewTeamEntry', { eventId: this.data.eventId, teamId: teamid, approve: true }, '已通过');
  },

  onRejectEntry(event) {
    const { teamid } = event.currentTarget.dataset;
    return this.run('reviewTeamEntry', { eventId: this.data.eventId, teamId: teamid, approve: false }, '已退回');
  },

  /** 队长为本队报名（管理者也能替任何一队补报） */
  onSubmitEntry(event) {
    const { teamid } = event.currentTarget.dataset;
    return this.run('submitTeamEntry', {
      eventId: this.data.eventId,
      teamId: teamid,
    }, '已提交报名，等协会负责人审核');
  },

  onLock() {
    return this.run('lockTeamEntries', { eventId: this.data.eventId }, '名单已锁定，接下来可以抽签');
  },

  /* ---------------- 赛程 ---------------- */

  onDraw() {
    return this.run('drawTeamEvent', { eventId: this.data.eventId }, '已抽签并生成赛程');
  },

  onAdvance() {
    return this.run('advanceTeamRound', { eventId: this.data.eventId }, '已排出下一轮');
  },

  onSettle() {
    return this.run('settleTeamEvent', { eventId: this.data.eventId }, '名次已结算');
  },

  /* ---------------- 录分 ---------------- */

  onOpenRecord(event) {
    const { matchid } = event.currentTarget.dataset;
    let target = null;
    this.data.rounds.forEach((bucket) => {
      const found = bucket.matches.find(item => item.matchId === matchid);
      if (found) target = found;
    });
    if (!target) return undefined;
    this.setData({
      recording: target,
      scoreA: target.scoreA === null ? '' : String(target.scoreA),
      scoreB: target.scoreB === null ? '' : String(target.scoreB),
      overtime: target.overtime === true,
      notice: '',
      noticeError: false,
    });
    return undefined;
  },

  onCloseRecord() {
    this.setData({ recording: null, scoreA: '', scoreB: '', overtime: false });
  },

  onInputScore(event) {
    const side = event.currentTarget.dataset.side;
    const value = event.detail.value;
    this.setData(side === 'A' ? { scoreA: value } : { scoreB: value });
  },

  onToggleOvertime(event) {
    this.setData({ overtime: event.detail.value === true });
  },

  async onSubmitScore() {
    if (!this.data.recording || this.data.busy) return undefined;
    const result = await this.run('recordTeamMatch', {
      matchId: this.data.recording.matchId,
      scoreA: this.data.scoreA,
      scoreB: this.data.scoreB,
      overtime: this.data.overtime,
    }, '已提交，等协会负责人发布');
    if (!result || result.ok !== true) return result;
    this.setData({ recording: null, scoreA: '', scoreB: '', overtime: false });
    // 服务端可能带回「个人合计与球队得分不符」这类提醒，别吞掉
    const warnings = result.warnings || [];
    if (warnings.length > 0) {
      this.setData({ notice: warnings.join('；'), noticeError: false });
    }
    return result;
  },

  onPublish(event) {
    const { matchid } = event.currentTarget.dataset;
    return this.run('publishTeamMatch', { matchId: matchid, approve: true }, '成绩已发布');
  },

  onRejectScore(event) {
    const { matchid } = event.currentTarget.dataset;
    return this.run('publishTeamMatch', { matchId: matchid, approve: false }, '已驳回，请让队长重新录');
  },
});
