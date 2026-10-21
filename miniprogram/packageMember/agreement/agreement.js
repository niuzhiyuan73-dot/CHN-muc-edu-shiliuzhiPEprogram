/**
 * 用户协议
 * ============================================================
 * 静态条款页，无取数、无状态。
 *
 * 【为什么单独做一个页面，而不是跳外链】
 * 用了 `web-view` 就得配业务域名、备案、HTTPS 证书;一张纯文本页可以省掉
 * 这些，离线也打得开。审核与用户查阅要的都只是「能读到条款」，不是技术形式。
 *
 * 【为什么放在 packageMember 而不是主包】
 * 它属于「我的」下的低频页，主包现在 1274 KB（压缩后）虽有余额，但没必要
 * 为一年点不了几次的条款页占主包体积。分包页面跳转不受限制。
 *
 * 【为什么隐私指引不在本页正文里，而是给个入口】
 * 隐私指引的内容由微信后台维护、随授权项变化，正文抄一份必然过期。
 * 一律通过 `wx.openPrivacyContract` 打开官方那一份，永远是最新的。
 * ============================================================
 */

Page({
  data: {
    /** 条款更新日期。改正文时一并改这里 */
    updatedAt: '2026-10-21',
  },

  /** 打开微信官方的隐私保护指引 */
  onOpenPrivacyContract() {
    if (typeof wx === 'undefined' || typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '当前微信版本不支持查看', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({
      fail: (err) => {
        console.error('[agreement] 打开隐私指引失败', err);
        wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' });
      },
    });
  },
});
