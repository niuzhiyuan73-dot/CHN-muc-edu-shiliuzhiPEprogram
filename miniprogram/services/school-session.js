/**
 * 当前浏览的学校（客户端会话作用域）
 * ============================================================
 * 与「当前协会」（association-scope.js）并列的第二把范围开关：协会决定「看哪个
 * 项目的数据」，学校决定「看哪所学校的信息」。二者互不影响——切学校不会改动
 * 协会，反之亦然。
 *
 * 【为什么单独一个模块】与协会作用域同理：门面与各台账都要能直接读它，放进
 * 门面会形成加载期环；放进纯计算模块又有可变状态、镜像不过去。所以单列。
 *
 * 【为什么学校没有客户端注册表】学校清单来自云端/种子的学校目录（schools
 * 集合），不是编译期常量，故本模块只保存「选中的是哪一个」与「我的学校是哪一个」，
 * 清单由页面从 school-identity 接口取。
 *
 * 【只读怎么判】当前浏览的学校与「我的学校」（primarySchoolId）不一致，且我的
 * 学校已知时，进入只读浏览：能看，不能写。home 未定（如尚未开通学校身份的演示
 * 账号）时不报只读——宁可少提示，也不误报把人挡在门外。
 * ============================================================
 */

/** 当前浏览的学校 id；空串表示尚未选择，由页面回落到「我的学校」或默认校 */
let current = '';

/** 当前账号的学校 id（primarySchoolId）；空串表示未知或未开通 */
let home = '';

/**
 * 当前浏览的学校 id。
 * @returns {string}
 */
function getSchoolId() {
  return current || home;
}

/**
 * 设定当前浏览的学校。
 * @param {string} id
 * @returns {string} 设定后的 id
 */
function setSchoolId(id) {
  current = typeof id === 'string' ? id : '';
  return current;
}

/**
 * 设定「我的学校」（登录/切换演示身份后由页面刷新）。
 * 若当前浏览的学校尚未选过，就跟着「我的学校」走。
 * @param {string} id
 * @returns {string}
 */
function setHomeSchoolId(id) {
  home = typeof id === 'string' ? id : '';
  if (!current) current = home;
  return home;
}

/** 我的学校 id（primarySchoolId）；未知时为空串。 */
function getHomeSchoolId() {
  return home;
}

/**
 * 当前是不是只读浏览（在别的学校看，不能写）。
 * @returns {boolean}
 */
function isReadOnly() {
  return Boolean(home && current && current !== home);
}

/** 复位到「未选定」。冷启动与测试重来用。 */
function reset() {
  current = '';
  home = '';
}

module.exports = { getSchoolId, setSchoolId, getHomeSchoolId, setHomeSchoolId, isReadOnly, reset };
