/**
 * 个人主页的行为层
 * ============================================================
 * 和 member-view.wxml / member-view.wxss 配套：
 *   .wxml 负责长什么样，.wxss 负责好不好看，这里负责怎么用。
 * 「我的」页、个人详情页与他人主页共用这一份，于是切项目、加载更多、
 * 点击对手跳转、重绘曲线这些逻辑都只写一次。
 *
 * 【为什么用工厂函数而不是直接导出一个对象】
 * 几个页面虽然几乎一样，但「看谁的数据」不同：
 *   我的页／个人详情页  永远看当前登录会员
 *   他人主页           看地址栏里的 userId
 * 这点差异通过参数传进来，其余全部共享。
 * ============================================================
 */

const { loadMemberView, DEFAULT_HISTORY_LIMIT } = require('../services/profile-view.js');
const { setCollegeLeader } = require('../services/index.js');
const { renderEloChart } = require('../utils/chart-view.js');

/**
 * 创建一个个人主页的页面配置。
 *
 * @param {Object} [options]
 * @param {Function} [options.resolveUserId] (query) => userId，返回 undefined 表示看自己
 * @param {boolean} [options.titleFromMember=false] 是否把导航栏标题设成会员昵称。
 *        看别人的主页时要开——连点几层之后，得知道自己在看谁。
 * @returns {Object} 可直接交给 Page() 的配置对象
 */
function createMemberPage(options = {}) {
  const { resolveUserId, titleFromMember = false } = options;

  return {
    data: {
      /** 首屏加载中 */
      loading: true,
      /** 加载失败时的提示 */
      error: '',
      /** 是否还有更早的战绩可以加载 */
      hasMore: false,
      /** 当前已加载多少场逐场战绩 */
      historyLimit: DEFAULT_HISTORY_LIMIT,
      /** 切项目时给个淡淡的反馈，避免点了没反应 */
      switching: false,
      // 视图模型，形状见 services/profile-view.js。
      // 初值给空对象而不是 null，WXML 里的 {{...view}} 展开才不会出错。
      view: {},
    },

    /**
     * 返回 Promise 是有意为之：小程序并不关心 onLoad 的返回值，
     * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
     */
    onLoad(query) {
      this.userId = resolveUserId ? resolveUserId(query) : undefined;
      return this.refresh();
    },

    /** 下拉刷新：数据都在内存里，重算一遍很快 */
    onPullDownRefresh() {
      return this.refresh().then(() => wx.stopPullDownRefresh());
    },

    /**
     * 重新装载整页数据。
     * @returns {Promise<void>}
     */
    async refresh() {
      try {
        const view = await loadMemberView(this.userId, {
          project: this.currentProject,
          historyLimit: this.data.historyLimit,
          // 登录态由页面明确传入：他人主页要靠「我是谁」才能判断能不能任免
          // 学院负责人。与 loadMatchView 同一约定——问数据源「当前用户是谁」在
          // mock 下永远答 u06，会让未登录的访客也拿到任免入口。
          viewer: this.currentUser(),
        });

        // 连点几层进来之后，光看内容分不清在看谁，标题里写上名字最省事
        if (titleFromMember && view.found) {
          wx.setNavigationBarTitle({ title: view.user.nickName });
        }

        this.setData(
          {
            loading: false,
            error: '',
            switching: false,
            view,
            // 拿「已加载条数」和「该项目总场次」比，而不是和 historyLimit 比：
            // 后者在总场次恰好等于上限时会多出一个点了没反应的「加载更多」
            hasMore: view.found && Boolean(view.summary) && view.history.length < view.summary.matchCount,
          },
          // 曲线必须等 canvas 渲染出来才能画，所以放在 setData 的回调里
          () => this.drawChart()
        );
      } catch (err) {
        console.error('[member] 加载失败', err);
        this.setData({
          loading: false,
          switching: false,
          error: '数据加载失败，请下拉重试',
        });
      }
    },

    /** 把当前项目的分数序列画成曲线 */
    drawChart() {
      const view = this.data.view;
      if (!view || !view.found || view.chart.empty) return;

      renderEloChart(this, {
        values: view.chart.values,
        // 参考线画在入池起点分上，一眼能看出总共涨了多少
        reference: view.chart.startElo,
      });
    },

    /** 切换项目（男单 / 女单 / 双打） */
    onSwitchProject(event) {
      const { project } = event.currentTarget.dataset;
      const shown = this.data.view.activeProject;
      if (!project || project === shown || this.data.switching) return undefined;

      this.currentProject = project;
      this.setData({ switching: true });
      return this.refresh();
    },

    /** 加载更早的战绩 */
    onLoadMore() {
      if (this.data.loading) return undefined;
      this.setData({ historyLimit: this.data.historyLimit + DEFAULT_HISTORY_LIMIT });
      return this.refresh();
    },

    /**
     * 点头卡头像。默认什么都不做——头卡是三个页面共用的，只有「我的」页
     * 需要它跳进个人详情；他人主页点头像不该有反应，详情页里再跳就是自己。
     * 留一个空实现，是为了免去「页面没绑这个方法」的告警。
     */
    onGoProfileDetail() {},

    /**
     * 读取全局登录态。与「我的」页同一套兜底：app 可能还没初始化好。
     * @returns {Object|null}
     */
    currentUser() {
      const app = getApp();
      if (!app) return null;
      if (typeof app.getUserInfo === 'function') return app.getUserInfo();
      return app.globalData ? app.globalData.userInfo : null;
    },

    /** 一句轻提示。Node 测试里没有 wx，静默跳过 */
    showToast(title, icon = 'none') {
      if (typeof wx === 'undefined' || typeof wx.showToast !== 'function') return;
      wx.showToast({ title, icon });
    },

    /**
     * 弹一句确认。与公告管理页同一套：Node 测试没有 wx.showModal，
     * 直接放行，免得用例卡在一个永远等不到的回调上。
     * @param {string} content
     * @returns {Promise<boolean>}
     */
    confirm(content) {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        wx.showModal({
          title: '任免学院负责人',
          content,
          success: (res) => resolve(Boolean(res.confirm)),
          fail: () => resolve(false),
        });
      });
    },

    /**
     * 把当前主页的会员设为 / 撤销为学院负责人。
     *
     * 【为什么目标编号取自 view 而不是页面参数】页面上渲染的那个人就是
     * view.user，地址栏里的 userId 可能已被改写；以渲染出来的为准，所见即所改。
     *
     * 写入端会重新判一次权限（services/member-review.validateCollegeLeader），
     * 这里的前置判断只为少弹一个必被拒绝的确认框。
     *
     * @returns {Promise<void>|undefined}
     */
    async onSetCollegeLeader() {
      const view = this.data.view;
      const target = view && view.user;
      const leader = view && view.leader;
      if (!target || !leader || !leader.visible) return undefined;

      const user = this.currentUser();
      if (!user) {
        this.showToast('请先登录后再操作');
        return undefined;
      }

      const confirmed = await this.confirm(
        leader.makeLeader
          ? `将 ${target.nickName} 设为学院负责人，他可代签、代录本学院的比赛`
          : `撤销 ${target.nickName} 的学院负责人身份，他将失去本学院的管理权限`
      );
      if (!confirmed) return undefined;

      const result = await setCollegeLeader(target.userId, user._id, leader.makeLeader);
      if (!result.ok) {
        this.showToast(result.message || '操作失败');
        return undefined;
      }
      this.showToast(leader.makeLeader ? '已设为学院负责人' : '已撤销学院负责人', 'success');
      return this.refresh();
    },

    /** 点交锋记录或搭档记录里的人，去看他的主页 */
    onOpenMember(event) {
      const userId = event.currentTarget.dataset.userId;
      const shown = this.data.view.user && this.data.view.user.userId;
      // 别为自己再开一层页面——那只会让人反复点进同一份数据
      if (!userId || userId === shown) return;

      wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
    },
  };
}

module.exports = { createMemberPage };
