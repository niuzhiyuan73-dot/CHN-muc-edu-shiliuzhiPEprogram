/**
 * 「这个人在哪个协会打得最多」
 * ============================================================
 * 多协会版本的默认协会规则（需求整理 §11.1）：每次进小程序，中间三个界面
 * 默认取「该用户比赛最多的协会」；并列按注册表顺序取第一个；一场都没打过
 * 就回落默认协会。
 *
 * 【为什么单列一个模块】这条规则要被三处用：app.js 启动定全局协会、
 * 个人详情页定本页默认、他人主页定本页默认。三处各写一份迟早分叉。
 *
 * 【为什么用 getMyProjects 而不是捞全部比赛】项目快照里已经带了每个池的
 * matchCount，累加即可，不必把整条比赛流水拉出来。它本身也是按当前协会
 * 作用域的，配合 mapActiveAssociations 正好一个协会一份。
 * ============================================================
 */

const { defaultAssociationId } = require('../utils/associations.js');
const scope = require('./association-scope.js');
const { getMyProjects } = require('./index.js');

/**
 * 各启用协会里，这个人的比赛场次（单打 + 双打）。
 *
 * @param {string} userId
 * @returns {Promise<Array<{id: string, matchCount: number}>>} 与启用协会同序
 */
async function matchCountsByAssociation(userId) {
  return scope.mapActiveAssociations(async (assoc) => {
    const projects = await getMyProjects(userId);
    const matchCount = (Array.isArray(projects) ? projects : []).reduce(
      (sum, item) => sum + (Number(item.matchCount) || 0),
      0
    );
    return { id: assoc.id, matchCount };
  });
}

/**
 * 「比赛最多的协会」。并列取注册表在前的；一场都没打过（或没登录）回落默认协会。
 *
 * @param {string} [userId]
 * @returns {Promise<string>} 协会 id
 */
async function mostPlayedAssociation(userId) {
  if (!userId) return defaultAssociationId();

  const counts = await matchCountsByAssociation(userId);
  let best = null;
  for (const item of counts) {
    // 严格大于：并列时保留先出现的（即注册表在前的那个）
    if (!best || item.matchCount > best.matchCount) best = item;
  }
  if (!best || best.matchCount <= 0) return defaultAssociationId();
  return best.id;
}

module.exports = {
  matchCountsByAssociation,
  mostPlayedAssociation,
};
