/**
 * 演示仓储的惰性加载器
 * ============================================================
 * 【为什么需要它】
 * `school-mock.js` 在**模块加载时**就执行 `reset()`——建种子、组演示内容、
 * 装满整个内存仓储，实测约 400ms（Node 环境；小程序端同量级）。而数据源是
 * cloud 时它一次都用不上。
 *
 * 但三个前端门面（`school-identity.js` / `association-space.js` /
 * `exchange.js`）从前都在文件顶部 `require('./school-mock.js')`，于是**无论
 * 数据源是什么，每次冷启动都先付这 400ms**（2026-10-16 只读审计 H7）。
 *
 * 收敛到这一个加载器：文件顶部不再 require，只在真的走 mock 分支时调
 * `loadSchoolMock()`；同一个模块被 require 多次只会执行一次 reset()，所以
 * 缓存一份实例即可。
 *
 * 【与本次审计的关系】
 * 审计记录 §5.6 曾写成「云端会先加载整套 mock 演示数据」，措辞不准——加载
 * 发生在**客户端**，与数据源是 mock 还是 cloud 无关。这里修的是那笔白开销。
 * ============================================================
 */

let cached = null;

/**
 * 取得演示仓储模块（首次调用才真正加载）。
 * @returns {Object} `services/school-mock.js` 的导出
 */
function loadSchoolMock() {
  if (!cached) cached = require('./school-mock.js');
  return cached;
}

module.exports = { loadSchoolMock };
