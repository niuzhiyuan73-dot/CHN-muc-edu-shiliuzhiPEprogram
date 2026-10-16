/**
 * 学校维度演示内容（公告 / 赛事 / 比赛）自检（迁移清单 C）
 * ============================================================
 * schoolMock.reset() 默认给多个「学校 + 协会」范围摆上演示内容，协会空间与排行榜
 * 一进去就有东西可看，不必先手工发几条。这里守三件事：
 *   1. 每个范围的内容都绑定自己的范围，且是被服务读得出来的完整记录（不是半截）；
 *   2. 三层差异性（2026-10-16 扩充）：协会之间的公告条数 / 标题不同、跨校各有各的
 *      内容、不同演示账号战绩不同——切了范围或身份，看到的东西确实不一样；
 *   3. reset({ withDemoContent: false }) 能把内容关干净——公告页那类
 *      「自己摆几条再数条数」的用例全靠它，否则条数会随演示内容的多寡漂移。
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoContent, DEMO_CONTENT_SPECS } = require('../miniprogram/services/school-seed.js');
const { isAnnouncementDoc } = require('../miniprogram/services/school-announcement-service.js');
const { isEventDoc } = require('../miniprogram/services/school-event-service.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const {
  MATCH_STATUS, MATCH_OUTCOME, MATCH_COMPETITION, RANK_PROJECT,
} = require('../miniprogram/utils/constants.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/** 某范围的内容片（与 createSchoolDemoContent 的切法一致）。 */
function contentOf(schoolId, association) {
  const content = createSchoolDemoContent();
  const inScope = doc => doc.schoolId === schoolId && doc.association === association;
  return {
    announcements: content.announcements.filter(inScope),
    events: content.events.filter(inScope),
    matches: content.matches.filter(inScope),
  };
}

/* ============================================================
 * 一、纯形状：每批记录都绑定自己的范围，形状可被服务读出来
 * ============================================================ */

test('演示内容 —— 每个范围的记录都绑定自己的「学校 + 协会」，形状可被服务读出来', () => {
  const content = createSchoolDemoContent();

  assert.equal(content.announcements.length, 18);
  assert.equal(content.events.length, 9);
  assert.equal(content.matches.length, 39);

  assert.ok(content.announcements.every(doc => isAnnouncementDoc(doc)), '公告形状不完整');
  assert.ok(content.events.every(doc => isEventDoc(doc)), '赛事形状不完整');
  assert.ok(content.matches.every(doc => doc.status === MATCH_STATUS.ACTIVE
    && doc.outcome === MATCH_OUTCOME.NORMAL
    && doc.competition === MATCH_COMPETITION.PERSONAL), '比赛形状不是「已生效的个人赛」');

  // 每条记录都能在规格表里找到自己的范围
  const scopes = new Set(DEMO_CONTENT_SPECS.map(spec => `${spec.schoolId}/${spec.association}`));
  const scoped = doc => scopes.has(`${doc.schoolId}/${doc.association}`);
  assert.ok(content.announcements.every(scoped), '公告必须绑定规格表里的范围');
  assert.ok(content.events.every(scoped), '赛事必须绑定规格表里的范围');
  assert.ok(content.matches.every(scoped), '比赛必须绑定规格表里的范围');
  assert.ok(scoped(content.announcements[0]) && content.announcements.some(doc =>
    doc.schoolId === 'buaa'), '跨校内容也要有（切到北航不是空态）');

  const ids = [...content.announcements, ...content.events, ...content.matches].map(doc => doc._id);
  assert.equal(new Set(ids).size, ids.length, '演示记录编号必须唯一');
});

test('差异性 —— 各协会的公告条数与标题不同，跨校内容也不同', () => {
  const pkb = contentOf('muc', 'pkb');
  const tt = contentOf('muc', 'tt');
  const bd = contentOf('muc', 'bd');
  const buaa = contentOf('buaa', 'pkb');

  // 条数刻意拉开：5 / 4 / 3
  assert.deepEqual(
    [pkb.announcements.length, tt.announcements.length, bd.announcements.length], [5, 4, 3]);
  assert.deepEqual([pkb.events.length, tt.events.length, bd.events.length], [3, 2, 1]);

  // 标题两两不重复：切协会一眼看出不是同一批数据
  const titles = [...pkb.announcements, ...tt.announcements, ...bd.announcements]
    .map(doc => doc.title);
  assert.equal(new Set(titles).size, titles.length, '协会之间的公告标题不能重复');

  // 跨校：北航有自己的整套内容，且与民大不重名
  assert.equal(buaa.announcements.length, 4);
  assert.equal(buaa.events.length, 2);
  assert.equal(buaa.matches.length, 8);
  const crossTitles = [...pkb.announcements, ...buaa.announcements].map(doc => doc.title);
  assert.equal(new Set(crossTitles).size, crossTitles.length, '跨校公告标题不能重复');
});

/* ============================================================
 * 二、reset() 默认挂上演示内容
 * ============================================================ */

describe('schoolMock.reset() —— 默认挂上演示内容', () => {
  beforeEach(() => schoolMock.reset());

  test('协会空间能读到公告与赛事；三个榜单项目都有人', async () => {
    const api = schoolMock.forAssociationSpace(SCOPE);

    const ann = await api.listSchoolAnnouncements({});
    assert.equal(ann.ok, true);
    assert.equal(ann.announcements.length, 5);

    const events = await api.listSchoolEvents({});
    assert.equal(events.events.length, 3);

    for (const project of [RANK_PROJECT.MEN_SINGLES, RANK_PROJECT.WOMEN_SINGLES, RANK_PROJECT.DOUBLES]) {
      const view = await api.getSchoolRanking({ project });
      assert.ok(view.rows.length > 0, `${project} 应有榜单行`);
      assert.equal(view.empty, false);
    }
  });

  test('默认身份（u06）出现在男单榜，带「我」的名次', async () => {
    assert.equal(schoolMock.getDemoActor(), 'u06', '默认演示身份应跟随 mock.js 的默认会员');
    const api = schoolMock.forAssociationSpace(SCOPE);
    const view = await api.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });

    assert.ok(view.rows.some(row => row.isMe), '默认会员应在男单榜上标出「我」');
    assert.ok(view.me && view.me.rank > 0);
  });

  test('别的协会读的是自己的内容，不是匹克球那套', async () => {
    const pkb = schoolMock.forAssociationSpace(SCOPE);
    const tt = schoolMock.forAssociationSpace({ schoolId: 'muc', association: 'tt' });

    const pkbTitles = (await pkb.listSchoolAnnouncements({})).announcements.map(doc => doc.title);
    const ttTitles = (await tt.listSchoolAnnouncements({})).announcements.map(doc => doc.title);
    assert.equal(ttTitles.length, 4, '乒乓协会也有自己的公告');
    assert.ok(ttTitles.every(title => !pkbTitles.includes(title)), '两个协会的公告不重名');

    // 榜单按范围隔离：两个协会各有人，但榜单内容不是同一份
    // （同一个人可以同时是两个协会的会员，所以只守「各有自己的人」与「不是同一张榜」）
    const ttBoard = await tt.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });
    const pkbBoard = await pkb.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });
    const ttIds = ttBoard.rows.map(row => row.userId);
    const pkbIds = pkbBoard.rows.map(row => row.userId);

    assert.ok(ttIds.length > 0 && pkbIds.length > 0);
    assert.ok(ttIds.includes('u04'), '乒乓榜上应有乒乓协会的负责人 u04');
    assert.ok(!pkbIds.includes('u04'), 'u04 不在匹克球榜上（他只在乒乓协会有比赛）');
    assert.ok(pkbIds.includes('u03') && !ttIds.includes('u03'), 'u03 只在匹克球协会有比赛');
    assert.notDeepEqual(ttIds.slice().sort(), pkbIds.slice().sort(), '两张榜单不是同一份');
  });

  test('跨校：民大身份读不到北航内容，切到北航才看得到', async () => {
    // 当前身份 u06 是民大在册会员：读北航协会空间被拒（不是空内容，是没权限）
    const crossView = await schoolMock.forAssociationSpace({ schoolId: 'buaa', association: 'pkb' })
      .listSchoolAnnouncements({});
    assert.equal(crossView.ok, false);
    assert.match(crossView.message, /权限/);

    // 换成北航演示会员：读得到北航自己那套内容
    schoolMock.setDemoActor('demo_buaa_member');
    const ownView = await schoolMock.forAssociationSpace({ schoolId: 'buaa', association: 'pkb' })
      .listSchoolAnnouncements({});
    assert.equal(ownView.ok, true);
    assert.equal(ownView.announcements.length, 4);
    assert.ok(ownView.announcements.some(doc => doc.title.includes('北航')));
  });

  test('不同演示账号战绩不同（切身份数据跟着变）', async () => {
    const repoRead = async (userId) => {
      const api = schoolMock.forAssociationSpace({ schoolId: 'buaa', association: 'pkb' });
      const profile = await api.getSchoolMemberProfile({ userId });
      return profile.history.length;
    };
    schoolMock.setDemoActor('demo_buaa_member');
    const heavy = await repoRead('demo_buaa_member');
    const light = await repoRead('demo_buaa_college_leader');
    assert.ok(heavy > light, `同一协会里不同账号的场次应有差别（${heavy} vs ${light}）`);
  });
});

/* ============================================================
 * 三、withDemoContent: false 能把内容关干净
 * ============================================================ */

describe('schoolMock.reset({ withDemoContent: false }) —— 关干净', () => {
  test('公告 / 赛事 / 榜单都为空，供「自己摆几条再数条数」的用例使用', async () => {
    schoolMock.reset({ withDemoContent: false });
    const api = schoolMock.forAssociationSpace(SCOPE);

    assert.equal((await api.listSchoolAnnouncements({})).announcements.length, 0);
    assert.equal((await api.listSchoolEvents({})).events.length, 0);
    assert.equal((await api.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES })).rows.length, 0);
  });
});
