/**
 * 录分与成绩发布
 * ============================================================
 * 一个页面两种身份，因为它们是同一条链路的相邻两步：
 *   · 裁判：看到「我的任务」→ 点开场次 → 逐条录入 → 提交；
 *   · 管理员：看到每个项目组别的汇总预览（均值 / 缺分）→ 发布正式结果。
 *
 * 画面上的判断都不重复服务端规则：缺几条分、能不能发布、谁的名次第几，
 * 一律以接口返回为准。页面只负责把「还差几条」「谁还没交」显示清楚。
 *
 * 无成绩（犯规/弃权）由管理员在预览时勾选，发布时作为 void 传给服务端——
 * 这是 A3 的落点：绝不把 0 当成绩传进去。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const session = require('../../services/school-session.js');

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    canManage: false,
    tasks: [],
    events: [],
    // 当前打开的录分场次
    activeSessionKey: '',
    scoreItems: [],
    drafts: {},
    // 管理员预览
    activeEventKey: '',
    preview: null,
    voidKeys: [],
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
      const [tasks, schedule] = await Promise.all([
        this.client().getMyMeetJudgeTasks({}),
        this.client().getMeetSchedule({}),
      ]);
      this.update({
        loading: false,
        canManage: Boolean(schedule.canManage),
        tasks: tasks.items,
        events: schedule.items,
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  // ---------- 裁判：录分 ----------

  async onOpenSession(event) {
    const sessionKey = event.currentTarget.dataset.sessionKey;
    if (!sessionKey) return;
    this.update({ busy: true, error: '', notice: '', activeEventKey: '', preview: null });
    try {
      const result = await this.client().getMeetSessionScores({ sessionKey });
      this.update({
        busy: false,
        activeSessionKey: sessionKey,
        scoreItems: result.items,
        drafts: {},
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '任务加载失败' });
    }
  },

  onScoreInput(event) {
    const entryKey = event.currentTarget.dataset.entryKey;
    const drafts = { ...this.data.drafts, [entryKey]: event.detail.value };
    this.update({ drafts });
  },

  /** 录入并提交一条：先存草稿再提交，服务端两态分离（D66） */
  async onSubmitScore(event) {
    if (this.data.busy) return;
    const entryKey = event.currentTarget.dataset.entryKey;
    const rawText = (this.data.drafts[entryKey] || '').trim();
    if (!entryKey || !rawText) {
      this.update({ error: '请先填写成绩' });
      return;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      const sessionKey = this.data.activeSessionKey;
      await this.client().saveMeetJudgeScore({ sessionKey, entryKey, rawText });
      await this.client().submitMeetJudgeScore({ sessionKey, entryKey });
      this.update({ busy: false, notice: '已提交' });
      return this.onOpenSession({ currentTarget: { dataset: { sessionKey } } });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '提交失败' });
      return undefined;
    }
  },

  // ---------- 管理员：预览与发布 ----------

  async onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '', preview: null, voidKeys: [] });
      return;
    }
    this.update({ busy: true, error: '', notice: '', activeSessionKey: '', scoreItems: [] });
    try {
      const preview = await this.client().getMeetResultPreview({ eventKey });
      this.update({ busy: false, activeEventKey: eventKey, preview, voidKeys: [] });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '预览失败' });
    }
  },

  onToggleVoid(event) {
    const entryKey = event.currentTarget.dataset.entryKey;
    const list = [...this.data.voidKeys];
    const index = list.indexOf(entryKey);
    if (index >= 0) list.splice(index, 1);
    else list.push(entryKey);
    this.update({ voidKeys: list });
  },

  async onPublish() {
    if (this.data.busy) return;
    const eventKey = this.data.activeEventKey;
    if (!eventKey) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await this.client().publishMeetResults({ eventKey, voidEntryKeys: this.data.voidKeys });
      this.update({
        busy: false,
        notice: `已发布第 ${result.publication.version} 版`,
      });
      if (this.data.preview) {
        const preview = await this.client().getMeetResultPreview({ eventKey });
        this.update({ preview });
      }
      return undefined;
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
      return undefined;
    }
  },
});
