const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  TITLE_MIN,
  TITLE_MAX,
  CONTENT_MAX,
  DEFAULT_CATEGORY,
  sortAnnouncements,
  canPublish,
  normalizeDraft,
  validateAnnouncement,
  buildAnnouncementRecord,
  buildAnnouncementRow,
} = require('../miniprogram/services/announcement.js');
const { ROLE, USER_STATUS, ANNOUNCEMENT_STATUS } = require('../miniprogram/utils/constants.js');

/** 一个正常会员 */
function member(overrides = {}) {
  return { _id: 'u01', nickName: '小林', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE, ...overrides };
}

/** 一名干事 */
function staff(overrides = {}) {
  return { _id: 'u02', nickName: '干事', role: ROLE.STAFF, status: USER_STATUS.ACTIVE, ...overrides };
}

/** 一份合法的公告表单 */
function form(overrides = {}) {
  return {
    title: '周末训练改到周六',
    content: '因场地检修，本周训练顺延一天。',
    category: '通知',
    pinned: false,
    ...overrides,
  };
}

describe('sortAnnouncements —— 置顶优先，其余按时间倒序', () => {
  /** 造一条公告，只需 id / pinned / 时间 */
  function item(id, pinned, publishTime) {
    return { _id: id, pinned, publishTime: new Date(publishTime) };
  }

  test('置顶的排在前面，即便发布时间更早', () => {
    const list = [
      item('old', false, '2026-05-01T12:00:00'),
      item('top', true, '2026-04-01T12:00:00'),
      item('new', false, '2026-06-01T12:00:00'),
    ];
    const sorted = sortAnnouncements(list);
    assert.deepStrictEqual(sorted.map((a) => a._id), ['top', 'new', 'old']);
  });

  test('同为置顶或同为普通时按发布时间倒序', () => {
    const sorted = sortAnnouncements([
      item('a', true, '2026-04-01T12:00:00'),
      item('b', true, '2026-06-01T12:00:00'),
    ]);
    assert.deepStrictEqual(sorted.map((a) => a._id), ['b', 'a']);
  });

  test('不改动入参', () => {
    const list = [item('a', false, '2026-04-01T12:00:00'), item('b', false, '2026-06-01T12:00:00')];
    sortAnnouncements(list);
    assert.deepStrictEqual(list.map((a) => a._id), ['a', 'b']);
  });
});

describe('canPublish —— 发布权', () => {
  test('未登录没有发布权', () => {
    assert.strictEqual(canPublish(null, { isMock: false }), false);
  });

  test('待审核的账号没有发布权', () => {
    assert.strictEqual(
      canPublish(member({ status: USER_STATUS.PENDING }), { isMock: false }),
      false
    );
  });

  test('正式环境要求干事及以上', () => {
    assert.strictEqual(canPublish(member(), { isMock: false }), false);
    assert.strictEqual(canPublish(staff(), { isMock: false }), true);
    assert.strictEqual(canPublish(staff({ role: ROLE.ADMIN }), { isMock: false }), true);
  });

  test('mock 下放宽为「已登录的正常会员即可」', () => {
    assert.strictEqual(canPublish(member(), { isMock: true }), true);
    // 放宽的只是角色门槛，待审核依旧不行
    assert.strictEqual(canPublish(member({ status: USER_STATUS.PENDING }), { isMock: true }), false);
  });
});

describe('normalizeDraft —— 整形草稿', () => {
  test('去掉首尾空格', () => {
    const draft = normalizeDraft({ title: '  训练通知  ', content: '  正文  ', category: ' 通知 ' });
    assert.strictEqual(draft.title, '训练通知');
    assert.strictEqual(draft.content, '正文');
    assert.strictEqual(draft.category, '通知');
  });

  test('缺失字段补成空串，pinned 收敛成布尔量', () => {
    const draft = normalizeDraft({});
    assert.strictEqual(draft.title, '');
    assert.strictEqual(draft.content, '');
    assert.strictEqual(draft.category, '');
    assert.strictEqual(draft.pinned, false);
    assert.strictEqual(normalizeDraft({ pinned: 'yes' }).pinned, true);
  });

  test('传进来不是对象时按空表单处理', () => {
    assert.deepStrictEqual(normalizeDraft(null), {
      title: '',
      content: '',
      category: '',
      pinned: false,
    });
  });
});

describe('validateAnnouncement —— 内容校验', () => {
  test('合法表单通过，并交回整形后的草稿', () => {
    const result = validateAnnouncement(form({ title: '  训练通知  ' }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.firstError, '');
    assert.strictEqual(result.draft.title, '训练通知');
  });

  test('标题过短或过长都被挡下', () => {
    assert.strictEqual(validateAnnouncement(form({ title: '训' })).errors.title, `标题需为 ${TITLE_MIN}~${TITLE_MAX} 个字`);
    assert.strictEqual(
      validateAnnouncement(form({ title: 'x'.repeat(TITLE_MAX + 1) })).errors.title,
      `标题需为 ${TITLE_MIN}~${TITLE_MAX} 个字`
    );
    // 边界值本身合法
    assert.strictEqual(validateAnnouncement(form({ title: 'x'.repeat(TITLE_MIN) })).ok, true);
    assert.strictEqual(validateAnnouncement(form({ title: 'x'.repeat(TITLE_MAX) })).ok, true);
  });

  test('正文必填且有长度上限', () => {
    assert.strictEqual(validateAnnouncement(form({ content: '   ' })).errors.content, '请填写公告正文');
    assert.strictEqual(
      validateAnnouncement(form({ content: 'x'.repeat(CONTENT_MAX + 1) })).errors.content,
      `正文最多 ${CONTENT_MAX} 个字`
    );
    assert.strictEqual(validateAnnouncement(form({ content: 'x'.repeat(CONTENT_MAX) })).ok, true);
  });

  test('分类必须落在白名单里', () => {
    assert.strictEqual(validateAnnouncement(form({ category: '通知' })).ok, true);
    assert.strictEqual(validateAnnouncement(form({ category: '赛事' })).ok, true);
    assert.strictEqual(validateAnnouncement(form({ category: '战报' })).ok, true);
    assert.strictEqual(validateAnnouncement(form({ category: '公告' })).errors.category, '请选择公告分类');
    assert.strictEqual(validateAnnouncement(form({ category: '' })).errors.category, '请选择公告分类');
  });

  test('firstError 按「标题 → 正文 → 分类」的顺序取第一条', () => {
    const result = validateAnnouncement({ title: '', content: '', category: '' });
    assert.strictEqual(result.firstError, `标题需为 ${TITLE_MIN}~${TITLE_MAX} 个字`);

    // 标题补好之后，第一条错就该轮到正文
    const second = validateAnnouncement({ title: '训练通知', content: '', category: '' });
    assert.strictEqual(second.firstError, '请填写公告正文');

    const third = validateAnnouncement({ title: '训练通知', content: '正文', category: '' });
    assert.strictEqual(third.firstError, '请选择公告分类');
  });
});

describe('buildAnnouncementRecord —— 组装记录', () => {
  const now = new Date('2026-05-01T12:00:00');

  test('合法草稿组装出带发布者与发布时间的记录', () => {
    const result = buildAnnouncementRecord(form({ pinned: true }), { actor: staff(), now });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.record.title, '周末训练改到周六');
    assert.strictEqual(result.record.category, '通知');
    assert.strictEqual(result.record.pinned, true);
    assert.strictEqual(result.record.publishTime, now);
    assert.strictEqual(result.record.publisherId, 'u02');
    assert.strictEqual(result.record.publisherName, '干事');
    // 记录里不带 _id / status：那是台账落库时才定的
    assert.strictEqual(result.record._id, undefined);
    assert.strictEqual(result.record.status, undefined);
  });

  test('非法草稿不产出记录，只回报第一条错误', () => {
    const result = buildAnnouncementRecord(form({ title: '' }), { actor: staff(), now });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.record, null);
    assert.strictEqual(result.firstError, `标题需为 ${TITLE_MIN}~${TITLE_MAX} 个字`);
  });

  test('没有发布者时编号与名字留空，不渲染出 undefined', () => {
    const result = buildAnnouncementRecord(form(), { now });
    assert.strictEqual(result.record.publisherId, '');
    assert.strictEqual(result.record.publisherName, '');
  });

  test('发布者昵称逐层兜底：昵称 → 实名 → 编号', () => {
    const noNick = buildAnnouncementRecord(form(), { actor: { _id: 'u09', realName: '王小明' }, now });
    assert.strictEqual(noNick.record.publisherName, '王小明');

    const bare = buildAnnouncementRecord(form(), { actor: { _id: 'u09' }, now });
    assert.strictEqual(bare.record.publisherName, 'u09');
  });
});

describe('buildAnnouncementRow —— 整形列表行', () => {
  const published = {
    _id: 'a01',
    title: '开训通知',
    content: '本周起常规训练。',
    category: '通知',
    pinned: true,
    publishTime: new Date('2026-05-01T12:00:00'),
    publisherName: '体育部',
  };

  test('字段照搬并算好展示文案', () => {
    const row = buildAnnouncementRow(published, { actor: staff() });

    assert.strictEqual(row.id, 'a01');
    assert.strictEqual(row.title, '开训通知');
    assert.strictEqual(row.category, '通知');
    assert.strictEqual(row.pinned, true);
    assert.strictEqual(row.publishText, '5月1日 12:00');
    assert.strictEqual(row.statusLabel, '已发布');
    assert.strictEqual(row.archived, false);
    assert.strictEqual(row.publisherName, '体育部');
  });

  test('干事且未下架时才能下架', () => {
    assert.strictEqual(buildAnnouncementRow(published, { actor: staff() }).canArchive, true);
    // 没有发布权的普通会员看不到下架按钮
    assert.strictEqual(buildAnnouncementRow(published, { actor: member() }).canArchive, false);
    // 访客也不行
    assert.strictEqual(buildAnnouncementRow(published, { actor: null }).canArchive, false);
    // 演示口径下放宽
    assert.strictEqual(buildAnnouncementRow(published, { actor: member(), isMock: true }).canArchive, true);
  });

  test('已下架的不能再下架', () => {
    const row = buildAnnouncementRow(
      { ...published, status: ANNOUNCEMENT_STATUS.ARCHIVED },
      { actor: staff() }
    );
    assert.strictEqual(row.archived, true);
    assert.strictEqual(row.statusLabel, '已下架');
    assert.strictEqual(row.canArchive, false);
  });

  test('缺字段逐层兜底，不渲染出 undefined', () => {
    const row = buildAnnouncementRow({ _id: 'a09' }, { actor: staff() });
    assert.strictEqual(row.title, '（无标题）');
    assert.strictEqual(row.content, '');
    assert.strictEqual(row.category, DEFAULT_CATEGORY);
    assert.strictEqual(row.publisherName, '');
    // 时间缺失时用占位符，而不是 Invalid Date
    assert.strictEqual(row.publishText, '—');
  });
});
