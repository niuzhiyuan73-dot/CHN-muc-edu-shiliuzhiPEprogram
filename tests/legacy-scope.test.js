/**
 * 旧栈门面 forScope 适配层（迁移清单 M0-2 / M0-3）
 *
 * 旧业务的数据模型只有 association 一维。适配层把旧门面钉死在默认校（muc）：
 * 默认校照常读写，非默认校一律拒绝——读抛错、写收敛成 {ok:false}。这一组用例
 * 守的就是「不许借旧门面碰第二所学校」，因为串校是静默的数据污染。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const facade = require('../miniprogram/services/index.js');
const { isWriteAction } = require('../miniprogram/utils/write.js');

const DEFAULT_SCHOOL = 'muc';
const OTHER_SCHOOL = 'buaa';

describe('旧栈 forScope —— 默认校照常读写', () => {
  test('schoolId 缺省时按默认校处理，与 forAssociation 等价', async () => {
    const scoped = facade.forScope({ association: 'pkb' });
    const legacy = facade.forAssociation('pkb');

    const a = await scoped.getMembers();
    const b = await legacy.getMembers();
    assert.deepEqual(a, b, '默认校下 forScope 应与 forAssociation 给出同一份数据');
  });

  test('显式 schoolId=muc 也照常', async () => {
    const scoped = facade.forScope({ schoolId: DEFAULT_SCHOOL, association: 'pkb' });
    const members = await scoped.getMembers();
    assert.ok(Array.isArray(members) && members.length > 0, '默认校应能读到会员');
  });

  test('association 非法时立刻报错，而不是静默落到别的协会', () => {
    assert.throws(() => facade.forScope({ schoolId: DEFAULT_SCHOOL, association: 'nope' }),
      /协会/);
  });
});

describe('旧栈 forScope —— 非默认校一律拒绝（M0-3）', () => {
  test('读接口抛错，并带可辨认的错误码', () => {
    const scoped = facade.forScope({ schoolId: OTHER_SCHOOL, association: 'pkb' });
    assert.throws(() => scoped.getMembers(), (err) => {
      assert.strictEqual(err.code, facade.LEGACY_SCHOOL_UNSUPPORTED);
      assert.match(err.message, /尚未支持学校/);
      return true;
    });
  });

  test('写接口不冒泡，收敛成 {ok:false}', async () => {
    const scoped = facade.forScope({ schoolId: OTHER_SCHOOL, association: 'pkb' });
    assert.strictEqual(isWriteAction('updateProfile'), true, '前提：updateProfile 是写接口');
    const result = await scoped.updateProfile({ nickName: '张三' });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /尚未支持学校/);
  });

  test('非默认校的写不会落到默认校数据上', async () => {
    const before = await facade.forAssociation('pkb').getAnnouncements();
    const scoped = facade.forScope({ schoolId: OTHER_SCHOOL, association: 'pkb' });
    await scoped.publishAnnouncement({ title: '外校公告', content: '不该写进来' });
    const after = await facade.forAssociation('pkb').getAnnouncements();
    assert.equal(after.length, before.length, '默认校公告数不应被外校写操作改到');
  });

  test('拒绝替身覆盖门面的全部接口名', () => {
    const scoped = facade.forScope({ schoolId: OTHER_SCHOOL, association: 'pkb' });
    const facadeNames = Object.keys(facade).filter(
      (k) => typeof facade[k] === 'function' && !['forScope', 'forAssociation',
        'setDataSource', 'getDataSource', 'isMockNow', 'setAssociation', 'getAssociation'].includes(k)
    );
    for (const name of facadeNames) {
      assert.strictEqual(typeof scoped[name], 'function', `拒绝替身缺少 ${name}`);
    }
  });
});
