/**
 * 赛事详情
 * ============================================================
 * 一场赛事的全部动作都收在这一页：
 *   会员：报名 / 取消报名；
 *   管理：开始赛事 / 代签 / 进名次录入页。
 * 取数与权限判定全在 services/events-view.js，页面只做交互与 setData。
 *
 * 【为什么按钮由数据决定、不在这里判权限】
 * 视图模型已经把 canSignUp / canStart / canCheckIn / canFinish 算进每一行，
 * 页面照着渲染即可。页面里写 `user.role >= 1` 这种判断，Node 跑不了，
 * 等于没法测——与 announcement / season-manage 同一纪律。
 *
 * 【每次写操作后为什么整页重载】
 * 报名人数、签到状态、按钮可用性都会随之变化。局部改 setData 要维护
 * 一整套本地状态，越改越容易和真值分叉；重载一次数据都在内存里，很快。
 * ============================================================
 */

const { loadEventDetailView } = require('../../services/events-view.js');
const { buildPickerRows, pickerEmptyText } = require('../../services/match-entry-view.js');
const { watchLiveScores } = require('../../services/live-watch.js');
const { applyLiveRows } = require('../../services/live-view.js');
const {
  signUpEvent,
  cancelSignupEvent,
  startEvent,
  checkInEvent,
  drawEvent,
  confirmMatch,
  assignMatchReferee,
  getMembers,
  isMock,
} = require('../../services/index.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 视图模型，形状见 services/events-view.js */
    view: {},
    /** 开发期标注模拟数据 */
    isMock,
    /** 写操作进行中，防止连点 */
    acting: false,

    /** 「手工指定种子」面板是否打开 */
    seedDialogOpen: false,
    /** 已按顺序点选的种子编号，下标即 1 号、2 号…… */
    seedPicked: [],
    /** 候选名单 + 已选序号，供模板渲染（order 为 0 表示未选） */
    seedRows: [],
    /** 点选过程中的提示（选满了、还差几位） */
    seedError: '',

    /**
     * 指派裁判面板。入口由视图模型的 canAssignReferee 控制，页面不自己判角色。
     * 与比赛页同一套面板，管理员在两处用起来一致。
     */
    referee: {
      open: false,
      matchId: '',
      hasReferee: false,
      selectedId: '',
      keyword: '',
      rows: [],
      emptyText: '',
    },
    /** 指派提交中，防止连点 */
    refereeActing: false,
  },

  /** 返回 Promise 让测试能等待首屏加载完 */
  onLoad(query) {
    this.eventId = (query && query.eventId) || '';
    return this.refresh();
  },

  /** 从名次录入页返回时刷新一次，刚录的名次才在页面上 */
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

  /** 下拉刷新 */
  onPullDownRefresh() {
    return this.refresh().then(() => this.stopPullDown());
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** stopPullDownRefresh 在测试环境里可能没有，做个保护 */
  stopPullDown() {
    if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') {
      wx.stopPullDownRefresh();
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /**
   * 二次确认。测试环境里没有 wx.showModal，直接放行——
   * 测试要验证的是「确认之后做了什么」，不是弹窗本身。
   */
  confirm(content, title = '请确认') {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
        resolve(true);
        return;
      }
      wx.showModal({
        title,
        content,
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      });
    });
  },

  /**
   * 重新装载整页数据。
   * @returns {Promise<void>}
   */
  async refresh() {
    const user = this.currentUser();

    try {
      const view = await loadEventDetailView(this.eventId, { user, isMock });
      this.loaded = true;
      this.setData({ loading: false, error: '', view });
      // 首屏若已有正在计分的场次（读接口已带上 live），才挂轮询取增量
      this.syncLiveWatch();
    } catch (err) {
      console.error('[event-detail] 赛事详情加载失败', err);
      this.loaded = true;
      this.setData({ loading: false, error: '赛事详情加载失败，请下拉重试' });
    }
  },

  /* ---------- 实时比分 ---------- */

  /**
   * 值得轮询的比赛编号：只有正在逐球计分、且还没结束的那几场。
   * 空数组交给适配器 = 一张表都不启，也就一次请求都不发。
   */
  liveIds() {
    const rows = (this.data.view && this.data.view.bracketRows) || [];
    return rows
      .filter((row) => row.liveActive && !(row.live && row.live.finished))
      .map((row) => row.matchId);
  },

  /**
   * 重新订阅实时比分。签表随刷新而变，每次刷新都重订一次即可
   * ——适配器会先停旧表，天然完成重订阅。
   */
  syncLiveWatch() {
    if (this.liveHandle) this.liveHandle();
    this.liveHandle = watchLiveScores(this.liveIds(), (views) => {
      this.setData({ 'view.bracketRows': applyLiveRows(this.data.view.bracketRows || [], views) });
    });
  },

  /**
   * 写操作的统一收口：判登录 → 调接口 → 提示 → 整页刷新。
   * 接口只认登录会员的编号，页面递不出别人的身份。
   *
   * @param {(actorId:string) => Promise<Object>} write 写接口
   * @param {string} successText 成功后的提示
   * @returns {Promise<void>}
   */
  async runWrite(write, successText) {
    if (this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    this.setData({ acting: true });
    const result = await write(user._id);
    this.setData({ acting: false });

    if (!result || !result.ok) {
      this.showToast((result && (result.firstError || result.message)) || '操作失败');
      return undefined;
    }

    this.showToast(successText, 'success');
    return this.refresh();
  },

  /** 报名这一场 */
  onSignUp() {
    return this.runWrite((actorId) => signUpEvent(this.eventId, actorId), '报名成功');
  },

  /** 取消报名 */
  onCancelSignup() {
    return this.runWrite((actorId) => cancelSignupEvent(this.eventId, actorId), '已取消报名');
  },

  /** 开始赛事。报名会在这一刻截止，先确认一道 */
  async onStart() {
    const confirmed = await this.confirm('开始后报名就截止了，确定现在开始这场赛事吗？', '开始赛事');
    if (!confirmed) return undefined;
    return this.runWrite((actorId) => startEvent(this.eventId, actorId), '赛事已开始');
  },

  /** 代某位会员签到。只有学院负责人以上能点，按钮与否由视图模型决定 */
  onCheckIn(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return undefined;
    return this.runWrite((actorId) => checkInEvent(this.eventId, userId, actorId), '已签到');
  },

  /**
   * 抽签 / 重抽。
   *
   * 手工指定种子的赛事不能直接抽：还缺一份「谁是 1 号种子」的名单，得先
   * 打开面板让管理员点名，凑齐了再走真正抽签那一步（见 onConfirmSeeds）。
   * 按等级分 / 赛季积分排的，算法自己排得出来，这里直接确认即可。
   */
  async onDraw() {
    if (this.data.acting) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    if (this.data.view.event.isManualSeed) {
      this.openSeedDialog();
      return undefined;
    }

    return this.runDraw(user, undefined);
  },

  /**
   * 确认之后真正落库的一步。
   *
   * 【为什么随机值取此刻的时间戳并落库】
   * 决策 4.4：抽签结果必须可复核。把 seedValue 一并存进 draw 字段后，
   * 任何人拿同一个值重跑就能得到同一张签表。这里只负责给一个值。
   *
   * @param {Object} user 当前登录会员
   * @param {string[]|undefined} manualOrder 手工指定的种子顺序，其余模式传 undefined
   */
  async runDraw(user, manualOrder) {
    const times = this.data.view.event.drawCount || 0;
    const confirmed = await this.confirm(
      times
        ? '重抽会作废现有签表与其中未确认的比赛，确定重抽吗？'
        : '抽签后名单会锁定，报名随即截止。确定开始抽签吗？',
      times ? '重新抽签' : '开始抽签'
    );
    if (!confirmed) return undefined;

    this.setData({ acting: true });
    const result = await drawEvent(this.eventId, user._id, { seedValue: Date.now(), manualOrder });
    this.setData({ acting: false });

    if (!result || !result.ok) {
      this.showToast((result && result.message) || '抽签失败');
      return undefined;
    }

    this.showToast(times ? '已重新抽签' : '抽签完成', 'success');
    return this.refresh();
  },

  /* ---------- 手工指定种子 ---------- */

  /** 把候选名单与已选顺序拼成模板要的行：order 为 0 表示未选 */
  buildSeedRows(picked) {
    const candidates = this.data.view.seedCandidates || [];
    return candidates.map((item) => {
      const at = picked.indexOf(item.userId);
      return {
        userId: item.userId,
        nickName: item.nickName,
        avatarText: item.avatarText,
        avatarUrl: item.avatarUrl || '',
        order: at >= 0 ? at + 1 : 0,
      };
    });
  },

  /** 面板里的空操作：挡住点击穿透，点面板本身不该关掉它 */
  noop() {},

  openSeedDialog() {
    this.setData({
      seedDialogOpen: true,
      seedPicked: [],
      seedRows: this.buildSeedRows([]),
      seedError: '',
    });
  },

  onCloseSeedDialog() {
    this.setData({ seedDialogOpen: false, seedPicked: [], seedRows: [], seedError: '' });
  },

  /**
   * 点选 / 取消一位种子。
   *
   * 【为什么按点击先后排号，而不是点完再排】
   * 决策 9.4：1 号种子是谁由管理员定，等级分高不见得就要排第一。
   * 所以先点的是 1 号、后点的是 2 号，顺序本身就是输入。
   */
  onToggleSeed(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return undefined;

    const picked = this.data.seedPicked.slice();
    const at = picked.indexOf(userId);

    // 再点一次已选的人＝取消，方便点错了就地改
    if (at >= 0) {
      picked.splice(at, 1);
      this.setData({ seedPicked: picked, seedRows: this.buildSeedRows(picked), seedError: '' });
      return undefined;
    }

    const needed = this.data.view.manualSeedNeeded || 0;
    if (picked.length >= needed) {
      this.setData({ seedError: `一共只需指定 ${needed} ${this.data.view.seedUnit || '位种子'}` });
      return undefined;
    }

    picked.push(userId);
    this.setData({ seedPicked: picked, seedRows: this.buildSeedRows(picked), seedError: '' });
    return undefined;
  },

  /** 清空重选 */
  onClearSeeds() {
    this.setData({ seedPicked: [], seedRows: this.buildSeedRows([]), seedError: '' });
  },

  /** 点名完毕，开始抽签 */
  async onConfirmSeeds() {
    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再操作');
      return undefined;
    }

    const needed = this.data.view.manualSeedNeeded || 0;
    const picked = this.data.seedPicked;
    if (picked.length !== needed) {
      const short = needed - picked.length;
      this.setData({ seedError: `还需指定 ${short} ${this.data.view.seedUnit || '位种子'}` });
      return undefined;
    }

    // 先收起面板，抽签失败时再来一次不必重新点名
    this.setData({ seedDialogOpen: false, seedRows: [], seedError: '' });
    return this.runDraw(user, picked.slice());
  },

  /** 给抽签排出的比赛录分：跳到录入页，带上这一场的编号 */
  onRecordMatch(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) return;
    wx.navigateTo({ url: `/pages/match-entry/match-entry?matchId=${matchId}` });
  },

  /** 确认一场已录分的比赛，成绩随即计入等级分 */
  async onConfirmMatch(event) {
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) return undefined;
    return this.runWrite((actorId) => confirmMatch(matchId, actorId), '已确认，成绩已计入等级分');
  },

  /* ---------- 指派裁判 ---------- */

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
    const matchId = event.currentTarget.dataset.matchId;
    if (!matchId) return undefined;

    const record = (this.data.view.bracketRows || []).find((item) => item.matchId === matchId);
    const selectedId = (record && record.referee) || '';
    const members = await this.pickerMembers();
    const rows = buildPickerRows(members, '', selectedId);

    this.setData({
      referee: {
        open: true,
        matchId,
        hasReferee: Boolean(record && record.hasReferee),
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

  /** 撤下裁判：传空串，比赛随即回到「人人照旧」的口径 */
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
   * 写入端会再校验一遍（仅管理员、比赛未生效、此人正常在册），这里的
   * 校验只为了少跑一趟：点错了当场就能看到原因。
   */
  async assignReferee(refereeId) {
    if (this.data.refereeActing) return undefined;

    const { matchId } = this.data.referee;
    const user = this.currentUser();
    if (!matchId) return undefined;
    if (!user) {
      this.showToast('请先登录后再指派裁判');
      return undefined;
    }

    this.setData({ refereeActing: true });
    const result = await assignMatchReferee(matchId, refereeId, user._id);
    this.setData({ refereeActing: false });

    if (!result.ok) {
      this.showToast(result.message || '指派失败');
      return undefined;
    }

    this.setData({ referee: { ...this.data.referee, open: false } });
    this.showToast(refereeId ? '已指派裁判' : '已撤下裁判', 'success');
    return this.refresh();
  },

  /** 进名次录入页 */
  onOpenPlacement() {
    wx.navigateTo({ url: `/pages/event-placement/event-placement?eventId=${this.eventId}` });
  },

  /** 点名单上的人，去看他的主页 */
  onOpenMember(event) {
    const userId = event.currentTarget.dataset.userId;
    if (!userId) return;

    wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
  },
});
