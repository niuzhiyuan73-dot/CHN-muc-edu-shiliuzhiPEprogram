/**
 * 实时比分轮询适配器（M7 第四期）
 * ============================================================
 * 适配器是「不频繁刷新」的实现处，也是全仓唯一允许 setInterval 的地方。
 * 这里用假定时器把它钉死：
 *
 *   1. 没有进行中的比赛 ⇒ 零请求、零定时器；
 *   2. 有比赛 ⇒ 每 2 秒一次，订阅时立即补一次；
 *   3. 比分没变 ⇒ 一个字节都不回调；变了才回调；
 *   4. 单拍失败 ⇒ 静默跳过，下一拍照常；
 *   5. pause 停表、resume 立即补一次；取消后旧表不再跑。
 *
 * 【取数器改为必填后，本测试也换了注入方式】
 * 从前是「替换门面出口 `getLiveScores`」；协议 1 门面按 P10 下线后，适配器
 * 不再有缺省取数路径，改为**由调用方注入**（三个页面调用点本就都传了
 * `getSchoolLiveScores`）。所以这里改为注入一个假取数器，与页面的用法一致——
 * 顺带把「不传取数器会怎样」也变成可断言的行为。
 * ============================================================
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { watchLiveScores, POLL_INTERVAL } = require('../miniprogram/services/live-watch.js');

/** 让已 resolve 的 Promise 链跑完（不用被 mock 的 setImmediate） */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 一条最小的实时视图 */
function view(matchId, pointsA, pointsB, extra = {}) {
  return {
    matchId,
    pointsA,
    pointsB,
    gamesA: 0,
    gamesB: 0,
    gameIndex: 0,
    status: 'live',
    finished: false,
    leading: '',
    gamePoints: 11,
    bestOf: 3,
    ...extra,
  };
}

describe('实时比分轮询适配器', () => {
  let handles = [];
  let calls = 0;
  /** 假取数器的实际行为，由各用例通过 install 指定 */
  let impl = async () => [];

  /**
   * 指定这一用例的取数行为，并把调用计数清零。
   * 计数是整段 describe 共用的，不归零就会把上一个用例的调用累加进来，
   * 断言「这一用例只请求了一次」时必然误判。
   */
  function install(fetcher) {
    calls = 0;
    impl = fetcher;
  }

  /** 与页面同样的用法：把取数器交给适配器 */
  function countingFetch(ids) {
    calls += 1;
    return impl(ids);
  }

  function watch(ids, cb) {
    const off = watchLiveScores(ids, cb, { fetch: countingFetch });
    handles.push(off);
    return off;
  }

  afterEach(() => {
    for (const off of handles) off();
    handles = [];
  });

  test('空名单 —— 不启表、不发一次请求', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    install(() => []);
    let updates = 0;

    watch([], () => {
      updates += 1;
    });
    await flush();
    t.mock.timers.tick(POLL_INTERVAL * 5);
    await flush();

    assert.equal(calls, 0, '没有进行中的比赛就该零请求');
    assert.equal(updates, 0);
  });

  test('订阅立即补一次；比分没变不回调，变了才回调', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let data = [view('m1', 1, 0)];
    install(() => data.map((item) => ({ ...item })));

    const seen = [];
    watch(['m1'], (views) => seen.push(views));
    await flush();
    assert.equal(calls, 1, '订阅时立即补一次');
    assert.equal(seen.length, 1);

    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 1, '比分没变时不惊动页面');

    data = [view('m1', 2, 0)];
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 2);
    assert.equal(seen[1][0].pointsA, 2);
  });

  test('单拍失败静默跳过，下一拍照常', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let failing = true;
    install(async () => {
      if (failing) throw new Error('网络异常');
      return [view('m1', 1, 0)];
    });

    const seen = [];
    watch(['m1'], (views) => seen.push(views));
    await flush();
    assert.equal(seen.length, 0, '首发失败既不回调也不冒泡');

    failing = false;
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(seen.length, 1, '下一拍照常取到数据');
  });

  test('pause 停表、resume 立即补一次', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let data = [view('m1', 1, 0)];
    install(() => data.map((item) => ({ ...item })));

    const seen = [];
    const off = watch(['m1'], (views) => seen.push(views));
    await flush();
    assert.equal(calls, 1);

    off.pause();
    t.mock.timers.tick(POLL_INTERVAL * 3);
    await flush();
    assert.equal(calls, 1, '隐藏后不再请求');

    data = [view('m1', 5, 0)];
    off.resume();
    await flush();
    assert.equal(calls, 2, '回到前台立即补一次');
    assert.equal(seen.length, 2);
    assert.equal(seen[1][0].pointsA, 5);
  });

  test('取消订阅后旧表不再跑', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    install(() => [view('m1', 1, 0)]);

    const off = watch(['m1'], () => {});
    await flush();
    assert.equal(calls, 1);

    off();
    t.mock.timers.tick(POLL_INTERVAL * 3);
    await flush();
    assert.equal(calls, 1);
  });

  test('换名单重订阅 —— 同一时刻只有一张表在跑', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    install(() => [view('m1', 1, 0)]);

    let firstCallbacks = 0;
    watch(['m1'], () => {
      firstCallbacks += 1;
    });
    await flush();
    assert.equal(calls, 1);

    // 名单变了：再订阅一次，旧的应先被停掉
    watch(['m2'], () => {});
    await flush();
    assert.equal(calls, 2);

    const before = calls;
    t.mock.timers.tick(POLL_INTERVAL);
    await flush();
    assert.equal(calls, before + 1, '只应有一张表在轮询');
    assert.equal(firstCallbacks, 1, '旧订阅停了就不再回调');
  });
});

/**
 * 取数器必填：这一组守的是「不留悄悄读旧栈门面的缺省路径」。
 * 从前不传就回落到门面的 getLiveScores，那条路径在协议 1 下线后必须消失——
 * 否则页面已改接 S2，适配器却还在读旧台账，两处各说各话且只在真机上看得出来。
 */
describe('实时比分轮询适配器 —— 取数器必填', () => {
  const handles = [];

  afterEach(() => {
    while (handles.length) handles.pop()();
  });

  test('名单非空却不给取数器 —— 订阅当场报错', () => {
    assert.throws(
      () => watchLiveScores(['m1'], () => {}),
      /options\.fetch/,
      '缺省取数路径应当已经不存在'
    );
  });

  test('空名单不传取数器也不报错（本就不启表、不请求）', () => {
    const off = watchLiveScores([], () => {});
    handles.push(off);
    assert.equal(typeof off, 'function', '空名单仍应返回可用的取消句柄');
  });
});
