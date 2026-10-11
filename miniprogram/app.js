/**
 * 小程序入口文件
 * ============================================================
 * 职责：
 *   1. 初始化云开发环境（仅在使用云端数据源时需要）
 *   2. 提供全局数据与全局方法
 *   3. 处理全局错误与未捕获的 Promise 异常
 * ============================================================
 */

const { STORAGE_KEY, DATA_SOURCE } = require('./utils/constants.js');
const { CLOUD_ENV_ID } = require('./config.js');
const { defaultAssociationId } = require('./utils/associations.js');
const facade = require('./services/index.js');

App({
  /**
   * 全局数据。页面通过 getApp().globalData 访问。
   * 注意：globalData 仅在内存中，小程序被销毁后清空。
   * 需要持久化的数据请使用 wx.setStorageSync。
   */
  globalData: {
    /** 当前数据源模式：'mock' 或 'cloud' */
    dataSource: DATA_SOURCE.MOCK,

    /** 云开发环境 ID。来源见 config.js，启动时由 initDataSource 填入 */
    cloudEnvId: CLOUD_ENV_ID,

    /** 当前登录用户信息，未登录时为 null */
    userInfo: null,

    /** 系统信息（状态栏高度等），在 onLaunch 中采集 */
    systemInfo: null,

    /** 当前协会 id，启动时由 initAssociation 复位。空串表示尚未设定 */
    association: '',
  },

  onLaunch() {
    this.initSystemInfo();
    this.initDataSource();
    // 协会要在任何数据读取之前定下来：refreshSession 要按它读会员台账
    this.initAssociation();
    this.restoreUserInfo();
    // 故意不 await：启动流程不该被一次网络往返拖住。校正结果落在
    // globalData 上，下一次页面 onShow 读全局登录态时就会体现出来。
    // 定协会排在后面串起来（不是并发）：当前协会是模块级单例，翻协会读要
    // 一个一个来，若与 refreshSession 的读并发，会互相读到对方切到的协会
    this.refreshSession().then(() => this.syncAssociationForUser());
  },

  /**
   * 采集设备与窗口信息。
   * 用于自定义导航栏、适配刘海屏等场景，后续页面会用到。
   */
  initSystemInfo() {
    try {
      const windowInfo = wx.getWindowInfo();
      const deviceInfo = wx.getDeviceInfo();
      this.globalData.systemInfo = {
        statusBarHeight: windowInfo.statusBarHeight,
        windowWidth: windowInfo.windowWidth,
        windowHeight: windowInfo.windowHeight,
        safeAreaBottom: windowInfo.screenHeight - windowInfo.safeArea.bottom,
        platform: deviceInfo.platform,
      };
    } catch (err) {
      console.error('[app] 获取系统信息失败', err);
    }
  },

  /**
   * 初始化数据源。
   *
   * 【设计意图】开发初期尚未申请 AppID / 开通云开发时，使用 mock 模式，
   * 全部功能依靠本地模拟数据即可完整跑通，便于界面开发与演示。
   * 拿到环境 ID 填进 config.js 之后，启动即走云端，业务代码无需任何改动。
   *
   * 【为什么要在这里调门面】数据源只有一个开关，就是门面的 setDataSource。
   * 早先这里只改 globalData.dataSource，而门面在模块加载时就把实现绑死了，
   * 于是「切到云端」这件事根本传不到取数路径上——开关看着有，其实没接线。
   * 现在云环境就绪与否在这里判定，判定结果亲手交给门面。
   *
   * 【失败为什么退回 mock 而不是硬走云端】环境 ID 填错或基础库太旧时，
   * 走云端会让每个页面都报「云函数调用失败」。退回模拟数据至少界面是活的，
   * 且控制台留下了明确的错误——比一片白屏好定位得多。
   *
   * 【init 为什么也包一层】init 在参数非法或基础库残缺时会同步抛错。若任它
   * 冒出去，onLaunch 会中断在 setDataSource 之前：门面停在默认的 mock，而
   * globalData 也来不及写——两边对不上，比老老实实退回 mock 更难查。
   */
  initDataSource() {
    const envId = this.globalData.cloudEnvId;
    let target = DATA_SOURCE.MOCK;

    if (envId) {
      if (!wx.cloud) {
        console.error('[app] 当前基础库不支持云开发，请升级至 2.2.3 以上');
      } else {
        try {
          wx.cloud.init({
            env: envId,
            // traceUser 会在云开发控制台的「用户管理」中记录访问用户
            traceUser: true,
          });
          target = DATA_SOURCE.CLOUD;
          console.info('[app] 云开发已初始化，环境：', envId);
        } catch (err) {
          console.error('[app] 云开发初始化失败，退回本地模拟数据', err);
        }
      }
    }

    facade.setDataSource(target);
    this.globalData.dataSource = target;

    if (target === DATA_SOURCE.MOCK) {
      console.info('[app] 当前使用本地模拟数据模式，功能可完整预览');
    }
  },

  /**
   * 复位「当前协会」为兜底默认协会。
   *
   * 【为什么不读缓存】「我在哪个协会」不再跨启动保留——每次进小程序都按
   * 用户比赛最多的协会重算（见 syncAssociationForUser 与需求整理 §11.1），
   * 所以冷启动只先把一个确定的兜底协会定下来，好让 refreshSession 在任何
   * 数据读取之前有一个作用域可依。
   *
   * 【为什么必须在 refreshSession 之前】校正登录态要按当前协会去读会员台账；
   * 协会没定下来，读到的可能是另一份，校正结果就张冠李戴了。
   *
   * @returns {string} 设定后的协会 id；一个启用协会都没有时为空串
   */
  initAssociation() {
    const target = defaultAssociationId();
    // 一个启用协会都没有：保持未设定，由调用方据空串跳过业务（见 associations.js）
    if (!target) return '';
    return this.setAssociation(target);
  },

  /**
   * 按登录用户定「当前协会」（需求整理 §11.1）。
   *
   * 【默认取比赛最多的协会，不记忆上次选择】每次进小程序都重算：并列最多按
   * 注册表顺序取第一个；该用户无任何比赛（或未登录）回落 defaultAssociationId。
   * 因此这里既不读缓存、也不写缓存。
   *
   * 【为什么失败要吞掉】这只是「进入时落在哪个协会」，不是业务动作。算不出来
   * 就沿用 initAssociation 已经设好的兜底协会，绝不因此中断启动或把人踢出去。
   *
   * @returns {Promise<string>} 最终生效的协会 id
   */
  async syncAssociationForUser() {
    const user = this.getUserInfo();
    let target = '';
    try {
      // 延迟取用：与 refreshSession 里取 auth 一致，避开 app → 服务 → 门面的加载期环
      const { mostPlayedAssociation } = require('./services/association-usage.js');
      target = user ? await mostPlayedAssociation(user._id) : defaultAssociationId();
    } catch (err) {
      console.error('[app] 计算默认协会失败，沿用当前协会', err);
      return this.globalData.association;
    }

    if (target && target !== this.globalData.association) {
      try {
        // 用 applyAssociation 而非 setAssociation：这里要自己等角色重解落定（见下），
        // 不让 setAssociation 再甩一个不等的重解出去
        this.applyAssociation(target);
      } catch (err) {
        console.error('[app] 切换默认协会失败', err);
        return this.globalData.association;
      }
    }

    // 协会定了之后按**新协会**重解本人角色，并显式等它落定——否则首屏读到的
    // 还是 refreshSession 在切换前那个协会里解出的角色（见 refreshViewerRole）
    await this.refreshViewerRole();
    return this.globalData.association;
  },

  /**
   * 切换当前协会。写门面（决定后续读到哪份数据）并回写 globalData。
   * 不做持久化——协会每次启动重算，见 syncAssociationForUser。
   *
   * 切完异步重解本人角色（见 refreshViewerRole）：不阻塞切换本身，切换要立刻
   * 可见；角色校正随后到位，下次设页面读到的权限便是新协会的。
   *
   * @param {string} id 注册表里的已知协会 id
   * @returns {string} 设定后的 id
   * @throws {Error} 未知协会（由 association-scope 抛出）
   */
  setAssociation(id) {
    const next = this.applyAssociation(id);
    if (this.globalData.userInfo) this.refreshViewerRole();
    return next;
  },

  /**
   * 只写门面与 globalData，不动登录态。供 setAssociation（要重解角色）与
   * syncAssociationForUser（自己掌控重解时机）复用，免得同一句写两遍。
   *
   * @param {string} id
   * @returns {string} 设定后的 id
   * @throws {Error} 未知协会（由 association-scope 抛出）
   */
  applyAssociation(id) {
    const next = facade.setAssociation(id);
    this.globalData.association = next;
    return next;
  },

  /**
   * 当前协会 id。页面一律通过它读取；globalData 尚未填时回落到门面（+默认）。
   * @returns {string}
   */
  getAssociation() {
    return this.globalData.association || facade.getAssociation();
  },

  /**
   * 从本地缓存恢复登录态。
   * 冷启动时避免用户重复授权，提升体验。
   */
  restoreUserInfo() {
    try {
      const cached = wx.getStorageSync(STORAGE_KEY.USER_INFO);
      if (cached && cached._id) {
        this.globalData.userInfo = cached;
      }
    } catch (err) {
      console.error('[app] 读取本地登录态失败', err);
    }
  },

  /**
   * 拿权威数据校正本地登录态。
   *
   * 【为什么必须有这一步】登录态是在注册/登录那一刻整份写进本地缓存的
   * （见 setUserInfo），而所有页面读的都是这份缓存，没有一处会主动回查。
   * 于是管理员在后台把人审核通过、或调整了角色，客户端并不知道：那个人
   * 会一直卡在「待审核」，模板上写着「通过后即可录入成绩」，可他怎么点都
   * 不行，也没有任何提示告诉他「重新登录一次」。启动时静默校正一次，
   * 就把这个死结解开了。
   *
   * 【两条来源，各按各的规矩】云端按微信身份重新取一次账号（login）。
   * mock 没有服务端，但数据源里的人是可以就地读的——按缓存里的 _id 回查
   * 本人，取他当前的样子（含角色变化，如 college-demo 把人提为学院负责人）。
   *
   * 【演示身份为什么以「当前演示账号」为准】mock 的登录人由编译期常量
   * mock.js 的 DEFAULT_CURRENT_USER_ID 决定。缓存里若是**另一个种子会员**
   * （把常量改成别人再编译的情形），说明演示身份已经换人，这里整体切成新
   * 那位——于是「改常量 + 重新编译」就能切换演示账号，不必手动退出登录。
   * 缓存里的人若已查不到（如本地注册、重启后内存清空的账号），原样保留。
   *
   * 【mock 为什么也要校正】演示场景会把当前用户提为某学院负责人
   * （见 college-demo.js），而登录快照是更早写下的「普通会员」。不回查的话，
   * 界面按快照判权限，学院负责人照样进不了排阵——正是这一步要防的不同步。
   *
   * 【失败/none 为什么一律保留缓存】拉取失败多半是网络抖动或云函数偶发
   * 故障；mock 下回查不到，意味着这个 _id 既不在种子也不在申请里。无论
   * 哪种，把人踢回未登录都比让他多看一会儿旧状态糟糕得多。只有云端明确
   * 回答「没有这个账号」（例如账号文档被删）才清本地——那种情况下留着
   * 一份账号，会让每次写操作都报「请先登录」，反而更难排查。
   *
   * 【未登录为什么不自动登录】mock 下没有缓存则保持访客态，不自动以演示
   * 账号登录——登录与否是登录页的决定，这里只负责校正已有会话。
   *
   * @returns {Promise<void>}
   */
  async refreshSession() {
    const cached = this.getUserInfo();
    if (!cached) return;

    if (this.globalData.dataSource === DATA_SOURCE.CLOUD) {
      try {
        // 延迟取用：与 services/auth.js 里 login() 的写法一致，
        // 避免 app → auth → 门面 → mock 的加载期环
        const { login } = require('./services/auth.js');
        const { ok, user } = await login();

        if (ok && user) this.setUserInfo(user);
        else this.clearUserInfo();
      } catch (err) {
        console.error('[app] 校正登录态失败，继续沿用本地缓存', err);
      }
      return;
    }

    try {
      // 按缓存里的 _id 回查本人：种子会员都在，本地注册的账号重启后不在。
      const fresh = await facade.getMember(cached._id);
      if (!fresh) return; // 查不到：原样保留快照（见上「失败/none 为什么保留缓存」）

      // 演示身份以「当前演示账号」（mock.js 的 DEFAULT_CURRENT_USER_ID）为准：
      // 常量已改指向别人（缓存里是另一个种子会员）时整体切换，改常量再编译
      // 即可换人；是同一个人则用回查到的当前样子刷新角色。
      const current = await facade.getCurrentUser();
      this.setUserInfo(current && current._id !== cached._id ? current : fresh);
    } catch (err) {
      console.error('[app] 校正本地登录态失败，继续沿用缓存', err);
    }
  },

  /**
   * 按**当前协会**重解登录者的有效角色，并回写登录态。
   *
   * 【为什么切协会后必须重解】协会角色是「协会内」的：同一个人在 A 协会可能
   * 只是普通会员、在 B 协会却是负责人（见 seed.js 的 ASSOC_ROLE_SEED）。登录
   * 快照是切协会之前写下的，不重解就会拿旧协会的角色判权限——例如某协会的
   * 负责人被默认落到别的协会时被当成会员，连本协会比赛的裁判都指派不了。
   *
   * 【为什么与 refreshSession 分开】refreshSession 在 mock 下带着「当前演示
   * 账号」的换人逻辑（改常量即换演示身份，见上），切协会时不能顺手换人；
   * 这里只按 _id 回查**同一个人**在当前协会里的样子。
   *
   * 【查不到为什么保留旧快照】本地注册、重启后内存清空的账号回查为空，此时
   * 保留原快照比清成访客稳妥。
   *
   * @returns {Promise<void>}
   */
  async refreshViewerRole() {
    const cached = this.getUserInfo();
    if (!cached || !cached._id) return;
    try {
      const fresh = await facade.getMember(cached._id);
      if (fresh) this.setUserInfo(fresh);
    } catch (err) {
      console.error('[app] 切协会后刷新本人角色失败，沿用旧快照', err);
    }
  },

  /**
   * 保存登录态到内存与本地缓存。
   * @param {Object} userInfo 用户信息对象
   */
  setUserInfo(userInfo) {
    this.globalData.userInfo = userInfo;
    try {
      wx.setStorageSync(STORAGE_KEY.USER_INFO, userInfo);
    } catch (err) {
      console.error('[app] 写入本地登录态失败', err);
    }
  },

  /**
   * 当前登录会员，未登录时为 null。
   * 页面一律通过它读取登录态，不要去翻 wx.getStorageSync——
   * 内存与缓存的同步只发生在 setUserInfo / clearUserInfo 两处。
   * @returns {Object|null}
   */
  getUserInfo() {
    return this.globalData.userInfo || null;
  },

  /** 是否已登录 */
  isLoggedIn() {
    return Boolean(this.globalData.userInfo);
  },

  /**
   * 清除登录态。用户退出登录或账号被禁用时调用。
   */
  clearUserInfo() {
    this.globalData.userInfo = null;
    try {
      wx.removeStorageSync(STORAGE_KEY.USER_INFO);
    } catch (err) {
      console.error('[app] 清除本地登录态失败', err);
    }
  },

  /**
   * 全局错误处理。
   * 上线后可在此处接入错误上报，便于发现线上问题。
   */
  onError(err) {
    console.error('[app] 未捕获的错误：', err);
  },

  /**
   * 未处理的 Promise 异常。
   * 云函数调用返回 Promise，若不 catch 会走到这里。
   */
  onUnhandledRejection({ reason }) {
    console.error('[app] 未处理的 Promise 异常：', reason);
  },
});
