/**
 * 石榴籽杯（校级活动）
 * ============================================================
 * 学院赛整体迁入本栏目后的唯一入口。
 *
 * 【结构：项目就是杯赛】
 * 顶部项目来自协会注册表（匹克球 / 乒乓 / 羽球 / 网球 / 篮球 / 足球…），不是
 * 「一届杯赛的几个项目」——每个项目各自就是一个石榴籽杯。切换项目等于切换当前
 * 协会，下方列表就是该项目的学院赛。项目栏是等宽网格换行铺开，不做横向滚动：
 * 滚动会把后面的球类藏到屏幕外，连当前选中哪个都看不见。
 *
 * 【不设届次】
 * 同一项目一年可以发起多次，列表按**发起时间**归档；年份只作为筛选条件，
 * 不做「第几届」的建模。因此这里没有 cupId，也不新建集合。
 *
 * 【权限沿用学院赛口径】
 * 发起、审核、抽签、开赛、结束、置顶都看读端下发的 canManage：
 * 校级管理员与本项目协会负责人（可多人）为真，其他项目负责人天然不在
 * 当前协会范围内，读端不会给他这个能力。
 * ============================================================
 */

const { activeAssociations } = require('../../utils/associations.js');
const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

const PAGE_SIZE = 50;
/** 输入停顿多久才发请求：按住键盘连打时不至于每敲一个字都问一次服务端 */
const SEARCH_DEBOUNCE_MS = 300;

/** 状态筛选项。value 用空串表示不限，其余是 COLLEGE_EVENT_STATUS 的数字值 */
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 0, label: '报名中' },
  { value: 1, label: '待开赛' },
  { value: 2, label: '进行中' },
  { value: 3, label: '已结束' },
];

/** 分组顺序：进行中的排在前面，已结束沉底 */
const STATUS_ORDER = [
  { status: 0, label: '报名中' },
  { status: 1, label: '待开赛' },
  { status: 2, label: '进行中' },
  { status: 3, label: '已结束' },
];

/** 年份下拉：当年往前 6 年 + 全部年份 */
function buildYears(now = new Date()) {
  const current = now.getFullYear();
  const years = [{ value: '', label: '全部年份' }];
  for (let year = current; year > current - 6; year -= 1) {
    years.push({ value: String(year), label: `${year} 年` });
  }
  return years;
}

Page({
  data: {
    loading: true,
    error: '',
    busy: false,
    schoolId: '',
    themeClass: '',
    /** 各球类项目：{ id, sportName, glyph } */
    projects: [],
    projectId: '',
    projectName: '',
    /** 搜索关键词：按赛事名称 / 场地匹配，空串等于不筛 */
    keyword: '',
    rows: [],
    groups: [],
    total: 0,
    offset: 0,
    hasMore: false,
    canManage: false,
    years: buildYears(),
    yearIndex: 0,
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
  },

  onLoad(query = {}) {
    this.unloaded = false;
    this.loaded = false;
    this.rows = [];

    const projects = activeAssociations().map((assoc) => ({
      id: assoc.id,
      sportName: assoc.sportName,
      glyph: assoc.logoGlyph,
    }));
    const wanted = String(query.projectId || associationScope.getAssociation() || '');
    const current = projects.some((item) => item.id === wanted)
      ? wanted
      : (projects[0] ? projects[0].id : '');

    // 进入即把当前项目写成全局当前协会：发布页、详情页、名单页都按它取数，
    // 不必给七页各加一套「杯赛参数」。
    if (current) this.applyProject(current);

    this.update({
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      projects,
      projectId: current,
      projectName: this.sportNameOf(current, projects),
      themeClass: currentThemeClass(),
    });
    return this.reload();
  },

  onShow() {
    if (!this.loaded) return undefined;
    return this.reload();
  },

  onUnload() {
    this.unloaded = true;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },

  onPullDownRefresh() {
    const done = () => (typeof wx !== 'undefined' && wx.stopPullDownRefresh ? wx.stopPullDownRefresh() : null);
    return this.reload().then(done, done);
  },

  update(values) {
    this.setData(values);
  },

  sportNameOf(id, projects) {
    const found = (projects || []).find((item) => item.id === id);
    return found ? found.sportName : '';
  },

  /**
   * 切换全局当前协会。
   * 优先走 app（它把结果同步进 globalData），测试环境回落到门面。
   */
  applyProject(id) {
    try {
      const app = getApp();
      if (app && typeof app.setAssociation === 'function') {
        app.setAssociation(id);
        return;
      }
    } catch (err) {
      // getApp 在 Node 测试里可能不存在，落到门面即可
    }
    associationScope.setAssociation(id);
  },

  client() {
    return space.forScope({
      schoolId: this.data.schoolId,
      association: this.data.projectId,
    });
  },

  /** 当前筛选条件 */
  query(extra = {}) {
    const status = this.data.statusOptions[this.data.statusIndex] || { value: '' };
    const year = this.data.years[this.data.yearIndex] || { value: '' };
    const keyword = String(this.data.keyword || '').trim();
    const payload = { limit: PAGE_SIZE, ...extra };
    if (status.value !== '') payload.status = Number(status.value);
    if (year.value) payload.year = year.value;
    if (keyword) payload.keyword = keyword;
    return payload;
  },

  /**
   * 按状态分组；空组不渲染，避免页面上出现一串空标题。
   *
   * 【搜索时为什么不再分组】
   * 「报名中 / 进行中 / 已结束」是浏览时的组织方式。带着关键词来时，人关心的是
   * 「这几个名字里哪个是我要找的」，再按状态切三段只会把命中结果拆散。搜索时
   * 聚成一组，把状态留在每行标签上。
   */
  groupOf(rows) {
    if (String(this.data.keyword || '').trim()) {
      return rows.length > 0 ? [{ status: 'search', label: '搜索结果', rows }] : [];
    }
    return STATUS_ORDER
      .map((item) => ({ ...item, rows: rows.filter((row) => row.status === item.status) }))
      .filter((item) => item.rows.length > 0);
  },

  /**
   * 重取第一页。
   *
   * 【silent 与请求令牌】
   * 边打字边搜时不能让整页回到「正在加载…」——那会把输入框一起换掉，键盘跟着收，
   * 一个字都打不完整。所以搜索走 silent：保留旧列表，直到新结果回来再换。
   * 令牌用来丢弃过期响应：连打三个字会发三次请求，先回的不一定是最后那个。
   */
  async reload(options = {}) {
    const silent = options && options.silent === true;
    const token = (this.requestToken || 0) + 1;
    this.requestToken = token;
    if (!this.data.projectId) {
      this.update({ loading: false, error: '这所学校还没有启用任何协会' });
      return undefined;
    }
    if (!silent) this.update({ loading: true, error: '' });
    this.rows = [];
    try {
      const result = await this.client().listCollegeEvents(this.query({ offset: 0 }));
      if (this.unloaded || token !== this.requestToken) return undefined;
      if (result && result.ok === false) throw new Error(result.message || '没有读取石榴籽杯的权限');
      const rows = result.events || [];
      this.rows = rows;
      this.loaded = true;
      this.update({
        loading: false,
        error: '',
        rows,
        groups: this.groupOf(rows),
        total: Number(result.total) || rows.length,
        offset: rows.length,
        hasMore: Boolean(result.hasMore),
        canManage: Boolean(result.canManage),
        themeClass: currentThemeClass(),
      });
    } catch (err) {
      if (this.unloaded || token !== this.requestToken) return undefined;
      this.loaded = true;
      this.update({ loading: false, error: (err && err.message) || '加载失败' });
    }
    return undefined;
  },

  async loadMore() {
    if (this.data.busy || !this.data.hasMore) return undefined;
    this.update({ busy: true });
    try {
      const result = await this.client().listCollegeEvents(this.query({ offset: this.data.offset }));
      const rows = this.rows.concat(result.events || []);
      this.rows = rows;
      this.update({
        busy: false,
        rows,
        groups: this.groupOf(rows),
        offset: rows.length,
        hasMore: Boolean(result.hasMore),
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '加载失败' });
    }
    return undefined;
  },

  onPickYear(event) {
    this.update({ yearIndex: Number(event.detail.value) });
    return this.reload();
  },

  onPickStatus(event) {
    this.update({ statusIndex: Number(event.detail.value) });
    return this.reload();
  },

  /** 输入即筛：停顿 SEARCH_DEBOUNCE_MS 后再发请求，连打不逐个字都问服务端 */
  onKeywordInput(event) {
    const keyword = String((event.detail && event.detail.value) || '');
    this.update({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      if (this.unloaded) return;
      this.reload({ silent: true });
    }, SEARCH_DEBOUNCE_MS);
  },

  /** 键盘「搜索」键：不等防抖，立刻按当前输入筛一次 */
  onKeywordConfirm() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    return this.reload({ silent: true });
  },

  onClearKeyword() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.update({ keyword: '' });
    return this.reload({ silent: true });
  },

  onPickProject(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || id === this.data.projectId) return undefined;
    this.applyProject(id);
    this.update({
      projectId: id,
      projectName: this.sportNameOf(id, this.data.projects),
      themeClass: currentThemeClass(),
      rows: [],
      groups: [],
      total: 0,
      offset: 0,
      hasMore: false,
    });
    return this.reload();
  },

  /** 发起学院赛：属于当前项目，发布页不再选项目（避免一次发起落到两个项目） */
  onCreate() {
    if (!this.data.projectId) return undefined;
    return wx.navigateTo({
      url: `/pages/college-event-edit/college-event-edit?projectId=${this.data.projectId}`,
    });
  },

  /**
   * 点一场学院赛。
   * 与旧入口一致：学院负责人在报名中直接进本学院名单页，其余进详情。
   */
  onOpenEvent(event) {
    const { eventId, canSubmit } = event.currentTarget.dataset;
    if (!eventId) return undefined;
    if (canSubmit) {
      return wx.navigateTo({ url: `/pages/college-entry/college-entry?eventId=${encodeURIComponent(eventId)}` });
    }
    return wx.navigateTo({ url: `/pages/college-event-detail/college-event-detail?eventId=${encodeURIComponent(eventId)}` });
  },
});
