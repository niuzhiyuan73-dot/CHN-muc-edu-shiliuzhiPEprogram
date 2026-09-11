/**
 * 登录 / 注册
 * ============================================================
 * 三步走，全部在同一页面内切换，不做多页跳转：
 *
 *   entry   入口——微信一键登录（已有账号）或新会员注册
 *   profile 完善实名信息——姓名、学号、学院、联系方式
 *   pending 提交成功——展示「待审核」状态
 *
 * 【为什么不调用 wx.login 拿 code】
 * 云开发环境下，云函数会自动带上调用者的 OpenID，客户端不需要自己
 * 换 code 再传上去——那反而多一道能被伪造的环节。所以这里只调用
 * 门面上的 login()，mock 模式返回演示会员，云端则由 user.login 云函数
 * 依 OpenID 查找或创建账号。校验与组装逻辑都在 services/auth.js，
 * 那边不碰 wx API，能在 Node 里测试。
 *
 * 【昵称头像为什么用 chooseAvatar / type=nickname】
 * wx.getUserProfile 在新的基础库上只能拿到匿名数据，官方已引导改用
 * 「头像昵称填写能力」——由用户主动选择，拿到的是真实可用的内容。
 * ============================================================
 */

const { COLLEGES, login, resolveAuthState } = require('../../services/auth.js');
const { ALL_GENDERS, GENDER_LABEL } = require('../../utils/constants.js');
// 注册要走门面而不是直接调 auth.register：只有落到数据源里，
// 审核页才看得到这条申请，通过了录入页也才选得到这个人
const { isMock, registerMember } = require('../../services/index.js');
const { uploadAvatar } = require('../../services/avatar.js');

Page({
  data: {
    /** 当前步骤：entry / profile / pending */
    step: 'entry',
    /** 注册表单 */
    form: {
      nickName: '',
      avatarUrl: '',
      realName: '',
      gender: '',
      studentId: '',
      college: '',
      phone: '',
    },
    /** 学院候选，供 picker 使用 */
    colleges: COLLEGES,
    /** picker 选中项下标，-1 表示还没选 */
    collegeIndex: -1,
    /** 性别候选：值与文案一一对应，picker 只认下标 */
    genderOptions: ALL_GENDERS.map((value) => ({ value, label: GENDER_LABEL[value] })),
    /** 性别 picker 选中项下标，-1 表示还没选 */
    genderIndex: -1,
    /** 性别在输入框里的展示文案 */
    genderText: '',
    /** 各字段的错误提示 */
    errors: {},
    /** 整体错误提示（登录失败等） */
    errorText: '',
    /** 提交中，防止连点重复提交 */
    submitting: false,
    /** 已登录时展示的账号信息 */
    existing: { loggedIn: false },
    /** 提交成功后展示的待审核信息 */
    pending: null,
    isMock,
  },

  /**
   * 进入页面时读取全局登录态。已登录就显示账号卡片，
   * 免得用户点进登录页又不知道该干什么。
   */
  onLoad() {
    const user = this.currentUser();
    this.setData({ existing: this.describe(user) });
  },

  /** 从全局登录态里取出当前会员 */
  currentUser() {
    const app = getApp();
    return app && app.globalData ? app.globalData.userInfo : null;
  },

  /** 把会员记录揉成界面要的字段 */
  describe(user) {
    const state = resolveAuthState(user);
    return {
      ...state,
      nickName: user ? user.nickName || '' : '',
      avatarUrl: user ? user.avatarUrl || '' : '',
      avatarText: user ? (user.nickName || '会').slice(0, 1) : '',
    };
  },

  /** 写入全局登录态。app.setUserInfo 负责同时落本地缓存 */
  saveSession(user) {
    const app = getApp();
    if (!app) return;
    if (typeof app.setUserInfo === 'function') app.setUserInfo(user);
    else if (app.globalData) app.globalData.userInfo = user;
  },

  /** 回首页。switchTab 在测试环境里可能没有，做个保护 */
  goHome() {
    if (typeof wx !== 'undefined' && typeof wx.switchTab === 'function') {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  /* ---------- 入口步骤 ---------- */

  /** 微信一键登录（已有账号） */
  async onLogin() {
    if (this.data.submitting) return undefined;

    this.setData({ submitting: true, errorText: '' });
    try {
      const { ok, user, state } = await login();
      if (!ok || !user) {
        // 服务端说「这个 OpenID 没有账号」不是故障，是引导——他去注册就行。
        // 报成「请稍后重试」会让人对着一个永远重试不出结果的按钮使劲点，
        // 而这恰恰是换了一台设备（开发者工具与真机 OpenID 不同）后最常见的情形。
        this.setData({
          submitting: false,
          errorText: '这个微信号还没有账号，请点下面的「新会员注册」',
        });
        return undefined;
      }

      this.saveSession(user);
      this.setData({ submitting: false, existing: this.describe(user) });

      // 待审核的账号登进来也没法录成绩，直接停在这一步把话说清楚
      if (state.isPending) {
        this.showPending(user, state);
        return undefined;
      }
      this.goHome();
      return undefined;
    } catch (err) {
      // 走到这里是云函数调用真的抛了（断网、环境 ID 不对），与「没有账号」不同，
      // 所以文案也不一样：这种情况重试是有意义的
      console.error('[login] 登录失败', err);
      this.setData({ submitting: false, errorText: '网络异常，请稍后重试' });
      return undefined;
    }
  },

  /**
   * 退出登录，回到未登录状态。
   * 待审核那一步也能退出，所以必须把 step 一起退回入口——
   * 否则登录态已经清了，界面却还停在「申请已提交」，看着像没退掉。
   */
  onLogout() {
    const app = getApp();
    if (app && typeof app.clearUserInfo === 'function') app.clearUserInfo();
    else if (app && app.globalData) app.globalData.userInfo = null;

    this.setData({ step: 'entry', existing: this.describe(null), errorText: '' });
  },

  /** 跳到注册表单 */
  onGoRegister() {
    this.setData({ step: 'profile', errorText: '' });
  },

  /** 从注册表单退回入口 */
  onBackToEntry() {
    this.setData({ step: 'entry', errors: {}, errorText: '' });
  },

  /* ---------- 表单步骤 ---------- */

  /**
   * 用户主动选择的头像。
   *
   * 选完立刻传云存储，换回一个 fileID。微信给的是会话级的临时文件，
   * 直接存进账号的话，重启小程序或者别人看你的主页就只能看到一张坏图
   * （开发者工具里还会报跨源拦截）。先挂本地路径是为了预览不用等上传。
   */
  async onChooseAvatar(event) {
    const tempPath = (event.detail && event.detail.avatarUrl) || '';
    if (!tempPath) return undefined;

    this.setData({ 'form.avatarUrl': tempPath });

    const uploaded = await uploadAvatar(tempPath);
    // 上传期间用户又选了一张，这次的结果就作废；上传失败（空串）也留着
    // 临时图继续预览，提交时还会再试一次
    if (uploaded && this.data.form.avatarUrl === tempPath) {
      this.setData({ 'form.avatarUrl': uploaded });
    }
    return undefined;
  },

  /** 通用输入处理：按 data-field 写回对应字段，并顺手清掉该字段的旧错误 */
  onInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;

    const patch = { [`form.${field}`]: event.detail.value };
    // 用户已经在改了，还挂着「请填写姓名」会很烦人
    if (this.data.errors[field]) patch[`errors.${field}`] = '';
    this.setData(patch);
  },

  /** 性别选择 */
  onPickGender(event) {
    const index = Number(event.detail.value);
    const option = this.data.genderOptions[index];
    if (!option) return;
    this.setData({
      genderIndex: index,
      genderText: option.label,
      'form.gender': option.value,
      'errors.gender': '',
    });
  },

  /** 学院选择 */
  onPickCollege(event) {
    const index = Number(event.detail.value);
    const college = this.data.colleges[index] || '';
    this.setData({
      collegeIndex: index,
      'form.college': college,
      'errors.college': '',
    });
  },

  /**
   * 提交注册申请。
   * 校验不通过时逐字段标红，并给一条总提示——只标红的话，
   * 用户可能滚到下面看不到是哪个字段出了问题。
   *
   * 校验本身仍是同步的（在 auth.validateProfile 里一次算完），异步的只是
   * 落库这一步——数据源要能被将来换成云函数而不改这里。所以提交期间挂上
   * submitting，既挡住连点，也让按钮显出「提交中」。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;

    this.setData({ submitting: true, errorText: '' });

    // 选头像和点提交之间可能只隔几秒，那次上传未必跑完。这里再确保一次，
    // 免得把一个会话级的临时路径写进账号（已是 fileID 时它原样返回）
    const avatarUrl = await uploadAvatar(this.data.form.avatarUrl);
    // 存回表单，校验失败后再提交一次时就不会重复上传同一个文件
    if (avatarUrl && avatarUrl !== this.data.form.avatarUrl) {
      this.setData({ 'form.avatarUrl': avatarUrl });
    }
    const result = await registerMember({ ...this.data.form, avatarUrl });

    if (!result.ok) {
      this.setData({ submitting: false, errors: result.errors, errorText: result.firstError });
      return undefined;
    }

    const account = result.account;
    // describe 里已经算过登录态，showPending 要的就是那几个字段，不必再解一遍
    const described = this.describe(account);
    this.saveSession(account);
    this.setData({ submitting: false, errors: {}, existing: described });
    this.showPending(account, described);
    return undefined;
  },

  /**
   * 展示提交结果。
   *
   * 【标题为什么不能写死成「申请已提交」】
   * 一个 OpenID 只对应一个账号，所以已经通过审核的会员再提交一次，服务端
   * 会把现有账号原样返回（见 member-handlers 的 registerMember：重试不能
   * 把审批结果冲掉）。这时还说「申请已提交」就是假话——人早就是会员了，
   * 界面却让他在这一屏等着审核。所以标题按实际状态给，按钮文案也跟着变。
   */
  showPending(user, state) {
    const settled = !state.isPending;

    this.setData({
      step: 'pending',
      pending: {
        title: settled ? (state.isActive ? '你已经是会员了' : '账号已被停用') : '申请已提交',
        actionLabel: settled ? '进入首页' : '先随便逛逛',
        statusClass: state.isActive ? 'tag-success' : 'tag-warning',
        nickName: user.nickName || '',
        realName: user.realName || '',
        genderText: GENDER_LABEL[user.gender] || '',
        studentId: user.studentId || '',
        college: user.college || '',
        statusLabel: state.statusLabel,
        notice:
          settled && state.isActive
            ? '这个微信号已经有账号了，不必重复注册，直接进首页就行。'
            : state.notice,
      },
    });
  },

  /** 待审核页上先去看看别的 */
  onGoHome() {
    this.goHome();
  },
});
