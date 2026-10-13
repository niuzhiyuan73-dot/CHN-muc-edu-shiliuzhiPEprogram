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
