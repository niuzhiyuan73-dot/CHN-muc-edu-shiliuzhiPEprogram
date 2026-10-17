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
    filteredJudges: [],
    judgeKeyword: '',
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
  },

  onLoad(options = {}) {
    this.unloaded = false;
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId: String(options.meetId || ''),
    });
    return this.reload();
  },

  onUnload() {
    this.unloaded = true;
  },

  update(values) {
    if (!this.unloaded) this.setData(values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
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
      }
      const items = schedule.items.map((item) => ({
        ...item,
        readyLabel: item.ready ? '已配齐' : '未配齐',
        // 赛制摘要：页面上直接看出这个项目怎么比
        procedureLabel: item.scoreType === 'versus'
          ? `${FORMAT_LABEL[item.format] || '单败淘汰'}${item.groups ? `（${item.groups.count} 组，每组出线 ${item.groups.advancePerGroup}）` : ''}`
          : `${item.rounds === 'heat_final' ? '预赛+决赛' : '直接决赛'}${item.laneCount ? ` · 每组 ${item.laneCount} 人` : ''}${item.advance ? ` · ${ADVANCE_LABEL[item.advance.mode] || ''} ${item.advance.count}` : ''}`,
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
        items,
        judges,
        filteredJudges: this.filterJudges(judges, this.data.judgeKeyword),
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
        rounds: item.rounds || 'final',
        laneCount: item.laneCount || 6,
        advanceCount: (item.advance && item.advance.count) || 3,
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
    const limits = {
      laneCount: [2, 20], advanceCount: [1, 50], groupCount: [2, 8], advancePerGroup: [1, 4],
    };
    const range = limits[field];
    if (!range) return;
    const next = Math.max(range[0], Math.min(range[1], Math.trunc(value)));
    this.update({ proc: { ...this.data.proc, [field]: next } });
  },

  async onSaveProcedure() {
    if (this.data.busy) return;
    const eventKey = this.data.procedureEventKey;
    if (!eventKey) return;
    const { proc } = this.data;
    const payload = {
      eventKey,
      rounds: proc.rounds,
      laneCount: proc.laneCount,
    };
    if (proc.isVersus) {
      payload.format = proc.format;
      if (proc.format === 'group_knockout') {
        payload.groups = { count: proc.groupCount, advancePerGroup: proc.advancePerGroup };
      }
    } else if (proc.rounds === 'heat_final') {
      payload.advance = { mode: 'per_heat', count: proc.advanceCount };
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
    const versus = event.currentTarget.dataset.versus === '1'
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
          notice: `${result.rounds === 'heat_final' ? '已分' : '已分'} ${result.heats.length} ${result.rounds === 'heat_final' ? '组预赛' : '枪决赛'}（人数 ${sizes}）`,
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
  },

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
});
