/**
 * 比赛流水的分批渲染（2026-10-21）
 * ============================================================
 * 背景：比赛流水一次取最近 100 场（services/match-view.js 的 DEFAULT_LIMIT），
 * 每场还要渲染双方队员名单，100 场就是上千个文本节点。首屏一次铺完，中低端
 * 安卓上会明显卡一下。
 *
 * 这里钉住三件事：
 *   ① 首屏只渲染一屏（RENDER_STEP）；
 *   ② 点「加载更多」只扩大渲染窗口，**不动 view.records**——实时比分回填、
 *      按 id 查记录都依赖全量，动了就是第二处真源；
 *   ③ 窗口放大到全量后，「加载更多」自动收起。
 *
 * 为什么不用页面 onReachBottom：组件挂在 association-home 里，滚动的是页面
 * 不是组件，组件收不到触底。为一个列表改宿主页面的事件转发，改动面比收益大。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { cloneData } = require('./helpers/page-harness.js');

/** 按路径加载组件配置（截获 Component()） */
function loadComponent(relative) {
  let config = null;
  const previous = global.Component;
  global.Component = (def) => { config = def; };
  try {
    const target = require.resolve(path.join(__dirname, '..', 'miniprogram', relative));
    delete require.cache[target];
    require(target);
  } finally {
    global.Component = previous;
  }
  assert.ok(config, `组件没有调用 Component()：${relative}`);
  return config;
}

/** 组件的方法收在 methods 里，测试里平铺到实例上，与小程序行为一致 */
function instantiate(config) {
  const page = { data: cloneData(config.data) };
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.');
      let target = page.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (target[parts[i]] === null || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;
    }
    if (callback) callback();
  };
  for (const [key, value] of Object.entries(config.methods || {})) {
    if (typeof value === 'function') page[key] = value.bind(page);
  }
  return page;
}

/** 造 n 场只有编号的记录，够 form 遍历即可 */
function makeRecords(n) {
  return Array.from({ length: n }, (_, i) => ({ matchId: `m${i}` }));
}

const config = loadComponent('components/match-panel/match-panel.js');

test('比赛流水 —— 首屏只铺一屏，不是一次铺满 100 场', () => {
  const page = instantiate(config);
  assert.equal(page.data.renderLimit, 20, '首屏窗口应为 RENDER_STEP');
  assert.deepEqual(page.data.visibleRecords, [], '没有数据时窗口是空的');
  assert.equal(page.data.visibleHasMore, false);
});

test('比赛流水 —— 点「加载更多」扩大窗口，且不动 view.records', () => {
  const page = instantiate(config);
  const all = makeRecords(45);
  page.data.view = { records: all };
  page.data.visibleRecords = all.slice(0, 20);
  page.data.visibleHasMore = true;

  page.onShowMore();
  assert.equal(page.data.renderLimit, 40);
  assert.equal(page.data.visibleRecords.length, 40);
  assert.equal(page.data.visibleHasMore, true, '还剩 5 条，按钮不该收');

  page.onShowMore();
  assert.equal(page.data.visibleRecords.length, 45);
  assert.equal(page.data.visibleHasMore, false, '全量放完后按钮收起');

  assert.equal(page.data.view.records.length, 45, 'view.records 必须保持全量：实时比分与按 id 查找都靠它');
  assert.equal(page.data.view.records, all, '不能换成新数组，否则外部持有的引用会失效');
});

test('比赛流水 —— 不足一屏时不出现「加载更多」', () => {
  const page = instantiate(config);
  const all = makeRecords(8);
  page.data.view = { records: all };
  page.data.visibleRecords = all.slice(0, 20);
  page.data.visibleHasMore = all.length > 20;

  assert.equal(page.data.visibleHasMore, false);
  page.onShowMore();
  assert.equal(page.data.visibleRecords.length, 8, '再点也只是把已有的 8 条放出来');
  assert.equal(page.data.visibleHasMore, false);
});
