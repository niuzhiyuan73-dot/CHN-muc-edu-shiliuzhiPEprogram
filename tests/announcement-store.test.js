const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../miniprogram/services/announcement-store.js');
const { ANNOUNCEMENT_STATUS } = require('../miniprogram/utils/constants.js');

/** 台账是模块级状态，每条用例都从空的一页开始 */
beforeEach(() => store.reset());

/** 一份最小的公告草稿 */
function draft(overrides = {}) {
  return {
    title: '周末训练改到周六',
    content: '因场地检修，本周训练顺延一天。',
    category: '通知',
    pinned: false,
    publishTime: new Date('2026-05-01T12:00:00'),
    publisherId: 'u01',
    publisherName: '管理员',
    ...overrides,
  };
}

test('addAnnouncement —— 第一条编号是 la0001，状态默认为已发布', () => {
  const record = store.addAnnouncement(draft());

  assert.strictEqual(record._id, 'la0001');
  assert.strictEqual(record.status, ANNOUNCEMENT_STATUS.PUBLISHED);
  assert.strictEqual(store.addAnnouncement(draft())._id, 'la0002');
});

test('addAnnouncement —— 即使草稿自带 status 也会被改写成已发布', () => {
  const record = store.addAnnouncement(draft({ status: ANNOUNCEMENT_STATUS.ARCHIVED }));
  assert.strictEqual(record.status, ANNOUNCEMENT_STATUS.PUBLISHED);
});

test('addAnnouncement —— 不就地修改传入的草稿', () => {
  const source = draft();
  store.addAnnouncement(source);

  assert.strictEqual(source._id, undefined, '不该往调用方的对象上塞 _id');
  assert.strictEqual(source.status, undefined);
});

test('addAnnouncement —— 返回的是副本，改它动不到台账', () => {
  const record = store.addAnnouncement(draft());
  record.title = '被改掉了';
  record.status = ANNOUNCEMENT_STATUS.ARCHIVED;

  const [stored] = store.listSubmitted();
  assert.strictEqual(stored.title, '周末训练改到周六');
  assert.strictEqual(stored.status, ANNOUNCEMENT_STATUS.PUBLISHED);
});

test('addAnnouncement —— publishTime 也是副本，改它动不到台账', () => {
  const record = store.addAnnouncement(draft());
  record.publishTime.setFullYear(1999);

  const [stored] = store.listSubmitted();
  assert.strictEqual(stored.publishTime.getFullYear(), 2026);
});

test('listSubmitted —— 返回副本，外部改不动内部', () => {
  store.addAnnouncement(draft());

  const list = store.listSubmitted();
  list[0].title = '被改掉了';
  list.push({ _id: 'fake' });

  assert.strictEqual(store.listSubmitted().length, 1);
  assert.strictEqual(store.listSubmitted()[0].title, '周末训练改到周六');
});

test('overrideOf —— 没有改判时返回 null', () => {
  assert.strictEqual(store.overrideOf('la0001'), null);
  assert.strictEqual(store.overrideOf('a01'), null);
});

test('setStatus —— 写入改判并能读回来', () => {
  store.setStatus('la0001', {
    status: ANNOUNCEMENT_STATUS.ARCHIVED,
    actor: 'u03',
    actedAt: '2026-05-02T10:00:00',
  });

  const patch = store.overrideOf('la0001');
  assert.strictEqual(patch.status, ANNOUNCEMENT_STATUS.ARCHIVED);
  assert.strictEqual(patch.actor, 'u03');
});

test('setStatus —— 多次改判合并且以最后一次为准', () => {
  store.setStatus('a01', { status: ANNOUNCEMENT_STATUS.ARCHIVED, actor: 'u03' });
  store.setStatus('a01', { status: ANNOUNCEMENT_STATUS.PUBLISHED, actor: 'u05' });

  const patch = store.overrideOf('a01');
  assert.strictEqual(patch.status, ANNOUNCEMENT_STATUS.PUBLISHED);
  assert.strictEqual(patch.actor, 'u05');
});

test('overrideOf —— 返回副本，改它动不到台账', () => {
  store.setStatus('a01', { status: ANNOUNCEMENT_STATUS.ARCHIVED, actor: 'u03' });

  const patch = store.overrideOf('a01');
  patch.status = ANNOUNCEMENT_STATUS.PUBLISHED;
  patch.actor = '被改掉了';

  assert.strictEqual(store.overrideOf('a01').status, ANNOUNCEMENT_STATUS.ARCHIVED);
  assert.strictEqual(store.overrideOf('a01').actor, 'u03');
});

test('reset —— 清空新增与改判，并把编号复位', () => {
  store.addAnnouncement(draft());
  store.setStatus('a01', { status: ANNOUNCEMENT_STATUS.ARCHIVED, actor: 'u03' });

  store.reset();

  assert.deepStrictEqual(store.listSubmitted(), []);
  assert.strictEqual(store.overrideOf('a01'), null);
  // 序号也要复位，否则测试里「第一条是 la0001」的断言会随执行顺序飘移
  assert.strictEqual(store.addAnnouncement(draft())._id, 'la0001');
});
