/**
 * 组队：球队详情
 * ============================================================
 * 一页承担四种身份看到的不同内容，靠服务端下发的布尔量切换，页面不自己判权：
 *   · 路人：看名单 + 「申请加入」；
 *   · 队员：看名单 + 「退队」；
 *   · 队长：多出「审批入队」「转让队长」「归档球队」；
 *   · 协会负责人：与队长同权，可接管任何一支队。
 *
 * 所有动作都走服务端校验；页面上的按钮只是「让该看到的人看到」，
 * 不是权限本身（藏按钮挡不住直接调接口）。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

Page({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    teamId: '',
    /** 球队视图（含 canManage / isCaptain / canApply / membershipLabel） */
    team: null,
    /** 名单：队长与管理者能看到待审申请 */
    members: [],
    pendingCount: 0,
    /** 战绩（getTeamRecord）：总胜负 + 历届 + 近期；归档后照样能看 */
    record: null,
    /** 战绩单独失败不影响球员名单，所以错误只落在这一块 */
    recordError: '',
    /** 动作进行中，防连点 */
    busy: false,
    notice: '',
    noticeError: false,
  },

  onLoad(query = {}) {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    this.scope = { schoolId, association: associationScope.getAssociation() };
    this.setData({
      themeClass: currentThemeClass(),
      teamId: query.teamId ? decodeURIComponent(query.teamId) : '',
    });
    return this.refresh();
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await space.forScope(this.scope).getTeam({ teamId: this.data.teamId });
      if (!result.ok) {
        this.setData({ loading: false, error: result.message || '球队不存在' });
        return undefined;
      }
      this.setData({
        loading: false,
        team: result.team,
        members: result.members || [],
        pendingCount: Number(result.pendingCount) || 0,
      });
      // 战绩与名单互不依赖：单独取，失败也不该把整页打成加载失败
      this.loadRecord();
      return undefined;
    } catch (err) {
      console.error('[team-detail] 加载失败', err);
      this.setData({ loading: false, error: '球队加载失败，请稍后重试' });
      return undefined;
    }
  },

  /**
   * 取球队战绩。
   *
   * 只读、对所有人开放（包括归档球队）——「这支队往年打得怎么样」是公开事实，
   * 与「谁能改这支队的名单」是两件事。
   */
  async loadRecord() {
    try {
      const result = await space.forScope(this.scope).getTeamRecord({ teamId: this.data.teamId });
      if (!result || result.ok !== true) {
        this.setData({ record: null, recordError: (result && result.message) || '战绩加载失败' });
        return undefined;
      }
      this.setData({ record: result, recordError: '' });
      return undefined;
    } catch (err) {
      console.error('[team-detail] 战绩加载失败', err);
      this.setData({ record: null, recordError: '战绩加载失败，请稍后重试' });
      return undefined;
    }
  },

  /** 统一的写动作包装：防连点 + 失败提示 + 成功后刷新 */
  async run(action, payload, successText) {
    if (this.data.busy) return undefined;
    this.setData({ busy: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope)[action](payload);
      if (!result.ok) {
        this.setData({ busy: false, notice: result.message || '操作失败', noticeError: true });
        return undefined;
      }
      this.setData({ busy: false, notice: successText, noticeError: false });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error(`[team-detail] ${action} 失败`, err);
      this.setData({ busy: false, notice: '操作失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onApply() {
    return this.run('applyToJoinTeam', { teamId: this.data.teamId }, '已提交入队申请，等队长审批');
  },

  onApprove(event) {
    const { userid } = event.currentTarget.dataset;
    return this.run('reviewTeamMember', { teamId: this.data.teamId, userId: userid, approve: true }, '已通过入队申请');
  },

  onReject(event) {
    const { userid } = event.currentTarget.dataset;
    return this.run('reviewTeamMember', { teamId: this.data.teamId, userId: userid, approve: false }, '已拒绝该申请');
  },

  onLeave() {
    return this.run('leaveTeam', { teamId: this.data.teamId }, '已退队');
  },

  /** 转让队长：二次确认，避免误点把队长交出去 */
  onTransfer(event) {
    const { userid, name } = event.currentTarget.dataset;
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
    return new Promise((resolve) => {
      wx.showModal({
        title: '转让队长',
        content: `确定把队长转给「${name}」吗？转让后你将变成普通队员。`,
        success: (res) => {
          if (!res.confirm) { resolve(undefined); return; }
          this.run('transferTeamCaptain', { teamId: this.data.teamId, userId: userid }, `已把队长转给 ${name}`)
            .then(resolve);
        },
        fail: () => resolve(undefined),
      });
    });
  },

  onArchive() {
    if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
    return new Promise((resolve) => {
      wx.showModal({
        title: '归档球队',
        content: '归档后不再接受入队与报名，历史成绩仍可查询。确定归档吗？',
        success: (res) => {
          if (!res.confirm) { resolve(undefined); return; }
          this.run('archiveTeam', { teamId: this.data.teamId }, '球队已归档')
            .then(() => { if (typeof wx.navigateBack === 'function') wx.navigateBack(); resolve(undefined); });
        },
        fail: () => resolve(undefined),
      });
    });
  },
});
