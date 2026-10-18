/**
 * 详情页成绩弹层
 * ============================================================
 * 原先「已发布成绩」把所有项目平铺在页面底部，一届上百个项目要滚很久。
 * 改成点项目才取该项目的成绩后，这段逻辑有四件容易回归的事，这里各留一条：
 *   1. 只装被点开的那一个项目（不是全届）；
 *   2. 行按名次升序——`getPublishedResults` 不排序，只有列表接口才排；
 *   3. 预赛各组的 `roundLabel` 都叫「预赛」，同名场次要补「第 N 场」，否则弹层里
 *      出现两个一模一样的标题；
 *   4. 连点两个项目时，先发的慢响应不能盖掉后点的那个。
 * 页面用假 client 直接驱动，不依赖演示种子，避免种子一改就红。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const PAGE = '../miniprogram/pages/meet-detail/meet-detail';

function loadPage() {
  const saved = global.Page;
  let config = null;
  global.Page = (value) => { config = value; };
  try {
    delete require.cache[require.resolve(PAGE)];
    require(PAGE);
  } finally {
    global.Page = saved;
  }
  assert.ok(config, 'meet-detail 没有调用 Page()');
  return {
    ...config,
    data: JSON.parse(JSON.stringify(config.data)),
    setData(values) { Object.assign(this.data, values); },
  };
}

const row = (entryKey, rank, points = 0) => ({
  entryKey, collegeId: 'c01', collegeName: '一院', memberText: `选手${entryKey}`,
  rank, value: null, text: `${rank}`, points, status: 'active',
});

function fakeClient(byEvent) {
  const calls = [];
  return {
    calls,
    getPublishedResults: async ({ eventKey }) => {
      calls.push(eventKey);
      return byEvent[eventKey];
    },
    listMeetPublishedResults: async () => ({ items: Object.keys(byEvent).map((eventKey) => ({ eventKey, rounds: [] })) }),
  };
}

const tap = (eventKey) => ({ currentTarget: { dataset: { eventKey } } });

test('点项目只取该项目成绩，行按名次升序', async () => {
  const page = loadPage();
  page.data.isDraft = false;
  page.data.events = [{ eventKey: 'e_100', name: '100 米', group: 'male' }];
  page.client = () => fakeClient({
    e_100: { published: true, rounds: [{ sessionKey: 's1', roundLabel: '决赛', official: true, items: [row('a', 3, 6), row('b', 1, 9), row('c', 2, 7)] }] },
    e_400: { published: true, rounds: [] },
  });

  await page.onOpenEventResult(tap('e_100'));

  assert.equal(page.data.resultPopup.visible, true);
  assert.equal(page.data.resultPopup.title, '100 米 · 男子');
  assert.equal(page.data.resultPopup.loading, false);
  assert.equal(page.data.resultPopup.rounds.length, 1, '弹层只应装被点开的项目');
  assert.deepEqual(page.data.resultPopup.rounds[0].items.map((item) => item.rank), [1, 2, 3]);
});

test('同名场次补序号：两个「预赛」变成第 1 场 / 第 2 场', async () => {
  const page = loadPage();
  page.data.isDraft = false;
  page.data.events = [{ eventKey: 'e_400', name: '400 米', group: 'male' }];
  page.client = () => fakeClient({
    e_400: {
      published: false,
      rounds: [
        { sessionKey: 'h1', roundLabel: '预赛', official: false, items: [row('a', 1)] },
        { sessionKey: 'h2', roundLabel: '预赛', official: false, items: [row('b', 1)] },
      ],
    },
  });

  await page.onOpenEventResult(tap('e_400'));

  assert.deepEqual(
    page.data.resultPopup.rounds.map((round) => round.roundLabel),
    ['预赛（第 1 场）', '预赛（第 2 场）'],
  );
  // 只有预赛发布时也算有成绩可看：空态判定看 rounds，不看 published
  assert.equal(page.data.resultPopup.rounds.length, 2);
});

test('同一项目再次点开命中缓存，不再请求', async () => {
  const page = loadPage();
  page.data.isDraft = false;
  page.data.events = [{ eventKey: 'e_100', name: '100 米', group: 'male' }];
  const client = fakeClient({ e_100: { published: true, rounds: [{ sessionKey: 's1', roundLabel: '决赛', official: true, items: [row('a', 1)] }] } });
  page.client = () => client;

  await page.onOpenEventResult(tap('e_100'));
  await page.onCloseResult();
  assert.equal(page.data.resultPopup.visible, false);
  await page.onOpenEventResult(tap('e_100'));

  assert.deepEqual(client.calls, ['e_100'], '第二次点开应走缓存');
  assert.equal(page.data.resultPopup.rounds.length, 1);
});

test('连点两个项目：先发的慢响应不会盖掉后点的那个', async () => {
  const page = loadPage();
  page.data.isDraft = false;
  page.data.events = [
    { eventKey: 'e_slow', name: '跳远', group: 'male' },
    { eventKey: 'e_fast', name: '800 米', group: 'male' },
  ];
  let releaseSlow = null;
  page.client = () => ({
    getPublishedResults: ({ eventKey }) => {
      if (eventKey === 'e_slow') {
        return new Promise((resolve) => { releaseSlow = () => resolve({ published: true, rounds: [{ sessionKey: 's_slow', roundLabel: '决赛', official: true, items: [row('x', 1)] }] }); });
      }
      return Promise.resolve({ published: true, rounds: [{ sessionKey: 's_fast', roundLabel: '决赛', official: true, items: [row('y', 1)] }] });
    },
  });

  const slow = page.onOpenEventResult(tap('e_slow'));
  await page.onOpenEventResult(tap('e_fast'));
  releaseSlow();
  await slow;

  assert.equal(page.data.resultPopup.eventKey, 'e_fast');
  assert.equal(page.data.resultPopup.title, '800 米 · 男子');
  assert.deepEqual(page.data.resultPopup.rounds.map((round) => round.sessionKey), ['s_fast']);
});

test('已发布索引只给有成绩的项目打标，草稿期点项目不弹层', async () => {
  const page = loadPage();
  page.data.events = [
    { eventKey: 'e_100', name: '100 米', group: 'male' },
    { eventKey: 'e_400', name: '400 米', group: 'male' },
  ];
  page.client = () => fakeClient({ e_100: { published: true, rounds: [] } });

  await page.loadResultIndex();
  assert.deepEqual(page.data.events.map((item) => Boolean(item.hasResult)), [true, false]);

  page.update({ isDraft: true });
  await page.onOpenEventResult(tap('e_400'));
  assert.equal(page.data.resultPopup.visible, false, '草稿期还没有成绩，不该弹出空弹层');
});
