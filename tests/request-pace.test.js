/**
 * 客户端读请求节流（2026-10-23 第三轮审查 X-2）
 * ============================================================
 * 服务端读限流是每账号 8 次/秒，而首页一次加载要约 15 个读请求。
 * 超出的部分被拒后，页面各自 catch 成「该协会没有内容」——首屏静默缺数据。
 * 这里把「被拒」换成「排队到下一个窗口」，并用假时钟验证：
 *   · 前 6 个立即放行；
 *   · 第 7 个开始等一个窗口，之后重新计数；
 *   · 15 个请求只等 2 次（6 + 6 + 3），不会每来一个就等一次。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPacer, DEFAULT_MAX, DEFAULT_WINDOW_MS } = require('../miniprogram/services/request-pace');

/** 假时钟 + 假延时：delay 直接把时间推过去，便于断言「谁等了多久」。 */
function fakeClock(start = 1_000) {
  const clock = {
    at: start,
    waits: [],
    now: () => clock.at,
    delay: async (ms) => { clock.waits.push(ms); clock.at += ms; },
  };
  return clock;
}

test('前 6 个请求不排队（阈值之内不该拖慢）', async () => {
  const clock = fakeClock();
  const pacer = createPacer({ now: clock.now, delay: clock.delay });

  for (let i = 0; i < DEFAULT_MAX; i += 1) await pacer.take();
  assert.deepEqual(clock.waits, [], '阈值内排队就是白等');
});

test('第 7 个等到下一个窗口，之后窗口重新计数', async () => {
  const clock = fakeClock();
  const pacer = createPacer({ now: clock.now, delay: clock.delay });

  for (let i = 0; i < DEFAULT_MAX; i += 1) await pacer.take();
  await pacer.take();
  assert.equal(clock.waits.length, 1, '第 7 个必须让位');
  assert.ok(clock.waits[0] > 0 && clock.waits[0] <= DEFAULT_WINDOW_MS,
    `等待时长应为一个窗口内（实际 ${clock.waits[0]}ms）`);

  // 新窗口里又放行满额
  for (let i = 0; i < DEFAULT_MAX - 1; i += 1) await pacer.take();
  assert.equal(clock.waits.length, 1, '新窗口的前 6 个不该再等');
});

test('首页 15 个读请求只让位 2 次，不会每个都等', async () => {
  const clock = fakeClock();
  const pacer = createPacer({ now: clock.now, delay: clock.delay });

  for (let i = 0; i < 15; i += 1) await pacer.take();
  assert.equal(clock.waits.length, 2,
    `15 个请求应分成 6 + 6 + 3 三批（实际让位 ${clock.waits.length} 次）`);
  assert.ok(clock.waits.every(ms => ms > 0 && ms <= DEFAULT_WINDOW_MS));
});

test('并发调用不会同时越过阈值（槽位分配是串行的）', async () => {
  const clock = fakeClock();
  const pacer = createPacer({ now: clock.now, delay: clock.delay });

  await Promise.all(Array.from({ length: 20 }, () => pacer.take()));
  // 20 个请求 = 6 + 6 + 6 + 2，三次让位
  assert.equal(clock.waits.length, 3, '并发也必须有 3 次让位，否则线上会被服务端拒');
});

test('时钟回拨不会把队列卡死', async () => {
  const clock = fakeClock(10_000);
  const pacer = createPacer({ now: clock.now, delay: clock.delay });
  for (let i = 0; i < DEFAULT_MAX; i += 1) await pacer.take();
  clock.at = 0;
  await pacer.take();
  assert.equal(clock.waits.length, 0, '时间倒退应当视为新窗口，而不是一直等');
});

test('默认阈值低于服务端读限流（否则排队没有意义）', () => {
  assert.ok(DEFAULT_MAX < 8, '排队阈值必须低于服务端 8 次/秒，留出并发余量');
});
