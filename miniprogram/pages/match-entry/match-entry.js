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

  async init() {
    const user = this.currentUser();
    const auth = resolveAuthState(user);

    try {
      const [members, summary] = await Promise.all([getMembers(), getHomeSummary()]);
      const seasonStart = toDateText(new Date(summary.seasonRange.from));

      // 编号 → 昵称的查表放在实例上，applyForm 每渲染一行都要用。
      // 不放 data 是因为它只参与计算，从不直接渲染。
      this.nameById = {};
      members.forEach((item) => {
        this.nameById[item._id] = item.nickName || item._id;
      });

      // 带着 matchId 进来 = 给签表里排定的比赛补录比分。
      // 对阵与赛制取自那条记录，页面不给改（见 match-entry-view.scheduledForm）。
      let form;
      if (this.matchId) {
        const records = await getMatchRecords({ id: this.matchId });
        const record = records && records[0];
        if (!record) {
          this.setData({ loading: false, error: '这场比赛不存在，或已被删除' });
          return;
        }
        form = scheduledForm(record);
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
          members: members.map((item) => ({ id: item._id, name: item.nickName || item._id })),
          seasonStart,
          blockReason: this.describeBlock(auth),
        },
        () => this.applyForm(form)
      );
    } catch (err) {
      console.error('[match-entry] 初始化失败', err);
      this.setData({ loading: false, error: '页面加载失败，请返回重试' });
    }
  },

  /** 不能录入的原因。能录入时返回空串 */
  describeBlock(auth) {
    if (auth.canRecord) return '';
    if (auth.loggedIn) return auth.notice || '当前账号暂时不能录入比赛成绩';
    return '请先登录后再录入比赛成绩';
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
      this.selectedIdOf(this.data.pickerSide, this.data.pickerSlot)
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
      // 补录签表比赛：带上编号把比分写回原记录，而不是另立一条新比赛。
      // 对阵、赛制、时间都取自原记录，所以这里只递比分与录入人。
      const result = this.matchId
        ? await submitMatch({
            id: this.matchId,
            scoreA: params.scoreA,
            scoreB: params.scoreB,
            actor: user ? user._id : undefined,
          })
        : await submitMatch(params);
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
});
