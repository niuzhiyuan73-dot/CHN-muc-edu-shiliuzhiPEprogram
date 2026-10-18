/**
 * 运动会详情
 * ============================================================
 * 一个页面承载「基本信息 + 项目清单 + 按角色可见动作」，不新增一级标签（R02）。
 * 报名、赛程、总榜在后续批次往这里加区块，不另开栏目。
 *
 * 动作只在草稿期出现：发布报名之后改规则会影响已提交的报名（交接文档 §5.2）。
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
    meet: null,
    events: [],
    canManage: false,
    isDraft: false,
    isRegistration: false,
    interests: [],
    myEntries: [],
    pendingEntries: [],
    openAt: '',
    closeAt: '',
  },

  onLoad(options = {}) {
    this.unloaded = false;
    const meetId = String(options.meetId || '');
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId,
      openAt: this.today(),
      closeAt: this.daysLater(14),
    });
    return this.reload();
  },

  onUnload() {
    this.unloaded = true;
  },

  onPullDownRefresh() {
    const done = () => (typeof wx !== 'undefined' && wx.stopPullDownRefresh ? wx.stopPullDownRefresh() : null);
    return this.reload().then(done, done);
  },

  update(values) {
    if (!this.unloaded) this.setData(values);
  },

  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  },

  daysLater(days) {
    const date = new Date(Date.now() + days * 86400000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  async reload() {
    this.update({ loading: true, error: '' });
    try {
      const result = await this.client().getSportsMeet({ meetId: this.data.meetId });
      const canManage = Boolean(result.permissions && result.permissions.canManage);
      const isRegistration = result.meet.status === 'registration';
      this.update({
        loading: false,
        meet: result.meet,
        events: result.events,
        canManage,
        isDraft: result.meet.status === 'draft',
        isRegistration,
      });
      if (isRegistration) await this.loadParticipation();
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /** 报名期：我的意向/入选状态 + 管理员视角的待审队列 */
  async loadParticipation() {
    try {
      const mine = await this.client().getMyMeetParticipation({});
      // 把「我在这个项目上的状态」贴到项目行上：WXML 不能查表，只能读字段
      const byEvent = new Map(mine.interests.map((row) => [row.eventKey, row.status]));
      this.update({
        interests: mine.interests,
        myEntries: mine.entries,
        events: this.data.events.map((row) => ({
          ...row, myInterestStatus: byEvent.get(row.eventKey) || '',
        })),
      });
    } catch (err) {
      // 未提交过意向也会走到这里（服务端返回空列表），失败不影响主信息
      this.update({ interests: [], myEntries: [] });
    }
    if (!this.data.canManage) return;
    try {
      const all = await this.client().listMeetEntries({});
      this.update({ pendingEntries: all.items.filter((row) => row.status === 'pending_review') });
    } catch (err) {
      this.update({ pendingEntries: [] });
    }
  },

  /** 学生提交参赛意向（不占正式名额，D10） */
  async onInterest(event) {
    if (this.data.busy) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().submitMeetInterest({ eventKey });
      this.update({ busy: false, notice: '已提交参赛意向，等待学院选拔' });
      return this.loadParticipation();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '提交失败' });
      return undefined;
    }
  },

  async onWithdrawInterest(event) {
    if (this.data.busy) return undefined;
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().withdrawMeetInterest({ eventKey });
      this.update({ busy: false, notice: '已撤回意向' });
      return this.loadParticipation();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤回失败' });
      return undefined;
    }
  },

  /** 管理员审核（B6 可自审：代报后本人审核也允许） */
  async onReview(event) {
    if (this.data.busy) return undefined;
    const { entryKey, decision } = event.currentTarget.dataset;
    if (!entryKey || !decision) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().reviewMeetEntry({ entryKey, decision });
      this.update({ busy: false, notice: decision === 'approve' ? '已通过' : '已驳回' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '审核失败' });
      return undefined;
    }
  },

  /** 学院总榜与我的荣誉（B8） */
  onOpenStanding() {
    return wx.navigateTo({ url: `/pages/meet-standing/meet-standing?meetId=${this.data.meetId}` });
  },

  /** 赛程编排（管理员） */
  onOpenSchedule() {
    return wx.navigateTo({ url: `/pages/meet-schedule/meet-schedule?meetId=${this.data.meetId}` });
  },

  /** 录分与发布（管理员/裁判） */
  onOpenScore() {
    return wx.navigateTo({ url: `/pages/meet-score/meet-score?meetId=${this.data.meetId}` });
  },

  /** 学院部长入口 */
  onOpenCollege() {
    return wx.navigateTo({ url: `/pages/meet-college/meet-college?meetId=${this.data.meetId}` });
  },

  onOpenSetup() {
    return wx.navigateTo({ url: `/pages/meet-setup/meet-setup?meetId=${this.data.meetId}` });
  },

  onOpenAtChange(event) {
    this.update({ openAt: event.detail.value });
  },

  onCloseAtChange(event) {
    this.update({ closeAt: event.detail.value });
  },

  /** 发布报名：必须已有项目（R04），窗口由服务端再校验一次 */
  async onPublish() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().publishMeetRegistration({
        openAt: `${this.data.openAt}T00:00`,
        closeAt: `${this.data.closeAt}T23:59`,
      });
      this.update({ busy: false, notice: '报名已发布' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '发布失败' });
    }
  },

  async onDelete() {
    if (this.data.busy) return undefined;
    const confirm = typeof wx !== 'undefined' && wx.showModal
      ? await new Promise((resolve) => wx.showModal({
        title: '删除草稿',
        content: '删除后该届不再出现在列表里，确定继续？',
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      }))
      : true;
    if (!confirm) return undefined;

    this.update({ busy: true, error: '' });
    try {
      await this.client().deleteSportsMeet({});
      this.update({ busy: false });
      return wx.navigateBack({ delta: 1 });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '删除失败' });
    }
  },
});
