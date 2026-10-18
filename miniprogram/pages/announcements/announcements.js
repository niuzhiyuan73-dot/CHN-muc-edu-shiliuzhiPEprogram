/**
 * 公告列表页
 * ============================================================
 * 首页公告栏只放得下三条，末尾那句「还有 N 条」原来点了没反应。这一页
 * 就是它该去的地方：**本校全部公告**，一个通道。
 *
 * 【为什么没有协会标签，也没有分类标签】
 * 2026-10-18 起公告只有管理员能发，发的是全校信息；协会维度（匹克球 / 乒乓 /
 * 羽毛球）与「通知 / 赛事 / 战报」分类都已从界面移除。repo 里 announcements
 * 也移进 SCHOOL_ONLY 档，一次查询拿到全校公告，不再逐协会各取一次——那样
 * 同一条公告会被重复显示三遍。
 *
 * 【为什么任何人都能看】
 * 公告本就是公开内容。取数在 services/announcement-view.js 的
 * loadSchoolAnnouncementListView，它给每一行恒下发 canArchive: false，
 * 于是管理按钮天然不会冒出来——公开页不需要、也不应该判权限。
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
   * 重新装载整页数据。协会只用于配色，不影响取数。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadSchoolAnnouncementListView({
        schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      });
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[announcements] 公告加载失败', err);
      this.setData({ loading: false, error: '公告加载失败，请下拉重试' });
    }
  },
});
