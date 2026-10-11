/**
 * 会员写接口：提交入会申请 / 通过 / 驳回
 * ============================================================
 * 【自提权是怎么被挡住的】
 * 前端只能提交实名信息，_id、openId、role、status、joinDate 全部由服务端
 * 生成。否则请求体里塞一个 role:2 就能自封管理员。
 *
 * 【重复提交为什么不会把已通过的账号打回待审核】
 * 主键由 OpenID 派生，同一个人的重复申请必然落到同一条文档上。事务里
 * 读到「已存在且不是待审核」，就直接把现有记录原样返回——用户重试一下
 * 不该让刚批下来的账号又变回待审。
 *
 * 【为什么入会审核也要动赛季版本号】
 * 通过一条申请会让这个人进入回放名单，从而影响部分比赛的期望胜率。
 * 版本号 +1 让缓存失效，下一次读就会带上他重算。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { getDataset } = require('./derive.js');
const { bumpSeason } = require('./season.js');
const { memberKey } = require('./idempotency.js');
const { register: registerAccount } = require('../../lib/services/auth.js');
const {
  REVIEW_ACTION,
  validateReview,
  validateInitialEloEdit,
  buildInitialEloByAssoc,
} = require('../../lib/services/member-review.js');
const { buildProfilePatch } = require('../../lib/services/profile.js');
const { ROLE, USER_STATUS } = require('../../lib/utils/constants.js');

/**
 * 提交入会申请。一律记为「待审核」。
 *
 * @param {Object} payload { profile }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, account, errors, firstError}
 */
async function registerMember(payload = {}, ctx) {
  // 校验复用 auth.register（纯函数），本函数只负责落库——
  // 两处各写一套校验，迟早会分叉
  const result = registerAccount(payload.profile, { openId: ctx.openId, now: ctx.now });
  if (!result.ok) {
    return ok({
      ok: false,
      account: null,
      errors: result.errors,
      firstError: result.firstError,
    });
  }

  // 没有 OpenID（理论上不会发生）时退回账号自带的临时编号，至少保证幂等
  const _id = memberKey(ctx.openId || result.account._id);

  const account = await ctx.repo.transaction(async (tx) => {
    const existing = await tx.users.getById(_id);
    // 已通过或已驳回的账号，原样返回：重试不能冲掉既有的审核结果
    if (existing && existing.status !== USER_STATUS.PENDING) return existing;

    const record = {
      ...result.account,
      _id,
      openId: ctx.openId,
      // 下面三个字段一律服务端盖章，不接受前端传入
      role: ROLE.MEMBER,
      status: USER_STATUS.PENDING,
      joinDate: ctx.now,
    };
    await tx.users.set(_id, record);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return record;
  });

  return ok({ ok: true, account, errors: {}, firstError: '' });
}

/**
 * 审核一条入会申请。通过 / 驳回共用这条通路，只是终态不同。
 *
 * @param {string} applicationId
 * @param {string} action 取值见 REVIEW_ACTION
 * @param {string} reason 驳回理由，驳回时必填
 * @param {Object} ctx
 * @param {*} [initialElo] 管理员手工指定的初始等级分，留空则按前五场自动定级
 * @returns {Promise<Object>} {ok, account, message}
 */
async function reviewMember(applicationId, action, reason, ctx, initialElo) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const { applications, members } = await getDataset(ctx);
  const application =
    applications.find((item) => item._id === applicationId) ||
    members.find((item) => item._id === applicationId) ||
    null;

  // 严格口径：仅管理员能审（见 member-review.canReview），且不能审自己的申请。
  // initialElo 也在这里校验取值范围——请求体里的任何数值都不被信任。
  const verdict = validateReview(ctx.actor, application, action, reason, {
    isMock: false,
    initialElo,
  });
  if (!verdict.ok) return ok({ ok: false, account: null, message: verdict.message });

  const status =
    action === REVIEW_ACTION.APPROVE ? USER_STATUS.ACTIVE : USER_STATUS.DISABLED;

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.users.getById(applicationId);
    // 事务内复核：并发审核只有一次能落地
    if (!current || current.status !== USER_STATUS.PENDING) return null;

    const patch = {
      status,
      action,
      reason: String(reason || '').trim(),
      actor: ctx.actorId,
      actedAt: ctx.now,
    };
    const next = { ...current, ...patch };
    // 只有「通过」且真填了分数才落初始分。初始分按协会分开存：在哪个协会
    // 审核通过、填了分，就写进那个协会。留空时不写这一档，回放引擎据此走
    // 自动定级（见 lib/services/replay.js）；同时清掉改造前的全局遗留字段。
    if (action === REVIEW_ACTION.APPROVE && verdict.initialElo !== null) {
      next.initialEloByAssoc = buildInitialEloByAssoc(current, ctx.association, verdict.initialElo);
      delete next.initialElo;
    }

    await tx.users.set(applicationId, next);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return next;
  });

  if (!patched) return ok({ ok: false, account: null, message: '这条申请已经处理过了' });
  return ok({ ok: true, account: patched, message: '' });
}

/** 通过一条入会申请，申请人随即成为正式会员并进入回放名单 */
async function approveMember(payload = {}, ctx) {
  return reviewMember(
    payload.applicationId,
    REVIEW_ACTION.APPROVE,
    '',
    ctx,
    payload.initialElo
  );
}

/** 驳回一条入会申请。驳回后账号处于「已禁用」，靠 action 区分文案。 */
async function rejectMember(payload = {}, ctx) {
  return reviewMember(payload.applicationId, REVIEW_ACTION.REJECT, payload.reason, ctx);
}

/**
 * 修改自己的昵称与头像。
 *
 * 【改的是谁，我说了不算】
 * 只认 ctx.actorId（由 OpenID 解析而来），payload 里的 actor 只是「谁点的
 * 按钮」的线索。请求体里塞一个别人的编号，改到的仍是自己的账号。
 *
 * 【真实姓名与学号为什么改不了】
 * 白名单写在 profile.js 的 EDITABLE_FIELDS 里，buildProfilePatch 会把
 * 白名单外的字段直接丢掉——实名信息是审核依据，不能由本人随手改。
 *
 * 【为什么要动赛季版本号】
 * 昵称、头像进了回放数据集（nameOf 解析器、榜单列表都读它）。不 +1 的话
 * 缓存里仍是旧名字，别人刷新看到的还是原来那个。
 *
 * @param {Object} payload { patch: {nickName?, avatarUrl?} }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, account, errors, firstError}
 */
async function updateProfile(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const built = buildProfilePatch(payload.patch);
  if (!built.ok) {
    return ok({ ok: false, account: null, errors: built.errors, firstError: built.firstError });
  }

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.users.getById(ctx.actorId);
    if (!current) return null;
    const next = { ...current, ...built.patch };
    await tx.users.set(ctx.actorId, next);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return next;
  });

  if (!patched) {
    return ok({ ok: false, account: null, errors: {}, firstError: '找不到你的账号' });
  }
  return ok({ ok: true, account: patched, errors: {}, firstError: '' });
}

/**
 * 调整某位会员在**本协会**的初始等级分。
 *
 * 【谁能改】管理员（全局通行）或协会负责人（仅本协会）。「仅本协会」不必
 * 显式判断：ctx.actor 的 role 已是本协会的有效角色，协会负责人出了本协会
 * 就是普通会员，canManage 自然不放行（见 member-review.canEditInitialElo）。
 * 允许改自己，也允许协会负责人改管理员——不在目标角色上设限。
 *
 * 【什么时候不能改】该会员在本协会已经打过比赛（生涯总计 > 0）。初始分是
 * 回放的起评分，只在没出场时才有意义；娱乐赛（日常约球）同样计入，只要进过
 * 回放就锁死。判定数据取自本协会作用域的数据集。
 *
 * 【清除】value 为空（null / 空串）表示清除本协会的初始分，回到自动定级。
 *
 * @param {Object} payload { userId, value }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, account, message}
 */
async function setMemberInitialElo(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const { members } = await getDataset(ctx);
  const target = members.find((item) => item._id === payload.userId) || null;

  const verdict = validateInitialEloEdit(ctx.actor, target, payload.value, { isMock: false });
  if (!verdict.ok) return ok({ ok: false, account: null, message: verdict.message });

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.users.getById(payload.userId);
    if (!current) return null;
    const next = {
      ...current,
      initialEloByAssoc: buildInitialEloByAssoc(current, ctx.association, verdict.value),
    };
    // 初始分现在完全按协会存，清掉改造前的全局遗留字段
    delete next.initialElo;
    await tx.users.set(payload.userId, next);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return next;
  });

  if (!patched) return ok({ ok: false, account: null, message: '找不到这位会员' });
  return ok({ ok: true, account: patched, message: '' });
}

// reviewMember 是 approve / reject 共用的内部实现，不导出——dispatch 会把
// 模块的所有导出都当成可调用的 action，导出它就等于多开一个没有参数约定
// 的路由。
module.exports = {
  registerMember,
  approveMember,
  rejectMember,
  setMemberInitialElo,
  updateProfile,
};
