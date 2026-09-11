/**
 * 赛事 —— 权限、表单校验、报名与名次
 * ============================================================
 * 赛事页要回答的问题，答案全在这里：
 *   1. 我能不能发赛事？（发布权）
 *   2. 我填的这张赛事单子能不能发出去？（表单校验）
 *   3. 我能不能报名 / 取消这一场？（报名判定）
 *   4. 我能不能开始、签到、录入名次？（管理端代签）
 *   5. 这一串名次存不存在自相矛盾？（名次校验）
 *
 * 【为什么单独成模块】
 * 与 match-record.js / announcement.js 同一套路数：这些都是纯判断，
 * 不碰 wx、不碰数据源。放进页面里就只能靠点真机验证，放进 mock.js 又会被
 * 卷进「哪些赛事该列出来」的取数逻辑里。单独拿出来，每一条边界都能用
 * 字面量在 Node 里钉死。
 *
 * 【发布权为什么与审核权共用一套判定】
 * 「谁能管这件事」在本项目里已经出现多处：审核入会、发布公告、管理赛季、
 * 发布赛事。规则一字不差，只是管的事不同，所以判定抽在 permission.js，
 * 这里只声明自己需要的门槛——不另抄一遍，免得两处口径慢慢分叉。
 *
 * 【三四名赛为什么只是一个字段】
 * 两种办赛方式只差「第 4 名有没有人」：并列时两个半决赛负者都记第 3 名，
 * 打三四名时一人 3 一人 4。名次录入与积分结算因此共用一条通路，只在保存
 * 时按下表校验一次名次是否成对，见 validatePlacements。
 * ============================================================
 */

const {
  MATCH_TYPE,
  MATCH_TYPE_LABEL,
  MATCH_TYPE_TO_POOL,
  EVENT_STATUS,
  EVENT_STATUS_LABEL,
  EVENT_LEVEL,
  EVENT_LEVEL_LABEL,
  EVENT_BRONZE_MODE,
  EVENT_BRONZE_MODE_LABEL,
  DEFAULT_BRONZE_MODE,
  SIGNUP_STATUS,
  SIGNUP_STATUS_LABEL,
  isRankable,
} = require('../utils/constants.js');
const { formatDateTime } = require('../utils/format.js');
const { canManage, isActive } = require('./permission.js');

/** 标题长度下限与上限 */
const TITLE_MIN = 2;
const TITLE_MAX = 30;
/** 说明文字长度上限 */
const DESCRIPTION_MAX = 200;
/** 场地长度上限 */
const LOCATION_MAX = 40;

/** 校验顺序即表单顺序，取「第一条错误」时按它走 */
const FIELD_ORDER = [
  'title',
  'description',
  'matchType',
  'level',
  'bronzeMode',
  'startTime',
  'location',
  'quota',
];

/** 合法的赛事等级集合，用于「必须显式选择」的判定 */
const VALID_LEVELS = Object.values(EVENT_LEVEL);
/** 合法的三四名赛方式集合 */
const VALID_BRONZE_MODES = Object.values(EVENT_BRONZE_MODE);

/* ============================================================
 * 权限
 * ============================================================ */

/**
 * 有没有发布 / 管理赛事的资格。
 *
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false] 演示数据源下放宽为「是会员即可」
 * @returns {boolean}
 */
function canManageEvent(actor, options = {}) {
  return canManage(actor, options);
}

/**
 * 能不能开始一场赛事（报名中 → 进行中）。
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canStartEvent(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  return canManageEvent(actor, options);
}

/**
 * 能不能给某位会员代签。
 *
 * 【为什么只有管理端能签】
 * 决策 4：不做会员自助签到。签到是赛事当天「人到了没有」的凭证，
 * 若本人能点，报名与签到就都成了自说自话，名次与积分的公信力也就没了。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canCheckIn(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.ONGOING) return false;
  return canManageEvent(actor, options);
}

/**
 * 能不能录入名次并结束赛事（进行中 → 已结束）。
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @returns {boolean}
 */
function canFinishEvent(event, actor, options = {}) {
  if (!event || event.status !== EVENT_STATUS.ONGOING) return false;
  return canManageEvent(actor, options);
}

/**
 * 能不能报名这一场。
 *
 * 【为什么离校的人不能报名】
 * 决策 11：离校后不可报名。报名是「我还会来打」的承诺，离校的人给不了
 * 这个承诺。但注意挡的是「报名」，不是「看」——他的历史成绩仍在个人页
 * 与赛事成绩里。这一条与 isRankable 同一把尺子，别处别再抄一遍。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {Object|null} [options.signup] 该会员在这场比赛里已有的报名记录
 * @returns {boolean}
 */
function canSignUp(event, actor, options = {}) {
  const { signup = null } = options;

  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  // 离校的人不能报名——但挡的是「报名」，不是「看」，他的旧成绩仍在
  if (!isRankable(actor)) return false;
  // 待审核 / 已禁用 / 未登录同样不行：还没转正的人不能承诺到场
  if (!isActive(actor)) return false;
  // 已报名或已签到的，报名按钮不该再出现
  if (signup && signup.status !== SIGNUP_STATUS.CANCELED) return false;

  // 名额满了就不放人进来；未设名额（0 / 缺省）视为不限
  const quota = Number(event.quota) || 0;
  if (quota > 0 && signupCountOf(event, options.signups) >= quota && !signup) return false;

  return true;
}

/**
 * 能不能取消报名。
 * 只有「报名中」阶段能撤，且确实存在一条有效报名记录。
 *
 * @param {Object} event
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {Object|null} [options.signup] 该会员已有的报名记录
 * @returns {boolean}
 */
function canCancelSignup(event, actor, options = {}) {
  const { signup = null } = options;

  if (!event || event.status !== EVENT_STATUS.SIGNUP) return false;
  if (!actor || !actor._id) return false;
  if (!signup || signup.userId !== actor._id) return false;

  return signup.status === SIGNUP_STATUS.SIGNED;
}

/* ============================================================
 * 报名记录
 * ============================================================ */

/** 把报名列表收敛成数组，顺手兼容「传对象」的调用方 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 统计一场赛事里有效报名的人数。
 * 已取消的不算——名额是给要来的人留的。
 *
 * @param {Object} event
 * @param {Array<Object>} [signups] 报名记录
 * @returns {number}
 */
function signupCountOf(event, signups) {
  const list = asArray(signups).length > 0 ? signups : asArray(event && event.signups);
  return list.filter((item) => item.status !== SIGNUP_STATUS.CANCELED).length;
}

/**
 * 在报名列表里找出某位会员的那一条。
 * @param {Array<Object>} signups
 * @param {string} userId
 * @returns {Object|null}
 */
function signupOf(signups, userId) {
  if (!userId) return null;
  return asArray(signups).find((item) => item.userId === userId) || null;
}

/**
 * 组装一条报名记录。
 *
 * 幂等靠自然键：同一人同一赛事永远只有一条记录（见 idempotency.js 的
 * signupNaturalKey）。取消不删除，只把状态置为 CANCELED——「报了多少人、
 * 退了多少人」有据可查，重新报名也能翻回同一条。
 *
 * @param {Object} event
 * @param {Object} actor 报名者
 * @param {Object} [ctx]
 * @param {Date|string|number} [ctx.now=new Date()] 报名时间，注入以便测试固定
 * @returns {{ok:boolean, record:Object|null, message:string}}
 */
function buildSignupRecord(event, actor, ctx = {}) {
  const { now = new Date() } = ctx;

  if (!event || !event._id) {
    return { ok: false, record: null, message: '赛事不存在' };
  }
  if (!actor || !actor._id) {
    return { ok: false, record: null, message: '请先登录' };
  }
  if (event.status !== EVENT_STATUS.SIGNUP) {
    return { ok: false, record: null, message: '报名已经截止了' };
  }
  if (!isRankable(actor)) {
    return { ok: false, record: null, message: '已离校的会员不能报名赛事' };
  }
  if (!isActive(actor)) {
    return { ok: false, record: null, message: '账号尚未通过审核，暂时不能报名' };
  }

  return {
    ok: true,
    record: {
      eventId: event._id,
      userId: actor._id,
      status: SIGNUP_STATUS.SIGNED,
      signTime: now,
      checkInTime: null,
      // 代签时用来追溯「谁签的」，本人报名时就是自己
      actorId: actor._id,
    },
    message: '',
  };
}

/**
 * 生成一条签到的改判。
 *
 * 不改 signTime：报名时间与到场时间是两件事，混在一起就再也分不出
 * 「什么时候报的名」。
 *
 * @param {Object} signup 既有报名记录
 * @param {Object} actor 代签的干事
 * @param {Object} [ctx]
 * @param {Date|string|number} [ctx.now=new Date()]
 * @returns {{ok:boolean, patch:Object|null, message:string}}
 */
function buildCheckInPatch(signup, actor, ctx = {}) {
  const { now = new Date() } = ctx;

  if (!signup) {
    return { ok: false, patch: null, message: '这位会员还没报名' };
  }
  if (signup.status === SIGNUP_STATUS.CANCELED) {
    return { ok: false, patch: null, message: '这位会员已经取消报名了' };
  }
  if (signup.status === SIGNUP_STATUS.CHECKED_IN) {
    return { ok: false, patch: null, message: '这位会员已经签过到了' };
  }

  return {
    ok: true,
    patch: {
      status: SIGNUP_STATUS.CHECKED_IN,
      checkInTime: now,
      actorId: actor ? actor._id : '',
    },
    message: '',
  };
}

/* ============================================================
 * 发布表单
 * ============================================================ */

/**
 * 去掉各项首尾空格、把数字收敛成数字、把日期收敛成 Date。
 *
 * @param {Object} [form]
 * @returns {Object}
 */
function normalizeDraft(form) {
  const source = form && typeof form === 'object' ? form : {};
  const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
  const int = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : NaN;
  };

  return {
    title: text(source.title),
    description: text(source.description),
    // 数字枚举：'' 变成 null，交给校验去说「请选择」，而不是悄悄当成 0
    matchType: int(source.matchType),
    level: int(source.level),
    bronzeMode: text(source.bronzeMode),
    location: text(source.location),
    startTime: source.startTime ? new Date(source.startTime) : null,
    // 名额：未填视为不限（0）
    quota: int(source.quota) === null ? 0 : int(source.quota),
  };
}

/**
 * 校验一张赛事草稿。
 *
 * 【为什么等级与三四名赛方式必须显式选】
 * 决策 13 / 8：两者都直接影响积分怎么算（等级决定倍数，三四名赛决定
 * 有没有第 4 名）。若允许留空再取默认值，一次「忘了选」就会静默改变
 * 全场的分数，而且事后无法从记录里看出当初选过没有。所以缺失即报错，
 * 默认值只由界面预填，落库的必须是用户确认过的。
 *
 * @param {Object} [form] 原始表单，内部会先做 normalize
 * @returns {{ok:boolean, draft:Object, errors:Object<string,string>, firstError:string}}
 */
function validateEvent(form = {}) {
  const draft = normalizeDraft(form);
  const errors = {};

  if (draft.title.length < TITLE_MIN || draft.title.length > TITLE_MAX) {
    errors.title = `赛事名称需为 ${TITLE_MIN}~${TITLE_MAX} 个字`;
  }

  if (!MATCH_TYPE_TO_POOL[draft.matchType]) {
    errors.matchType = '请选择单打或双打';
  }

  if (!VALID_LEVELS.includes(draft.level)) {
    errors.level = '请选择赛事等级';
  }

  if (!VALID_BRONZE_MODES.includes(draft.bronzeMode)) {
    errors.bronzeMode = '请选择三四名赛方式';
  }

  if (draft.description.length > DESCRIPTION_MAX) {
    errors.description = `赛事说明最多 ${DESCRIPTION_MAX} 个字`;
  }

  if (!draft.startTime || Number.isNaN(draft.startTime.getTime())) {
    errors.startTime = '请选择赛事时间';
  }

  if (draft.location.length > LOCATION_MAX) {
    errors.location = `场地最多 ${LOCATION_MAX} 个字`;
  }

  if (!Number.isFinite(draft.quota) || draft.quota < 0) {
    errors.quota = '名额必须是不小于 0 的整数';
  }

  const firstFailed = FIELD_ORDER.find((field) => errors[field]);

  return {
    ok: !firstFailed,
    draft,
    errors,
    firstError: firstFailed ? errors[firstFailed] : '',
  };
}

/**
 * 由草稿组装一条可落库的赛事记录。
 *
 * 记录里带 publisherId / publisherName：赛事是「谁办的」在管理台账里必须
 * 能追溯，出了问题才知道该找谁核实。这与公告带 publisher、比赛带 recorder 同理。
 *
 * @param {Object} form 赛事表单
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 发布者
 * @param {Date} [ctx.now=new Date()] 发布时间，注入以便测试固定
 * @returns {{ok:boolean, record:Object|null, errors:Object, firstError:string}}
 */
function buildEventRecord(form, ctx = {}) {
  const { actor = null, now = new Date() } = ctx;
  const validation = validateEvent(form);

  if (!validation.ok) {
    return { ok: false, record: null, errors: validation.errors, firstError: validation.firstError };
  }

  const { draft } = validation;
  return {
    ok: true,
    record: {
      title: draft.title,
      description: draft.description,
      matchType: draft.matchType,
      // 池必须跟着记录一起写死：漏了会被按池过滤的查询静默漏掉，
      // 赛事发出去却哪儿都查不到，是最难排查的一类问题
      pool: MATCH_TYPE_TO_POOL[draft.matchType],
      level: draft.level,
      bronzeMode: draft.bronzeMode,
      location: draft.location,
      startTime: draft.startTime,
      quota: draft.quota,
      status: EVENT_STATUS.SIGNUP,
      // 名次在赛事结束后才录入，这里先占好位置，读的时候不必判 undefined
      results: [],
      publishTime: now,
      publisherId: actor ? actor._id : '',
      // 昵称逐层兜底：注册资料里昵称可能没填，绝不落库一个空字符串
      publisherName: actor ? actor.nickName || actor.realName || actor._id : '',
    },
    errors: {},
    firstError: '',
  };
}

/* ============================================================
 * 名次录入
 * ============================================================ */

/**
 * 校验并整形成一个赛事的名次表。
 *
 * 【为什么在这里判成对而不是在积分里判】
 * 积分只看单个人的 placement（见 points.js），它无从知道「季军是不是
 * 并列」。若不在录入时挡一道，就会出现「并列模式却有人拿了第 4 名」
 * 这种记录——分数照算，但名次表自相矛盾，事后无法解释。
 *
 * 规则：
 *   - 名次必须是正整数，且每人只出现一次；
 *   - 一场赛事有且只有一位冠军，亚军至多一位；
 *   - 并列季军：不出现第 4 名；
 *   - 打三四名：第 3 名与第 4 名成对出现，且各至多一位。
 *
 * @param {Array<Object>} results [{ userId, placement }]
 * @param {Object} [options]
 * @param {string} [options.bronzeMode] 取值见 constants.EVENT_BRONZE_MODE
 * @returns {{ok:boolean, results:Array<Object>, errors:Object, firstError:string}}
 */
function validatePlacements(results, options = {}) {
  const bronzeMode = VALID_BRONZE_MODES.includes(options.bronzeMode)
    ? options.bronzeMode
    : DEFAULT_BRONZE_MODE;

  const list = asArray(results);
  if (list.length === 0) {
    const message = '请录入参赛者的名次';
    return { ok: false, results: [], errors: { results: message }, firstError: message };
  }

  const normalized = [];
  const seen = new Set();
  for (const item of list) {
    const userId = item && item.userId ? String(item.userId) : '';
    const placement = Number(item && item.placement);
    if (!userId || !Number.isInteger(placement) || placement < 1 || seen.has(userId)) {
      const message = '名次必须对应到人：每人只记一次，名次为正整数';
      return { ok: false, results: [], errors: { results: message }, firstError: message };
    }
    seen.add(userId);
    normalized.push({ userId, placement });
  }

  const countOf = (place) => normalized.filter((row) => row.placement === place).length;

  let message = '';
  if (countOf(1) !== 1) {
    message = '一场赛事有且只有一位冠军';
  } else if (countOf(2) > 1) {
    message = '亚军只能有一位';
  } else if (bronzeMode === EVENT_BRONZE_MODE.TIED && countOf(4) > 0) {
    message = '并列季军模式下不应出现第 4 名';
  } else if (bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && countOf(3) !== countOf(4)) {
    message = '打三四名模式下，第 3 名与第 4 名必须成对出现';
  } else if (bronzeMode === EVENT_BRONZE_MODE.PLAYOFF && countOf(3) > 1) {
    message = '打三四名模式下第 3 名只能有一位';
  }

  if (message) {
    return { ok: false, results: [], errors: { results: message }, firstError: message };
  }

  return { ok: true, results: normalized, errors: {}, firstError: '' };
}

/* ============================================================
 * 展示整形
 * ============================================================ */

/** 等级文案，缺省按三级（历史 / 种子赛事没有该字段） */
function levelLabelOf(event) {
  const level = event && event.level;
  return EVENT_LEVEL_LABEL[level] || EVENT_LEVEL_LABEL[EVENT_LEVEL.THIRD];
}

/** 三四名赛方式文案，缺省按并列（历史 / 种子赛事正是并列口径） */
function bronzeLabelOf(event) {
  const mode = event && event.bronzeMode;
  return EVENT_BRONZE_MODE_LABEL[mode] || EVENT_BRONZE_MODE_LABEL[DEFAULT_BRONZE_MODE];
}

/** 状态文案，缺省按已结束（种子赛事写死 2） */
function statusLabelOf(event) {
  const status = event && event.status;
  return EVENT_STATUS_LABEL[status] || EVENT_STATUS_LABEL[EVENT_STATUS.FINISHED];
}

/**
 * 会员在这场比赛里的报名状态。
 * @param {Object|null} signup
 * @returns {{status:number|null, label:string, signed:boolean, checkedIn:boolean}}
 */
function signupStateOf(signup) {
  if (!signup) {
    return { status: null, label: '未报名', signed: false, checkedIn: false };
  }
  // 签到了必然报过名，所以 signed 对两者都为真：它说的是「有一条有效报名」，
  // 而不是「恰好停在已报名这一步」。名次录入要的正是前者。
  return {
    status: signup.status,
    label: SIGNUP_STATUS_LABEL[signup.status] || '未报名',
    signed: signup.status === SIGNUP_STATUS.SIGNED || signup.status === SIGNUP_STATUS.CHECKED_IN,
    checkedIn: signup.status === SIGNUP_STATUS.CHECKED_IN,
  };
}

/**
 * 整形赛事列表的一行。
 *
 * 与 announcement.buildAnnouncementRow 同一约定：把权限算进数据里，
 * 模板只照着渲染按钮，不写 `wx:if="{{viewer.role >= 1}}"` 这类业务判断
 * ——那种写法 Node 跑不了，等于没法测。
 *
 * @param {Object} event 一条赛事
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @param {Array<Object>} [ctx.signups] 这场赛事的报名记录
 * @param {boolean} [ctx.isMock=false] 是否放宽管理权
 * @returns {Object}
 */
function buildEventRow(event, ctx = {}) {
  const { actor = null, signups = [], isMock: mock = false } = ctx;

  const mySignup = signupOf(signups, actor ? actor._id : null);
  const state = signupStateOf(mySignup);
  const count = signupCountOf(event, signups);
  const quota = Number(event && event.quota) || 0;

  return {
    id: event._id,
    // 逐层兜底，绝不渲染出 undefined
    title: event.title || '（未命名赛事）',
    description: event.description || '',
    matchTypeLabel: MATCH_TYPE_LABEL[event.matchType] || '',
    isDoubles: event.matchType === MATCH_TYPE.DOUBLES,
    levelLabel: levelLabelOf(event),
    bronzeLabel: bronzeLabelOf(event),
    status: event.status,
    statusLabel: statusLabelOf(event),
    isSignup: event.status === EVENT_STATUS.SIGNUP,
    isOngoing: event.status === EVENT_STATUS.ONGOING,
    isFinished: event.status === EVENT_STATUS.FINISHED,
    timeText: formatDateTime(event.startTime),
    location: event.location || '',
    signupCount: count,
    quotaText: quota > 0 ? `${count}/${quota} 人` : `${count} 人`,
    mySignupLabel: state.label,
    signedUp: state.signed,
    checkedIn: state.checkedIn,
    // 本人报名 / 退赛；离校者、报名截止后都会自动为 false
    canSignUp: canSignUp(event, actor, { signup: mySignup, signups }),
    canCancelSignup: canCancelSignup(event, actor, { signup: mySignup }),
    // 管理端按钮
    canStart: canStartEvent(event, actor, { isMock: mock }),
    canCheckIn: canCheckIn(event, actor, { isMock: mock }),
    canFinish: canFinishEvent(event, actor, { isMock: mock }),
  };
}

/**
 * 整形报名名单的一行（用于签到与名次录入）。
 *
 * @param {Object} signup 报名记录
 * @param {Object} [member] 会员档案，取昵称头像
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @returns {Object}
 */
function buildSignupRow(signup, member, ctx = {}) {
  const { actor = null } = ctx;
  const state = signupStateOf(signup);
  const profile = member || {};

  return {
    userId: signup.userId,
    nickName: profile.nickName || signup.userId,
    avatarUrl: profile.avatarUrl || '',
    statusLabel: state.label,
    checkedIn: state.checkedIn,
    isMe: Boolean(actor && actor._id === signup.userId),
  };
}

module.exports = {
  TITLE_MIN,
  TITLE_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  VALID_LEVELS,
  VALID_BRONZE_MODES,
  canManageEvent,
  canStartEvent,
  canCheckIn,
  canFinishEvent,
  canSignUp,
  canCancelSignup,
  signupCountOf,
  signupOf,
  buildSignupRecord,
  buildCheckInPatch,
  normalizeDraft,
  validateEvent,
  buildEventRecord,
  validatePlacements,
  levelLabelOf,
  bronzeLabelOf,
  statusLabelOf,
  signupStateOf,
  buildEventRow,
  buildSignupRow,
};
