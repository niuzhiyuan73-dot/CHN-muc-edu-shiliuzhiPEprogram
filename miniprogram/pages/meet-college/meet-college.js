/**
 * 学院部长工作台
 * ============================================================
 * 一屏看本院每个项目组别的「已报 / 上限 / 待审 / 意向人数」，点开某个项目从
 * 申请人池里选人提交。三条约束直接来自裁决：
 *   · 只能从已提交意向的人里选（D14），所以选人面板只列意向池；
 *   · 提交按项目组别一条（D22），一次只提交一个项目，失败时只影响这一项；
 *   · 名额、兼项、人数、重复全部由服务端判，页面只负责把失败原因显示清楚。
 *
 * 这里不做「整院一次提交」：120 个项目组别不可能放进一个事务（单事务 200 写），
 * 假装能整批原子提交只会在失败时给出错误的安全感。
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
    collegeId: '',
    byAdmin: false,
    rows: [],
    // 当前展开的项目与它的申请人池
    activeEventKey: '',
    activeEvent: null,
    applicants: [],
    picked: [],
    entries: [],
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
      const [board, entries] = await Promise.all([
        this.client().listMeetCollegeEvents({}),
        this.client().listMeetEntries({}),
      ]);
      this.update({
        loading: false,
        collegeId: board.collegeId,
        byAdmin: Boolean(board.byAdmin),
        rows: board.items,
        entries: entries.items,
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /** 展开某个项目的选人面板 */
  async onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '', activeEvent: null, applicants: [], picked: [] });
      return undefined;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      const pool = await this.client().getMeetApplicantPool({ eventKey });
      const picked = pool.event.entryForm === 'single' && pool.items.length === 1 ? [pool.items[0].userId] : [];
      this.update({
        busy: false,
        activeEventKey: eventKey,
        activeEvent: pool.event,
        applicants: pool.items.map((row) => ({ ...row, checked: picked.includes(row.userId) })),
        picked,
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '申请人加载失败' });
    }
  },

  onToggleApplicant(event) {
    const userId = event.currentTarget.dataset.userId;
    const need = Number((this.data.activeEvent && this.data.activeEvent.members) || 1);
    const picked = [...this.data.picked];
    const index = picked.indexOf(userId);
    if (index >= 0) picked.splice(index, 1);
    else if (picked.length < need) picked.push(userId);
    else return;

    this.update({
      picked,
      applicants: this.data.applicants.map((row) => ({ ...row, checked: picked.includes(row.userId) })),
    });
  },

  async onSubmitEntry() {
    if (this.data.busy) return undefined;
    const { activeEventKey, picked } = this.data;
    const need = Number((this.data.activeEvent && this.data.activeEvent.members) || 1);
    if (picked.length !== need) {
      this.update({ error: `该项目需要 ${need} 人，当前选了 ${picked.length} 人` });
      return undefined;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().submitMeetCollegeEntry({ eventKey: activeEventKey, userIds: picked });
      this.update({ busy: false, notice: '已提交，等待校级审核', activeEventKey: '', applicants: [], picked: [] });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '提交失败' });
      return undefined;
    }
  },

  async onWithdrawEntry(event) {
    if (this.data.busy) return undefined;
    const entryKey = event.currentTarget.dataset.entryKey;
    if (!entryKey) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().withdrawMeetCollegeEntry({ entryKey });
      this.update({ busy: false, notice: '已撤回' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤回失败' });
      return undefined;
    }
  },

  onOpenDetail() {
    return wx.navigateTo({ url: `/pages/meet-detail/meet-detail?meetId=${this.data.meetId}` });
  },
});
