/**
 * 录入比赛成绩
 * ============================================================
 * 只做一件事：把一张填好的单子变成一条「待确认」的比赛记录。
 * 校验与组装在 services/match-record.js，表单的纯逻辑在
 * services/match-entry-view.js，这里负责取数、交互与 setData。
 *
 * 【为什么独立成页而不是比赛页里的一个弹层】
 * switchTab 不能带参数，比赛页是 tabBar 页，没法从别处直接跳到
 * 「正在录入」的状态。将来录入页要接收参数（改草稿、扫场地码），
 * 也只有普通页才做得到。
 *
 * 【未登录为什么不能进来】
 * 录入要把当前用户写进 A 队第一格并作为 recorder（见 seed.js 的约定）。
 * 没有身份就没有 A 队，整张单子无从填起。所以这里也拦一道——
 * 用户可能绕过比赛页直接从小程序码进来。
 *
 * 【选手名单为什么来自 getMembers】
 * 回放引擎遇到不在名单里的会员会直接抛错（replay.js）。本地注册的
 * local_* 账号不在种子里，绝不能出现在选手选择器里。
 * ============================================================
 */

const {
  getMembers,
  getHomeSummary,
  getMatchRecords,
  getSeasonPairCounts,
  submitMatch,
  isMock,
} = require('../../services/index.js');
const { resolveAuthState } = require('../../services/auth.js');
const {
  MATCH_TYPE_OPTIONS,
  GAME_POINTS_LABELS,
  BEST_OF_LABELS,
  createForm,
  scheduledForm,
  resizeTeams,
  resizeScores,
  toScoreRows,
  winnerOf,
  formatTextOf,
  toSubmitParams,
  buildPickerRows,
  pickerEmptyText,
} = require('../../services/match-entry-view.js');
const { GAME_POINTS_OPTIONS, BEST_OF_OPTIONS } = require('../../utils/match-format.js');
const { hasReferee, canRecordScore } = require('../../services/match-record.js');
const { ROLE } = require('../../utils/constants.js');

/** 把 Date 变成 picker 要的 2026-05-01 */
function toDateText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把 Date 变成 picker 要的 18:30 */
function toTimeText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    /** 首屏加载中 */
    loading: true,
    /** 加载失败时的提示 */
    error: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 当前登录态 */
    auth: { loggedIn: false },
    isMock,

    /** 不能录入时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /**
     * 这一场的裁判情况。补录签表比赛时才有意义：
     *   hasReferee 有指定裁判就标出是谁；
     *   restricted 表示「本场已交给裁判，而你既不是裁判也不是管理员」，
     *   此时录分入口会被写入端拒下，页面上提前说清楚，别让人填完才被拒。
     */
    referee: { hasReferee: false, name: '', restricted: false },

    /**
     * 是否为「给签表里排定的比赛补录比分」。
     * 这种模式下对阵、赛制、时间、场地都来自那条记录，页面只收比分。
     */
    scheduled: false,

    /** 完整会员名单，供「找人面板」按名字搜索 */
    members: [],

    /** 赛季首日，用作日期选择器的下界 */
    seasonStart: '',

    /** 项目 / 分制 / 局制选项 */
    matchTypeOptions: MATCH_TYPE_OPTIONS,
    gamePointsLabels: GAME_POINTS_LABELS,
    bestOfLabels: BEST_OF_LABELS,

    /** 表单本体 */
    form: {},
    /** A / B 队的渲染行（含 picker 下标与锁定标记） */
    teamARows: [],
    teamBRows: [],
    /** 比分输入行 */
    scoreRows: [],
    /** 赛制文案与实时推出来的胜方 */
    formatText: '',
    winnerText: '',

    // ---------- 找人面板 ----------
    // 原生 picker 只吃一个静态数组，几十个名字里没法搜；换成这个自建面板，
    // 点格子打开，边打字边筛，再点一下选中。
    /** 面板是否打开 */
    pickerVisible: false,
    /** 正在给哪一队的哪一格选人 */
    pickerSide: '',
    pickerSlot: -1,
    /** 面板里的搜索词 */
    pickerKeyword: '',
    /** 面板里显示的名单（已筛选） */
    pickerRows: [],
    /** 面板里一个人都没搜到时给的解释 */
    pickerEmptyText: '',

    /** 逐字段的错误提示 */
    errors: {},
    /** 逐局比分的错误。数量与输入行对不上，单独放，别和字段错误挤在一起 */
    scoreErrors: [],
    /** 整体错误提示 */
    errorText: '',
  },

  /**
   * 返回 Promise 是有意为之：测试需要句柄等首屏加载完。
   * @returns {Promise<void>}
   */
  onLoad(query) {
    this.matchId = (query && query.matchId) || '';
    return this.init();
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /**
   * 回到本页时（例如从实时计分台返回）刷新签表补录的比分。
   * 计分台定稿会把比分写回原记录；不刷新，表单还停在计分前的空比分，
   * 再点提交就会把刚打完的实时结果覆盖掉。日常录入没有记录可刷，跳过。
   * @returns {Promise<void>|undefined}
   */
  onShow() {
    if (!this.matchId || !this._loaded) return undefined;
    return this.refreshScheduled();
  },

  async refreshScheduled() {
    try {
      const records = await getMatchRecords({ id: this.matchId });
      const record = records && records[0];
      if (!record) return;
      const user = this.currentUser();
      const referee = this.describeReferee(record, user);
      this.setData({
        referee,
        blockReason: this.describeBlock(this.data.auth) || this.describeRecordBlock(record, user),
      });
      this.applyForm(scheduledForm(record));
    } catch (err) {
      console.error('[match-entry] 刷新签表比赛失败', err);
    }
  },

  async init() {
    const user = this.currentUser();
    const auth = resolveAuthState(user);

    try {
      const [members, summary] = await Promise.all([getMembers(), getHomeSummary()]);
      // 赛季首日仅用于给日期选择器定下界；首场还没打时它是 null，
      // new Date(null) 会得到 1970，务必退回空串（空串即不设下界）。
      const seasonStart =
        summary.seasonRange && summary.seasonRange.from
          ? toDateText(new Date(summary.seasonRange.from))
          : '';
      // 记录原始会员档案（含学院），供补录时的录分权判定查学院
      this.rawMembers = members;

      // 编号 → 昵称的查表放在实例上，applyForm 每渲染一行都要用。
      // 不放 data 是因为它只参与计算，从不直接渲染。
      this.nameById = {};
      members.forEach((item) => {
        this.nameById[item._id] = item.nickName || item._id;
      });

      // 本赛季与每个人已交手的场次，选对手面板上那个数字取自它。
      // 放在这里取一次就够：整张单子期间它只用于展示，不参与任何判定
      // （真正拦人的是提交时服务端的闸门）。取不到也不影响录入。
      // 补录签表比赛时对阵已经排定、格子全是锁的（面板打不开），不必白跑一趟。
      this.pairInfo = user && !this.matchId ? await this.loadPairCounts(user._id) : null;

      // 带着 matchId 进来 = 给签表里排定的比赛补录比分。
      // 对阵与赛制取自那条记录，页面不给改（见 match-entry-view.scheduledForm）。
      let form;
      let referee = { hasReferee: false, name: '', restricted: false };
      let recordBlock = '';
      if (this.matchId) {
        const records = await getMatchRecords({ id: this.matchId });
        const record = records && records[0];
        if (!record) {
          this.setData({ loading: false, error: '这场比赛不存在，或已被删除' });
          return;
        }
        form = scheduledForm(record);
        referee = this.describeReferee(record, user);
        // 提前按写入端同一口径判一次录分权：非参赛者别填完整张单子才被拒
        recordBlock = this.describeRecordBlock(record, user);
      } else {
        // 默认填今天与此刻：绝大多数比赛是刚打完就来录的
        const now = new Date();
        form = createForm(user);
        form.date = toDateText(now) < seasonStart ? seasonStart : toDateText(now);
        form.time = toTimeText(now);
      }

      this.setData(
        {
          loading: false,
          error: '',
          auth,
          scheduled: Boolean(this.matchId),
          // realName 只用于面板搜索（昵称常只是真名的一部分，只按昵称搜，
          // 输入「赵」就找不到昵称叫「明宇」的人）；名字列显示的仍是昵称
          members: members.map((item) => ({
            id: item._id,
            name: item.nickName || item._id,
            realName: item.realName || '',
          })),
          seasonStart,
          referee,
          blockReason: this.describeBlock(auth) || recordBlock || this.refereeBlock(referee),
        },
        () => this.applyForm(form)
      );
      this._loaded = true;
    } catch (err) {
      console.error('[match-entry] 初始化失败', err);
      this.setData({ loading: false, error: '页面加载失败，请返回重试' });
    }
  },

  /**
   * 本赛季与每个人已交手的场次。
   * 失败就返回 null——徽标是提示，不该因为它读不到而让整页打不开。
   */
  async loadPairCounts(userId) {
    try {
      const result = await getSeasonPairCounts(userId);
      return { counts: (result && result.counts) || {}, limit: result && result.limit };
    } catch (err) {
      console.error('[match-entry] 交手场次读取失败', err);
      return null;
    }
  },

  /** 不能录入的原因。能录入时返回空串 */
  describeBlock(auth) {
    if (auth.canRecord) return '';
    if (auth.loggedIn) return auth.notice || '当前账号暂时不能录入比赛成绩';
    return '请先登录后再录入比赛成绩';
  },

  /**
   * 这一场的裁判情况。
   * 判定只看「有没有指定裁判」与「我是不是裁判 / 管理员」，与写入端同一口径
   * （见 match-record.canRecordScore 的裁判闸）：指定裁判后旁人一律录不了。
   */
  describeReferee(record, user) {
    if (!hasReferee(record)) return { hasReferee: false, name: '', restricted: false };

    const name = this.nameOf(record.referee) || String(record.referee);
    const isAdmin = Boolean(user && Number(user.role) >= ROLE.ADMIN);
    const isReferee = Boolean(user && user._id === record.referee);
    return { hasReferee: true, name, restricted: !isReferee && !isAdmin };
  },

  /** 被裁判接管时的拦截文案。没被挡下就返回空串 */
  refereeBlock(referee) {
    if (!referee || !referee.restricted) return '';
    return `本场由 ${referee.name} 裁判执法，仅裁判与管理员可录入比分`;
  },

  /**
   * 给签表里排定的比赛补录时，提前判一次「这场轮不轮得到你录」。
   * 判定与写入端一字不差（match-record.canRecordScore）：参赛者 / 指定裁判 /
   * 管理员 / 本院干事才放行。不判的话，非参赛者会被给到整张表单，填完比分
   * 才在服务端被拒——与「别让人填完才被拒」的设计相反。
   */
  describeRecordBlock(record, user) {
    if (!user) return '';
    const collegeByMember = new Map((this.rawMembers || []).map((item) => [item._id, item.college || '']));
    const allowed = canRecordScore(record, user._id, {
      role: Number(user.role) || 0,
      college: user.college || '',
      collegeOf: (id) => collegeByMember.get(id) || '',
    });
    if (allowed) return '';
    if (hasReferee(record)) {
      return `本场由 ${this.nameOf(record.referee) || record.referee} 裁判执法，仅裁判与管理员可录入比分`;
    }
    return '这场不是你参加的比赛，无权录入成绩';
  },

  /** 编号 → 昵称 */
  nameOf(userId) {
    if (!userId) return '';
    return (this.nameById && this.nameById[userId]) || '';
  },

  /**
   * 写入表单并重算所有派生字段。
   * 一律走这里，免得某个字段改了、展示却没跟着更新。
   */
  applyForm(form, extra = {}) {
    // 补录签表比赛时两队的对阵都已排定，一格都不给改；日常录入则只锁
    // A 队第一格（那是登录者自己）
    const scheduled = Boolean(this.matchId);
    const rowsOf = (team, lockedFirst) =>
      (Array.isArray(team) ? team : []).map((id, slot) => {
        const selfSlot = lockedFirst && slot === 0;
        return {
          slot,
          id,
          name: this.nameOf(id),
          locked: scheduled || selfSlot,
          // 只有「这一格是我自己」才标「我」；签表锁定的格子不分身份
          lockLabel: !scheduled && selfSlot ? '我' : '',
        };
      });

    const winner = winnerOf(form.scoreA, form.scoreB, form.gamePoints, form.bestOf);
    const winnerTeam = winner === 'A' ? form.teamA : form.teamB;
    const winnerNames = (Array.isArray(winnerTeam) ? winnerTeam : [])
      .filter(Boolean)
      .map((id) => this.nameOf(id))
      .join('、');

    this.setData({
      form,
      teamARows: rowsOf(form.teamA, true),
      teamBRows: rowsOf(form.teamB, false),
      scoreRows: toScoreRows(form.scoreA, form.scoreB),
      // picker 要的是下标，不是值
      gamePointsIndex: GAME_POINTS_OPTIONS.indexOf(form.gamePoints),
      bestOfIndex: BEST_OF_OPTIONS.indexOf(form.bestOf),
      formatText: formatTextOf(form.gamePoints, form.bestOf),
      winnerText: winner ? `${winnerNames || (winner === 'A' ? 'A 队' : 'B 队')} 胜` : '',
      ...extra,
    });
  },

  /* ---------- 表单交互 ---------- */

  /** 切换单打 / 双打。队伍格子与比分行都要跟着变，已填内容尽量保留 */
  onPickMatchType(event) {
    const matchType = Number(event.currentTarget.dataset.value);
    const form = this.data.form;
    if (!matchType || matchType === form.matchType) return;

    // 换项目不重置比分：三局两胜单打改双打，刚填的比分照样算数
    this.applyForm({ ...form, matchType, ...resizeTeams(form, matchType) });
  },

  /* ---------- 找人面板 ---------- */

  /** 读某一格当前选的人，用作面板里的打勾标记 */
  selectedIdOf(side, slot) {
    const team = side === 'A' ? this.data.form.teamA : this.data.form.teamB;
    return (Array.isArray(team) ? team[Number(slot)] : '') || '';
  },

  /** 按搜索词重算面板里的名单。纯本地计算，跟着每次输入即时调用 */
  applyPickerKeyword(keyword) {
    const rows = buildPickerRows(
      this.data.members,
      keyword,
      this.selectedIdOf(this.data.pickerSide, this.data.pickerSlot),
      // 只有对手那一侧带场次：名额只数跨队相对的人，同队的搭档之间不算一对
      this.data.pickerSide === 'B' ? this.pairInfo : null
    );
    this.setData({
      pickerKeyword: String(keyword == null ? '' : keyword).trim(),
      pickerRows: rows,
      pickerEmptyText: pickerEmptyText(keyword),
    });
  },

  /** 点某一格，打开找人面板。A 队第 0 格是锁的，点不到这里 */
  onOpenPicker(event) {
    const { side, slot } = event.currentTarget.dataset;
    const index = Number(slot);

    this.setData({ pickerVisible: true, pickerSide: side, pickerSlot: index });
    this.applyPickerKeyword('');
  },

  /** 面板里输入搜索词 */
  onInputPickerKeyword(event) {
    this.applyPickerKeyword(event.detail.value);
  },

  /** 清空面板里的搜索词 */
  onClearPickerKeyword() {
    this.applyPickerKeyword('');
  },

  /** 在面板里点中一个人，填进那一格并收起面板 */
  onPickMember(event) {
    const { side, slot, id } = event.currentTarget.dataset;
    if (!id) return;

    const form = this.data.form;
    const team = side === 'A' ? [...form.teamA] : [...form.teamB];
    team[Number(slot)] = id;

    this.setData({ pickerVisible: false, pickerKeyword: '', pickerRows: [], pickerEmptyText: '' });
    this.applyForm(side === 'A' ? { ...form, teamA: team } : { ...form, teamB: team });
  },

  /** 收起面板，不改动任何一格 */
  onClosePicker() {
    this.setData({ pickerVisible: false, pickerKeyword: '', pickerRows: [], pickerEmptyText: '' });
  },

  /** 面板内层吞掉冒泡，免得点列表时连带把面板关掉 */
  noop() {},

  /** 填比分 */
  onInputScore(event) {
    const { side, slot } = event.currentTarget.dataset;
    const key = side === 'A' ? 'scoreA' : 'scoreB';
    const scores = [...this.data.form[key]];
    scores[Number(slot)] = event.detail.value;

    this.applyForm({ ...this.data.form, [key]: scores });
  },

  onPickGamePoints(event) {
    const gamePoints = GAME_POINTS_OPTIONS[Number(event.detail.value)];
    if (!gamePoints) return;
    this.applyForm({ ...this.data.form, gamePoints });
  },

  /** 换局制要把比分输入行的数量对齐，否则三局两胜改五局三胜时会缺两行 */
  onPickBestOf(event) {
    const bestOf = BEST_OF_OPTIONS[Number(event.detail.value)];
    const form = this.data.form;
    if (!bestOf || bestOf === form.bestOf) return;

    this.applyForm({
      ...form,
      bestOf,
      scoreA: resizeScores(bestOf, form.scoreA),
      scoreB: resizeScores(bestOf, form.scoreB),
    });
  },

  onPickDate(event) {
    this.applyForm({ ...this.data.form, date: event.detail.value });
  },

  onPickTime(event) {
    this.applyForm({ ...this.data.form, time: event.detail.value });
  },

  onInputLocation(event) {
    this.applyForm({ ...this.data.form, location: event.detail.value });
  },

  /* ---------- 提交 ---------- */

  /**
   * 提交。校验不通过时逐字段标红并给一条总提示——只标红的话，
   * 用户可能滚不到出错的那一项。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (this.data.blockReason) return undefined;

    const user = this.currentUser();
    const params = toSubmitParams(this.data.form);

    this.setData({ submitting: true, errors: {}, scoreErrors: [], errorText: '' });
    try {
      // 两种录入都要带上登录者：云端按 OpenID 认身份，mock 靠 actor 走
      // 同一条「谁有资格录这一场」的判定（见 mock.submitMatch）。不带上，
      // 本地演示就落到「谁都能录」，与线上不是一回事。
      const actor = user ? user._id : undefined;
      // 补录签表比赛：带上编号把比分写回原记录，而不是另立一条新比赛。
      // 对阵、赛制、时间都取自原记录，所以这里只递比分与录入人。
      const result = this.matchId
        ? await submitMatch({ id: this.matchId, scoreA: params.scoreA, scoreB: params.scoreB, actor })
        : await submitMatch({ ...params, actor });
      if (!result.ok) {
        this.setData({
          submitting: false,
          errors: result.errors || {},
          scoreErrors: result.scoreErrors || [],
          // 逐局比分的错误不逐条挂在输入框上，用一条总提示兜底；
          // 否则用户可能只看到「校验失败」，却不知道是哪一局的问题
          errorText: result.firstError || (result.scoreErrors || [])[0] || '提交失败',
        });
        return undefined;
      }

      this.setData({ submitting: false });
      this.showToast('已提交，等待对手确认', 'success');
      // 退回比赛页，onShow 会刷新，刚提交的那场就在待确认里
      wx.navigateBack();
      return undefined;
    } catch (err) {
      console.error('[match-entry] 提交失败', err);
      this.setData({ submitting: false, errorText: '提交失败，请稍后重试' });
      return undefined;
    }
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  onCancel() {
    wx.navigateBack();
  },

  /**
   * 改用横屏计分台逐球计分。
   * 只有「给签表里排定的比赛补录」才有编号可带——日常约球还没生成比赛，
   * 没有实时台可开，所以入口在非 scheduled 时根本不出现。
   */
  onGoLiveScore() {
    if (!this.matchId) return;
    wx.navigateTo({ url: `/pages/live-score/live-score?matchId=${this.matchId}` });
  },
});
