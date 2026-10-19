/**
 * 组队：球队列表
 * ============================================================
 * 团队运动（篮球）的入口页。三件事：
 *   1. 看队 —— 我的球队 / 全部球队，可按队名搜；
 *   2. 建队 —— 学生申请，提交后是「待审核」，协会负责人通过才成立；
 *   3. 进队 —— 点开详情申请加入，队长审批。
 *
 * 这一页只做列表与建队；入队审批在详情页，避免列表上放一排只有队长能点的
 * 按钮（普通成员看到一片灰按钮只会困惑）。
 * ============================================================
 */

const space = require('../../services/association-space.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const { currentThemeClass } = require('../../services/branding.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 生成一次提交的请求编号：时间戳 + 随机后缀，满足服务端字符集要求 */
function nextRequestId() {
  return `team_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

Page({
  data: {
    loading: true,
    error: '',
    themeClass: '',
    /** 球队行：[{ teamId, name, captainName, memberCount, statusLabel, isMine, isCaptain }] */
    teams: [],
    /** 是否只看我的球队 */
    mineOnly: false,
    keyword: '',
    /** 当前账号能不能审核建队（协会负责人及以上） */
    canManage: false,
    /** 建队表单 */
    creating: false,
    newName: '',
    submitting: false,
    notice: '',
    noticeError: false,
  },

  onLoad() {
    const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;
    const association = associationScope.getAssociation();
    this.scope = { schoolId, association };
    this.setData({ themeClass: currentThemeClass(), association });
    return this.refresh();
  },

  /** 取列表。失败时给一句人话，不把异常抛到页面上 */
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await space.forScope(this.scope).listTeams({
        keyword: this.data.keyword,
        mine: this.data.mineOnly,
      });
      if (!result.ok) {
        this.setData({ loading: false, error: result.message || '球队列表加载失败' });
        return undefined;
      }
      this.setData({ loading: false, teams: result.teams || [], canManage: result.canManage === true });
      return undefined;
    } catch (err) {
      console.error('[team-list] 加载失败', err);
      this.setData({ loading: false, error: '球队列表加载失败，请稍后重试' });
      return undefined;
    }
  },

  onInputKeyword(event) {
    this.setData({ keyword: event.detail.value });
  },

  /** 搜索按提交触发，不在每次输入都请求（人多了会把接口打满） */
  onSearch() {
    return this.refresh();
  },

  onToggleMine() {
    this.setData({ mineOnly: !this.data.mineOnly });
    return this.refresh();
  },

  onOpenCreate() {
    this.setData({ creating: true, newName: '', notice: '', noticeError: false });
  },

  onCloseCreate() {
    this.setData({ creating: false, submitting: false });
  },

  onInputName(event) {
    this.setData({ newName: event.detail.value });
  },

  /**
   * 提交建队申请。
   * 请求编号在点击时生成一次：网络超时后用户再点，是新的一次申请还是重试？
   * 这里按「新申请」处理——队名相同会被服务端判重名，用户能看到原因。
   */
  async onSubmitCreate() {
    if (this.data.submitting) return undefined;
    this.setData({ submitting: true, notice: '', noticeError: false });
    try {
      const result = await space.forScope(this.scope).createTeamApplication({
        name: this.data.newName,
        requestId: nextRequestId(),
      });
      if (!result.ok) {
        this.setData({ submitting: false, notice: result.message || '建队失败', noticeError: true });
        return undefined;
      }
      this.setData({ submitting: false, creating: false, notice: '已提交建队申请，等协会负责人审核', noticeError: false });
      await this.refresh();
      return undefined;
    } catch (err) {
      console.error('[team-list] 建队失败', err);
      this.setData({ submitting: false, notice: '建队失败，请稍后重试', noticeError: true });
      return undefined;
    }
  },

  onOpenTeam(event) {
    const { teamid } = event.currentTarget.dataset;
    return wx.navigateTo({ url: `/pages/team-detail/team-detail?teamId=${encodeURIComponent(teamid)}` });
  },
});
