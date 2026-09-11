/**
 * 编辑资料
 * ============================================================
 * 只开放昵称与头像两项。真实姓名与学号是注册时核过的实名信息，改不得——
 * 白名单写在 services/profile.js 的 EDITABLE_FIELDS 里，服务端还会再挡一道。
 *
 * 头像选择沿用登录页那套微信官方写法（open-type="chooseAvatar" +
 * bindchooseavatar），选完立刻走 uploadAvatar 落云存储；本地模拟没有云
 * 存储可传，原路径返回即可。校验与组装复用 buildProfilePatch（纯函数），
 * 本文件只负责交互与 setData。
 * ============================================================
 */

const { NICKNAME_MAX, resolveNameDisplay } = require('../../services/profile.js');
const { uploadAvatar } = require('../../services/avatar.js');
const { updateProfile, isMock } = require('../../services/index.js');

Page({
  data: {
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock,

    /** 没有登录态时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /** 昵称长度上限，交给 maxlength 属性 */
    nicknameMax: NICKNAME_MAX,

    /** 可改的两项 */
    form: { nickName: '', avatarUrl: '' },
    /** 没有头像时用昵称首字兜底 */
    avatarText: '',

    /** 只读的实名信息，让用户看得到「改的是谁」 */
    realName: '',
    studentId: '',

    /** 逐字段的错误提示 */
    errors: {},
    /** 整体错误提示 */
    errorText: '',
  },

  onLoad() {
    const user = this.currentUser();
    this.setData({ blockReason: user ? '' : '请先登录后再修改资料' });
    if (user) this.fill(user);
  },

  /** 把当前会员填进表单 */
  fill(user) {
    const display = resolveNameDisplay(user);
    this.setData({
      form: { nickName: display.nickName, avatarUrl: user.avatarUrl || '' },
      avatarText: (display.nickName || '?').slice(0, 1),
      realName: display.realName,
      studentId: user.studentId || '',
    });
  },

  /** 读取全局登录态。app 可能还没初始化好，逐层兜底 */
  currentUser() {
    const app = getApp();
    if (!app) return null;
    if (typeof app.getUserInfo === 'function') return app.getUserInfo();
    return app.globalData ? app.globalData.userInfo : null;
  },

  /** 写入全局登录态。app.setUserInfo 负责同时落本地缓存 */
  saveSession(user) {
    const app = getApp();
    if (!app) return;
    if (typeof app.setUserInfo === 'function') app.setUserInfo(user);
    else if (app.globalData) app.globalData.userInfo = user;
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /* ---------- 表单交互 ---------- */

  onInputNickname(event) {
    this.setData({
      'form.nickName': event.detail.value,
      'errors.nickName': '',
      errorText: '',
    });
  },

  /**
   * 选头像。先拿临时路径顶上预览，再传云存储换回 fileID。
   * 上传期间用户又选了一张，这次的结果就作废；上传失败（空串）也留着
   * 临时图继续预览，提交时还会再试一次。
   */
  async onChooseAvatar(event) {
    const tempPath = (event.detail && event.detail.avatarUrl) || '';
    if (!tempPath) return undefined;

    this.setData({ 'form.avatarUrl': tempPath, errorText: '' });

    const uploaded = await uploadAvatar(tempPath);
    if (uploaded && this.data.form.avatarUrl === tempPath) {
      this.setData({ 'form.avatarUrl': uploaded });
    }
    return undefined;
  },

  /* ---------- 提交 ---------- */

  async onSubmit() {
    if (this.data.submitting || this.data.blockReason) return undefined;

    const user = this.currentUser();
    if (!user) {
      this.showToast('请先登录后再修改资料');
      return undefined;
    }

    this.setData({ submitting: true, errors: {}, errorText: '' });

    // 云端调用是会失败的：网络断了、云函数还没更新（「未知的操作」）……
    // 不接住的话 submitting 会一直停在 true，页面看起来就是「点了没反应」，
    // 连个错都不报。这里统一收口，失败也要把按钮放回来。
    const result = await this.save(user);

    if (!result.ok) {
      this.setData({ submitting: false, errors: result.errors, errorText: result.firstError });
      this.showToast(result.firstError);
      return undefined;
    }

    // 登录态是所有页面的取数来源：不更新它，返回「我的」后新昵称新头像不会出现
    this.saveSession(result.account || user);
    this.setData({ submitting: false });
    this.showToast('已保存', 'success');
    wx.navigateBack();
    return undefined;
  },

  /**
   * 真正落库的一步。异常一律转成与业务失败同形的返回值，
   * 调用方只需看 ok / firstError，不必分两套分支。
   *
   * @param {Object} user 当前登录会员
   * @returns {Promise<{ok:boolean, account:Object|null, errors:Object, firstError:string}>}
   */
  async save(user) {
    try {
      // 已经是 fileID 的话 uploadAvatar 原样返回，不会重复上传
      const avatarUrl = await uploadAvatar(this.data.form.avatarUrl);
      return await updateProfile({ nickName: this.data.form.nickName, avatarUrl }, user._id);
    } catch (err) {
      console.error('[profile-edit] 保存资料失败', err);
      return { ok: false, account: null, errors: {}, firstError: '保存失败，请检查网络后重试' };
    }
  },

  onCancel() {
    wx.navigateBack();
  },
});
