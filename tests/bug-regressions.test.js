/**
 * 回归钉子（ surviving P10 后仍有效的部分）
 * ============================================================
 * 本文件原收录旧栈（协议 1）踩过的坑：登录态用缓存不校正、假赛事绕过
 * 防刷分上限、名额竞态、实时比分故障锁分、首页范围竞态、二次改分改写
 * 对手、禁用会员破坏数据集、名额取消与恢复。这些路径已随协议 1 下线，
 * 它们守护的语义各有 S2 对应接管：
 *   · 登录态校正 → tests/app-session.test.js（S2 会话覆盖缓存）；
 *   · 防刷分上限 → tests/school-match.test.js（RATED_PAIR_LIMIT 贯穿）；
 *   · 名额竞态与取消 → tests/school-event.test.js（报名闸门）；
 *   · 实时比分故障收敛 → tests/school-live.test.js；
 *   · 范围竞态 → 下面的 S2 客户端绑定用例（结构性绑定）；
 *   · 手工改分 → 能力已随 B8 移除（学校身份页统一授权）；
 *   · 禁用会员 → tools/acceptance-audit.cjs F1。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('S2 空间客户端跨 await 保持绑定，不被中途的协会切换劫走（旧 withAssociation 用例的 S2 对应）', async () => {
  // 旧栈守的是 withAssociation(id, fn)：回调里的 api 绑定协会、回调中途全局
  // 切协会不影响它。withAssociation 已随 P10 下线；S2 的绑定是结构性的
  // （school-cloud 客户端创建时冻结 scope），本用例把它在云客户端上重新钉住。
  const scope = require('../miniprogram/services/association-scope');
  const { forAssociationSpace } = require('../miniprogram/services/school-cloud');
  scope.setAssociation('pkb');
  const associations = [];
  global.wx = { cloud: { callFunction: async ({ data }) => {
    associations.push(data.association);
    return { result: { ok: true, data: { ok: true } } };
  } } };
  try {
    const api = forAssociationSpace({ schoolId: 'muc', association: 'tt' });
    await api.listSchoolMembers({});
    scope.setAssociation('bd');
    await api.listSchoolMembers({});
    assert.deepEqual(associations, ['tt', 'tt'], '客户端绑定的 tt 不随全局切到 bd 而漂移');
    assert.equal(scope.getAssociation(), 'bd');
  } finally {
    delete global.wx;
    scope.resetAssociation();
  }
});

test('mock adjustment ledger preserves every historical adjustment', () => {
  const store = require('../miniprogram/services/elo-store');
  store.reset();
  try {
    store.setValue('u01', 'singles', 2000, '2026-04-09');
    store.setValue('u01', 'singles', 1800, '2026-04-12');
    assert.deepEqual(store.list().map(item => item.value), [2000, 1800]);
    assert.equal(store.valueOf('u01', 'singles').value, 1800);
  } finally {
    store.reset();
  }
});
