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

test('cloud 数据源下走云端协议 2，而不是偷偷用本地演示数据', async () => {
  // 2026-10-16：邀请赛已接入云函数（协议 2 注册了全部动作），页面不再要求「仅本地模拟」。
  // 这条用例守的是「云模式必须真的走云」：wx.cloud 没初始化时如实报错，
  // 而不是回落到本地仓储把演示数据当真实数据展示。
  facade.setDataSource('cloud');
  const p = page();
  await p.onLoad();
  assert.match(p.data.error, /云开发尚未初始化/);
  assert.equal(p.data.canCreate, false);
  assert.deepEqual(p.data.events, []);
  facade.setDataSource('mock');
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

/* ============================================================
 * S4 剩余能力（2026-10-16）：签到 / 退赛移除 / 邀请撤回 / 取消赛事 / 比分撤销
 * ============================================================ */

test('页面：撤回邀请（受邀校自己那条）', async () => {
  mock.setDemoActor('demo_muc_admin');
  const p = page();
  await p.onLoad();
  await p.onCreate();
  const id = p.data.detail.event._id;

  // 切到北航管理员：页面给出的可撤回标记只落在「不是主办校 + 还没人报名」的那一条
  await p.onSchoolChange(select(1));
  await p.onActorChange(select(2));
  await p.onOpen({ currentTarget: { dataset: { id } } });
  const schools = p.data.detail.schools;
  assert.equal(schools.find(row => row.id === 'muc').canWithdraw, false, '主办校自己不能撤回');
  assert.equal(schools.find(row => row.id === 'buaa').canWithdraw, true);

  await p.onWithdrawInvitation({ currentTarget: { dataset: { schoolid: 'buaa' } } });
  assert.equal(p.data.error, '');
  assert.equal(p.data.detail.event.invitations.buaa, 'withdrawn');
  assert.equal(p.data.detail.schools.find(row => row.id === 'buaa').status, '已撤回');
});

test('页面：代签 / 移出报名 / 锁定 / 抽签 / 撤销比分 / 取消赛事', async () => {
  mock.setDemoActor('demo_muc_admin');
  const p = page();
  await p.onLoad();
  await p.onCreate();
  const id = p.data.detail.event._id;

  // 北航接受邀请，两校各报一人，再让北航管理员也报一个（用来验证「移出」）
  await p.onSchoolChange(select(1));
  await p.onActorChange(select(2));
  await p.onOpen({ currentTarget: { dataset: { id } } });
  await p.onRespond({ currentTarget: { dataset: { decision: 'accepted' } } });
  await p.onActorChange(select(4)); // 北航会员
  await p.onSignup();
  await p.onActorChange(select(2)); // 北航管理员
  await p.onSignup();
  await p.onSchoolChange(select(0));
  await p.onActorChange(select(3)); // 民大会员
  await p.onOpen({ currentTarget: { dataset: { id } } });
  await p.onSignup();
  assert.equal(p.data.detail.participants.length, 3);

  // 移出北航管理员那一条（北航管理员自己操作），名额释放
  await p.onSchoolChange(select(1));
  await p.onActorChange(select(2));
  await p.onOpen({ currentTarget: { dataset: { id } } });
  const target = p.data.detail.participants.find(row => row.userId === 'demo_buaa_admin');
  assert.equal(target.canRemove, true);
  await p.onRemoveSignup({ currentTarget: { dataset: { userid: 'demo_buaa_admin' } } });
  assert.equal(p.data.error, '');
  assert.equal(p.data.detail.participants.length, 2);

  // 主办校锁定名单
  await p.onSchoolChange(select(0));
  await p.onActorChange(select(1));
  await p.onOpen({ currentTarget: { dataset: { id } } });
  await p.onLock();
  assert.equal(p.data.detail.statusText, '名单已锁定');

  // 代签：民大管理员替本校参赛者签到；此时没有「移出」入口（名单已锁）
  const mucRow = p.data.detail.participants.find(row => row.representedSchoolId === 'muc');
  assert.equal(mucRow.canCheckIn, true);
  assert.equal(mucRow.canRemove, false, '锁定后不能再移出报名');
  await p.onCheckIn({ currentTarget: { dataset: { userid: mucRow.userId } } });
  assert.equal(p.data.error, '');
  assert.equal(p.data.detail.participants.find(row => row.userId === mucRow.userId).checkedIn, true);

  // 抽签 → 录分 → 撤销比分 → 重录 → 取消赛事
  await p.onDraw();
  assert.equal(p.data.detail.matches.length, 1);
  const match = p.data.detail.matches[0];
  await p.onScoreInput({ currentTarget: { dataset: { matchid: match._id, side: 'a' } }, detail: { value: '11' } });
  await p.onScoreInput({ currentTarget: { dataset: { matchid: match._id, side: 'b' } }, detail: { value: '6' } });
  await p.onSubmitScore({ currentTarget: { dataset: { matchid: match._id } } });
  assert.equal(p.data.detail.matches[0].statusText, '已确认');

  assert.equal(p.data.detail.matches[0].canRevoke, true);
  await p.onRevokeScore({ currentTarget: { dataset: { matchid: match._id } } });
  assert.equal(p.data.error, '');
  assert.equal(p.data.detail.matches[0].statusText, '待比赛', '撤销后回到待确认');

  await p.onScoreInput({ currentTarget: { dataset: { matchid: match._id, side: 'a' } }, detail: { value: '11' } });
  await p.onScoreInput({ currentTarget: { dataset: { matchid: match._id, side: 'b' } }, detail: { value: '9' } });
  await p.onSubmitScore({ currentTarget: { dataset: { matchid: match._id } } });
  assert.equal(p.data.error, '');
  assert.equal(p.data.detail.canConfirmRanking, true);
  await p.onCancelEvent();
  assert.equal(p.data.error, '');
  assert.equal(p.data.detail.statusText, '已取消');
  assert.equal(p.data.detail.canDraw, false, '取消后不再给抽签入口');
});
