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

const { guardRate, resetRateLimit, LIMITS, kindOf } = require('../cloudfunctions/data/src/core/rate-limit');

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

test('未登录请求归入同一个匿名桶（匿名刷也受限）', () => {
  resetRateLimit();
  for (let i = 0; i < LIMITS.write; i += 1) guardRate('', 'registerSchoolAccount', T0);
  const blocked = guardRate('', 'registerSchoolAccount', T0);
  assert.ok(blocked, '无 OPENID 也必须有闸门');
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
  assert.ok(Object.isFrozen(LIMITS));
});
