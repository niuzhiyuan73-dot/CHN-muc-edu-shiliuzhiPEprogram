/**
 * 客户端请求节流（2026-10-23 第三轮审查 X-2）
 * ============================================================
 * 【要解决什么】
 * 云端入口限流是「每账号每秒 8 次读」（`src/core/rate-limit.js` 的 `LIMITS`）。
 * 而首页一次加载要发约 15 个读请求：公告 1 + 六个协会 ×（赛事列表 + 比赛列表）
 * + 赛季 + 名录。第 9 个起会被服务端拒绝，页面又各自 `catch` 成「该协会没有
 * 内容」——**首屏不报错，只是静默少几个协会、公告变「暂无」**。
 * 这比直接报错更难发现：用户以为「本来就这些」，下拉刷新可能又好了。
 *
 * 【为什么在客户端排队，而不是等被拒】
 * 被拒的请求没有任何收益：既不省服务端读，也不给用户数据。排队则把「超出的
 * 部分」推迟到下一个窗口，最终全部成功，代价是首屏新鲜数据晚到几百毫秒——
 * 首页本来就先用本地快照画一屏（`index.js` 的 `paintFromCache`），这段延迟
 * 只影响「数字什么时候刷新」，不影响可读性。
 *
 * 【为什么是 6 而不是 8】
 * 留出余量给同一时刻的其它请求：轮询（2 秒一拍）、用户点击、另一个页面的
 * 预取。贴着实测上限排 8 个，任何一次并发都会把整批推回被拒状态。
 *
 * 【只管读】
 * 写动作由用户逐个触发，频率远低于阈值；把它们也塞进队列，会让「点击后没反应」
 * 变成新的体感问题。
 * ============================================================
 */

/** 统计窗口：与服务端一致，固定 1 秒。 */
const DEFAULT_WINDOW_MS = 1000;

/** 每窗口放行数：低于服务端读阈值（8），留出并发余量。 */
const DEFAULT_MAX = 6;

/**
 * 造一个节流器。
 *
 * 【为什么要注入 now / delay】时间相关逻辑必须能在测试里被驱动，否则只能靠
 * 真机等 1 秒，测不出「第 7 个才等」。测试用假时钟直接把窗口推过去。
 *
 * @param {Object} [options]
 * @param {number} [options.windowMs]
 * @param {number} [options.max]
 * @param {Function} [options.now]
 * @param {Function} [options.delay] (ms) => Promise
 * @returns {{take:Function, reset:Function, stats:Function}}
 */
function createPacer(options = {}) {
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_WINDOW_MS;
  const max = Number(options.max) > 0 ? Number(options.max) : DEFAULT_MAX;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const delay = typeof options.delay === 'function'
    ? options.delay
    : ms => new Promise((resolve) => setTimeout(resolve, ms));

  let windowStart = 0;
  let used = 0;
  // 槽位分配必须串行：并发调用若各自算「还剩几个」，会同时判定放行而超发。
  let tail = Promise.resolve();

  /**
   * 占一个发送名额；必要时等到下一个窗口。
   * @returns {Promise<void>}
   */
  function take() {
    const step = tail.then(async () => {
      const at = now();
      // 时钟回拨（`at < windowStart`）也当作新窗口，避免一直等不到
      if (at - windowStart >= windowMs || at < windowStart) {
        windowStart = at;
        used = 0;
      }
      if (used >= max) {
        await delay(Math.max(1, windowMs - (at - windowStart)));
        windowStart = now();
        used = 0;
      }
      used += 1;
    });
    // 队列本身不能因为某一次 take 失败而卡死
    tail = step.then(() => undefined, () => undefined);
    return step;
  }

  function reset() {
    windowStart = 0;
    used = 0;
    tail = Promise.resolve();
  }

  return {
    take,
    reset,
    stats: () => ({ windowStart, used, windowMs, max }),
  };
}

/** 全局单例：所有门面共用一份额度（服务端按账号计，客户端也按账号计）。 */
const pacer = createPacer();

module.exports = { createPacer, pacer, DEFAULT_WINDOW_MS, DEFAULT_MAX };
