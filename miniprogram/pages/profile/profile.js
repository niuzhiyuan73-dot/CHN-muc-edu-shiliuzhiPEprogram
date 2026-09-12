/**
 * 我的
 * ============================================================
 * 展示当前登录会员的当前分数（单打/双打）与赛事荣誉。
 * 走势、逐场战绩、交锋记录、搭档记录这些细账搬到了个人详情页
 * pages/profile-detail，点头卡头像过去看。
 *
 * 界面与交互来自 templates/member-view（profileView），本文件只管两件事：
 * 「看谁的数据」——这里不传 userId，也就是看自己；
 * 以及「看得到哪些入口」——审核权与公告权只在这里算一次。
 * 他人主页 pages/member 用的是同一套模板，只是把 userId 传了进去。
 *
 * 【为什么管理入口在这里包一层】
 * templates/member-view 是三个页面共用的。若把审核入口写进模板，
 * 别人的主页上也会冒出一个审核按钮——权限判断于是散到几处。
 * 包一层之后，入口只属于「我的」页。
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
    /** 是否已登录。退出登录按钮据此显隐——没登录时它没有意义 */
    loggedIn: false,
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

  /**
   * 从登录页回来时登录态可能变了，入口要重算、数据要重取。
   *
   * 【为什么 onShow 里还得取一次数】tabBar 页切回来只走 onShow，不重新 onLoad。
   * 于是这个页面实例可能是在「未登录」时建出来的，view 一直停在 {found:false}；
   * 登录成功再切回来，loggedIn 变成 true，模板却拿着那份旧 view 渲染——屏幕上
   * 就成了「没有找到这位会员」，明明账号好端端地在那儿。退出登录后重新登录、
   * 或换一个账号登进来，都是这条路径。
   *
   * 只在「这次该给谁取数」和「上次取的是谁」不一样时才重取，免得每次切 tab
   * 都白跑一趟云端。
   *
   * @returns {Promise<void>|undefined}
   */
  onShow() {
    this.syncEntries();

    const key = this.sessionKey(this.currentUser());
    if (key !== (this.loadedForKey || null)) return this.refresh();
    return undefined;
  },

  /**
   * 会话指纹：除了「是谁」，还把昵称与头像算进去。
   *
   * 【为什么不能只比编号】改完昵称/头像从编辑页返回时，人还是那个人，编号
   * 没变。只比编号就不会重取，屏幕上仍挂着旧名字——刚改完却看不到变化，
   * 用户只会以为没保存上。
   *
   * @param {Object|null} user
   * @returns {string|null}
   */
  sessionKey(user) {
    if (!user) return null;
    return [user._id, user.nickName || '', user.avatarUrl || ''].join('|');
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /**
   * 装载整页数据。未登录时直接短路。
   *
   * 【为什么不能让它去问数据源】这一页只有一份数据可看：本地登录态里的
   * 那个人。而 memberPage 的默认实现会在没传 userId 时调 getCurrentUser()，
   * 云端那个接口认的是 OpenID（见 context.js），退出登录之后它照样答得出
   * 是谁——于是刚清掉的账号原地又长回来，页面上还挂着「我」的战绩。
   * 所以先看本地有没有人，没有就什么都不查。
   *
   * 【服务端答「查无此人」是什么意思】本地还留着登录态，getCurrentUser
   * 却说没这个人，只有两种可能：账号在后台被删了，或者这台设备上的微信号
   * 与服务端那个账号根本不是同一个（开发者工具与真机的 OpenID 不同，是
   * 两个微信号）。两种情况下这份缓存都已经对不上号，若照常渲染，页面就
   * 停在「没有找到这位会员」——一个既进不去也退不出的死角。清掉它退回
   * 登录引导，才是用户此刻真实的处境。
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();
    if (!user) {
      this.showGuest();
      return undefined;
    }

    // 屏幕上已经有这个人的数据时（切项目、加载更多、下拉刷新）就不动加载态，
    // 整页替成「正在加载…」反而把刚看到的内容抹掉了。其余情况——刚登录换人、
    // 或者压根还没有数据——必须先挂上加载态：不挂的话，模板会拿着登录前那份
    // {found:false} 渲染成「没有找到这位会员」，一直挂到云端返回为止。冷启动的
    // 云函数要等好几秒，看起来就像「必须手动刷新一次才出得来」。
    const key = this.sessionKey(user);
    const hadData = this.loadedForKey === key && this.data.view && this.data.view.found;
    this.loadedForKey = key;
    if (!hadData) this.setData({ loading: true, error: '' });

    await memberPage.refresh.call(this);

    // 加载报错时 view 还是空的，不能拿它当「查无此人」处理
    if (!this.data.error && this.data.view && this.data.view.found === false) {
      this.dropSession();
      this.showGuest();
    }
    return undefined;
  },

  /** 原地切成未登录的样子，不跳页——退出的入口和这里都不该把人甩到别的页 */
  showGuest() {
    // 没有登录态可展示，下次 onShow 只要还是未登录就不用重取
    this.loadedForKey = null;
    this.setData({
      loading: false,
      error: '',
      switching: false,
      hasMore: false,
      view: { found: false },
    });
  },

  /** 丢掉本地登录态。内存与缓存同步的那份逻辑在 app 上，这里不另抄一遍 */
  dropSession() {
    const app = getApp();
    if (app && typeof app.clearUserInfo === 'function') app.clearUserInfo();
    else if (app && app.globalData) app.globalData.userInfo = null;

    this.syncEntries();
  },

  /** 未登录时的引导按钮 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
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
      loggedIn: Boolean(user),
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

  /**
   * 退出登录。
   *
   * 【为什么退出按钮放在这里】
   * 登录页那张账号卡片上也有一个，但首页的「登录 / 注册」入口只在未登录时
   * 才渲染（index.wxml 的 wx:if="{{!auth.loggedIn}}"），所以已登录的人根本
   * 走不到登录页——那个按钮等于够不着。「我的」是 tabBar 常驻页，把退出放
   * 在这里才随时找得到。
   *
   * 退出后回首页：只清本地缓存的话，服务端认 OpenID，getCurrentUser 照样
   * 答得出是谁，这一页的战绩还会原样挂在那儿，看着像没退掉。
   */
  onLogout() {
    // 顺手把本页也切成未登录的样子：切页动画期间它还留在屏幕上，
    // 继续挂着审核入口或旧战绩会闪一下
    this.dropSession();
    this.showGuest();
    wx.switchTab({ url: '/pages/index/index' });
  },

  /** 进审核页 */
  onGoReview() {
    wx.navigateTo({ url: '/pages/member-review/member-review' });
  },

  /** 进公告管理页 */
  onGoAnnouncementsAdmin() {
    wx.navigateTo({ url: '/pages/announcement-manage/announcement-manage' });
  },

  /** 点头卡头像进个人详情页。走势、战绩、交手这些细账都在那边 */
  onGoProfileDetail() {
    wx.navigateTo({ url: '/pages/profile-detail/profile-detail' });
  },

  /**
   * 收掉工厂里的曲线重绘：本页改渲染 profileView，没有 canvas。
   * 不覆盖的话，每次 refresh 都会去查一个不存在的节点——虽然查不到会静默跳过，
   * 但白跑一趟；覆盖成空操作更干净。
   */
  drawChart() {},
});
