/**
 * 个人主页的行为层
 * ============================================================
 * 和 member-view.wxml / member-view.wxss 配套：
 *   .wxml 负责长什么样，.wxss 负责好不好看，这里负责怎么用。
 * 「我的」页与他人主页共用这一份，于是切项目、加载更多、
 * 点击对手跳转、重绘曲线这些逻辑都只写一次。
 *
 * 【为什么用工厂函数而不是直接导出一个对象】
 * 两个页面虽然几乎一样，但「看谁的数据」不同：
 *   我的页   永远看当前登录会员
 *   他人主页  看地址栏里的 userId
 * 这点差异通过参数传进来，其余全部共享。
 * ============================================================
 */

const { loadMemberView, DEFAULT_HISTORY_LIMIT } = require('../services/profile-view.js');
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
