/**
 * 入口限流（2026-10-21 审查 P0-3）
 * ============================================================
 * 读接口的门槛只是「在册会员」，而单次读要打 6~8 个集合。没有闸门时一个
 * 账号的 for 循环就能把全校每日读配额打空。这里钉住三件事：
 *   1. 读 / 写分开计，读 8 次/秒、写 3 次/秒 是**天花板**，不能被悄悄放宽；
 *   2. 账号之间互不牵连（一个人刷不能连累别人）；
 *   3. 未知动作按「写」处理——宁可严格，也不能让新动作默认拿宽松额度。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { guardRate, resetRateLimit, LIMITS, ANON_LIMITS, DAILY_LIMITS, ANON_DAILY_LIMITS, kindOf } = require('../cloudfunctions/data/src/core/rate-limit');

/** 固定时间点：0 秒窗口起点，避免用例受真实时钟影响。 */
const T0 = 1_700_000_000_000;
const T1 = T0 + 1000;

test('读动作第 LIMITS.read + 1 次被拒，前 LIMITS.read 次放行', () => {
  resetRateLimit();
  for (let i = 1; i <= LIMITS.read; i += 1) {
    assert.equal(guardRate('openid-a', 'getSchoolRanking', T0), null, `第 ${i} 次应当放行`);
  }
  const blocked = guardRate('openid-a', 'getSchoolRanking', T0);
  assert.ok(blocked, '超过阈值应当被拒');
  assert.equal(blocked.kind, 'read');
  assert.match(blocked.message, /频繁/);
});

test('写动作阈值更严（LIMITS.write）', () => {
  resetRateLimit();
  for (let i = 1; i <= LIMITS.write; i += 1) {
    assert.equal(guardRate('openid-b', 'submitSchoolMatch', T0), null);
  }
  const blocked = guardRate('openid-b', 'submitSchoolMatch', T0);
  assert.ok(blocked);
  assert.equal(blocked.kind, 'write');
});

test('读写分开计：写额度用满不影响读', () => {
  resetRateLimit();
  for (let i = 0; i < LIMITS.write; i += 1) guardRate('openid-c', 'recordSchoolRally', T0);
  assert.ok(guardRate('openid-c', 'recordSchoolRally', T0), '写已超限');
  assert.equal(guardRate('openid-c', 'getSchoolRanking', T0), null, '读不应被写的超限牵连');
});

test('账号之间互不牵连', () => {
  resetRateLimit();
  for (let i = 0; i <= LIMITS.read; i += 1) guardRate('openid-d', 'listSchoolMatches', T0);
  assert.ok(guardRate('openid-d', 'listSchoolMatches', T0));
  assert.equal(guardRate('openid-e', 'listSchoolMatches', T0), null, '别人被限流不该影响我');
});

test('跨过 1 秒窗口后额度复位', () => {
  resetRateLimit();
  for (let i = 0; i <= LIMITS.read; i += 1) guardRate('openid-f', 'getSchoolRanking', T0);
  assert.ok(guardRate('openid-f', 'getSchoolRanking', T0), '同一秒内超限');
  assert.equal(guardRate('openid-f', 'getSchoolRanking', T1), null, '下一秒应重新有额度');
});

test('未登录请求走匿名桶，且额度比登录更严', () => {
  resetRateLimit();
  // 匿名桶是全站共享的一个桶（无法按人区分），所以额度必须压到最低。
  assert.ok(ANON_LIMITS.read < LIMITS.read, '匿名读额度应低于登录用户');
  assert.ok(ANON_LIMITS.write < LIMITS.write, '匿名写额度应低于登录用户');
  for (let i = 0; i < ANON_LIMITS.write; i += 1) guardRate('', 'registerSchoolAccount', T0);
  const blocked = guardRate('', 'registerSchoolAccount', T0);
  assert.ok(blocked, '无 OPENID 也必须有闸门');
  assert.equal(blocked.limit, ANON_LIMITS.write);

  // 已登录用户不受匿名桶影响
  assert.equal(guardRate('openid-anon-edge', 'registerSchoolAccount', T0), null);
});

test('动作分类：get/list/search 为读，其余（含未知）为写', () => {
  assert.equal(kindOf('getSchoolRanking'), 'read');
  assert.equal(kindOf('listSchoolMembers'), 'read');
  assert.equal(kindOf('searchSomething'), 'read');
  assert.equal(kindOf('submitSchoolMatch'), 'write');
  assert.equal(kindOf(''), 'write');
  assert.equal(kindOf(undefined), 'write');
  assert.equal(kindOf('__proto__'), 'write', '未知键按写算，不给宽松额度');
});

test('阈值本身是常量，不会被调用方改写', () => {
  assert.equal(LIMITS.read, 8);
  assert.equal(LIMITS.write, 3);
  assert.equal(ANON_LIMITS.read, 3);
  assert.equal(ANON_LIMITS.write, 1);
  assert.ok(Object.isFrozen(LIMITS));
  assert.ok(Object.isFrozen(ANON_LIMITS));
  assert.ok(Object.isFrozen(DAILY_LIMITS));
  assert.ok(Object.isFrozen(ANON_DAILY_LIMITS));
});

/**
 * 日预算（2026-10-27 第八轮审查 P1-2）
 * ============================================================
 * 秒级阈值压的是「瞬时速率」，压不住「持续低速」：读 8 次/秒 × 每次 6~8 次点读
 * ≈ 每秒 50 次读，5 万次/天十几分钟就见底。这里钉住「按天封顶」，
 * 并钉住两条会误伤正常用户的边界：
 *   1. 轮询接口豁免（看一场比赛 1800 次请求，否则观众被封）；
 *   2. 秒级被拒的请求不消耗日预算（连点不该提前吃掉一天额度）。
 * ============================================================
 */
test('单账号一天最多 DAILY_LIMITS.read 次读，超了就按日拒绝', () => {
  resetRateLimit();
  // 每次间隔一秒，避开秒级桶，只考察日预算。
  for (let i = 0; i < DAILY_LIMITS.read; i += 1) {
    assert.equal(guardRate('openid-day', 'getSchoolRanking', T0 + i * 1000), null, `第 ${i + 1} 次应当放行`);
  }
  const blocked = guardRate('openid-day', 'getSchoolRanking', T0 + DAILY_LIMITS.read * 1000);
  assert.ok(blocked, '超过日预算应当被拒');
  assert.equal(blocked.scope, 'day');
  assert.match(blocked.message, /今日/);
});

test('日预算按账号隔离，别人刷满不影响我', () => {
  resetRateLimit();
  for (let i = 0; i < DAILY_LIMITS.read; i += 1) guardRate('openid-full', 'getSchoolRanking', T0 + i * 1000);
  assert.ok(guardRate('openid-full', 'getSchoolRanking', T0 + DAILY_LIMITS.read * 1000));
  assert.equal(guardRate('openid-fresh', 'getSchoolRanking', T0 + DAILY_LIMITS.read * 1000), null);
});

test('轮询接口不计入日预算，正常观众不会被误封', () => {
  resetRateLimit();
  const rounds = DAILY_LIMITS.read + 10;
  for (let i = 0; i < rounds; i += 1) {
    assert.equal(guardRate('openid-watch', 'getSchoolLiveScores', T0 + i * 1000), null,
      `轮询第 ${i + 1} 次不该被日预算拦下`);
  }
});

test('秒级被拒的请求不消耗日预算', () => {
  resetRateLimit();
  // 同一秒内连打：第 9 次起被秒级拒，那些被拒的不该记进日额度。
  for (let i = 0; i < LIMITS.read + 5; i += 1) guardRate('openid-burst', 'getSchoolRanking', T0);
  // 换一秒继续：仍应放行（若被拒的也计数，这里就会更快触顶，但真正可测的是
  // 「日额度从第 10 次才开始消耗」——用剩余额度反推）。
  for (let i = 1; i <= DAILY_LIMITS.read - LIMITS.read; i += 1) {
    assert.equal(guardRate('openid-burst', 'getSchoolRanking', T0 + i * 1000), null, `第 ${i} 秒应当放行`);
  }
  assert.ok(guardRate('openid-burst', 'getSchoolRanking', T0 + (DAILY_LIMITS.read - LIMITS.read + 1) * 1000),
    '日额度用尽后应被拒，且额度恰为 DAILY_LIMITS.read（被秒级拒的不计数）');
});

test('匿名请求按来源 IP 分桶，单个来源打满不牵连别人', () => {
  resetRateLimit();
  for (let i = 0; i < ANON_LIMITS.read; i += 1) {
    assert.equal(guardRate('', 'getSchoolDirectory', T0, { clientIp: '10.0.0.1' }), null);
  }
  const blocked = guardRate('', 'getSchoolDirectory', T0, { clientIp: '10.0.0.1' });
  assert.ok(blocked, '同一来源超过秒级额度应被拒');
  assert.equal(guardRate('', 'getSchoolDirectory', T0, { clientIp: '10.0.0.2' }), null,
    '另一个来源不该被带累（旧实现全站共用一个匿名桶）');
});

test('匿名日预算比登录账号更严', () => {
  resetRateLimit();
  assert.ok(ANON_DAILY_LIMITS.read < DAILY_LIMITS.read);
  for (let i = 0; i < ANON_DAILY_LIMITS.read; i += 1) {
    assert.equal(guardRate('', 'getSchoolDirectory', T0 + i * 1000, { clientIp: '10.0.0.9' }), null);
  }
  const blocked = guardRate('', 'getSchoolDirectory', T0 + ANON_DAILY_LIMITS.read * 1000, { clientIp: '10.0.0.9' });
  assert.ok(blocked);
  assert.equal(blocked.scope, 'day');
});
