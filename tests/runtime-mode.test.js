/**
 * 运行模式 与 协议 1 解耦（P10 第 3 步的前置）
 * ============================================================
 * 背景：协议 1 已定「完全下线」（见 docs/隐患与未定产品决策-2026-10-16.md §三 P10）。
 * 但「现在跑的是本地模拟数据还是云端」这个开关原本长在协议 1 的数据源门面
 * （services/index.js）里，而**学校维度自己也要按它取仓储**：
 *
 *     school-identity.js  ──isMockNow()──▶  services/index.js（协议 1 门面）
 *                                              ▲
 *     association-space.js / exchange.js ──────┘
 *
 * 于是「删门面」会连带打断学校维度的 mock / cloud 判定——这就是 P10 第 3 步
 * 必须先解开的硬耦合点。本切片把模式搬到中立模块 runtime-mode.js。
 *
 * 本测试钉住两件事：
 *   ① 运行模式本身的行为；
 *   ② 解耦的静态事实——页面层、模板与服务层都不再碰旧门面（协议 1 已随
 *      P10-c 完全下线，清单空了；这条静态守护继续钉住「不许复活」）。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = require('../miniprogram/services/runtime-mode.js');

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram');
// 页面已按域拆进 5 个分包；要扫「所有页面」必须从 app.json 取目录，
// 写死 pages/ 只会扫到主包那 5 页，其余 37 页静默漏检。
const { pageDirs } = require('./helpers/page-registry.js');
const FACADE_REF = 'services/index.js';
const FACADE_REQUIRE = "require('./index.js')";

/**
 * 仍 require 旧门面的服务层文件（相对 miniprogram/services/）。
 *
 * 【为什么允许它们继续依赖】协议 1 的删除是破坏性改动，分切片推进：本切片只
 * 负责「解耦运行模式 + 页面层归零」，服务层与旧栈删除留给切片 B / C。列表中
 * 每消掉一个，切片 B 就离「可以删门面」更近一步。
 */
const SERVICE_FILES_PENDING = [
  // P10 合并批第 10 子批：association-usage 改接 S2（getSchoolMemberStats），
  // withAssociation / mapActiveAssociations 删除后，服务层对旧门面的依赖归零，
  // P10-c 可以删门面了。
].sort();

/** 递归列出目录下的 .js 文件。 */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 页面上是否出现对旧门面的引用。 */
function filesReferencing(files) {
  return files.filter((file) => fs.readFileSync(file, 'utf8').includes(FACADE_REF));
}

/** 在给定模式下跑一段断言，结束后无论成败都复位为 mock。 */
function withMode(name, fn) {
  const original = runtime.getDataSource();
  runtime.setDataSource(name);
  try {
    fn();
  } finally {
    runtime.setDataSource(original);
  }
}

describe('运行模式 —— 状态与校验', () => {
  test('默认是本地模拟数据', () => {
    assert.equal(runtime.getDataSource(), 'mock');
    assert.equal(runtime.isMockNow(), true);
    assert.equal(runtime.isMock, true);
  });

  test('切到云端后读数为云端，切回后读数为模拟', () => {
    withMode('cloud', () => {
      assert.equal(runtime.getDataSource(), 'cloud');
      assert.equal(runtime.isMockNow(), false);
      assert.equal(runtime.isMock, false);
    });
    assert.equal(runtime.getDataSource(), 'mock');
    assert.equal(runtime.isMockNow(), true);
  });

  test('不认识的数据源被当场拒绝，且不改变当前状态', () => {
    assert.throws(() => runtime.setDataSource('sqlite'), /未知的数据源/);
    assert.equal(runtime.getDataSource(), 'mock');
  });

  test('resetDataSource 复位为本地模拟', () => {
    withMode('cloud', () => {
      runtime.resetDataSource();
      assert.equal(runtime.getDataSource(), 'mock');
    });
  });
});

describe('P10-a 解耦 —— 学校维度与页面层不再依赖旧门面', () => {
  test('school-identity.js 不再 require 旧门面', () => {
    const text = fs.readFileSync(
      path.join(MINIPROGRAM, 'services', 'school-identity.js'),
      'utf8'
    );
    assert.ok(
      !text.includes(FACADE_REQUIRE),
      'school-identity 一旦再依赖旧门面，删门面就会打断学校维度的 mock / cloud 判定'
    );
  });

  test('app.js 不再 require 旧门面', () => {
    const text = fs.readFileSync(path.join(MINIPROGRAM, 'app.js'), 'utf8');
    assert.ok(!text.includes(FACADE_REF), 'app.js 的运行模式开关应走 runtime-mode');
  });

  test('页面与组件都不再 require 旧门面', () => {
    const files = [
      ...pageDirs().flatMap((dir) => jsFiles(dir)),
      ...jsFiles(path.join(MINIPROGRAM, 'components')),
    ];
    assert.deepEqual(
      filesReferencing(files).map((f) => path.relative(MINIPROGRAM, f)),
      [],
      '页面层要切协会走 association-scope，要读运行模式走 runtime-mode'
    );
  });

  test('服务层待迁移清单必须与登记一致（切片 B 的进度条）', () => {
    const servicesDir = path.join(MINIPROGRAM, 'services');
    const actual = fs
      .readdirSync(servicesDir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => fs.readFileSync(path.join(servicesDir, name), 'utf8').includes(FACADE_REQUIRE))
      .sort();

    assert.deepEqual(
      actual,
      SERVICE_FILES_PENDING,
      '新增对旧门面的依赖不是小事；若这是切片 B 的成果，请同步更新本清单'
    );
  });
});
