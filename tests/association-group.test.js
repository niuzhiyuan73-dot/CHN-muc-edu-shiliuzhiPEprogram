const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchoolDemoSeed } = require('../miniprogram/services/school-seed');
const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
const { buildSchoolContext } = require('../miniprogram/services/school-context');
const handlers = require('../miniprogram/services/association-group-service');
const { schoolMembershipKey, schoolMemberKey } = require('../miniprogram/utils/school');

const NOW = new Date('2026-10-13T10:00:00Z');

/** 在演示种子上补平台管理员、第三个民大会员，并给民大会员一个负责人身份。 */
function fixture({ leader = false } = {}) {
  const seed = createSchoolDemoSeed();
  seed.users.push({ _id: 'demo_platform_admin', openId: 'mock_openid_platform_admin',
    nickName: '平台管理员', platformStatus: 'active', platformRole: 'admin', simulated: true });
  seed.users.push({ _id: 'demo_muc_other', openId: 'mock_openid_muc_other', nickName: '民大第三会员',
    platformStatus: 'active', platformRole: 'member', primarySchoolId: 'muc', simulated: true });
  seed.schoolMembers.push({ _id: schoolMemberKey('demo_muc_other', 'muc'), userId: 'demo_muc_other',
    schoolId: 'muc', collegeId: 'c02', studentId: 'TEST003', status: 'active', simulated: true });
  if (leader) {
    seed.memberships.push({ _id: schoolMembershipKey('demo_muc_member', { schoolId: 'muc', association: 'pkb' }),
      userId: 'demo_muc_member', schoolId: 'muc', association: 'pkb', role: 'leader', status: 'active' });
  }
  return createSchoolMemoryRepo(seed);
}

async function call(repo, action, payload = {}, actor = 'demo_muc_admin', schoolId = 'muc', association = 'pkb') {
  const ctx = await buildSchoolContext({ repo, actorId: actor, scope: { schoolId, association }, now: NOW });
  return (await handlers[action](payload, ctx)).data;
}

async function createGroup(repo, fields = {}, actor = 'demo_muc_admin', schoolId = 'muc') {
  const result = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r1', ...fields }, actor, schoolId);
  assert.equal(result.ok, true, result.message);
  return result.group;
}

const revisionOf = async (repo, groupId) => (await repo.associationGroups.getById(groupId)).revision;
const countOf = async (repo, groupId) => (await repo.associationGroups.getById(groupId)).memberCount;
const repoGroups = async (repo) => (await repo.associationGroups.list()).filter(doc => !doc.nameClaim).length;

test('权限矩阵：只有学校管理员、协会负责人与平台管理员能建立小组', async () => {
  const plain = fixture();
  assert.equal((await call(plain, 'createAssociationGroup', { name: '新手组', requestId: 'r1' }, 'demo_muc_member')).ok,
    false, '普通会员不能建组');
  assert.equal((await call(plain, 'createAssociationGroup', { name: '新手组', requestId: 'r1' }, 'demo_buaa_admin')).ok,
    false, '外校管理员不能在本校建组');
  assert.equal((await repoGroups(plain)), 0, '被拒时无写入');
  assert.equal((await call(plain, 'createAssociationGroup', { name: '新手组', requestId: 'r1' })).ok, true, '本校管理员可建组');
  assert.equal((await call(plain, 'createAssociationGroup', { name: '平台组', requestId: 'r3' }, 'demo_platform_admin', 'buaa')).ok,
    true, '平台管理员可跨校建组');

  const led = fixture({ leader: true });
  assert.equal((await call(led, 'createAssociationGroup', { name: '新手组', requestId: 'r1' }, 'demo_muc_member')).ok,
    true, '协会负责人可建组');
});

test('读取名录：本校会员与平台管理员可读，外校会员被拒绝', async () => {
  const repo = fixture();
  await createGroup(repo, { name: '新手组', requestId: 'r1' });
  assert.equal((await call(repo, 'listAssociationGroups', {}, 'demo_muc_member')).ok, true, '本校会员可读');
  const cross = await call(repo, 'listAssociationGroups', {}, 'demo_buaa_member', 'muc');
  assert.equal(cross.ok, false, '外校会员不可读别协会空间');
  assert.deepEqual(cross.groups, []);
  const asPlatform = await call(repo, 'listAssociationGroups', {}, 'demo_platform_admin', 'muc');
  assert.equal(asPlatform.ok, true, '平台管理员可跨校读');
});

test('建组幂等：同请求编号重试返回同一组，改内容则拒绝', async () => {
  const repo = fixture();
  const first = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  const retry = await call(repo, 'createAssociationGroup',
    { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal(retry.ok, true);
  assert.equal(retry.group.groupId, first.groupId);
  assert.equal((await repo.associationGroups.list()).filter(doc => !doc.nameClaim).length, 1, '只落一组');
  const changed = await call(repo, 'createAssociationGroup', { name: '校队组', requestId: 'r1' });
  assert.equal(changed.ok, false, '同编号换内容被拒');
});

test('同范围不重名：同名不同请求编号被拒，换学校/协会则允许', async () => {
  const repo = fixture();
  await createGroup(repo, { name: '新手组', requestId: 'r1' });
  const dup = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r2' });
  assert.equal(dup.ok, false, '同范围同名被拒');
  const otherSchool = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r2' }, 'demo_buaa_admin', 'buaa');
  assert.equal(otherSchool.ok, true, '别校同名互不影响');
  const otherSport = await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r3' }, 'demo_muc_admin', 'muc', 'tt');
  assert.equal(otherSport.ok, true, '同校别协会同名互不影响');
});

test('重命名释放旧名占位，旧名可被新组复用', async () => {
  const repo = fixture();
  const a = await createGroup(repo, { name: '新手组', requestId: 'r1' });
  const b = await createGroup(repo, { name: '校队组', requestId: 'r2' });
  assert.equal((await call(repo, 'updateAssociationGroup',
    { groupId: a.groupId, name: '校队组', description: '', expectedRevision: await revisionOf(repo, a.groupId) })).ok,
    false, '改成已存在的名字被拒');
  assert.equal((await call(repo, 'updateAssociationGroup',
    { groupId: a.groupId, name: '精英组', description: '进阶', expectedRevision: await revisionOf(repo, a.groupId) })).ok,
    true, '改名成功');
  const reused = await createGroup(repo, { name: '新手组', requestId: 'r3' });
  assert.notEqual(reused.groupId, a.groupId, '旧名被释放后新组可用');
  assert.notEqual(b.groupId, reused.groupId);
});

test('成员增减幂等：重复加入/移除人数最多变一次', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal(await countOf(repo, group.groupId), 1);
  const again = await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_member'] });
  assert.equal(again.ok, true);
  assert.equal(await countOf(repo, group.groupId), 1, '重复加入不增加人数');
  const two = await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_other', 'demo_muc_other'] });
  assert.equal(two.ok, true);
  assert.equal(await countOf(repo, group.groupId), 2, '去重后只加一个');
  assert.equal((await call(repo, 'removeAssociationGroupMember', { groupId: group.groupId, userId: 'demo_muc_member' })).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1);
  assert.equal((await call(repo, 'removeAssociationGroupMember', { groupId: group.groupId, userId: 'demo_muc_member' })).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1, '重复移除不减少人数');
});

test('本人退出只影响自己，且重复退出幂等', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member', 'demo_muc_other'] });
  assert.equal(await countOf(repo, group.groupId), 2);
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1);
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, true);
  assert.equal(await countOf(repo, group.groupId), 1, '重复退出不影响别人');
  // 非组员的普通会员退出也不报错，只是无变化
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_buaa_member', 'buaa')).ok, false);
});

test('入组只收本协会在册会员，超员与非法清单直接拒绝', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1' });
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_buaa_member'] })).ok,
    false, '外校会员不能入组');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['ghost'] })).ok,
    false, '不存在的人不能入组');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: [] })).ok,
    false, '空清单被拒');
  assert.equal((await call(repo, 'addAssociationGroupMembers',
    { groupId: group.groupId, memberIds: Array.from({ length: 51 }, (_, i) => `m${i}`) })).ok, false, '超过单次上限');
  assert.equal(await countOf(repo, group.groupId), 0, '拒绝时无写入');
});

test('归档后禁止编辑与增员，允许成员退出，归档本身幂等', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal((await call(repo, 'archiveAssociationGroup', { groupId: group.groupId, expectedRevision: await revisionOf(repo, group.groupId) })).ok, true);
  assert.equal((await repo.associationGroups.getById(group.groupId)).status, 'archived');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_muc_other'] })).ok, false, '归档禁止增员');
  assert.equal((await call(repo, 'updateAssociationGroup', { groupId: group.groupId, name: '改名', description: '', expectedRevision: 9 })).ok, false, '归档禁止编辑');
  assert.equal((await call(repo, 'archiveAssociationGroup', { groupId: group.groupId, expectedRevision: 9 })).ok, true, '重复归档幂等');
  assert.equal((await call(repo, 'leaveAssociationGroup', { groupId: group.groupId }, 'demo_muc_member')).ok, true, '归档仍可退出');
});

test('名单可见性：管理者与组员可见，非组员只看组信息', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  const asManager = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_admin');
  assert.equal(asManager.canReadRoster, true);
  assert.deepEqual(asManager.members.map(row => row.userId), ['demo_muc_member']);
  assert.deepEqual(Object.keys(asManager.members[0]).sort(),
    ['collegeId', 'collegeName', 'nickName', 'permissionLabel', 'userId'], '成员字段脱敏');
  const asMember = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_member');
  assert.equal(asMember.canReadRoster, true, '组员可见名单');
  const asOutsider = await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_muc_other');
  assert.equal(asOutsider.canReadRoster, false, '非组员看不到名单');
  assert.deepEqual(asOutsider.members, []);
  assert.equal(asOutsider.group.name, '新手组', '组基本信息仍可见');
});

test('跨校跨协会隔离：别校/别协会读不到也改不了本组', async () => {
  const repo = fixture();
  const group = await createGroup(repo, { name: '新手组', requestId: 'r1', memberIds: ['demo_muc_member'] });
  assert.equal((await call(repo, 'listAssociationGroups', {}, 'demo_buaa_admin', 'buaa')).groups.length, 0, '别校列表为空');
  // 同校别协会（乒乓球）能读自己的空间，但看不到本协会（匹克球）的小组——数据不串台。
  assert.deepEqual((await call(repo, 'listAssociationGroups', {}, 'demo_muc_admin', 'muc', 'tt')).groups, []);
  assert.equal((await call(repo, 'getAssociationGroup', { groupId: group.groupId }, 'demo_buaa_admin', 'buaa')).ok,
    false, '外校读不到别校组');
  assert.equal((await call(repo, 'addAssociationGroupMembers', { groupId: group.groupId, memberIds: ['demo_buaa_member'] },
    'demo_buaa_admin', 'buaa')).ok, false, '外校不能改别校组');
});

test('并发：同名建组只成功一个，并发增员人数不丢更新', async () => {
  const repo = fixture();
  const both = await Promise.all([1, 2].map((n) => call(repo, 'createAssociationGroup', { name: '新手组', requestId: `r${n}` })));
  assert.equal(both.filter(row => row.ok).length, 1, '并发建同名只成功一个');
  const groupId = both.find(row => row.ok).group.groupId;

  const added = await Promise.all(['demo_muc_member', 'demo_muc_other'].map((userId) =>
    call(repo, 'addAssociationGroupMembers', { groupId, memberIds: [userId] })));
  assert.equal(added.filter(row => row.ok).length, 2);
  assert.equal(await countOf(repo, groupId), 2, '并发增员人数不丢更新');

  const sameTwice = await Promise.all([1, 2].map(() =>
    call(repo, 'addAssociationGroupMembers', { groupId, memberIds: ['demo_buaa_member'] })));
  assert.equal(sameTwice.every(row => row.ok === false), true, '不合格成员并发也被拒');
  assert.equal(await countOf(repo, groupId), 2);
});

test('建组校验：组名长度、请求编号与不存在的成员都会拒绝且不落库', async () => {
  const repo = fixture();
  assert.equal((await call(repo, 'createAssociationGroup', { name: 'x', requestId: 'r1' })).ok, false, '组名太短');
  assert.equal((await call(repo, 'createAssociationGroup', { name: '组'.repeat(31), requestId: 'r1' })).ok, false, '组名太长');
  assert.equal((await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'bad id!' })).ok, false, '编号非法');
  assert.equal((await call(repo, 'createAssociationGroup', { name: '新手组', requestId: 'r1', memberIds: ['ghost'] })).ok,
    false, '含不合格成员');
  assert.equal((await repo.associationGroups.list()).length, 0, '全部拒绝时无写入');
});
