const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const facade = require('../miniprogram/services/index');
const mock = require('../miniprogram/services/school-mock');
function page() {
  let config;
  const old = global.Page;
  global.Page = value => { config = value; };
  const modulePath = require.resolve('../miniprogram/pages/school-exchange/school-exchange');
  delete require.cache[modulePath];
  try { require(modulePath); } finally { global.Page = old; }
  return { ...config, data: JSON.parse(JSON.stringify(config.data)), setData(data) { Object.assign(this.data, data); } };
}
const select = value => ({ detail: { value } });
beforeEach(() => { facade.setDataSource('mock'); mock.reset(); });

test('local page completes invitation, guest acceptance, two-school signup and locking', async () => {
  const p = page();
  await p.onLoad();
  assert.equal(p.data.canCreate, false);
  await p.onActorChange(select(1));
  assert.equal(p.data.canCreate, true);
  await p.onCreate();
  assert.equal(p.data.error, '');
  const id = p.data.detail.event._id;
  assert.equal(p.data.events.length, 1);
  await p.onSchoolChange(select(1));
  await p.onActorChange(select(2));
  await p.onOpen({ currentTarget: { dataset: { id } } });
  assert.equal(p.data.detail.canRespond, true);
  await p.onRespond({ currentTarget: { dataset: { decision: 'accepted' } } });
  await p.onActorChange(select(4));
  await p.onSignup();
  assert.equal(p.data.detail.signed, true);
  await p.onSchoolChange(select(0));
  await p.onActorChange(select(3));
  await p.onOpen({ currentTarget: { dataset: { id } } });
  await p.onSignup();
  assert.equal(p.data.detail.participants.length, 2);
  await p.onActorChange(select(1));
  await p.onLock();
  assert.equal(p.data.detail.statusText, '名单已锁定');
  assert.equal(p.data.detail.canSignup, false);
  assert.equal(p.data.detail.canLock, false);
});

test('page retains create request ID on retry, blocks duplicate writes and resets after error', async () => {
  mock.setDemoActor('demo_muc_admin');
  const p = page();
  await p.onLoad();
  const original = p.api;
  let calls = 0;
  let release;
  p.api = { ...original, createExchangeEvent: async payload => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return original.createExchangeEvent(payload);
  } };
  const pending = p.onCreate();
  await p.onCreate();
  await p.onSchoolChange(select(1));
  assert.equal(p.data.schoolId, 'muc');
  release();
  await pending;
  assert.equal(calls, 1);
  const id = p.data.detail.event._id;
  await p.onCreate();
  assert.equal(p.data.events.length, 1);
  assert.equal(p.data.detail.event._id, id);
  p.api = { createExchangeEvent: async () => { throw new Error('offline'); } };
  await p.onCreate();
  assert.equal(p.data.error, 'offline');
  assert.equal(p.data.busy, false);
});

test('cloud-mode entry is gated rather than silently using demo data', async () => {
  facade.setDataSource('cloud');
  const p = page();
  await p.onLoad();
  assert.match(p.data.error, /仅开放本地模拟/);
  assert.equal(p.data.canCreate, false);
  assert.deepEqual(p.data.events, []);
});

test('B7 身份切换经 app 统一入口：兼容会话随演示身份一起刷新', async () => {
  const identity = require('../miniprogram/services/school-identity');
  const switched = [];
  const priorGetApp = global.getApp;
  global.getApp = () => ({
    switchDemoActor: async (id) => {
      switched.push(id);
      identity.setDemoActor(id);
      return null;
    },
  });
  try {
    const p = page();
    await p.onLoad();
    await p.onActorChange(select(1)); // 民大校管理员

    assert.deepEqual(switched, ['demo_muc_admin'], '切换演示身份应经 app 统一入口（B3 链路）');
    assert.equal(identity.getDemoActor(), 'demo_muc_admin');
    assert.equal(p.data.canCreate, true, '页面按新身份重取能力');
  } finally {
    global.getApp = priorGetApp;
  }
});

test('B7 普通会员不能处理邀请或锁定名单，误触发无副作用', async () => {
  mock.setDemoActor('demo_muc_admin');
  const p = page();
  await p.onLoad();
  await p.onCreate();
  const id = p.data.detail.event._id;

  await p.onActorChange(select(3)); // 民大会员
  await p.onOpen({ currentTarget: { dataset: { id } } });

  assert.equal(p.data.detail.canRespond, false, '会员不能处理邀请');
  assert.equal(p.data.detail.canLock, false, '会员不能锁定名单');

  // 误触发没有副作用：邀请状态原样
  const before = JSON.stringify(p.data.detail.event.invitations);
  await p.onRespond({ currentTarget: { dataset: { decision: 'accepted' } } });
  await p.onLock();
  assert.equal(JSON.stringify(p.data.detail.event.invitations), before, '邀请状态没被改动');
  assert.equal(p.data.detail.statusText, '报名中', '名单仍未锁定');
});
