/**
 * 发布赛事
 * ============================================================
 * 只做一件事：把一张填好的单子变成一场「报名中」的赛事。
 * 校验与组装在 services/event.js（纯函数），这里负责交互与 setData。
 *
 * 【为什么独立成页而不是详情页里的一个弹层】
 * 名称、等级、三四名赛方式、时间、场地、名额、说明七项，说明还要一大块
 * 输入区，弹层里挤不下；带参数的独立页也更好扩展。
 *
 * 【等级与三四名赛方式为什么默认不选】
 * 决策 13 / 8：两者都直接决定积分怎么算，留空取默认等于悄悄改分。
 * 数据层对历史赛事会按三级 / 并列兜底（见 event.js），但新建时必须由
 * 管理员亲手选定，所以这里初值就是「未选择」，不靠默认值蒙混过去。
 *
 * 【没有发布权为什么不让进】
 * 用户可能绕过赛事页直接从小程序码进来。填完再被拒，比一开始就说清楚
 * 糟得多，所以进来先判一道，不给表单。
 * ============================================================
 */

const {
  MATCH_TYPE,
  EVENT_LEVEL_LABEL,
  EVENT_BRONZE_MODE,
  EVENT_BRONZE_MODE_LABEL,
  EVENT_FORMAT,
  EVENT_FORMAT_LABEL,
  DEFAULT_EVENT_FORMAT,
  GROUP_CONFIG,
  DEFAULT_GROUP_COUNT,
  DEFAULT_ADVANCE_PER_GROUP,
  EVENT_PLACEMENT_MODE,
  DEFAULT_PLACEMENT_MODE,
  SEED_MODE,
  SEED_MODE_LABEL,
  SEED_COUNTS,
  DEFAULT_SEED_COUNT,
} = require('../../utils/constants.js');
const {
  TITLE_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  canManageEvent,
} = require('../../services/event.js');
const { publishEvent, isMock } = require('../../services/index.js');

/** 赛事等级下拉的取值与文案。顺序固定为 一级 → 二级 → 三级 */
const LEVELS = [1, 2, 3];
const LEVEL_LABELS = LEVELS.map((level) => EVENT_LEVEL_LABEL[level]);

/** 三四名赛方式下拉的取值与文案 */
const BRONZE_MODES = [EVENT_BRONZE_MODE.TIED, EVENT_BRONZE_MODE.PLAYOFF];
const BRONZE_LABELS = BRONZE_MODES.map((mode) => EVENT_BRONZE_MODE_LABEL[mode]);

/** 项目下拉。默认单打——双打赛事不计积分，别让人一进来就踩坑 */
const MATCH_TYPES = [MATCH_TYPE.SINGLES, MATCH_TYPE.DOUBLES];
const MATCH_TYPE_LABELS = ['单打', '双打'];

/**
 * 赛制下拉。仅单打赛事显示（决策 5：新赛制只做单打）。
 * 双败淘汰与复合赛制属第二批，这里先只列第一批的三种。
 */
const FORMATS = [EVENT_FORMAT.SINGLE_ELIM, EVENT_FORMAT.ROUND_ROBIN, EVENT_FORMAT.GROUP_KNOCKOUT];
const FORMAT_LABELS = FORMATS.map((format) => EVENT_FORMAT_LABEL[format]);

/** 小组数下拉（仅小组赛显示）。取值固定为 GROUP_CONFIG 允许的档位 */
const GROUP_COUNT_OPTIONS = GROUP_CONFIG.COUNT_OPTIONS;
const GROUP_COUNT_LABELS = GROUP_COUNT_OPTIONS.map((count) => `${count} 组`);
const DEFAULT_GROUP_COUNT_INDEX = GROUP_COUNT_OPTIONS.indexOf(DEFAULT_GROUP_COUNT);

/** 每组出线人数下拉（仅小组赛显示） */
const ADVANCE_OPTIONS = GROUP_CONFIG.ADVANCE_OPTIONS;
const ADVANCE_LABELS = ADVANCE_OPTIONS.map((count) => `每组出线 ${count} 人`);
const DEFAULT_ADVANCE_INDEX = ADVANCE_OPTIONS.indexOf(DEFAULT_ADVANCE_PER_GROUP);

/** 种子来源下拉。仅单打赛事显示（决策 1） */
const SEED_MODES = [SEED_MODE.MANUAL, SEED_MODE.ELO, SEED_MODE.POINTS];
const SEED_MODE_LABELS = SEED_MODES.map((mode) => SEED_MODE_LABEL[mode]);

/** 种子数量下拉。只认 2 / 4 / 8（决策 3），默认 8 */
const SEED_COUNT_OPTIONS = SEED_COUNTS;
const SEED_COUNT_LABELS = SEED_COUNTS.map((count) => `${count} 位`);
const DEFAULT_SEED_COUNT_INDEX = SEED_COUNTS.indexOf(DEFAULT_SEED_COUNT);

/** 日期选择器的下界：今天。赛事不该往过去发 */
function todayText(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

Page({
  data: {
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock,

    /** 没有发布权时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /** 各下拉的数据源与当前下标 */
    matchTypes: MATCH_TYPE_LABELS,
    matchTypeIndex: 0,
    formats: FORMAT_LABELS,
    formatIndex: FORMATS.indexOf(DEFAULT_EVENT_FORMAT),
    groupCounts: GROUP_COUNT_LABELS,
    // 小组参数预填默认值；只有选中「小组赛」时才显示，也允许不选
    groupCountIndex: DEFAULT_GROUP_COUNT_INDEX,
    advanceOptions: ADVANCE_LABELS,
    advanceIndex: DEFAULT_ADVANCE_INDEX,
    levels: LEVEL_LABELS,
    levelIndex: 0,
    bronzeModes: BRONZE_LABELS,
    bronzeIndex: 0,
    seedModes: SEED_MODE_LABELS,
    seedModeIndex: 0,
    seedCounts: SEED_COUNT_LABELS,
    // 数量按决策 3 预填 8，来源仍需管理员显式选定
    seedCountIndex: DEFAULT_SEED_COUNT_INDEX,

    /** 日期选择器的下界 */
    today: todayText(),

    /** 输入长度上限，交给 maxlength 属性 */
    titleMax: TITLE_MAX,
    descriptionMax: DESCRIPTION_MAX,
    locationMax: LOCATION_MAX,

    /** 表单本体。level / bronzeMode 初值为空，必须由管理员选定 */
    form: {
      title: '',
      description: '',
      matchType: MATCH_TYPES[0],
      // 赛制预填单败淘汰：不选就是旧行为，老流程无感
      format: DEFAULT_EVENT_FORMAT,
      groupCount: DEFAULT_GROUP_COUNT,
      advancePerGroup: DEFAULT_ADVANCE_PER_GROUP,
      placementMode: DEFAULT_PLACEMENT_MODE,
      level: null,
      bronzeMode: '',
      // 种子来源留空必须显式选；数量预填默认值（决策 2 / 3）
      seedMode: '',
      seedCount: DEFAULT_SEED_COUNT,
      location: '',
      date: '',
      time: '',
      quota: '',
    },
    /** 逐字段的错误提示 */
    errors: {},
    /** 整体错误提示 */
    errorText: '',
  },

  onLoad() {
    const user = this.currentUser();
    const allowed = canManageEvent(user, { isMock });
    this.setData({ blockReason: this.describeBlock(allowed, user) });
  },

  /** 不能发布的原因。能发布时返回空串 */
  describeBlock(allowed, user) {
    if (allowed) return '';
    return user ? '当前账号没有发布赛事的权限，请联系管理员' : '请先登录后再发布赛事';
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

  /* ---------- 表单交互 ---------- */

  /**
   * 写入一个字段，并清掉它的旧错误。
   * 一律走这里，免得某个字段改了、错误提示却没跟着消失。
   */
  setField(key, value) {
    this.setData({
      form: { ...this.data.form, [key]: value },
      errors: { ...this.data.errors, [key]: '' },
      errorText: '',
    });
  },

  onInputTitle(event) {
    this.setField('title', event.detail.value);
  },

  onInputDescription(event) {
    this.setField('description', event.detail.value);
  },

  onInputLocation(event) {
    this.setField('location', event.detail.value);
  },

  onInputQuota(event) {
    this.setField('quota', event.detail.value);
  },

  onPickMatchType(event) {
    const index = Number(event.detail.value);
    const type = MATCH_TYPES[index];
    if (type === undefined) return;
    this.setData({ matchTypeIndex: index });
    this.setField('matchType', type);
    // 新赛制只做单打（决策 5）：切到双打就把赛制收回单败淘汰，
    // 免得带着分组赛制提交、抽签时却被「双打不支持抽签」挡下
    if (type === MATCH_TYPE.DOUBLES && this.data.form.format !== DEFAULT_EVENT_FORMAT) {
      this.setData({ formatIndex: FORMATS.indexOf(DEFAULT_EVENT_FORMAT) });
      this.setField('format', DEFAULT_EVENT_FORMAT);
    }
  },

  onPickFormat(event) {
    const index = Number(event.detail.value);
    const format = FORMATS[index];
    if (format === undefined) return;
    this.setData({ formatIndex: index });
    this.setField('format', format);
  },

  onPickGroupCount(event) {
    const index = Number(event.detail.value);
    const count = GROUP_COUNT_OPTIONS[index];
    if (count === undefined) return;
    this.setData({ groupCountIndex: index });
    this.setField('groupCount', count);
  },

  onPickAdvance(event) {
    const index = Number(event.detail.value);
    const count = ADVANCE_OPTIONS[index];
    if (count === undefined) return;
    this.setData({ advanceIndex: index });
    this.setField('advancePerGroup', count);
  },

  /** 倒三角排位开关：勾上则八强负者加赛分出 5–8 名 */
  onToggleTop8(event) {
    this.setField(
      'placementMode',
      event.detail.value ? EVENT_PLACEMENT_MODE.TOP8 : EVENT_PLACEMENT_MODE.NONE
    );
  },

  onPickLevel(event) {
    const index = Number(event.detail.value);
    const level = LEVELS[index];
    if (level === undefined) return;
    this.setData({ levelIndex: index });
    this.setField('level', level);
  },

  onPickBronzeMode(event) {
    const index = Number(event.detail.value);
    const mode = BRONZE_MODES[index];
    if (mode === undefined) return;
    this.setData({ bronzeIndex: index });
    this.setField('bronzeMode', mode);
  },

  onPickSeedMode(event) {
    const index = Number(event.detail.value);
    const mode = SEED_MODES[index];
    if (mode === undefined) return;
    this.setData({ seedModeIndex: index });
    this.setField('seedMode', mode);
  },

  onPickSeedCount(event) {
    const index = Number(event.detail.value);
    const count = SEED_COUNT_OPTIONS[index];
    if (count === undefined) return;
    this.setData({ seedCountIndex: index });
    this.setField('seedCount', count);
  },

  onPickDate(event) {
    this.setField('date', event.detail.value);
  },

  onPickTime(event) {
    this.setField('time', event.detail.value);
  },

  /* ---------- 提交 ---------- */

  /** 把日期与时间两栏拼成 ISO 字符串，缺一不可 */
  buildStartTime() {
    const { date, time } = this.data.form;
    if (!date || !time) return '';
    return `${date}T${time}:00`;
  },

  /**
   * 提交。校验不通过时逐字段标红并给一条总提示——只标红的话，
   * 用户可能滚不到出错的那一项。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (this.data.blockReason) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再发布赛事');
      return undefined;
    }

    const form = { ...this.data.form, startTime: this.buildStartTime() };

    this.setData({ submitting: true, errors: {}, errorText: '' });
    const result = await publishEvent(form, user._id);

    if (!result.ok) {
      this.setData({
        submitting: false,
        errors: result.errors || {},
        errorText: result.firstError || '发布失败',
      });
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已发布', 'success');
    // 退回赛事页，onShow 会刷新，刚发的这场就在列表里
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
});
