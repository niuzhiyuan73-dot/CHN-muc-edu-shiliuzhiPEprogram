/** 足球独立建赛组件。由父页面处理 submit/cancel 事件和网络请求。
 * 团队赛事列表仅在足球范围挂载本组件。
 */
const {
  createFootballEventForm, setFootballEventField, applyFootballPreset,
  validateFootballEventForm, footballEventFormView,
} = require('../../utils/football-event-form.js');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    submitting: { type: Boolean, value: false },
    serverError: { type: String, value: '' },
  },
  data: {
    ready: false, fields: [], presetOptions: [], presetIndex: 0, presetLabel: '',
    customized: false, summary: '', summaryLines: [], error: '', preview: false,
    previewName: '', previewFormat: '', pending: false,
  },
  observers: {
    submitting(value) { if (!value) this.releaseSubmission(); },
    serverError(value) { if (value) this.releaseSubmission(); },
  },
  lifetimes: {
    attached() {
      this.disposed = false;
      this.form = createFootballEventForm();
      this.formRevision = 0;
      this.showErrors = false;
      this.refreshForm();
    },
    detached() { this.disposed = true; },
  },
  methods: {
    releaseSubmission() {
      this.awaitingSubmission = false;
      this.setData({ pending: false });
    },
    isBusy() { return this.properties.submitting || this.awaitingSubmission; },
    refreshForm() {
      const view = footballEventFormView(this.form, this.showErrors);
      this.setData({ ...view, summaryLines: view.summary ? view.summary.split(' · ') : [], ready: true });
    },
    changeField(field, value) {
      if (this.isBusy() || this.data.preview || !this.form) return;
      const next = setFootballEventField(this.form, field, value);
      if (!next) return;
      this.form = next;
      this.formRevision += 1;
      this.requestId = null;
      this.refreshForm();
    },
    onInput(event) { this.changeField(event.currentTarget.dataset.field, event.detail.value); },
    onSwitch(event) { this.changeField(event.currentTarget.dataset.field, event.detail.value); },
    onSelect(event) {
      const key = event.currentTarget.dataset.field;
      const field = this.data.fields.find(item => item.key === key);
      const choice = field && field.options && field.options[Number(event.detail.value)];
      if (choice) this.changeField(key, choice.value);
    },
    onQuotaMode(event) {
      if (this.isBusy() || this.data.preview) return;
      const key = event.currentTarget.dataset.field;
      if (!['substitutionLimit', 'substitutionOpportunities'].includes(key)) return;
      const mode = Number(event.detail.value);
      if (mode !== 0 && mode !== 1) return;
      const current = this.form[key];
      if (mode === 1) {
        if (current !== 'all_named' && current !== 'unlimited') {
          this.numericQuotas = { ...(this.numericQuotas || {}), [key]: current };
        }
        this.changeField(key, key === 'substitutionLimit' ? 'all_named' : 'unlimited');
      } else if (current === 'all_named' || current === 'unlimited') {
        this.changeField(key, (this.numericQuotas || {})[key] || (key === 'substitutionLimit' ? '5' : '3'));
      }
    },
    onPreset(event) {
      if (this.isBusy() || this.data.preview) return;
      const option = this.data.presetOptions[Number(event.detail.value)];
      if (!option) return;
      const revision = this.formRevision;
      const result = applyFootballPreset(this.form, option.value);
      const accept = confirmed => {
        if (this.disposed || revision !== this.formRevision || this.isBusy() || this.data.preview) return;
        const changed = confirmed ? applyFootballPreset(this.form, option.value, true) : result;
        if (!changed.ok) return;
        this.form = changed.form;
        this.formRevision += 1;
        this.requestId = null;
        this.numericQuotas = {};
        this.refreshForm();
      };
      if (result.needsConfirmation) {
        if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return;
        wx.showModal({
          title: '切换规则预设',
          content: '将覆盖已修改的比赛规则，赛事名称和赛制会保留。',
          confirmText: '切换',
          success: response => { if (response.confirm) accept(true); },
        });
      } else if (result.ok) accept(false);
    },
    onPreview() {
      if (this.isBusy() || !this.form) return;
      this.showErrors = true;
      this.refreshForm();
      const result = validateFootballEventForm(this.form);
      if (!result.ok) return;
      this.setData({ preview: true, previewName: result.payload.name,
        previewFormat: result.payload.format === 'round_robin' ? '单循环赛' : '单淘汰赛' });
    },
    onBack() { if (!this.isBusy()) this.setData({ preview: false }); },
    onSubmit() {
      if (this.isBusy() || !this.data.preview) return;
      const result = validateFootballEventForm(this.form);
      if (!result.ok) { this.setData({ preview: false }); this.refreshForm(); return; }
      if (!this.requestId) this.requestId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      this.awaitingSubmission = true;
      this.setData({ pending: true });
      this.triggerEvent('submit', { ...result.payload, requestId: this.requestId });
    },
    onCancel() { if (!this.isBusy()) this.triggerEvent('cancel'); },
  },
});
