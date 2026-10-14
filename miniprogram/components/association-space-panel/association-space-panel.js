/**
 * 协会空间面板（协会工作台内嵌页签）
 * ============================================================
 * 工作台顶层新增「协会空间」页签，排在第一且进入即默认展示。面板内含四个
 * 二级页签：分组 / 通知 / 训练 / 成员，默认展示「训练」（见规划 §3.1）。
 *
 * 【为什么二级也懒挂载】
 * 与顶层同理：一次全挂会同时取四份数据。只有切过去才挂，挂过的保持挂载，
 * 来回切不丢搜索词与滚动位置。
 *
 * 【本阶段落了什么】
 * P1 只落「分组」与「成员」两个可用页签：分组可建组、本人退出、管理移出、
 * 归档；成员可按 §4.5 搜索并点进个人主页。「通知」「训练」在 P2 / P3 补齐，
 * 这里先给占位说明，不做假数据，也不给可点但无作用的按钮。
 *
 * 【取数一律绑定进入时的范围】
 * 学校取 school-session、协会取 association-scope，创建客户端时一次固定，
 * 之后的每个请求都用这把范围——不在异步等待期间再读全局状态（见 §9.4）。
 * ============================================================
 */

const identity = require('../../services/school-identity.js');
const space = require('../../services/association-space.js');
const { currentThemeClass } = require('../../services/branding.js');

/** 二级页签定义。顺序即页面上的先后，默认落在「训练」 */
const SUB_TABS = [
  { key: 'group', label: '分组' },
  { key: 'notice', label: '通知' },
  { key: 'training', label: '训练' },
  { key: 'member', label: '成员' },
];
const DEFAULT_SUB = 'training';
const isKnownSub = (key) => SUB_TABS.some((def) => def.key === key);
/** 一格的名录一次取多少——既是成员页签一页，也是建组选人的候选池 */
const MEMBER_PAGE = 20;
const PICK_POOL = 50;

Component({
  options: {
    // 组件默认样式隔离，app.wxss 里的 .card / .pool-tabs / .btn 等全局类进不来。
    // apply-shared 让全局与所在页面的样式渗入组件，本面板的样式仍不外泄。
    styleIsolation: 'apply-shared',
  },

  data: {
    loading: true,
    error: '',
    notice: '',
    themeClass: '',
    /** 顶栏：当前学校与协会，避免只显示「匹克球」分不清民大与北航 */
    spaceTitle: '协会空间',

    /** 二级页签：[{ key, label, active }] */
    subTabs: SUB_TABS.map((def) => ({ ...def, active: def.key === DEFAULT_SUB })),
    activeSub: DEFAULT_SUB,
    /** 挂载过的二级页签，默认只挂「训练」 */
    mountedSub: { group: false, notice: false, training: true, member: false },

    // ---------- 分组页签 ----------
    groups: [],
    canManage: false,
    groupBusy: false,
    // 建组 / 编辑表单（同一份 groupForm 两处复用）
    showCreate: false,
    groupForm: { name: '', description: '' },
    /** 正在编辑的小组 id；空串表示没有在编辑 */
    editingId: '',
    /** 编辑时自带的版本号，提交时回传以防覆盖他人改动 */
    editRevision: 0,
    /** 建组候选：本协会在册会员（脱敏 DTO） */
    roster: [],
    selectedMemberIds: [],
    /** 展开的名册：groupId -> { loading, members } */
    openGroupId: '',
    detailMembers: [],
    detailLoading: false,

    // ---------- 成员页签 ----------
    keyword: '',
    members: [],
    memberCursor: '',
    memberHasMore: false,
    memberLoading: false,
    memberError: '',
    searching: false,
    memberEmptyNote: '',
  },

  lifetimes: {
    attached() {
      this.onLoad();
    },
  },

  pageLifetimes: {
    show() {
      if (typeof this.onShow === 'function') this.onShow();
    },
  },

  methods: {
    onLoad() {
      return this.refresh();
    },

    /**
     * 从别的页签切回时重算：刚建/退的组会改变列表。
     * loaded 只在首屏落地后置真，避免 attached 后紧跟的 show 白刷一遍。
     */
    onShow() {
      if (!this.loaded) return undefined;
      return this.refresh();
    },

    onPullDownRefresh() {
      return this.refresh().then(() => wx.stopPullDownRefresh());
    },

    /** 组装当前范围（学校 + 协会），并固定成本次的客户端 */
    scopeKey() {
      const schoolId = require('../../services/school-session.js').getSchoolId();
      const association = require('../../services/association-scope.js').getAssociation();
      return { schoolId, association };
    },

    /**
     * 标题：学校 + 协会。演示协会名（北航匹克球）已带学校前缀，避免「北航·北航匹克球」。
     * @param {string} schoolName
     * @param {string} associationName
     */
    composeTitle(schoolName, associationName) {
      if (!schoolName) return associationName || '协会空间';
      const rest = associationName && associationName.startsWith(schoolName)
        ? associationName.slice(schoolName.length)
        : associationName;
      return rest ? `${schoolName}·${rest}` : schoolName;
    },

    /** 装载首屏：学校名 + 分组列表 + 成员名录（供成员页签与建组选人共用） */
    async refresh() {
      try {
        const scope = this.scopeKey();
        this.api = space.forScope(scope);
        const sessionApi = identity.forSchoolIdentity(scope);
        this.scope = scope;

        let schoolName = '';
        try {
          const directory = await sessionApi.getSchoolDirectory();
          const found = directory && directory.ok && (directory.schools || []).find((row) => row.schoolId === scope.schoolId);
          if (found) schoolName = found.shortName || found.name || '';
          this.colleges = (directory && directory.colleges) || [];
        } catch (err) {
          console.error('[space] 学校目录读取失败', err);
        }
        schoolName = schoolName || require('../../services/school-demo.js').schoolShortName(scope.schoolId);
        const associationName = this.resolveAssociationName(scope.association);

        const [groupResult, memberResult] = await Promise.all([
          this.api.listAssociationGroups({ limit: 50 }),
          this.api.listAssociationMembers({ limit: PICK_POOL }),
        ]);
        this.loaded = true;
        this.setData({
          loading: false,
          error: groupResult.ok ? '' : groupResult.message || '协会空间加载失败',
          spaceTitle: this.composeTitle(schoolName, associationName),
          themeClass: currentThemeClass(),
          groups: (groupResult.groups || []).map((row) => this.describeGroup(row)),
          canManage: Boolean(groupResult.canManage),
          roster: (memberResult.members || []).map((row) => this.describeMember(row)),
        });
        this.applyKeyword(this.data.keyword);
      } catch (err) {
        console.error('[space] 加载失败', err);
        this.loaded = true;
        this.setData({ loading: false, error: err.message || '协会空间加载失败，请下拉重试',
          themeClass: currentThemeClass() });
      }
    },

    /** 协会显示名：演示学校取演示名（带学校前缀），本校取注册表简称 */
    resolveAssociationName(association) {
      const schoolId = this.scope && this.scope.schoolId;
      const demo = require('../../services/school-demo.js').schoolAssociations(schoolId);
      const found = demo && demo.find((item) => item.id === association);
      if (found) return found.name;
      return require('../../utils/associations.js').getAssociation(association).shortName;
    },

    describeGroup(row) {
      return {
        groupId: row.groupId,
        name: row.name,
        description: row.description || '',
        status: row.status,
        archived: row.status === 'archived',
        memberCount: row.memberCount || 0,
        revision: row.revision,
        joined: Boolean(row.joined),
      };
    },

    describeMember(row) {
      return {
        userId: row.userId,
        nickName: row.nickName || '',
        realName: row.realName || '',
        avatarUrl: row.avatarUrl || '',
        collegeName: row.collegeName || '',
        permissionLabel: row.permissionLabel || '',
        picked: false,
      };
    },

    /** 切二级页签。首次切到时挂上对应的栏目 */
    onSwitchSub(event) {
      const { sub } = event.currentTarget.dataset;
      if (!isKnownSub(sub) || sub === this.data.activeSub) return undefined;
      this.setData({
        activeSub: sub,
        subTabs: SUB_TABS.map((def) => ({ ...def, active: def.key === sub })),
        [`mountedSub.${sub}`]: true,
      });
      // 成员页签首次展开时才拉第一页；挂过之后保留状态，来回切不重拉。
      if (sub === 'member' && !this.memberLoaded) {
        this.memberLoaded = true;
        return this.loadMembers();
      }
      return undefined;
    },

    /* ============================================================
     * 分组页签
     * ============================================================ */

    onToggleCreate() {
      if (!this.data.canManage || this.data.groupBusy) return undefined;
      this.requestId = '';
      this.setData({
        showCreate: !this.data.showCreate,
        editingId: '',
        groupForm: { name: '', description: '' },
        selectedMemberIds: [],
        roster: this.data.roster.map((row) => ({ ...row, picked: false })),
        notice: '',
      });
    },

    /** 展开/收起某个小组的编辑表单（点第二次收起，不再请求） */
    onToggleEdit(event) {
      const groupId = event.currentTarget.dataset.groupid;
      const revision = event.currentTarget.dataset.revision;
      if (!groupId || this.data.groupBusy) return undefined;
      if (this.data.editingId === groupId) {
        return this.setData({ editingId: '' });
      }
      const group = this.data.groups.find((row) => row.groupId === groupId);
      if (!group) return undefined;
      return this.setData({
        editingId: groupId,
        editRevision: revision,
        showCreate: false,
        groupForm: { name: group.name, description: group.description || '' },
        notice: '',
        error: '',
      });
    },

    /** 提交编辑：带上进表单时的版本号，避免覆盖他人改动 */
    onSaveEdit() {
      if (this.data.groupBusy || !this.api) return undefined;
      const groupId = this.data.editingId;
      if (!groupId) return undefined;
      const name = String(this.data.groupForm.name || '').trim();
      if (name.length < 2 || name.length > 30) {
        this.setData({ error: '小组名称请填 2 到 30 个字' });
        return undefined;
      }
      return this.write(() => this.api.updateAssociationGroup({
        groupId, name, description: this.data.groupForm.description || '',
        expectedRevision: this.data.editRevision,
      }), '小组已更新').then(() => {
        if (!this.data.error) this.setData({ editingId: '' });
      });
    },

    onField(event) {
      const field = event.currentTarget.dataset.field;
      if (!['name', 'description'].includes(field)) return undefined;
      this.requestId = '';
      return this.setData({ [`groupForm.${field}`]: event.detail.value });
    },

    onTogglePick(event) {
      const userId = event.currentTarget.dataset.userid;
      if (!userId) return undefined;
      // 在 roster 行上翻转 picked（WXML 不支持 indexOf，选中的判断必须预先算好），
      // 再把选中的 userId 收成一份清单交给建组接口。
      const roster = this.data.roster.map((row) => (row.userId === userId ? { ...row, picked: !row.picked } : row));
      return this.setData({ roster, selectedMemberIds: roster.filter((row) => row.picked).map((row) => row.userId) });
    },

    onCreateGroup() {
      if (this.data.groupBusy || !this.api) return undefined;
      const name = String(this.data.groupForm.name || '').trim();
      if (name.length < 2 || name.length > 30) {
        this.setData({ error: '小组名称请填 2 到 30 个字' });
        return undefined;
      }
      this.requestId = this.requestId || `ag_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      return this.write(() => this.api.createAssociationGroup({
        requestId: this.requestId, name, description: this.data.groupForm.description || '',
        memberIds: this.data.selectedMemberIds.slice(),
      }), '小组已创建');
    },

    /** 展开/收起某个小组的成员名册（点第二次收起，不再请求） */
    onToggleGroupDetail(event) {
      const groupId = event.currentTarget.dataset.groupid;
      if (!groupId || this.data.groupBusy) return undefined;
      if (this.data.openGroupId === groupId) {
        return this.setData({ openGroupId: '', detailMembers: [] });
      }
      return this.loadGroupDetail(groupId);
    },

    /** 拉取并展开某个小组的名册（移出成员后用它刷新名单） */
    loadGroupDetail(groupId) {
      if (!groupId || !this.api) return Promise.resolve();
      this.setData({ openGroupId: groupId, detailMembers: [], detailLoading: true });
      return this.api.getAssociationGroup({ groupId }).then((result) => {
        if (this.data.openGroupId !== groupId) return;
        this.setData({
          detailLoading: false,
          detailMembers: (result.members || []).map((row) => this.describeMember(row)),
        });
      }).catch((err) => {
        this.setData({ detailLoading: false, error: err.message || '名单读取失败' });
      });
    },

    onLeaveGroup(event) {
      const groupId = event.currentTarget.dataset.groupid;
      if (!groupId || this.data.groupBusy) return undefined;
      return this.write(() => this.api.leaveAssociationGroup({ groupId }), '已退出小组');
    },

    onRemoveMember(event) {
      const { groupid: groupId, userid: userId } = event.currentTarget.dataset;
      if (!groupId || !userId || this.data.groupBusy) return undefined;
      // write 成功后会 refresh 首屏；名册此刻可能已被收起，按需再展开并重拉。
      return this.write(() => this.api.removeAssociationGroupMember({ groupId, userId }), '已移出该成员')
        .then(() => (this.data.openGroupId === groupId ? this.loadGroupDetail(groupId) : undefined));
    },

    onArchiveGroup(event) {
      const groupId = event.currentTarget.dataset.groupid;
      const revision = event.currentTarget.dataset.revision;
      if (!groupId || this.data.groupBusy) return undefined;
      return this.write(() => this.api.archiveAssociationGroup({ groupId, expectedRevision: revision }), '小组已归档');
    },

    /* ============================================================
     * 成员页签
     * ============================================================ */

    /** 首屏/切回时按当前关键词重拉第一页 */
    loadMembers() {
      if (!this.api) return Promise.resolve();
      this.setData({ memberLoading: true, memberError: '' });
      return this.api.listAssociationMembers({ keyword: this.data.keyword, limit: MEMBER_PAGE })
        .then((result) => {
          this.setData({
            memberLoading: false,
            members: (result.members || []).map((row) => this.describeMember(row)),
            memberCursor: result.nextCursor || '',
            memberHasMore: Boolean(result.hasMore),
          });
          this.refreshMemberEmptyNote(result.keyword);
        })
        .catch((err) => this.setData({ memberLoading: false, memberError: err.message || '成员加载失败' }));
    },

    onLoadMore() {
      if (this.data.memberLoading || !this.data.memberHasMore || !this.api) return undefined;
      this.setData({ memberLoading: true });
      return this.api.listAssociationMembers({ keyword: this.data.keyword, cursor: this.data.memberCursor, limit: MEMBER_PAGE })
        .then((result) => {
          this.setData({
            memberLoading: false,
            members: this.data.members.concat((result.members || []).map((row) => this.describeMember(row))),
            memberCursor: result.nextCursor || '',
            memberHasMore: Boolean(result.hasMore),
          });
        })
        .catch((err) => this.setData({ memberLoading: false, memberError: err.message || '成员加载失败' }));
    },

    onInputKeyword(event) {
      this.applyKeyword(event.detail.value);
      return this.loadMembers();
    },

    onClearKeyword() {
      this.applyKeyword('');
      return this.loadMembers();
    },

    /** 只更新关键词与搜索态，真正的取数交给 loadMembers */
    applyKeyword(keyword) {
      const word = String(keyword == null ? '' : keyword).trim();
      return this.setData({ keyword: word, searching: Boolean(word) });
    },

    refreshMemberEmptyNote(keyword) {
      const empty = this.data.members.length === 0;
      this.setData({ memberEmptyNote: !empty ? '' : keyword ? '没有找到匹配的成员' : '本协会暂无在册会员' });
    },

    /** 点成员行进入个人主页 */
    onOpenMember(event) {
      const userId = event.currentTarget.dataset.userid;
      if (!userId) return undefined;
      return wx.navigateTo({ url: `/pages/member/member?userId=${userId}` });
    },

    /**
     * 统一写操作：跑 action、拉起忙碌态、成功后重载首屏并给轻提示。
     * @param {Function} action 返回 Promise<{ok, message}>
     * @param {string} successText
     */
    write(action, successText) {
      if (this.data.groupBusy) return Promise.resolve();
      this.setData({ groupBusy: true, error: '', notice: '' });
      return Promise.resolve()
        .then(action)
        .then((result) => {
          if (!result || !result.ok) throw new Error((result && result.message) || '操作失败');
          return this.refresh();
        })
        .then(() => this.setData({ groupBusy: false, notice: successText || '操作成功' }))
        .catch((err) => this.setData({ groupBusy: false, error: err.message || '操作失败，请重试' }));
    },
  },
});
