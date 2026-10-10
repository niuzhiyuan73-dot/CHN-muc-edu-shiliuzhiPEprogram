/**
 * 公告写接口：发布 / 下架
 * ============================================================
 * 【发布人与发布时间为什么由服务端填】
 * 前端传「我是谁」是不可信的（改个 role 就能冒充管理员发布公告）。
 * 发布人取服务端由 OpenID 查到的账号，发布时间取服务端时钟——
 * 顺带避免客户端时钟不准导致公告排到未来或很久以前。
 *
 * 【发布为什么要去重】
 * mock 允许重复发布同一条公告；云端加了按「发布人 + 标题 + 正文」的
 * 幂等键。这是刻意的加固：弱网重试会产生两条一模一样的公告，
 * 看起来像有人在刷屏。这是一处与 mock 有意不同的行为。
 * ============================================================
 */

const { ok, fail } = require('../envelope.js');
const { callerError } = require('./context.js');
const { getDataset } = require('./derive.js');
const { bumpSeason } = require('./season.js');
const { announcementNaturalKey } = require('./idempotency.js');
const {
  canPublish,
  buildAnnouncementRecord,
} = require('../../lib/services/announcement.js');
const { ANNOUNCEMENT_STATUS } = require('../../lib/utils/constants.js');

/**
 * 发布一条公告，一律记为「已发布」。
 *
 * @param {Object} payload { form }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, errors, firstError}
 */
async function publishAnnouncement(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  // 严格口径：仅管理员能发布（学院负责人是学院范围角色，公告没有学院可言）
  if (!canPublish(ctx.actor, { isMock: false })) {
    return ok({
      ok: false,
      record: null,
      errors: {},
      firstError: '当前账号没有发布公告的权限',
    });
  }

  const built = buildAnnouncementRecord(payload.form, { actor: ctx.actor, now: ctx.now });
  if (!built.ok) {
    return ok({ ok: false, record: null, errors: built.errors, firstError: built.firstError });
  }

  // 盖章协会：写进文档供读路径过滤，同时并入自然键——同一条公告内容
  // 在两个协会发出来就是两条，互不顶替
  built.record.association = ctx.association;

  const _id = announcementNaturalKey(built.record);

  const record = await ctx.repo.transaction(async (tx) => {
    const existing = await tx.announcements.getById(_id);
    if (existing) return existing; // 同一条公告重复提交，返回已有那条

    const doc = { ...built.record, _id, status: ANNOUNCEMENT_STATUS.PUBLISHED };
    await tx.announcements.insert(doc);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return doc;
  });

  return ok({ ok: true, record, errors: {}, firstError: '' });
}

/**
 * 下架一条公告。只改状态，不删除——话已经发出去了，至少要留痕。
 *
 * @param {Object} payload { id }
 * @param {Object} ctx
 * @returns {Promise<Object>} {ok, record, message}
 */
async function archiveAnnouncement(payload = {}, ctx) {
  const guard = callerError(ctx);
  if (guard) return fail(guard);

  if (!canPublish(ctx.actor, { isMock: false })) {
    return ok({ ok: false, record: null, message: '当前账号没有管理公告的权限' });
  }

  const { announcementLedger } = await getDataset(ctx);
  const target = announcementLedger.find((item) => item._id === payload.id);
  if (!target) return ok({ ok: false, record: null, message: '找不到这条公告' });
  if (target.status === ANNOUNCEMENT_STATUS.ARCHIVED) {
    return ok({ ok: false, record: null, message: '这条公告已经下架了' });
  }

  const patched = await ctx.repo.transaction(async (tx) => {
    const current = await tx.announcements.getById(payload.id);
    if (!current) return null;
    if (current.status === ANNOUNCEMENT_STATUS.ARCHIVED) return null;

    const patch = {
      status: ANNOUNCEMENT_STATUS.ARCHIVED,
      actor: ctx.actorId,
      actedAt: ctx.now,
    };
    await tx.announcements.update(payload.id, patch);
    await bumpSeason(tx, { association: ctx.association, anchorTime: null, now: ctx.now });
    return { ...current, ...patch };
  });

  if (!patched) return ok({ ok: false, record: null, message: '这条公告已经下架了' });
  return ok({ ok: true, record: patched, message: '' });
}

module.exports = { publishAnnouncement, archiveAnnouncement };
