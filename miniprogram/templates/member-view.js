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
const { applyBranding, themeClassOf } = require('../services/branding.js');
const { activeAssociations } = require('../utils/associations.js');
const scope = require('../services/association-scope.js');
const { renderEloChart } = require('../utils/chart-view.js');

/**
 * 创建一个个人主页的页面配置。
 *
 * @param {Object} [options]
 * @param {Function} [options.resolveUserId] (query) => userId，返回 undefined 表示看自己
 * @param {boolean} [options.localAssociation=false] 是否开启**页面局部**的协会切换。
 *        个人详情页与他人主页要开：页内切换只改本页展示、不写回全局；导航标题与
 *        主题色也随之按该协会套。默认按「页面对应用户比赛最多的协会」起（§11.1）。
 * @returns {Object} 可直接交给 Page() 的配置对象
 */
function createMemberPage(options = {}) {
  const { resolveUserId, localAssociation = false } = options;

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
      /** 页内协会切换：徽章是否显示（仅局部分页、且已登录、且不止一个启用协会） */
      showSwitch: false,
      /** 切换徽章当前值：本页正在看的协会 id */
      switchValue: '',
      /** 页面根节点的协会主题类（本页按页内协会套色，见 §11.7） */
      themeClass: '',
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
        // 页内切换的协会：首屏按「页面对应用户比赛最多的协会」定一次，之后跟着用户点
        if (localAssociation && !this.associationResolved) {
          this.associationResolved = true;
          this.localAssociation = await this.defaultLocalAssociation();
        }
        const association = localAssociation ? this.localAssociation : undefined;

        const view = await loadMemberView(this.userId, {
          project: this.currentProject,
          historyLimit: this.data.historyLimit,
          // 登录态由页面明确传入：他人主页要靠「我是谁」才能判断能不能任免
          // 学院负责人。与 loadMatchView 同一约定——问数据源「当前用户是谁」在
          // mock 下永远答 u06，会让未登录的访客也拿到任免入口。
          viewer: this.currentUser(),
          // 页面局部的作用域：只在本次取数期间切过去，取完由 withAssociation 还原
          association,
        });

        // 导航栏按当前页内协会套品牌（标题 + 主题色，见 §11.7）
        if (localAssociation) {
          applyBranding(association || scope.getAssociation());
        }

        this.setData(
          {
            loading: false,
            error: '',
            switching: false,
            view,
            showSwitch: localAssociation && this.canSwitchAssociation(),
            switchValue: association || '',
            // 页内协会决定整页配色：本页所属协会的主题类挂到根容器上
            themeClass: themeClassOf(association || scope.getAssociation()),
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

    /**
     * 本页默认看哪个协会：该页面对应用户「比赛最多的协会」（§11.1）。
     * 他人主页取被查看者，个人详情页取本人。算不出来就沿用全局当前协会。
     *
     * @returns {Promise<string>}
     */
    async defaultLocalAssociation() {
      const user = this.currentUser();
      const ownerId = this.userId || (user ? user._id : '');
      try {
        // 延迟取用：避开 member-view → association-usage → 门面的加载期环
        const { mostPlayedAssociation } = require('../services/association-usage.js');
        return await mostPlayedAssociation(ownerId);
      } catch (err) {
        console.error('[member] 计算默认协会失败，沿用全局', err);
        return scope.getAssociation();
      }
    },

    /** 页内切换徽章是否显示：只有登录用户、且启用协会不止一个时才给 */
    canSwitchAssociation() {
      return Boolean(this.currentUser()) && activeAssociations().length > 1;
    },

    /**
     * 页内切换协会（个人详情页 / 他人主页）。只改本页展示，**不写回全局**，
     * 退出即失效（§11.1）。整页数据按新协会重取。
     */
    onAssociationChange(event) {
      if (!localAssociation) return undefined;
      const id = event && event.detail ? event.detail.id : '';
      if (!id || id === this.localAssociation) return undefined;

      this.localAssociation = id;
      this.setData({ switching: true });
      return this.refresh();
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
