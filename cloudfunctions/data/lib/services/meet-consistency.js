/** 集合查询在事务外进行，事务内点读版本，防止旧快照覆盖新成绩/报名。 */
function stableJson(doc) {
  return JSON.stringify(doc, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

async function unchanged(tx, collection, docs) {
  for (const doc of docs) {
    const current = await tx[collection].getById(doc._id);
    if (stableJson(current) !== stableJson(doc)) return false;
  }
  return true;
}

async function touchEvent(tx, eventKey) {
  const doc = await tx.sportsMeetEvents.getById(eventKey);
  if (doc) await tx.sportsMeetEvents.set(eventKey, { ...doc, revision: Number(doc.revision || 0) + 1 });
}

function liveMeet(ctx) {
  return Boolean(ctx.meet && ctx.meet.schoolId === ctx.schoolId && ctx.meet.status !== 'deleted');
}

module.exports = { unchanged, touchEvent, liveMeet };
