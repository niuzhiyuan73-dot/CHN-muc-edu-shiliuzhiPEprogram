const identity = require('../../services/school-identity.js');
const exchange = require('../../services/exchange.js');
const STATE = { signup: '报名中', ready: '名单已锁定', drawn: '已抽签', finished: '名次已确认', canceled: '已取消' };
const INVITATION = { pending: '待确认', accepted: '已接受', declined: '已婉拒', withdrawn: '已撤回' };
const MATCH_STATUS = { pending: '待比赛', active: '已确认' };

Page({
  data: {
    loading: true, busy: false, error: '', notice: '', schoolId: 'muc', schoolName: '中央民族大学',
    schoolIndex: 0, schools: [], actors: [], actorIndex: 0, actorName: '',
    canCreate: false, events: [], detail: null, scoreDraft: {},
    title: '民大北航单打交流赛', location: '模拟球场', date: '', time: '18:00', quota: '4', schoolQuota: '2',
  },
  onLoad() {
    const tomorrow = new Date(Date.now() + 86400000);
    this.setData({ date: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}` });
    this.unloaded = false;
    return this.reload();
  },
  onUnload() { this.unloaded = true; this.sequence = (this.sequence || 0) + 1; },
  update(values) { if (!this.unloaded) this.setData(values); },
  async reload(eventId = '') {
    const seq = this.sequence = (this.sequence || 0) + 1;
    this.update({ loading: true, error: '', events: [], detail: null, canCreate: false });
    try {
      // 2026-10-16 起云端也已接入（协议 2 注册了邀请赛动作），门面按数据源自己选，
      // 页面不再拦「非模拟模式」——否则云环境一上线，这里就成了唯一的死路。
      const target = { schoolId: this.data.schoolId, association: 'pkb' };
      const sessionApi = identity.forSchoolIdentity(target);
      const api = exchange.forScope(target);
      const [directory, session] = await Promise.all([sessionApi.getSchoolDirectory(), sessionApi.getSchoolIdentitySession()]);
      if (!directory.ok || !session.ok) throw new Error(directory.message || session.message);
      const result = await api.getExchangeEvents();
      let detail = null;
      if (eventId && result.ok) {
        const response = await api.getExchangeEvent({ eventId });
        if (response.ok) detail = this.describeDetail(response, target.schoolId);
      }
      if (seq !== this.sequence || this.unloaded) return;
      this.api = api;
      const actors = identity.getDemoActors();
      // 当前演示身份未必在这份体验身份清单里（默认身份跟随 mock.js 的演示账号），
      // 找不到就落到第一项，别让下拉 value 变成 -1。
      const found = actors.findIndex(actor => actor.id === identity.getDemoActor());
      const actorIndex = found >= 0 ? found : 0;
      const schoolIndex = directory.schools.findIndex(school => school.schoolId === target.schoolId);
      this.update({ schools: directory.schools, schoolIndex, schoolName: directory.schools[schoolIndex].name,
        actors, actorIndex, actorName: (actors[actorIndex] && actors[actorIndex].label) || '',
        canCreate: session.canManageAssociation, detail, scoreDraft: {},
        events: (result.events || []).map(event => ({ ...event, statusText: STATE[event.status],
          invitationText: INVITATION[event.invitations[target.schoolId]] })),
        notice: result.ok ? '' : result.message,
      });
    } catch (err) {
      if (seq === this.sequence) this.update({ error: err.message || '读取失败，请刷新重试' });
    } finally { if (seq === this.sequence) this.update({ loading: false }); }
  },
  describeDetail(response, schoolId) {
    const event = response.event;
    const canceled = response.canceled === true || event.status === 'canceled';
    return { ...response, statusText: STATE[event.status], canceled,
      canLock: !canceled && response.canManage && event.status === 'signup',
      schools: event.participantSchoolIds.map(id => ({ id, name: event.schoolNames[id],
        status: INVITATION[event.invitations[id]], count: event.schoolCounts[id], quota: event.schoolQuotas[id],
        // 撤回邀请：报名阶段、不是主办校自己、该校还没人报名时才能撤
        canWithdraw: Boolean(response.canWithdrawInvitation) && id !== event.schoolId &&
          (event.schoolCounts[id] || 0) === 0 &&
          ['pending', 'accepted'].includes(event.invitations[id]),
      })),
      invitationText: INVITATION[event.invitations[schoolId]],
      results: (event.results || []).slice(),
      participants: (response.participants || []).map(row => ({ ...row,
        checkInText: row.checkInTime ? '已签到' : '未签到' })),
      matches: (response.matches || []).map(match => ({ ...match, statusText: MATCH_STATUS[match.status],
        scoreText: match.status === 'active' ? `${match.scoreA}:${match.scoreB}` : '未开始' })),
    };
  },

  /** 破坏性动作的二次确认：与协会空间面板同一写法，测试环境放行 */
  confirmAction(content, title = '请确认') {
    return new Promise(resolve => {
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') { resolve(true); return; }
      wx.showModal({ title, content, success: res => resolve(Boolean(res.confirm)), fail: () => resolve(false) });
    });
  },
  onSchoolChange(event) {
    if (this.data.busy) return;
    const school = this.data.schools[Number(event.detail.value)];
    if (!school) return;
    this.update({ schoolId: school.schoolId, notice: '' });
    this.requestId = '';
    return this.reload();
  },
  onActorChange(event) {
    if (this.data.busy) return;
    const actor = this.data.actors[Number(event.detail.value)];
    if (!actor) return;
    // 切换演示身份统一经 app（B3）：登录态、兼容视图与浏览范围跟着新身份
    // 一起刷新，避免「按钮是管理员、提交是会员」的分裂。测试环境没有 app
    // 实例时退回只切 mock 身份。
    const app = typeof getApp === 'function' ? getApp() : null;
    const switched = app && typeof app.switchDemoActor === 'function'
      ? app.switchDemoActor(actor.id).catch(err => { this.update({ error: err.message || '切换身份失败' }); })
      : Promise.resolve(identity.setDemoActor(actor.id));
    this.requestId = '';
    return switched.then(() => this.reload(this.data.detail && this.data.detail.event._id || ''));
  },
  onField(event) {
    if (this.data.busy) return;
    const field = event.currentTarget.dataset.field;
    if (!['title', 'location', 'date', 'time', 'quota', 'schoolQuota'].includes(field)) return;
    this.update({ [field]: event.detail.value });
    this.requestId = '';
  },
  onOpen(event) {
    if (!this.data.busy) return this.reload(event.currentTarget.dataset.id);
  },
  onRefresh() { if (!this.data.busy) return this.reload(this.data.detail && this.data.detail.event._id || ''); },
  async write(action) {
    if (this.data.loading || this.data.busy || !this.api) return;
    this.update({ busy: true, error: '', notice: '' });
    try {
      const result = await action(this.api);
      if (!result.ok) throw new Error(result.message || '操作失败');
      await this.reload(result.event._id);
      this.update({ notice: '操作成功' });
    } catch (err) { this.update({ error: err.message || '操作失败，请重试' }); }
    finally { this.update({ busy: false }); }
  },
  onCreate() {
    if (!this.data.canCreate) return;
    const schoolIds = this.data.schools.map(school => school.schoolId);
    if (schoolIds.length !== 2) { this.update({ error: '当前体验页需要两所试点学校' }); return; }
    const start = new Date(`${this.data.date}T${this.data.time}:00`);
    if (!Number.isFinite(start.getTime())) { this.update({ error: '请选择有效时间' }); return; }
    this.requestId = this.requestId || `create_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return this.write(api => api.createExchangeEvent({ requestId: this.requestId, title: this.data.title,
      location: this.data.location, startTime: start.toISOString(), participantSchoolIds: schoolIds,
      quota: Number(this.data.quota), schoolQuotas: Object.fromEntries(schoolIds.map(id => [id, Number(this.data.schoolQuota)])),
    }));
  },
  onRespond(event) {
    if (!this.data.detail || !this.data.detail.canRespond) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.respondExchangeInvitation({ eventId, decision: event.currentTarget.dataset.decision }));
  },
  onSignup() {
    if (!this.data.detail || !this.data.detail.canSignup) return;
    const { signed, event } = this.data.detail;
    return this.write(api => signed ? api.cancelExchangeSignup({ eventId: event._id }) : api.signUpExchangeEvent({ eventId: event._id }));
  },
  onLock() {
    if (!this.data.detail || !this.data.detail.canManage) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.lockExchangeRoster({ eventId }));
  },
  onDraw() {
    if (!this.data.detail || !this.data.detail.canDraw) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.drawExchangeEvent({ eventId }));
  },
  onRefereeChange(event) {
    if (this.data.busy || !this.data.detail) return;
    const referee = this.data.detail.referees[Number(event.detail.value)];
    if (!referee) return;
    const matchId = event.currentTarget.dataset.matchid;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.assignExchangeReferee({ eventId, matchId, refereeId: referee.userId }));
  },
  onScoreInput(event) {
    if (this.data.busy) return;
    const { matchid, side } = event.currentTarget.dataset;
    if (!matchid || !['a', 'b'].includes(side)) return;
    const scoreDraft = { ...this.data.scoreDraft };
    scoreDraft[matchid] = { a: '', b: '', ...(scoreDraft[matchid] || {}), [side]: event.detail.value };
    this.update({ scoreDraft });
  },
  onSubmitScore(event) {
    if (this.data.busy || !this.data.detail) return;
    const matchId = event.currentTarget.dataset.matchid;
    const row = this.data.scoreDraft[matchId] || {};
    const scoreA = Number(row.a);
    const scoreB = Number(row.b);
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      this.update({ error: '请填写双方比分' });
      return;
    }
    const eventId = this.data.detail.event._id;
    return this.write(api => api.submitExchangeScore({ eventId, matchId, scoreA, scoreB }));
  },
  onConfirmRanking() {
    if (!this.data.detail || !this.data.detail.canConfirmRanking) return;
    const eventId = this.data.detail.event._id;
    return this.write(api => api.confirmExchangeRanking({ eventId }));
  },

  /* ---------- S4 剩余能力（2026-10-16）：签到 / 退赛 / 撤回邀请 / 取消 / 撤销比分 ---------- */

  /** 代签：管理员在场边替参赛者签到（与普通赛事同一口径，本人不自助签到） */
  onCheckIn(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const userId = event.currentTarget.dataset.userid;
    if (!userId) return;
    return this.write(api => api.checkInExchangeSignup({ eventId: detail.event._id, userId }));
  },

  /** 移除报名者（退赛处理）：只在报名阶段，需二次确认 */
  onRemoveSignup(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const userId = event.currentTarget.dataset.userid;
    if (!userId) return;
    return this.confirmAction('移除后该名额会释放，确定移除这位报名者吗？', '移除报名')
      .then(confirmed => (confirmed
        ? this.write(api => api.removeExchangeSignup({ eventId: detail.event._id, userId }))
        : undefined));
  },

  /** 撤回对某校的邀请（主办方撤别人、受邀校撤自己那一条） */
  onWithdrawInvitation(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const schoolId = event.currentTarget.dataset.schoolid;
    if (!schoolId) return;
    return this.confirmAction('撤回后该校不能再报名，确定撤回邀请吗？', '撤回邀请')
      .then(confirmed => (confirmed
        ? this.write(api => api.withdrawExchangeInvitation({ eventId: detail.event._id, schoolId }))
        : undefined));
  },

  /** 取消整场赛事：主办校管理员或平台管理员 */
  onCancelEvent() {
    const { detail } = this.data;
    if (this.data.busy || !detail || !detail.canCancel) return;
    return this.confirmAction('取消后不能再报名、抽签与录入比分，已确认的比分作为历史保留。确定取消吗？', '取消赛事')
      .then(confirmed => (confirmed
        ? this.write(api => api.cancelExchangeEvent({ eventId: detail.event._id }))
        : undefined));
  },

  /** 撤销已确认的比分（从最后一轮往前撤），撤销后可以重新录入 */
  onRevokeScore(event) {
    const { detail } = this.data;
    if (this.data.busy || !detail) return;
    const matchId = event.currentTarget.dataset.matchid;
    if (!matchId) return;
    return this.confirmAction('撤销后这场比赛回到待确认，比分要重新录入。确定撤销吗？', '撤销比分')
      .then(confirmed => (confirmed
        ? this.write(api => api.revokeExchangeScore({ eventId: detail.event._id, matchId }))
        : undefined));
  },
});
