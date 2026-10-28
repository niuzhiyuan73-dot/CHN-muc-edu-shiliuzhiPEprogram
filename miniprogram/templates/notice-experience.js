/** 客户端公告展开与定位。 */
function withNoticeExpansion(config) {
  config.data = { ...config.data, expandedNotices: {} };
  const onLoad = config.onLoad;
  config.onLoad = async function (options = {}) {
    if (options.noticeId) {
      try { this.pendingNoticeId = decodeURIComponent(options.noticeId); } catch (_) { this.pendingNoticeId = options.noticeId; }
    }
    await onLoad.call(this, options);
    this.focusRequestedNotice();
  };
  config.focusRequestedNotice = function () {
    if (!this.pendingNoticeId || this.unloaded) return;
    const index = (this.data.view?.rows || []).findIndex(row => row.id === this.pendingNoticeId);
    if (index < 0) return;
    const id = this.pendingNoticeId;
    this.pendingNoticeId = '';
    this.setData({ expandedNotices: { ...this.data.expandedNotices, [id]: true } }, () => {
      const go = () => { if (!this.unloaded && typeof wx !== 'undefined' && typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: `#notice-${index}`, duration: 0 }); };
      if (typeof wx !== 'undefined' && typeof wx.nextTick === 'function') wx.nextTick(go); else go();
    });
  };
  const more = config.loadMore;
  config.loadMore = async function (...args) { const result = await more.apply(this, args); this.focusRequestedNotice(); return result; };
  config.onToggleNotice = function (event) {
    const id = event.currentTarget.dataset.id;
    if (!(this.data.view?.rows || []).some(row => row.id === id)) return;
    this.setData({ expandedNotices: { ...this.data.expandedNotices, [id]: !this.data.expandedNotices[id] } });
  };
  return config;
}
module.exports = { withNoticeExpansion };
