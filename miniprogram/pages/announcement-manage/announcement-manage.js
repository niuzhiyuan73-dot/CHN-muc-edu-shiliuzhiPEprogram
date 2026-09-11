/**
 * 公告管理页
 * ============================================================
 * 两件事：发布新公告、下架已有公告。
 * 取数与权限判定全在 services/announcement-view.js，页面只做渲染与交互
 * ——那一层不碰 wx API，因而权限规则能在 Node 里逐条测。
 *
 * 【登录态由页面传进去，不让数据源自己猜】
 * mock 数据源永远认为当前用户是 u06。若让视图模型自己去问，一个没登录
 * 的访客也会被当成 u06，凭空拿到发布与下架的权限。所以这里把 getApp()
 * 里的登录态明确传下去，传 null 就是访客。
 *
 * 【为什么只做下架不做删除】
 * 公告是发出去给人看过的，直接抹掉会让「上周那条通知哪去了」无从追溯。
 * 下架只把状态改成已下架：公开列表看不见，台账里仍留着。界面上也说清楚
 * 这一点，免得用户以为「下架 = 删掉」。
 *
 * 【onShow 为什么要带守卫】
 * onLoad 之后紧接着就会来一次 onShow。若不加 this.loaded 判断，首屏会
 * 白算两遍。而带守卫又必须保留 onShow——从发布页 navigateBack 回来时
 * onLoad 不会再触发，不刷新就看不到刚发的那一条。
 * ============================================================
 */

const { loadAnnouncementManageView } = require('../../services/announcement-view.js');
const { archiveAnnouncement, isMock } = require('../../services/index.js');

/** 下架前的二次确认文案 */
const ARCHIVE_CONFIRM = '下架后这条公告不再对会员显示，但仍会留在台账里，确定下架吗？';

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
    /** 下架请求进行中，防止连点 */
    acting: false,
  },

  /** 返回 Promise 是有意为之：测试需要句柄等首屏加载完 */
  onLoad() {
    return this.refresh();
  },

  /** 从发布页返回时刷新一次，刚发的公告才能立刻出现在台账里 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 二次确认。测试环境里没有 wx.showModal，直接放行——
   * 测试要验证的是「确认之后做了什么」，不是弹窗本身。
   * @param {string} content
   * @returns {Promise<boolean>}
   */
  confirm(content) {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(true);
        return;
      }
      wx.showModal({
        title: '下架公告',
        content,
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      });
    });
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();

    try {
      const view = await loadAnnouncementManageView({ user });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[announcement-manage] 公告加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '公告加载失败，请下拉重试' });
    }
  },

  /** 去发布页 */
  onGoPublish() {
    wx.navigateTo({ url: '/pages/announcement-edit/announcement-edit' });
  },

  /** 下架一条公告。先确认，再动手 */
  async onArchive(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    const confirmed = await this.confirm(ARCHIVE_CONFIRM);
    if (!confirmed) return undefined;

    this.setData({ acting: true });
    const result = await archiveAnnouncement(id, user._id);
    this.setData({ acting: false });

    if (!result.ok) {
      this.showToast(result.message || '下架失败');
      return undefined;
    }

    this.showToast('已下架', 'success');
    return this.refresh();
  },
});
