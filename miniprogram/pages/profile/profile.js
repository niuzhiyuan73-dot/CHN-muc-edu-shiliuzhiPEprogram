/**
 * 我的
 * ============================================================
 * 展示当前登录会员的**全局身份**（头卡）与**跨协会聚合的荣誉**。
 *
 * 【为什么这一页不随协会变】
 * 等级分（男/女单·双打 Elo）、赛季积分这些「各协会不同」的内容都搬进了
 * 个人详情页（点下方头卡的头像过去看）；这一页只留不随协会变化的东西：
 * 头卡（只到全局身份「会员 / 管理员」）+ 全部荣誉（各协会相加、按协会分组）。
 * 因此这里套**中性品牌**、用全局协会切换器（切换只影响中间三个界面，
 * 本页内容不重取）——见需求整理 §11.2 / §11.4 / §11.7。
 *
 * 【为什么管理入口在这里包一层】
 * templates/member-view 是三个页面共用的，审核入口只属于「我的」页；
 * 包一层之后，别人的主页上不会冒出审核按钮，权限判断也只在这一处。
 * ============================================================
 */

const { loadProfileSummary } = require('../../services/profile-view.js');
const { isMock } = require('../../services/index.js');
const { resetBranding } = require('../../services/branding.js');
const { canReview } = require('../../services/member-review.js');
const { canPublish } = require('../../services/announcement.js');
const facade = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/profile-view.js 的 loadProfileSummary。
     *  初值给空对象，WXML 里的 {{...view}} 展开才不会出错 */
    view: {},
    /** 开发期在页脚标注数据来源，以免把演示数据当成真实成绩 */
    isMock,
    /** 是否已登录。退出登录按钮与头卡据此显隐 */
    loggedIn: false,
    /** 当前全局协会 id，供切换徽章显示；切换器只改全局，本页内容不重取 */
    associationId: '',
    /** 会员审核入口。没有审核权时整张卡不出现，而不是给一个点不动的按钮 */
    reviewEntry: { visible: false, hint: '' },
    /** 公告管理入口。与审核入口同理，没权限就不渲染 */
    adminEntry: { visible: false, hint: '' },
  },

  onLoad() {
    // 「我的」是全局页，套中性品牌（与首页一致）
    resetBranding();
    // 入口与荣誉数据互不依赖，各算各的，不必串成一条链
    this.syncEntries();
    return this.refresh();
  },

  /**
   * 从登录页回来时登录态可能变了，入口要重算、数据要重取。
   *
   * 【为什么 onShow 里还得比对会话指纹】tabBar 页切回来只走 onShow，不重新 onLoad。
   * 页面实例可能是在「未登录」时建出来的，view 一直停在 {found:false}；登录成功
   * 再切回来，loggedIn 变成 true，模板却拿着旧 view 渲染成「没有找到这位会员」。
   * 改完昵称/头像从编辑页返回也是同一条路径——所以指纹里除了编号还带上昵称与头像。
   *
   * @returns {Promise<void>|undefined}
   */
  onShow() {
    resetBranding();
    this.syncEntries();
    // 【为什么单独同步一次徽章】当前协会是首页与本页共用的同一个全局，可能在
    // 首页被切走；而本页内容跨协会聚合、不随它变，下面那行指纹比较常常直接
    // 跳过 refresh——refresh 是唯一写 associationId 的地方。不同步的话，就会
    // 出现「首页显示 tt、我的还显示 pkb」的两张皮（需求整理 §11.2）。
    this.syncAssociationBadge();

    const key = this.sessionKey(this.currentUser());
    if (key !== (this.loadedForKey || null)) return this.refresh();
    return undefined;
  },

  /** 下拉刷新：数据都在内存里，重算一遍很快 */
  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 会话指纹：除了「是谁」，还把昵称与头像算进去。
   * 只比编号的话，改完昵称/头像返回时不会重取，屏幕上仍挂着旧名字。
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

  /** 当前全局协会。真机上由 app 持有，测试环境下回落到门面 */
  currentAssociation() {
    const app = getApp();
    if (app && typeof app.getAssociation === 'function') return app.getAssociation();
    return facade.getAssociation();
  },

  /** 切全局协会：优先走 app（它把结果同步进 globalData），否则直接改门面 */
  setAssociation(id) {
    const app = getApp();
    if (app && typeof app.setAssociation === 'function') return app.setAssociation(id);
    return facade.setAssociation(id);
  },

  /**
   * 把徽章上的协会对齐到当前全局协会。
   * 只在真的变了时才 setData，免得每次 onShow 都触发一次无谓的重渲染。
   */
  syncAssociationBadge() {
    const id = this.currentAssociation();
    if (id !== this.data.associationId) this.setData({ associationId: id });
  },

  /**
   * 装载整页数据。未登录时直接短路。
   *
   * 【为什么不能让它去问数据源】这一页只有一份数据可看：本地登录态里的那个人。
   * 云端接口认的是 OpenID（见 context.js），退出登录之后它照样答得出是谁——于是
   * 刚清掉的账号原地又长回来。所以先看本地有没有人，没有就什么都不查。
   *
   * 【服务端答「查无此人」是什么意思】本地还留着登录态，数据源却说没这个人，只有
   * 两种可能：账号在后台被删了，或这台设备的微信号与服务端账号不是同一个。两种
   * 情况下这份缓存都已对不上号，照常渲染就停在「没有找到这位会员」——一个既进不去
   * 也退不出的死角。清掉它退回登录引导，才是此刻真实的处境。
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();
    if (!user) {
      this.showGuest();
      return undefined;
    }

    // 屏幕上已经有这个人的数据时不挂加载态，否则切 tab 回来会把刚看到的内容
    // 整页替成「正在加载…」。其余情况（换人、还没数据）先挂上，免得拿旧 view 渲染。
    const key = this.sessionKey(user);
    const hadData = this.loadedForKey === key && this.data.view && this.data.view.found;
    this.loadedForKey = key;
    if (!hadData) this.setData({ loading: true, error: '' });

    try {
      const view = await loadProfileSummary();
      this.setData({
        loading: false,
        error: '',
        view,
        associationId: this.currentAssociation(),
      });

      // 加载报错时 view 还是空的，不能拿它当「查无此人」处理
      if (!view.found) {
        this.dropSession();
        this.showGuest();
      }
    } catch (err) {
      console.error('[profile] 加载失败', err);
      this.setData({
        loading: false,
        error: '数据加载失败，请下拉重试',
      });
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
   * 切协会徽章的 change 事件。与首页同一套：只改全局当前协会，作用在中间三个
   * 界面；本页是跨协会聚合的，内容不随它变（§11.2）。
   */
  onAssociationChange(event) {
    const id = event && event.detail ? event.detail.id : '';
    if (!id || id === this.currentAssociation()) return undefined;
    try {
      this.setAssociation(id);
      this.setData({ associationId: id });
    } catch (err) {
      console.error('[profile] 切换协会失败', err);
    }
    return undefined;
  },

  /**
   * 退出登录。
   *
   * 【为什么退出按钮放在这里】登录页那张账号卡片上也有一个，但首页的「登录 / 注册」
   * 入口只在未登录时才渲染，已登录的人根本走不到登录页——那个按钮等于够不着。
   * 「我的」是 tabBar 常驻页，把退出放在这里才随时找得到。
   *
   * 退出后回首页：只清本地缓存的话，服务端认 OpenID，数据源照样答得出是谁，
   * 这一页的战绩还会原样挂在那儿，看着像没退掉。
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

  /** 点头卡头像进个人详情页。等级分、赛季积分、走势、战绩这些细账都在那边 */
  onGoProfileDetail() {
    wx.navigateTo({ url: '/pages/profile-detail/profile-detail' });
  },
});
