/**
 * 公告管理页
 * ============================================================
 * 两件事：发布新公告、下架已有公告。
 * 取数与权限判定全在 services/announcement-view.js 的学校维度装载器，
 * 页面只做渲染与交互——那一层不碰 wx API，因而权限规则能在 Node 里逐条测。
 * 数据按「当前学校 + 协会」取（学校维度下公告不再跨协会成大台账）。
 *
 * 【身份来自学校维度会话，不猜默认演示账号】
 * 「能不能管公告」由 S2 服务端回答（只有平台管理员能管）。页面另外取一次
 * 学校身份会话，只用来分辨「去登录」还是「没这个权限」——服务端只答
 * 「能不能管」，答不了「为什么不能管」。
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

const { loadSchoolAnnouncementManageView } = require('../../services/announcement-view.js');
const { isMock } = require('../../services/index.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 下架前的二次确认文案 */
const ARCHIVE_CONFIRM = '下架后这条公告不再对会员显示，但仍会留在台账里，确定下架吗？';

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
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

  /** 当前「学校 + 协会」范围。写操作复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: associationScope.getAssociation(),
    };
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
    const scope = this.currentScope();
    this.scope = scope;

    // 有没有学校身份只影响「去登录 / 没权限」的措辞，判权仍由服务端负责。
    // 取 account（在册学校身份）而不是 user：演示账号里没有停用的平台账号，
    // 连「模拟申请人」都是有效账号（user 恒非空），拿 user 判不出「没有学校身份」。
    let loggedIn = false;
    try {
      const session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
      loggedIn = Boolean(session && session.account);
    } catch (err) {
      console.error('[announcement-manage] 读取学校身份失败', err);
    }

    try {
      const view = await loadSchoolAnnouncementManageView({ ...scope, loggedIn });
      this.loaded = true;
      this.setData({ loading: false, error: '', view, themeClass: currentThemeClass() });
    } catch (err) {
      console.error('[announcement-manage] 公告加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '公告加载失败，请下拉重试', themeClass: currentThemeClass() });
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

    const confirmed = await this.confirm(ARCHIVE_CONFIRM);
    if (!confirmed) return undefined;

    this.setData({ acting: true });
    const result = await space.forScope(this.scope || this.currentScope())
      .archiveSchoolAnnouncement({ announcementId: id });
    this.setData({ acting: false });

    if (!result.ok) {
      this.showToast(result.message || '下架失败');
      return undefined;
    }

    this.showToast('已下架', 'success');
    return this.refresh();
  },
});
