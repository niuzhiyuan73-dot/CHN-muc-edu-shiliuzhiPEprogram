/**
 * 运动会：草稿、项目运行时配置与报名发布（B4）
 * ============================================================
 * 覆盖「发起 → 选项目 → 逐项目配置 → 发布报名」这一段，不含报名本身（B5）。
 *
 * 【届次与项目是两个粒度】
 * `sportsMeets` 一条是一届；`sportsMeetEvents` 一条是「一届 × 项目模板 × 组别」。
 * 男子 100 米与女子 100 米是两条，各自有独立的限额、轮次与名次，不能合并成
 * 「100 米」一个对象——否则限额会串、名次会混。
 *
 * 【配置只在草稿期可改】
 * 一旦发布报名，限额、组别、兼项规则就被报名者依据了。此时静默改小额度会让
 * 已提交的报名超出上限（交接文档 §5.2 明确禁止）。所以本模块所有配置写入都
 * 要求 status=draft；发布之后的修改需要「规则版本」机制，属后续批次。
 *
 * 【为什么删除是软删除】
 * 仓储接口没有 remove（forMeet 只提供 getById / set / insert / update），
 * 而且已产生的报名、成绩、荣誉都按 meetId 指过来，物理删会留下悬空引用。
 * 这里把 status 置为 deleted，读取路径一律当它不存在。
 *
 * 【限额只设每学院上限】
 * D29／D33：不设全校总上限。所以事件文档上只有 perCollegeLimit，没有全校额度；
 * 将来若要加，必须同时加分配策略，不能由实现者暗定先到先得。
 * ============================================================
 */

const {
  MEET_STATUS, MEET_EVENT_STATUS,
  meetEventKey, meetCollegeKey, newMeetId, meetRequestScope, listAliveEvents,
} = require('../utils/meet-scope.js');
const {
  TEMPLATES, getTemplate, searchTemplates, CATEGORY_LABEL, CATEGORY_ORDER,
  MEET_SCORE_TYPE, HEAT_MODE,
} = require('./meet-event-catalog.js');
const { ADVANCE_MODE, MEET_FORMAT, FORMAT_LABEL } = require('./meet-advance.js');
const { buildMeetContext, freshMeetContext } = require('./meet-context.js');
const { meetReadable, canManageMeet, isActiveMeetLead } = require('./meet-permission.js');
const { meetCollegeLeadKey } = require('../utils/meet-scope.js');

const ok = (data) => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const MEET_NAME_MAX = 40;
const LOCATION_MAX = 60;
const PAGE_MAX = 50;
const PAGE_DEFAULT = 20;
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

/** 进行中/报名中排前面，其余按日期倒序（D01：进行中置顶）。 */
const STATUS_WEIGHT = Object.freeze({
  [MEET_STATUS.RUNNING]: 0,
  [MEET_STATUS.REGISTRATION]: 1,
  [MEET_STATUS.SCHEDULED]: 2,
  [MEET_STATUS.DRAFT]: 3,
  [MEET_STATUS.FINISHED]: 4,
  [MEET_STATUS.ARCHIVED]: 5,
});
const STATUS_LABEL = Object.freeze({
  [MEET_STATUS.DRAFT]: '筹备中',
  [MEET_STATUS.REGISTRATION]: '报名中',
  [MEET_STATUS.SCHEDULED]: '赛程已发布',
  [MEET_STATUS.RUNNING]: '进行中',
  [MEET_STATUS.FINISHED]: '已结束',
  [MEET_STATUS.ARCHIVED]: '已归档',
  [MEET_STATUS.DELETED]: '已删除',
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function textOf(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, message: `请填写${label}` };
  if (text.length > max) return { ok: false, message: `${label}不超过 ${max} 个字` };
  return { ok: true, value: text };
}

function dateOf(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!DATE_PATTERN.test(text)) return { ok: false, message: `${label}格式应为 YYYY-MM-DD` };
  const time = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(time)) return { ok: false, message: `${label}不是有效日期` };
  return { ok: true, value: text, time };
}

function timeOf(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!TIME_PATTERN.test(text)) return { ok: false, message: `${label}格式应为 YYYY-MM-DDTHH:mm` };
  const time = Date.parse(text.length === 16 ? `${text}:00Z` : `${text}Z`);
  if (!Number.isFinite(time)) return { ok: false, message: `${label}不是有效时间` };
  return { ok: true, value: text, time };
}

function intOf(value, min, max, label) {
  const num = Number(value);
  if (!Number.isInteger(num)) return { ok: false, message: `${label}必须是整数` };
  if (num < min || num > max) return { ok: false, message: `${label}应在 ${min}–${max} 之间` };
  return { ok: true, value: num };
}

/** 对外摘要：不把内部字段（版本、创建人等）全抛给页面。 */
function meetSummary(doc) {
  return {
    meetId: doc._id || doc.meetId,
    name: doc.name,
    year: doc.year,
    startDate: doc.startDate,
    endDate: doc.endDate,
    location: doc.location || '',
    status: doc.status,
    statusLabel: STATUS_LABEL[doc.status] || doc.status,
    // 「筹备中」只给管理员看：草稿对其他人根本不可见，但页面仍按角色收口，
    // 避免任何分享/截图把未发布的届次当成对外信息。
    isDraft: doc.status === MEET_STATUS.DRAFT,
    registration: doc.registration || null,
    eventCount: doc.eventCount || 0,
    createdAt: doc.createdAt || '',
    updatedAt: doc.updatedAt || '',
  };
}

function eventSummary(doc) {
  const template = getTemplate(doc.templateId);
  // 老数据只有 laneCount、没有 heatMode：按模板推导，避免读出空分批口径后
  // 页面把「长跑」误显示成「不分批」。老数据的 laneCount 视为每批人数。
  const heat = doc.heatMode
    ? { heatMode: doc.heatMode, heatCapacity: Number(doc.heatCapacity) || 0 }
    : (template
      ? {
        heatMode: template.heatMode || '',
        heatCapacity: Number(doc.laneCount) || template.heatCapacity || 0,
      }
      : { heatMode: '', heatCapacity: Number(doc.laneCount) || 0 });
  return {
    eventKey: doc._id,
    templateId: doc.templateId,
    name: doc.name || (template ? template.name : doc.templateId),
    category: doc.category || (template ? template.category : ''),
    categoryLabel: CATEGORY_LABEL[doc.category] || '',
    group: doc.group,
    scoreType: doc.scoreType,
    order: doc.order,
    unit: doc.unit,
    entryForm: doc.entryForm,
    members: doc.members,
    // 0 = 不限（页面据此显示「不限」而不是「0 人」）
    membersUnlimited: Number(doc.members) === 0,
    perCollegeLimit: doc.perCollegeLimit,
    limitUnlimited: Number(doc.perCollegeLimit) === 0,
    rounds: doc.rounds,
    // 赛制（仅胜负项目）：single_elim 单败淘汰 / round_robin 循环赛。空表示不适用。
    format: doc.format || '',
    formatLabel: FORMAT_LABEL[doc.format] || '',
    groups: doc.groups || null,
    // 分批口径：lane 按道数、capacity 按人数上限、single 不分批。
    // 老数据没有这两个字段时由上面的 heat 兜底推导。
    heatMode: heat.heatMode,
    heatCapacity: heat.heatCapacity,
    laneCount: Number(doc.laneCount) || 0,
    // 晋级口径（仅预赛+决赛）：{ mode, count }。空表示不适用。
    advance: doc.advance || null,
    scored: doc.scored,
    allowFinalOnly: doc.rounds === 'final',
  };
}

const isMeetDoc = (doc) => Boolean(doc && doc.status && doc.schoolId && doc.name);
const isAlive = (doc) => isMeetDoc(doc) && doc.status !== 'deleted';

/** 本届项目清单（按项目库顺序，便于页面稳定展示）。 */
async function listEventsOf(repo, ctx) {
  if (!ctx.meetId) return [];
  const docs = await listAliveEvents(repo.forMeet({ schoolId: ctx.schoolId, meetId: ctx.meetId }).sportsMeetEvents);
  const orderOf = new Map(TEMPLATES.map((item, index) => [item.id, index]));
  const groupWeight = { male: 0, female: 1, mixed: 2 };
  return docs
    .filter((doc) => doc.schoolId === ctx.schoolId && doc.meetId === ctx.meetId)
    .sort((a, b) => (orderOf.get(a.templateId) ?? 999) - (orderOf.get(b.templateId) ?? 999)
      || (groupWeight[a.group] ?? 9) - (groupWeight[b.group] ?? 9))
    .map(eventSummary);
}

/**
 * 发起运动会：只建草稿，且**不允许无项目地直接可报名**（R04 在发布时强制）。
 */
async function createSportsMeet(payload = {}, ctx) {
  if (!meetReadable(ctx)) return refused('请先登录');
  const name = textOf(payload.name, MEET_NAME_MAX, '运动会名称');
  if (!name.ok) return refused(name.message);
  const year = intOf(payload.year, YEAR_MIN, YEAR_MAX, '年份');
  if (!year.ok) return refused(year.message);
  const start = dateOf(payload.startDate, '开始日期');
  if (!start.ok) return refused(start.message);
  const end = dateOf(payload.endDate, '结束日期');
  if (!end.ok) return refused(end.message);
  if (end.time < start.time) return refused('结束日期不能早于开始日期');
  const location = String(payload.location == null ? '' : payload.location).trim();
  if (location.length > LOCATION_MAX) return refused(`地点不超过 ${LOCATION_MAX} 个字`);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以发起运动会');

    const meetId = newMeetId(fresh.schoolId, fresh.now);
    const existing = await tx.sportsMeets.getById(meetId);
    // 同一秒内重复点击：同一个人再点一次是幂等的，别人抢到同一个编号则报错重试。
    if (existing && existing.schoolId === fresh.schoolId) {
      if (existing.createdBy === fresh.actorId) return ok({ meet: meetSummary(existing), created: false });
      return refused('操作过于频繁，请稍后重试');
    }

    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      meetId,
      name: name.value,
      year: year.value,
      startDate: start.value,
      endDate: end.value,
      location,
      status: MEET_STATUS.DRAFT,
      registration: { openAt: '', closeAt: '' },
      eventCount: 0,
      createdBy: fresh.actorId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await tx.sportsMeets.set(meetId, doc);
    return ok({ meet: meetSummary(doc), created: true });
  });
}

/**
 * 设置某个项目的赛制与轮次（报名截止后的「编排」环节）。
 *
 * 【为什么不在创建时定】
 * 分几组、分几枪不是拍脑袋决定的：径赛一组最多 6 人（跑道数），有多少人报名
 * 才知道要跑几组。项目创建时报名还没开始，那时候让管理员选「预赛+决赛」只能
 * 靠猜。所以赛制推迟到报名截止后再定，此时人数已定，系统也能据此算出组数。
 *
 * 【允许改到什么时候】
 * 只要这个项目还没有场次、也没有发布过成绩就能改。一旦排了场次（抽签/分枪/
 * 签表），改赛制就会让已排的赛程与已录入的成绩对不上，所以此时拒绝。
 *
 * @param {Object} payload { eventKey, rounds, laneCount, advance, format, groups }
 */
async function setMeetEventProcedure(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');
  const scope = { schoolId: ctx.schoolId, meetId: ctx.meetId };

  const [event, sessions, publications] = await Promise.all([
    ctx.repo.forMeet(scope).sportsMeetEvents.getById(eventKey),
    ctx.repo.forMeet(scope).sportsMeetSessions.list(),
    ctx.repo.forMeet(scope).sportsMeetPublications.list(),
  ]);
  if (!event || event.meetId !== ctx.meetId) return refused('项目组别不存在或不属于本届运动会');
  const template = getTemplate(event.templateId);
  if (!template) return refused('项目模板不存在');

  const procedure = procedureOf(template, payload);
  if (!procedure.ok) return refused(procedure.message);

  if (sessions.some((doc) => doc.eventKey === eventKey)) {
    return refused('该项目已经排了场次，不能再改赛制；如需重排请先删除场次');
  }
  if (publications.some((doc) => doc.eventKey === eventKey)) {
    return refused('该项目已经发布过成绩，不能再改赛制');
  }

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以设置赛制');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAlive(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    const current = await tx.sportsMeetEvents.getById(eventKey);
    if (!current || current.meetId !== fresh.meetId) return refused('项目组别不存在或不属于本届运动会');

    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const next = {
      ...current,
      rounds: procedure.rounds,
      heatMode: procedure.heatMode,
      heatCapacity: procedure.heatCapacity,
      laneCount: procedure.laneCount,
      format: procedure.format,
      groups: procedure.groups,
      advance: procedure.advance,
      procedureSetAt: now,
      updatedAt: now,
    };
    await tx.sportsMeetEvents.set(eventKey, next);
    return ok({ event: eventSummary(next) });
  });
}

/**
 * 移除一个项目组别（仅草稿期）。
 *
 * 为什么不物理删除：报名、场次、成绩都按 eventKey 指过来，删文档会留下悬空引用。
 * 这里置 status='deleted'，并把 eventCount 减一；读取处统一走 listAliveEvents。
 * 草稿期还没有报名，所以不存在「删了却有人已报名」的情况——发布之后再删属于
 * 撤销发布流程（B8），不在本动作范围内。
 */
async function removeMeetEvent(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  const eventKey = String(payload.eventKey || '').trim();
  if (!eventKey) return refused('请指定项目组别');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以删除项目');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAlive(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (meet.status !== MEET_STATUS.DRAFT) return refused('已发布报名，不能再删除项目');

    const event = await tx.sportsMeetEvents.getById(eventKey);
    if (!event || event.meetId !== fresh.meetId) return refused('项目组别不存在或不属于本届运动会');
    if (event.status === MEET_EVENT_STATUS.DELETED) return ok({ eventKey, removed: false });

    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    await tx.sportsMeetEvents.set(eventKey, {
      ...event, status: MEET_EVENT_STATUS.DELETED, deletedAt: now, updatedAt: now,
    });
    const count = Math.max(0, Number(meet.eventCount || 0) - 1);
    await tx.sportsMeets.set(fresh.meetId, {
      ...meet, eventCount: count, updatedAt: now, version: (meet.version || 1) + 1,
    });
    return ok({ eventKey, removed: true, eventCount: count });
  });
}

/**
 * 代报时可选的学院（校管理员在学院报名工作台里选学院用）。
 *
 * 只给校级管理员及以上：学院部长只能报自己学院，不需要也不应该看到全院列表。
 */
async function listMeetColleges(payload = {}, ctx) {
  if (!meetReadable(ctx)) return refused('请先登录');
  if (!canManageMeet(ctx)) return refused('只有校级管理员及以上可以代报其他学院');

  const keyword = String(payload.keyword || '').trim();
  const docs = await ctx.repo.colleges.listBySchool(ctx.schoolId);
  const items = docs
    .filter((doc) => doc.schoolId === ctx.schoolId && doc.status !== 'inactive')
    .filter((doc) => (keyword ? String(doc.name || '').includes(keyword) : true))
    .map((doc) => ({ collegeId: doc.collegeId || doc._id, name: doc.name || '' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok({ items: items.slice(0, 50), total: items.length });
}

/** 改草稿基本资料；只有草稿可改（发布后改需规则版本，本批不做）。 */
async function updateMeetDraft(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  const name = payload.name === undefined ? null : textOf(payload.name, MEET_NAME_MAX, '运动会名称');
  if (name && !name.ok) return refused(name.message);
  const start = payload.startDate === undefined ? null : dateOf(payload.startDate, '开始日期');
  if (start && !start.ok) return refused(start.message);
  const end = payload.endDate === undefined ? null : dateOf(payload.endDate, '结束日期');
  if (end && !end.ok) return refused(end.message);
  const location = payload.location === undefined ? null : String(payload.location).trim();
  if (location && location.length > LOCATION_MAX) return refused(`地点不超过 ${LOCATION_MAX} 个字`);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以修改运动会');
    const doc = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAlive(doc) || doc.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (doc.status !== MEET_STATUS.DRAFT) return refused('已发布报名的运动会不能再改基本规则');

    const nextStart = start ? start.value : doc.startDate;
    const nextEnd = end ? end.value : doc.endDate;
    if (Date.parse(`${nextEnd}T00:00:00Z`) < Date.parse(`${nextStart}T00:00:00Z`)) {
      return refused('结束日期不能早于开始日期');
    }
    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const next = {
      ...doc,
      name: name ? name.value : doc.name,
      startDate: nextStart,
      endDate: nextEnd,
      location: location === null ? (doc.location || '') : location,
      updatedAt: now,
      version: (doc.version || 1) + 1,
    };
    await tx.sportsMeets.set(fresh.meetId, next);
    return ok({ meet: meetSummary(next) });
  });
}

/**
 * 赛制相关的校验：轮次、赛制、小组设置、晋级口径、每组人数。
 *
 * 抽出来是因为它有两个调用点：草稿期的 configureMeetEvent，以及报名截止后的
 * setMeetEventProcedure。两处必须用同一把尺子——否则同一个赛制在草稿期被拒、
 * 在编排期却能过，或者反过来。
 *
 * @returns {{ok:boolean, message?:string, rounds?:string, laneCount?:number,
 *   format?:string, groups?:object|null, advance?:object|null}}
 */
function procedureOf(template, payload = {}) {
  const isVersus = template.scoreType === MEET_SCORE_TYPE.VERSUS;
  const rounds = payload.rounds === undefined ? 'final' : String(payload.rounds);
  if (!['final', 'heat_final'].includes(rounds)) {
    return { ok: false, message: '轮次只能是直接决赛或预赛+决赛' };
  }
  if (rounds === 'heat_final' && isVersus) {
    return { ok: false, message: '胜负项目不支持预赛+决赛，请改用淘汰赛或循环赛' };
  }

  // 赛制：只有胜负项目有。默认单败淘汰——拔河、团体对抗绝大多数是这个赛制。
  // 双败本期未实现，这里当场拒绝：宁可配置失败，也不能按单败跑出一个看似合理、
  // 实际错误的名次（双败的第二名可能输过两场）。
  const format = isVersus ? String(payload.format || MEET_FORMAT.SINGLE_ELIM) : '';
  if (isVersus && !FORMAT_LABEL[format]) {
    return { ok: false, message: '胜负项目只支持单败淘汰、循环赛或小组+淘汰；双败本期未实现' };
  }

  // 小组+淘汰：小组赛打循环，每组前 N 出线后再打单败。
  let groups = null;
  if (format === MEET_FORMAT.GROUP_KNOCKOUT) {
    const count = Number((payload.groups && payload.groups.count) || 2);
    const advancePerGroup = Number((payload.groups && payload.groups.advancePerGroup) || 2);
    if (!Number.isInteger(count) || count < 2 || count > 8) return { ok: false, message: '小组数应为 2–8' };
    if (!Number.isInteger(advancePerGroup) || advancePerGroup < 1 || advancePerGroup > 4) {
      return { ok: false, message: '每组出线数应为 1–4' };
    }
    groups = { count, advancePerGroup };
  }

  // 晋级口径（D47）：三种都支持，逐项目选。只有预赛+决赛才有意义。
  let advance = null;
  if (rounds === 'heat_final') {
    const mode = String((payload.advance && payload.advance.mode) || ADVANCE_MODE.PER_HEAT);
    const count = Number((payload.advance && payload.advance.count) || 3);
    if (!Object.values(ADVANCE_MODE).includes(mode)) {
      return { ok: false, message: '晋级口径只能是每组前 N、总成绩前 N 或混合晋级' };
    }
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      return { ok: false, message: '晋级人数应为 1–50 的整数' };
    }
    advance = { mode, count };
  }

  // 分批口径按项目模板推导（Q1／Q3／Q4）：
  //   lane     → 一批 = 道数（分道跑，8 道场地一批 8 人/8 队）
  //   capacity → 一批 = 人数上限（不分道长跑 15、次数 10、趣味 6）
  //   single   → 不分批（田赛试跳、评分展示依次上场），只有一个场次
  //
  // 它决定的不是「一组几个人」这句描述，而是「报名人数除以几」：分几组/几枪
  // 由它算出来。所以它是赛制的一部分，放在报名截止后的编排阶段定。
  const heatMode = template.heatMode || null;
  let heatCapacity = 0;
  if (heatMode === HEAT_MODE.SINGLE) {
    // 田赛与展示类没有预赛：一个场次按抽签顺序进行到底
    if (rounds !== 'final') {
      return { ok: false, message: `${template.name}在一个场次内按顺序进行，不支持预赛+决赛` };
    }
  } else if (heatMode) {
    const fallback = Number(template.heatCapacity) || 6;
    // heatCapacity 是新字段；laneCount 是旧名，仍接受，避免旧页面调用直接报错
    const given = payload.heatCapacity !== undefined
      ? payload.heatCapacity
      : (payload.laneCount !== undefined ? payload.laneCount : fallback);
    const value = Number(given);
    if (!Number.isInteger(value)) return { ok: false, message: '每组人数应为整数' };
    if (heatMode === HEAT_MODE.LANE) {
      if (value < 2 || value > 20) {
        return { ok: false, message: '跑道数（每组人数）应为 2–20 的整数' };
      }
    } else if (value < 2 || value > 50) {
      return { ok: false, message: '每组人数上限应为 2–50 的整数' };
    }
    heatCapacity = value;
  }

  return {
    ok: true,
    rounds,
    heatMode,
    heatCapacity,
    // 兼容旧字段：只有分道项目才有「道数」，其余记 0（与旧语义一致）
    laneCount: heatMode === HEAT_MODE.LANE ? heatCapacity : 0,
    format,
    groups,
    advance,
  };
}

/**
 * 逐项目配置（N11／N12：组别、是否预决赛、每队人数、限额、是否计分都由这里定）。
 *
 * @param {Object} payload { templateId, group, members, perCollegeLimit, rounds, scored }
 */
async function configureMeetEvent(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  const template = getTemplate(payload.templateId);
  if (!template) return refused('项目不存在或未启用');
  const group = String(payload.group || '').trim();
  if (!['male', 'female', 'mixed'].includes(group)) return refused('请选择男子/女子/混合组别');

  const isMulti = template.entryForm === 'group' || template.entryForm === 'team';
  // members = 0 表示「人数不限」：入场式展示、团体操这类项目，各院上场人数由学院自定，
  // 系统只关心「有没有报」，不关心报了几个人（用户明确要这个口径）。
  const members = isMulti
    ? intOf(payload.members === undefined ? template.defaultMembers : payload.members, 0, 200, '每队（组）人数')
    : { ok: true, value: 1 };
  if (!members.ok) return refused(members.message);
  // 固定人数的项目不接受改人数（两人三足 2 人、三人板鞋 3 人）
  if (template.fixedMembers && payload.members !== undefined
    && Number(payload.members) !== template.fixedMembers) {
    return refused(`${template.name}必须 ${template.fixedMembers} 人一组`);
  }

  // perCollegeLimit = 0 表示「不限」：展示类项目常常不限每院队数
  const limit = intOf(payload.perCollegeLimit === undefined ? 1 : payload.perCollegeLimit, 0, 20, '每学院上限');
  if (!limit.ok) return refused(limit.message);
  // 单人项目默认上限 3（4.2），团体/接力 1 队，多人协作 3 组；显式传值优先。
  if (payload.perCollegeLimit === undefined && template.entryForm === 'single') {
    limit.value = 3;
  } else if (payload.perCollegeLimit === undefined && template.entryForm === 'group') {
    limit.value = 3;
  } else if (payload.perCollegeLimit === undefined) {
    limit.value = 1;
  }

  const procedure = procedureOf(template, payload);
  if (!procedure.ok) return refused(procedure.message);
  const scored = payload.scored === undefined ? template.defaultScored : Boolean(payload.scored);

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以配置项目');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAlive(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (meet.status !== MEET_STATUS.DRAFT) return refused('已发布报名，不能再改项目配置');

    const key = meetEventKey(fresh.meetId, template.id, group);
    const existing = await tx.sportsMeetEvents.getById(key);
    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const doc = {
      schoolId: fresh.schoolId,
      meetId: fresh.meetId,
      templateId: template.id,
      name: template.name,
      category: template.category,
      group,
      scoreType: template.scoreType,
      order: template.order,
      unit: template.unit,
      entryForm: template.entryForm,
      members: members.value,
      perCollegeLimit: limit.value,
      rounds: procedure.rounds,
      heatMode: procedure.heatMode,
      heatCapacity: procedure.heatCapacity,
      laneCount: procedure.laneCount,
      format: procedure.format,
      groups: procedure.groups,
      advance: procedure.advance,
      scored,
      createdAt: existing ? (existing.createdAt || now) : now,
      updatedAt: now,
    };
    await tx.sportsMeetEvents.set(key, doc);

    // 项目数按「事件条数」累加：同一项目组别重复配置是覆盖，不重复计数。
    const count = Number(meet.eventCount || 0) + (existing ? 0 : 1);
    await tx.sportsMeets.set(fresh.meetId, {
      ...meet, eventCount: count, updatedAt: now, version: (meet.version || 1) + 1,
    });
    return ok({ event: eventSummary(doc), eventCount: count });
  });
}

/** 发布报名：必须有项目、必须有合法报名窗口（R04）。 */
async function publishMeetRegistration(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');

  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以发布报名');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAlive(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (meet.status !== MEET_STATUS.DRAFT) return refused('只有筹备中的运动会可以发布报名');

    // 事务内不能查集合，所以项目清单在事务外先读一次，事务内只点读校验数量。
    const openAt = timeOf(payload.openAt === undefined ? (meet.registration || {}).openAt : payload.openAt, '报名开始时间');
    if (!openAt.ok) return refused(openAt.message);
    const closeAt = timeOf(payload.closeAt === undefined ? (meet.registration || {}).closeAt : payload.closeAt, '报名截止时间');
    if (!closeAt.ok) return refused(closeAt.message);
    if (closeAt.time <= openAt.time) return refused('报名截止时间必须晚于开始时间');
    // R04：不能创建/发布一个没有项目的空运动会。计数在草稿期维护，事务内点读即可。
    if (Number(meet.eventCount || 0) < 1) return refused('请先至少选择一个项目再发布报名');

    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    const next = {
      ...meet,
      status: MEET_STATUS.REGISTRATION,
      registration: { openAt: openAt.value, closeAt: closeAt.value },
      publishedAt: now,
      updatedAt: now,
      version: (meet.version || 1) + 1,
    };
    await tx.sportsMeets.set(fresh.meetId, next);
    return ok({ meet: meetSummary(next) });
  });
}

/** 列表：草稿仅管理者可见；进行中置顶；支持名称/年份/状态/学院筛选与分页。 */
async function listSportsMeets(payload = {}, ctx) {
  const fresh = await buildMeetContext({
    repo: ctx.repo, actorId: ctx.actorId,
    scope: { schoolId: ctx.schoolId }, now: ctx.now,
  });
  if (!meetReadable(fresh)) return refused('请先登录');

  const keyword = String(payload.keyword || '').trim();
  const year = payload.year === undefined || payload.year === '' ? null : Number(payload.year);
  const status = String(payload.status || '').trim();
  const collegeId = String(payload.collegeId || '').trim();
  const limit = Math.min(Math.max(Number(payload.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  const offset = Math.max(Number(payload.offset) || 0, 0);
  const canManage = canManageMeet(fresh);

  const all = await ctx.repo.sportsMeets.listBySchool(fresh.schoolId);
  let items = all
    .filter((doc) => isAlive(doc) && doc.schoolId === fresh.schoolId)
    .filter((doc) => canManage || doc.status !== MEET_STATUS.DRAFT)
    .filter((doc) => (keyword ? String(doc.name).includes(keyword) : true))
    .filter((doc) => (year === null || doc.year === year))
    .filter((doc) => (status ? doc.status === status : true));

  // 学院筛选：按「本届学院范围」的确定性主键点读，不做整表扫描。
  if (collegeId) {
    const checked = [];
    for (const doc of items) {
      const row = await ctx.repo.sportsMeetColleges.getById(meetCollegeKey(doc._id || doc.meetId, collegeId));
      if (row && row.schoolId === fresh.schoolId) checked.push(doc);
    }
    items = checked;
  }

  items.sort((a, b) => (STATUS_WEIGHT[a.status] ?? 9) - (STATUS_WEIGHT[b.status] ?? 9)
    || String(b.startDate).localeCompare(String(a.startDate)));

  return ok({
    total: items.length,
    offset,
    limit,
    // 页面据此决定要不要显示「发起运动会」——权限由服务端算，客户端不自己猜。
    permissions: { canManage },
    items: items.slice(offset, offset + limit).map(meetSummary),
  });
}

/** 详情：草稿只有管理者能看；同时给出本届项目清单与我的权限标记。 */
async function getSportsMeet(payload = {}, ctx) {
  const fresh = await buildMeetContext({
    repo: ctx.repo, actorId: ctx.actorId,
    scope: { schoolId: ctx.schoolId, meetId: ctx.meetId || payload.meetId }, now: ctx.now,
  });
  if (!meetReadable(fresh)) return refused('请先登录');
  if (!fresh.meetId) return refused('请指定运动会');

  const met = await ctx.repo.sportsMeets.getById(fresh.meetId);
  if (!isAlive(met) || met.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');

  const canManage = canManageMeet(fresh);
  if (met.status === MEET_STATUS.DRAFT && !canManage) return refused('运动会尚未发布');

  const lead = fresh.schoolMember && fresh.schoolMember.collegeId
    ? await ctx.repo.sportsMeetCollegeLeads.getById(meetCollegeLeadKey(fresh.schoolId, fresh.schoolMember.collegeId))
    : null;
  const collegeId = lead && isActiveMeetLead(lead) && lead.userId === fresh.actorId ? lead.collegeId : '';

  return ok({
    meet: meetSummary(met),
    events: await listEventsOf(ctx.repo, fresh),
    permissions: { canManage, collegeId },
  });
}

/**
 * 项目模板搜索：不依赖届次，供创建向导使用。
 *
 * 名字用 list 前缀（不是 search）：学校维度的读动作一律以 get / list 起头，
 * 这是 tests/school-write-guard.test.js 用来区分读写的唯一判据。叫 search 会被
 * 判成写动作，进而套上「故障收敛成 {ok:false}」的守卫——读失败就会被伪装成空列表。
 */
async function listSportsEventTemplates(payload = {}, ctx) {
  if (!meetReadable(ctx)) return refused('请先登录');
  const keyword = String(payload.keyword || '').trim();
  const category = String(payload.category || '').trim();
  const items = searchTemplates(keyword, { category }).map((item) => ({
    templateId: item.id,
    name: item.name,
    category: item.category,
    categoryLabel: CATEGORY_LABEL[item.category],
    scoreType: item.scoreType,
    order: item.order,
    unit: item.unit,
    entryForm: item.entryForm,
    defaultMembers: item.defaultMembers,
    fixedMembers: item.fixedMembers,
    recommendedGroups: [...item.recommendedGroups],
    defaultScored: item.defaultScored,
  }));
  return ok({
    total: items.length,
    items,
    categories: CATEGORY_ORDER.map((key) => ({ category: key, label: CATEGORY_LABEL[key] })),
  });
}

/** 删除：本批只允许删草稿；已发布的一律走后续批次的撤销流程（B8）。 */
async function deleteSportsMeet(payload = {}, ctx) {
  if (!ctx.meetId) return refused('请指定运动会');
  return ctx.repo.transaction(async (tx) => {
    const fresh = await freshMeetContext(tx, ctx);
    if (!canManageMeet(fresh)) return refused('只有校级管理员及以上可以删除运动会');
    const meet = await tx.sportsMeets.getById(fresh.meetId);
    if (!isAlive(meet) || meet.schoolId !== fresh.schoolId) return refused('运动会不存在或已删除');
    if (meet.status !== MEET_STATUS.DRAFT) {
      return refused('已发布报名的运动会不能直接删除，请使用撤销发布');
    }
    const now = fresh.now instanceof Date ? fresh.now.toISOString() : String(fresh.now);
    await tx.sportsMeets.set(fresh.meetId, {
      ...meet, status: 'deleted', deletedAt: now, updatedAt: now, version: (meet.version || 1) + 1,
    });
    return ok({ meetId: fresh.meetId });
  });
}

module.exports = {
  createSportsMeet,
  setMeetEventProcedure,
  removeMeetEvent,
  listMeetColleges,
  updateMeetDraft,
  configureMeetEvent,
  publishMeetRegistration,
  listSportsMeets,
  getSportsMeet,
  listSportsEventTemplates,
  deleteSportsMeet,
};
