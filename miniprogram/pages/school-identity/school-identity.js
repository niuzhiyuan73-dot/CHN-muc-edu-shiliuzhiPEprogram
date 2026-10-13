const service = require('../../services/school-identity.js');
const STATUS_LABEL = { pending: '待审核', active: '已通过', rejected: '已驳回', left: '已离校', disabled: '已停用' };

Page({
  data: {
    schoolId: 'muc', schoolName: '中央民族大学', schools: [], schoolIndex: 0,
    colleges: [], collegeIndex: -1, collegeName: '', studentId: '',
    loading: true, submitting: false, error: '', notice: '',
    isMock: false, demoActors: [], demoActorIndex: 0, demoActorName: '',
    user: null, account: null, statusText: '', canApply: false, canReview: false, applications: [],
  },
  onLoad() { this.unloaded = false; return this.reload(); },
  onUnload() { this.unloaded = true; this.loadVersion = (this.loadVersion || 0) + 1; },
  onPullDownRefresh() {
    if (this.data.submitting) { wx.stopPullDownRefresh(); return; }
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
  update(data) { if (!this.unloaded) this.setData(data); },
  async reload() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    const schoolId = this.data.schoolId;
    const api = service.forSchoolIdentity({ schoolId, association: 'pkb' });
    const actors = service.getDemoActors();
    const actorIndex = Math.max(0, actors.findIndex(actor => actor.id === service.getDemoActor()));
    this.update({ loading: true, error: '', applications: [], canReview: false, canApply: false,
      user: null, account: null, statusText: '', isMock: service.isMockNow(), demoActors: actors,
      demoActorIndex: actorIndex, demoActorName: actors[actorIndex] && actors[actorIndex].label || '' });
    try {
      const [directory, session] = await Promise.all([api.getSchoolDirectory(), api.getSchoolIdentitySession()]);
      if (!directory.ok || !session.ok) throw new Error(directory.message || session.message || '读取学校信息失败');
      let applications = [];
      if (session.canReview) {
        const result = await api.getSchoolApplications();
        if (!result.ok) throw new Error(result.message || '读取申请失败');
        applications = result.applications;
      }
      if (this.unloaded || version !== this.loadVersion) return;
      this.api = api;
      const account = session.account;
      const collegeIndex = account ? directory.colleges.findIndex(c => c.collegeId === account.collegeId) : -1;
      const schoolIndex = directory.schools.findIndex(s => s.schoolId === schoolId);
      const homeMismatch = session.user && session.user.primarySchoolId && session.user.primarySchoolId !== schoolId;
      this.update({ schools: directory.schools, schoolIndex, colleges: directory.colleges,
        schoolName: schoolIndex >= 0 ? directory.schools[schoolIndex].name : schoolId,
        collegeIndex, collegeName: collegeIndex >= 0 ? directory.colleges[collegeIndex].name : '',
        studentId: account && account.studentId || '', user: session.user, account,
        statusText: account ? STATUS_LABEL[account.status] || '身份状态待确认' : '尚未申请',
        canReview: session.canReview,
        canApply: Boolean(session.user && !homeMismatch && (!account || ['pending', 'rejected'].includes(account.status))),
        notice: homeMismatch ? '当前浏览外校。转校需要单独办理，不能通过普通申请更改归属。' : session.message || '',
        applications: applications.map(row => ({ ...row, reason: '',
          collegeName: (directory.colleges.find(c => c.collegeId === row.collegeId) || {}).name || '学院待核实' })),
      });
    } catch (err) {
      if (version === this.loadVersion) this.update({ error: err.message || '加载失败，请重试' });
    } finally {
      if (version === this.loadVersion) this.update({ loading: false });
    }
  },
  onSchoolChange(event) {
    if (this.data.submitting) return;
    const school = this.data.schools[Number(event.detail.value)];
    if (!school || school.schoolId === this.data.schoolId) return;
    this.update({ schoolId: school.schoolId, schoolName: school.name, notice: '', studentId: '', collegeIndex: -1 });
    return this.reload();
  },
  onDemoActorChange(event) {
    if (this.data.submitting || !service.isMockNow()) return;
    const actor = this.data.demoActors[Number(event.detail.value)];
    if (!actor) return;
    service.setDemoActor(actor.id);
    return this.reload();
  },
  onCollegeChange(event) {
    if (this.data.submitting || this.data.loading) return;
    const index = Number(event.detail.value);
    if (this.data.colleges[index]) this.update({ collegeIndex: index, collegeName: this.data.colleges[index].name });
  },
  onStudentIdInput(event) { if (!this.data.submitting) this.update({ studentId: event.detail.value }); },
  onReasonInput(event) {
    if (this.data.submitting) return;
    const userId = event.currentTarget.dataset.userId;
    this.update({ applications: this.data.applications.map(row => row.userId === userId ? { ...row, reason: event.detail.value } : row) });
  },
  async write(action) {
    if (this.data.loading || this.data.submitting || !this.api) return;
    this.update({ submitting: true, error: '', notice: '' });
    try {
      const result = await action(this.api);
      if (!result.ok) throw new Error(result.message || '提交失败');
      await this.reload();
      this.update({ notice: '操作成功' });
    } catch (err) {
      this.update({ error: err.message || '提交失败，请重试' });
    } finally { this.update({ submitting: false }); }
  },
  onApply() {
    if (!this.data.canApply) return;
    const college = this.data.colleges[this.data.collegeIndex];
    if (!college) { this.update({ error: '请选择学院' }); return; }
    const studentId = this.data.studentId;
    return this.write(api => api.applySchoolMembership({ collegeId: college.collegeId, studentId }));
  },
  onReview(event) {
    if (!this.data.canReview) return;
    const { userId, decision } = event.currentTarget.dataset;
    const row = this.data.applications.find(item => item.userId === userId);
    if (!row || !['approve', 'reject'].includes(decision)) return;
    if (decision === 'reject' && !row.reason.trim()) { this.update({ error: '请先填写驳回理由' }); return; }
    return this.write(api => api.reviewSchoolMembership({ userId, decision, revision: row.revision, reason: row.reason }));
  },
  onRetry() { if (!this.data.submitting) return this.reload(); },
});
