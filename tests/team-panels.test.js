/**
 * 协会工作台的两个团队页签：组队面板 / 团队赛事面板
 * ============================================================
 * 这两个页签以前只是入口卡：切过去看到一句话 + 一个「进入…」按钮，
 * 还要再点一次才见到列表。改成面板后要守三件事：
 *   · 切到页签就能直接看到列表（首屏自己取数，不依赖父页面传参）；
 *   · 人数、状态文案都来自服务端，面板不自己查映射表；
 *   · 点一行进详情、点右上角进列表页——建队 / 建赛仍在完整页面里。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { cloneData, withApi, withWx } = require('./helpers/page-harness.js');

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

const TEAM_ROWS = [
  {
    teamId: 'tm_heat', name: '热浪队', initial: '热', captainName: '巴特尔',
    memberCount: 5, isMine: false, status: 'active', statusLabel: '正常', college: '',
  },
  {
    teamId: 'tm_flash', name: '闪电队', initial: '闪', captainName: '明宇',
    memberCount: 5, isMine: true, status: 'active', statusLabel: '正常', college: '',
  },
];

test('组队面板 —— 首屏直接拉球队，人数与「我的」标记都来自服务端', () => withApi({
  listTeams: () => ({ ok: true, teams: TEAM_ROWS, canManage: false }),
}, async () => {
  const page = instantiate(loadComponent('components/team-panel/team-panel.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.equal(page.data.teams.length, 2, '切到页签就能看到队，不再是一张入口卡');
  assert.equal(page.data.teams[0].memberCount, 5, '人数原样渲染，不再显示 0 人');
  assert.equal(page.data.teams[1].isMine, true);
}));

test('组队面板 —— 点一行进详情，右上角进列表页', () => withApi({
  listTeams: () => ({ ok: true, teams: TEAM_ROWS, canManage: false }),
}, async () => withWx(async ({ navigations }) => {
  const page = instantiate(loadComponent('components/team-panel/team-panel.js'));
  await page.onLoad();

  page.onOpenTeam({ currentTarget: { dataset: { teamid: 'tm_heat' } } });
  assert.match(navigations[0], /team-detail\?teamId=tm_heat/);

  page.onOpenAll();
  assert.equal(navigations[1], '/packageTeam/team-list/team-list', '建队 / 全部球队在列表页');
})));

test('组队面板 —— 取数失败给一句提示，不留白屏', () => withApi({
  listTeams: () => ({ ok: false, message: '球队加载失败：数据库超时' }),
}, async () => {
  const page = instantiate(loadComponent('components/team-panel/team-panel.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.match(page.data.error, /数据库超时/);
  assert.deepEqual(page.data.teams, []);
}));

test('团队赛事面板 —— 首屏直接拉赛事，状态用的是服务端中文文案', () => withApi({
  listTeamEvents: () => ({
    ok: true,
    canManage: true,
    events: [
      {
        eventId: 'tev_1', name: '院际篮球邀请赛', rulesText: '4 节 × 10 分钟', entryCount: 4,
        status: 'finished', statusLabel: '已结束',
      },
      {
        eventId: 'tev_2', name: '新生杯', rulesText: '2 节 × 20 分钟', entryCount: 2,
        status: 'registration', statusLabel: '报名中',
      },
    ],
  }),
}, async () => {
  const page = instantiate(loadComponent('components/team-events-panel/team-events-panel.js'));
  await page.onLoad();

  assert.equal(page.data.events.length, 2);
  // 面板不查映射表：服务端给什么就渲染什么，避免「拿 status 值去查状态表」那类错
  assert.deepEqual(page.data.events.map(row => row.statusLabel), ['已结束', '报名中']);
  assert.equal(page.data.canManage, true);
}));

test('团队赛事面板 —— 点一行进赛事详情，右上角进建赛页', () => withApi({
  listTeamEvents: () => ({
    ok: true,
    canManage: true,
    events: [{ eventId: 'tev_1', name: '院际篮球邀请赛', statusLabel: '已结束', entryCount: 4, rulesText: '' }],
  }),
}, async () => withWx(async ({ navigations }) => {
  const page = instantiate(loadComponent('components/team-events-panel/team-events-panel.js'));
  await page.onLoad();

  page.onOpenEvent({ currentTarget: { dataset: { eventid: 'tev_1' } } });
  assert.match(navigations[0], /team-event-detail\?eventId=tev_1/);

  page.onOpenAll();
  assert.equal(navigations[1], '/packageTeam/team-event-list/team-event-list');
})));
