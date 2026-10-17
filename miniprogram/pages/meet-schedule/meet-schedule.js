/**
 * 赛程编排（管理员）
 * ============================================================
 * 一屏列出本届每个项目组别，逐个填「开始时间 / 场地」并指派裁判，最后发布赛程。
 *
 * 三条界面约束来自服务端规则（这里只是把它显示出来，不重复判断）：
 *   · 没有时间或场地的项目，行上标「未配齐」，发布时服务端会拒绝并指出是哪几项；
 *   · 裁判从本校在册成员里选，不让手输 ID；
 *   · 没有裁判的场次不能开赛，所以「开赛」按钮只在有裁判时可用。
 *
 * D55 不做冲突检测：同一裁判被派到同一时段不会阻止，页面也不再假装能拦。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const session = require('../../services/school-session.js');

const ROUND_LABEL = { final: '决赛', heat: '预赛', rr: '循环赛' };

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
    // 展开的行与它正在编辑的场次
    activeEventKey: '',
    editStartAt: '',
    editVenue: '',
    editRound: 'final',
    editIndex: 1,
    editSessionKey: '',
    // 当前正在编辑的场次（含裁判名单）：预赛有多组，必须能分别排期并派裁判
    current: null,
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

  async reload() {
    this.update({ loading: true, error: '' });
    try {
      const schedule = await this.client().getMeetSchedule({});
      let judges = [];
      if (schedule.canManage) {
        const candidates = await this.client().listMeetJudgeCandidates({});
        judges = candidates.items;
      }
      this.update({
        loading: false,
        canManage: schedule.canManage,
        items: schedule.items.map((item) => ({
          ...item,
          readyLabel: item.ready ? '已配齐' : '未配齐',
          sessions: item.sessions.map((row) => ({
            ...row,
            roundLabel: row.roundLabel || ROUND_LABEL[row.round] || row.round,
          })),
        })),
        judges,
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /** 展开某项目：默认带出已存在的场次内容，没有就给个空表单 */
  onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '' });
      return;
    }
    const item = this.data.items.find((row) => row.eventKey === eventKey);
    const first = item && item.sessions[0];
    this.pickSession(eventKey, first);
  },

  /** 切换要排期的场次（预赛第 1/2 组、决赛各自独立） */
  onPickSession(event) {
    const sessionKey = event.currentTarget.dataset.sessionKey;
    const item = this.data.items.find((row) => row.eventKey === this.data.activeEventKey);
    const target = item && item.sessions.find((row) => row.sessionKey === sessionKey);
    if (target) this.pickSession(this.data.activeEventKey, target);
  },

  pickSession(eventKey, session) {
    this.update({
      activeEventKey: eventKey || '',
      editSessionKey: (session && session.sessionKey) || '',
      editStartAt: (session && session.startAt) || '',
      editVenue: (session && session.venue) || '',
      editRound: (session && session.round) || 'final',
      editIndex: (session && session.index) || 1,
      current: session || null,
    });
  },

  onStartInput(event) {
    this.update({ editStartAt: event.detail.value });
  },

  onVenueInput(event) {
    this.update({ editVenue: event.detail.value });
  },

  async onSaveSession() {
    if (this.data.busy) return;
    const { activeEventKey, editStartAt, editVenue } = this.data;
    if (!editStartAt) {
      this.update({ error: '请填写开始时间（YYYY-MM-DDTHH:mm）' });
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
        round: this.data.editRound,
        index: this.data.editIndex,
        startAt: editStartAt,
        venue: editVenue,
      });
      this.update({ busy: false, notice: '场次已保存', activeEventKey: '' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '保存失败' });
      return undefined;
    }
  },

  /** 指派裁判：picker 选定后立刻写入（同一人重复指派是幂等的） */
  async onAssignJudge(event) {
    if (this.data.busy) return;
    const index = Number(event.detail.value);
    const judge = this.data.judges[index];
    const target = this.data.current;
    if (!judge || !target) {
      this.update({ error: '请先保存场次，再指派裁判' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().assignMeetJudge({ sessionKey: target.sessionKey, judgeId: judge.userId });
      this.update({ busy: false, notice: `已指派 ${judge.name}` });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '指派失败' });
      return undefined;
    }
  },

  async onRemoveJudge(event) {
    if (this.data.busy) return;
    const { sessionKey, judgeId } = event.currentTarget.dataset;
    if (!sessionKey || !judgeId) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().removeMeetJudge({ sessionKey, judgeId });
      this.update({ busy: false, notice: '已撤销指派' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤销失败' });
      return undefined;
    }
  },

  async onStartSession(event) {
    if (this.data.busy) return;
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().startMeetEvent({ sessionKey });
      this.update({ busy: false, notice: '已开赛' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '开赛失败' });
      return undefined;
    }
  },

  async onPublishSchedule() {
    if (this.data.busy) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().publishMeetSchedule({});
      this.update({ busy: false, notice: '赛程已发布' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
      return undefined;
    }
  },

  onOpenScore() {
    return wx.navigateTo({ url: `/pages/meet-score/meet-score?meetId=${this.data.meetId}` });
  },
});
