/**
 * 发起运动会 / 继续配置项目（两段向导）
 * ============================================================
 * 两种进入方式：
 *   · 不带 meetId：新发起。第一步填基本信息并建草稿，第二步选项目。
 *   · 带 meetId：继续配置已有草稿，直接进第二步（详情页的「继续配置项目」走这条）。
 *
 * 【为什么组别是逐项勾选，不是自动生成】
 * N12 的裁决是「每届管理员逐项目勾选组别」。自动按男/女生成会把 110 米栏
 * 也生成女子组，把入场式生成男女组——这些在规则上都站不住。默认只勾模板
 * 推荐的组别，管理员可以再改。
 *
 * 【配置是一次一项提交的】
 * 服务端按「项目 + 组别」落库，每项一次 configureMeetEvent。整批提交时若某一项
 * 被拒（比如三人板鞋人数不是 3），会明确报出是哪一项，而不是整批静默失败。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const session = require('../../services/school-session.js');

const GROUP_LABEL = { male: '男子', female: '女子', mixed: '混合' };
const GROUP_ORDER = ['male', 'female', 'mixed'];

/** 限额单位：单人按人、团体按队、多人协作按组（4.2） */
function unitOf(entryForm) {
  if (entryForm === 'single') return '人';
  if (entryForm === 'team') return '队';
  return '组';
}

/** 给每个模板算出可勾选组别，并标出当前是否已选（WXML 只能读数据，不能调方法） */
function decorateTemplates(templates, picked) {
  const chosen = new Set(picked.map((row) => row.key));
  return templates.map((item) => ({
    ...item,
    groupOptions: GROUP_ORDER
      .filter((group) => item.recommendedGroups.includes(group))
      .map((group) => ({
        group,
        label: GROUP_LABEL[group],
        picked: chosen.has(`${item.templateId}|${group}`),
      })),
  }));
}

/** 按模板与参赛形态给出默认限额（与 meet-service 的默认值同源） */
function defaultLimit(template) {
  return template.entryForm === 'single' || template.entryForm === 'group' ? 3 : 1;
}

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    isContinue: false,
    step: 1,

    // 基本信息
    name: '',
    year: '',
    startDate: '',
    endDate: '',
    location: '',

    // 项目选择
    keyword: '',
    categories: [],
    activeCategory: '',
    templates: [],
    picked: [],
    pickedCount: 0,
  },

  onLoad(options = {}) {
    this.unloaded = false;
    const meetId = String(options.meetId || '');
    const now = new Date();
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId,
      isContinue: Boolean(meetId),
      step: meetId ? 2 : 1,
      year: String(now.getFullYear()),
      startDate: this.dateAfter(30),
      endDate: this.dateAfter(31),
    });
    return this.loadTemplates();
  },

  onUnload() {
    this.unloaded = true;
  },

  update(values) {
    if (!this.unloaded) this.setData(values);
  },

  dateAfter(days) {
    const date = new Date(Date.now() + days * 86400000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  async loadTemplates() {
    this.update({ loading: true, error: '' });
    try {
      const result = await meet.forScope({ schoolId: this.data.schoolId })
        .listSportsEventTemplates({ keyword: this.data.keyword, category: this.data.activeCategory });
      this.update({
        loading: false,
        categories: result.categories,
        templates: decorateTemplates(result.items, this.data.picked),
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '项目库加载失败' });
    }
  },

  // ---------- 第一步：基本信息 ----------

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.update({ [field]: event.detail.value });
  },

  onDateChange(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.update({ [field]: event.detail.value });
  },

  async onNext() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '' });
    try {
      const created = await meet.forScope({ schoolId: this.data.schoolId }).createSportsMeet({
        name: this.data.name,
        year: Number(this.data.year),
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        location: this.data.location,
      });
      this.update({
        busy: false,
        step: 2,
        meetId: created.meet.meetId,
        notice: '草稿已建立，请选择项目',
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '创建失败' });
    }
  },

  // ---------- 第二步：选项目 ----------

  onKeywordInput(event) {
    this.update({ keyword: event.detail.value });
  },

  onSearch() {
    return this.loadTemplates();
  },

  onCategoryTap(event) {
    const category = String(event.currentTarget.dataset.category || '');
    this.update({ activeCategory: category });
    return this.loadTemplates();
  },

  /** 勾选/取消「项目 + 组别」。默认人数与限额取模板建议值，可再调。 */
  onToggleGroup(event) {
    const { templateId, group } = event.currentTarget.dataset;
    const key = `${templateId}|${group}`;
    const picked = [...this.data.picked];
    const index = picked.findIndex((row) => row.key === key);
    if (index >= 0) {
      picked.splice(index, 1);
      this.update({
        picked,
        pickedCount: picked.length,
        templates: decorateTemplates(this.data.templates, picked),
      });
      return;
    }
    const template = this.data.templates.find((item) => item.templateId === templateId);
    if (!template) return;
    picked.push({
      key,
      templateId,
      name: template.name,
      group,
      groupLabel: GROUP_LABEL[group],
      entryForm: template.entryForm,
      members: template.fixedMembers || template.defaultMembers || 1,
      limit: defaultLimit(template),
      limitUnit: unitOf(template.entryForm),
      fixedMembers: template.fixedMembers || null,
    });
    this.update({
      picked,
      pickedCount: picked.length,
      templates: decorateTemplates(this.data.templates, picked),
    });
  },

  onStep(event) {
    const { index, field, delta } = event.currentTarget.dataset;
    const picked = [...this.data.picked];
    const row = picked[Number(index)];
    if (!row) return;
    const next = Number(row[field]) + Number(delta);
    if (field === 'members') {
      if (row.fixedMembers || row.entryForm === 'single') return;
      if (next < 2 || next > 30) return;
    }
    if (field === 'limit' && (next < 1 || next > 20)) return;
    row[field] = next;
    this.update({ picked });
  },

  /** 批量写入：逐项配置，失败时明确指出是哪一项 */
  async onSubmit() {
    if (this.data.busy) return undefined;
    if (this.data.picked.length === 0) {
      this.update({ error: '请至少选择一个项目再继续' });
      return undefined;
    }
    this.update({ busy: true, error: '', notice: '' });

    const scoped = this.client();
    try {
      for (const row of this.data.picked) {
        try {
          await scoped.configureMeetEvent({
            templateId: row.templateId,
            group: row.group,
            members: row.members,
            perCollegeLimit: row.limit,
          });
        } catch (err) {
          throw new Error(`${row.name}（${row.groupLabel}）：${(err && err.message) || '配置失败'}`);
        }
      }
      this.update({ busy: false });
      return wx.redirectTo({ url: `/pages/meet-detail/meet-detail?meetId=${this.data.meetId}` });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '配置失败' });
      return undefined;
    }
  },

  onBackToBasic() {
    if (this.data.isContinue) {
      return wx.navigateBack({ delta: 1 });
    }
    this.update({ step: 1, error: '', notice: '' });
    return undefined;
  },
});
