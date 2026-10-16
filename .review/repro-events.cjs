/**
 * 四件用户实测问题的端到端验收脚本（Lead 维护，不提交）。
 * ============================================================
 * 直接跑真实 mock 栈（school-mock + association-space 门面 + 视图装载器），
 * 逐条核对用户报的现象是否已经消失：
 *   1. 点「报名」不再显示「赛事不存在」（开发者工具把 query 原样透传的环境）；
 *   2. 已创建并结束的赛事不再持续显示 0 人；
 *   3. 最终名次显示姓名而不是编号；
 *   4. 协会空间可以删除整个小组（成员移空后小组不再残留）。
 * 用法：node .review/acceptance-check.cjs
 */
const mock = require('../miniprogram/services/school-mock.js');
const {
  loadSchoolEventDetailView, loadSchoolEventPlacementView,
} = require('../miniprogram/services/school-event-view.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  mock.reset();
  mock.setDemoActor('u01'); // 管理员：发布 / 删除小组都要管理权
  const admin = mock.forAssociationSpace(SCOPE);

  /* ---------- 1 + 2：报名与人数（开发者工具：query 原样透传） ---------- */
  const list = await admin.listSchoolEvents({ limit: 50 });
  const open = list.events.find((row) => row.isSignup);
  const finished = list.events.find((row) => row.isFinished);
  const encodedOpen = encodeURIComponent(open.eventId);

  console.log('\n=== 赛事列表 ===');
  for (const row of list.events) {
    console.log(`    ${row.title} | ${row.statusLabel} | ${row.quotaText}`);
  }

  const detail = await loadSchoolEventDetailView(encodedOpen, { ...SCOPE, actorId: 'u01' });
  check('编码过的 query 也能打开详情，并回传真实编号',
    detail.found && detail.eventId === open.eventId,
    `eventId=${detail.eventId}`);

  const signed = await admin.signUpSchoolEvent({ eventId: detail.eventId });
  check('页面拿回传编号报名成功（不再「赛事不存在」）',
    signed.ok === true || /已经报过|已报名/.test(signed.message || ''),
    JSON.stringify({ ok: signed.ok, message: signed.message, quotaText: signed.event && signed.event.quotaText }));

  const naive = await admin.cancelSchoolEventSignup({ eventId: encodedOpen });
  check('对照：拿未解码编号直接写仍会被判「赛事不存在」（说明修复点在页面采纳回传编号）',
    naive.ok === false && /赛事不存在/.test(naive.message || ''),
    `message=${naive.message}`);

  check('已结束的赛事显示真实人数，不再是 0 人',
    Boolean(finished) && finished.signupCount > 0 && !/^0(\/| 人)/.test(finished.quotaText),
    finished ? `${finished.title} | ${finished.quotaText}` : '演示内容里没有已结束赛事');

  /* ---------- 3：最终名次显示姓名 ---------- */
  const finishedDetail = finished
    ? await loadSchoolEventDetailView(encodeURIComponent(finished.eventId), { ...SCOPE, actorId: 'u01' })
    : { resultRows: [] };
  const named = finishedDetail.resultRows.filter((row) => row.nickName && row.nickName !== row.userId);
  check('最终名次显示姓名而不是编号',
    finishedDetail.resultRows.length > 0 && named.length === finishedDetail.resultRows.length,
    finishedDetail.resultRows.map((row) => `${row.userId}→${row.nickName}`).join(', '));

  const placement = finished
    ? await loadSchoolEventPlacementView(encodeURIComponent(finished.eventId), { ...SCOPE, actorId: 'u01' })
    : { rows: [] };
  check('名次录入页的名单同样有姓名（不再空名单）',
    placement.rows.length > 0 && placement.rows.every((row) => row.nickName && row.nickName !== row.userId),
    placement.rows.map((row) => `${row.userId}→${row.nickName}`).join(', '));

  /* ---------- 4：删除整个小组 ---------- */
  console.log('\n=== 协会空间小组 ===');
  const created = await admin.createAssociationGroup({
    requestId: `accept_group_${Date.now()}`, name: '验收临时小组', description: '', memberIds: ['u03', 'u05'],
  });
  check('建组成功', created.ok === true, JSON.stringify(created.message || created.group));

  let groupId = created.group && created.group.groupId;
  const beforeList = await admin.listAssociationGroups({ limit: 50 });
  check('新建的小组出现在列表里',
    beforeList.groups.some((row) => row.groupId === groupId));

  for (const userId of ['u03', 'u05']) {
    await admin.removeAssociationGroupMember({ groupId, userId });
  }
  const emptied = await admin.getAssociationGroup({ groupId });
  check('成员移空后小组仍在（成员操作不等于删除小组，符合现状）',
    emptied.ok === true && emptied.group.memberCount === 0);

  const revision = (await admin.getAssociationGroup({ groupId })).group.revision;
  const removed = await admin.deleteAssociationGroup({ groupId, expectedRevision: revision });
  check('删除整个小组成功', removed.ok === true, JSON.stringify({ ok: removed.ok, message: removed.message }));

  const afterList = await admin.listAssociationGroups({ limit: 50 });
  check('删除后列表里不再出现这个小组',
    !afterList.groups.some((row) => row.groupId === groupId),
    afterList.groups.map((row) => row.name).join(', '));

  const fetchAfter = await admin.getAssociationGroup({ groupId });
  check('删除后再读该小组被拒（小组不存在）',
    fetchAfter.ok === false, `message=${fetchAfter.message}`);

  const recreated = await admin.createAssociationGroup({
    requestId: `accept_group_again_${Date.now()}`, name: '验收临时小组', description: '', memberIds: [],
  });
  check('删除后同名小组可以重建（组名占位已释放）',
    recreated.ok === true, JSON.stringify({ ok: recreated.ok, message: recreated.message }));
  if (recreated.ok) {
    const rev2 = (await admin.getAssociationGroup({ groupId: recreated.group.groupId })).group.revision;
    await admin.deleteAssociationGroup({ groupId: recreated.group.groupId, expectedRevision: rev2 });
  }

  const failed = results.filter((row) => !row.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('未通过：' + failed.map((row) => row.name).join('；'));
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
