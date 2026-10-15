/** 页面入口，每次创建客户端时固定数据源、学校与演示身份。 */
const { isMockNow } = require('./index.js');
const cloud = require('./school-cloud.js');
const mock = require('./school-mock.js');
module.exports = {
  forSchoolIdentity: scope => (isMockNow() ? mock : cloud).forSchoolIdentity(scope),
  isMockNow,
  getDemoActors: () => isMockNow() ? mock.DEMO_ACTORS.map(actor => ({ ...actor })) : [],
  getDemoActor: () => isMockNow() ? mock.getDemoActor() : '',
  setDemoActor(id) {
    if (!isMockNow()) throw new Error('云端不可切换模拟身份');
    mock.setDemoActor(id);
  },
  /** 模拟「新微信号」（仅本地演示）：拨到尚无账号的 OpenID，用于注册闭环演示。 */
  simulateNewWechat(openId) {
    if (!isMockNow()) throw new Error('云端不可模拟微信身份');
    return mock.simulateNewWechat(openId);
  },
};
