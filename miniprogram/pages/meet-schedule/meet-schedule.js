/**
 * 赛程编排（管理员）
 * ============================================================
 * 这一页承担「报名截止后到比赛开始前」的全部编排工作，顺序就是页面上从上到下：
 *
 *   1. 定赛制：轮次（直接决赛 / 预赛+决赛）、每组人数（跑道数）、
 *      晋级人数或小组设置。**必须在报名截止后做**——分几组、分几枪是由实际
 *      报名人数除出来的，项目刚建好时人数还不知道。
 *   2. 分组/编排：径赛按跑道数自动均分（多枪决赛就是分几枪），
 *      胜负项目生成签表/循环赛。
 *   3. 排时间场地：时间是必填的告知信息，不做任何先后校验。
 *   4. 指派裁判：搜索 + 点人即指派，列表里直接看到已派的人。
 *   5. 发布赛程。
 *
 * 【为什么裁判不用 picker】
 * picker 的 range 是打开那一刻的快照：先搜索、再点开会拿到旧列表，
 * 必须关掉重开一次才对。改成「搜索框 + 直接列出候选人」，点谁就是谁。
 *
 * 【为什么开赛按钮要看名单长度】
 * 早期用计数 judgeCount，增删几次就会与真实指派表对不上。现在场次上维护
 * judgeIds 名单，页面按名单长度判断，服务端也用同一份名单。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const session = require('../../services/school-session.js');
const { showError, showNotice, updateMeetPage } = require('../../utils/meet-ui.js');

const ROUND_LABEL = { final: '决赛', heat: '预赛', rr: '循环赛' };
const ADVANCE_LABEL = { per_heat: '每组前 N', overall: '总成绩前 N', hybrid: '混合晋级' };
const FORMAT_LABEL = { single_elim: '单败淘汰', round_robin: '循环赛', group_knockout: '小组+淘汰' };

/** 在刷新后的列表里找回当前场次：重载后 current 必须换成本次数据的新对象 */
function sessionOf(items, eventKey, sessionKey) {
  const item = (items || []).find((row) => row.eventKey === eventKey);
  if (!item) return null;
  return (item.sessions || []).find((row) => row.sessionKey === sessionKey) || null;
}

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    canManage: false,
    items: [],
    judges: [],
    /** 本届总裁判（null = 未任命）：显示与撤销用 */
    chiefJudge: null,
    /** 总裁判候选面板：wx.showActionSheet 最多 6 项，成员一多就选不到人 */
    chiefOpen: false,
    chiefKeyword: '',
    chiefCandidates: [],
    filteredJudges: [],
    judgeKeyword: '',
    // 批量指派（B9c）：一批人一次派到多个场次
    bulkOpen: false,
    bulkJudges: [],
    bulkSessions: [],
    bulkDate: '',
    // 批量面板的裁判搜索与已选摘要（试用反馈：面板里搜不了人、选了没提示）
    bulkKeyword: '',
    filteredBulkJudges: [],
    bulkJudgeNames: '',
    // 展开的行与它正在编辑的场次
    activeEventKey: '',
    editStartAt: '',
    editVenue: '',
    editRound: 'final',
    editIndex: 1,
    editSessionKey: '',
    // 时间用两个 picker 拼（日期 + 时分）：手输格式太容易错
    editDate: '',
    editTime: '',
    // 当前正在编辑的场次（含裁判名单）
    current: null,
    // 赛制编辑面板
    procedureEventKey: '',
    proc: {
      isVersus: false,
      rounds: 'final',
      laneCount: 6,
      advanceCount: 3,
      format: 'single_elim',
      groupCount: 2,
      advancePerGroup: 2,
    },
    advanceLabel: ADVANCE_LABEL,
    formatLabel: FORMAT_LABEL,
    advanceModes: [
      { value: 'per_heat', label: '每组前 N' },
      { value: 'overall', label: '总成绩前 N' },
      { value: 'hybrid', label: '混合晋级' },
    ],
  },

  onLoad(options = {}) {
    this.unloaded = false;
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId: String(options.meetId || ''),
    });
    return this.reload();
  },

  onHide() { this.needsRefresh = true; },

  onShow() {
    if (this.needsRefresh) { this.needsRefresh = false; return this.reload(); }
  },

  onUnload() {
    clearTimeout(this.candidateTimer);
    this.unloaded = true;
  },

  update(values) {
    updateMeetPage(this, values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  /**
   * 赛制与分批摘要。
   *
   * 分批口径分三种，不能合并写：lane 按道数、capacity 按人数上限、
   * single 不分批。若一律写成「每组 N 人」，跳远会显示成「每组 0 人」，
   * 而 1500 米会显示成「每组 6 人」——这正是审查里的 C1/C2。
   */
  procedureLabelOf(item) {
    if (item.scoreType === 'versus') {
      const format = FORMAT_LABEL[item.format] || '单败淘汰';
      const groups = item.groups
        ? `（${item.groups.count} 组，每组出线 ${item.groups.advancePerGroup}）` : '';
      return `${format}${groups}`;
    }
    if (item.heatMode === 'single') return '单场 · 按顺序进行';
    const rounds = item.rounds === 'heat_final' ? '预赛+决赛' : '直接决赛';
    const capacity = item.heatCapacity || item.laneCount;
    if (!capacity) return rounds;
    const unit = item.heatMode === 'lane'
      ? `每组 ${capacity} 人（按道次）`
      : `每组最多 ${capacity} 人`;
    const advance = item.advance
      ? ` · ${ADVANCE_LABEL[item.advance.mode] || ''} ${item.advance.count}` : '';
    return `${rounds} · ${unit}${advance}`;
  },

  /**
   * 重新拉赛程。
   *
   * `keep` 用来指定「重载后仍停留在哪个场次」：指派/撤销裁判之后必须留在原地，
   * 否则用户每点一次就被弹回列表，看不到刚才的结果。
   */
  async reload(keep = {}) {
    this.update({ loading: true, error: '' });
    try {
      const schedule = await this.client().getMeetSchedule({});
      let judges = [];
      if (schedule.canManage) {
        const candidates = await this.client().listMeetJudgeCandidates({});
        judges = candidates.items;
        this.update({judgeHasMore: Boolean(candidates.hasMore), bulkHasMore: Boolean(candidates.hasMore)});
      }
      const items = schedule.items.map((item) => ({
        ...item,
        readyLabel: item.ready ? '已配齐' : '未配齐',
        procedureLabel: this.procedureLabelOf(item),
        // canDraw 由服务端给（它读的是兜底后的 heatMode，老数据也正确）
        sessions: (item.sessions || []).map((row) => ({
          ...row,
          roundLabel: row.roundLabel || ROUND_LABEL[row.round] || row.round,
          // 预赛要带上组号，否则四个 chip 全写「预赛」分不清；多枪的标签
          // 已经自带「第 N 枪」，不再重复
          displayLabel: row.round === 'heat'
            ? `预赛 第 ${row.index} 组`
            : (row.roundLabel || ROUND_LABEL[row.round] || row.round),
        })),
      }));

      const eventKey = keep.eventKey !== undefined ? keep.eventKey : this.data.activeEventKey;
      const sessionKey = keep.sessionKey !== undefined ? keep.sessionKey : this.data.editSessionKey;
      // 关键：用**刷新后的**场次对象替换 current，否则界面还显示指派前的 0 个裁判
      const current = sessionOf(items, eventKey, sessionKey);

      this.update({
        loading: false,
        canManage: schedule.canManage,
        chiefJudge: schedule.chiefJudge || null,
        items,
        judges,
        filteredJudges: this.filterJudges(judges, this.data.judgeKeyword),
        filteredBulkJudges: this.filterJudges(judges, this.data.bulkKeyword),
        bulkJudgeNames: this.judgeNamesOf(this.data.bulkJudges),
        activeEventKey: current ? eventKey : '',
        editSessionKey: current ? sessionKey : '',
        current,
        editStartAt: current ? current.startAt : '',
        editVenue: current ? current.venue : '',
        editRound: current ? current.round : 'final',
        editIndex: current ? current.index : 1,
        editDate: current ? this.dateOf(current.startAt) : '',
        editTime: current ? this.timeOf(current.startAt) : '',
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  dateOf(value) {
    const matched = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value || ''));
    return matched ? matched[1] : '';
  },

  timeOf(value) {
    const matched = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value || ''));
    return matched ? matched[2] : '';
  },

  filterJudges(judges, keyword) {
    const needle = String(keyword || '').trim();
    if (!needle) return judges;
    return judges.filter((row) => `${row.name}${row.collegeName || ''}${row.collegeId || ''}`.includes(needle));
  },

  /** 已选裁判的姓名串：chips 之外再给一行文字摘要，选中状态不只靠颜色 */
  judgeNamesOf(judgeIds) {
    const names = (judgeIds || []).map((id) => {
      const judge = this.data.judges.find((row) => row.userId === id);
      return judge ? judge.name : id;
    });
    return names.join('、');
  },

  // ---------- 赛制设置（报名截止后） ----------

  async onOpenProcedure(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.procedureEventKey === eventKey) {
      this.update({ procedureEventKey: '' });
      return;
    }
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    if (!item) return;
    this.update({
      procedureEventKey: eventKey,
      error: '',
      notice: '',
      proc: {
        isVersus: item.scoreType === 'versus',
        heatMode: item.heatMode || 'capacity',
        rounds: item.rounds || 'final',
        heatCapacity: item.heatCapacity || item.laneCount || 8,
        advanceCount: (item.advance && item.advance.count) || 3,
        advanceModeIndex: Math.max(0, this.data.advanceModes.findIndex(row => row.value === (item.advance && item.advance.mode))),
        format: item.format || 'single_elim',
        groupCount: (item.groups && item.groups.count) || 2,
        advancePerGroup: (item.groups && item.groups.advancePerGroup) || 2,
      },
    });
  },

  onProcPickRounds(event) {
    const rounds = String(event.currentTarget.dataset.rounds || 'final');
    this.update({ proc: { ...this.data.proc, rounds } });
  },

  onProcPickFormat(event) {
    const format = String(event.currentTarget.dataset.format || 'single_elim');
    this.update({ proc: { ...this.data.proc, format } });
  },

  onProcInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = Number(event.detail.value);
    if (!field || !Number.isFinite(value)) return;
    // 分道项目上限是跑道数（2–20）；不分道项目是每批人数，可以更大（2–50）
    const capacityRange = this.data.proc.heatMode === 'lane' ? [2, 20] : [2, 50];
    const limits = {
      heatCapacity: capacityRange,
      advanceCount: [1, 50], groupCount: [2, 8], advancePerGroup: [1, 4],
    };
    const range = limits[field];
    if (!range) return;
    const next = Math.max(range[0], Math.min(range[1], Math.trunc(value)));
    this.update({ proc: { ...this.data.proc, [field]: next } });
  },

  /**
   * 批量指派面板。
   *
   * 「连续几个项目同一批裁判」是学生运动会的常态。逐个场次、逐个裁判地派，
   * 一个上午的赛程要几十次点击，漏派一场那场就开不了赛。所以这里一次选多人、
   * 一次选多场，服务端按写预算拆事务后全部完成。
   *
   * 【为什么必须带上 eventKey】
   * 面板的显示条件是 `bulkOpen && activeEventKey === item.eventKey`，而按钮挂在
   * 每个项目行上。早先只翻 `bulkOpen`，点在未展开的项目上时 activeEventKey 还是
   * 空的——按钮像坏了一样「点了没反应」（试用反馈）。现在点谁就把谁展开。
   */
  onOpenBulk(event) {
    if (this.data.busy) return;
    const eventKey = (event.currentTarget.dataset.eventKey || '').trim();
    if (!eventKey) return;
    const row = this.data.items.find(item => item.eventKey === eventKey);
    // 没有场次就没有可派的裁判：模板已把按钮置灰，这里再兜一道（旧版缓存/直达调用）
    if (!row || !(row.sessions || []).length) {
      this.update({ error: '该项目还没有抽签分组，先抽签再派裁判' });
      return;
    }
    const sameEvent = this.data.activeEventKey === eventKey;
    if (!sameEvent) {
      this.pickSession(eventKey, row.sessions[0]);
    }
    this.update({
      activeEventKey: eventKey,
      bulkOpen: sameEvent ? !this.data.bulkOpen : true,
      bulkJudges: [],
      bulkSessions: [],
      bulkDate: '',
      bulkKeyword: '',
      filteredBulkJudges: this.data.judges,
      bulkJudgeNames: '',
      error: '',
      notice: '',
    });
  },

  onToggleBulkJudge(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;
    const picked = this.data.bulkJudges.includes(userId)
      ? this.data.bulkJudges.filter((id) => id !== userId)
      : [...this.data.bulkJudges, userId];
    this.update({ bulkJudges: picked, bulkJudgeNames: this.judgeNamesOf(picked) });
  },

  onBulkKeyword(event) {
    const bulkKeyword = event.detail.value;
    this.update({
      bulkKeyword,
      filteredBulkJudges: this.filterJudges(this.data.judges, bulkKeyword),
    });
    this.queueCandidateSearch('bulk');
  },

  onToggleBulkSession(event) {
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey) return;
    const picked = this.data.bulkSessions.includes(sessionKey)
      ? this.data.bulkSessions.filter((key) => key !== sessionKey)
      : [...this.data.bulkSessions, sessionKey];
    this.update({ bulkSessions: picked });
  },

  /** 本项目的全部场次（含未排期的） */
  onBulkAllSessions() {
    const item = this.data.items.find((row) => row.eventKey === this.data.activeEventKey);
    const all = (item && item.sessions || []).map((row) => row.sessionKey);
    this.update({ bulkSessions: all, bulkDate: '' });
  },

  onBulkDateInput(event) {
    // 填了日期就清空勾选：两者是互斥的范围
    this.update({ bulkDate: event.detail.value, bulkSessions: [] });
  },

  async onSubmitBulk() {
    if (this.data.busy) return;
    const { bulkJudges, bulkSessions, bulkDate, activeEventKey } = this.data;
    if (bulkJudges.length === 0) {
      this.update({ error: '请先选择裁判' });
      return;
    }
    const payload = { judgeIds: bulkJudges };
    if (bulkSessions.length > 0) payload.sessionKeys = bulkSessions;
    else if (bulkDate) payload.date = bulkDate;
    else payload.eventKey = activeEventKey;

    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await this.client().assignMeetJudges(payload);
      await this.reload({ eventKey: activeEventKey, sessionKey: this.data.editSessionKey });
      const existed = result.existed ? `（${result.existed} 条原本就已指派）` : '';
      this.update({
        busy: false,
        bulkOpen: false,
        bulkJudges: [],
        bulkSessions: [],
        bulkJudgeNames: '',
        notice: '',
        error: '',
      });
      showNotice(`已指派 ${result.judgeIds.length} 名裁判到 ${result.sessionCount} 个场次${existed}`);
    } catch (err) {
      this.update({ busy: false });
      showError((err && err.message) || '指派失败');
    }
  },

  async onSaveProcedure() {
    if (this.data.busy) return;
    const eventKey = this.data.procedureEventKey;
    if (!eventKey) return;
    const { proc } = this.data;
    const payload = {
      eventKey,
      rounds: proc.rounds,
    };
    // 单场项目没有「每批人数」这个概念，传了也会被服务端按模板覆盖
    if (!proc.isVersus && proc.heatMode !== 'single') {
      payload.heatCapacity = proc.heatCapacity;
    }
    if (proc.isVersus) {
      payload.format = proc.format;
      if (proc.format === 'group_knockout') {
        payload.groups = { count: proc.groupCount, advancePerGroup: proc.advancePerGroup };
      }
    } else if (proc.rounds === 'heat_final') {
      payload.advance = { mode: this.data.advanceModes[proc.advanceModeIndex || 0].value, count: proc.advanceCount };
    }

    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().setMeetEventProcedure(payload);
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, procedureEventKey: '', notice: '赛制已保存' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '保存失败' });
    }
  },

  /** 抽签分组 / 分枪 / 编排签表 */
  async onDraw(event) {
    if (this.data.busy) return;
    const eventKey = event.currentTarget.dataset.eventKey;
    const versus = event.currentTarget.dataset.versus === 1 || event.currentTarget.dataset.versus === '1'
      || event.currentTarget.dataset.versus === true;
    if (!eventKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      if (versus) {
        const result = await this.client().drawMeetBracket({ eventKey });
        this.update({
          busy: false,
          notice: result.format === 'round_robin'
            ? `已生成 ${result.matches.length} 场循环赛`
            : `已生成 ${result.matches.length} 场对阵（共 ${result.totalRounds} 轮）`,
        });
      } else {
        const result = await this.client().drawMeetHeats({ eventKey });
        const sizes = result.heats.map((row) => row.entryKeys.length).join(' / ');
        this.update({
          busy: false,
          notice: result.rounds === 'heat_final'
            ? `已分 ${result.heats.length} 组预赛（人数 ${sizes}）`
            : `已分 ${result.heats.length} 枪（人数 ${sizes}）`,
        });
      }
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '编排失败' });
    }
  },

  // ---------- 场次排期与裁判 ----------

  onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '', current: null, editSessionKey: '' });
      return;
    }
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    const first = item && item.sessions[0];
    this.pickSession(eventKey, first);
  },

  onPickSession(event) {
    const sessionKey = event.currentTarget.dataset.sessionKey;
    const item = this.data.items.find((row) => row.eventKey === this.data.activeEventKey);
    const target = item && item.sessions.find((row) => row.sessionKey === sessionKey);
    if (target) this.pickSession(this.data.activeEventKey, target);
  },

  pickSession(eventKey, s) {
    this.update({
      activeEventKey: eventKey || '',
      editSessionKey: (s && s.sessionKey) || '',
      editStartAt: (s && s.startAt) || '',
      editDate: s ? this.dateOf(s.startAt) : '',
      editTime: s ? this.timeOf(s.startAt) : '',
      editVenue: (s && s.venue) || '',
      editRound: (s && s.round) || 'final',
      editIndex: (s && s.index) || 1,
      current: s || null,
    });
  },

  onStartInput(event) {
    this.update({ editStartAt: event.detail.value });
  },

  onVenueInput(event) {
    this.update({ editVenue: event.detail.value });
  },

  onStartDateChange(event) {
    this.update({ editDate: event.detail.value });
    return this.composeStart();
  },

  onStartTimeChange(event) {
    this.update({ editTime: event.detail.value });
    return this.composeStart();
  },

  composeStart() {
    const { editDate, editTime } = this.data;
    if (!editDate || !editTime) return;
    this.update({ editStartAt: `${editDate} ${editTime}` });
  },

  async onSaveSession() {
    if (this.data.busy) return;
    const { activeEventKey, editStartAt, editVenue, editRound, editIndex } = this.data;
    if (!editStartAt) {
      this.update({ error: '请填写开始时间（可以选日期时间，也可以直接写）' });
      return;
    }
    if (!editVenue) {
      this.update({ error: '请填写场地' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().saveMeetSession({
        eventKey: activeEventKey,
        round: editRound,
        index: editIndex,
        startAt: editStartAt,
        venue: editVenue,
      });
      this.update({ busy: false, notice: '场次已保存' });
      return this.reload({ eventKey: activeEventKey, sessionKey: this.data.editSessionKey });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '保存失败' });
      return undefined;
    }
  },

  onJudgeKeyword(event) {
    const judgeKeyword = event.detail.value;
    this.update({
      judgeKeyword,
      filteredJudges: this.filterJudges(this.data.judges, judgeKeyword),
    });
    this.queueCandidateSearch('judge');
  },

  queueCandidateSearch(kind) {
    clearTimeout(this.candidateTimer);
    this.candidateTimer = setTimeout(() => this.loadCandidates(kind, false), 400);
  },

  async loadCandidates(kind, append) {
    const bulk = kind === 'bulk';
    const keyword = bulk ? this.data.bulkKeyword : this.data.judgeKeyword;
    const field = bulk ? 'filteredBulkJudges' : 'filteredJudges';
    const previous = append ? this.data[field] : [];
    const requestId = (this.candidateRequestId || 0) + 1;
    this.candidateRequestId = requestId;
    try {
      const result = await this.client().listMeetJudgeCandidates({keyword, offset: previous.length});
      if (this.unloaded || this.candidateRequestId !== requestId || keyword !== (bulk ? this.data.bulkKeyword : this.data.judgeKeyword)) return;
      const merged = new Map(this.data.judges.map(row => [row.userId, row]));
      for (const row of result.items) merged.set(row.userId, row);
      this.update({[field]: previous.concat(result.items), judges: [...merged.values()], [bulk ? 'bulkHasMore' : 'judgeHasMore']: Boolean(result.hasMore)});
    } catch(err) { this.update({error: err.message || '搜索裁判失败'}); }
  },

  onMoreJudges() { return this.loadCandidates('judge', true); },
  onMoreBulkJudges() { return this.loadCandidates('bulk', true); },

  /** 点候选人即指派：不再经过 picker，避免「搜索完还要再点一次才刷新」 */
  async onAssignJudge(event) {
    if (this.data.busy) return;
    const judgeId = event.currentTarget.dataset.judgeId;
    const target = this.data.current;
    if (!judgeId || !target) {
      this.update({ error: '请先选择一个场次' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().assignMeetJudge({ sessionKey: target.sessionKey, judgeId });
      const judge = this.data.judges.find((row) => row.userId === judgeId);
      // reload 会带回新的 current（含刚指派的裁判），而不是只弹一句提示
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: target.sessionKey });
      this.update({ busy: false, notice: `已指派 ${judge ? judge.name : judgeId}` });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '指派失败' });
    }
  },

  async onRemoveJudge(event) {
    if (this.data.busy) return;
    const { sessionKey, judgeId } = event.currentTarget.dataset;
    if (!sessionKey || !judgeId) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().removeMeetJudge({ sessionKey, judgeId });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey });
      this.update({ busy: false, notice: '已撤销指派' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤销失败' });
    }
  },

  async onStartSession(event) {
    if (this.data.busy) return;
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().startMeetEvent({ sessionKey });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey });
      this.update({ busy: false, notice: '已开赛' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '开赛失败' });
    }
  },

  async onPublishSchedule() {
    if (this.data.busy) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().publishMeetSchedule({});
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, notice: '赛程已发布' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
    }
  },

  onOpenScore() {
    return wx.navigateTo({ url: `/pages/meet-score/meet-score?meetId=${this.data.meetId}` });
  },

  /* ---------- M3：重排与总裁判 ---------- */

  /**
   * 重抽本项目：清空分组 / 签表，让管理员改完赛制再抽一次。
   *
   * 为什么要有：组数、每组人数是现场才知道的准数（报名 37 人、按 32 人抽错很常见），
   * 原先抽错之后无路可走。服务端会拒绝「已发布成绩」或「已录分」的项目，页面先确认
   * 一次再发，避免误触把整组安排清掉。
   */
  async onResetDraw(event) {
    if (this.data.busy) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    if (!eventKey || !item) return undefined;

    const confirmed = typeof wx !== 'undefined' && wx.showModal
      ? await new Promise((resolve) => wx.showModal({
        title: '重新抽签',
        content: `将清空「${item.name}」的全部分组与排期，之后可改赛制再抽一次。已发布的成绩或已录的分数会让该操作被拒绝。`,
        confirmText: '重抽',
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      }))
      : true;
    if (!confirmed) return undefined;

    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await this.client().resetMeetDraw({ eventKey });
      await this.reload({ eventKey: '', sessionKey: '' });
      this.update({ busy: false, notice: `已清空 ${result.clearedSessions} 个场次，可重新抽签` });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '重抽失败' });
    }
    return undefined;
  },

  /**
   * 打开总裁判候选面板。
   *
   * 不用 wx.showActionSheet：它最多 6 项，本校成员一多就选不到人（点「任命」
   * 直接没有反应）。改成可搜索的列表，与「指派裁判」同一套交互。
   */
  onOpenChief() {
    if (this.data.busy) return undefined;
    if (this.data.chiefOpen) {
      this.update({ chiefOpen: false });
      return undefined;
    }
    this.update({
      chiefOpen: true,
      chiefKeyword: '',
      chiefCandidates: (this.data.judges || []).slice(0, 20),
    });
    return undefined;
  },

  async onChiefKeyword(event) {
    const chiefKeyword = event.detail.value;
    this.update({ chiefKeyword });
    try {
      const result = await this.client().listMeetJudgeCandidates({ keyword: chiefKeyword });
      this.update({ chiefCandidates: (result.items || []).slice(0, 20) });
    } catch (err) {
      this.update({ chiefCandidates: [] });
    }
    return undefined;
  },

  onPickChief(event) {
    const userId = event.currentTarget.dataset.userId;
    if (userId) this.submitChiefJudge(userId);
  },

  async submitChiefJudge(userId) {
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().appointMeetChiefJudge({ userId });
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, notice: '已任命总裁判' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '任命失败' });
    }
  },

  async onRevokeChiefJudge() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().revokeMeetChiefJudge({});
      await this.reload({ eventKey: this.data.activeEventKey, sessionKey: this.data.editSessionKey });
      this.update({ busy: false, notice: '已撤销总裁判' });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤销失败' });
    }
    return undefined;
  },

  onProcAdvanceMode(event) {
    this.update({ proc: { ...this.data.proc, advanceModeIndex: Number(event.detail.value) } });
  },
});
