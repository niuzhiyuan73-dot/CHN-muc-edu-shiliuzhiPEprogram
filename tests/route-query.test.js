/**
 * 路由编号解析（utils/route-query.js）
 * ============================================================
 * 守的是一次真实踩过的坑：跳转方 encodeURIComponent 拼 URL，而**接收方拿到的
 * 值是否已解码取决于运行环境**——Node 测试替身（URLSearchParams）解码一次，
 * 微信开发者工具 / 真机原样透传。两种环境都要能查回同一条记录，
 * 同时编号自身含 `%`（schoolKey 复合键）时不能被二次解码改坏。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { routeIdCandidates, resolveRouteId } = require('../miniprogram/utils/route-query.js');

test('不含 % 的编号只有一个候选：不做无谓的解码', () => {
  assert.deepStrictEqual(routeIdCandidates('u06'), ['u06']);
  assert.deepStrictEqual(routeIdCandidates('sev:muc:pkb:open-singles'), ['sev:muc:pkb:open-singles']);
});

test('百分号编码的编号给两个候选：原值在前、解码值在后', () => {
  assert.deepStrictEqual(
    routeIdCandidates('sev%3Amuc%3Apkb%3Aspring-cup'),
    ['sev%3Amuc%3Apkb%3Aspring-cup', 'sev:muc:pkb:spring-cup']
  );
});

test('编号自身含 %（未解码环境里的 %25）也能解回原样', () => {
  // schoolKey 各段 encodeURIComponent 后拼接，编号里合法地存在 %
  const id = 'sev:muc:pkb:a%2Fb';
  assert.deepStrictEqual(routeIdCandidates('sev%3Amuc%3Apkb%3Aa%252Fb'), ['sev%3Amuc%3Apkb%3Aa%252Fb', id]);
  // 已解码环境：值里含 %，解码后再与原值不同，仍在第二个候选里
  assert.deepStrictEqual(routeIdCandidates(id), [id, 'sev:muc:pkb:a/b']);
});

test('空值与非法百分号序列不抛错', () => {
  assert.deepStrictEqual(routeIdCandidates(''), []);
  assert.deepStrictEqual(routeIdCandidates(null), []);
  assert.deepStrictEqual(routeIdCandidates('sev%3Amuc%'), ['sev%3Amuc%']);
});

test('resolveRouteId 按候选顺序探测，命中即返回', async () => {
  const tried = [];
  const hit = await resolveRouteId('sev%3Amuc%3Apkb%3Aspring-cup', async (id) => {
    tried.push(id);
    return id === 'sev:muc:pkb:spring-cup' ? { ok: true, id } : null;
  });
  assert.deepStrictEqual(tried, ['sev%3Amuc%3Apkb%3Aspring-cup', 'sev:muc:pkb:spring-cup']);
  assert.strictEqual(hit.id, 'sev:muc:pkb:spring-cup');
  assert.ok(hit.result);
});

test('resolveRouteId 全部候选未命中时返回空 id', async () => {
  const miss = await resolveRouteId('sev:missing', async () => null);
  assert.deepStrictEqual(miss, { id: '', result: null });
});
