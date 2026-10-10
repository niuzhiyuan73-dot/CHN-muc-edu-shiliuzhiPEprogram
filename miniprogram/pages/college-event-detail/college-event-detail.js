/**
 * 学院赛详情（报名中抽签 → 待开赛开赛 → 进行中打大场）
 * ============================================================
 * 取数与整形在 services/college-view.js 的 loadCollegeEventDetailView，
 * 权限与规则在 college-draw.js / college-tie.js / college-lineup.js（纯函数），
 * 页面只做渲染与交互。
 *
 * 【为什么抽签、开赛、大场同页】
 * 三件事在时间上首尾相接，状态一推，该出现的入口自然就换了一批（见视图
 * 模型里的注释）。分成三个页面，管理员每走一步都要回上一页再点进来。
 * 名单审核仍留在独立的审核页，从本页给一个入口。
 *
 * 【种子的交互口径】
 * 按顺序点选：先点的排 1 号，再点一次取消。这是 D17 定死的手工指定，
 * 学院没有等级分，不拿院内个人的平均分去猜「学院实力」。种子的合法性
 * （必须来自已通过名单、不能重复）由 college-draw.js 兜底，页面只维护
 * 点击顺序。
 * ============================================================
 */

const { loadCollegeEventDetailView, buildSeedRows } = require('../../services/college-view.js');
const { buildPickerRows, pickerEmptyText } = require('../../services/match-entry-view.js');
const { watchLiveScores } = require('../../services/live-watch.js');
const { applyLiveTies } = require('../../services/live-view.js');
const {
  drawCollegeEvent,
  startCollegeEvent,
  startTie,
  assignTieReferee,
  getMembers,
  isMock,
} = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/college-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 正在处理的按钮标识（tieId 或固定动作名），防止连点 */
    acting: '',
    /** 已点选的种子学院（按点击顺序） */
    seeds: [],
    /** 抽签面板里渲染的行：学院 + 是否种子 + 种子序号文案 */
    seedRows: [],

    /**
     * 指派大场裁判面板。入口由视图模型的 canAssignReferee 控制，页面不自己判角色。
     * 与赛事详情页的小场面板同一套，管理员在两处用起来一致。
     */
    referee: {
      open: false,
      tieId: '',
      hasReferee: false,
      selectedId: '',
      keyword: '',
      rows: [],
      emptyText: '',
    },
    /** 指派提交中，防止连点 */
    refereeActing: false,
  },

  /**
   * 返回 Promise 是有意为之：测试需要一个句柄来等首屏加载完。
   * @param {Object} [query] 路由参数，带 eventId
   */
  onLoad(query = {}) {
    this.eventId = query.eventId || '';
    return this.refresh();
  },

  /** 从排阵页 / 审核页返回时刷新一次，刚交的排阵与刚通过的名单才在页面上 */
  onShow() {
    if (!this.loaded) return undefined;
    return this.refresh();
  },

  /** 离开本页就停表，不再空转；回到前台时 onShow 会重新订阅 */
  onHide() {
    if (this.liveHandle) this.liveHandle.pause();
  },

  onUnload() {
    if (this.liveHandle) {
      this.liveHandle();
      this.liveHandle = null;
    }
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 重新装载整页数据。种子的已选状态是页面交互态，刷新时保留——
   * 但只在学院仍有效时保留，避免已取消的种子留在列表里。
   * @returns {Promise<void>}
   */
  async refresh() {
    try {
      const view = await loadCollegeEventDetailView(this.eventId, { user: this.currentUser() });
      const approved = view.approvedColleges || [];
      const seeds = (this.data.seeds || []).filter((name) => approved.includes(name));
      this.loaded = true;
      this.setData({
        loading: false,
        error: '',
        view,
        seeds,
        seedRows: buildSeedRows(approved, seeds),
      });
      // 首屏若已有正在计分的小场（读接口已带上 live），才挂轮询取增量
      this.syncLiveWatch();
    } catch (err) {
      console.error('[college-event-detail] 加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '学院赛详情页加载失败，请返回重试' });
    }
  },

  /* ---------- 实时比分 ---------- */

  /**
   * 值得轮询的小场编号：只取正在逐球计分、且还没结束的那些。
   * 大场行里的 legRows 才是真正带 matchId 的一层，逐层摊平后过滤。
   */
  liveIds() {
    const ties = (this.data.view && this.data.view.ties) || [];
    const ids = [];
    for (const tie of ties) {
      for (const leg of (tie && tie.legRows) || []) {
        if (leg && leg.liveActive && !(leg.live && leg.live.finished)) ids.push(leg.matchId);
      }
    }
    return ids;
  },

  /**
   * 重新订阅实时比分。名单随刷新而变，每次刷新都重订一次即可
   * ——适配器会先停旧表，天然完成重订阅。
   */
  syncLiveWatch() {
    if (this.liveHandle) this.liveHandle();
    this.liveHandle = watchLiveScores(this.liveIds(), (views) => {
      this.setData({ 'view.ties': applyLiveTies(this.data.view.ties || [], views) });
    });
  },

  /* ---------- 抽签 ---------- */

  /**
   * 点选 / 取消种子。勾选顺序即种子序号，再点一次从序列里去掉。
   */
  onToggleSeed(event) {
    const college = event.currentTarget.dataset.college;
    if (!college) return;

    const seeds = [...(this.data.seeds || [])];
    const index = seeds.indexOf(college);
    if (index >= 0) seeds.splice(index, 1);
    else seeds.push(college);

    this.setData({
      seeds,
      seedRows: buildSeedRows(this.data.view.approvedColleges || [], seeds),
    });
  },

  async onDraw() {
    if (this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再抽签');
      return undefined;
    }

    this.setData({ acting: 'draw' });
    const result = await drawCollegeEvent(this.eventId, user._id, { seedColleges: this.data.seeds });
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '抽签失败');
      return undefined;
    }

    this.showToast('抽签完成，名单已锁定', 'success');
    return this.refresh();
  },

  /* ---------- 开赛 ---------- */

  async onStartEvent() {
    if (this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再开始赛事');
      return undefined;
    }

    this.setData({ acting: 'startEvent' });
    const result = await startCollegeEvent(this.eventId, user._id);
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '开始失败');
      return undefined;
    }

    this.showToast('赛事已开始，请各学院提交排阵', 'success');
    return this.refresh();
  },

  /** 大场级「开始」：双方排阵齐才能点，后端会再校验一次 */
  async onStartTie(event) {
    const tieId = event.currentTarget.dataset.tieId;
    if (!tieId || this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再开始大场');
      return undefined;
    }

    this.setData({ acting: tieId });
    const result = await startTie(tieId, user._id);
    this.setData({ acting: '' });

    if (!result.ok) {
      this.showToast(result.message || '开始失败');
      return undefined;
    }

    this.showToast('大场已开始', 'success');
    return this.refresh();
  },

  /* ---------- 指派大场裁判 ---------- */

  /**
   * 取会员名单，供面板筛选。
   * 只取一次并缓存在实例上：面板可能被反复打开，名单在一次会话里不会变。
   */
  async pickerMembers() {
    if (!this.members) {
      const members = await getMembers();
      this.members = (members || []).map((member) => ({
        id: member._id,
        name: member.nickName || member.realName || member._id,
        realName: member.realName || '',
      }));
    }
    return this.members;
  },

  /** 按关键字刷新面板列表 */
  async applyRefereeKeyword(keyword) {
    const members = await this.pickerMembers();
    this.setData({
      'referee.keyword': keyword,
      'referee.rows': buildPickerRows(members, keyword, this.data.referee.selectedId),
      'referee.emptyText': pickerEmptyText(keyword),
    });
  },

  /** 打开指派面板。当前是谁当头一版勾出来 */
  async onOpenReferee(event) {
    const tieId = event.currentTarget.dataset.tieId;
    if (!tieId) return undefined;

    const record = (this.data.view.ties || []).find((item) => item.tieId === tieId);
    const selectedId = (record && record.referee) || '';
    const members = await this.pickerMembers();
    const rows = buildPickerRows(members, '', selectedId);

    this.setData({
      referee: {
        open: true,
        tieId,
        hasReferee: Boolean(record && record.referee),
        selectedId,
        keyword: '',
        rows,
        emptyText: pickerEmptyText(''),
      },
    });
    return undefined;
  },

  onInputRefereeKeyword(event) {
    return this.applyRefereeKeyword(event.detail.value);
  },

  onCancelReferee() {
    if (this.data.refereeActing) return;
    this.setData({ referee: { ...this.data.referee, open: false } });
  },

  /** 撤下裁判：传空串，大场随即回到「各小场各自为政」的口径 */
  onClearReferee() {
    return this.assignReferee('');
  },

  /** 选中某位会员当裁判。点「当前」那位等于不改派，直接关掉面板 */
  onPickReferee(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId || userId === this.data.referee.selectedId) {
      this.setData({ referee: { ...this.data.referee, open: false } });
      return undefined;
    }
    return this.assignReferee(userId);
  },

  /**
   * 落库一次指派。
   * 写入端会再校验一遍（仅管理员、大场未结束、此人正常在册），这里的校验
   * 只为了少跑一趟：点错了当场就能看到原因。指派的裁判会铺到本大场还没
   * 开打的各小场上。
   */
  async assignReferee(refereeId) {
    if (this.data.refereeActing) return undefined;

    const { tieId } = this.data.referee;
    const user = this.currentUser();
    if (!tieId) return undefined;
    if (!user) {
      this.showToast('请先登录后再指派裁判');
      return undefined;
    }

    this.setData({ refereeActing: true });
    const result = await assignTieReferee(tieId, refereeId, user._id);
    this.setData({ refereeActing: false });

    if (!result.ok) {
      this.showToast(result.message || '指派失败');
      return undefined;
    }

    this.setData({ referee: { ...this.data.referee, open: false } });
    this.showToast(refereeId ? '已指派裁判' : '已撤下裁判', 'success');
    return this.refresh();
  },

  /* ---------- 跳转 ---------- */

  /** 去本大场的排阵页 */
  onOpenLineup(event) {
    const { tieId } = event.currentTarget.dataset;
    if (!tieId) return;

    wx.navigateTo({
      url: `/pages/college-lineup/college-lineup?tieId=${tieId}&eventId=${this.eventId}`,
    });
  },

  /** 去某个小项的录分页（参赛者 / 学院负责人 / 管理员） */
  onOpenMatch(event) {
    const { matchId } = event.currentTarget.dataset;
    if (!matchId) return;

    wx.navigateTo({ url: `/pages/college-match/college-match?matchId=${matchId}` });
  },

  /** 去名单审核页（管理员） */
  onOpenReview() {
    wx.navigateTo({ url: `/pages/college-entry-review/college-entry-review?eventId=${this.eventId}` });
  },

  /** 去本学院名单提交页（学院负责人） */
  onOpenEntry() {
    wx.navigateTo({ url: `/pages/college-entry/college-entry?eventId=${this.eventId}` });
  },

  /** 去学院名次录入页（管理员）。提交后赛事即结束 */
  onOpenPlacement() {
    wx.navigateTo({
      url: `/pages/college-placement/college-placement?eventId=${this.eventId}`,
    });
  },

  onBack() {
    wx.navigateBack();
  },

  /** 吞掉面板内层的冒泡，免得点名单时把面板一起关掉 */
  noop() {},
});
