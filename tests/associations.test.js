/**
 * 协会注册表的纯逻辑自检
 * ============================================================
 * 注册表是多协会的唯一真相源：选择页、导航栏标题、主题色、按协会的规则
 * 默认值全从这里取；云端还要用它校验请求里的 association。它一旦有错，
 * 要么页面拿不到协会，要么数据落到不存在的协会名下。
 *
 * 判定全是纯计算（不碰 wx、不碰数据源），能在 Node 里直接跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  allAssociations,
  activeAssociations,
  getAssociation,
  isKnownAssociation,
  defaultAssociationId,
} = require('../miniprogram/utils/associations.js');
const { ASSOCIATION_STATUS } = require('../miniprogram/utils/constants.js');
const { isValidFormat } = require('../miniprogram/utils/match-format.js');

const DEST_ROOT = path.join(__dirname, '..', 'cloudfunctions', 'data', 'lib');

/* ============================================================
 * 一、清单本身
 * ============================================================ */

test('allAssociations —— 至少登记了三个首批协会，且 id 唯一', () => {
  const list = allAssociations();
  assert.ok(list.length >= 3, '首批至少三个协会');
  const ids = list.map((a) => a.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 不能重复');
  // 首批三个必须都在
  for (const id of ['pkb', 'tt', 'bd']) {
    assert.ok(ids.includes(id), `缺少协会 ${id}`);
  }
});

test('每个协会的字段齐全，且规则默认值合法', () => {
  for (const a of allAssociations()) {
    assert.strictEqual(typeof a.id, 'string');
    assert.ok(a.id.length > 0);
    assert.ok(a.name && a.shortName && a.logoGlyph, `${a.id} 缺品牌字段`);

    // 主题色的四个值都是 #RRGGBB
    for (const key of ['primary', 'primaryDark', 'primaryLight', 'accent']) {
      assert.match(a.theme[key], /^#[0-9A-Fa-f]{6}$/, `${a.id}.theme.${key} 不是颜色`);
    }

    // 规则默认值：默认赛制必须落在可选值里
    assert.ok(Array.isArray(a.format.gamePointsOptions));
    assert.ok(Array.isArray(a.format.bestOfOptions));
    assert.ok(
      isValidFormat(a.format.defaultFormat),
      `${a.id}.format.defaultFormat 不合法`
    );
    assert.strictEqual(typeof a.ratedPairLimit, 'number');
    assert.ok(a.elo && typeof a.elo.initialRating === 'number');
  }
});

test('allAssociations 返回的是副本，外部增删改不动内部清单', () => {
  const before = allAssociations().length;
  const list = allAssociations();
  list.push({ id: 'ghost' });
  assert.strictEqual(allAssociations().length, before, '外部 push 不应改变清单长度');
  assert.strictEqual(isKnownAssociation('ghost'), false);
});

/* ============================================================
 * 二、启用与默认
 * ============================================================ */

test('activeAssociations —— 只返回启用中的协会', () => {
  for (const a of activeAssociations()) {
    assert.strictEqual(a.status, ASSOCIATION_STATUS.ACTIVE);
  }
  assert.ok(activeAssociations().length > 0, '至少要有一个启用协会');
});

test('defaultAssociationId —— 兜底是首个启用协会（匹克球）', () => {
  assert.strictEqual(defaultAssociationId(), 'pkb');
});

/* ============================================================
 * 三、取用与校验
 * ============================================================ */

test('getAssociation —— 取得到，且 id 对得上', () => {
  assert.strictEqual(getAssociation('pkb').id, 'pkb');
  assert.strictEqual(getAssociation('tt').id, 'tt');
});

test('getAssociation —— 未知 id 抛错，不静默退回', () => {
  assert.throws(() => getAssociation('nope'), /未知的协会 id/);
  assert.throws(() => getAssociation(undefined), /未知的协会 id/);
});

test('isKnownAssociation —— 只认注册表里的 id', () => {
  assert.strictEqual(isKnownAssociation('pkb'), true);
  assert.strictEqual(isKnownAssociation('tt'), true);
  assert.strictEqual(isKnownAssociation('nope'), false);
  assert.strictEqual(isKnownAssociation(''), false);
});

/* ============================================================
 * 四、镜像一致性（云端要用同一份清单）
 * ============================================================
 * 逐字节一致性由 cloud-lib-sync.test.js 守卫；这里只确认云端镜像能加载，
 * 且取到的 id 清单与源文件一致。
 */

test('云端镜像能加载，且协会 id 清单与源文件一致', () => {
  const mirror = require(path.join(DEST_ROOT, 'utils', 'associations.js'));
  assert.deepStrictEqual(
    mirror.allAssociations().map((a) => a.id),
    allAssociations().map((a) => a.id)
  );
});
