/**
 * 防刷分上限单元测试
 *
 * 规则：同一对会员在一个赛季内，最多 RATED_PAIR_LIMIT 场「自行录入的比赛」
 * 计入等级分。赛事比赛不设上限；双打按跨队无序对计。
 *
 * 这里只测纯判定函数，不碰界面、不碰数据库。边界要钉死，因为这条规则
 * 直接决定谁的分算数、谁的分不算数——差一场就是两个人分数不同。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCasualMatch,
  pairKey,
  crossPairs,
  findCappedMatchIds,
} = require('../miniprogram/services/rating-cap.js');

const { MATCH_STATUS, RATED_PAIR_LIMIT } = require('../miniprogram/utils/constants.js');

/** 一场日常单打 */
function casualSingles(id, a, b, matchTime, status = MATCH_STATUS.ACTIVE) {
  return {
    _id: id,
    teamA: [a],
    teamB: [b],
    matchTime,
    status,
    matchType: 1,
  };
}

/** 一场日常双打 */
function casualDoubles(id, teamA, teamB, matchTime, status = MATCH_STATUS.ACTIVE) {
  return { _id: id, teamA, teamB, matchTime, status, matchType: 2 };
}

/** 一天一天往后排，保证回放顺序确定 */
function day(n) {
  return new Date(Date.UTC(2026, 0, n, 12, 0, 0));
}

describe('isCasualMatch —— 什么算「自行录入的比赛」', () => {
  test('没有赛事身份的就是日常约球', () => {
    assert.equal(isCasualMatch(casualSingles('m1', 'u1', 'u2', day(1))), true);
  });

  test('带 eventId 的是赛事比赛，不算日常', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), eventId: 'e1' };
    assert.equal(isCasualMatch(match), false);
  });

  test('带 collegeEventId 的是学院赛，不算日常', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), collegeEventId: 'ce1' };
    assert.equal(isCasualMatch(match), false);
  });

  test('带 tieId 的是学院赛小场，不算日常', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), tieId: 't1' };
    assert.equal(isCasualMatch(match), false);
  });

  test('三者任一为空串也仍算日常（空串等于没设）', () => {
    const match = { ...casualSingles('m1', 'u1', 'u2', day(1)), eventId: '', tieId: null };
    assert.equal(isCasualMatch(match), true);
  });

  test('null 不报错，按非日常处理', () => {
    assert.equal(isCasualMatch(null), false);
  });
});

describe('pairKey —— 无序对', () => {
  test('甲乙与乙甲是同一个键', () => {
    assert.equal(pairKey('u1', 'u2'), pairKey('u2', 'u1'));
  });

  test('不同的人对不同', () => {
    assert.notEqual(pairKey('u1', 'u2'), pairKey('u1', 'u3'));
  });
});

describe('crossPairs —— 跨队无序对', () => {
  test('单打只有一组', () => {
    const keys = crossPairs(casualSingles('m1', 'u1', 'u2', day(1)));
    assert.equal(keys.length, 1);
    assert.equal(keys[0], pairKey('u1', 'u2'));
  });

  test('双打四组，同队两人之间不算', () => {
    const keys = crossPairs(casualDoubles('m1', ['a', 'b'], ['c', 'd'], day(1)));
    assert.equal(keys.length, 4);
    assert.deepEqual(
      keys.slice().sort(),
      [
        pairKey('a', 'c'),
        pairKey('a', 'd'),
        pairKey('b', 'c'),
        pairKey('b', 'd'),
      ].sort()
    );
  });

  test('队伍数据缺失时返回空数组，不抛错', () => {
    assert.deepEqual(crossPairs(null), []);
    assert.deepEqual(crossPairs({ _id: 'm1' }), []);
    assert.deepEqual(crossPairs({ _id: 'm1', teamA: ['a'], teamB: [] }), []);
  });

  test('队伍里的 null / undefined 成员被跳过', () => {
    const keys = crossPairs({ _id: 'm1', teamA: ['a', null], teamB: ['c'] });
    assert.deepEqual(keys, [pairKey('a', 'c')]);
  });
});

describe('findCappedMatchIds —— 上限本身', () => {
  test('恰好打满 15 场，全部计入', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('第 16 场不计入，前 15 场不受影响', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(capped.has(`m${RATED_PAIR_LIMIT + 1}`));
  });

  test('超限只压那一对：别人的比赛照常计入', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    // u3 与 u4 只有一场，不该被牵连
    matches.push(casualSingles('other', 'u3', 'u4', day(20)));

    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(!capped.has('other'));
  });

  test('同日多场时按确定顺序判定，结果可复现', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      // 全部同一时刻：排序要能给出稳定次序
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(1)));
    }
    const first = findCappedMatchIds(matches);
    const second = findCappedMatchIds([...matches].reverse());
    assert.deepEqual([...first].sort(), [...second].sort());
    assert.equal(first.size, 1);
  });

  test('空数组与 null 返回空集合，不报错', () => {
    assert.equal(findCappedMatchIds([]).size, 0);
    assert.equal(findCappedMatchIds(null).size, 0);
    assert.equal(findCappedMatchIds(undefined).size, 0);
  });

  test('limit 传 0 或负数时视为不设上限（防误配把全部比赛压掉）', () => {
    const matches = [casualSingles('m1', 'u1', 'u2', day(1))];
    assert.equal(findCappedMatchIds(matches, { limit: 0 }).size, 0);
    assert.equal(findCappedMatchIds(matches, { limit: -1 }).size, 0);
  });

  test('limit 可调，便于不同项目走不同口径', () => {
    const matches = [
      casualSingles('m1', 'u1', 'u2', day(1)),
      casualSingles('m2', 'u1', 'u2', day(2)),
    ];
    assert.equal(findCappedMatchIds(matches, { limit: 1 }).size, 1);
  });
});

describe('findCappedMatchIds —— 赛事不算数', () => {
  test('赛事比赛再多也不占名额、也不被压', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 5; i += 1) {
      matches.push({
        ...casualSingles(`e${i}`, 'u1', 'u2', day(i)),
        eventId: 'evt-1',
      });
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('赛事比赛不占用日常名额：15 场赛事之后日常仍能打满 15 场', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push({ ...casualSingles(`e${i}`, 'u1', 'u2', day(i)), eventId: 'evt-1' });
    }
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`c${i}`, 'u1', 'u2', day(100 + i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('学院赛小场也不占名额', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push({
        ...casualSingles(`t${i}`, 'u1', 'u2', day(i)),
        collegeEventId: 'ce1',
        tieId: 'tie1',
      });
    }
    assert.equal(findCappedMatchIds(matches).size, 0);
  });
});

describe('findCappedMatchIds —— 双打按跨队无序对', () => {
  test('同一对搭档反复对上同一对对手，第 16 场整场不计', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'b'], ['c', 'd'], day(i)));
    }
    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(capped.has(`m${RATED_PAIR_LIMIT + 1}`));
  });

  test('换搭档不刷新名额：甲丙交手 15 场之后，甲乙对丙丁仍受同一名额约束', () => {
    // 甲与丙这一对已经打满 15 场
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'x'], ['c', 'y'], day(i)));
    }
    // 这一场里仍然含「甲 vs 丙」这一对，因此超限
    matches.push(casualDoubles('extra', ['a', 'b'], ['c', 'd'], day(50)));

    const capped = findCappedMatchIds(matches);
    assert.ok(capped.has('extra'));
  });

  test('四对里只要有一对满额，整场不计（队内 delta 共用，没法半算）', () => {
    // 把 a-c 这一对喂到满额
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'x'], ['c', 'y'], day(i)));
    }
    // 这场只让 a-c 复用，其余三对都是新的
    matches.push(casualDoubles('mixed', ['a', 'new1'], ['c', 'new2'], day(60)));

    assert.ok(findCappedMatchIds(matches).has('mixed'));
  });

  test('(甲,乙) 与 (乙,甲) 是同一对：四人不变只换边，仍是同一批对子', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'b'], ['c', 'd'], day(i)));
    }
    // 同样的四人、同样的组合，只是两队位置对调——四组跨队对一模一样
    matches.push(casualDoubles('swap', ['c', 'd'], ['a', 'b'], day(50)));
    assert.ok(findCappedMatchIds(matches).has('swap'));
  });

  test('同队两人之间不算一对：他们从未交手', () => {
    // 甲与乙永远同队，从不交手
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 5; i += 1) {
      matches.push(casualDoubles(`m${i}`, ['a', 'b'], [`c${i}`, `d${i}`], day(i)));
    }
    // a-b 同队，不该因为同队次数过多而互相压分；但与 c/d 各只交手一次
    assert.equal(findCappedMatchIds(matches).size, 0);
  });
});

describe('findCappedMatchIds —— 状态与赛季', () => {
  test('待确认的场次也占名额（否则先录 15 场再一起确认就绕过了）', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i), MATCH_STATUS.PENDING));
    }
    // 第 16 场无论什么状态，都该被压
    matches.push(casualSingles('m16', 'u1', 'u2', day(20), MATCH_STATUS.ACTIVE));
    const capped = findCappedMatchIds(matches);
    assert.ok(capped.has('m16'));
    assert.equal(capped.size, 1);
  });

  test('已撤销的场次不占名额，名额释放给后来的场次', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i), MATCH_STATUS.REVOKED));
    }
    // 前面 15 场全撤销，这场是第 1 场有效
    matches.push(casualSingles('m16', 'u1', 'u2', day(20), MATCH_STATUS.ACTIVE));
    assert.equal(findCappedMatchIds(matches).size, 0);
  });

  test('被撤销的是超限的那一场后，名额回到后面的场次', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    matches.push(casualSingles('m17', 'u1', 'u2', day(30)));
    // m16 是超限的那场，把它撤掉，m17 应该补位进来
    matches[RATED_PAIR_LIMIT].status = MATCH_STATUS.REVOKED;

    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 1);
    assert.ok(capped.has('m17'));
  });

  test('赛季分界点之前的场次不占本赛季名额', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    // 本赛季从第 10 天开始：只有 m10..m16 属于本赛季，共 7 场，没超
    const capped = findCappedMatchIds(matches, { seasonStart: day(10) });
    assert.equal(capped.size, 0);
  });

  test('赛季分界点之后重新计数：上赛季打满，本赛季重新有 15 个名额', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`old${i}`, 'u1', 'u2', day(i)));
    }
    for (let i = 1; i <= RATED_PAIR_LIMIT; i += 1) {
      matches.push(casualSingles(`new${i}`, 'u1', 'u2', day(100 + i)));
    }
    const capped = findCappedMatchIds(matches, { seasonStart: day(100) });
    assert.equal(capped.size, 0);
  });

  test('不传赛季分界点：全部流水都算本赛季', () => {
    const matches = [];
    for (let i = 1; i <= RATED_PAIR_LIMIT + 1; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 1);
    assert.equal(findCappedMatchIds(matches, { seasonStart: null }).size, 1);
  });

  test('分界点之后正好 15 场，第 16 场才压', () => {
    const matches = [];
    for (let i = 1; i <= 40; i += 1) {
      matches.push(casualSingles(`m${i}`, 'u1', 'u2', day(i)));
    }
    // 从第 20 天起有新赛季，则 m20..m34 是本赛季第 1..15 场，m35 是第 16 场
    const capped = findCappedMatchIds(matches, { seasonStart: day(20) });
    assert.equal(capped.size, 6); // m35..m40
    assert.ok(capped.has('m35'));
    assert.ok(!capped.has('m34'));
  });

  test('matchTime 非法的场次跳过，不占名额', () => {
    const matches = [
      casualSingles('bad', 'u1', 'u2', '不是时间'),
      casualSingles('ok', 'u1', 'u2', day(1)),
    ];
    assert.equal(findCappedMatchIds(matches).size, 0);
  });
});

describe('findCappedMatchIds —— 多名会员交织', () => {
  test('每对各自计数，互不干扰', () => {
    const matches = [];
    // u1-u2 打 20 场
    for (let i = 1; i <= 20; i += 1) {
      matches.push(casualSingles(`a${i}`, 'u1', 'u2', day(i)));
    }
    // u3-u4 打 20 场
    for (let i = 1; i <= 20; i += 1) {
      matches.push(casualSingles(`b${i}`, 'u3', 'u4', day(i)));
    }
    const capped = findCappedMatchIds(matches);
    // 两对各超 5 场
    assert.equal(capped.size, 10);
    assert.ok(capped.has('a16'));
    assert.ok(capped.has('b16'));
  });

  test('一个人同时对多个对手：每个对子单独计数', () => {
    const matches = [];
    // u1 与 u2、u3 各打 15 场，都还没超
    for (let i = 1; i <= 15; i += 1) {
      matches.push(casualSingles(`p${i}`, 'u1', 'u2', day(i)));
      matches.push(casualSingles(`q${i}`, 'u1', 'u3', day(i)));
    }
    assert.equal(findCappedMatchIds(matches).size, 0);

    // 各自再打一场，两对都超
    matches.push(casualSingles('p16', 'u1', 'u2', day(20)));
    matches.push(casualSingles('q16', 'u1', 'u3', day(21)));
    const capped = findCappedMatchIds(matches);
    assert.equal(capped.size, 2);
    assert.ok(capped.has('p16'));
    assert.ok(capped.has('q16'));
  });
});

/* ============================================================
 * 端到端：这条上限确实作用在数据源上
 * ============================================================ */

const mock = require('../miniprogram/services/mock.js');

describe('数据源 —— 上限贯穿到流水与台账', () => {
  test('超限的场次留在台账里，但不进流水（等于不进等级分）', async () => {
    mock.resetCache();
    try {
      const records = await mock.getMatchRecords();
      const flow = await mock.getMatches();
      const capped = findCappedMatchIds(records, { seasonStart: null });

      assert.ok(
        capped.size > 0,
        '演示流水里应当有成对的会员交手超过上限，否则这条测试验不出东西'
      );

      const flowIds = new Set(flow.map((match) => String(match._id)));
      const ledgerIds = new Set(records.map((record) => String(record._id)));

      for (const id of capped) {
        assert.ok(!flowIds.has(id), `${id} 超限了，不该出现在流水里`);
        assert.ok(ledgerIds.has(id), `${id} 仍应留在台账里，比赛记录页查得到`);
      }
    } finally {
      mock.resetCache();
    }
  });
});
