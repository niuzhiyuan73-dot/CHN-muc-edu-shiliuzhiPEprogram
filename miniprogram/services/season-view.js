/**
 * 赛季管理页的视图模型
 * ============================================================
 * 页面只做渲染与交互，取数与权限判定全在这里——这一层不碰 wx API，
 * 因而权限与文案都能在 Node 里逐条测。
 *
 * 【登录态由页面传进来，不让数据源自己猜】
 * mock 的 getCurrentUser() 永远答 u06。若这里自己去问，一个没登录的访客
 * 也会被当成 u06，凭空拿到重置赛季的权限。所以页面必须把登录态明确传下来，
 * 传 null 就是访客。
 *
 * 【为什么失败关闭】
 * 没有管理员权限时直接返回 allowed:false 与一句 blockedText，赛季数据
 * 一个字段都不下发。与 member-review / announcement-view 同一套路数：
 * 界面拿不到数据，就不可能「不小心」渲染出一个能点的重置按钮。
 *
 * 【为什么文案在这一层拼】
 * 页面上「本赛季尚未重置」这类话要跟策略里的实际参数对上，而参数来自
 * 服务端。若放到 wxml 里靠 wx:if 拼，参数一改两处就对不上，且 Node 测不了。
 * ============================================================
 */

const { applySeasonalReset } = require('../utils/elo.js');
const { formatDateTime } = require('../utils/format.js');
const { canResetSeason, DEFAULT_RESET_POLICY } = require('./season.js');
const { getSeasonState } = require('./index.js');

/**
 * 把重置策略写成人话，并给出两个具体例子。
 *
 * 例子由策略本身算出来（而不是写死），这样将来调了保留系数，页面上
 * 的说明会跟着变，不会出现「文案说打七五折、实际按五折」这种自相矛盾。
 *
 * @param {Object} policy {retentionFactor, anchorRating}
 * @returns {string}
 */
function describePolicy(policy) {
  const source = policy || DEFAULT_RESET_POLICY;
  const retention = Number(source.retentionFactor);
  const anchor = Number(source.anchorRating);

  if (!Number.isFinite(retention) || !Number.isFinite(anchor)) {
    return '重置后按俱乐部统一规则压分';
  }

  const keepPercent = Math.round(retention * 100);
  const pullPercent = 100 - keepPercent;
  const sample = (elo) =>
    applySeasonalReset(elo, { anchorRating: anchor, retentionFactor: retention });

  return [
    `重置后分数 = 原分 × ${keepPercent}% + ${anchor} × ${pullPercent}%`,
    `例如 1900 分降到 ${sample(1900)} 分，1200 分升到 ${sample(1200)} 分`,
  ].join('；');
}

/**
 * 装载赛季管理页。
 *
 * @param {Object} [options]
 * @param {Object|null} [options.user] 当前登录会员；传 null 或不传都算访客
 * @param {boolean} [options.isMock=false] 是否演示数据源（放宽为「会员即可」）
 * @returns {Promise<Object>}
 */
async function loadSeasonManageView(options = {}) {
  const { user = null, isMock: mock = false } = options;

  const relaxed = canResetSeason(user, { isMock: true });
  const strict = canResetSeason(user, { isMock: false });
  const allowed = canResetSeason(user, { isMock: mock });

  const viewer = {
    userId: user ? user._id : null,
    loggedIn: Boolean(user),
  };

  // 闸门：没有管理权就到此为止，一个字段都不下发
  if (!allowed) {
    return {
      allowed: false,
      blockedText: user
        ? '当前账号没有管理赛季的权限，请联系管理员'
        : '请先登录后再管理赛季',
      viewer,
      hasReset: false,
      anchorText: '',
      resetText: '',
      versionText: '',
      policyText: '',
      demoNotice: '',
    };
  }

  const state = (await getSeasonState()) || {};
  const hasReset = Boolean(state.resetTime);

  return {
    allowed: true,
    blockedText: '',
    viewer,
    hasReset,
    // 逐层兜底：锚点一般都有，但绝不渲染出 undefined
    anchorText: state.anchorTime ? formatDateTime(state.anchorTime) : '暂无比赛记录',
    resetText: hasReset ? formatDateTime(state.resetTime) : '本赛季尚未重置',
    // 读赛季编号，绝不读 version：version 是写缓存计数器，录一场球就 +1，
    // 拿它当赛季数会让界面上的赛季随日常操作一路虚涨
    versionText: `第 ${Number(state.seasonNumber || 1)} 赛季`,
    policyText: describePolicy(state.policy),
    demoNotice:
      relaxed && !strict
        ? '当前为演示数据源：任何已登录会员都可以执行赛季重置，正式环境需由管理员操作'
        : '',
  };
}

module.exports = {
  describePolicy,
  loadSeasonManageView,
};
