/**
 * 会员审核规则的纯逻辑自检
 * ============================================================
 * 这一层决定「谁能给谁盖章」，是全项目权限最敏感的地方，所以每条边界
 * 都用字面量钉死：
 *
 *   1. 审核权 —— 访客、待审核账号、被禁用的管理员，一个都不许审；
 *      普通会员也照样不许（判定只看角色，不分数据源）。
 *   2. 自己审自己 —— 硬规则，必须单独盯着：一旦破了，
 *      注册就变成自封正式会员。
 *   3. 驳回理由 —— 没有理由的驳回事后说不清，必须拦住。
 *   4. 行数据的预计算布尔量 —— 模板不写业务逻辑，全靠它们。
 *
 * 不碰 wx API、不碰数据源，所以能全部在这里跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  REVIEW_ACTION,
  INITIAL_ELO_MIN,
  INITIAL_ELO_MAX,
  validateInitialElo,
  statusTagOf,
  isSelf,
  canReview,
  canReviewApplication,
  canSetCollegeLeader,
  validateCollegeLeader,
  validateReview,
  buildApplicationRow,
} = require('../miniprogram/services/member-review.js');
const { ROLE, USER_STATUS, COLLEGES } = require('../miniprogram/utils/constants.js');

/** 一位刚注册、还没通过的申请人 */
const APPLICANT = {
  _id: 'local_1001',
  nickName: '孙悟空',
  realName: '孙悟空',
  studentId: '20230001',
  college: '体育学院',
  phone: '13800000000',
  role: ROLE.MEMBER,
  status: USER_STATUS.PENDING,
  joinDate: new Date('2026-09-01T10:00:00'),
};

/** 一位审核通过的普通会员 */
const MEMBER = { _id: 'u01', nickName: '李明', role: ROLE.MEMBER, status: USER_STATUS.ACTIVE };

/** 一位正常在岗的学院负责人，带学院——学院负责人的管理范围全靠它 */
const STAFF = {
  _id: 'u02',
  nickName: '王学院负责人',
  role: ROLE.STAFF,
  status: USER_STATUS.ACTIVE,
  college: '信息工程学院',
};

/** 一位管理员 */
const ADMIN = { _id: 'u03', nickName: '张管理', role: ROLE.ADMIN, status: USER_STATUS.ACTIVE };

/** 一位状态正常、学院确定的普通会员，适合被设为学院负责人 */
const CANDIDATE = {
  _id: 'u04',
  nickName: '赵四',
  role: ROLE.MEMBER,
  status: USER_STATUS.ACTIVE,
  college: '体育学院',
};

/* ============================================================
 * 一、审核权
 * ============================================================ */

test('canReview —— 访客没有审核权', () => {
  assert.strictEqual(canReview(null), false);
});

test('canReview —— 待审核的账号自己还没转正，不能去审别人', () => {
  const pendingUser = { _id: 'local_1001', role: ROLE.MEMBER, status: USER_STATUS.PENDING };
  assert.strictEqual(canReview(pendingUser), false);
});

test('canReview —— 被禁用的管理员同样没有审核权', () => {
  const banned = { _id: 'u09', role: ROLE.ADMIN, status: USER_STATUS.DISABLED };
  assert.strictEqual(canReview(banned), false);
});

test('canReview —— 普通会员没有审核权，与数据源无关', () => {
  // 本地模拟数据源里也不放宽：普通会员在自己手机上看不到审核入口
  assert.strictEqual(canReview(MEMBER), false);
  assert.strictEqual(canReview(MEMBER, { isMock: true }), false);
});

test('canReview —— 仅管理员可审', () => {
  assert.strictEqual(canReview(ADMIN), true);
});

test('canReview —— 学院负责人没有审核权', () => {
  // 学院负责人是「学院负责人」，其权限以学院为界；而批下来的是「俱乐部会员」
  // 这个身份，拿到手就能报名、上榜、算积分，与申请人填的哪个学院无关，
  // 没有可靠的边界可收，只能收归管理员。
  assert.strictEqual(canReview(STAFF), false);
  assert.strictEqual(canReview(STAFF, { isMock: true }), false);
});

test('canReview —— 调用方传更宽的门槛也放不进学院负责人', () => {
  assert.strictEqual(canReview(STAFF, { minRole: ROLE.STAFF }), false);
});

/* ============================================================
 * 二、不能审自己的申请
 * ============================================================ */

test('isSelf —— 编号相同才算本人', () => {
  assert.strictEqual(isSelf(MEMBER, { _id: 'u01' }), true);
  assert.strictEqual(isSelf(MEMBER, { _id: 'u02' }), false);
  // 空值一律不算「本人」，免得把 null === null 当成自己
  assert.strictEqual(isSelf(null, null), false);
  assert.strictEqual(isSelf(MEMBER, null), false);
});

test('canReviewApplication —— 管理员也不能审自己的申请', () => {
  const mine = { ...APPLICANT, _id: ADMIN._id };
  assert.strictEqual(canReviewApplication(ADMIN, mine), false);
});

test('canReviewApplication —— 普通会员与学院负责人都审不了，管理员能审别人的待审核申请', () => {
  assert.strictEqual(canReviewApplication(MEMBER, APPLICANT), false);
  assert.strictEqual(canReviewApplication(STAFF, APPLICANT), false);
  assert.strictEqual(canReviewApplication(ADMIN, APPLICANT), true);
});

test('canReviewApplication —— 已经处理过的申请不能再动', () => {
  for (const status of [USER_STATUS.ACTIVE, USER_STATUS.DISABLED]) {
    const handled = { ...APPLICANT, status };
    assert.strictEqual(canReviewApplication(ADMIN, handled), false, `status=${status} 不该可审`);
  }
  assert.strictEqual(canReviewApplication(ADMIN, null), false);
});

/* ============================================================
 * 三、状态文案
 * ============================================================ */

test('statusTagOf —— 四种状态各有各的说法', () => {
  assert.strictEqual(statusTagOf(USER_STATUS.PENDING).label, '待审核');
  assert.strictEqual(statusTagOf(USER_STATUS.ACTIVE).label, '正常');
  assert.strictEqual(statusTagOf(USER_STATUS.DISABLED).label, '已禁用');
  // 驳回借「已禁用」的壳，靠 action 把话说得更准
  assert.strictEqual(statusTagOf(USER_STATUS.DISABLED, REVIEW_ACTION.REJECT).label, '已驳回');
});

test('statusTagOf —— 未知状态给「未知状态」，不渲染出 undefined', () => {
  const tag = statusTagOf(99);
  assert.strictEqual(tag.label, '未知状态');
  assert.ok(tag.className);
});

/* ============================================================
 * 四、审核校验
 * ============================================================ */

test('validateReview —— 没有审核权时，先报权限而不是别的', () => {
  const result = validateReview(MEMBER, APPLICANT, REVIEW_ACTION.APPROVE, '', { isMock: false });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /没有审核权限/);
});

test('validateReview —— 查不到的申请给明确失败', () => {
  const result = validateReview(ADMIN, null, REVIEW_ACTION.APPROVE);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /找不到/);
});

test('validateReview —— 自己的申请被挡住，管理员也不例外', () => {
  const mine = { ...APPLICANT, _id: ADMIN._id };
  const result = validateReview(ADMIN, mine, REVIEW_ACTION.APPROVE, '', { isMock: true });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /自己/);
});

test('validateReview —— 已经处理过的申请不能再处理', () => {
  const handled = { ...APPLICANT, status: USER_STATUS.ACTIVE };
  const result = validateReview(ADMIN, handled, REVIEW_ACTION.APPROVE);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /已经处理过/);
});

test('validateReview —— 未知动作被挡住', () => {
  const result = validateReview(ADMIN, APPLICANT, 'burn');
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /未知/);
});

test('validateReview —— 驳回必须给理由，通过则不必', () => {
  const noReason = validateReview(ADMIN, APPLICANT, REVIEW_ACTION.REJECT, '   ');
  assert.strictEqual(noReason.ok, false);
  assert.match(noReason.message, /理由/);

  assert.strictEqual(validateReview(ADMIN, APPLICANT, REVIEW_ACTION.REJECT, '学号对不上').ok, true);
  assert.strictEqual(validateReview(ADMIN, APPLICANT, REVIEW_ACTION.APPROVE, '').ok, true);
});

/* ============================================================
 * 五、手工指定的初始等级分
 * ============================================================ */

test('validateInitialElo —— 留空表示不指定，不算错', () => {
  for (const blank of [null, undefined, '', '   ']) {
    const result = validateInitialElo(blank);
    assert.strictEqual(result.ok, true, `空值 ${JSON.stringify(blank)} 不该被判错`);
    assert.strictEqual(result.value, null);
  }
});

test('validateInitialElo —— 数字与数字字符串都接受', () => {
  assert.deepStrictEqual(validateInitialElo(1500), { ok: true, value: 1500, message: '' });
  // WXML 的输入框给的是字符串
  assert.strictEqual(validateInitialElo('1600').value, 1600);
});

test('validateInitialElo —— 非数字、小数、越界、布尔都被拒', () => {
  assert.match(validateInitialElo('一千五').message, /数字/);
  assert.match(validateInitialElo(1500.5).message, /整数/);
  assert.match(validateInitialElo(-1).message, /之间/);
  assert.match(validateInitialElo(INITIAL_ELO_MAX + 1).message, /之间/);
  // 布尔值能被 Number 转成 0/1，必须显式挡掉
  assert.strictEqual(validateInitialElo(true).ok, false);
});

test('validateInitialElo —— 上下边界本身合法', () => {
  assert.strictEqual(validateInitialElo(INITIAL_ELO_MIN).ok, true);
  assert.strictEqual(validateInitialElo(INITIAL_ELO_MAX).ok, true);
});

test('validateReview —— 通过时可带初始分', () => {
  const result = validateReview(ADMIN, APPLICANT, REVIEW_ACTION.APPROVE, '', { initialElo: 1600 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.initialElo, 1600);
});

test('validateReview —— 不填初始分时给出 null，交由回放自动定级', () => {
  const result = validateReview(ADMIN, APPLICANT, REVIEW_ACTION.APPROVE, '');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.initialElo, null);
});

test('validateReview —— 初始分越界时整单被挡下', () => {
  const result = validateReview(ADMIN, APPLICANT, REVIEW_ACTION.APPROVE, '', {
    initialElo: INITIAL_ELO_MAX + 1,
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /之间/);
  assert.strictEqual(result.initialElo, null);
});

test('validateReview —— 驳回时忽略传入的初始分', () => {
  const result = validateReview(ADMIN, APPLICANT, REVIEW_ACTION.REJECT, '资料不符', {
    initialElo: 1600,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.initialElo, null);
});

/* ============================================================
 * 六、行数据的预计算布尔量
 * ============================================================ */

test('buildApplicationRow —— 有权限且不是自己时，两个按钮都放行', () => {
  const row = buildApplicationRow(APPLICANT, { actor: ADMIN });

  assert.strictEqual(row.applicationId, 'local_1001');
  assert.strictEqual(row.canApprove, true);
  assert.strictEqual(row.canReject, true);
  assert.strictEqual(row.isSelf, false);
});

test('buildApplicationRow —— 普通会员与学院负责人那一行都没有任何按钮', () => {
  for (const actor of [MEMBER, STAFF]) {
    const row = buildApplicationRow(APPLICANT, { actor });
    assert.strictEqual(row.canApprove, false, `${actor._id} 不该能批`);
    assert.strictEqual(row.canReject, false, `${actor._id} 不该能驳`);
  }
});

test('buildApplicationRow —— 本人那条只留提示，不给按钮', () => {
  const mine = { ...APPLICANT, _id: ADMIN._id };
  const row = buildApplicationRow(mine, { actor: ADMIN });

  assert.strictEqual(row.isSelf, true);
  assert.strictEqual(row.canApprove, false);
  assert.strictEqual(row.canReject, false);
});

test('buildApplicationRow —— 昵称逐层兜底，不渲染出 undefined', () => {
  const withNick = buildApplicationRow(APPLICANT, { actor: ADMIN });
  assert.strictEqual(withNick.nickName, '孙悟空');

  // 注册时昵称可以不填，退回真实姓名
  const noNick = buildApplicationRow({ ...APPLICANT, nickName: '' }, { actor: ADMIN });
  assert.strictEqual(noNick.nickName, '孙悟空');

  // 连姓名都没有（异常数据）时退回编号，而不是 undefined
  const bare = buildApplicationRow({ _id: 'local_9', status: USER_STATUS.PENDING }, { actor: ADMIN });
  assert.strictEqual(bare.nickName, 'local_9');
  assert.strictEqual(bare.realName, '');
  assert.strictEqual(bare.phone, '');
});

test('buildApplicationRow —— 申请时间格式化成中文，未知状态不空白', () => {
  const row = buildApplicationRow(APPLICANT, { actor: ADMIN });
  assert.strictEqual(row.appliedAtText, '9月1日 10:00');

  const handled = buildApplicationRow(
    { ...APPLICANT, status: USER_STATUS.DISABLED, action: REVIEW_ACTION.REJECT, reason: '学号对不上' },
    { actor: ADMIN }
  );
  assert.strictEqual(handled.statusLabel, '已驳回');
  assert.strictEqual(handled.action, 'reject');
  assert.strictEqual(handled.reason, '学号对不上');
  assert.strictEqual(handled.canApprove, false);
});

/* ============================================================
 * 七、任免学院负责人
 * ============================================================
 * 学院负责人握着「代签本学院」与「代录本学院比赛」两项权限，等于把一个学院的
 * 临场事务交出去。所以任免权只给管理员，且被任免者必须有确定的学院——
 * 没有学院的人当上学院负责人，范围判定永远不成立，界面会冒出一堆点不动的入口。
 * ============================================================ */

test('canSetCollegeLeader —— 只有管理员，学院负责人与普通会员都不行', () => {
  assert.strictEqual(canSetCollegeLeader(ADMIN), true);
  assert.strictEqual(canSetCollegeLeader(STAFF), false);
  assert.strictEqual(canSetCollegeLeader(MEMBER), false);
  assert.strictEqual(canSetCollegeLeader(null), false);
});

test('canSetCollegeLeader —— 被禁用的管理员同样没有任免权', () => {
  const banned = { ...ADMIN, status: USER_STATUS.DISABLED };
  assert.strictEqual(canSetCollegeLeader(banned), false);
});

test('validateCollegeLeader —— 学院负责人不能任免别人，只有管理员能', () => {
  const result = validateCollegeLeader(STAFF, CANDIDATE, true);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /管理员/);
  assert.strictEqual(result.role, null);
});

test('validateCollegeLeader —— 找不到目标时给明确失败', () => {
  const result = validateCollegeLeader(ADMIN, null, true);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /找不到/);
});

test('validateCollegeLeader —— 不能给自己任免角色', () => {
  const result = validateCollegeLeader(ADMIN, ADMIN, true);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /自己/);
});

test('validateCollegeLeader —— 不能改变管理员的角色', () => {
  const other = { ...ADMIN, _id: 'u99' };
  const result = validateCollegeLeader(ADMIN, other, false);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /管理员/);
});

test('validateCollegeLeader —— 只有状态正常的会员才能设为学院负责人', () => {
  const pending = { ...CANDIDATE, status: USER_STATUS.PENDING };
  const result = validateCollegeLeader(ADMIN, pending, true);
  assert.strictEqual(result.ok, false);
  assert.match(result.message, /正常/);
});

test('validateCollegeLeader —— 没有有效学院的人不能当学院负责人', () => {
  // 空学院、过时的「其他」、以及不在 COLLEGES 里的值都不行
  for (const college of ['', '其他', '不存在的学院']) {
    const result = validateCollegeLeader(ADMIN, { ...CANDIDATE, college }, true);
    assert.strictEqual(result.ok, false, `college=${college} 不该放行`);
    assert.match(result.message, /学院/);
  }
  // 26 所学院里的任意一所都应当被接受
  assert.strictEqual(validateCollegeLeader(ADMIN, { ...CANDIDATE, college: COLLEGES[0] }, true).ok, true);
});

test('validateCollegeLeader —— 设为学院负责人给 STAFF，撤销给 MEMBER', () => {
  assert.deepStrictEqual(validateCollegeLeader(ADMIN, CANDIDATE, true), {
    ok: true,
    message: '',
    role: ROLE.STAFF,
  });
  assert.deepStrictEqual(validateCollegeLeader(ADMIN, STAFF, false), {
    ok: true,
    message: '',
    role: ROLE.MEMBER,
  });
});
