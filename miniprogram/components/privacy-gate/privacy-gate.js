/**
 * 隐私授权弹窗
 * ============================================================
 * 用在**调用了隐私接口**的页面上（目前是登录页与编辑资料页的头像按钮）。
 * 用户第一次点「换头像」时，微信会拦下这次调用并通知 app，本组件随之弹出，
 * 用户点「同意」后那次调用才会继续。
 *
 * 【为什么「同意」按钮必须写 open-type="agreePrivacyAuthorization"】
 * 这不是普通按钮。用户的同意必须由微信自己记录，才具备法律与平台效力。
 * 普通的 bindtap 里调什么都不会被认作授权——写了也是白写，接口照样失败。
 *
 * 【为什么还要自己写这个框，不用微信的】
 * 微信只提供拦截，不提供界面。弹窗文案、样式、出现时机都由开发者定，
 * 平台只要求在拿到用户同意前不调用隐私接口。
 *
 * 【为什么挂在页面上而不是 app 里】
 * 小程序没有全局浮层，app 也放不了 WXML。要跨页面复用，只能组件化。
 * 状态不放在组件里，而是放在 services/privacy.js：真正挂起的那次调用
 * 属于 app，不属于某个页面。
 * ============================================================
 */

const privacy = require('../../services/privacy.js');

Component({
  data: {
    /** 是否显示弹窗 */
    show: false,
  },

  lifetimes: {
    attached() {
      // 页面刚进就可能有挂起请求（比如从别的页面跳过来时点了头像）
      this.visible = true;
      this.unsubscribe = privacy.subscribe(() => this.sync());
      this.sync();
    },
    detached() {
      // 必须退订：页面销毁后还留着监听，会在 setData 上抛错
      if (this.unsubscribe) this.unsubscribe();
      this.unsubscribe = null;
    },
  },

  pageLifetimes: {
    /**
     * 用页面可见性兜住一种情况：页面栈里同时有两个带本组件的页面时，
     * 只有当前可见的那个该弹框，否则用户会看到两个叠在一起的遮罩。
     */
    show() {
      this.visible = true;
      this.sync();
    },
    hide() {
      this.visible = false;
      this.sync();
    },
  },

  methods: {
    /** 按「有无挂起请求」+「页面是否可见」决定显隐 */
    sync() {
      const show = Boolean(this.visible && privacy.hasPending());
      if (show !== this.data.show) this.setData({ show });
    },

    /** 用户点了同意。微信那边由 open-type 完成记录，这里只负责结算凭证 */
    onAgree() {
      privacy.settle('agree');
    },

    /** 用户点了不同意：那次调用会被微信判为失败，页面需自行兜住错误 */
    onDisagree() {
      privacy.settle('disagree');
    },

    /** 打开微信官方的隐私保护指引页，不必自己再维护一份纯文本协议 */
    onOpenContract() {
      if (typeof wx === 'undefined' || typeof wx.openPrivacyContract !== 'function') {
        wx.showToast({ title: '当前微信版本不支持查看', icon: 'none' });
        return;
      }
      wx.openPrivacyContract({
        fail: (err) => {
          console.error('[privacy] 打开隐私指引失败', err);
          wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' });
        },
      });
    },

    /** 吞掉遮罩上的滑动，避免底层页面跟着滚 */
    noop() {},
  },
});
