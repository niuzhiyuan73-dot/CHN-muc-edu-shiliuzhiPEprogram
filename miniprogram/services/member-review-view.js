/**
 * 会员审核页的视图模型
 * ============================================================
 * 与 match-view.js 同一套路数：把权限算在视图模型里，页面拿到的每一行
 * 都自带 canApprove / canReject，页面只负责照着渲染按钮。
 *
 * 【防泄漏闸门】
 * 没有审核权时，这里直接返回 rows: [] 与一句 blockedText，一行申请都不
 * 下发。理由和 loadMatchView 拒绝让 mock 替访客回答「u06」是同一条：
 * 把数据拦在数据层，比指望每个页面都记得判断可靠得多——页面可以改，
 * 而漏判一次就是把全体申请人的姓名、学号、手机号摆在访客面前。
 *
 * 【登录态为什么由调用方传进来，而且不给兜底】
 * mock 的 getCurrentUser() 永远答 u06。若这里自己去问，一个没登录的访客
 * 也会被当成 u06，凭空拿到审核权限。所以登录态由页面明确传入——
 * 传 null 是访客，干脆不传也按访客处理（失败关闭）。
 * loadMatchView 在不传时会回退到数据源的当前用户，那是为了方便「看谁的
 * 比赛」这类公开查询；审核页没有这种用法，漏传一个参数不该换来权限。
 *
 * 【演示口径怎么标出来的】
 * 逐层比对「放宽后的权限」与「严格口径的权限」，两者不一致才置
 * demoNotice。这样文案的触发条件是算出来的，不是页面猜的。
 * ============================================================
 */

const { USER_STATUS, ROLE_LABEL } = require('../utils/constants.js');
const { canReview, buildApplicationRow } = require('./member-review.js');
const { getMemberApplications, isMock } = require('./index.js');

/** 页面上的两个标签页 */
const REVIEW_TAB = {
  PENDING: 'pending', // 待审核：等着被处理的
  HANDLED: 'handled', // 已处理：驳回过的（通过的那些已经是会员，见下方说明）
};

const TAB_LABEL = {
  [REVIEW_TAB.PENDING]: '待审核',
  [REVIEW_TAB.HANDLED]: '已处理',
};

/** 空态文案按标签页区分。「没有待审的」和「一条都没处理过」是两回事 */
const TAB_EMPTY = {
  [REVIEW_TAB.PENDING]: '没有待审核的入会申请',
  [REVIEW_TAB.HANDLED]: '还没有驳回过的申请',
};

/** 兜底的空视图。没有权限时下发它——一行数据都不带 */
function emptyView() {
  return { tabs: [], rows: [], pendingCount: 0, handledCount: 0, emptyText: '', demoNotice: '' };
}

/**
 * 按标签页筛选申请。
 *
 * 【「已处理」里为什么只有驳回的】
 * 通过审核的人已经是正式会员，下一次 load 时会离开申请台账、进入会员
 * 名单（见 mock.buildCache）。所以这里能列出来的只有驳回过的那些。
 * 想看通过后的人，去会员名单里看——他们本来就在那儿。
 */
function filterApplications(applications, tab) {
  const list = Array.isArray(applications) ? applications : [];
  if (tab === REVIEW_TAB.HANDLED) {
    return list.filter((item) => item.status === USER_STATUS.DISABLED);
  }
  return list.filter((item) => item.status === USER_STATUS.PENDING);
}

/** 新提交的排前面。时间解析不出来时退回 0，不让 NaN 把排序搅乱 */
function appliedTimeOf(application) {
  const time = new Date(application.joinDate).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * 装载会员审核页。
 *
 * @param {Object} [options]
 * @param {string} [options.tab] 当前标签页，非法值退回「待审核」
 * @param {Object|null} [options.user] 当前登录会员；传 null 或不传都算访客
 * @returns {Promise<Object>}
 */
async function loadMemberReviewView(options = {}) {
  const { tab = REVIEW_TAB.PENDING, user = null } = options;
  const viewerId = user ? user._id : null;

  const relaxed = canReview(user, { isMock: true });
  const strict = canReview(user, { isMock: false });
  const allowed = canReview(user, { isMock });

  const activeTab = TAB_LABEL[tab] ? tab : REVIEW_TAB.PENDING;
  const viewer = {
    userId: viewerId,
    roleLabel: user ? ROLE_LABEL[user.role] || '' : '',
    loggedIn: Boolean(user),
  };

  // 闸门：没有审核权就到此为止，绝不把申请人的资料发出去
  if (!allowed) {
    return {
      allowed: false,
      blockedText: user
        ? '当前账号没有审核入会申请的权限，请联系管理员'
        : '请先登录后再审核入会申请',
      viewer,
      activeTab,
      ...emptyView(),
    };
  }

  const all = await getMemberApplications();
  const pending = filterApplications(all, REVIEW_TAB.PENDING);
  const handled = filterApplications(all, REVIEW_TAB.HANDLED);
  const current = filterApplications(all, activeTab).sort(
    (a, b) => appliedTimeOf(b) - appliedTimeOf(a)
  );

  return {
    allowed: true,
    blockedText: '',
    viewer,
    tabs: Object.values(REVIEW_TAB).map((key) => ({
      tab: key,
      label: TAB_LABEL[key],
      // 数字挂在标签上，不用点进去才知道有没有事要做
      count: key === REVIEW_TAB.PENDING ? pending.length : handled.length,
      active: key === activeTab,
    })),
    activeTab,
    rows: current.map((application) => buildApplicationRow(application, { actor: user, isMock })),
    pendingCount: pending.length,
    handledCount: handled.length,
    emptyText: TAB_EMPTY[activeTab],
    demoNotice:
      relaxed && !strict
        ? '当前为演示数据源：任何已登录会员都可以审核入会申请，正式环境需由干事或管理员操作'
        : '',
  };
}

module.exports = {
  REVIEW_TAB,
  TAB_LABEL,
  TAB_EMPTY,
  filterApplications,
  loadMemberReviewView,
};
