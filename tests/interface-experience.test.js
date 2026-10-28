const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { instantiate, loadPage, withWx, withApi } = require('./helpers/page-harness');
const { pageFileOf } = require('./helpers/page-registry');
const { eventProgress, reportDifferences, displayValue } = require('../miniprogram/utils/interface-view');
const { detailExperience, withDetailExperience } = require('../miniprogram/templates/detail-experience');
const { withFormExperience, formRows } = require('../miniprogram/templates/form-experience');
const { withScoreDraftExperience } = require('../miniprogram/templates/score-draft-experience');
const { withNoticeExpansion } = require('../miniprogram/templates/notice-experience');
const tap = dataset => ({ currentTarget: { dataset } });
const input = value => ({ detail: { value } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function selector() {
  const before = global.Component; let config;
  global.Component = value => { config = value; };
  const file = require.resolve('../miniprogram/components/member-selector/member-selector');
  delete require.cache[file]; require(file); global.Component = before;
  const component = instantiate({ data: config.data, ...config.methods });
  component.properties = { active: false, scope: { schoolId: 'muc', association: 'pkb' }, collegeId: 'c02', selected: [] };
  component.triggerEvent = (name, detail) => { component.emitted = { name, detail }; };
  component.observe = config.observers['active, scope, collegeId'].bind(component);
  component.detach = config.lifetimes.detached.bind(component);
  return component;
}

test('赛事阶段按真实状态推进，未知/取消状态不猜测当前阶段', () => {
  assert.equal(eventProgress('personal', { status: 0, drawn: true }).find(row => row.current).position, 1);
  assert.equal(eventProgress('college', { status: 2 }).find(row => row.current).position, 2);
  assert.equal(eventProgress('meet', { status: 'running' }).find(row => row.current).position, 3);
  assert.equal(eventProgress('team', { status: 'finished' }).find(row => row.current).position, 4);
  assert.ok(eventProgress('team', { status: 'canceled' }).every(row => !row.current && !row.done));
});
test('详情主行动消费 can*，失败和读取中清除可执行动作', () => {
  const data = { view: { event: { status: 0, canSignUp: true } } };
  assert.equal(detailExperience('personal', data).action, 'onSignUp');
  assert.equal(detailExperience('personal', { ...data, error: '撤权' }).action, '');
  assert.equal(detailExperience('personal', { ...data, loading: true }).action, '');
  assert.equal(detailExperience('personal', { view: { event: { status: 0 } } }).action, '');
  assert.equal(detailExperience('meet', { meet: { isDraft: true, status: 'draft' } }).action, '');
});
test('详情卸载后迟到读取不更新骨架，忙碌时主行动不执行', async () => {
  let called = 0; const wait = deferred();
  const page = instantiate(withDetailExperience({ data: { busy: false, view: { event: { canSignUp: true } } },
    async refresh() { await wait.promise; }, onSignUp() { called++; } }, 'personal'));
  const loading = page.refresh(); page.onUnload(); wait.resolve(); await loading;
  assert.deepEqual(page.data.experience.steps, []);
  page.data.experience.action = 'onSignUp'; page.onExperienceAction(); assert.equal(called, 0);
});
test('表单复核要求同一份输入，编辑后不能沿用旧复核直接提交', async () => withWx(async () => {
  let calls = 0;
  const page = instantiate(withFormExperience({ data: { form: { title: '春季赛' }, errors: {} }, onSubmit() { calls++; },
    onInputTitle(event) { this.setData({ 'form.title': event.detail.value }); } }));
  page.onConfirmFormReview(); assert.equal(calls, 0); assert.equal(page.data.formReview.rows[0].value, '春季赛');
  page.onInputTitle(input('秋季赛')); assert.equal(page.data.formReview, null);
  page.onPrepareFormReview(); page.data.form.title = '冬季赛'; await page.onConfirmFormReview(); assert.equal(calls, 0);
  await page.onConfirmFormReview(); assert.equal(calls, 1);
}));
test('表单错误展开分区并提供字段摘要；网络错误释放提交锁', async () => withWx(async () => {
  const page = instantiate(withFormExperience({ data: { form: {}, errors: {}, formFolds: {} },
    onSubmit() { this.setData({ errors: { quota: '名额超出容量' }, submitting: false }); } }));
  page.onToggleFormGroup(tap({ group: 'group-1' })); assert.equal(page.data.formFolds['group-1'], true);
  await page.onSubmit(); assert.deepEqual(page.data.formFolds, {});
  assert.deepEqual(page.data.formErrorItems, [{ field: 'quota', message: '名额超出容量' }]);
  const failed = instantiate(withFormExperience({ data: { form: {}, submitting: true }, onSubmit() { throw new Error('断网'); } }));
  await failed.onSubmit(); assert.equal(failed.data.submitting, false); assert.equal(failed.data.errorText, '断网');
}));
test('复核用选择器展示文案，并保留学院小项顺序和报名范围', () => {
  assert.equal(formRows({ form: { title: 'constructor' } })[0].value, 'constructor');
  const rows = formRows({ form: { matchType: 3, title: '', legPlan: ['MS', 'XD'] }, matchTypes: ['单打', '双打'], matchTypeIndex: 1,
    audienceIndex: 1, selectedGroupIds: ['g1'], groups: [{ groupId: 'g1', name: '进阶组' }] });
  assert.equal(rows.find(row => row.field === 'matchType').value, '双打');
  assert.equal(rows.find(row => row.field === 'legPlan').value, '男单 → 混双');
  assert.ok(rows.find(row => row.field === 'audience').value.includes('进阶组'));
});
test('选人：关闭时零读取，开启后携带学校与学院，每次仅 20 人', async () => withApi({
  listSchoolMembers: () => ({ ok: true, members: [], hasMore: false }),
}, async calls => {
  const c = selector(); c.observe(); await c.loadPage(false); assert.equal(calls.length, 0);
  c.properties.active = true; await c.loadPage(false);
  assert.deepEqual(calls[0][1], { page: true, collegeId: 'c02', keyword: '', cursor: '', limit: 20 });
  assert.equal(calls.length, 1);
}));
test('选人：搜索、续页保留选择并去重，确认只返回所选会员', async () => withApi({
  listSchoolMembers: payload => ({ ok: true, members: payload.cursor ? [{ userId: 'b', nickName: '乙' }, { userId: 'c', nickName: '丙' }]
    : [{ userId: 'a', nickName: '甲' }, { userId: 'b', nickName: '乙' }], hasMore: !payload.cursor, nextCursor: 'next' }),
}, async () => {
  const c = selector(); c.properties.active = true; await c.loadPage(false);
  c.onToggle(tap({ id: 'a' })); await c.onMore(); assert.equal(c.data.rows.length, 3);
  c.onSearch(input('乙')); clearTimeout(c.searchTimer); await c.loadPage(false);
  assert.equal(c.data.picked[0].userId, 'a'); c.onConfirm(); assert.equal(c.emitted.detail.members[0].nickName, '甲');
}));
test('选人：关层或卸载后在途响应不写回，旧搜索结果不会覆盖新搜索', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  await withApi({ listSchoolMembers: () => ++count === 1 ? first.promise : second.promise }, async () => {
    const c = selector(); c.properties.active = true; const old = c.loadPage(false);
    c.onSearch(input('新')); clearTimeout(c.searchTimer); const current = c.loadPage(false);
    second.resolve({ ok: true, members: [{ userId: 'new', nickName: '新' }] }); await current;
    first.resolve({ ok: true, members: [{ userId: 'old', nickName: '旧' }] }); await old;
    assert.equal(c.data.rows[0].userId, 'new');
  });
  const late = deferred(); await withApi({ listSchoolMembers: () => late.promise }, async () => {
    const c = selector(); c.properties.active = true; const request = c.loadPage(false);
    c.properties.active = false; c.observe(); c.detach(); late.resolve({ ok: true, members: [{ userId: 'late' }] }); await request;
    assert.deepEqual(c.data.rows, []);
  });
});
test('选人续页失败保留当前页，重试继续使用同一游标', async () => {
  let failed = true;
  await withApi({ listSchoolMembers: payload => {
    if (payload.cursor && failed) { failed = false; throw new Error('网络错误'); }
    return { ok: true, members: [{ userId: payload.cursor ? 'b' : 'a' }], hasMore: !payload.cursor, nextCursor: 'after-a' };
  } }, async calls => {
    const c = selector(); c.properties.active = true; await c.loadPage(false); await c.onMore();
    assert.equal(c.data.rows[0].userId, 'a'); assert.equal(c.data.error, '网络错误');
    await c.onRetry(); assert.deepEqual(c.data.rows.map(row => row.userId), ['a', 'b']);
    assert.equal(calls[1][1].cursor, calls[2][1].cursor);
  });
});
test('足球差异：未知与零分开，数字输入与已保存数字相同不报变化', () => {
  assert.equal(displayValue('__proto__'), '__proto__');
  assert.equal(displayValue(null), '未统计'); assert.equal(displayValue(0), '0');
  const before = { result: { regulationScore: { A: 0, B: 1 } }, sides: { A: { players: [{ userId: 'u1', goals: null }] } } };
  const after = { result: { regulationScore: { A: '0', B: '1' } }, sides: { A: { players: [{ userId: 'u1', goals: 0 }] } } };
  const diff = reportDifferences(before, after, { u1: '阿明' });
  assert.equal(diff.total, 1); assert.equal(diff.rows[0].label, 'A队 · 阿明 · 进球');
});
test('足球差异按球员编号比较，调整名单顺序不误报，纪律统计变化会列出', () => {
  const first = { sides: { A: { players: [{ userId: 'a', directRed: 0 }, { userId: 'b', goals: 1 }] } } };
  const same = { sides: { A: { players: first.sides.A.players.slice().reverse() } } };
  assert.equal(reportDifferences(first, same).total, 0);
  same.sides.A.players = [{ userId: 'b', goals: 1 }, { userId: 'a', directRed: 1 }];
  assert.equal(reportDifferences(first, same).rows[0].label, 'A队 · a · 直接红牌');
});
test('运动会未提交输入：取消切场次保留数据，不请求新场次', async () => {
  let calls = 0; const prior = global.wx;
  global.wx = { showModal: opts => opts.success({ confirm: false }), enableAlertBeforeUnload() {} };
  try {
    const p = instantiate(withScoreDraftExperience({ data: { activeSessionKey: 's1', scoringJudgeId: 'j1',
      scoreItems: [{ entryKey: 'e1', myScore: null }], drafts: {} }, update(data) { this.setData(data); },
      async openSession() { calls++; }, onOpenEvent() { calls++; } }));
    p.update({ drafts: { e1: '12.30' } }); assert.equal(p.data.scoreDirty, true);
    await p.openSession('s2', 'j1'); await p.onOpenEvent(tap({ eventKey: 'e2' }));
    assert.equal(calls, 0); assert.equal(p.data.drafts.e1, '12.30');
    p.update({ scoreItems: [{ entryKey: 'e1', myScore: { text: '12.30', state: 'submitted' } }] });
    assert.equal(p.data.scoreDirty, false); await p.openSession('s2', 'j1'); assert.equal(calls, 1);
  } finally { global.wx = prior; }
});
test('计分台界面入口：等待判球期间不重复计分、撤分或定稿', () => {
  const p = instantiate(loadPage('live-score')); let calls = 0;
  p.pending = 1; p.onScore = () => { calls++; }; p.actor = 'a'; p.data.canUndo = true; p.data.canFinish = true;
  p.onScoreTap(tap({ side: 'A' })); p.onUndo(); p.onFinish(); assert.equal(calls, 0);
  p.pending = 0; p.onScoreTap(tap({ side: 'A' })); assert.equal(calls, 1);
});
test('首页缓存随账号和学校隔离，旧作用域快照不展示', () => {
  const p = instantiate(loadPage('index')); const priorWx = global.wx; const priorApp = global.getApp;
  const session = require('../miniprogram/services/school-session'); const oldSchool = session.getSchoolId();
  let user = { _id: 'a' }; let cached;
  global.getApp = () => ({ getUserInfo: () => user }); global.wx = { getStorageSync: () => cached, setStorageSync: (_k, value) => { cached = value; } };
  try {
    session.setSchoolId('muc'); p.saveCache({ title: '本校' }); user = { _id: 'b' }; p.paintFromCache(); assert.deepEqual(p.data.view, {});
    user = { _id: 'a' }; session.setSchoolId('buaa'); p.paintFromCache(); assert.deepEqual(p.data.view, {});
    session.setSchoolId('muc'); p.paintFromCache(); assert.equal(p.data.view.title, '本校');
  } finally { global.wx = priorWx; global.getApp = priorApp; if (oldSchool) session.setSchoolId(oldSchool); }
});
test('新表单模板复核按钮、折叠和错误定位绑定正确，折叠保留输入节点', () => {
  for (const name of ['event-edit', 'college-event-edit', 'announcement-edit']) {
    const text = readFileSync(pageFileOf(name, '.wxml'), 'utf8');
    assert.match(text, /bindtap="onPrepareFormReview"/); assert.match(text, /hidden="\{\{formFolds/);
    assert.match(text, /is="form-review"/); assert.match(text, /id="form-title"/);
  }
});
test('公告从首页进入后仅展开目标记录；未装载的编号保留到续页', async () => {
  const page = instantiate(withNoticeExpansion({ data: { view: { rows: [] } }, async onLoad() { this.setData({ view: { rows: [{ id: 'first' }] } }); },
    async loadMore() { this.setData({ view: { rows: [{ id: 'first' }, { id: '公告/2' }] } }); } }));
  await page.onLoad({ noticeId: encodeURIComponent('公告/2') }); assert.deepEqual(page.data.expandedNotices, {});
  await page.loadMore(); assert.equal(page.data.expandedNotices['公告/2'], true);
  assert.equal(page.data.expandedNotices.first, undefined);
  page.onToggleNotice(tap({ id: 'private-unloaded' })); assert.equal(page.data.expandedNotices['private-unloaded'], undefined);
});
test('运动会卸载后不再写回草稿状态或重新打开离页提示', () => {
  const page = instantiate(withScoreDraftExperience({ data: { drafts: {}, scoreItems: [] }, update(data) { this.setData(data); },
    onUnload() { this.unloaded = true; }, async openSession() {} }));
  page.onUnload(); let writes = 0; page.setData = () => { writes++; };
  page.update({ drafts: { late: '12.30' }, scoreItems: [{ entryKey: 'late' }] }); assert.equal(writes, 0);
});
test('退出登录使在途个人页读取失效，不恢复旧身份和管理入口', async () => withWx(async () => {
  const identity = require('../miniprogram/services/school-identity');
  const priorApi = identity.forSchoolIdentity, priorApp = global.getApp;
  let user = { _id: 'old', nickName: '旧账号' }; const wait = deferred();
  identity.forSchoolIdentity = () => ({ getSchoolIdentitySession: () => wait.promise });
  global.getApp = () => ({ getUserInfo: () => user, clearUserInfo: () => { user = null; } });
  global.wx.switchTab = () => {};
  try {
    const p = instantiate(loadPage('profile')); const pending = p.refresh(); p.onLogout();
    wait.resolve({ user: { userId: 'old' }, canReview: true, canManageSchool: true }); await pending;
    assert.equal(p.data.view.found, false); assert.equal(p.data.loggedIn, false);
    assert.equal(p.data.reviewEntry.visible, false); assert.equal(p.data.adminEntry.visible, false);
  } finally { identity.forSchoolIdentity = priorApi; global.getApp = priorApp; }
}));
