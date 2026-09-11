/**
 * 个人详情
 * ============================================================
 * 从「我的」页点自己的头像进来。分数走势、逐场战绩、交锋记录、搭档记录
 * 这些一屏看不完的细账都放在这里，「我的」页只留当前分数与赛事荣誉。
 *
 * 界面与交互全部来自 templates/member-view（profileDetailView），
 * 本文件只管两件事：「看自己」（不传 userId），以及「修改头像」入口。
 * ============================================================
 */

const { createMemberPage } = require('../../templates/member-view.js');
const { isMock } = require('../../services/index.js');

const memberPage = createMemberPage();

Page({
  ...memberPage,
  data: {
    ...memberPage.data,
    /** 开发期在页脚标注数据来源，以免把演示数据当成真实成绩 */
    isMock,
  },

  /**
   * 首屏取一次数，取完打个标记，好让 onShow 分得清「第一次显示」与
   * 「从编辑页返回」——后者需要重取，前者不必。
   */
  async onLoad(query) {
    await memberPage.onLoad.call(this, query);
    this.ready = true;
  },

  /**
   * 从编辑页返回时重取一次，头像/昵称改完立刻反映到头卡。
   * 首次显示不重复取，免得刚进页面就打两次请求。
   *
   * @returns {Promise<void>|undefined}
   */
  onShow() {
    if (this.ready) return this.refresh();
    return undefined;
  },

  /** 修改头像与昵称，复用既有编辑页（实名信息只读） */
  onGoProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/profile-edit' });
  },
});
