const identity = require('../../services/school-identity.js');
const exchange = require('../../services/exchange.js');
const STATE = { signup: '报名中', ready: '名单已锁定', drawn: '已抽签', finished: '名次已确认' };
const INVITATION = { pending: '待确认', accepted: '已接受', declined: '已婉拒' };
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
      if (!identity.isMockNow()) throw new Error('跨校交流当前仅开放本地模拟体验');
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
    return { ...response, statusText: STATE[event.status],
      canLock: response.canManage && event.status === 'signup',
      schools: event.participantSchoolIds.map(id => ({ id, name: event.schoolNames[id],
        status: INVITATION[event.invitations[id]], count: event.schoolCounts[id], quota: event.schoolQuotas[id] })),
      invitationText: INVITATION[event.invitations[schoolId]],
      results: (event.results || []).slice(),
      matches: (response.matches || []).map(match => ({ ...match, statusText: MATCH_STATUS[match.status],
        scoreText: match.status === 'active' ? `${match.scoreA}:${match.scoreB}` : '未开始' })),
    };
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
    identity.setDemoActor(actor.id);
    this.requestId = '';
    return this.reload(this.data.detail && this.data.detail.event._id || '');
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
});
