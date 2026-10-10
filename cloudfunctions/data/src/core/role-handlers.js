/**
 * 角色任免：协会负责人 / 学院负责人
 * ============================================================
 * 改造后角色分两层（见施工方案 §3.2–3.4）：
 *   - 全局角色（`users.role`）只有 MEMBER(0) / ADMIN(2)；
 *   - 协会角色记在 `memberships` 集合：`leader` = 协会负责人、
 *     `staff` = 学院负责人，**无行 = 普通会员**。
 *
 * 两个任免都只写 `ctx.association` 名下的成员行，因此协会负责人天然只能
 * 任免本协会的人——请求携带的 association 就是他所在的协会，越界无从发生。
 *
 * 【安全红线：任免协会负责人只认 ctx.globalRole】
 * 协会负责人的**有效角色**也是 ADMIN（见 context.effectiveRole），
 * `canManage` 区分不出他与全局管理员。所以「任命 / 免除协会负责人」这条
 * 通路绝不能走 canManage，只认 `ctx.isGlobalAdmin`；否则协会负责人就能
 * 反手把自己人提成协会负责人，层层自封。
 *
 * 【为什么任免要动赛季版本号】
 * 角色与学院虽然不进回放计算，却要经 getDataset 下发（会员名单、权限判定
 * 都读它）。不 +1 的话容器里还是旧缓存，被任免的人刷新后仍是旧身份。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError, effectiveRole } = require('./context.js');
const { bumpSeason } = require('./season.js');
const { membershipKey } = require('./idempotency.js');
const { validateCollegeLeader } = require('../../lib/services/member-review.js');
const { ROLE, ASSOC_ROLE, USER_STATUS } = require('../../lib/utils/constants.js');

/**
 * 任命 / 免除**本协会的学院负责人**（写 `memberships.role='staff'`）。
 *
 * 权限：**有效角色 ≥ ADMIN**（即本协会的协会负责人，或全局管理员）。
 * 复用共享的 `validateCollegeLeader`：其中 canSetCollegeLeader 走
 * `canManage(actor, { minRole: ADMIN })`，读的是 `ctx.actor.role`（已是
 * 有效角色），因此协会负责人一行不改就被放行。
 *
 * @param {Object} payload { userId, makeLeader }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, account, message}
 */
async function setCollegeLeader(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  const target = await ctx.repo.users.getById(payload.userId);
  const makeLeader = Boolean(payload.makeLeader);

  const verdict = validateCollegeLeader(ctx.actor, target, makeLeader);
  if (!verdict.ok) return ok({ ok: false, account: null, message: verdict.message });

  const key = membershipKey(target._id, ctx.association);
  await ctx.repo.transaction(async (tx) => {
    const existing = await tx.memberships.get(key);
    if (makeLeader) {
      // 已是协会负责人就不降级——学院负责人的任命不该动协会负责人的身份
      if (!existing || existing.role !== ASSOC_ROLE.LEADER) {
        await tx.memberships.set(key, {
          _id: key,
          userId: target._id,
          association: ctx.association,
          role: ASSOC_ROLE.STAFF,
          updatedAt: ctx.now,
        });
      }
    } else if (existing && existing.role !== ASSOC_ROLE.LEADER) {
      // 撤销学院负责人只删 staff 行；「协会负责人」是另一项任命，不在这里撤
      await tx.memberships.remove(key);
    }
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
  });

  // 重新取一次成员行，按有效角色回报——界面据此刷新身份标签与权限入口
  const row = await ctx.repo.memberships.get(key);
  const account = { ...target, role: effectiveRole(target.role, row) };
  return ok({ ok: true, account, message: '' });
}

/**
 * 任命 / 免除**本协会的协会负责人**（写 `memberships.role='leader'`）。
 *
 * 权限：**仅全局管理员**（`ctx.isGlobalAdmin`），不读 canManage——见文件头
 * 的安全红线。免除时删掉本协会的角色行（回到普通会员）；若该会员此前另有
 * 学院负责人身份，会被一并清掉，需要保留就再单独任命一次。
 *
 * @param {Object} payload { userId, makeLeader }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, account, message}
 */
async function setAssociationLeader(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!ctx.isGlobalAdmin) {
    return ok({ ok: false, account: null, message: '只有全局管理员可以任免协会负责人' });
  }

  const target = await ctx.repo.users.getById(payload.userId);
  if (!target) return ok({ ok: false, account: null, message: '找不到这位会员' });
  if (target._id === ctx.actorId) {
    return ok({ ok: false, account: null, message: '不能给自己任免角色' });
  }
  if (Number(target.role || 0) >= ROLE.ADMIN) {
    return ok({ ok: false, account: null, message: '不能改变管理员的角色' });
  }
  if (target.status !== USER_STATUS.ACTIVE) {
    return ok({ ok: false, account: null, message: '只有在册会员才能设为协会负责人' });
  }

  const makeLeader = Boolean(payload.makeLeader);
  const key = membershipKey(target._id, ctx.association);

  await ctx.repo.transaction(async (tx) => {
    if (makeLeader) {
      await tx.memberships.set(key, {
        _id: key,
        userId: target._id,
        association: ctx.association,
        role: ASSOC_ROLE.LEADER,
        updatedAt: ctx.now,
      });
    } else {
      const existing = await tx.memberships.get(key);
      if (existing) await tx.memberships.remove(key);
    }
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
  });

  const row = await ctx.repo.memberships.get(key);
  const account = { ...target, role: effectiveRole(target.role, row) };
  return ok({ ok: true, account, message: '' });
}

module.exports = { setCollegeLeader, setAssociationLeader };
