/**
 * 学校维度演示内容（公告 / 赛事 / 比赛）自检（迁移清单 C）
 * ============================================================
 * schoolMock.reset() 默认给民大匹克球协会摆上演示内容，协会空间与排行榜
 * 一进去就有东西可看，不必先手工发几条。这里守两件事：
 *   1. 内容确实落在 muc + pkb，且是被服务读得出来的完整记录（不是半截）；
 *   2. reset({ withDemoContent: false }) 能把内容关干净——公告页那类
 *      「自己摆几条再数条数」的用例全靠它，否则条数会随演示内容的多寡漂移。
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createSchoolDemoContent } = require('../miniprogram/services/school-seed.js');
const { isAnnouncementDoc } = require('../miniprogram/services/school-announcement-service.js');
const { isEventDoc } = require('../miniprogram/services/school-event-service.js');
const schoolMock = require('../miniprogram/services/school-mock.js');
const {
  MATCH_STATUS, MATCH_OUTCOME, MATCH_COMPETITION, RANK_PROJECT,
} = require('../miniprogram/utils/constants.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };

/* ============================================================
 * 一、纯形状：三批记录都绑定民大匹克球协会，形状可被服务读出来
 * ============================================================ */

test('演示内容 —— 三批记录都绑定民大匹克球协会，形状可被服务读出来', () => {
  const content = createSchoolDemoContent();

  assert.equal(content.announcements.length, 3);
  assert.equal(content.events.length, 2);
  assert.equal(content.matches.length, 9);

  const scoped = doc => doc.schoolId === 'muc' && doc.association === 'pkb';
  assert.ok(content.announcements.every(doc => scoped(doc) && isAnnouncementDoc(doc)), '公告形状不完整');
  assert.ok(content.events.every(doc => scoped(doc) && isEventDoc(doc)), '赛事形状不完整');
  assert.ok(content.matches.every(doc => scoped(doc)
    && doc.status === MATCH_STATUS.ACTIVE
    && doc.outcome === MATCH_OUTCOME.NORMAL
    && doc.competition === MATCH_COMPETITION.PERSONAL), '比赛形状不是「已生效的个人赛」');

  const ids = [...content.announcements, ...content.events, ...content.matches].map(doc => doc._id);
  assert.equal(new Set(ids).size, ids.length, '演示记录编号必须唯一');
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
    assert.equal(ann.announcements.length, 3);

    const events = await api.listSchoolEvents({});
    assert.equal(events.events.length, 2);

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

  test('别的协会读不到演示内容（按范围隔离）', async () => {
    const api = schoolMock.forAssociationSpace({ schoolId: 'muc', association: 'tt' });
    const view = await api.getSchoolRanking({ project: RANK_PROJECT.MEN_SINGLES });

    assert.equal(view.rows.length, 0);
    assert.equal(view.empty, true);
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
