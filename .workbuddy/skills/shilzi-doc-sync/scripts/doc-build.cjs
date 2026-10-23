#!/usr/bin/env node
/**
 * 批量重建 docx 产物（md 是唯一内容源）。
 *
 * 用法：
 *   node doc-build.cjs              重建全部三份
 *   node doc-build.cjs 交接说明      只重建名字含该串的
 *   node doc-build.cjs --check      只检查环境，不构建
 *
 * 退出码：0 成功；1 构建失败或缺依赖；2 找不到 python。
 *
 * 设计取舍：缺 python-docx 时**明确失败**，不静默跳过。
 * 假装成功比不构建更糟 —— 上次就是这样让 docx 落后于 md 而没人发现。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../../..');

const TARGETS = [
  { name: '赛事管理员操作手册', md: 'docs/赛事管理员操作手册.md', docx: '赛事管理员操作手册.docx' },
  { name: '云开发控制台操作指南', md: 'docs/云开发控制台操作指南.md', docx: '云开发控制台操作指南.docx' },
  { name: '交接说明', md: 'docs/交接说明.md', docx: '交接说明.docx' },
];

const PYTHON_CANDIDATES = [
  // 已装 python-docx 的隔离环境优先
  'C:/Users/17789/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
  'C:/Users/17789/.workbuddy/binaries/python/versions/3.13.12/python.exe',
  'python',
  'python3',
];

function findPython() {
  for (const cmd of PYTHON_CANDIDATES) {
    if (cmd.includes('/') && !fs.existsSync(cmd)) continue;
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version.split()[0])'], {
      encoding: 'utf8',
    });
    if (r.status === 0) return { cmd, version: (r.stdout || '').trim() };
  }
  return null;
}

function hasDocx(cmd) {
  const r = spawnSync(cmd, ['-c', 'import docx; print("ok")'], { encoding: 'utf8' });
  return r.status === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const filter = argv.find((a) => !a.startsWith('--'));

  const py = findPython();
  if (!py) {
    console.error('[失败] 找不到可用的 python。');
    console.error('安装：https://www.python.org/downloads/ 或使用项目约定的托管解释器');
    process.exit(2);
  }
  console.log(`python: ${py.cmd}（${py.version}）`);

  if (!hasDocx(py.cmd)) {
    console.error('[失败] 缺 python-docx，docx 未重建。');
    console.error(`修复：${py.cmd} -m pip install python-docx`);
    console.error('说明：md 已是最新，只有 docx 产物落后；不要手改 docx 绕过构建。');
    process.exit(1);
  }

  const list = filter ? TARGETS.filter((t) => t.name.includes(filter)) : TARGETS;
  if (!list.length) {
    console.error(`[失败] 没有匹配 "${filter}" 的目标。可选：${TARGETS.map((t) => t.name).join(' / ')}`);
    process.exit(1);
  }

  if (checkOnly) {
    console.log(`环境就绪，待构建 ${list.length} 份：`);
    list.forEach((t) => console.log(`  ${t.md} → ${t.docx}`));
    return;
  }

  const script = path.join(ROOT, 'tools/md-to-docx.py');
  if (!fs.existsSync(script)) {
    console.error(`[失败] 找不到构建脚本：${script}`);
    process.exit(1);
  }

  let failed = 0;
  list.forEach((t) => {
    const src = path.join(ROOT, t.md);
    const out = path.join(ROOT, t.docx);
    if (!fs.existsSync(src)) {
      console.error(`[跳过] 源文件不存在：${t.md}`);
      failed += 1;
      return;
    }
    const before = fs.existsSync(out) ? fs.statSync(out).mtimeMs : 0;
    const r = spawnSync(py.cmd, [script, src, out], { encoding: 'utf8', cwd: ROOT });
    if (r.status !== 0) {
      console.error(`[失败] ${t.md}`);
      console.error((r.stderr || r.stdout || '').split('\n').slice(-6).join('\n'));
      failed += 1;
      return;
    }
    const after = fs.existsSync(out) ? fs.statSync(out).mtimeMs : 0;
    const sizeKb = fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1024) : 0;
    console.log(`[完成] ${t.docx}（${sizeKb} KB${after > before ? '，已更新' : '，内容未变'}）`);
  });

  if (failed) {
    console.error(`\n${failed} 份失败。`);
    process.exit(1);
  }
  console.log(`\n${list.length} 份构建完成。`);
}

main();
