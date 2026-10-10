/**
 * 发布公告
 * ============================================================
 * 只做一件事：把一张填好的单子变成一条「已发布」的公告。
 * 校验与组装在 services/announcement.js（纯函数），这里负责交互与 setData。
 *
 * 【为什么独立成页而不是管理页里的一个弹层】
 * 标题、分类、正文、置顶四项，正文还要一大块输入区，弹层里挤不下；
 * 而且将来要支持「改草稿」时，带参数的独立页比弹层好扩展。
 *
 * 【没有发布权为什么不让进】
 * 用户可能绕过管理页直接从小程序码进来。填完再被拒，比一开始就说清楚
 * 糟得多，所以进来先判一道，不给表单。校验与判权都是纯函数，
 * 这里只是把它们的结果渲染出来。
 * ============================================================
 */

const { ANNOUNCEMENT_CATEGORIES } = require('../../utils/constants.js');
const { TITLE_MAX, CONTENT_MAX, canPublish } = require('../../services/announcement.js');
const { publishAnnouncement, isMock } = require('../../services/index.js');
const { currentThemeClass } = require('../../services/branding.js');

Page({
  data: {
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock,
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',

    /** 没有发布权时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /** 分类选择器的数据源与当前下标 */
    categories: ANNOUNCEMENT_CATEGORIES,
    categoryIndex: 0,

    /** 输入长度上限，交给 maxlength 属性 */
    titleMax: TITLE_MAX,
    contentMax: CONTENT_MAX,

    /** 表单本体 */
    form: { title: '', content: '', category: ANNOUNCEMENT_CATEGORIES[0], pinned: false },
    /** 逐字段的错误提示 */
    errors: {},
    /** 整体错误提示 */
    errorText: '',
  },

  onLoad() {
    const user = this.currentUser();
    const allowed = canPublish(user, { isMock });
    this.setData({ blockReason: this.describeBlock(allowed, user), themeClass: currentThemeClass() });
  },

  /** 不能发布的原因。能发布时返回空串 */
  describeBlock(allowed, user) {
    if (allowed) return '';
    return user ? '当前账号没有发布公告的权限，请联系管理员' : '请先登录后再发布公告';
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /* ---------- 表单交互 ---------- */

  /**
   * 写入一个字段，并清掉它的旧错误。
   * 一律走这里，免得某个字段改了、错误提示却没跟着消失。
   */
  setField(key, value) {
    this.setData({
      form: { ...this.data.form, [key]: value },
      errors: { ...this.data.errors, [key]: '' },
      errorText: '',
    });
  },

  onInputTitle(event) {
    this.setField('title', event.detail.value);
  },

  onInputContent(event) {
    this.setField('content', event.detail.value);
  },

  onPickCategory(event) {
    const category = this.data.categories[Number(event.detail.value)];
    if (!category) return;
    this.setData({ categoryIndex: Number(event.detail.value) });
    this.setField('category', category);
  },

  onTogglePinned(event) {
    this.setField('pinned', Boolean(event.detail.value));
  },

  /* ---------- 提交 ---------- */

  /**
   * 提交。校验不通过时逐字段标红并给一条总提示——只标红的话，
   * 用户可能滚不到出错的那一项。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (this.data.blockReason) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再发布公告');
      return undefined;
    }

    this.setData({ submitting: true, errors: {}, errorText: '' });
    const result = await publishAnnouncement(this.data.form, user._id);

    if (!result.ok) {
      this.setData({
        submitting: false,
        errors: result.errors || {},
        errorText: result.firstError || '发布失败',
      });
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已发布', 'success');
    // 退回管理页，onShow 会刷新，刚发的那条就在台账里
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
});
