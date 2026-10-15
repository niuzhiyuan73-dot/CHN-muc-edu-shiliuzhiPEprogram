/**
 * 赛事面板（协会工作台的内嵌页签之一）
 * ============================================================
 * 原来是一个独立的 tabBar 页面。中间三个页签收进「协会工作台」之后，这一页
 * 变成一个自定义组件，由工作台按当前协会挂载。
 * 面板只做四件事：渲染、点人跳转、点赛事跳详情、按名字筛选积分榜。
 * 取数与整形全在 services/events-view.js 里。
 *
 * 【这一面板现在有什么】
 *   1. 赛事列表：近期有哪些赛事、我报了哪一场，是赛事闭环的入口；
 *   2. 赛季积分榜：按本赛季积分排序，谁投入谁在前（决策 14），
 *      只展示前 10 名，其余靠搜索框定位。
 * 积分榜是「积分」这把尺子的展示面；「等级分」那把尺子是工作台里的「排行榜」页签。
 *
 * 【登录态为什么由面板传进去】
 * mock 的 getCurrentUser() 永远答 u06。若让视图模型自己去问，一个没登录
 * 的访客也会被当成 u06，凭空拿到报名与管理权限。所以这里把 getApp() 里的
 * 登录态明确传下去，传 null 就是访客。
 * ============================================================
 */

const { loadEventsView } = require('../../services/events-view.js');
// 积分榜的搜索框与排行榜页是同一套逻辑，直接复用它的纯函数，
// 免得「怎么算命中、怎么拼文案」在两处各写一份、改一处漏一处。
const { describeSearch } = require('../../services/rank-view.js');
const {
  setEventPinned,
  isMock,
  isMockNow,
} = require('../../services/index.js');
const { currentThemeClass } = require('../../services/branding.js');
// 学院赛已迁到学校维度：列表行取自 S2（见 events-view.loadEventsView），置顶就必须
// 写回同一份 S2 台账，否则「列表按 S2 读、置顶按旧栈写」，点了也没反应。
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

Component({
  options: {
    // app.wxss 的 .card / .tag / .rank-head 等全局类要渗进来
    styleIsolation: 'apply-shared',
  },

  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在面板根节点上 */
    themeClass: '',
    // 视图模型，形状见 services/events-view.js。
    // 初值给空对象而不是 null，WXML 里的 {{view.xxx}} 才不会报错。
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock,
    /** 当前是否在浏览外校（演示）赛事：为真时整页只读，隐藏发布 / 置顶入口 */
    demoSchool: false,
    /** 演示学校简称，供只读提示条显示 */
    demoSchoolName: '',

    // ---------- 积分榜按名字筛选 ----------
    // 完整榜留在 this.view 里，页面上只渲染筛选后的结果。与排行榜面板同一套：
    // 每敲一个字都只过一遍本地数组，不重新拉数据。
    /** 当前搜索词 */
    keyword: '',
    /** 正在显示的积分榜行（已筛选） */
    rows: [],
    /** 是否处于搜索状态，用来切换文案口径 */
    searching: false,
    /** 积分榜右上角的计数文案 */
    playerCountText: '',
    /** 筛选后一行都没有 */
    empty: false,
    /** 一行都没有时给的原因 */
    emptyNote: '',
    /** 置顶 / 取消置顶进行中，防止连点 */
    pinning: false,
  },

  lifetimes: {
    attached() {
      this.onLoad();
    },
    detached() {
      if (typeof this.onUnload === 'function') this.onUnload();
    },
  },

  pageLifetimes: {
    show() {
      if (typeof this.onShow === 'function') this.onShow();
    },
    hide() {
      if (typeof this.onHide === 'function') this.onHide();
    },
  },

  methods: {
    /**
     * 返回 Promise 是有意为之：小程序不关心 onLoad 的返回值，
     * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
     */
    onLoad() {
      return this.refresh();
    },

    /** 从详情 / 发布页返回时刷新一次，刚报的名、刚发的赛事才在列表里 */
    onShow() {
      if (!this.loaded) return undefined;
      return this.refresh();
    },

    /** 下拉刷新：数据都在内存里，重算一遍很快 */
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

    /**
     * 重新装载整页数据。
     * @returns {Promise<void>}
     */
    async refresh() {
      try {
        // 切到模拟学校（北航）时展示该校当前协会的演示赛事与积分榜：整页只读，发布 /
        // 置顶等入口一概不给。未开放学校维度的情况（云端数据源）回落到真实视图。
        const session = require('../../services/school-session.js');
        const association = require('../../services/association-scope.js').getAssociation();
        const demo = isMockNow()
          ? require('../../services/school-demo.js').schoolEvents(session.getSchoolId(), { association })
          : null;
        if (demo) {
          this.loaded = true;
          this.view = demo;
          this.setData({
            loading: false,
            error: '',
            view: demo,
            demoSchool: true,
            demoSchoolName: demo.schoolName,
            themeClass: currentThemeClass(),
          });
          this.applyKeyword(this.data.keyword);
          return;
        }

        const view = await loadEventsView({ user: this.currentUser(), isMock });
        this.loaded = true;
        // 整个视图模型另存一份。里面的完整榜 allRows 不参与渲染，
        // 只当筛选的数据源，所以不用塞进 data——省一次 setData 的开销。
        this.view = view;
        this.setData({
          loading: false,
          error: '',
          view,
          demoSchool: false,
          demoSchoolName: '',
          themeClass: currentThemeClass(),
        });
        // 重新装载后保留搜索词，重新算一遍要显示的行
        this.applyKeyword(this.data.keyword);
      } catch (err) {
        console.error('[events] 加载失败', err);
        this.loaded = true;
        this.setData({
          loading: false,
          demoSchool: false,
          demoSchoolName: '',
          error: '赛事页加载失败，请下拉重试',
          themeClass: currentThemeClass(),
        });
      }
    },

    /**
     * 按搜索词重算积分榜要显示的行与文案。
     * 纯本地计算，不碰数据源，所以能跟着每一次输入即时调用。
     *
     * @param {string} keyword
     */
    applyKeyword(keyword) {
      const view = this.view || {};
      // 搜索在完整榜（allRows）里找，默认展示的才是截断后的前 10（rows）。
      // 只用 rows 当搜索源的话，前十之外的人永远搜不到。
      const search = describeSearch(view.allRows || [], keyword);
      const idle = !search.searching;

      this.setData({
        keyword: search.keyword,
        rows: idle ? view.rows || [] : search.rows,
        searching: search.searching,
        playerCountText: search.searching
          ? search.countText
          : view.playerCountText || '',
        empty: idle ? Boolean(view.empty) : search.empty,
        emptyNote: idle ? view.emptyNote || '' : search.emptyNote,
      });
    },

    /** 搜索框输入 */
    onInputKeyword(event) {
      this.applyKeyword(event.detail.value);
    },

    /** 清空搜索。清空后回到默认展示的积分榜（前 10） */
    onClearKeyword() {
      this.applyKeyword('');
    },

    /** 轻提示。测试环境里可能没有这个 API */
    showToast(title, icon = 'none') {
      if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
        wx.showToast({ title, icon });
      }
    },

    /**
     * 置顶 / 取消置顶的共用流程：判登录 → 调接口 → 提示 → 整页重载。
     * 两个列表共用一套，避免「赛事能置顶、学院赛漏了登录判断」这类偏差。
     *
     * @param {(actorId:string) => Promise<Object>} write 写接口
     * @param {string} successText 成功后的提示
     * @returns {Promise<void>}
     */
    async runPin(write, successText) {
      if (this.data.pinning) return undefined;

      const user = this.currentUser();
      if (!user) {
        this.showToast('请先登录后再操作');
        return undefined;
      }

      this.setData({ pinning: true });
      const result = await write(user._id);
      this.setData({ pinning: false });

      if (!result || !result.ok) {
        this.showToast((result && (result.firstError || result.message)) || '操作失败');
        return undefined;
      }

      this.showToast(successText, 'success');
      return this.refresh();
    },

    /** 管理员置顶 / 取消置顶一场赛事 */
    onToggleEventPin(event) {
      const { eventId, pinned } = event.currentTarget.dataset;
      if (!eventId) return undefined;
      const next = !pinned;
      return this.runPin(
        (actorId) => setEventPinned(eventId, next, actorId),
        next ? '已置顶' : '已取消置顶'
      );
    },

    /**
     * 管理员置顶 / 取消置顶一场学院赛。
     *
     * 与个人赛不同，这一步走学校维度：列表已按 S2 读，置顶也得写回 S2 的学院赛
     * 主记录（见 school-college-service.setCollegeEventPinned）。权限与登录都由
     * 服务端判，未登录 / 无管理权时读端返回 ok:false，页面只负责把话说清楚。
     *
     * @param {Object} event currentTarget.dataset = { eventId, pinned }
     * @returns {Promise<void>}
     */
    async onToggleCollegePin(event) {
      const { eventId, pinned } = event.currentTarget.dataset;
      if (!eventId) return undefined;
      if (this.data.pinning) return undefined;

      const next = !pinned;
      const scope = {
        schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
        association: associationScope.getAssociation(),
      };

      this.setData({ pinning: true });
      const result = await space.forScope(scope).setCollegeEventPinned({ eventId, pinned: next });
      this.setData({ pinning: false });

      if (!result || result.ok === false) {
        this.showToast((result && (result.firstError || result.message)) || '操作失败');
        return undefined;
      }

      this.showToast(next ? '已置顶' : '已取消置顶', 'success');
      return this.refresh();
    },

    /** 进「全部赛事」，看没被截断的完整列表 */
    onMoreEvents() {
      // 外校演示赛事没有对应的列表页（那是本校的），别把人引到本校去
      if (this.data.demoSchool) return undefined;
      wx.navigateTo({ url: '/pages/event-list/event-list?type=event' });
    },

    /** 进「全部学院赛」 */
    onMoreCollegeEvents() {
      wx.navigateTo({ url: '/pages/event-list/event-list?type=college' });
    },

    /** 点榜上的任何一行，去看这个人的完整战绩 */
    onOpenMember(event) {
      // 外校演示榜单里的人没有本校账号，点进去只会是「查无此人」
      if (this.data.demoSchool) return undefined;
      const userId = event.currentTarget.dataset.userId;
      if (!userId) return;

      wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
    },

    /** 点一场赛事，进详情看报名名单或录入名次 */
    onOpenEvent(event) {
      // 外校演示赛事只读，没有可进的详情页
      if (this.data.demoSchool) return undefined;
      const eventId = event.currentTarget.dataset.eventId;
      if (!eventId) return;

      wx.navigateTo({ url: `/pages/event-detail/event-detail?eventId=${eventId}` });
    },

    /** 管理员发布赛事。无发布权时按钮根本不会渲染出来 */
    onOpenPublish() {
      wx.navigateTo({ url: '/pages/event-edit/event-edit' });
    },

    /** 管理员发布学院赛。与发布个人赛同一权限门槛 */
    onOpenCollegePublish() {
      wx.navigateTo({ url: '/pages/college-event-edit/college-event-edit' });
    },

    /**
     * 点一场学院赛。
     *
     * 学院负责人在报名中直接进本学院的名单页——那几天他的全部任务就是交名单，
     * 少走一步；其余情况一律进详情页，抽签、开赛、大场对阵与名单审核的
     * 入口都收在那里，普通会员也能看到签表。
     */
    onOpenCollegeEvent(event) {
      const { eventId, canSubmit } = event.currentTarget.dataset;
      if (!eventId) return;

      if (canSubmit) {
        wx.navigateTo({ url: `/pages/college-entry/college-entry?eventId=${encodeURIComponent(eventId)}` });
        return;
      }
      wx.navigateTo({ url: `/pages/college-event-detail/college-event-detail?eventId=${encodeURIComponent(eventId)}` });
    },
  },
});
