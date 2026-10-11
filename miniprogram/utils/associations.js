/**
 * 协会注册表（多协会的唯一真相源）
 * ============================================================
 * 一个小程序承载校内多个体育协会：匹克球、乒乓球、羽毛球……将来还可能继续加。
 * 各协会「功能完全一致」，差异只有两处：
 *   1. 品牌——名称、简称、图标字、主题色；
 *   2. 少数规则默认值——赛制选项/默认、Elo 锚点、防刷阈值。
 * 这两处都写在这里。业务代码只按当前协会的 id 泛化处理，永远不判断
 * 「是不是匹克球/乒乓/羽毛」，也不写死数量。
 *
 * 【为什么协会是代码而不是数据库】
 * 新增一个协会，必然要有人定它的名称与配色——这本就是一次前端改动。与其
 * 为此建一整套后台增删 + 数据集合，不如把清单放进代码：新增协会 = 在这里
 * 加一条并配品牌，然后发版。加第 N 个协会时，数据、业务逻辑、云端接口都
 * 不用动（隔离靠内容文档上的 association 字段，见施工方案 §四）。
 *
 * 【为什么账号不带协会、内容和角色才带】
 * 账号按 OpenID 全局唯一（注册一次即可）；「是不是某协会的会员」是隐式的
 * （账号在册 + 协会启用），不逐条登记；只有比赛/赛事/公告/学院赛等内容数据
 * 带 association 字段（读过滤、写盖章），以及 memberships 里记协会角色。
 *
 * 【镜像】
 * 本模块是纯计算模块（不碰 wx、不碰 I/O），云端要用同一份清单来校验请求
 * 里的 association 并落地字段，因此列入 tools/sync-cloud-lib.js 的 MANIFEST，
 * 由 tests/cloud-lib-sync.test.js 逐字节守卫。
 * ============================================================
 */

const { DEFAULT_CONFIG } = require('./elo.js');
const { GAME_POINTS_OPTIONS, BEST_OF_OPTIONS, DEFAULT_FORMAT } = require('./match-format.js');
const { RATED_PAIR_LIMIT, ASSOCIATION_STATUS } = require('./constants.js');

/**
 * 各协会共用的规则默认值。
 *
 * 本期所有协会都沿用现有默认（赛制 11 分制三局两胜、Elo 锚点 1450、防刷 15 场），
 * 与改造前的行为一致。以后若某个协会要单独调，直接在该协会条目里覆盖同名字段即可。
 * 返回新对象，避免各条目之间共享同一份可变引用。
 *
 * @returns {{format: Object, elo: Object, ratedPairLimit: number}}
 */
function baseRules() {
  return {
    format: {
      gamePointsOptions: GAME_POINTS_OPTIONS.slice(),
      bestOfOptions: BEST_OF_OPTIONS.slice(),
      defaultFormat: { ...DEFAULT_FORMAT },
    },
    elo: { ...DEFAULT_CONFIG },
    ratedPairLimit: RATED_PAIR_LIMIT,
  };
}

/**
 * 协会清单。数组顺序即选择页展示顺序；首个启用中的协会是兜底默认。
 *
 * 【字段】
 *   id            写进内容文档的 association 字段，也是 memberships 的协会标识；
 *                 一旦上线不可改（改了等于把历史数据指向别的协会）。
 *   name          全称，用于选择页与页内大标题。
 *   shortName     简称，用于导航栏标题等窄处。
 *   sportName     项目名（三字），用于协会切换徽章、公告页协会标签等极窄处。
 *   logoGlyph     文字徽标（一个汉字），当前首页只用文字徽标、不用图片资源。
 *   theme         主题色，配合 app.wxss 的 .assoc-<id> 覆盖 CSS 变量。
 *   format/elo/…  规则默认值，见 baseRules()。
 *   status        启用/停用；停用保留历史数据，见 ASSOCIATION_STATUS。
 *
 * 【按 N 个设计】增删协会只动这个数组，不牵动数据与业务逻辑。
 */
const ASSOCIATIONS = [
  {
    id: 'pkb',
    name: '中央民族大学匹克球俱乐部',
    shortName: '民大匹克球',
    sportName: '匹克球',
    logoGlyph: '匹',
    theme: {
      // 匹克球 → 蓝
      primary: '#1565C0',
      primaryDark: '#0D47A1',
      primaryLight: '#E3F0FB',
      accent: '#FF7A45',
    },
    ...baseRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  {
    id: 'tt',
    name: '中央民族大学乒乓球协会',
    shortName: '民大乒乓',
    sportName: '乒乓球',
    logoGlyph: '乒',
    theme: {
      // 乒乓球 → 深绿（RGB 0,77,64）
      primary: '#004D40',
      primaryDark: '#00332B',
      primaryLight: '#E0F0EC',
      accent: '#C9A227',
    },
    ...baseRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  {
    id: 'bd',
    name: '中央民族大学羽毛球协会',
    shortName: '民大羽球',
    sportName: '羽毛球',
    logoGlyph: '羽',
    theme: {
      // 羽毛球 → 紫
      primary: '#6A1B9A',
      primaryDark: '#4A148C',
      primaryLight: '#F3E8F7',
      accent: '#F2994A',
    },
    ...baseRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
];

/**
 * 全部协会（含已停用）。
 * 返回浅拷贝：清单只读，调用方改不动数组本身，也拿不到内部数组引用。
 *
 * @returns {Array<Object>}
 */
function allAssociations() {
  return ASSOCIATIONS.slice();
}

/**
 * 仅启用中的协会。选择页与默认值只认这些。
 *
 * @returns {Array<Object>}
 */
function activeAssociations() {
  return ASSOCIATIONS.filter((a) => a.status === ASSOCIATION_STATUS.ACTIVE);
}

/**
 * 按 id 取一个协会。
 *
 * 未知 id **抛错**，不静默退回某个协会——请求带错协会时宁可当场炸，
 * 也不要让数据悄悄落到别的协会名下。
 *
 * @param {string} id
 * @returns {Object}
 */
function getAssociation(id) {
  const found = ASSOCIATIONS.find((a) => a.id === id);
  if (!found) throw new Error(`未知的协会 id：${id}`);
  return found;
}

/**
 * id 是否登记在册（含已停用）。用于校验请求携带的 association。
 *
 * @param {string} id
 * @returns {boolean}
 */
function isKnownAssociation(id) {
  return ASSOCIATIONS.some((a) => a.id === id);
}

/**
 * 兜底默认协会：首个启用中的协会。
 * 一个启用协会都没有时返回空串（调用方应据空串跳过业务，而不是硬闯）。
 *
 * @returns {string}
 */
function defaultAssociationId() {
  const first = activeAssociations()[0];
  return first ? first.id : '';
}

/**
 * 多协会改造之前唯一存在的协会 id。
 *
 * 【为什么要有它】
 * 改造前的内容文档没有 association 字段。迁移脚本会批量回填为这个值，但在
 * 回填完成之前（以及测试夹具里），读取必须把「缺字段」等同于它，否则旧数据
 * 一条都读不出来。**只对缺字段生效**：字段存在但与请求协会不符，一律挡住。
 */
const LEGACY_ASSOCIATION_ID = 'pkb';

/**
 * 一条内容文档是否属于某个协会。
 *
 * 读路径的统一谓词：字段缺省视作 LEGACY_ASSOCIATION_ID（旧数据），字段存在
 * 则要求严格相等——「旧数据归匹克球、新数据各归各协会」一条规则说清。
 *
 * @param {Object|null} doc
 * @param {string} association
 * @returns {boolean}
 */
function belongsToAssociation(doc, association) {
  if (!doc) return false;
  const owner = doc.association || LEGACY_ASSOCIATION_ID;
  return owner === association;
}

module.exports = {
  allAssociations,
  activeAssociations,
  getAssociation,
  isKnownAssociation,
  defaultAssociationId,
  LEGACY_ASSOCIATION_ID,
  belongsToAssociation,
};
