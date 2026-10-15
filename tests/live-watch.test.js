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
 * 用假 getLiveScores 替换门面出口，从而完全掌控每一拍的数据。
 * ============================================================
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const facade = require('../miniprogram/services/index.js');
const { watchLiveScores, POLL_INTERVAL } = require('../miniprogram/services/live-watch.js');

/** 真实出口，测完要还回去 */
const realGetLiveScores = facade.getLiveScores;

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

  /**
   * 换掉门面出口，记录调用次数。
   * 每次换桩都把计数清零——calls 是整段 describe 共用的，不归零就会把
   * 上一个用例的调用累加进来，断言「这一用例只请求了一次」时必然误判。
   */
  function install(fetcher) {
    calls = 0;
    facade.getLiveScores = async () => {
      calls += 1;
      return fetcher();
    };
  }

  function watch(ids, cb) {
    const off = watchLiveScores(ids, cb);
    handles.push(off);
    return off;
  }

  afterEach(() => {
    for (const off of handles) off();
    handles = [];
    facade.getLiveScores = realGetLiveScores;
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
    facade.getLiveScores = async () => {
      calls += 1;
      if (failing) throw new Error('网络异常');
      return [view('m1', 1, 0)];
    };

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

  test('传取数器时改走取数器，不碰旧栈门面', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    // 门面故意留桩：一旦被调到就说明取数器没生效
    let facadeCalls = 0;
    facade.getLiveScores = async () => {
      facadeCalls += 1;
      return [];
    };

    let fetcherCalls = 0;
    const seen = [];
    const off = watchLiveScores(['m1'], (views) => seen.push(views), {
      fetch: async () => {
        fetcherCalls += 1;
        return [view('m1', 3, 0)];
      },
    });
    handles.push(off);

    await flush();
    assert.equal(fetcherCalls, 1, '订阅时立即补一次走的是取数器');
    assert.equal(facadeCalls, 0, '传了取数器就不该再碰旧栈门面');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].pointsA, 3);
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
