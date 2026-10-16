/**
 * 公告列表页
 * ============================================================
 * 首页公告栏只放得下三条，末尾那句「还有 N 条」原来点了没反应。这一页
 * 就是它该去的地方：全部协会的公告，顶部一栏协会标签切换，再按分类筛选。
 *
 * 【为什么任何人都能看】
 * 公告本就是公开内容。取数与筛选在 services/announcement-view.js 的学校维度
 * 装载器（loadSchoolAnnouncementListView），它给每一行恒下发 canArchive: false，
 * 于是管理按钮天然不会冒出来——公开页不需要、也不应该判权限。
 * 数据按「当前学校 + 协会」取，跨协会时逐个协会各取一次。
 *
 * 【onShow 为什么不需要守卫】
 * 这一页没有下级页面（发布走的是另一页），返回时内容不会变，
 * 不必像比赛页那样在 onShow 里重刷。
 * ============================================================
 */

const { loadSchoolAnnouncementListView } = require('../../services/announcement-view.js');
const { isMock } = require('../../services/runtime-mode.js');
const schoolSession = require('../../services/school-session.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 切分类时给个淡淡的反馈，避免点了没反应 */
    switching: false,
    /** 视图模型，形状见 services/announcement-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
  },

  /** 返回 Promise 是有意为之：测试需要句柄等首屏加载完 */
  onLoad() {
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadSchoolAnnouncementListView({
        schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
        tab: this.currentTab,
        association: this.currentAssociation,
      });
      this.setData({ loading: false, error: '', switching: false, view });
    } catch (err) {
      console.error('[announcements] 公告加载失败', err);
      this.setData({
        loading: false,
        switching: false,
        error: '公告加载失败，请下拉重试',
      });
    }
  },

  /** 切换分类（全部 / 通知 / 赛事 / 战报） */
  onSwitchTab(event) {
    const { tab } = event.currentTarget.dataset;
    if (!tab || tab === this.data.view.activeTab || this.data.switching) return undefined;

    this.currentTab = tab;
    this.setData({ switching: true });
    return this.refresh();
  },

  /** 切换协会（顶部横向一栏）。选哪个协会就只看哪个协会的公告 */
  onSwitchAssociation(event) {
    const { association } = event.currentTarget.dataset;
    if (!association || association === this.data.view.activeAssociation || this.data.switching) {
      return undefined;
    }

    this.currentAssociation = association;
    this.setData({ switching: true });
    return this.refresh();
  },
});
