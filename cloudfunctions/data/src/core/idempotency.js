/**
 * 幂等键
 * ============================================================
 * 【要防的是什么】
 * 弱网下用户连点两下「提交」，或者请求超时后客户端自动重试，都可能让同一
 * 场比赛被录入两次。等级分是零和的，重复一场比赛会让比赛双方各多算一次
 * 分，而且看不出哪里错了。发公告同理。
 *
 * 【为什么用哈希而不是查询去重】
 * 微信云开发的事务里，集合查询受限，而按 _id 读写稳定可靠。于是把
 * 「这位会员在这个时间用这个比分打了这场比赛」压成一个自然键，直接当成
 * 文档 _id：第二次提交会撞上同一个 _id，事务里读到已存在就知道是重试。
 * 不需要查询，不需要唯一索引，也不需要额外的去重表。
 *
 * 【键里为什么包含录入人】
 * 不同的人确实可能在不同场次报出完全相同的四人组合与比分——那是两场
 * 真实比赛。用录入人把这种巧合区分开，避免误判成重复。
 * ============================================================
 */

const crypto = require('crypto');

/**
 * 把若干字段拼成定长十六进制摘要。
 * @param {Array<*>} parts
 * @returns {string} 32 位十六进制
 */
function digest(parts) {
  return crypto
    .createHash('md5')
    .update(parts.map((part) => String(part === null || part === undefined ? '' : part)).join('|'))
    .digest('hex');
}

/**
 * 比赛的自然键。
 * 队伍成员先排序，避免「A 队里两人顺序不同」被误判成两场不同的比赛。
 *
 * @param {Object} record buildMatchRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function matchNaturalKey(record) {
  return `m_${digest([
    record.pool,
    [...record.teamA].sort().join(','),
    [...record.teamB].sort().join(','),
    record.scoreA.join(','),
    record.scoreB.join(','),
    new Date(record.matchTime).toISOString(),
    record.recorder || '',
  ])}`;
}

/**
 * 公告的自然键。
 * @param {Object} record buildAnnouncementRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function announcementNaturalKey(record) {
  return `a_${digest([record.publisherId || '', record.title, record.content])}`;
}

/**
 * 会员记录的主键：一个 OpenID 只对应一个账号。
 * 用它当 _id，重复提交入会申请就会落到同一条文档上。
 * @param {string} openId
 * @returns {string}
 */
function memberKey(openId) {
  return `u_${digest([openId])}`;
}

/**
 * 赛事的自然键：同一位发布者在同一时刻发的同名赛事只该有一条。
 * 弱网重试最容易在这里出问题——线上市集里出现两条一模一样的赛事，
 * 报名的会员会不知道该点哪一个。
 *
 * @param {Object} record buildEventRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function eventNaturalKey(record) {
  return `e_${digest([
    record.publisherId || '',
    record.title,
    new Date(record.startTime).toISOString(),
  ])}`;
}

/**
 * 报名记录的自然键：「这位会员报了这场赛事」压成一个 _id。
 *
 * 同一人同一赛事只该有一条报名记录。取消不删记录、只改状态，于是重新报名
 * 会落回同一条文档（见 event.buildSignupRecord）——这样「报了多少人、退了
 * 多少人」有据可查，也不会因为连点两下报名而长出两条。
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {string} 可直接用作 _id
 */
function signupNaturalKey(eventId, userId) {
  return `s_${digest([eventId, userId])}`;
}

/**
 * 学院赛的自然键：同一位发布者在同一时刻发的同名学院赛只该有一条。
 * 与 eventNaturalKey 同一思路——弱网重试不该在列表里留下两场一样的赛事。
 *
 * @param {Object} record buildCollegeEventRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function collegeEventNaturalKey(record) {
  return `ce_${digest([
    record.publisherId || '',
    record.title,
    new Date(record.startTime).toISOString(),
  ])}`;
}

/**
 * 学院名单的自然键：「这场学院赛里这个学院」压成一个 _id。
 *
 * 同一赛事同一学院只该有一份有效名单（D10）。名单可以改后重交，重交会落回
 * 同一条文档，于是不需要先删后插，也不会长出两份互相矛盾的名单。
 *
 * @param {string} eventId
 * @param {string} college
 * @returns {string} 可直接用作 _id
 */
function collegeEntryNaturalKey(eventId, college) {
  return `cn_${digest([eventId, college])}`;
}

/**
 * 大场排阵的自然键：「这个大场里这个学院」压成一个 _id。
 *
 * 同一大场同一学院只该有一份有效排阵；学院负责人改后重交（含换替补，D30）会落回
 * 同一条文档，于是不需要先删后插，也不会留下两份互相矛盾的排阵。学院名带
 * 中文，用摘要压成定长十六进制，避免主键里出现非 ASCII 字符。
 *
 * @param {string} tieId
 * @param {string} college
 * @returns {string} 可直接用作 _id
 */
function collegeLineupNaturalKey(tieId, college) {
  return `ln_${digest([tieId, college])}`;
}

module.exports = {
  digest,
  matchNaturalKey,
  announcementNaturalKey,
  eventNaturalKey,
  memberKey,
  signupNaturalKey,
  collegeEventNaturalKey,
  collegeEntryNaturalKey,
  collegeLineupNaturalKey,
};
