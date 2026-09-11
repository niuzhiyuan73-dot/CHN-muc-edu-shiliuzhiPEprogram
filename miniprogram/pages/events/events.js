/**
 * 赛事
 * ============================================================
 * 页面只做两件事：渲染、点人跳转。取数与整形全在 services/events-view.js 里。
 *
 * 【这一页现在有什么】
 * 赛季积分榜：按本赛季积分排序，谁投入谁在前。
 * 这是「积分」这把尺子的展示面；「等级分」那把尺子在「排行榜」tab。
 *
 * 【为什么单独占一个 tab】
 * 决策 14。两个榜回答的是不同的问题（实力 vs 投入），挤在一页里，
 * 用户会拿积分去比实力。等赛事闭环做完，报名、签到、成绩也会落在这里。
 * ============================================================
 */

const { loadEventsView } = require('../../services/events-view.js');
const { isMock } = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    // 视图模型，形状见 services/events-view.js。
    // 初值给空对象而不是 null，WXML 里的 {{view.xxx}} 才不会报错。
    view: {},
    /** 开发期在页脚标注数据来源 */
    isMock,
  },

  /**
   * 返回 Promise 是有意为之：小程序不关心 onLoad 的返回值，
   * 但测试需要一个句柄来等首屏加载完（见 tests/page.test.js）。
   */
  onLoad() {
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
      const view = await loadEventsView();
      this.setData({ loading: false, error: '', view });
    } catch (err) {
      console.error('[events] 加载失败', err);
      this.setData({ loading: false, error: '赛事页加载失败，请下拉重试' });
    }
  },

  /** 点榜上的任何一行，去看这个人的完整战绩 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;

    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },
});
