/**
 * 页面级复现：微信开发者工具 / 真机把路由 query **原样透传**（未解码）时，
 * 学院赛各页面的写操作能不能走通。
 *
 * 与 .review/repro-college.cjs 的差别：那一份只看服务端读/写接口收不收未解码
 * 编号；这一份真的把六个页面的配置起来跑 onLoad / onDraw / onSubmit，
 * 看页面实例上存的是不是「探测出的真实编号」。
 *
 * 用法：node .review/repro-college-page.cjs
 * 临时脚本，不提交。
 */
const mock = require('../miniprogram/services/school-mock.js');
const session = require('../miniprogram/services/school-session.js');
const association = require('../miniprogram/services/association-scope.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const ADMIN = 'demo_muc_admin';
const LEADER = 'demo_muc_college_leader';

const toasts = [];
global.wx = {
  showToast: options => toasts.push(options.title),
  navigateTo: () => {},
  navigateBack: () => {},
  showModal: options => options.success && options.success({ confirm: true }),
};

let captured = null;
global.Page = config => { captured = config; };
function configOf(file) {
  captured = null;
  // eslint-disable-next-line global-require
  require(file);
  return captured;
}
const detailConfig = configOf('../miniprogram/pages/college-event-detail/college-event-detail.js');
const entryConfig = configOf('../miniprogram/pages/college-entry/college-entry.js');
const reviewConfig = configOf('../miniprogram/pages/college-entry-review/college-entry-review.js');
const lineupConfig = configOf('../miniprogram/pages/college-lineup/college-lineup.js');
const matchConfig = configOf('../miniprogram/pages/college-match/college-match.js');
const placementConfig = configOf('../miniprogram/pages/college-placement/college-placement.js');

/** 与 tests/page.test.js 同一份最小实例化 */
function instantiate(config) {
  const page = {
    data: JSON.parse(JSON.stringify(config.data)),
    setData(patch, callback) {
      for (const [key, value] of Object.entries(patch)) {
        const path = key.split('.');
        let target = this.data;
        for (let i = 0; i < path.length - 1; i += 1) {
          if (target[path[i]] === null || typeof target[path[i]] !== 'object') target[path[i]] = {};
          target = target[path[i]];
        }
        target[path[path.length - 1]] = value;
      }
      if (callback) callback();
    },
  };
  for (const key of Object.keys(config)) {
    if (typeof config[key] === 'function') page[key] = config[key].bind(page);
  }
  return page;
}

const line = (label, value) => console.log(`${label} → ${value}`);

async function main() {
  mock.reset({ withDemoContent: false });
  session.setSchoolId(SCOPE.schoolId);
  association.setAssociation(SCOPE.association);
  mock.setDemoActor(ADMIN);
  const api = mock.forAssociationSpace(SCOPE);

  const published = await api.publishCollegeEvent({
    requestId: 'repro_page_1', title: '页面级复现学院赛', description: '',
    legPlan: ['MS'], allowMultiEntry: true, rosterMin: 1, rosterMax: 20,
    tieAlgo: 'full_points', tieNetMode: 'win_diff',
    startTime: '2026-12-01T09:00:00', location: '体育馆', courtCount: 1,
  });
  if (!published.ok) throw new Error(published.message);
  const eventId = published.event.eventId;
  const routeEventId = encodeURIComponent(eventId);
  line('真实编号', eventId);
  line('路由里的值', routeEventId);

  // 两份名单：本院那一份用**名单页**交（模拟真实操作），另一份由管理员代交
  const membersRes = await api.listSchoolMembers({});
  const members = membersRes.members.filter(item => ['M', 'F'].includes(item.gender));
  const colleges = [...new Set(members.map(item => item.collegeName))];
  const collegeA = colleges.find(name => name === '民族学与社会学学院') || colleges[0];
  const collegeB = colleges.find(name => name !== collegeA);
  const idsOf = name => members.filter(item => item.collegeName === name).map(item => item.userId);
  console.log('参赛学院', collegeA, '/', collegeB);

  mock.setDemoActor(LEADER);
  const entryPage = instantiate(entryConfig);
  await entryPage.onLoad({ eventId: routeEventId });
  line('名单页 page.eventId', entryPage.eventId);
  line('名单页 view.canSubmit / college', `${entryPage.data.view.canSubmit} / ${entryPage.data.view.college}`);
  entryPage.onToggleMember({ detail: { value: idsOf(collegeA) } });
  toasts.length = 0;
  await entryPage.onSubmit();
  line('名单页 onSubmit 提示', JSON.stringify(toasts));

  mock.setDemoActor(ADMIN);
  const otherSubmit = await api.submitCollegeEntry({ eventId, college: collegeB, memberIds: idsOf(collegeB) });
  if (!otherSubmit.ok) throw new Error(`代交名单失败：${otherSubmit.message}`);

  const reviewPage = instantiate(reviewConfig);
  await reviewPage.onLoad({ eventId: routeEventId });
  line('审核页 page.eventId', reviewPage.eventId);
  line('审核页 view.canReview / pendingCount', `${reviewPage.data.view.canReview} / ${reviewPage.data.view.pendingCount}`);
  for (const row of (reviewPage.data.view.rows || []).slice()) {
    toasts.length = 0;
    await reviewPage.onApprove({ currentTarget: { dataset: { entryId: row.entryId } } });
    line(`审核页 onApprove[${row.college}] 提示`, JSON.stringify(toasts));
  }
  line('审核后 pendingCount', reviewPage.data.view.pendingCount);

  /* ---------- 详情页：未解码 query 下的抽签 / 开赛 ---------- */
  const detail = instantiate(detailConfig);
  await detail.onLoad({ eventId: routeEventId });
  line('详情页 page.eventId', detail.eventId);
  line('详情页 view.found / blockReason', `${detail.data.view.found} / ${detail.data.view.blockReason || '（空）'}`);

  toasts.length = 0;
  await detail.onDraw();
  line('详情页 onDraw 提示', JSON.stringify(toasts));
  line('抽签后 view.isReady', detail.data.view.isReady);

  toasts.length = 0;
  await detail.onStartEvent();
  line('详情页 onStartEvent 提示', JSON.stringify(toasts));
  line('开赛后 view.isOngoing / ties', `${detail.data.view.isOngoing} / ${(detail.data.view.ties || []).length}`);

  /* ---------- 排阵页：未解码 query 下替两侧排阵 ---------- */
  const tie = (detail.data.view.ties || [])[0];
  if (!tie) {
    console.log('没有大场，后续步骤跳过');
    return;
  }
  const tieId = tie.tieId;
  const routeTieId = encodeURIComponent(tieId);
  line('真实大场编号', tieId);
  for (const college of [collegeA, collegeB]) {
    // 本院负责人排本侧；另一侧由管理员代交（判权在服务端，与页面口径一致）
    mock.setDemoActor(college === collegeA ? LEADER : ADMIN);
    session.setSchoolId(SCOPE.schoolId);
    const lineup = instantiate(lineupConfig);
    await lineup.onLoad({ tieId: routeTieId, eventId: routeEventId, college });
    line(`排阵页[${college}] page.tieId`, lineup.tieId);
    const roster = idsOf(college);
    for (const leg of lineup.data.view.legs) {
      lineup.onTogglePlayer({ currentTarget: { dataset: { legNo: leg.legNo } }, detail: { value: [roster[leg.legNo - 1]] } });
    }
    toasts.length = 0;
    await lineup.onSubmit();
    line(`排阵页[${college}] onSubmit 提示`, JSON.stringify(toasts));
  }

  /* ---------- 详情页开大场 → 小场页录分确认 ---------- */
  mock.setDemoActor(ADMIN);
  await detail.refresh();
  toasts.length = 0;
  await detail.onStartTie({ currentTarget: { dataset: { tieId } } });
  line('详情页 onStartTie 提示', JSON.stringify(toasts));

  const leg = ((detail.data.view.ties || [])[0] || {}).legRows ? detail.data.view.ties[0].legRows[0] : null;
  if (!leg) {
    console.log('没有小场，后续步骤跳过');
    return;
  }
  const matchId = leg.matchId;
  line('真实小场编号', matchId);
  const match = instantiate(matchConfig);
  await match.onLoad({ matchId: encodeURIComponent(matchId) });
  line('小场页 page.matchId', match.matchId);

  toasts.length = 0;
  await match.onSubmit();
  line('小场页 onSubmit（未录分）提示', JSON.stringify(toasts));
  const wins = Math.floor(match.data.view.bestOf / 2) + 1;
  for (let slot = 0; slot < wins; slot += 1) {
    match.onInputScore({ currentTarget: { dataset: { side: 'A', slot } }, detail: { value: String(match.data.view.gamePoints) } });
    match.onInputScore({ currentTarget: { dataset: { side: 'B', slot } }, detail: { value: '3' } });
  }
  toasts.length = 0;
  await match.onSubmit();
  line('小场页 onSubmit 提示', JSON.stringify(toasts));
  await match.onConfirm();
  line('小场页 onConfirm 后 view.status', match.data.view.status);

  /* ---------- 名次页：未解码 query 下结束赛事 ---------- */
  mock.setDemoActor(ADMIN);
  await detail.refresh();
  const placement = instantiate(placementConfig);
  await placement.onLoad({ eventId: routeEventId });
  line('名次页 page.eventId', placement.eventId);
  for (const [index, row] of (placement.data.view.rows || []).entries()) {
    placement.onInputPlacement({ currentTarget: { dataset: { index } }, detail: { value: row.college === collegeA ? '1' : '2' } });
  }
  toasts.length = 0;
  await placement.onSubmit();
  line('名次页 onSubmit 提示', JSON.stringify(toasts));
  line('名次页 errorText', placement.data.errorText || '（空）');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
