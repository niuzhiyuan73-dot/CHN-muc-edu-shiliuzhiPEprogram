const { belongsToAssociation } = require('../../lib/utils/associations.js');
const { canRecordScore, fillScheduledMatch } = require('../../lib/services/match-record.js');
const { MATCH_STATUS } = require('../../lib/utils/constants.js');
const { bumpSeason } = require('./season.js');

/** 同一事务内校验最新比赛、保存正式比分并更新版本，供手动录分和实时定稿复用。 */
async function writeScheduledScore(tx, id, scores, { dataset, ctx, now }) {
  const failed = (firstError) => ({ ok: false, match: null, errors: {}, scoreErrors: [], firstError });
  const current = await tx.matches.getById(id);
  if (!belongsToAssociation(current, ctx.association)) return failed('找不到这场比赛');
  if (current.status !== MATCH_STATUS.PENDING) return failed('只有待确认的比赛可以录分');
  if (!canRecordScore(current, ctx.actorId, {
    role: ctx.role,
    college: (ctx.actor && ctx.actor.college) || '',
    collegeOf: (userId) => (dataset.users.find((user) => user._id === userId) || {}).college || '',
  })) return failed('只有参赛者、本学院负责人或管理员可以录入这场比赛的成绩');

  const filled = fillScheduledMatch(current, scores, {
    members: dataset.members,
    now: now || ctx.now,
    minMatchTime: dataset.meta.seasonStart || dataset.meta.firstMatchTime,
    recorder: ctx.actorId,
  });
  if (!filled.ok) return { ...failed(filled.firstError), errors: filled.errors, scoreErrors: filled.scoreErrors };
  const patch = {
    ...filled.patch,
    status: MATCH_STATUS.PENDING,
    action: 'score',
    actor: ctx.actorId,
    actedAt: ctx.now,
  };
  await tx.matches.update(id, patch);
  await bumpSeason(tx, {
    association: ctx.association,
    anchorTime: dataset.meta.seasonStart || current.matchTime,
    now: ctx.now,
  });
  return { ok: true, match: { ...current, ...patch }, errors: {}, scoreErrors: [], firstError: '' };
}

module.exports = { writeScheduledScore };
