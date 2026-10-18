/**
 * 首页
 * ============================================================
 * 两块内容，自上而下：
 *   1. 公告——置顶在前，其余按时间倒序（**当前学校内跨协会聚合**）
 *   2. 近期赛事——报名中 / 进行中的赛事，最近要打的在前（**当前学校内跨协会聚合**）
 *
 * 【为什么首页是跨协会的】
 * 首页回答的是「最近学校里有什么事」，不该被「我现在在哪个协会」框住。
 * 公告与近期赛事把该校全部协会的都摆出来，每条标注它属于哪个协会（见需求
 * 整理 §11.3）。因此首页套**中性品牌**，头图与导航标题都用中性名（§11.7）。
 *
 * 【B4-b 起首页走学校维度】取数统一经 services/school-home-view.js：
 * 按「当前浏览学校」逐协会聚合 S2 的公告 / 赛事 / 概况，跨校只读浏览得到
 * 真实（空）数据而不是静态演示内容。
 *
 * 【切换按钮为什么只换全局协会、不重刷首页】
 * 首页上那个切换器改的是「全局当前协会」，作用域是**中间三个界面**
 * （排行榜 / 比赛 / 赛事），首页自身内容不随它变（§11.2）。所以点了只把
 * 全局与徽章同步一下，不必重取首页数据。
 *
 * 【切学校为什么重刷首页】
 * 首页按学校聚合，切学校 = 换数据范围，必须重取；旧响应用请求序号作废。
 *
 * 【点某条为什么可能先切协会】
 * 点公告/赛事进详情时，若那一条属于别的协会，先把全局整体切过去再跳
 * （§11.3）——否则详情页会按「当前协会」去读，取不到这条数据。
 *
 * 【登录态变化后为什么要刷新】
 * 用户去登录页转一圈回来，赛事卡上的「已报名」标记就该更新，
 * 而且登录后才会出现赛事与概况两块（游客只看得到公告，§11.8）。
 * 所以 onShow 里再刷一次——但首屏 onLoad 之后紧跟着的 onShow 要跳过，
 * 否则同一份数据会白算两遍。
 * ============================================================
 */

const { loadSchoolHomeView } = require('../../services/school-home-view.js');
const { resolveAuthState } = require('../../services/auth.js');
const { resetBranding } = require('../../services/branding.js');
const associationScope = require('../../services/association-scope.js');
const runtime = require('../../services/runtime-mode.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/school-home-view.js。初值给空对象，WXML 展开才不会出错 */
    view: {},
    /** 当前登录态（是否登录、状态标签、能否录成绩） */
    auth: { loggedIn: false },
    /** 当前全局协会 id，供切换徽章显示；切换器只改全局，不改首页内容 */
    associationId: '',
    /** 当前数据源，用于页脚提示 */
    dataSourceLabel: '',
    /** 开发期标注模拟数据（onLoad 时按门面实际状态刷新） */
    isMock: false,
    /** 当前浏览的学校 id 与校名 */
    schoolId: '',
    schoolName: '',
    /** 可选学校清单：[{ schoolId, name }]。学校维度未开放时为空数组，控件自动隐藏 */
    schoolList: [],
    /** 是否在浏览外校（只读）。true 时页头出只读提示 */
    readOnlySchool: false,
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心返回值，
   * 但测试需要一个句柄等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
    this.showDataSource();
    // 首页套中性品牌。冷启动可能从别的协会页回来，先刷一次保险
    resetBranding();
    return this.refresh();
  },

  /**
   * 从别的页面返回时刷新一次，登录/退出后才能立刻看到变化。
   * 同时把导航栏刷回中性品牌——中间三个界面把它改成了各自协会的品牌。
   */
  onShow() {
    resetBranding();
    // 首次进入时 onLoad 已经加载过，这个紧随其后的 onShow 直接跳过
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh());
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
    return associationScope.getAssociation();
  },

  /** 切全局协会：优先走 app（它把结果同步进 globalData），否则直接改门面 */
  setAssociation(id) {
    const app = getApp();
    if (app && typeof app.setAssociation === 'function') return app.setAssociation(id);
    return associationScope.setAssociation(id);
  },

  /**
   * 重新装载整页数据：先定「当前浏览学校」（学校切换器），再按它聚合首页内容。
   * @returns {Promise<void>}
   */
  async refresh() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1;
    try {
      const user = this.currentUser();
      // 学校切换器单独加载；装载完按当前学校聚合首页内容。
      // 失败只收起控件，不该拖垮首页内容。
      await this.loadSchoolScope();
      const schoolSession = require('../../services/school-session.js');
      const view = await loadSchoolHomeView({
        schoolId: schoolSession.getSchoolId() || 'muc',
        viewerId: user ? user._id : '',
      });
      if (seq !== this.loadSeq) return;
      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        view,
        auth: resolveAuthState(user),
        associationId: this.currentAssociation(),
      });
    } catch (err) {
      console.error('[index] 首页加载失败', err);
      if (seq !== this.loadSeq) return;
      this.loaded = true;
      this.setData({
        loading: false,
        error: '首页数据加载失败，请下拉重试',
      });
    }
  },

  /**
   * 在界面上标注当前数据源，避免开发期把模拟数据当成真实成绩。
   * 直接问门面，而不是读 getApp().globalData——数据源只有一个真源，
   * 两处各存一份迟早会对不上（曾经就出现过开关拨了、界面还显示模拟数据）。
   */
  showDataSource() {
    const mock = runtime.isMockNow();
    this.setData({
      dataSourceLabel: mock ? '本地模拟数据' : '云端数据',
      isMock: mock,
    });
  },

  /**
   * 若某条内容属于别的协会，先把全局整体切过去再跳详情（§11.3）。
   * 切失败不该拦住跳转——顶多是详情页取不到数据，也好过点了没反应。
   *
   * @param {string} id 目标协会 id；空或与当前相同则什么都不做
   */
  switchTo(id) {
    if (!id || id === this.currentAssociation()) return;
    try {
      this.setAssociation(id);
      // 徽章跟着变。首页内容不重取（它本来就是跨协会的）
      this.setData({ associationId: id });
    } catch (err) {
      console.error('[index] 自动切换协会失败', err);
    }
  },

  /** 切协会徽章的 change 事件：只改全局，供中间三个界面之用 */
  onAssociationChange(event) {
    const id = event && event.detail ? event.detail.id : '';
    this.switchTo(id);
  },

  /**
   * 装载学校切换器：学校清单来自学校目录，当前浏览的学校来自会话作用域。
   * 只读与否由「当前浏览的学校 ≠ 我的学校」决定。整体包在 try/catch 里，
   * 接口报错时只是收起控件、回落到默认校聚合。
   *
   * 【为什么不再按 isMock 提前返回（2026-10-16）】
   * 这里曾经写死「云端尚未开放学校维度」，云数据源下直接把 schoolList 清空——
   * 于是真实环境没有「浏览外校」这条路径，而它正是转校与跨校读的入口。
   * 现在云端也走同一段代码：目录与会话本来就由 school-cloud 与协议 2 提供，
   * 真取不到（未登录 / 接口报错）时下面的 catch 照样把控件收起。
   *
   * @returns {Promise<void>}
   */
  async loadSchoolScope() {
    try {
      const service = require('../../services/school-identity.js');
      const schoolSession = require('../../services/school-session.js');
      const start = schoolSession.getSchoolId() || 'muc';
      const api = service.forSchoolIdentity({ schoolId: start, association: 'pkb' });
      const [directory, session] = await Promise.all([
        api.getSchoolDirectory(),
        api.getSchoolIdentitySession(),
      ]);
      if (!directory || !directory.ok) {
        this.setData({ schoolList: [], readOnlySchool: false });
        return;
      }
      const schools = (directory.schools || []).map((row) => ({ schoolId: row.schoolId, name: row.name }));
      // 「我的学校」以会话返回的 primarySchoolId 为准（演示身份切换后随之变化）
      schoolSession.setHomeSchoolId(session && session.user ? session.user.primarySchoolId || '' : '');
      const selected = schoolSession.getSchoolId() || (schools[0] && schools[0].schoolId) || '';
      schoolSession.setSchoolId(selected);
      this.setData({
        schoolList: schools,
        schoolId: selected,
        schoolName: (schools.find((row) => row.schoolId === selected) || {}).name || '',
        readOnlySchool: schoolSession.isReadOnly(),
      });
    } catch (err) {
      console.error('[index] 学校切换器加载失败', err);
      this.setData({ schoolList: [], readOnlySchool: false });
    }
  },

  /**
   * 切学校徽章的 change 事件：写会话作用域，并重取该校的首页聚合内容。
   * 切学校 = 换数据范围，旧学校的公告 / 赛事不能留在屏上。
   */
  onSchoolChange(event) {
    const id = event && event.detail ? event.detail.schoolId : '';
    if (!id) return;
    const schoolSession = require('../../services/school-session.js');
    schoolSession.setSchoolId(id);
    const found = (this.data.schoolList || []).find((row) => row.schoolId === id);
    this.setData({
      schoolId: id,
      schoolName: found ? found.name : id,
      readOnlySchool: schoolSession.isReadOnly(),
    });
    return this.refresh();
  },

  /** 去登录/注册 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /**
   * 去「赛事」看全部赛事。赛事板块现在收在「协会工作台」里，直接跳到工作台的
   * 赛事页签；工作台按当前全局协会取数，所以不必再传协会。
   */
  onGoEvents() {
    return wx.navigateTo({ url: '/pages/association-home/association-home?tab=events' });
  },

  /** 看全部公告 */
  onGoAnnouncements() {
    return wx.navigateTo({ url: '/pages/announcements/announcements' });
  },

  /** 点近期赛事的一条：跨协会的先切过去，再进详情 */
  onOpenEvent(event) {
    const { eventId, association } = event.currentTarget.dataset;
    if (!eventId) return undefined;
    this.switchTo(association);
    return wx.navigateTo({ url: `/pages/event-detail/event-detail?eventId=${encodeURIComponent(eventId)}` });
  },

  /** 点公告的一条：公告是学校级的一条通道，不必先切协会 */
  onOpenAnnouncement() {
    return wx.navigateTo({ url: '/pages/announcements/announcements' });
  },
});
