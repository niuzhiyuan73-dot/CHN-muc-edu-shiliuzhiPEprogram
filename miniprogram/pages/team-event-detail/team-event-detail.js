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

/** 统计指标：顺序即页面上的列顺序，label 给人看，max 只作提示 */
const STAT_FIELDS = [
  { field: 'points', label: '得分' },
  { field: 'rebounds', label: '篮板' },
  { field: 'assists', label: '助攻' },
  { field: 'steals', label: '抢断' },
  { field: 'blocks', label: '盖帽' },
  { field: 'turnovers', label: '失误' },
  { field: 'fouls', label: '犯规' },
];

/** 把摊平的统计行按节分组；基础模式（period 为 0）自成一组 */
function groupStatRows(rows, mode) {
  if (mode === 'detailed') {
    const byPeriod = new Map();
    rows.forEach((row) => {
      if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
      byPeriod.get(row.period).push(row);
    });
    return [...byPeriod.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([period, list]) => ({ period, rows: list }));
  }
  return [{ period: 0, rows }];
}

/**
 * ISO 时间 → 输入框里的 `YYYY-MM-DD HH:mm`（北京时间）。
 *
 * 服务端下发的是 ISO；输入框要的是人能改的字符串。两边都用固定的 +08，
 * 不读运行环境时区——否则本机与云函数会算出两个不同的时间。
 */
function toInputTime(value) {
  if (!value) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`
    + ` ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`;
}
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/**
 * 轮次的名字。
 *
 * 季军赛与决赛是同一轮的两场不同比赛，靠 `stage` 区分——只看轮次会把
 * 它们塞进同一个分组，标题写成「决赛」却挂着两场。
 */
function roundLabelOf(round, totalRounds, format, stage) {
  if (stage === 'bronze') return '季军赛';
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
    /** 弃权：0 正常完赛 / 1 A 队弃权 / 2 B 队弃权 */
    forfeitIndex: 0,
    forfeitLabels: ['正常完赛', 'A 队弃权', 'B 队弃权'],
    busy: false,
    /** 个人统计录入面板：{ matchId, title, mode, periods, revision } */
    statsEditing: null,
    /** 摊平后的统计行：{ key, sideIndex, userId, name, period?, points?, ... } */
    statRows: [],
    /** 按节分组的渲染结构：[{ period, rows: [] }]；period 为 0 表示基础模式 */
    statGroups: [],
    statsBusy: false,
    /** 统计审核条：{ matchId, canReview, needReview, pending } */
    statsReview: null,
    /** 赛程浮层：{ matchId, title, revision, matchTime, location, referees, recorders, ... } */
    scheduleEditing: null,
    /** 整轮顺延浮层：{ round, stage, label, minutes } */
    shiftEditing: null,
    scheduleBusy: false,
    /** 统计指标列（顺序即页面列顺序） */
    statFields: STAT_FIELDS,
    /** 球员数据榜 */
    playerStats: [],
    playerStatsError: '',
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
        // 分组键必须带上 stage：决赛与季军赛同轮次不同场
        const key = `${match.round}|${match.stage}`;
        let bucket = grouped.find(item => item.key === key);
        if (!bucket) {
          bucket = {
            key,
            round: match.round,
            stage: match.stage,
            label: roundLabelOf(match.round, totalRounds, event.format, match.stage),
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
      this.onLoadPlayerStats();
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

  /* ---------------- 个人统计 ---------------- */

  /**
   * 打开统计面板。
   *
   * 名单必须问服务端要：它是「锁定那一刻的快照」，不是球队现在的成员表。
   * 按节模式下把「节 × 人」摊平成一张平表，再按节分组渲染——WXML 的
   * 表达式能力有限，能摊平就不要嵌套两层 wx:for 取值。
   */
  async onOpenStats(event) {
    const { matchid } = event.currentTarget.dataset;
    this.setData({ notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).getTeamMatchStats({ matchId: matchid });
      if (!result || result.ok !== true) {
        this.setData({ notice: (result && result.message) || '统计加载失败', noticeError: true });
        return undefined;
      }
      if (result.canEdit !== true) {
        this.setData({ notice: '这场已结束或你没有录入权限', noticeError: true });
        return undefined;
      }
      const editing = {
        matchId: matchid,
        title: `${result.match.teamAName} vs ${result.match.teamBName}`,
        mode: result.statPolicy,
        periods: Number(result.periods) || 4,
        // 版本号取两侧工作副本的较大值：两侧总是一起写，正常情况下相等。
        // 保存时带上它，服务端据此判断「打开面板之后有没有人改过」。
        revision: (result.sides || []).reduce((max, side) => Math.max(max, side.revision || 0), 0),
        needReview: result.needReview === true,
      };
      const rows = [];
      (result.sides || []).forEach((side, sideIndex) => {
        const saved = side.rows || [];
        // key 必须带上节次：同一个人在第 1 节和第 2 节是两行，撞键会串数据
        const blankOf = (userId, name, period) => ({
          key: period ? `${sideIndex}-${userId}-${period}` : `${sideIndex}-${userId}`,
          sideIndex, userId, name,
          points: '', rebounds: '', assists: '', steals: '', blocks: '', turnovers: '', fouls: '',
        });
        if (editing.mode === 'detailed') {
          // 按节：一节一张小表，每个人在每个节里都有自己的一行
          for (let period = 1; period <= editing.periods; period += 1) {
            (side.players || []).forEach((player) => {
              const hit = saved.find(row => row.period === period && row.userId === player.userId) || {};
              const row = blankOf(player.userId, player.name, period);
              row.period = period;
              STAT_FIELDS.forEach(({ field }) => {
                row[field] = hit[field] === null || hit[field] === undefined ? '' : String(hit[field]);
              });
              rows.push(row);
            });
          }
        } else {
          const savedPlayers = side.players || [];
          (side.players || []).forEach((player) => {
            const hit = savedPlayers.find(item => item.userId === player.userId) || {};
            const row = blankOf(player.userId, player.name, 0);
            STAT_FIELDS.forEach(({ field }) => {
              row[field] = hit[field] === null || hit[field] === undefined ? '' : String(hit[field]);
            });
            rows.push(row);
          });
        }
      });
      this.setData({
        statsEditing: editing,
        statRows: rows,
        statGroups: groupStatRows(rows, editing.mode),
        statsReview: {
          matchId: matchid,
          canReview: result.canReview === true,
          needReview: result.needReview === true,
          pending: (result.sides || []).some(side => side.pendingReview === true),
        },
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 统计加载失败', err);
      this.setData({ notice: '统计加载失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onCloseStats() {
    this.setData({
      statsEditing: null, statRows: [], statGroups: [], statsBusy: false, statsReview: null,
    });
  },

  /** 改一个格子。整张平表重建，不依赖 setData 的数组下标路径 */
  onInputStat(event) {
    const key = event.currentTarget.dataset.key;
    const field = event.currentTarget.dataset.field;
    const rows = this.data.statRows.map((row) => (
      row.key === key ? { ...row, [field]: event.detail.value } : row
    ));
    this.setData({ statRows: rows, statGroups: groupStatRows(rows, this.data.statsEditing.mode) });
  },

  async onSaveStats() {
    const editing = this.data.statsEditing;
    if (!editing || this.data.statsBusy) return undefined;
    const filled = this.data.statRows.filter(row => STAT_FIELDS.some(({ field }) => row[field] !== ''));
    if (filled.length === 0) {
      this.setData({ notice: '还没填任何统计', noticeError: true });
      return undefined;
    }

    const players = filled.map(row => {
      const out = { userId: row.userId };
      STAT_FIELDS.forEach(({ field }) => { out[field] = row[field]; });
      if (editing.mode === 'detailed') out.period = row.period;
      return out;
    });

    this.setData({ statsBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).saveTeamMatchStats({
        matchId: editing.matchId,
        mode: editing.mode,
        expectRevision: editing.revision,
        ...(editing.mode === 'detailed' ? { rows: players } : { players }),
      });
      if (!result || result.ok !== true) {
        this.setData({
          statsBusy: false,
          notice: (result && result.message) || '保存失败',
          noticeError: true,
        });
        return undefined;
      }
      const warnings = result.warnings || [];
      // 已发布比赛的统计改动只是「待审核」版本：说清楚它还没对外生效，
      // 否则保存成功会让人以为榜单已经变了
      const doneText = result.needReview === true
        ? '统计已保存，等协会负责人审核后对外生效'
        : '统计已保存';
      this.setData({
        statsBusy: false,
        statsEditing: null,
        statRows: [],
        statGroups: [],
        statsReview: null,
        notice: warnings.length > 0 ? warnings.join('；') : doneText,
        noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 统计保存失败', err);
      this.setData({ statsBusy: false, notice: '保存失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 通过 / 退回统计的新版本（只有协会管理员能看到这两个按钮） */
  async onReviewStats(event) {
    const review = this.data.statsReview;
    if (!review || this.data.statsBusy) return undefined;
    const approve = event.currentTarget.dataset.approve === true
      || event.currentTarget.dataset.approve === 'true';
    this.setData({ statsBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).reviewTeamMatchStats({
        matchId: review.matchId,
        approve,
      });
      if (!result || result.ok !== true) {
        this.setData({
          statsBusy: false,
          notice: (result && result.message) || '审核失败',
          noticeError: true,
        });
        return undefined;
      }
      this.setData({
        statsBusy: false,
        statsEditing: null,
        statRows: [],
        statGroups: [],
        statsReview: null,
        notice: approve ? '统计已通过，榜单已更新' : '统计已退回，对外仍是上一版',
        noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 统计审核失败', err);
      this.setData({ statsBusy: false, notice: '审核失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 球员数据榜：赛事页底部一块，只算已发布的比赛 */
  async onLoadPlayerStats() {    try {
      const result = await space.forScope(this.scope).getTeamEventPlayerStats({
        eventId: this.data.eventId,
      });
      if (!result || result.ok !== true) {
        this.setData({ playerStats: [], playerStatsError: (result && result.message) || '' });
        return undefined;
      }
      this.setData({ playerStats: result.players || [], playerStatsError: '' });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 球员榜加载失败', err);
      this.setData({ playerStats: [], playerStatsError: '球员数据加载失败' });
      return undefined;
    }
  },

  /* ---------------- 赛程：时间 / 场地 / 裁判 / 记录员 ---------------- */

  /**
   * 打开单场赛程浮层。
   *
   * 候选名单必须问服务端要：裁判不能是这两支队的队长、记录员必须是本协会会员，
   * 这些规则页面推不出来。这里只把「可选的人」铺成选择器，选完把编号传回去。
   */
  async onOpenSchedule(event) {
    const { matchid } = event.currentTarget.dataset;
    this.setData({ notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).getTeamMatchSchedule({ matchId: matchid });
      if (!result || result.ok !== true) {
        this.setData({ notice: (result && result.message) || '赛程加载失败', noticeError: true });
        return undefined;
      }
      if (result.canEdit !== true) {
        this.setData({ notice: '这场已结束或已取消，不能再改赛程', noticeError: true });
        return undefined;
      }
      // 裁判候选里排除「不能执法」的人；记录员不受这条限制
      const referees = (result.referees || []).filter(row => !row.disabled);
      const recorders = (result.recorders || []).filter(row => !row.disabled);
      const indexOf = (list, userId) => {
        const at = list.findIndex(row => row.userId === userId);
        return at < 0 ? 0 : at + 1;
      };
      this.setData({
        scheduleEditing: {
          matchId: matchid,
          title: `${result.match.teamAName} vs ${result.match.teamBName}`,
          revision: result.match.revision,
          matchTime: toInputTime(result.match.matchTime),
          location: result.match.location || '',
          referees,
          recorders,
          refereeIndex: indexOf(referees, result.match.refereeId),
          recorderIndex: indexOf(recorders, result.match.recorderId),
          refereeLabels: ['不指派', ...referees.map(row => row.name)],
          recorderLabels: ['不指派', ...recorders.map(row => row.name)],
        },
      });
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 赛程加载失败', err);
      this.setData({ notice: '赛程加载失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onCloseSchedule() {
    this.setData({ scheduleEditing: null, scheduleBusy: false });
  },

  onInputSchedule(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`scheduleEditing.${field}`]: event.detail.value });
  },

  onPickSchedulePerson(event) {
    const role = event.currentTarget.dataset.role;
    const index = Number(event.detail.value) || 0;
    this.setData(role === 'referee'
      ? { 'scheduleEditing.refereeIndex': index }
      : { 'scheduleEditing.recorderIndex': index });
  },

  async onSubmitSchedule() {
    const editing = this.data.scheduleEditing;
    if (!editing || this.data.scheduleBusy) return undefined;
    const refereeId = editing.refereeIndex > 0
      ? (editing.referees[editing.refereeIndex - 1] || {}).userId || ''
      : '';
    const recorderId = editing.recorderIndex > 0
      ? (editing.recorders[editing.recorderIndex - 1] || {}).userId || ''
      : '';

    this.setData({ scheduleBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).updateTeamMatchSchedule({
        matchId: editing.matchId,
        matchTime: editing.matchTime,
        location: editing.location,
        refereeId,
        recorderId,
        // 版本号来自打开浮层那一刻：期间有人改过就拒绝，不覆盖
        expectRevision: editing.revision,
      });
      if (!result || result.ok !== true) {
        this.setData({
          scheduleBusy: false,
          notice: (result && result.message) || '保存失败',
          noticeError: true,
        });
        return undefined;
      }
      this.setData({
        scheduleBusy: false, scheduleEditing: null, notice: '赛程已更新', noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 赛程保存失败', err);
      this.setData({ scheduleBusy: false, notice: '保存失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  /** 整轮顺延：一场雨把整轮往后挪，不必逐场改 */
  onOpenShift(event) {
    const { round, stage, label } = event.currentTarget.dataset;
    this.setData({
      shiftEditing: {
        round: Number(round) || 1,
        stage: stage || '',
        label: label || `第 ${round} 轮`,
        minutes: '30',
      },
      notice: '',
      noticeError: false,
    });
  },

  onCloseShift() {
    this.setData({ shiftEditing: null, scheduleBusy: false });
  },

  onInputShift(event) {
    this.setData({ 'shiftEditing.minutes': event.detail.value });
  },

  async onSubmitShift() {
    const editing = this.data.shiftEditing;
    if (!editing || this.data.scheduleBusy) return undefined;
    this.setData({ scheduleBusy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).updateTeamRoundSchedule({
        eventId: this.data.eventId,
        round: editing.round,
        stage: editing.stage,
        shiftMinutes: Number(editing.minutes),
      });
      if (!result || result.ok !== true) {
        this.setData({
          scheduleBusy: false,
          notice: (result && result.message) || '顺延失败',
          noticeError: true,
        });
        return undefined;
      }
      const skipped = Number(result.skipped) || 0;
      this.setData({
        scheduleBusy: false,
        shiftEditing: null,
        notice: `已顺延 ${result.shifted} 场${skipped > 0 ? `，跳过 ${skipped} 场（已发布或没有开赛时间）` : ''}`,
        noticeError: false,
      });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-event-detail] 整轮顺延失败', err);
      this.setData({ scheduleBusy: false, notice: '顺延失败，请稍后重试', noticeError: true });
      return undefined;
    }
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
      forfeitIndex: target.forfeit === 'A' ? 1 : (target.forfeit === 'B' ? 2 : 0),
      // 页面上用队名而不是「A 队 / B 队」，裁判看的是队名
      forfeitLabels: ['正常完赛', `${target.teamAName} 弃权`, `${target.teamBName} 弃权`],
      notice: '',
      noticeError: false,
    });
    return undefined;
  },

  onCloseRecord() {
    this.setData({ recording: null, scoreA: '', scoreB: '', overtime: false, forfeitIndex: 0 });
  },

  onInputScore(event) {
    const side = event.currentTarget.dataset.side;
    const value = event.detail.value;
    this.setData(side === 'A' ? { scoreA: value } : { scoreB: value });
  },

  onToggleOvertime(event) {
    this.setData({ overtime: event.detail.value === true });
  },

  /**
   * 选弃权方：自动把比分填成 20:0（FIBA 口径：弃权方 0 分、对手 20 分胜）。
   * 填进去而不是锁死——有的赛事按实际比分记，改一下就行。
   */
  onPickForfeit(event) {
    const index = Number(event.detail.value) || 0;
    if (index === 1) {
      this.setData({ forfeitIndex: 1, scoreA: '0', scoreB: '20', overtime: false });
    } else if (index === 2) {
      this.setData({ forfeitIndex: 2, scoreA: '20', scoreB: '0', overtime: false });
    } else {
      this.setData({ forfeitIndex: 0 });
    }
  },

  async onSubmitScore() {
    if (!this.data.recording || this.data.busy) return undefined;
    const forfeit = this.data.forfeitIndex === 1 ? 'A' : (this.data.forfeitIndex === 2 ? 'B' : null);
    const result = await this.run('recordTeamMatch', {
      matchId: this.data.recording.matchId,
      scoreA: this.data.scoreA,
      scoreB: this.data.scoreB,
      overtime: this.data.overtime,
      forfeit,
      // 版本号来自打开浮层时的赛程快照：期间若有人先提交，服务端会拒绝而不是覆盖
      expectRevision: this.data.recording.revision,
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

  /** 在已加载的赛程里按编号找一场：发布要带它的版本号，不能只带编号 */
  matchOf(matchId) {
    let target = null;
    this.data.rounds.forEach((bucket) => {
      const found = bucket.matches.find(item => item.matchId === matchId);
      if (found) target = found;
    });
    return target;
  },

  onPublish(event) {
    const { matchid } = event.currentTarget.dataset;
    const target = this.matchOf(matchid);
    return this.run('publishTeamMatch', {
      matchId: matchid, approve: true, expectRevision: target && target.revision,
    }, '成绩已发布');
  },

  onRejectScore(event) {
    const { matchid } = event.currentTarget.dataset;
    const target = this.matchOf(matchid);
    return this.run('publishTeamMatch', {
      matchId: matchid, approve: false, expectRevision: target && target.revision,
    }, '已驳回，请让队长重新录');
  },
});
