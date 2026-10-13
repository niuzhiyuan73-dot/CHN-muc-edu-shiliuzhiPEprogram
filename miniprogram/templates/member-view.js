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
          // mock 下永远答 u06，会让未登录的访客也拿到任免入口。身份按本页协会
          // 解析（见 viewerFor），使协会负责人随页内协会变化。
          viewer: await this.viewerFor(association),
          // 页面局部的作用域：取数客户端固定绑定本页协会
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

    /**
     * 取「看本页的人」身份，并把角色解析到**本页协会**之下。
     *
     * 【为什么不能直接用登录快照】登录快照（app.getUserInfo）只带一个 role，
     * 是按某一个协会读下来的。而协会角色随协会各异：同一个人在本协会是协会
     * 负责人（有效角色＝管理员），切到别的协会可能只是普通会员。本页允许页内
     * 切换协会（§11.6），若还拿快照里的旧 role 判权限，协会负责人打开本协会
     * 会员的主页时，按角色显示的「任免学院负责人」入口会整张不出现——写入端
     * 本就有这个权限，界面却点不到。
     *
     * 【为什么按编号回查而不是问「当前用户是谁」】回查用的是已知编号（快照里
     * 的 _id），既拿得到本协会下的有效角色，又不会在未登录时凭 mock 的默认
     * 演示账号答出一个假身份——访客（无 _id）一律返回原值，不给任何入口。
     * 查不到（本地注册、重启后不在名单）就沿用快照，行为与写入端一致。
     *
     * @param {string} [association] 本页协会；传了就在该协会作用域里回查
     * @returns {Promise<Object|null>} 供 loadMemberView 判权限的 viewer
     */
    async viewerFor(association) {
      const user = this.currentUser();
      if (!user || !user._id) return user || null;
      const api = require('../services/index.js').forAssociation(association || scope.getAssociation());
      return (await api.getMember(user._id)) || user;
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
     * @param {string} [title='任免学院负责人']
     * @returns {Promise<boolean>}
     */
    confirm(content, title = '任免学院负责人') {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        wx.showModal({
          title,
          content,
          success: (res) => resolve(Boolean(res.confirm)),
          fail: () => resolve(false),
        });
      });
    },

    /**
     * 在「本页所属协会」作用域里跑一次写操作（可异步）。
     *
     * 【为什么写也要按页内协会】个人详情页 / 他人主页允许页内切换协会查看。
     * 页内协会若不带给写接口，服务端就会按**全局**当前协会判权限与盖章，
     * 于是「在 B 协会的页面上」做的一次调整会被算到 A 协会头上。这里把绑定
     * 页内协会的客户端交给回调，非局部分页则绑定调用时的全局协会。
     *
     * @param {Function} fn 接收绑定协会的 api，返回 Promise
     * @returns {Promise<*>}
     */
    runInLocalAssociation(fn) {
      const association = localAssociation && this.localAssociation || scope.getAssociation();
      return scope.withAssociation(association, fn);
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
          : `撤销 ${target.nickName} 的学院负责人身份，他将失去本学院的管理权限`,
        '任免学院负责人'
      );
      if (!confirmed) return undefined;

      // 写也走本页协会作用域：否则服务端按全局协会判权，页内切到别的协会时
      // 会改错协会（见 runInLocalAssociation）
      const result = await this.runInLocalAssociation((api) =>
        api.setCollegeLeader(target.userId, user._id, leader.makeLeader)
      );
      if (!result.ok) {
        this.showToast(result.message || '操作失败');
        return undefined;
      }
      this.showToast(leader.makeLeader ? '已设为学院负责人' : '已撤销学院负责人', 'success');
      return this.refresh();
    },

    /**
     * 把当前主页的会员设为 / 撤销为**本页所属协会**的协会负责人。
     *
     * 入口仅对全局管理员显示（profile-view 用 validateAssociationLeader 算出），
     * 写入端仍会再判一次——有效角色是 ADMIN 的协会负责人不会被放行。
     *
     * @returns {Promise<void>|undefined}
     */
    async onSetAssociationLeader() {
      const view = this.data.view;
      const target = view && view.user;
      const leader = view && view.associationLeader;
      if (!target || !leader || !leader.visible) return undefined;

      const user = this.currentUser();
      if (!user) {
        this.showToast('请先登录后再操作');
        return undefined;
      }

      const confirmed = await this.confirm(
        leader.makeLeader
          ? `将 ${target.nickName} 设为本协会的协会负责人，他可管理本协会的赛事、会员与公告`
          : `撤销 ${target.nickName} 的协会负责人身份，他将失去本协会的管理权限`,
        '任免协会负责人'
      );
      if (!confirmed) return undefined;

      const result = await this.runInLocalAssociation((api) =>
        api.setAssociationLeader(target.userId, user._id, leader.makeLeader)
      );
      if (!result.ok) {
        this.showToast(result.message || '操作失败');
        return undefined;
      }
      this.showToast(leader.makeLeader ? '已设为协会负责人' : '已撤销协会负责人', 'success');
      return this.refresh();
    },

    /**
     * 统一的「指定权限」入口：点开后按当前身份**可授予**的档位给出选项，
     * 再复用各自的处理完成写入。能选哪几档由 profile-view 的可见性决定——
     * 全局管理员可任免协会负责人，有学院管理权者可任免学院负责人，
     * 权限不同、入口同一个（§11）。
     *
     * @returns {Promise<void>|undefined}
     */
    onGrantPermission() {
      const view = this.data.view || {};
      const options = [];
      if (view.associationLeader && view.associationLeader.visible) {
        options.push({ key: 'associationLeader', label: view.associationLeader.label });
      }
      if (view.leader && view.leader.visible) {
        options.push({ key: 'leader', label: view.leader.label });
      }
      if (!options.length) return undefined;
      const run = (key) => key === 'associationLeader'
        ? this.onSetAssociationLeader() : this.onSetCollegeLeader();
      // 真机弹选择框；Node 测试没有 wx.showActionSheet，直接采用首项。
      if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') {
        return run(options[0].key);
      }
      return new Promise((resolve) => {
        wx.showActionSheet({
          itemList: options.map((option) => option.label),
          success: (res) => {
            const picked = options[res.tapIndex];
            return picked ? resolve(run(picked.key)) : resolve(undefined);
          },
          fail: () => resolve(undefined),
        });
      });
    },

    /**
     * 调整当前主页会员在**本协会当前项目**的当前等级分。用于「在外打完比赛、
     * 对手不在本程序里」的同步：直接改成外部算好的分数。数值从弹层输入框取；
     * Node 测试没有 wx.showModal，直接把当前值当作提交值（用例可改调
     * submitCurrentElo 直接驱动）。
     *
     * @returns {Promise<void>|undefined}
     */
    onEditCurrentElo() {
      const entry = this.data.view && this.data.view.currentElo;
      if (!entry || !entry.visible) return undefined;

      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        return this.submitCurrentElo(entry.current);
      }
      return new Promise((resolve) => {
        wx.showModal({
          title: `调整${entry.label}等级分`,
          editable: true,
          placeholderText: '0–3000 的整数',
          content: entry.current === null ? '' : String(entry.current),
          success: (res) => {
            if (!res.confirm) return resolve(undefined);
            resolve(this.submitCurrentElo(res.content));
          },
          fail: () => resolve(undefined),
        });
      });
    },

    /**
     * 写入当前等级分。改的是当前显示项目对应的池（entry.pool），之后的比赛
     * 会从这个新值继续累加。独立成方法，便于测试绕过 wx 弹层直接驱动。
     *
     * @param {*} value 输入框里的原始值
     * @returns {Promise<void>|undefined}
     */
    async submitCurrentElo(value) {
      const entry = this.data.view && this.data.view.currentElo;
      const target = this.data.view && this.data.view.user;
      if (!entry || !entry.visible || !target) return undefined;

      const user = this.currentUser();
      if (!user) {
        this.showToast('请先登录后再操作');
        return undefined;
      }

      const result = await this.runInLocalAssociation((api) =>
        api.setMemberElo(target.userId, entry.pool, value, user._id)
      );
      if (!result.ok) {
        this.showToast(result.message || '操作失败');
        return undefined;
      }
      this.showToast('已更新等级分', 'success');
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
