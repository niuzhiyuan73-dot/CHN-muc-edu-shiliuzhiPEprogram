/**
 * 我的
 * ============================================================
 * 展示当前登录会员的完整战绩：分数、走势、赛事名次、交锋记录、
 * 搭档记录、逐场战绩。
 *
 * 界面与交互全部来自 templates/member-view，本文件只管两件事：
 * 「看谁的数据」——这里不传 userId，也就是看自己；
 * 以及「看得到哪些入口」——审核权只在这里算一次。
 * 他人主页 pages/member 用的是同一套模板，只是把 userId 传了进去。
 *
 * 【为什么在这里外包一层，而不是改模板】
 * templates/member-view 是「我的」和「他人主页」共用的。若把审核入口写进
 * 模板，别人的主页上也会冒出一个审核按钮——权限判断于是散到两处。
 * 包一层之后，入口只属于「我的」页，模板一行都不用动。
 * ============================================================
 */

const { createMemberPage } = require('../../templates/member-view.js');
const { isMock } = require('../../services/index.js');
const { canReview } = require('../../services/member-review.js');
const { canPublish } = require('../../services/announcement.js');

// 先建出公共配置，再把本页独有的字段并进去，
// 避免为了加一个字段就把 createMemberPage 整个再调一次
const memberPage = createMemberPage();

Page({
  ...memberPage,
  data: {
    ...memberPage.data,
    /** 开发期在页脚标注数据来源，以免把演示数据当成真实成绩 */
    isMock,
    /** 会员审核入口。没有审核权时整张卡不出现，而不是给一个点不动的按钮 */
    reviewEntry: { visible: false, hint: '' },
    /** 公告管理入口。与审核入口同理，没权限就不渲染 */
    adminEntry: { visible: false, hint: '' },
  },

  onLoad(query) {
    const wait = memberPage.onLoad.call(this, query);
    // 入口与战绩数据互不依赖，各算各的，不必串成一条链
    this.syncEntries();
    return wait;
  },

  /** 从登录页回来时登录态可能变了，权限要重算——否则退出登录后入口还挂着 */
  onShow() {
    this.syncEntries();
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /**
   * 重算所有管理入口。判定一律复用各功能自己的规则（canReview / canPublish），
   * 不在这里另写一套，免得某天规则改了这两处还各说各话。
   */
  syncEntries() {
    const user = this.currentUser();
    const canReviewNow = canReview(user, { isMock });
    const canPublishNow = canPublish(user, { isMock });

    this.setData({
      reviewEntry: {
        visible: canReviewNow,
        hint: canReviewNow ? '有入会申请等待处理' : '',
      },
      adminEntry: {
        visible: canPublishNow,
        hint: canPublishNow ? '发布或下架俱乐部公告' : '',
      },
    });
  },

  /** 进审核页 */
  onGoReview() {
    wx.navigateTo({ url: '/pages/member-review/member-review' });
  },

  /** 进公告管理页 */
  onGoAnnouncementsAdmin() {
    wx.navigateTo({ url: '/pages/announcement-manage/announcement-manage' });
  },
});
