/**
 * 登录与会籍单元测试
 * ============================================================
 * 这些是纯逻辑，不依赖微信 API，所以可以在 Node 里把边界情况挨个试一遍：
 * 学号带空格、少数民族姓名里的间隔号、学院不在候选里……
 * 这些恰恰是真实用户最容易填错、而手工点界面很难覆盖到的地方。
 * ============================================================
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLEGES,
  validateProfile,
  normalizeProfile,
  buildAccount,
  resolveAuthState,
  register,
  login,
} = require('../miniprogram/services/auth.js');
const { ROLE, USER_STATUS } = require('../miniprogram/utils/constants.js');
// 只为下面那条「纯函数」断言：register 写完，数据源里一条申请都不该多出来
const facade = require('../miniprogram/services/index.js');

/** 一份合法的表单，各用例在它基础上改一个字段 */
function validForm(overrides = {}) {
  return {
    realName: '马小雨',
    gender: 'M',
    studentId: '2023001234',
    college: COLLEGES[0],
    phone: '13800138000',
    ...overrides,
  };
}

describe('validateProfile —— 实名信息校验', () => {
  test('填写完整时通过', () => {
    const result = validateProfile(validForm());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, {});
    assert.equal(result.firstError, '');
  });

  test('五项必填全空时逐项报错，firstError 指向姓名', () => {
    const result = validateProfile({});
    assert.equal(result.valid, false);
    assert.deepEqual(Object.keys(result.errors).sort(), [
      'college',
      'gender',
      'phone',
      'realName',
      'studentId',
    ]);
    assert.equal(result.firstErrorField, 'realName');
  });

  test('性别只认 M / F：缺失、乱填、大小写都要判准', () => {
    assert.ok(validateProfile(validForm({ gender: undefined })).errors.gender, '缺性别要报错');
    assert.ok(validateProfile(validForm({ gender: '' })).errors.gender, '空串要报错');
    assert.ok(validateProfile(validForm({ gender: '男' })).errors.gender, '中文标签不是合法取值');
    assert.equal(validateProfile(validForm({ gender: 'F' })).valid, true);
    // 小写也接受：表单偶尔会传来 'm' / 'f'，normalize 会先转成大写
    assert.equal(validateProfile(validForm({ gender: 'f' })).valid, true);
  });

  test('学号与姓名首尾的空格会先被去掉，不该因此判错', () => {
    const result = validateProfile(validForm({ realName: ' 马小雨 ', studentId: ' 2023001234 ' }));
    assert.equal(result.valid, true);
    assert.deepEqual(result.profile, {
      realName: '马小雨',
      gender: 'M',
      studentId: '2023001234',
      college: COLLEGES[0],
      phone: '13800138000',
      nickName: '',
      avatarUrl: '',
    });
  });

  test('少数民族姓名里的间隔号是合法的', () => {
    assert.equal(validateProfile(validForm({ realName: '阿依古丽·买买提' })).valid, true);
  });

  test('姓名过短、含数字都判不合法', () => {
    assert.equal(validateProfile(validForm({ realName: '马' })).errors.realName.length > 0, true);
    assert.equal(validateProfile(validForm({ realName: '马小雨1' })).errors.realName.length > 0, true);
  });

  test('学号必须是 6~12 位数字', () => {
    assert.ok(validateProfile(validForm({ studentId: '12345' })).errors.studentId);
    assert.ok(validateProfile(validForm({ studentId: '2023001234567' })).errors.studentId);
    assert.ok(validateProfile(validForm({ studentId: 'abc123456' })).errors.studentId);
  });

  test('学院必须在候选名单里', () => {
    assert.ok(validateProfile(validForm({ college: '霍格沃茨魔法学院' })).errors.college);
    assert.equal(validateProfile(validForm({ college: COLLEGES[0] })).valid, true);
  });

  test('手机号按 11 位、以 1 开头校验', () => {
    assert.ok(validateProfile(validForm({ phone: '1380013800' })).errors.phone);
    assert.ok(validateProfile(validForm({ phone: '23800138000' })).errors.phone);
    assert.equal(validateProfile(validForm({ phone: '19912345678' })).valid, true);
  });

  test('参数为空或非对象时安全返回，不抛异常', () => {
    for (const value of [undefined, null, '', 0, 'abc']) {
      const result = validateProfile(value);
      assert.equal(result.valid, false);
    }
  });
});

describe('normalizeProfile —— 整形', () => {
  test('缺失字段补成空串，数字被转成字符串', () => {
    assert.deepEqual(normalizeProfile({ realName: undefined, studentId: 2023001234 }), {
      realName: '',
      gender: '',
      studentId: '2023001234',
      college: '',
      phone: '',
      nickName: '',
      avatarUrl: '',
    });
  });
});

describe('buildAccount —— 组装账号', () => {
  test('新账号一律是待审核的普通会员', () => {
    const account = buildAccount({ profile: validForm() });
    assert.equal(account.status, USER_STATUS.PENDING);
    assert.equal(account.role, ROLE.MEMBER);
    assert.equal(account.points, 0);
    assert.equal(account.realName, '马小雨');
    assert.ok(account.ratings, '缺少 ratings，各页面会拿不到分数');
  });

  test('有 OpenID 时用它生成编号，便于在名单里定位', () => {
    const account = buildAccount({ openId: 'oABC123', profile: validForm() });
    assert.equal(account._id, 'local_oABC123');
    assert.equal(account.openId, 'oABC123');
  });

  test('没有昵称时用真实姓名兜底，头像处不会空白', () => {
    const account = buildAccount({ profile: validForm({ nickName: '' }) });
    assert.equal(account.nickName, '马小雨');
  });

  test('性别写进账号：定级与单打榜都靠它', () => {
    assert.equal(buildAccount({ profile: validForm({ gender: 'F' }) }).gender, 'F');
    // 小写进来也存成规范的大写取值
    assert.equal(buildAccount({ profile: validForm({ gender: 'm' }) }).gender, 'M');
  });
});

describe('resolveAuthState —— 登录态判定', () => {
  test('未登录：不能录成绩，给一句引导文案', () => {
    const state = resolveAuthState(null);
    assert.equal(state.loggedIn, false);
    assert.equal(state.statusLabel, '未登录');
    assert.equal(state.canRecord, false);
    assert.ok(state.notice.length > 0);
  });

  test('待审核：能看不能录', () => {
    const state = resolveAuthState({ status: USER_STATUS.PENDING, role: ROLE.MEMBER });
    assert.equal(state.isPending, true);
    assert.equal(state.canRecord, false);
    assert.equal(state.statusLabel, '待审核');
  });

  test('正常：可以录成绩', () => {
    const state = resolveAuthState({ status: USER_STATUS.ACTIVE, role: ROLE.ADMIN });
    assert.equal(state.isActive, true);
    assert.equal(state.canRecord, true);
    assert.equal(state.roleLabel, '管理员');
    assert.equal(state.notice, '');
  });

  test('已禁用：不能录成绩，且给出联系管理员的提示', () => {
    const state = resolveAuthState({ status: USER_STATUS.DISABLED, role: ROLE.MEMBER });
    assert.equal(state.isDisabled, true);
    assert.equal(state.canRecord, false);
    assert.ok(state.notice.includes('禁用'));
  });
});

describe('register —— 注册申请', () => {
  test('校验失败时不产出账号', () => {
    const result = register({ realName: '马' });
    assert.equal(result.ok, false);
    assert.equal(result.account, null);
    assert.ok(result.firstError);
  });

  test('校验通过时产出待审核账号，编号可按 now 固定', () => {
    const now = new Date('2026-09-10T10:00:00');
    const result = register(validForm(), { now });
    assert.equal(result.ok, true);
    assert.equal(result.account.status, USER_STATUS.PENDING);
    assert.equal(result.account.joinDate, now);
    assert.equal(result.state.isPending, true);
  });

  test('register 是纯函数：算完不往数据源里写任何东西', async () => {
    // 落库是数据源的 registerMember 干的，register 只负责校验与组装。
    // 这条断言把两者的分工钉死——将来谁把写操作挪进来，这里立刻会红。
    facade.resetCache();
    const before = await facade.getMemberApplications();

    register(validForm());

    const after = await facade.getMemberApplications();
    assert.equal(after.length, before.length, 'register 不该多出申请');
    assert.deepEqual(after, before, 'register 不该改动任何一条申请');
  });
});

describe('login —— 登录', () => {
  test('mock 数据源下返回演示会员，且状态正常', async () => {
    const result = await login();
    assert.equal(result.ok, true);
    assert.ok(result.user);
    assert.equal(result.state.isActive, true);
  });
});
