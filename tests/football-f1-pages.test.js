const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate, withApi, withWx } = require('./helpers/page-harness');
const associationScope = require('../miniprogram/services/association-scope');
const { createFootballEventForm, validateFootballEventForm } = require('../miniprogram/utils/football-event-form');

function football(t) {
  const previous = associationScope.getAssociation();
  associationScope.setAssociation('fb');
  t.after(() => associationScope.setAssociation(previous));
}
const EVENT = { eventId: 'football-page', name: '足球杯', format: 'single_elim', status: 'registration',
  sportFormat: 'football11', supportsMatchData: false, supportsLiveScore: false, canManage: true };

test('F1 足球工作台只提供空间/组队/赛事，旧个人榜单链接回退到空间', t => {
  football(t);
  const page = instantiate(loadPage('association-home/association-home.js'));
  page.onLoad({ association: 'fb', tab: 'rank' });
  assert.equal(page.data.associationId, 'fb');
  assert.equal(page.data.themeClass, 'assoc-fb');
  assert.deepEqual(page.data.tabs.map(tab => tab.tab), ['space', 'teams', 'events']);
  assert.equal(page.data.activeTab, 'space');
});

test('F1 足球列表接独立表单并传递完整请求，成功后刷新列表', t => {
  football(t);
  return withApi({ listTeamEvents: () => ({ ok: true, events: [], canManage: true }), createTeamEvent: () => ({ ok: true }) }, async calls => {
    const page = instantiate(loadPage('team-event-list/team-event-list.js'));
    await page.onLoad(); page.onOpenCreate();
    assert.equal(page.data.isFootball, true);
    await page.onSubmitCreate();
    assert.equal(calls.filter(call => call[0] === 'createTeamEvent').length, 0, '足球不能误发篮球预设');
    const form = { ...createFootballEventForm(), name: '自由组队足球杯', halfMinutes: '35' };
    const payload = { ...validateFootballEventForm(form).payload, requestId: 'fb_page' };
    await page.onFootballSubmit({ detail: payload });
    assert.deepEqual(calls.find(call => call[0] === 'createTeamEvent')[1], payload);
    assert.equal(page.data.creating, false);
    assert.equal(page.data.submitting, false);
    assert.equal(calls.filter(call => call[0] === 'listTeamEvents').length, 2);
  });
});

test('F1 足球建赛提交中不允许关闭或连点，失败保留组件及服务端原因', t => {
  football(t);
  let release;
  return withApi({ listTeamEvents: () => ({ ok: true, events: [], canManage: true }),
    createTeamEvent: () => new Promise(resolve => { release = resolve; }) }, async calls => {
    const page = instantiate(loadPage('team-event-list/team-event-list.js'));
    await page.onLoad(); page.onOpenCreate();
    const pending = page.onFootballSubmit({ detail: { name: '待保存足球杯' } });
    page.onCloseCreate();
    assert.equal(page.data.creating, true);
    await page.onFootballSubmit({ detail: { name: '不应重复提交' } });
    assert.equal(calls.filter(call => call[0] === 'createTeamEvent').length, 1);
    release({ ok: false, message: '规则配置不合法' }); await pending;
    assert.equal(page.data.creating, true); assert.equal(page.data.noticeError, true);
    assert.equal(page.data.notice, '规则配置不合法');
  });
});

test('F1 足球详情显示报名，不调用篮球统计和实时订阅', t => {
  football(t);
  return withApi({ getTeamEvent: () => ({ ok: true, event: EVENT, entries: [], submitCandidates: [], matches: [], table: [], placements: [] }) }, async calls => {
    const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
    await page.onLoad({ eventId: 'football-page' });
    assert.equal(page.data.error, '');
    assert.equal(page.data.isFootball, true); assert.equal(page.data.supportsMatchData, false);
    assert.deepEqual(page.data.playerStats, []);
    assert.deepEqual(calls.map(call => call[0]), ['getTeamEvent']);
    await withWx(({ navigations }) => {
      page.onOpenLiveScore({ currentTarget: { dataset: { matchid: 'x' } } });
      assert.deepEqual(navigations, []);
    });
  });
});

test('F1 足球报名页面选人及号码提交到现有接口，接口失败保留名单', t => {
  football(t);
  return withApi({
    getTeamEntryRoster: () => ({ ok: true, canEdit: true, event: { entryMin: 11, entryMax: 22 }, team: { teamId: 'a', name: '自由队' },
      members: Array.from({ length: 11 }, (_, i) => ({ userId: `f${i}`, name: `球员${i}`, selected: true, no: i + 1 })) }),
    submitTeamEntry: () => ({ ok: false, message: '球员已代表其他球队报名' }),
  }, async calls => {
    const page = instantiate(loadPage('team-event-detail/team-event-detail.js'));
    page.scope = { schoolId: 'muc', association: 'fb' }; page.setData({ eventId: 'football-page' });
    await page.onSubmitEntry({ currentTarget: { dataset: { teamid: 'a' } } });
    assert.equal(page.data.entryEditing.selectedCount, 11);
    await page.onSaveEntry();
    const saved = calls.find(call => call[0] === 'submitTeamEntry')[1];
    assert.equal(saved.roster.length, 11); assert.equal(saved.roster[0].no, '1');
    assert.ok(page.data.entryEditing); assert.match(page.data.notice, /其他球队/);
  });
});

test('F1 我的球队入口对足球打开球队列表，球队详情不加载尚未提供的成绩', t => {
  football(t);
  return withApi({ listTeams: () => ({ ok: true, teams: [], canManage: false }),
    getTeam: () => ({ ok: true, team: { teamId: 'a', name: '自由队', sport: 'football' }, members: [] }) }, async calls => {
    const list = instantiate(loadPage('team-list/team-list.js'));
    await list.onLoad({ mine: '1' });
    assert.equal(calls[0][1].mine, true);
    const detail = instantiate(loadPage('team-detail/team-detail.js'));
    await detail.onLoad({ teamId: 'a' });
    assert.equal(detail.data.recordSupported, false);
    assert.equal(calls.some(call => call[0] === 'getTeamRecord'), false);
    await withWx(({ navigations }) => {
      const profile = instantiate(loadPage('profile/profile.js'));
      profile.currentAssociation = () => 'fb'; profile.syncAssociationBadge(); profile.onGoMyTeamProfile();
      assert.equal(profile.data.hasTeamStats, false);
      assert.match(navigations[0], /team-list\?mine=1/);
    });
  });
});
