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
      this.update({
        loading: false,
        meet: result.meet,
        events: result.events,
        canManage,
        isDraft: result.meet.status === 'draft',
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
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
