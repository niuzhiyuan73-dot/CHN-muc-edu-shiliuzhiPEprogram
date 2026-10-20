/**
 * 测试运行器（tools/run-tests.js）的自检
 * ============================================================
 * 【为什么给运行器本身写测试】
 * 2026-10-20 踩过一次「整套测试长时间没有输出」：单个测试文件要 190 秒，
 * 又被中断残留的子进程抢了 CPU，看上去像某个用例死锁，实际是没人告诉你在等谁。
 * 修法不是把那个文件调快，而是让**运行器**保证三件事：单文件有硬超时、
 * 过程有进度、失败/超时能点名。这三条一旦被改坏，卡死会悄悄回来，
 * 所以用临时目录造「通过 / 失败 / 挂住」三个文件，直接验运行器的判定。
 *
 * 只跑三个小文件，总耗时约 2 秒（挂住的那个 1.5 秒被杀）。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'tools', 'run-tests.js');

/** 造一个临时测试目录，写入若干测试文件 */
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-runner-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function runRunner(dir, extra = []) {
  const result = spawnSync(process.execPath, [RUNNER, '--root', dir, '--concurrency', '3', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

const PASS_FILE = `const { test } = require('node:test');
test('甲', () => {});
test('乙', () => {});
`;

const FAIL_FILE = `const { test } = require('node:test');
const assert = require('node:assert/strict');
test('会失败的那条', () => { assert.equal(1, 2); });
`;

/** 一条永不结束的用例：定时器让子进程活着，只有硬超时能收场 */
const HANG_FILE = `const { test } = require('node:test');
test('挂住的用例', () => { setInterval(() => {}, 1000); });
`;

test('运行器 —— 全通过时退出码为 0，并给出文件数与耗时', () => {
  const dir = makeFixture({ 'a.test.js': PASS_FILE });
  try {
    const { code, output } = runRunner(dir);
    assert.equal(code, 0, output);
    assert.match(output, /文件 1 · 用例 2 · 通过 1 · 失败 0 · 超时 0/, '用例数要从 TAP 汇总里数出来');
    assert.match(output, /✔ .*a\.test\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('运行器 —— 失败与挂住分别记成失败/超时，退出码非 0 且点名到文件', () => {
  const dir = makeFixture({
    'a-pass.test.js': PASS_FILE,
    'b-fail.test.js': FAIL_FILE,
    'c-hang.test.js': HANG_FILE,
  });
  try {
    // 超时压到 1.5 秒：挂住的文件必须在硬超时被杀，而不是拖住整套
    const { code, output } = runRunner(dir, ['--timeout', '1500']);
    assert.notEqual(code, 0, '有失败/超时必须返回非 0');
    assert.match(output, /文件 3 · 用例 3 · 通过 1 · 失败 1 · 超时 1/, output);
    assert.match(output, /✖ .*b-fail\.test\.js/, '失败的文件要点名');
    assert.match(output, /⏱ .*c-hang\.test\.js/, '超时的文件要点名');
    assert.match(output, /超时（>1\.5s）/, '超时原因要写在行上');
    assert.match(output, /──── 超时：.*c-hang\.test\.js/, '超时要单独给一段输出，便于定位');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('运行器 —— 慢文件被单独点名，回归时第一眼能看到', () => {
  const dir = makeFixture({ 'slow.test.js': PASS_FILE });
  try {
    const { code, output } = runRunner(dir, ['--slow', '1']);
    assert.equal(code, 0, output);
    assert.match(output, /慢文件/, '超过慢阈值要单列，而不是只报总耗时');
    assert.match(output, /slow\.test\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm test 必须走带超时的运行器，不能退回裸 node --test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /tools\/run-tests\.js/,
    '裸 `node --test` 没有硬超时，单文件卡住会让整套永远不出结果');
  // 原生运行器留一个入口，方便单独排查某个文件（但不当默认）
  assert.ok(pkg.scripts['test:node'], '保留 test:node 便于用原生运行器排查单文件');
});
