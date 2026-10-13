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
};
