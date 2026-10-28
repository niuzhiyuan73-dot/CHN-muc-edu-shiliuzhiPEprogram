const space = require('../../services/association-space.js');

Component({
  properties: {
    active: { type: Boolean, value: false },
    scope: { type: Object, value: {} },
    collegeId: { type: String, value: '' },
    selected: { type: Array, value: [] },
  },
  data: { keyword: '', rows: [], picked: [], loading: false, error: '', hasMore: false, nextCursor: '' },
  observers: {
    'active, scope, collegeId': function () {
      this.epoch = (this.epoch || 0) + 1;
      clearTimeout(this.searchTimer);
      if (!this.properties.active) return;
      this.setData({ keyword: '', rows: [], picked: this.properties.selected.slice(), nextCursor: '', hasMore: false });
      this.loadPage(false);
    },
  },
  lifetimes: { detached() { this.epoch = (this.epoch || 0) + 1; clearTimeout(this.searchTimer); } },
  methods: {
    async loadPage(append) {
      if (!this.properties.active || (append && (this.data.loading || !this.data.hasMore))) return;
      const epoch = this.epoch = (this.epoch || 0) + 1;
      const keyword = this.data.keyword;
      this.setData({ loading: true, error: '', ...(append ? {} : { rows: [], hasMore: false }) });
      try {
        const result = await space.forScope(this.properties.scope).listSchoolMembers({ page: true,
          collegeId: this.properties.collegeId, keyword, cursor: append ? this.data.nextCursor : '', limit: 20 });
        if (epoch !== this.epoch || !this.properties.active) return;
        if (!result.ok) throw new Error(result.message || '无法读取候选会员');
        const picked = new Set(this.data.picked.map(row => row.userId));
        const byId = new Map((append ? this.data.rows : []).map(row => [row.userId, row]));
        for (const row of result.members || []) byId.set(row.userId, { userId: row.userId,
          nickName: row.nickName || row.realName || row.userId, checked: picked.has(row.userId) });
        this.setData({ rows: [...byId.values()], loading: false, hasMore: Boolean(result.hasMore), nextCursor: result.nextCursor || '' });
      } catch (error) {
        if (epoch === this.epoch && this.properties.active) this.setData({ loading: false, error: error.message || '加载失败，请重试' });
      }
    },
    onSearch(event) {
      clearTimeout(this.searchTimer);
      this.epoch = (this.epoch || 0) + 1;
      this.setData({ keyword: String(event.detail.value || '').slice(0, 32), loading: false, rows: [], error: '', hasMore: false });
      this.searchTimer = setTimeout(() => this.loadPage(false), 250);
    },
    onToggle(event) {
      const id = event.currentTarget.dataset.id;
      const row = this.data.rows.find(item => item.userId === id) || this.data.picked.find(item => item.userId === id);
      if (!row) return;
      const exists = this.data.picked.some(item => item.userId === id);
      const picked = exists ? this.data.picked.filter(item => item.userId !== id) : [...this.data.picked, { userId: id, nickName: row.nickName }];
      const ids = new Set(picked.map(item => item.userId));
      this.setData({ picked, rows: this.data.rows.map(item => ({ ...item, checked: ids.has(item.userId) })) });
    },
    onMore() { return this.loadPage(true); },
    onRetry() { return this.loadPage(this.data.rows.length > 0); },
    onCancel() { this.epoch = (this.epoch || 0) + 1; clearTimeout(this.searchTimer); this.triggerEvent('cancel'); },
    onConfirm() { this.epoch = (this.epoch || 0) + 1; clearTimeout(this.searchTimer); this.triggerEvent('confirm', { members: this.data.picked }); },
    noop() {},
  },
});
