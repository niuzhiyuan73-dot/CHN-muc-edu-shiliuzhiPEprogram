/**
 * 隐私授权桥
 * ============================================================
 * 职责：把「系统说该弹隐私授权框了」这件事，从 app 传到页面上的
 * `components/privacy-gate` 组件。
 *
 * 【为什么需要一个中间模块】
 * `wx.onNeedPrivacyAuthorization` 的回调只交给**注册它的那一处**，而弹窗
 * 必须画在**用户当前看得见的那个页面**上。两个东西不在同一条调用链里：
 * 回调在 app.js 的 onLaunch 注册，页面则是各自独立渲染的。中间必须有个
 * 容器把 resolve 存住，等页面上的组件来取——就是这里。
 *
 * 【为什么不直接在 app.js 里画弹窗】
 * 小程序没有全局浮层。app.js 不是页面，放不了 WXML。想在任意页面弹同一
 * 个框，只能每页都挂一个组件，让它们共享同一份状态。
 *
 * 【为什么要存 resolve】
 * `onNeedPrivacyAuthorization` 给的是一个「挂起凭证」：拿到它不等于结束，
 * 必须由开发者在你自己的弹窗里、用户点了「同意」之后亲手 resolve。不存
 * 下来，用户点完同意也没人告诉微信「他同意了」，那次 chooseAvatar 就永远
 * 挂着，表现为点了没反应。
 *
 * 【为什么不自己维护一个 isAgreed 布尔量】
 * 授没授权是微信说了算，会随用户在「···→ 设置」里撤回而变化。本地缓存
 * 一个布尔量必然过期，且撤回后仍会放行。这里只做一次性的凭证转交，判断
 * 全部交给微信（`wx.getPrivacySetting` / 系统拦截）。
 * ============================================================
 */

/** 同意按钮的 id。resolve 时要原样回传，微信据此确认是哪个按钮做的授权。 */
const AGREE_BUTTON_ID = 'privacy-agree-btn';

/**
 * 当前挂起的那一次授权请求。
 * 同一时刻只可能有一次——用户点一次「换头像」才会产生一次。
 * @type {Function|null}
 */
let pendingResolve = null;

/** 订阅者（各页面上的 privacy-gate 组件） */
let listeners = [];

/** 通知所有订阅者重新读一次状态 */
function notify() {
  // 复制一份再遍历：订阅者在回调里退订是正常行为，直接遍历原数组会漏掉人
  listeners.slice().forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[privacy] 通知订阅者失败', err);
    }
  });
}

/**
 * 登记一次待授权的请求。由 app.js 的 onNeedPrivacyAuthorization 调用。
 *
 * @param {Function} resolve 微信给的挂起凭证
 */
function request(resolve) {
  if (typeof resolve !== 'function') return;
  // 上一次没人应答就被新请求顶掉：先把旧的按「拒绝」结掉，
  // 否则那次接口调用会永远悬着，页面上表现为一直 loading。
  if (pendingResolve && pendingResolve !== resolve) settle('disagree');
  pendingResolve = resolve;
  notify();
}

/**
 * 是否还有一次授权没人应答。
 * @returns {boolean}
 */
function hasPending() {
  return Boolean(pendingResolve);
}

/**
 * 用用户的选择结束当前请求。
 *
 * @param {'agree'|'disagree'} event 用户点了同意还是不同意
 */
function settle(event) {
  const resolve = pendingResolve;
  pendingResolve = null;
  if (resolve) {
    try {
      // 同意必须带上按钮 id，否则微信不认这次授权
      resolve(event === 'agree' ? { buttonId: AGREE_BUTTON_ID, event: 'agree' } : { event: 'disagree' });
    } catch (err) {
      console.error('[privacy] 结算授权失败', err);
    }
  }
  notify();
}

/**
 * 订阅状态变化。组件 attached 时订阅，detached 时退订。
 *
 * @param {Function} fn 状态可能变了，请重读
 * @returns {Function} 退订函数
 */
function subscribe(fn) {
  listeners.push(fn);
  return function unsubscribe() {
    listeners = listeners.filter((item) => item !== fn);
  };
}

/**
 * 当前基础库是否支持这套授权机制。
 * 2.32.3 起才有 onNeedPrivacyAuthorization / open-type="agreePrivacyAuthorization"；
 * 更早的版本由平台自己兜底弹窗，页面不必插一手。
 *
 * @returns {boolean}
 */
function isSupported() {
  return typeof wx !== 'undefined' && typeof wx.onNeedPrivacyAuthorization === 'function';
}

module.exports = { AGREE_BUTTON_ID, request, hasPending, settle, subscribe, isSupported };
