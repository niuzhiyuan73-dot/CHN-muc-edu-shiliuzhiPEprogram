/** 页面入口，每次创建客户端时固定数据源、学校与演示身份。 */
const { isMockNow } = require('./index.js');
const cloud = require('./school-cloud.js');
// 演示仓储惰性加载：数据源为 cloud 时完全用不上，别让每次冷启动都付那 400ms
// （见 school-mock-loader.js 与 2026-10-16 只读审计 H7）。
const { loadSchoolMock } = require('./school-mock-loader.js');
module.exports = {
  forSchoolIdentity: scope => (isMockNow() ? loadSchoolMock() : cloud).forSchoolIdentity(scope),
  isMockNow,
  getDemoActors: () => isMockNow() ? loadSchoolMock().DEMO_ACTORS.map(actor => ({ ...actor })) : [],
  getDemoActor: () => isMockNow() ? loadSchoolMock().getDemoActor() : '',
  setDemoActor(id) {
    if (!isMockNow()) throw new Error('云端不可切换模拟身份');
    loadSchoolMock().setDemoActor(id);
  },
  /** 模拟「新微信号」（仅本地演示）：拨到尚无账号的 OpenID，用于注册闭环演示。 */
  simulateNewWechat(openId) {
    if (!isMockNow()) throw new Error('云端不可模拟微信身份');
    return loadSchoolMock().simulateNewWechat(openId);
  },
};
