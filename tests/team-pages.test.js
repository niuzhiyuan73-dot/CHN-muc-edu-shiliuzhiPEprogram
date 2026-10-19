/**
 * 组队两页的装配测试（team-list / team-detail）
 * ============================================================
 * 这两页只做展示与转发：真正的权限与幂等在 team-service 里，已由
 * tests/team-service.test.js 覆盖。这里守的是「界面把动作接到了正确的接口、
 * 拿到了正确的入参、失败时给了人话」——页面拼接错了，服务端再对也没用。
 *
 * 【为什么单开一份工装，而不是并进 page.test.js】
 * page.test.js 用 `registered[N]` 下标取页面配置，新增页面就得同步维护下标，
 * 加一页错一次。这里按**文件路径**加载（loadPage），不依赖注册顺序；
 * page.test.js 的注册方式后续单独重构，不在这批里搅动。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const space = require('../miniprogram/services/association-space.js');
const associationScope = require('../miniprogram/services/association-scope.js');
const schoolSession = require('../miniprogram/services/school-session.js');

/** 深拷贝，避免用例之间串 data */
function cloneData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 按路径加载页面配置：Page() 调用被这次加载截获，与注册顺序无关 */
function loadPage(relative) {
  let config = null;
  const previousPage = global.Page;
  global.Page = (def) => { config = def; };
  try {
    const target = require.resolve(path.join(__dirname, '..', 'miniprogram', 'pages', relative));
    delete require.cache[target];
    require(target);
  } finally {
    global.Page = previousPage;
  }
  assert.ok(config, `页面没有调用 Page()：${relative}`);
  return config;
}

/** 按真机语义实现 setData（支持 'a.b' 路径键）与页面方法绑定 */
function instantiate(config) {
  const page = { data: cloneData(config.data) };
  for (const [key, value] of Object.entries(config)) {
    if (key === 'data') continue;
    page[key] = typeof value === 'function' ? value.bind(page) : value;
  }
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
  return page;
}

/** 用假的 API 顶掉真实门面，并记录每次调用 */
function withApi(methods, run) {
  const original = space.forScope;
  const calls = [];
  space.forScope = () => new Proxy({}, {
    get: (_t, name) => async (payload) => {
      calls.push([String(name), payload]);
      const handler = methods[String(name)];
      if (!handler) throw new Error(`未打桩的接口：${String(name)}`);
      return handler(payload);
    },
  });
  return Promise.resolve(run(calls)).finally(() => { space.forScope = original; });
}

/** 页面的 wx 桩：navigateTo / navigateBack / showModal(默认确认) */
function withWx(run) {
  const previous = global.wx;
  const modals = [];
  global.wx = {
    navigateTo: () => undefined,
    navigateBack: () => undefined,
    showModal: (options) => {
      modals.push(options.title);
      if (options.success) options.success({ confirm: true });
    },
  };
  return Promise.resolve(run(modals)).finally(() => { global.wx = previous; });
}

const TEAM = {
  teamId: 'tm_1', name: '热浪队', initial: '热', sport: 'basketball', college: '',
  status: 'active', statusLabel: '正常', captainId: 'u_cap', captainName: '队长',
  memberCount: 1, isMine: false, isCaptain: false, canManage: false, canApply: true,
  pending: false, membershipStatus: '', membershipLabel: '',
};

/* ============================================================
 * team-list
 * ============================================================ */

test('组队列表 —— 首屏取列表并落到 data，空列表给出提示', () => withApi({
  listTeams: () => ({ ok: true, teams: [], canManage: false }),
}, async (calls) => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.teams, []);
  assert.equal(calls[0][0], 'listTeams');
  assert.equal(calls[0][1].mine, false);
}));

test('组队列表 —— 搜索与「我的球队」都会重新取数，并把条件带上', () => withApi({
  listTeams: (payload) => ({ ok: true, teams: payload.mine ? [TEAM] : [], canManage: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();

  page.onInputKeyword({ detail: { value: '热浪' } });
  await page.onSearch();
  assert.equal(calls.at(-1)[1].keyword, '热浪');

  await page.onToggleMine();
  assert.equal(page.data.mineOnly, true);
  assert.equal(calls.at(-1)[1].mine, true);
  assert.equal(page.data.teams.length, 1);
  assert.equal(page.data.canManage, true);
}));

test('组队列表 —— 建队成功给出待审提示并刷新；失败把原因留在页面上', () => withApi({
  listTeams: () => ({ ok: true, teams: [], canManage: false }),
  createTeamApplication: (payload) => (payload.name === '热浪队'
    ? { ok: true, teamId: 'tm_1' }
    : { ok: false, message: '同协会已有同名球队，请换一个名字' }),
}, async (calls) => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();

  page.onOpenCreate();
  page.onInputName({ detail: { value: '热浪队' } });
  await page.onSubmitCreate();
  assert.equal(page.data.creating, false, '成功后收起表单');
  assert.match(page.data.notice, /等协会负责人审核/);
  const created = calls.find(call => call[0] === 'createTeamApplication');
  assert.equal(created[1].name, '热浪队');
  assert.match(created[1].requestId, /^team_/, '请求编号由页面生成');

  page.onOpenCreate();
  page.onInputName({ detail: { value: '重复队' } });
  await page.onSubmitCreate();
  assert.equal(page.data.noticeError, true);
  assert.match(page.data.notice, /同名/);
}));

test('组队列表 —— 接口抛错时给「请稍后重试」，不把异常抛到页面外', () => withApi({
  listTeams: () => { throw new Error('boom'); },
}, async () => {
  const page = instantiate(loadPage('team-list/team-list.js'));
  await page.onLoad();
  assert.equal(page.data.loading, false);
  assert.match(page.data.error, /稍后重试/);
}));

/* ============================================================
 * team-detail
 * ============================================================ */

test('球队详情 —— 首屏拉到球队与名单；普通成员只看到在队的人', () => withApi({
  getTeam: () => ({
    ok: true,
    team: TEAM,
    members: [{ userId: 'u_cap', name: '队长', role: 'captain', status: 'active', statusLabel: '在队' }],
    pendingCount: 0,
  }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.scope = { schoolId: 'muc', association: 'bk' };
  page.data.teamId = 'tm_1';
  await page.onLoad({ teamId: 'tm_1' });

  assert.equal(page.data.error, '');
  assert.equal(page.data.team.name, '热浪队');
  assert.equal(page.data.members.length, 1);
  assert.equal(calls[0][0], 'getTeam');
  assert.equal(calls[0][1].teamId, 'tm_1');
}));

test('球队详情 —— 申请入队走 applyToJoinTeam，成功提示等队长审批', () => withApi({
  getTeam: () => ({ ok: true, team: { ...TEAM, canApply: false, pending: true }, members: [], pendingCount: 0 }),
  applyToJoinTeam: () => ({ ok: true, status: 'pending' }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';
  await page.onApply();

  assert.equal(calls[0][0], 'applyToJoinTeam');
  assert.equal(calls[0][1].teamId, 'tm_1');
  assert.match(page.data.notice, /等队长审批/);
}));

test('球队详情 —— 队长审批入队：通过带 approve=true，拒绝带 false', () => withApi({
  getTeam: () => ({ ok: true, team: { ...TEAM, canManage: true }, members: [], pendingCount: 1 }),
  reviewTeamMember: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';

  await page.onApprove({ currentTarget: { dataset: { userid: 'u_m1' } } });
  const approved = calls.filter(call => call[0] === 'reviewTeamMember');
  assert.deepEqual(approved[0][1], { teamId: 'tm_1', userId: 'u_m1', approve: true });

  await page.onReject({ currentTarget: { dataset: { userid: 'u_m2' } } });
  const reviewed = calls.filter(call => call[0] === 'reviewTeamMember');
  assert.deepEqual(reviewed[1][1], { teamId: 'tm_1', userId: 'u_m2', approve: false });
}));

test('球队详情 —— 转让队长与归档都要二次确认', () => withWx(async (modals) => withApi({
  getTeam: () => ({ ok: true, team: { ...TEAM, isCaptain: true, canManage: true }, members: [], pendingCount: 0 }),
  transferTeamCaptain: () => ({ ok: true }),
  archiveTeam: () => ({ ok: true }),
}, async (calls) => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';

  await page.onTransfer({ currentTarget: { dataset: { userid: 'u_m1', name: '小李' } } });
  assert.deepEqual(modals, ['转让队长']);
  const transferred = calls.find(call => call[0] === 'transferTeamCaptain');
  assert.deepEqual(transferred[1], { teamId: 'tm_1', userId: 'u_m1' });

  await page.onArchive();
  assert.deepEqual(modals, ['转让队长', '归档球队']);
  assert.ok(calls.some(call => call[0] === 'archiveTeam'));
})));

test('球队详情 —— 业务失败时把服务端原话显示出来，不吞掉', () => withApi({
  getTeam: () => ({ ok: true, team: TEAM, members: [], pendingCount: 0 }),
  leaveTeam: () => ({ ok: false, message: '队长不能直接退队：请先转让队长，或直接归档这支球队' }),
}, async () => {
  const page = instantiate(loadPage('team-detail/team-detail.js'));
  page.data.teamId = 'tm_1';
  await page.onLeave();

  assert.equal(page.data.noticeError, true);
  assert.match(page.data.notice, /转让队长/);
  assert.equal(page.data.busy, false, '失败后要解除防连点');
}));
