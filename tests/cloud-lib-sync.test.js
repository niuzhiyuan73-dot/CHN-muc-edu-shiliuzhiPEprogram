/**
 * 云函数共享库镜像守卫
 * ============================================================
 * cloudfunctions/data/lib/ 是 miniprogram/ 里纯模块的副本（原因见
 * tools/sync-cloud-lib.js 的文件头）。副本一旦落后于源文件，云端就会用
 * 旧算法算分，而本地测试全绿——这种错误最难发现。
 *
 * 所以这里做两件事：
 *   1. 逐字节比对，防止漂移；
 *   2. 逐个 require，证明镜像自洽（不依赖清单以外的文件）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MANIFEST, SRC_ROOT, DEST_ROOT } = require('../tools/sync-cloud-lib.js');

test('镜像文件与源文件逐字节一致', () => {
  const drifted = [];
  const missing = [];

  for (const rel of MANIFEST) {
    const srcPath = path.join(SRC_ROOT, rel);
    const destPath = path.join(DEST_ROOT, rel);

    if (!fs.existsSync(destPath)) {
      missing.push(rel);
      continue;
    }
    if (!fs.readFileSync(destPath).equals(fs.readFileSync(srcPath))) {
      drifted.push(rel);
    }
  }

  assert.deepEqual(missing, [], '以下文件没有同步到云函数镜像，请运行 node tools/sync-cloud-lib.js');
  assert.deepEqual(drifted, [], '以下文件已漂移（源文件改了但镜像没更新），请运行 node tools/sync-cloud-lib.js');
});

test('清单里每个源文件都存在', () => {
  for (const rel of MANIFEST) {
    assert.ok(fs.existsSync(path.join(SRC_ROOT, rel)), `清单里的源文件不存在：${rel}`);
  }
});

test('镜像模块都能独立加载，不依赖清单以外的文件', () => {
  for (const rel of MANIFEST) {
    const destPath = path.join(DEST_ROOT, rel);
    assert.doesNotThrow(
      () => require(destPath),
      `镜像模块 ${rel} 加载失败——说明它依赖了清单以外的文件`
    );
  }
});

test('镜像里的回放引擎与源文件算出的结果完全一致', () => {
  // 镜像在磁盘上是一份独立文件，必然是独立的模块实例——这是设计使然。
  // 真正要守住的是「同一份输入得到同一份输出」，所以这里跑一遍比对结果。
  const source = require('../miniprogram/services/replay.js');
  const mirror = require(path.join(DEST_ROOT, 'services', 'replay.js'));

  const members = [
    { _id: 'u01', gender: 'M', joinDate: '2026-04-01T00:00:00' },
    { _id: 'u02', gender: 'F', joinDate: '2026-04-01T00:00:00' },
    { _id: 'u03', gender: 'M', joinDate: '2026-05-01T00:00:00' },
  ];
  const matches = [
    {
      _id: 'm1',
      matchType: 1,
      teamA: ['u01'],
      teamB: ['u02'],
      scoreA: [11],
      scoreB: [7],
      winner: 'A',
      matchTime: '2026-04-08T18:00:00',
      eventId: null,
    },
    {
      _id: 'm2',
      matchType: 1,
      teamA: ['u03'],
      teamB: ['u01'],
      scoreA: [11],
      scoreB: [9],
      winner: 'A',
      matchTime: '2026-05-10T18:00:00',
      eventId: null,
    },
  ];

  const a = source.replaySeason({ members, matches });
  const b = mirror.replaySeason({ members, matches });

  assert.deepEqual(b.users, a.users, '镜像与源文件的等级分结果必须一致');
  assert.deepEqual(b.meta.placements, a.meta.placements, '镜像与源文件的定级结果必须一致');
});
