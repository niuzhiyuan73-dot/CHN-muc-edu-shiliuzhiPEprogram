/**
 * 实时计分台（唯一的横屏页）
 * ============================================================
 * 一场比赛从 0:0 打到分出胜负，每一球判给一边。这里只做三件事：
 * 取这一场与会员名单、把每次点击变成一次判球、把实时态画出来。
 * 判一球的规则全在 services/live-score.js（纯逻辑，三端共用），
 * 权限与落库全在数据源那侧——页面既不算分，也不判权。
 *
 * 【为什么横屏】
 * 计分台是放在球网边、隔着一两米点的，横屏才有足够大的两块按钮。
 * pageOrientation 写在本页自己的 .json 里，app.json 的 window 不动，
 * 因此其余页面一律照旧竖屏（见计划 §八.6）。
 *
 * 【为什么点击是乐观更新 + 串行队列】
 * 录分讲究「点下去立刻看见分」，等一次云函数往返再刷新会明显发木。
 * 所以点击先在本地按同一套纯逻辑加分，再把请求排进一条串行队列：
 *   - 串行保证服务端收到的顺序与点击顺序一致；
 *   - 每球带一个客户端生成的 rallyId，重发不会计两次（§八.3）；
 *   - 队列彻底排空时用服务端的返回对账一次，本地与服务端不会漂移；
 *   - 中途失败就提示并以服务端为准重新拉一次，不把错的分留在屏幕上。
 *
 * 【为什么首屏不会「先 0:0 再跳」】
 * 进页面就调 startLiveScore：已存在就取回现有实时态（重开不重置比分），
 * 不存在才新建 0:0。屏幕上的第一帧就是真实比分。
 *
 * 【定稿不等于生效】
 * finishLiveScore 只是把打完的局转成正式比分，得到的仍是一条**待确认**
 * 的比赛——确认权照旧在裁判 / 管理员手上。所以这里定稿后要能退回原页，
 * 让别人去确认。
 * ============================================================
 */

const {
  getMatchRecords,
  getMembers,
  startLiveScore,
  recordRally,
  undoRally,
  finishLiveScore,
} = require('../../services/index.js');
const { applyRally, liveScoreOf, LIVE_STATUS } = require('../../services/live-score.js');
const { canRecordScore, hasReferee } = require('../../services/match-record.js');
const { formatMatchFormat } = require('../../utils/match-format.js');
const { MATCH_COMPETITION, MATCH_STATUS, ROLE } = require('../../utils/constants.js');
const { currentThemeClass } = require('../../services/branding.js');

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',
    /** 不能计分的原因，非空就顶掉整个计分台 */
    blockReason: '',
    /** 操作过程中的提示（判球失败、撤销失败等），成功一次新的判球就清掉 */
    notice: '',

    /** 左右两方的显示名：个人赛是队员姓名，学院赛是学院名 */
    labelA: 'A 队',
    labelB: 'B 队',
    /** 赛制文案，例如「11 分制 · 三局两胜」 */
    formatText: '',
    /** 这一场的裁判（有就提示一句）。空表示未指定裁判 */
    refereeNotice: '',

    /**
     * 当前的实时视图，形状见 services/live-score.js 的 liveScoreOf：
     * { pointsA, pointsB, gamesA, gamesB, gameIndex, status, finished,
     *   leading, gamePoints, bestOf }
     */
    view: { pointsA: 0, pointsB: 0, gamesA: 0, gamesB: 0, gameIndex: 0, status: 'live', finished: false, leading: '' },
    /** 有可撤销的球才亮撤销按钮 */
    canUndo: false,
    /** 分出胜负才能定稿 */
    canFinish: false,
    /** 定稿请求进行中，防连点 */
    finishing: false,
  },

  /**
   * 返回 Promise 是有意为之：测试需要句柄等首屏加载完。
   * @param {Object} [query] 路由参数，必带 matchId
   * @returns {Promise<void>}
   */
  onLoad(query = {}) {
    this.matchId = query.matchId || '';
    // 一条串行队列：所有写请求按点击顺序排队，队尾即「最新」
    this.queue = Promise.resolve();
    /** 尚未拿到服务端回执的请求数；归零才对账 */
    this.pending = 0;
    /** 本地计球编号的自增序，仅用于拼出唯一的 rallyId */
    this.rallySeq = 0;
    /** 页面是否已销毁。销毁后队列里的回调不再 setData / navigateBack */
    this.destroyed = false;
    return this.init();
  },

  /** 进页与回到前台时刷新根节点主题类。本页没有 refresh，就在这里写一次 */
  onShow() {
    this.setData({ themeClass: currentThemeClass() });
  },

  /**
   * 退出页面时立起「已销毁」标：写请求排成串行队列，用户可能在某次请求
   * 尚未返回时就离开。若不管，迟到的 sendFinish 会再 navigateBack 一次
   * （多弹一页），或对已销毁的页面 setData。
   */
  onUnload() {
    this.destroyed = true;
  },

  /** 销毁后不再写界面 */
  safeSetData(patch) {
    if (this.destroyed) return;
    this.setData(patch);
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
   * 装载：取比赛与名单 → 校验录分权 → 开 / 取实时态。
   * @returns {Promise<void>}
   */
  async init() {
    const user = this.currentUser();
    if (!user) {
      this.setData({ loading: false, blockReason: '请先登录后再计分' });
      return;
    }

    try {
      const [members, records] = await Promise.all([
        getMembers(),
        getMatchRecords({ id: this.matchId }),
      ]);
      const record = records && records[0];
      if (!record) {
        this.setData({ loading: false, error: '这场比赛不存在，或已被删除' });
        return;
      }

      // 编号 → 昵称，供个人赛显示队员姓名
      this.nameById = {};
      (members || []).forEach((item) => {
        this.nameById[item._id] = item.nickName || item._id;
      });

      // 与写入端同一口径：已生效 / 已作废的场次开不了台；能不能录看录分权
      // （指定裁判后只有裁判与管理员能录，见 match-record.canRecordScore）
      const collegeByMember = new Map((members || []).map((m) => [m._id, m.college || '']));
      const allowed =
        record.status === MATCH_STATUS.PENDING &&
        canRecordScore(record, user._id, {
          role: Number(user.role),
          college: user.college || '',
          collegeOf: (id) => collegeByMember.get(id) || '',
        });
      if (!allowed) {
        this.setData({
          loading: false,
          blockReason: hasReferee(record)
            ? `本场由 ${this.nameOf(record.referee) || record.referee} 裁判执法，仅裁判与管理员可计分`
            : '你无权为这场比赛计分',
        });
        return;
      }

      this.actor = user._id;
      const opened = await startLiveScore(this.matchId, this.actor);
      if (!opened.ok || !opened.live) {
        this.setData({ loading: false, blockReason: opened.message || '无法开启实时计分台' });
        return;
      }

      this.setData({
        loading: false,
        error: '',
        blockReason: '',
        labelA: this.labelFor(record, 'A'),
        labelB: this.labelFor(record, 'B'),
        formatText: formatMatchFormat({ gamePoints: record.gamePoints, bestOf: record.bestOf }),
        refereeNotice: this.describeReferee(record, user),
      });
      this.applyLive(opened.live);
    } catch (err) {
      console.error('[live-score] 初始化失败', err);
      this.setData({ loading: false, error: '计分台加载失败，请返回重试' });
    }
  },

  /** 编号 → 昵称 */
  nameOf(userId) {
    if (!userId) return '';
    return (this.nameById && this.nameById[userId]) || '';
  },

  /** 这一场有没有裁判，有就拼一句提示；没指定返回空串 */
  describeReferee(record, user) {
    if (!hasReferee(record)) return '';
    const name = this.nameOf(record.referee) || String(record.referee);
    const isMine = user && user._id === record.referee;
    return isMine ? `本场由你执法（${name}）` : `本场由 ${name} 裁判执法`;
  },

  /**
   * 一方的显示名。学院赛用学院名，个人赛用队员昵称；都没有才退回 A / B 队。
   * @param {Object} record
   * @param {'A'|'B'} side
   * @returns {string}
   */
  labelFor(record, side) {
    const fallback = side === 'A' ? 'A 队' : 'B 队';
    if (record.competition === MATCH_COMPETITION.COLLEGE) {
      const college = side === 'A' ? record.collegeA : record.collegeB;
      return college || fallback;
    }
    const ids = side === 'A' ? record.teamA : record.teamB;
    const names = (Array.isArray(ids) ? ids : []).map((id) => this.nameOf(id)).filter(Boolean);
    return names.length ? names.join('、') : fallback;
  },

  /**
   * 把实时态落到界面。所有展示都从这里走，免得某个按钮的可用状态忘了更新。
   * @param {Object} state 实时态原始对象（含 rallies）
   */
  applyLive(state) {
    this.state = state;
    const view = liveScoreOf(state) || this.data.view;
    this.setData({
      view,
      // 定稿之后实时态只读：撤分会与已经写进比赛记录的正式比分打架
      canUndo: Boolean(state && state.rallies && state.rallies.length > 0 && !state.finalizedAt),
      canFinish: Boolean(view && view.finished && !state.finalizedAt),
    });
  },

  /** 拼一个客户端计球编号：重发同一个编号不会被计两次 */
  nextRallyId() {
    this.rallySeq += 1;
    return `${this.matchId}-${Date.now()}-${this.rallySeq}`;
  },

  /* ---------- 判球 ---------- */

  onScore(event) {
    const side = event.currentTarget.dataset.side;
    const state = this.state;
    if (!state || state.status !== LIVE_STATUS.LIVE) return undefined;
    if (!this.actor) {
      this.showToast('请先登录后再计分');
      return undefined;
    }

    const rallyId = this.nextRallyId();
    // 先本地加分：点下去立刻在屏幕上看见，不等一次往返
    this.applyLive(applyRally(state, side, { rallyId }));
    this.setData({ notice: '' });

    this.pending += 1;
    this.queue = this.queue.then(() => this.sendRally(side, rallyId, this.actor));
    return undefined;
  },

  /**
   * 把一球发给服务端。成功后若队列已排空，就用服务端返回对账；
   * 失败则提示并以服务端为准重拉，避免本地多算 / 少算。
   */
  async sendRally(side, rallyId, actor) {
    let res;
    try {
      res = await recordRally(this.matchId, side, actor, { rallyId });
    } catch (err) {
      console.error('[live-score] 判球失败', err);
      res = { ok: false, message: '判球失败，请重试' };
    }
    this.pending -= 1;
    if (this.destroyed) return;

    if (!res.ok) {
      this.safeSetData({ notice: res.message || '判球失败' });
      if (this.pending === 0) await this.resync();
      return;
    }
    // 队尾对账：此时服务端已经收下全部点击，以它的结果为准最稳
    if (this.pending === 0 && res.live) this.applyLive(res.live);
  },

  /** 以服务端为准重拉实时态（startLiveScore 已存在就原样返回） */
  async resync() {
    try {
      const res = await startLiveScore(this.matchId, this.actor);
      if (res.ok && res.live) this.applyLive(res.live);
    } catch (err) {
      console.error('[live-score] 对账失败', err);
    }
  },

  /* ---------- 撤销 / 定稿 ---------- */

  onUndo() {
    if (!this.data.canUndo) return undefined;
    if (!this.actor) {
      this.showToast('请先登录后再撤销');
      return undefined;
    }
    this.setData({ notice: '' });
    this.pending += 1;
    this.queue = this.queue.then(() => this.sendUndo(this.actor));
    return undefined;
  },

  async sendUndo(actor) {
    let res;
    try {
      res = await undoRally(this.matchId, actor);
    } catch (err) {
      console.error('[live-score] 撤销失败', err);
      res = { ok: false, message: '撤销失败，请重试' };
    }
    this.pending -= 1;
    if (this.destroyed) return;

    if (!res.ok) {
      this.safeSetData({ notice: res.message || '撤销失败' });
      if (this.pending === 0) await this.resync();
      return;
    }
    if (this.pending === 0 && res.live) this.applyLive(res.live);
  },

  onFinish() {
    if (this.data.finishing || !this.data.canFinish) return undefined;
    if (!this.actor) {
      this.showToast('请先登录后再定稿');
      return undefined;
    }

    const submit = (confirmed) => {
      if (!confirmed) return;
      this.setData({ finishing: true, notice: '' });
      // 排到队尾：先让手上没发完的球落库，再定稿，否则会漏掉最后几球
      this.queue = this.queue.then(() => this.sendFinish(this.actor));
    };

    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
      submit(true);
      return undefined;
    }
    wx.showModal({
      title: '结束比赛',
      content: '定稿后比分将提交为待确认，由对手 / 裁判确认后生效。确定结束吗？',
      success: (res) => submit(Boolean(res && res.confirm)),
      fail: () => submit(false),
    });
    return undefined;
  },

  async sendFinish(actor) {
    let res;
    try {
      res = await finishLiveScore(this.matchId, actor);
    } catch (err) {
      console.error('[live-score] 定稿失败', err);
      res = { ok: false, message: '定稿失败，请重试' };
    }
    // 用户可能已经手动离开：此时既不该再 setData，也不该再退一次页
    if (this.destroyed) return;
    this.setData({ finishing: false });

    if (!res.ok) {
      this.setData({ notice: res.message || '定稿失败' });
      return;
    }
    this.showToast('已定稿，等待确认', 'success');
    wx.navigateBack();
  },

  onExit() {
    wx.navigateBack();
  },
});
