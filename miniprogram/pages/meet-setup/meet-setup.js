/**
 * 发起运动会 / 继续配置项目（两段向导）
 * ============================================================
 * 两种进入方式：
 *   · 不带 meetId：新发起。第一步填基本信息并建草稿，第二步选项目。
 *   · 带 meetId：继续配置已有草稿，直接进第二步，并**回填已配置的项目**。
 *
 * 【勾选即保存】
 * 早先的写法是「先改一堆，最后点保存项目统一提交」。中途退出、切页面，或者
 * 某一项被服务端拒绝，用户看到的就是「我明明选了，草稿里却没有」。
 * 现在每次勾选/取消/改人数都立刻写库：勾上就 configureMeetEvent，取消就
 * removeMeetEvent。草稿状态永远等于屏幕上的状态，不需要用户记得点保存。
 *
 * 【为什么人数与限额可以是 0（不限）】
 * 入场式展示这类项目，各院上场人数与队数由学院自己定，系统只关心「有没有报」。
 * 0 在服务端表示「不限」，页面显示成「不限」而不是「0 人」。
 *
 * 【赛制与轮次用分段选择，不是一个按钮】
 * 原来单个 chip 显示「直接决赛」，点一下才知道是切换，也看不出还有别的选项。
 * 现在明确列出全部可选值：数值型「直接决赛 / 预赛+决赛」，胜负型
 * 「单败淘汰 / 循环赛 / 小组+淘汰」；选中项高亮，未选项一眼可见。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const session = require('../../services/school-session.js');
const { meetEventKey } = require('../../utils/meet-scope.js');

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
    savingKey: '',
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
      const [result, existing] = await Promise.all([
        meet.forScope({ schoolId: this.data.schoolId })
          .listSportsEventTemplates({ keyword: this.data.keyword, category: this.data.activeCategory }),
        // 继续配置必须回填：否则一进来「已选 0 项」，看起来像之前什么都没保存
        // 只在首次进入时回填：之后每次切分类都重新拉会覆盖本地刚改的设置
        this.data.meetId && !this.prefilled ? this.client().getSportsMeet({}) : Promise.resolve(null),
      ]);
      const byId = new Map(result.items.map((item) => [item.templateId, item]));
      const picked = existing ? this.pickedFromEvents(existing.events, byId) : this.data.picked;
      if (existing) this.prefilled = true;
      this.update({
        loading: false,
        categories: result.categories,
        templates: decorateTemplates(result.items, picked),
        picked,
        pickedCount: picked.length,
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '项目库加载失败' });
    }
  },

  /** 把服务端已配置的项目还原成编辑行（人数、限额、赛制、轮次一个不能丢） */
  pickedFromEvents(events, templateById) {
    return (events || []).map((ev) => {
      const template = templateById.get(ev.templateId) || {};
      return {
        key: `${ev.templateId}|${ev.group}`,
        eventKey: ev.eventKey,
        templateId: ev.templateId,
        name: ev.name,
        group: ev.group,
        groupLabel: GROUP_LABEL[ev.group],
        entryForm: ev.entryForm,
        scoreType: ev.scoreType,
        members: Number(ev.members) || 0,
        membersUnlimited: Number(ev.members) === 0,
        limit: Number(ev.perCollegeLimit) || 0,
        limitUnlimited: Number(ev.perCollegeLimit) === 0,
        limitUnit: unitOf(ev.entryForm),
        fixedMembers: template.fixedMembers || null,
        isVersus: ev.scoreType === 'versus',
        format: ev.format || 'single_elim',
        groupCount: (ev.groups && ev.groups.count) || 2,
        advancePerGroup: (ev.groups && ev.groups.advancePerGroup) || 2,
        rounds: ev.rounds || 'final',
        advanceCount: (ev.advance && ev.advance.count) || 3,
        saved: true,
      };
    });
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
        notice: '草稿已建立，选中的项目会立即保存',
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

  /** 勾选 = 立即写入草稿；取消 = 立即从草稿移除 */
  async onToggleGroup(event) {
    const { templateId, group } = event.currentTarget.dataset;
    const key = `${templateId}|${group}`;
    const picked = [...this.data.picked];
    const index = picked.findIndex((row) => row.key === key);

    if (index >= 0) {
      const row = picked[index];
      this.update({ savingKey: key, error: '' });
      try {
        await this.client().removeMeetEvent({ eventKey: row.eventKey });
      } catch (err) {
        this.update({ savingKey: '', error: (err && err.message) || '移除失败' });
        return;
      }
      picked.splice(index, 1);
      this.update({
        savingKey: '',
        picked,
        pickedCount: picked.length,
        templates: decorateTemplates(this.data.templates, picked),
      });
      return;
    }

    const template = this.data.templates.find((item) => item.templateId === templateId);
    if (!template) return;
    const row = {
      key,
      eventKey: meetEventKey(this.data.meetId, templateId, group),
      templateId,
      name: template.name,
      group,
      groupLabel: GROUP_LABEL[group],
      entryForm: template.entryForm,
      scoreType: template.scoreType,
      members: template.fixedMembers || template.defaultMembers || 1,
      membersUnlimited: false,
      limit: defaultLimit(template),
      limitUnlimited: false,
      limitUnit: unitOf(template.entryForm),
      fixedMembers: template.fixedMembers || null,
      isVersus: template.scoreType === 'versus',
      format: 'single_elim',
      groupCount: 2,
      advancePerGroup: 2,
      rounds: 'final',
      advanceCount: 3,
      saved: false,
    };
    picked.push(row);
    this.update({
      picked,
      pickedCount: picked.length,
      templates: decorateTemplates(this.data.templates, picked),
    });
    await this.persist(row);
  },

  /** 把一行的当前设置写进草稿；失败时明确报出来，不吞掉 */
  async persist(row) {
    const payload = {
      templateId: row.templateId,
      group: row.group,
      members: row.entryForm === 'single'
        ? 1
        : (row.membersUnlimited ? 0 : Number(row.members) || 0),
      perCollegeLimit: row.limitUnlimited ? 0 : Number(row.limit) || 0,
    };
    if (row.isVersus) {
      payload.format = row.format;
      if (row.format === 'group_knockout') {
        payload.groups = {
          count: Number(row.groupCount) || 2,
          advancePerGroup: Number(row.advancePerGroup) || 2,
        };
      }
    } else if (row.rounds === 'heat_final') {
      payload.rounds = 'heat_final';
      payload.advance = { mode: 'per_heat', count: Number(row.advanceCount) || 3 };
    }

    this.update({ savingKey: row.key, error: '' });
    try {
      await this.client().configureMeetEvent(payload);
      this.markSaved(row.key, true);
      this.update({ savingKey: '' });
      return true;
    } catch (err) {
      const message = (err && err.message) || '保存失败';
      this.markSaved(row.key, false, message);
      this.update({ savingKey: '', error: `${row.name}（${row.groupLabel}）：${message}` });
      return false;
    }
  },

  markSaved(key, saved, message = '') {
    const picked = this.data.picked.map((row) => (row.key === key
      ? { ...row, saved, saveError: message } : row));
    this.update({ picked });
  },

  /** 改了一行之后：先写库，再刷新界面 */
  async applyChange(index, patch) {
    const picked = [...this.data.picked];
    const row = { ...picked[index], ...patch };
    picked[index] = row;
    this.update({ picked });
    await this.persist(row);
    return row;
  },

  /** 人数与限额：允许直接输入，不再只能点加减 */
  onMembersInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value) || row.fixedMembers) return;
    const members = Math.max(0, Math.min(200, Math.trunc(value)));
    this.applyChange(index, { members, membersUnlimited: members === 0 });
  },

  onLimitInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value)) return;
    const limit = Math.max(0, Math.min(20, Math.trunc(value)));
    this.applyChange(index, { limit, limitUnlimited: limit === 0 });
  },

  onToggleMembersUnlimited(event) {
    const index = Number(event.currentTarget.dataset.index);
    const row = this.data.picked[index];
    if (!row || row.fixedMembers) return;
    // 取消「不限」时给一个合理默认值，避免人数停在 0 让报名端无从校验
    const next = row.membersUnlimited ? (row.entryForm === 'single' ? 1 : 10) : 0;
    this.applyChange(index, { membersUnlimited: !row.membersUnlimited, members: next });
  },

  onToggleLimitUnlimited(event) {
    const index = Number(event.currentTarget.dataset.index);
    const row = this.data.picked[index];
    if (!row) return;
    this.applyChange(index, {
      limitUnlimited: !row.limitUnlimited,
      limit: row.limitUnlimited ? 1 : 0,
    });
  },

  /** 轮次：直接决赛 / 预赛+决赛 */
  onPickRounds(event) {
    const index = Number(event.currentTarget.dataset.index);
    const rounds = String(event.currentTarget.dataset.rounds || 'final');
    const row = this.data.picked[index];
    if (!row || row.isVersus || row.rounds === rounds) return;
    this.applyChange(index, { rounds });
  },

  /** 赛制：单败 / 循环 / 小组+淘汰 */
  onPickFormat(event) {
    const index = Number(event.currentTarget.dataset.index);
    const format = String(event.currentTarget.dataset.format || 'single_elim');
    const row = this.data.picked[index];
    if (!row || !row.isVersus || row.format === format) return;
    this.applyChange(index, { format });
  },

  onAdvanceCountInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value)) return;
    this.applyChange(index, { advanceCount: Math.max(1, Math.min(50, Math.trunc(value))) });
  },

  onGroupCountInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value)) return;
    this.applyChange(index, { groupCount: Math.max(2, Math.min(8, Math.trunc(value))) });
  },

  onAdvancePerGroupInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value)) return;
    this.applyChange(index, { advancePerGroup: Math.max(1, Math.min(4, Math.trunc(value))) });
  },

  onStep(event) {
    const { index, field, delta } = event.currentTarget.dataset;
    const row = this.data.picked[Number(index)];
    if (!row) return;
    const next = Number(row[field]) + Number(delta);
    if (field === 'members') {
      if (row.fixedMembers || row.entryForm === 'single') return;
      if (next < 0 || next > 200) return;
    }
    if (field === 'limit' && (next < 0 || next > 20)) return;
    if (field === 'advanceCount' && (next < 1 || next > 50)) return;
    this.applyChange(Number(index), { [field]: next });
  },

  /** 收尾：项目在勾选时就已写库，这里只校验有没有保存失败的 */
  async onSubmit() {
    if (this.data.busy) return undefined;
    if (this.data.picked.length === 0) {
      this.update({ error: '请至少选择一个项目再继续' });
      return undefined;
    }
    const failed = this.data.picked.filter((row) => !row.saved);
    if (failed.length > 0) {
      // 逐项重试一次：多数是网络抖动，重试就能过
      for (const row of failed) await this.persist(row);
      const stillFailed = this.data.picked.filter((row) => !row.saved);
      if (stillFailed.length > 0) {
        this.update({ error: `还有 ${stillFailed.length} 项没有保存成功，请检查后重试` });
        return undefined;
      }
    }
    this.update({ busy: false });
    return wx.redirectTo({ url: `/pages/meet-detail/meet-detail?meetId=${this.data.meetId}` });
  },

  onBackToBasic() {
    if (this.data.isContinue) {
      return wx.navigateBack({ delta: 1 });
    }
    this.update({ step: 1, error: '', notice: '' });
    return undefined;
  },
});
