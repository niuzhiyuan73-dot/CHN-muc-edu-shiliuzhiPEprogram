/**
 * 数据源门面 与 本地模拟数据源 单元测试
 *
 * 门面的价值全在「两个实现可以互换」这一点上。所以这里最要紧的断言是：
 * mock 与 cloud 导出的函数名必须完全一致——少一个，切换数据源后
 * 那个页面就会在运行时崩掉，而那时往往已经上线了。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const mock = require('../miniprogram/services/mock.js');
const cloud = require('../miniprogram/services/cloud.js');
const facade = require('../miniprogram/services/index.js');
const {
  RATING_POOL,
  ALL_RATING_POOLS,
  RANK_PROJECT,
  ALL_RANK_PROJECTS,
  ROLE,
  MATCH_TYPE,
  MATCH_STATUS,
  USER_STATUS,
  ANNOUNCEMENT_STATUS,
  EVENT_STATUS,
  SIGNUP_STATUS,
  EVENT_LEVEL,
  EVENT_BRONZE_MODE,
  BRACKET_STAGE,
  SEED_MODE,
  EVENT_FORMAT,
} = require('../miniprogram/utils/constants.js');

/**
 * 管理类写入要由管理员或有干事权限的账号执行。
 * 种子里 u01 巴特尔是管理员、u02 张宇轩是干事；getCurrentUser() 答的是
 * 普通会员 u06，拿它去审核 / 发公告 / 管理赛事都会被权限闸门挡回来。
 */
const ADMIN_ID = 'u01';
const getManager = () => mock.getMember(ADMIN_ID);

describe('数据源门面 —— 实现可互换', () => {
  test('mock 与 cloud 导出同一组接口', () => {
    const mockKeys = Object.keys(mock).filter((k) => typeof mock[k] === 'function').sort();
    const cloudKeys = Object.keys(cloud).filter((k) => typeof cloud[k] === 'function').sort();

    // request / resetCache / load 是各自实现特有的内部工具，不参与接口约定
    const internal = ['request', 'resetCache', 'load'];
    const expected = mockKeys.filter((k) => !internal.includes(k));
    const actual = cloudKeys.filter((k) => !internal.includes(k));

    assert.deepEqual(actual, expected, '两个数据源导出的接口必须一一对应');
  });

  test('门面默认使用模拟数据源', () => {
    assert.equal(facade.isMock, true);
    assert.equal(facade.currentSource, 'mock');
  });

  test('门面把实现的方法都透传出来', () => {
    for (const name of ['getMembers', 'getLeaderboard', 'getMatchHistory', 'getMyProjects']) {
      assert.equal(typeof facade[name], 'function', `门面缺少 ${name}`);
    }
  });

  test('门面暴露的接口在 mock 里都真实存在', () => {
    for (const [name, value] of Object.entries(mock)) {
      if (typeof value !== 'function') continue;
      assert.equal(typeof facade[name], 'function', `门面没有透传 ${name}`);
    }
  });
});

describe('数据源门面 —— 开关真的接线', () => {
  /**
   * 这一组守的是一个曾经真实存在的缺陷：门面在模块加载时就把某个实现
   * 展开成固定属性，于是 setDataSource 沦为空壳——app.js 把开关拨到
   * cloud，取数却仍走 mock，页面上一片正常，只有真机联调才会发现
   * 「怎么改都不生效」。所以这里断言的不是标志位，而是调用真的换了去处。
   * 统一的 finally 复位：漏一条就会把后面所有用例拖进 cloud 模式。
   */
  function withSource(name, fn) {
    return async () => {
      const original = facade.getDataSource();
      facade.setDataSource(name);
      try {
        await fn();
      } finally {
        facade.setDataSource(original);
      }
    };
  }

  test(
    '切到 cloud 后，调用走到云端实现（没有云环境就报未初始化）',
    withSource('cloud', async () => {
      assert.equal(facade.getDataSource(), 'cloud');
      assert.equal(facade.isMockNow(), false);
      await assert.rejects(() => facade.getMembers(), /云开发尚未初始化/);
    })
  );

  test(
    '切回 mock 后，同一函数名又能取到本地数据',
    withSource('mock', async () => {
      const members = await facade.getMembers();
      assert.ok(members.length > 0);
    })
  );

  test('切换数据源会同步改变 isMock 与 currentSource 的读数', async () => {
    const original = facade.getDataSource();
    try {
      facade.setDataSource('cloud');
      assert.equal(facade.isMock, false);
      assert.equal(facade.currentSource, 'cloud');
    } finally {
      facade.setDataSource(original);
    }
    assert.equal(facade.isMock, true);
    assert.equal(facade.currentSource, 'mock');
  });

  test('不认识的数据源被当场拒绝，不会把门面留在坏状态', () => {
    assert.throws(() => facade.setDataSource('sqlite'), /未知的数据源/);
    assert.equal(facade.getDataSource(), 'mock');
  });

  test(
    'mock 专有的 resetCache 在 cloud 下给出明确报错，而不是「不是函数」',
    withSource('cloud', async () => {
      assert.throws(() => facade.resetCache(), /当前数据源（cloud）不支持 resetCache/);
    })
  );
});

describe('cloud 数据源 —— 未接通时明确报错', () => {
  test('没有云环境时抛出可读的错误，而不是返回假数据', async () => {
    await assert.rejects(() => cloud.getMembers(), /云开发尚未初始化/);
  });
});

describe('mock 数据源 —— 基础读取', () => {
  test('会员、比赛、赛事都能取到', async () => {
    const members = await mock.getMembers();
    const matches = await mock.getMatches();
    const events = await mock.getEvents();

    assert.ok(members.length > 0);
    assert.ok(matches.length > 0);
    assert.ok(events.length > 0);
  });

  test('同一份数据被缓存复用，不会每次重新生成', async () => {
    const a = await mock.getMembers();
    const b = await mock.getMembers();
    assert.equal(a, b, '应返回同一个数组引用，说明用的是缓存');
  });

  test('按会员筛选比赛', async () => {
    const matches = await mock.getMatches({ userId: 'u01' });
    for (const m of matches) {
      assert.ok([...m.teamA, ...m.teamB].includes('u01'));
    }
  });

  test('按池筛选比赛', async () => {
    const matches = await mock.getMatches({ pool: RATING_POOL.DOUBLES });
    assert.ok(matches.length > 0);
    for (const m of matches) assert.equal(m.pool, RATING_POOL.DOUBLES);
  });

  test('比赛对外按时间倒序返回（最近的在前）', async () => {
    const matches = await mock.getMatches({ limit: 20 });
    for (let i = 1; i < matches.length; i += 1) {
      assert.ok(new Date(matches[i - 1].matchTime) >= new Date(matches[i].matchTime));
    }
  });

  test('limit 生效', async () => {
    assert.equal((await mock.getMatches({ limit: 5 })).length, 5);
  });

  test('查询单个会员，查不到时返回 null', async () => {
    assert.ok(await mock.getMember('u01'));
    assert.equal(await mock.getMember('ghost'), null);
  });

  test('当前登录会员是中游选手，便于演示「进步」', async () => {
    const me = await mock.getCurrentUser();
    const pools = await mock.getMyProjects(me._id);
    assert.ok(pools.length > 0);
    // 不应是榜首，否则页面上看不到追赶的意味
    assert.ok(pools.every((p) => p.rank === null || p.rank > 1));
  });
});

describe('mock 数据源 —— 榜单', () => {
  test('每个项目都能出榜，且名次连续', async () => {
    for (const project of ALL_RANK_PROJECTS) {
      const board = await mock.getLeaderboard(project);
      assert.ok(board.length > 0, `${project} 榜单为空`);
      board.forEach((row, i) => assert.equal(row.rank, i + 1));
    }
  });

  test('榜单按该项目分数降序排列', async () => {
    const board = await mock.getLeaderboard(RANK_PROJECT.DOUBLES);
    for (let i = 1; i < board.length; i += 1) {
      assert.ok(board[i - 1].elo >= board[i].elo);
    }
  });

  test('进步榜默认只收场次达标的人', async () => {
    const board = await mock.getProgressLeaderboard(RANK_PROJECT.DOUBLES);
    assert.ok(board.length > 0);
    for (const row of board) assert.ok(row.matchCount >= 5);
  });

  test('进步榜按涨幅降序排列', async () => {
    const board = await mock.getProgressLeaderboard(RANK_PROJECT.DOUBLES);
    for (let i = 1; i < board.length; i += 1) {
      assert.ok(board[i - 1].delta >= board[i].delta);
    }
  });

  test('百分位能查到，且名次与榜单一致', async () => {
    const board = await mock.getLeaderboard(RANK_PROJECT.DOUBLES);
    const target = board[3];
    const stats = await mock.getPercentile(target._id, RANK_PROJECT.DOUBLES);
    assert.equal(stats.rank, 4);
    assert.equal(stats.total, board.length);
  });

  test('查不到的会员返回 null', async () => {
    assert.equal(await mock.getPercentile('ghost', RANK_PROJECT.DOUBLES), null);
  });
});

describe('mock 数据源 —— 个人战绩', () => {
  test('逐场战绩带出搭档与对手的昵称', async () => {
    const history = await mock.getMatchHistory('u01', { limit: 10 });
    assert.ok(history.length > 0);
    for (const item of history) {
      assert.ok(Array.isArray(item.opponentNames));
      assert.ok(item.opponentNames.every((n) => typeof n === 'string' && n.length > 0));
    }
  });

  test('交锋记录不会把自己算进去，昵称可读', async () => {
    const table = await mock.getHeadToHead('u01');
    assert.ok(table.length > 0);
    for (const row of table) {
      assert.notEqual(row.opponentId, 'u01');
      assert.notEqual(row.nickName, row.opponentId, '昵称没有被解析出来');
    }
  });

  test('搭档记录只包含双打搭档', async () => {
    const table = await mock.getPartnerRecord('u01');
    assert.ok(table.length > 0);
    for (const row of table) assert.notEqual(row.partnerId, 'u01');
  });

  test('分数曲线的终点等于当前分数', async () => {
    const me = await mock.getCurrentUser();
    const curve = await mock.getRatingHistory(me._id, RATING_POOL.DOUBLES);
    assert.ok(curve.length > 0);
    assert.equal(curve[curve.length - 1].eloAfter, me.ratings[RATING_POOL.DOUBLES].elo);
  });

  test('赛事名次附带汇总', async () => {
    const me = await mock.getCurrentUser();
    const { records, summary } = await mock.getEventRecord(me._id);
    assert.ok(records.length > 0);
    assert.equal(summary.eventCount, records.length);
    assert.ok(summary.bestPlacement >= 1);
    assert.ok(summary.championCount <= summary.topThreeCount);
  });

  test('近期状态返回胜负序列', async () => {
    const form = await mock.getForm('u01', { limit: 5 });
    assert.ok(form.results.length <= 5);
    assert.equal(form.wins + form.losses, form.results.length);
  });

  test('我的各项目分数只包含打过的项目，且带名次', async () => {
    const me = await mock.getCurrentUser();
    const projects = await mock.getMyProjects(me._id);
    for (const p of projects) {
      assert.ok(p.matchCount > 0);
      assert.ok(ALL_RANK_PROJECTS.includes(p.project));
      // 项目是展示口径，池是取数口径，两者都要带上且各自合法
      assert.ok(ALL_RATING_POOLS.includes(p.pool));
      assert.ok(p.rank >= 1 && p.rank <= p.total);
      assert.equal(p.delta, p.elo - p.startElo);
      assert.equal(p.wins + p.losses, p.matchCount);
    }
  });

  test('从未参赛的会员返回空的各项目列表', async () => {
    assert.deepEqual(await mock.getMyProjects('ghost'), []);
  });
});

describe('mock 数据源 —— 公告', () => {
  test('公告能取到，字段完整', async () => {
    const list = await mock.getAnnouncements();
    assert.ok(list.length > 0);
    for (const item of list) {
      assert.ok(item._id);
      assert.ok(item.title);
      assert.ok(item.content);
      assert.ok(item.publishTime);
    }
  });

  test('公告按发布时间倒序返回', async () => {
    const list = await mock.getAnnouncements();
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(new Date(list[i - 1].publishTime) >= new Date(list[i].publishTime));
    }
  });

  test('公告发布时间落在赛季区间内，不会早于开赛', async () => {
    const list = await mock.getAnnouncements();
    const { seasonRange } = await mock.getHomeSummary();
    // 开训公告发在首场活动当天的上午，比第一场球早几个小时是正常的，
    // 所以只要求不早于开赛前一天（而不是不早于第一场比赛那一刻）
    const dayMs = 24 * 60 * 60 * 1000;
    const lowerBound = new Date(seasonRange.from).getTime() - dayMs;

    for (const item of list) {
      const time = new Date(item.publishTime).getTime();
      assert.ok(time >= lowerBound, `公告 ${item._id} 早于赛季开始`);
      assert.ok(time <= new Date(seasonRange.to).getTime(), `公告 ${item._id} 晚于赛季结束`);
    }
  });
});

describe('mock 数据源 —— 首页概览', () => {
  test('汇总人数、场次、赛事数', async () => {
    const summary = await mock.getHomeSummary();
    assert.equal(summary.memberCount, (await mock.getMembers()).length);
    assert.ok(summary.matchCount > 0);
    assert.ok(summary.eventCount > 0);
  });

  test('每个项目都给出前三名', async () => {
    const summary = await mock.getHomeSummary();
    for (const project of ALL_RANK_PROJECTS) {
      const entry = summary.topByProject[project];
      assert.ok(entry, `${project} 缺少概览`);
      assert.ok(entry.top.length > 0 && entry.top.length <= 3);
      assert.ok(entry.playerCount > 0);
    }
  });

  test('概览里的榜首就是榜单第一', async () => {
    const summary = await mock.getHomeSummary();
    for (const project of ALL_RANK_PROJECTS) {
      const board = await mock.getLeaderboard(project);
      const firstPlayed = board.find((p) => p.matchCount > 0);
      assert.equal(summary.topByProject[project].top[0]._id, firstPlayed._id);
    }
  });
});

describe('mock 数据源 —— 比赛录入与流转', () => {
  /**
   * 写操作会往台账里塞东西、并让缓存失效。
   * 后面那些断言数组引用的用例经不起这么一搅，所以每条用例前后都复位。
   */
  function withCleanStore(fn) {
    return async () => {
      mock.resetCache();
      try {
        await fn();
      } finally {
        mock.resetCache();
      }
    };
  }

  /** 一份合法的单打录入参数（时间落在赛季区间内且早于现在） */
  function singlesDraft(overrides = {}) {
    return {
      matchType: MATCH_TYPE.SINGLES,
      teamA: ['u06'],
      teamB: ['u01'],
      scoreA: ['11', '11'],
      scoreB: ['9', '7'],
      gamePoints: 11,
      bestOf: 3,
      matchTime: '2026-05-01T18:00:00',
      location: '学校体育馆 1 号场',
      ...overrides,
    };
  }

  test(
    '台账把全部比赛都列出来，比赛流水只列已生效的',
    withCleanStore(async () => {
      const records = await mock.getMatchRecords();
      const active = await mock.getMatches();

      // 演示赛事里排好签、还没开打的半决赛只进台账，不进成绩公示
      const pending = records.filter((record) => record.status === MATCH_STATUS.PENDING);
      assert.ok(pending.length > 0, '种子里应当留有待确认的演示场次');
      assert.equal(records.length, active.length + pending.length);
      assert.ok(records.length > 0);
    })
  );

  test(
    '成绩公示口径不变：matches 里每一场都已生效',
    withCleanStore(async () => {
      // 这是整个 P3 最要紧的一条不变式。回放引擎会把送进去的每一场
      // 无条件改写成 ACTIVE，所以「待确认不得进入回放」只能靠数据层
      // 在回放之前挡住——这里就是那道闸门的守门测试。
      const { matches } = mock.load();
      assert.ok(matches.length > 0);
      assert.ok(matches.every((m) => m.status === MATCH_STATUS.ACTIVE));
    })
  );

  test(
    '录入一场之后，它出现在台账里但不在成绩公示里',
    withCleanStore(async () => {
      const before = (await mock.getMatches()).length;
      const result = await mock.submitMatch(singlesDraft());

      assert.equal(result.ok, true, result.firstError);
      assert.equal(result.match.status, MATCH_STATUS.PENDING);

      const records = await mock.getMatchRecords({ status: MATCH_STATUS.PENDING });
      assert.ok(records.some((m) => m._id === result.match._id));

      // 最重要的一步：未生效的比赛绝不能混进成绩公示
      const afterActive = await mock.getMatches();
      assert.equal(afterActive.length, before);
      assert.ok(!afterActive.some((m) => m._id === result.match._id));
    })
  );

  test(
    '按状态过滤台账，status 为 0 时也能正确筛选',
    withCleanStore(async () => {
      // 0 是合法状态，用真值判断的话这里会返回全部，测不出问题。
      // 种子里的演示赛事本来就留了几场待确认，先记下基线再比对。
      const seeded = await mock.getMatchRecords({ status: MATCH_STATUS.PENDING });
      assert.ok(seeded.length > 0, '种子里应当留有待确认的演示场次');
      assert.ok(seeded.every((record) => record.status === MATCH_STATUS.PENDING));

      const { match } = await mock.submitMatch(singlesDraft());
      const pending = await mock.getMatchRecords({ status: MATCH_STATUS.PENDING });
      assert.equal(pending.length, seeded.length + 1);
      assert.ok(pending.some((record) => record._id === match._id));
      assert.ok(pending.every((record) => record.status === MATCH_STATUS.PENDING));
    })
  );

  test(
    '录入的校验错误原样返回，不落台账',
    withCleanStore(async () => {
      const before = (await mock.getMatchRecords({ status: MATCH_STATUS.PENDING })).length;
      const result = await mock.submitMatch(singlesDraft({ scoreA: ['11'], scoreB: ['10'] }));

      assert.equal(result.ok, false);
      assert.ok(result.firstError.includes('领先 2 分'));
      assert.equal(result.match, null);
      assert.equal((await mock.getMatchRecords({ status: MATCH_STATUS.PENDING })).length, before);
    })
  );

  test(
    '确认之后成绩才计入等级分，撤销之后又回滚',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const before = (await mock.getMyProjects(me._id)).find(
        (p) => p.project === RANK_PROJECT.MEN_SINGLES
      );

      const { match } = await mock.submitMatch(singlesDraft());
      const confirmed = await mock.confirmMatch(match._id, me._id);
      assert.equal(confirmed.ok, true, confirmed.message);
      assert.equal((await mock.getMatchRecords({ status: MATCH_STATUS.ACTIVE })).length > 0, true);

      const afterConfirm = (await mock.getMyProjects(me._id)).find(
        (p) => p.project === RANK_PROJECT.MEN_SINGLES
      );
      // 多了这一场，出场次数必然增加
      assert.equal(afterConfirm.matchCount, before.matchCount + 1);

      const revoked = await mock.revokeMatch(match._id, me._id, '对手记错了比分');
      assert.equal(revoked.ok, true, revoked.message);

      const afterRevoke = (await mock.getMyProjects(me._id)).find(
        (p) => p.project === RANK_PROJECT.MEN_SINGLES
      );
      // 回滚是「从零重放」，所以分数应当一模一样地回到撤销之前
      assert.equal(afterRevoke.matchCount, before.matchCount);
      assert.equal(afterRevoke.elo, before.elo);
    })
  );

  test(
    '撤销和驳回都必须给理由',
    withCleanStore(async () => {
      const seeded = (await mock.getMatchRecords({ status: MATCH_STATUS.PENDING })).length;
      const me = await mock.getCurrentUser();
      const { match } = await mock.submitMatch(singlesDraft());

      const noReason = await mock.revokeMatch(match._id, me._id, '   ');
      assert.equal(noReason.ok, false);
      assert.match(noReason.message, /理由/);

      const rejected = await mock.rejectMatch(match._id, me._id, '');
      assert.equal(rejected.ok, false);
      assert.match(rejected.message, /理由/);

      // 没给理由就不该改动任何状态：刚录入的那场仍停在待确认
      assert.equal(
        (await mock.getMatchRecords({ status: MATCH_STATUS.PENDING })).length,
        seeded + 1
      );
    })
  );

  test(
    '驳回写的是「已撤销」状态，另存行动以便与撤销区分',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const { match } = await mock.submitMatch(singlesDraft());

      const rejected = await mock.rejectMatch(match._id, me._id, '这局比分录反了');
      assert.equal(rejected.ok, true, rejected.message);

      const [record] = await mock.getMatchRecords({ status: MATCH_STATUS.REVOKED });
      assert.equal(record._id, match._id);
      // 不新增第 4 个枚举，靠 action 区分是「驳回」还是「撤销」
      assert.equal(record.action, 'reject');
      assert.equal(record.reason, '这局比分录反了');
    })
  );

  test(
    '已生效的比赛不能撤销两次',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const { match } = await mock.submitMatch(singlesDraft());
      await mock.confirmMatch(match._id, me._id);

      assert.equal((await mock.revokeMatch(match._id, me._id, '第一次')).ok, true);
      const again = await mock.revokeMatch(match._id, me._id, '第二次');
      assert.equal(again.ok, false);
      assert.match(again.message, /已经作废/);
    })
  );

  test(
    '查不到的比赛给出明确的失败，而不是抛异常',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      for (const action of [
        () => mock.confirmMatch('nope', me._id),
        () => mock.rejectMatch('nope', me._id, '理由'),
        () => mock.revokeMatch('nope', me._id, '理由'),
      ]) {
        const result = await action();
        assert.equal(result.ok, false);
        assert.match(result.message, /找不到/);
      }
    })
  );

  test(
    '确认 / 撤销 / 驳回返回的都是改动后的那条记录',
    withCleanStore(async () => {
      // 页面拿到 result.match 后直接拿去渲染（比如 college-match 页用它的
      // status 决定按钮），若回的是改动前的快照，页面上会看到「刚确认完
      // 还是待确认」。三个动作各验一遍，与云端 { ...current, ...patch } 对齐。
      const me = await mock.getCurrentUser();
      // 自然键含时间，三场要各给一个不同的 matchTime，否则会撞成同一 _id
      const at = (time) => singlesDraft({ matchTime: time });

      const a = (await mock.submitMatch(at('2026-05-01T18:00:00'))).match;
      const confirmed = await mock.confirmMatch(a._id, me._id);
      assert.equal(confirmed.match.status, MATCH_STATUS.ACTIVE);
      assert.equal(confirmed.match.action, 'confirm');

      const b = (await mock.submitMatch(at('2026-05-02T18:00:00'))).match;
      const rejected = await mock.rejectMatch(b._id, me._id, '录反了');
      assert.equal(rejected.match.status, MATCH_STATUS.REVOKED);
      assert.equal(rejected.match.action, 'reject');

      const c = (await mock.submitMatch(at('2026-05-03T18:00:00'))).match;
      const revoked = await mock.revokeMatch(c._id, me._id, '重打了一场');
      assert.equal(revoked.match.status, MATCH_STATUS.REVOKED);
      assert.equal(revoked.match.action, 'revoke');
    })
  );
});

describe('mock 数据源 —— 会员注册与审核', () => {
  /** 写操作会往账号台账里塞东西，所以每条用例前后都复位（同上） */
  function withCleanStore(fn) {
    return async () => {
      mock.resetCache();
      try {
        await fn();
      } finally {
        mock.resetCache();
      }
    };
  }

  /** 一份合法的实名信息 */
  const draft = {
    realName: '测试同学',
    gender: 'M',
    studentId: '20240099',
    college: '法学院',
    phone: '13700001111',
  };

  test(
    '预置两条待审核申请，且不计入会员数',
    withCleanStore(async () => {
      const applications = await mock.getMemberApplications();

      assert.equal(applications.length, 2);
      for (const item of applications) assert.equal(item.status, USER_STATUS.PENDING);
      // 待审核的人不算会员：录进申请台账，但不进会员名单
      assert.equal((await mock.getMembers()).length, 24);
      assert.equal((await mock.getHomeSummary()).memberCount, 24);
    })
  );

  test(
    '注册只产生申请：会员数不变，榜单一个字节都不动',
    withCleanStore(async () => {
      const doublesBefore = await mock.getLeaderboard(RANK_PROJECT.DOUBLES);
      const singlesBefore = await mock.getLeaderboard(RANK_PROJECT.MEN_SINGLES);

      const result = await mock.registerMember(draft);
      assert.equal(result.ok, true, result.firstError);
      // 注册只是申请，绝不能自己把自己激活
      assert.equal(result.account.status, USER_STATUS.PENDING);

      assert.equal((await mock.getMembers()).length, 24);
      assert.equal((await mock.getHomeSummary()).memberCount, 24);
      // 这是最要紧的一条：没转正的人不该在任何一张榜上出现
      assert.deepEqual(await mock.getLeaderboard(RANK_PROJECT.DOUBLES), doublesBefore);
      assert.deepEqual(await mock.getLeaderboard(RANK_PROJECT.MEN_SINGLES), singlesBefore);
      // 但审核页要能取到他、也要能解析出他的昵称
      assert.ok((await mock.getMemberApplications()).some((a) => a.studentId === '20240099'));
      assert.ok(await mock.getMember(result.account._id));
    })
  );

  test(
    '注册校验不过则原样报错，不落台账',
    withCleanStore(async () => {
      const before = (await mock.getMemberApplications()).length;
      const result = await mock.registerMember({ ...draft, phone: '123' });

      assert.equal(result.ok, false);
      assert.ok(result.errors.phone);
      assert.ok(result.firstError);
      assert.equal(result.account, null);
      // 被拒绝的调用不许留下任何痕迹
      assert.equal((await mock.getMemberApplications()).length, before);
    })
  );

  test(
    '通过审核后才成为会员，榜单多出一行',
    withCleanStore(async () => {
      const me = await getManager();
      const before = await mock.getLeaderboard(RANK_PROJECT.DOUBLES);

      const { account } = await mock.registerMember(draft);
      const approved = await mock.approveMember(account._id, me._id);
      assert.equal(approved.ok, true, approved.message);
      assert.equal(approved.account.status, USER_STATUS.ACTIVE);

      const members = await mock.getMembers();
      assert.equal(members.length, before.length + 1);
      assert.ok(members.some((m) => m._id === account._id));
      assert.equal((await mock.getHomeSummary()).memberCount, members.length);
      assert.equal((await mock.getLeaderboard(RANK_PROJECT.DOUBLES)).length, before.length + 1);
      // 转正之后就不再是「申请」了
      assert.ok(!(await mock.getMemberApplications()).some((a) => a._id === account._id));
    })
  );

  test(
    '通过时手工指定初始分：新会员直接以该分上榜，不再走自动定级',
    withCleanStore(async () => {
      const me = await getManager();
      const { account } = await mock.registerMember(draft);

      const approved = await mock.approveMember(account._id, me._id, 1620);
      assert.equal(approved.ok, true, approved.message);
      // 指定分要落在账号上，回放据此跳过前五场定级
      assert.equal(approved.account.initialElo, 1620);

      // 男会员默认初始分是 1450，指定 1620 说明覆盖真的生效了
      const board = await mock.getLeaderboard(RANK_PROJECT.MEN_SINGLES);
      const row = board.find((p) => p.userId === account._id || p._id === account._id);
      assert.ok(row, '新会员应当出现在男单榜上');
      assert.equal(row.elo, 1620);
    })
  );

  test(
    '初始分越界时整单被挡下，申请保持待审核',
    withCleanStore(async () => {
      const me = await getManager();
      const { account } = await mock.registerMember(draft);

      const approved = await mock.approveMember(account._id, me._id, 99999);
      assert.equal(approved.ok, false);
      assert.match(approved.message, /之间/);
      // 被拒绝的调用不许改动账号状态
      const applications = await mock.getMemberApplications();
      assert.equal(applications.find((a) => a._id === account._id).status, USER_STATUS.PENDING);
    })
  );

  test(
    '驳回一条申请：账号作废，分数纹丝不动',
    withCleanStore(async () => {
      const me = await getManager();
      const doublesBefore = await mock.getLeaderboard(RANK_PROJECT.DOUBLES);
      const [application] = await mock.getMemberApplications();

      const rejected = await mock.rejectMember(application._id, me._id, '学号与姓名对不上');
      assert.equal(rejected.ok, true, rejected.message);
      // 驳回借「已禁用」的壳，靠 action 与理由把话说清楚
      assert.equal(rejected.account.status, USER_STATUS.DISABLED);
      assert.equal(rejected.account.action, 'reject');
      assert.equal(rejected.account.reason, '学号与姓名对不上');

      assert.deepEqual(await mock.getLeaderboard(RANK_PROJECT.DOUBLES), doublesBefore);
      assert.equal((await mock.getMembers()).length, 24);
    })
  );

  test(
    '驳回必须给理由',
    withCleanStore(async () => {
      const me = await getManager();
      const [application] = await mock.getMemberApplications();

      const noReason = await mock.rejectMember(application._id, me._id, '   ');
      assert.equal(noReason.ok, false);
      assert.match(noReason.message, /理由/);
      // 没给理由就不许动状态
      assert.equal((await mock.getMemberApplications())[0].status, USER_STATUS.PENDING);
    })
  );

  test(
    '已经处理过的申请不能再处理一次',
    withCleanStore(async () => {
      const me = await getManager();
      const [application] = await mock.getMemberApplications();
      await mock.approveMember(application._id, me._id);

      const again = await mock.approveMember(application._id, me._id);
      assert.equal(again.ok, false);
      assert.match(again.message, /已经处理过/);
    })
  );

  test(
    '查不到的申请给出明确的失败，而不是抛异常',
    withCleanStore(async () => {
      const me = await getManager();

      const approved = await mock.approveMember('nope', me._id);
      const rejected = await mock.rejectMember('nope', me._id, '理由');
      for (const result of [approved, rejected]) {
        assert.equal(result.ok, false);
        assert.match(result.message, /找不到/);
      }
    })
  );

  test(
    '未登录的调用者没有审核权，申请原样不动',
    withCleanStore(async () => {
      const [application] = await mock.getMemberApplications();

      const result = await mock.approveMember(application._id, null);
      assert.equal(result.ok, false);
      assert.match(result.message, /没有审核权限/);
      assert.equal((await mock.getMemberApplications())[0].status, USER_STATUS.PENDING);
    })
  );
});

describe('mock 数据源 —— 任免干事（学院负责人）', () => {
  function withCleanStore(fn) {
    return async () => {
      mock.resetCache();
      try {
        await fn();
      } finally {
        mock.resetCache();
      }
    };
  }

  test(
    '管理员设置后，被设者按本学院获权；撤销后收回',
    withCleanStore(async () => {
      const admin = await getManager();
      // u06 赵明宇,普通会员,法学院——种子里学院是确定的一所
      const before = (await mock.getMember('u06')).role;
      assert.equal(before, ROLE.MEMBER);

      const promoted = await mock.setCollegeLeader('u06', admin._id, true);
      assert.equal(promoted.ok, true, promoted.message);
      assert.equal(promoted.account.role, ROLE.STAFF);
      // 榜单要重取才算数：角色进了数据集，缓存必须被冲掉
      assert.equal((await mock.getMember('u06')).role, ROLE.STAFF);

      const revoked = await mock.setCollegeLeader('u06', admin._id, false);
      assert.equal(revoked.ok, true, revoked.message);
      assert.equal(revoked.account.role, ROLE.MEMBER);
    })
  );

  test(
    '干事自己不能任免别人，只有管理员能',
    withCleanStore(async () => {
      const staff = await mock.getMember('u02');
      const result = await mock.setCollegeLeader('u06', staff._id, true);

      assert.equal(result.ok, false);
      assert.match(result.message, /管理员/);
      // 被拒的调用不许在台账里留下任何痕迹
      assert.equal((await mock.getMember('u06')).role, ROLE.MEMBER);
    })
  );

  test(
    '管理员也不能给自己任免角色',
    withCleanStore(async () => {
      const admin = await getManager();

      const myself = await mock.setCollegeLeader(admin._id, admin._id, false);
      assert.equal(myself.ok, false);
      assert.match(myself.message, /自己/);
    })
  );
});

describe('mock 数据源 —— 公告发布与下架', () => {
  /** 写操作会往公告台账里塞东西，所以每条用例前后都复位（同上） */
  function withCleanStore(fn) {
    return async () => {
      mock.resetCache();
      try {
        await fn();
      } finally {
        mock.resetCache();
      }
    };
  }

  /** 一份合法的公告表单 */
  const draft = {
    title: '场地调整通知',
    content: '下周一起训练改到体育馆 2 号场。',
    category: '通知',
    pinned: false,
  };

  test(
    '发布后同时出现在公开列表与台账里，并带上发布者',
    withCleanStore(async () => {
      const me = await getManager();
      const before = (await mock.getAnnouncements()).length;

      const result = await mock.publishAnnouncement(draft, me._id);
      assert.equal(result.ok, true, result.firstError);
      assert.equal(result.record._id, 'la0001');
      assert.equal(result.record.publisherId, me._id);
      assert.ok(result.record.publishTime instanceof Date);

      const list = await mock.getAnnouncements();
      assert.equal(list.length, before + 1);
      assert.ok(list.some((a) => a._id === result.record._id));
      // 台账是「全量」，此刻两者应当一样多（还没有下架过）
      assert.equal((await mock.getAnnouncementRecords()).length, list.length);
    })
  );

  test(
    '新公告按发布时间插到正确的位置，公开列表仍是倒序',
    withCleanStore(async () => {
      const me = await getManager();
      await mock.publishAnnouncement(draft, me._id);

      const list = await mock.getAnnouncements();
      for (let i = 1; i < list.length; i += 1) {
        assert.ok(new Date(list[i - 1].publishTime) >= new Date(list[i].publishTime));
      }
    })
  );

  test(
    '校验不过则原样报错，不落台账',
    withCleanStore(async () => {
      const me = await getManager();
      const before = (await mock.getAnnouncements()).length;

      const result = await mock.publishAnnouncement({ ...draft, title: '' }, me._id);
      assert.equal(result.ok, false);
      assert.ok(result.errors.title);
      assert.ok(result.firstError);
      assert.equal(result.record, null);
      // 被拒绝的调用不许留下任何痕迹
      assert.equal((await mock.getAnnouncements()).length, before);
    })
  );

  test(
    '没有发布权的调用者发不出去',
    withCleanStore(async () => {
      const before = (await mock.getAnnouncements()).length;

      for (const actor of [null, 'ghost']) {
        const result = await mock.publishAnnouncement(draft, actor);
        assert.equal(result.ok, false);
        assert.match(result.firstError, /没有发布公告的权限/);
      }
      assert.equal((await mock.getAnnouncements()).length, before);
    })
  );

  test(
    '下架种子公告：公开列表少一条，台账里仍留着',
    withCleanStore(async () => {
      const me = await getManager();
      const [first] = await mock.getAnnouncements();
      const before = (await mock.getAnnouncements()).length;

      const archived = await mock.archiveAnnouncement(first._id, me._id);
      assert.equal(archived.ok, true, archived.message);
      assert.equal(archived.record.status, ANNOUNCEMENT_STATUS.ARCHIVED);

      const list = await mock.getAnnouncements();
      assert.equal(list.length, before - 1);
      assert.ok(!list.some((a) => a._id === first._id));

      // 台账不能少：公告是发出去给人看过的，抹掉就无从追溯了
      const records = await mock.getAnnouncementRecords();
      assert.equal(records.length, before);
      assert.ok(
        records.some((a) => a._id === first._id && a.status === ANNOUNCEMENT_STATUS.ARCHIVED)
      );
    })
  );

  test(
    '下架本地新发的公告同样生效',
    withCleanStore(async () => {
      const me = await getManager();
      const { record } = await mock.publishAnnouncement(draft, me._id);

      const archived = await mock.archiveAnnouncement(record._id, me._id);
      assert.equal(archived.ok, true, archived.message);
      assert.ok(!(await mock.getAnnouncements()).some((a) => a._id === record._id));
    })
  );

  test(
    '已下架的不能再下架一次',
    withCleanStore(async () => {
      const me = await getManager();
      const [first] = await mock.getAnnouncements();
      await mock.archiveAnnouncement(first._id, me._id);

      const again = await mock.archiveAnnouncement(first._id, me._id);
      assert.equal(again.ok, false);
      assert.match(again.message, /已经下架/);
    })
  );

  test(
    '没有管理权时下架不动，也给出明确失败',
    withCleanStore(async () => {
      const [first] = await mock.getAnnouncements();
      const before = (await mock.getAnnouncements()).length;

      const result = await mock.archiveAnnouncement(first._id, null);
      assert.equal(result.ok, false);
      assert.match(result.message, /没有管理公告的权限/);
      assert.equal((await mock.getAnnouncements()).length, before);
    })
  );

  test(
    '查不到的公告给出明确的失败，而不是抛异常',
    withCleanStore(async () => {
      const me = await getManager();
      const result = await mock.archiveAnnouncement('nope', me._id);
      assert.equal(result.ok, false);
      assert.match(result.message, /找不到/);
    })
  );
});

describe('mock 数据源 —— 个人资料', () => {
  /** 资料补丁写的是内存台账，所以每条用例前后都复位（同上） */
  function withCleanStore(fn) {
    return async () => {
      mock.resetCache();
      try {
        await fn();
      } finally {
        mock.resetCache();
      }
    };
  }

  test(
    '改昵称后「当前登录会员」与「会员名单」看到的是同一个新名字',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      // 种子里的 u06 是「明宇 / 赵明宇」，昵称与真名本来就分得开
      assert.notEqual(me.nickName, me.realName);

      const result = await mock.updateProfile({ nickName: '小明' }, me._id);
      assert.equal(result.ok, true, result.firstError);
      assert.equal(result.account.nickName, '小明');

      const after = await mock.getCurrentUser();
      assert.equal(after.nickName, '小明');
      // 这两处若各盖各的补丁，改完昵称就会一个变一个不变
      const [fromMembers] = (await mock.getMembers()).filter((m) => m._id === me._id);
      assert.equal(fromMembers.nickName, '小明');
    })
  );

  test(
    '改头像只动头像，昵称与实名信息分毫不动',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const result = await mock.updateProfile({ avatarUrl: 'cloud://x/y.png' }, me._id);

      assert.equal(result.ok, true, result.firstError);
      assert.equal(result.account.avatarUrl, 'cloud://x/y.png');
      assert.equal(result.account.nickName, me.nickName);
      assert.equal(result.account.realName, me.realName);
      assert.equal(result.account.studentId, me.studentId);
    })
  );

  test(
    '实名与权限字段即使被塞进补丁也会被丢掉',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const result = await mock.updateProfile(
        { nickName: '合规名字', realName: '冒名', studentId: '000000', role: 2, points: 99999 },
        me._id
      );

      assert.equal(result.ok, true, result.firstError);
      assert.equal(result.account.nickName, '合规名字');
      // 白名单之外的一个都不能落地
      assert.equal(result.account.realName, me.realName);
      assert.equal(result.account.studentId, me.studentId);
      assert.equal(result.account.role, me.role);
      assert.equal(result.account.points, me.points);
    })
  );

  test(
    '只提交敏感字段等于什么都没改，明确报错且不落库',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const result = await mock.updateProfile({ role: 2, realName: '冒名' }, me._id);

      assert.equal(result.ok, false);
      assert.equal(result.firstError, '没有要修改的内容');
      assert.equal((await mock.getCurrentUser()).realName, me.realName);
    })
  );

  test(
    '昵称不合规时原样报错，旧名字保持不变',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      const result = await mock.updateProfile({ nickName: '   ' }, me._id);

      assert.equal(result.ok, false);
      assert.ok(result.errors.nickName);
      assert.equal((await mock.getCurrentUser()).nickName, me.nickName);
    })
  );

  test(
    '改完昵称，榜单上那一行也跟着换名字',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      await mock.updateProfile({ nickName: '榜上新名' }, me._id);

      const board = await mock.getLeaderboard(RANK_PROJECT.MEN_SINGLES);
      const row = board.find((item) => item._id === me._id);
      assert.equal(row.nickName, '榜上新名');
    })
  );

  test(
    '未登录或查不到的账号改不动资料',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      for (const actor of [null, 'ghost']) {
        const result = await mock.updateProfile({ nickName: '谁' }, actor);
        assert.equal(result.ok, false);
        assert.match(result.firstError, /请先登录/);
      }
      assert.equal((await mock.getCurrentUser()).nickName, me.nickName);
    })
  );

  test(
    'resetCache 会把资料补丁一并清掉，名字退回种子',
    withCleanStore(async () => {
      const me = await mock.getCurrentUser();
      await mock.updateProfile({ nickName: '临时名字' }, me._id);
      assert.equal((await mock.getCurrentUser()).nickName, '临时名字');

      mock.resetCache();
      assert.equal((await mock.getCurrentUser()).nickName, me.nickName);
    })
  );
});

describe('mock 数据源 —— 赛事闭环', () => {
  /** 写操作会往赛事台账里塞东西，所以每条用例前后都复位（同上） */
  function withCleanStore(fn) {
    return async () => {
      mock.resetCache();
      try {
        await fn();
      } finally {
        mock.resetCache();
      }
    };
  }

  /** 一份合法的赛事表单（等级二级、打三四名） */
  function eventDraft(overrides = {}) {
    return {
      title: '秋季单打赛',
      description: '面向全体会员的单打赛事',
      matchType: MATCH_TYPE.SINGLES,
      level: EVENT_LEVEL.SECOND,
      bronzeMode: EVENT_BRONZE_MODE.PLAYOFF,
      seedMode: SEED_MODE.ELO,
      seedCount: 8,
      startTime: '2026-05-20T09:00:00',
      location: '学校体育馆',
      quota: 8,
      ...overrides,
    };
  }

  test(
    '发布赛事 —— 落库即报名中，编号从 le0001 起',
    withCleanStore(async () => {
      const me = await getManager();
      const before = (await mock.getEvents()).length;

      const result = await mock.publishEvent(eventDraft(), me._id);
      assert.equal(result.ok, true, result.firstError);
      assert.equal(result.record._id, 'le0001');
      assert.equal(result.record.status, EVENT_STATUS.SIGNUP);
      assert.equal(result.record.publisherId, me._id);
      assert.ok(result.record.startTime instanceof Date);

      const events = await mock.getEvents();
      assert.equal(events.length, before + 1);
      assert.ok(events.some((e) => e._id === 'le0001'));
    })
  );

  test(
    '发布赛事 —— 等级缺失被拒，不落台账',
    withCleanStore(async () => {
      const me = await getManager();
      const before = (await mock.getEvents()).length;

      const result = await mock.publishEvent(eventDraft({ level: undefined }), me._id);
      assert.equal(result.ok, false);
      assert.ok(result.errors.level);
      assert.equal(result.record, null);
      assert.equal((await mock.getEvents()).length, before);
    })
  );

  test(
    '报名 → 签到 → 录入名次：走通并发出积分',
    withCleanStore(async () => {
      const me = await getManager();
      const pointsBefore = me.points;

      const { record } = await mock.publishEvent(eventDraft({ seedCount: 2 }), me._id);
      const id = record._id;

      const signed = await mock.signUpEvent(id, me._id);
      assert.equal(signed.ok, true, signed.message);
      assert.equal(signed.record.status, SIGNUP_STATUS.SIGNED);
      assert.equal((await mock.getEventSignups(id)).length, 1);

      // 单打要先抽签才能开赛；再拉一位会员进来，好让签表排得出来
      const other = (await mock.getMembers()).find((m) => m._id !== me._id);
      await mock.signUpEvent(id, other._id);
      const drawn = await mock.drawEvent(id, me._id, { seedValue: 3 });
      assert.equal(drawn.ok, true, drawn.message);

      const started = await mock.startEvent(id, me._id);
      assert.equal(started.ok, true, started.message);
      assert.equal(started.record.status, EVENT_STATUS.ONGOING);

      const checked = await mock.checkInEvent(id, me._id, me._id);
      assert.equal(checked.ok, true, checked.message);
      assert.equal(checked.record.status, SIGNUP_STATUS.CHECKED_IN);

      const finished = await mock.finishEvent(id, [{ userId: me._id, placement: 1 }], me._id);
      assert.equal(finished.ok, true, finished.firstError);
      assert.equal(finished.record.status, EVENT_STATUS.FINISHED);
      assert.deepEqual(finished.record.results, [{ userId: me._id, placement: 1 }]);

      // 名次落定 → 回放重算 → 冠军拿到积分（二级赛事封顶倍数）
      const after = await mock.getMember(me._id);
      assert.ok(after.points > pointsBefore, '冠军应当拿到赛事积分');
    })
  );

  test(
    '录入名次 —— 没报名的人拿不到名次',
    withCleanStore(async () => {
      const me = await getManager();
      const players = (await mock.getMembers())
        .filter((m) => m._id !== me._id)
        .slice(0, 2)
        .map((m) => m._id);

      // 单打双打都要先抽签才能开赛，这里按真人路线走一遍；管理员本人不报名
      const { record } = await mock.publishEvent(eventDraft({ seedCount: 2 }), me._id);
      for (const userId of players) await mock.signUpEvent(record._id, userId);
      const drawn = await mock.drawEvent(record._id, me._id, { seedValue: 9 });
      assert.equal(drawn.ok, true, drawn.message);
      await mock.startEvent(record._id, me._id);

      const result = await mock.finishEvent(record._id, [{ userId: me._id, placement: 1 }], me._id);
      assert.equal(result.ok, false);
      assert.match(result.firstError, /没有报名/);
      assert.equal((await mock.getEvents()).find((e) => e._id === record._id).status, EVENT_STATUS.ONGOING);
    })
  );

  test(
    '录入名次 —— 3 人打三四名赛也能结赛（签表排不出季军赛，名次到第 3 名为止）',
    withCleanStore(async () => {
      const me = await getManager();
      const members = await mock.getMembers();
      const others = members.filter((m) => m._id !== me._id).slice(0, 2);
      const players = [me._id, ...others.map((m) => m._id)];

      const { record } = await mock.publishEvent(eventDraft(), me._id);
      const id = record._id;
      for (const userId of players) await mock.signUpEvent(id, userId);

      const drawn = await mock.drawEvent(id, me._id, { seedValue: 5 });
      assert.equal(drawn.ok, true, drawn.message);
      assert.equal(drawn.matches.length, 1, '3 人 4 签，首轮有一场轮空，只打得出一场');

      await mock.startEvent(id, me._id);

      const finished = await mock.finishEvent(
        id,
        [
          { userId: players[0], placement: 1 },
          { userId: players[1], placement: 2 },
          { userId: players[2], placement: 3 },
        ],
        me._id
      );
      assert.equal(finished.ok, true, finished.firstError);
      assert.equal(finished.record.status, EVENT_STATUS.FINISHED);
    })
  );

  test(
    '循环赛 —— 逐轮打完自动放下一轮，4 人共 6 场，名次允许出现第 4 名',
    withCleanStore(async () => {
      const members = await mock.getMembers();
      const players = members.slice(0, 4).map((m) => m._id);
      const host = players[0];

      const { record } = await mock.publishEvent(
        eventDraft({ format: EVENT_FORMAT.ROUND_ROBIN, seedCount: 2 }),
        host
      );
      const id = record._id;
      for (const userId of players) await mock.signUpEvent(id, userId);

      // 抽签只在报名阶段开放，先抽再开赛
      const drawn = await mock.drawEvent(id, host, { seedValue: 7 });
      assert.equal(drawn.ok, true, drawn.message);
      await mock.startEvent(id, host);
      assert.equal(drawn.draw.format, EVENT_FORMAT.ROUND_ROBIN, '赛制要落到 draw 上');
      assert.equal(drawn.matches.length, 2, '4 人循环赛首轮排两场');
      assert.ok(
        drawn.matches.every((m) => m.stage === BRACKET_STAGE.GROUP),
        '循环赛的比赛都在 groups 阶段'
      );
      assert.equal(drawn.matches[0].group, 0, '循环赛只有一组，组号自 0 起');

      // 每一场都录分并让对手确认；确认一场就会让引擎试着排出后续轮次。
      // 没排完就继续，排完（没有待确认的比赛）即止，加一道闸防死循环。
      for (let guard = 0; guard < 12; guard += 1) {
        const pending = (await mock.getMatchRecords({ eventId: id })).filter(
          (m) => m.status === MATCH_STATUS.PENDING && m.teamA[0] && m.teamB[0]
        );
        if (pending.length === 0) break;
        for (const match of pending) {
          const scored = await mock.submitMatch({
            id: match._id,
            scoreA: ['11', '11'],
            scoreB: ['3', '5'],
            actor: match.teamA[0],
          });
          assert.equal(scored.ok, true, scored.firstError);
          const confirmed = await mock.confirmMatch(match._id, match.teamB[0]);
          assert.equal(confirmed.ok, true, confirmed.message);
        }
      }

      const all = await mock.getMatchRecords({ eventId: id });
      assert.equal(all.length, 6, '4 人循环赛共 3 轮 6 场，应全部排完');
      assert.ok(all.every((m) => m.status === MATCH_STATUS.ACTIVE), '全部已生效');

      // 循环赛走「阶梯」名次口径：1..4 都要允许，不能再套三四名成对规则
      const finished = await mock.finishEvent(
        id,
        players.map((userId, index) => ({ userId, placement: index + 1 })),
        host
      );
      assert.equal(finished.ok, true, finished.firstError);
      assert.equal(finished.record.status, EVENT_STATUS.FINISHED);
      assert.equal(finished.record.results.length, 4);
    })
  );

  test(
    '双败淘汰 —— 胜者组→败者组→总决赛逐轮推进，4 人共 6 场',
    withCleanStore(async () => {
      const members = await mock.getMembers();
      const players = members.slice(0, 4).map((m) => m._id);
      const host = players[0];

      const { record } = await mock.publishEvent(
        eventDraft({ format: EVENT_FORMAT.DOUBLE_ELIM, seedCount: 2 }),
        host
      );
      const id = record._id;
      assert.equal(record.gfReset, true, '双败默认开启总决赛重赛');
      for (const userId of players) await mock.signUpEvent(id, userId);

      const drawn = await mock.drawEvent(id, host, { seedValue: 7 });
      assert.equal(drawn.ok, true, drawn.message);
      await mock.startEvent(id, host);
      assert.equal(drawn.matches.length, 2, '4 人双败首轮排两场');
      assert.ok(
        drawn.matches.every((m) => m.stage === BRACKET_STAGE.WINNERS),
        '双败的落败者要先在胜者组里打出来'
      );

      for (let guard = 0; guard < 16; guard += 1) {
        const pending = (await mock.getMatchRecords({ eventId: id })).filter(
          (m) => m.status === MATCH_STATUS.PENDING && m.teamA[0] && m.teamB[0]
        );
        if (pending.length === 0) break;
        for (const match of pending) {
          const scored = await mock.submitMatch({
            id: match._id,
            scoreA: ['11', '11'],
            scoreB: ['3', '5'],
            actor: match.teamA[0],
          });
          assert.equal(scored.ok, true, scored.firstError);
          const confirmed = await mock.confirmMatch(match._id, match.teamB[0]);
          assert.equal(confirmed.ok, true, confirmed.message);
        }
      }

      const all = await mock.getMatchRecords({ eventId: id });
      assert.equal(all.length, 6, '4 人双败共 2n−2 = 6 场');
      assert.ok(all.every((m) => m.status === MATCH_STATUS.ACTIVE), '全部已生效');
      const stages = new Set(all.map((m) => m.stage));
      assert.ok(stages.has(BRACKET_STAGE.WINNERS), '有胜者组比赛');
      assert.ok(stages.has(BRACKET_STAGE.LOSERS), '有败者组比赛');
      assert.ok(stages.has(BRACKET_STAGE.GRAND_FINAL), '有总决赛');

      const finished = await mock.finishEvent(
        id,
        players.map((userId, index) => ({ userId, placement: index + 1 })),
        host
      );
      assert.equal(finished.ok, true, finished.firstError);
      assert.equal(finished.record.results.length, 4);
    })
  );

  test(
    '取消报名 —— 只置状态不删记录，重新报名落回同一条',
    withCleanStore(async () => {
      const me = await getManager();
      const { record } = await mock.publishEvent(eventDraft(), me._id);
      const id = record._id;

      await mock.signUpEvent(id, me._id);
      const canceled = await mock.cancelSignupEvent(id, me._id);
      assert.equal(canceled.ok, true, canceled.message);
      assert.equal(canceled.record.status, SIGNUP_STATUS.CANCELED);

      const afterCancel = await mock.getEventSignups(id);
      assert.equal(afterCancel.length, 1, '取消不删记录');
      assert.equal(afterCancel[0].status, SIGNUP_STATUS.CANCELED);

      const again = await mock.signUpEvent(id, me._id);
      assert.equal(again.ok, true, again.message);
      const afterSignUp = await mock.getEventSignups(id);
      assert.equal(afterSignUp.length, 1, '重新报名不新增记录');
      assert.equal(afterSignUp[0].status, SIGNUP_STATUS.SIGNED);
    })
  );

  test(
    '报名 —— 赛事开始后就截止了',
    withCleanStore(async () => {
      const me = await getManager();
      const players = (await mock.getMembers())
        .filter((m) => m._id !== me._id)
        .slice(0, 2)
        .map((m) => m._id);

      // 单打双打都要先抽签才能开赛；管理员本人留着不报名，用来试开赛后补报
      const { record } = await mock.publishEvent(eventDraft({ seedCount: 2 }), me._id);
      for (const userId of players) await mock.signUpEvent(record._id, userId);
      const drawn = await mock.drawEvent(record._id, me._id, { seedValue: 9 });
      assert.equal(drawn.ok, true, drawn.message);
      await mock.startEvent(record._id, me._id);

      const result = await mock.signUpEvent(record._id, me._id);
      assert.equal(result.ok, false);
      assert.match(result.message, /截止/);
    })
  );

  test(
    '未报名的人不能报名同一场两次',
    withCleanStore(async () => {
      const me = await getManager();
      const { record } = await mock.publishEvent(eventDraft(), me._id);

      await mock.signUpEvent(record._id, me._id);
      const again = await mock.signUpEvent(record._id, me._id);
      assert.equal(again.ok, false);
      assert.match(again.message, /已经报过名/);
    })
  );

  test(
    '抽签 —— 生成首轮比赛，重抽覆盖不追加，抽后报名冻结',
    withCleanStore(async () => {
      const members = await mock.getMembers();
      const players = members.slice(0, 4).map((m) => m._id);
      const host = players[0];

      const { record } = await mock.publishEvent(eventDraft({ seedCount: 2 }), host);
      const id = record._id;
      for (const userId of players) await mock.signUpEvent(id, userId);

      const drawn = await mock.drawEvent(id, host, { seedValue: 12345 });
      assert.equal(drawn.ok, true, drawn.message);
      assert.equal(drawn.draw.size, 4);
      assert.equal(drawn.draw.drawCount, 1);
      assert.equal(drawn.matches.length, 2, '4 人 4 签，正好两场');
      // 待确认的比赛只在台账里，成绩公示 getMatches 不收未生效的
      assert.equal((await mock.getMatches({ eventId: id })).length, 0);
      assert.equal((await mock.getMatchRecords({ eventId: id })).length, 2);

      // 重抽：编号不变，比赛不翻倍
      const again = await mock.drawEvent(id, host, { seedValue: 999 });
      assert.equal(again.ok, true, again.message);
      assert.equal(again.draw.drawCount, 2);
      assert.equal((await mock.getMatchRecords({ eventId: id })).length, 2, '重抽不该让比赛翻倍');

      // 抽签后名单冻结：第 5 位会员报名被拒
      const late = await mock.signUpEvent(id, members[4]._id);
      assert.equal(late.ok, false);
      assert.match(late.message, /锁定/);

      // 已报名的人也不能退赛
      const quit = await mock.cancelSignupEvent(id, players[1]);
      assert.equal(quit.ok, false);
    })
  );

  test(
    '逐轮推进 —— 首轮打完自动排出决赛与季军赛',
    withCleanStore(async () => {
      const members = await mock.getMembers();
      const players = members.slice(0, 4).map((m) => m._id);
      const host = players[0];

      const { record } = await mock.publishEvent(eventDraft({ seedCount: 2 }), host);
      const id = record._id;
      for (const userId of players) await mock.signUpEvent(id, userId);

      const drawn = await mock.drawEvent(id, host, { seedValue: 5 });
      assert.equal(drawn.matches.length, 2, '4 人 4 签，首轮两场');

      // 两场都录分并确认（A 队胜）
      for (const match of drawn.matches) {
        const scored = await mock.submitMatch({
          id: match._id,
          scoreA: ['11', '11'],
          scoreB: ['3', '5'],
          actor: match.teamA[0],
        });
        assert.equal(scored.ok, true, scored.firstError);
        assert.equal(scored.match.status, MATCH_STATUS.PENDING, '录完仍是待确认');

        const confirmed = await mock.confirmMatch(match._id, match.teamB[0]);
        assert.equal(confirmed.ok, true, confirmed.message);
      }

      const ledger = await mock.getMatchRecords({ eventId: id });
      assert.equal(ledger.length, 4, '首轮两场 + 决赛 + 季军赛');

      const final = ledger.find((m) => m.round === 2 && m.stage === BRACKET_STAGE.MAIN);
      const bronze = ledger.find((m) => m.round === 2 && m.stage === BRACKET_STAGE.BRONZE);
      assert.ok(final, '应排出决赛');
      assert.ok(bronze, '打三四名模式下应排出季军赛');
      assert.deepEqual([final.teamA[0], final.teamB[0]], [drawn.matches[0].teamA[0], drawn.matches[1].teamA[0]]);
      assert.deepEqual([bronze.teamA[0], bronze.teamB[0]], [drawn.matches[0].teamB[0], drawn.matches[1].teamB[0]]);
    })
  );

  test(
    '录分前不许确认 —— 抽签排出的比赛必须先有人录分',
    withCleanStore(async () => {
      const members = await mock.getMembers();
      const players = members.slice(0, 2).map((m) => m._id);

      const { record } = await mock.publishEvent(eventDraft({ seedCount: 2 }), players[0]);
      const id = record._id;
      for (const userId of players) await mock.signUpEvent(id, userId);

      const drawn = await mock.drawEvent(id, players[0], { seedValue: 5 });
      const scheduled = drawn.matches[0];

      const early = await mock.confirmMatch(scheduled._id, scheduled.teamB[0]);
      assert.equal(early.ok, false);
      assert.match(early.message, /还没有比分/);

      await mock.submitMatch({
        id: scheduled._id,
        scoreA: ['11', '11'],
        scoreB: ['3', '5'],
        actor: scheduled.teamA[0],
      });
      const confirmed = await mock.confirmMatch(scheduled._id, scheduled.teamB[0]);
      assert.equal(confirmed.ok, true, confirmed.message);
    })
  );

  test(
    '种子里的待确认比赛也能录分确认 —— 台账里不留同编号的两份',
    withCleanStore(async () => {
      // 演示赛事 e07 的半决赛在种子里就已经「排好没打」，与现场抽签排出的
      // 比赛不同：它不在 matchStore 里，录分走的是「按编号覆盖」。若覆盖后
      // 种子那份还留在台账里，findRecord 会命中排在前面的空比分版，点确认
      // 永远报「还没有比分」，签表也会同场渲染两行。
      const scheduled = (
        await mock.getMatchRecords({ eventId: 'e07', status: MATCH_STATUS.PENDING })
      ).find((m) => m.teamA.concat(m.teamB).includes('u06'));
      assert.ok(scheduled, '种子里应有 u06 还没打的半决赛');

      const scored = await mock.submitMatch({
        id: scheduled._id,
        scoreA: ['11', '11'],
        scoreB: ['3', '5'],
        actor: 'u06',
      });
      assert.equal(scored.ok, true, scored.firstError);

      const ledger = await mock.getMatchRecords({ eventId: 'e07' });
      assert.equal(
        ledger.filter((m) => m._id === scheduled._id).length,
        1,
        '同一场比赛不该在台账里出现两次'
      );

      const confirmed = await mock.confirmMatch(scheduled._id, 'u06');
      assert.equal(confirmed.ok, true, confirmed.message);
    })
  );

  test(
    'resetCache 清掉赛事与报名，编号也复位',
    withCleanStore(async () => {
      const me = await getManager();
      const { record } = await mock.publishEvent(eventDraft(), me._id);
      await mock.signUpEvent(record._id, me._id);

      mock.resetCache();
      assert.ok(!(await mock.getEvents()).some((e) => e._id === 'le0001'));

      // 本次会话的报名随赛事一起清掉；种子那场「报名中」赛事的预置报名仍在
      const left = await mock.getEventSignups();
      assert.ok(!left.some((s) => s.eventId === 'le0001'), '会话内报名应被清掉');
      assert.ok(left.some((s) => s.eventId === 'e07'), '种子里预置的报名不该被清掉');

      // 复位后第一场又是 le0001
      const again = await mock.publishEvent(eventDraft(), me._id);
      assert.equal(again.record._id, 'le0001');
    })
  );
});
