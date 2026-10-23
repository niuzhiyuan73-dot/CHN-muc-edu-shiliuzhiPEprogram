#!/usr/bin/env node
/**
 * 文档校对器。
 *
 * 只扫 A1 四份「数字校对型」文档，用 doc-truth 算出的真值比对。
 * 不扫历史文档 —— 旧验收记录里的数字在当时是对的，扫了只会产生噪音。
 *
 * 用法：
 *   node doc-audit.js                 校对数字（不校验用例数）
 *   node doc-audit.js --cases=N        附带用例数校验
 *   node doc-audit.js --frozen-check  检查 git 改动是否碰到冻结文档
 *   node doc-audit.js --links         检查文档内 markdown 链接可达
 *   node doc-audit.js --json          结构化输出
 *
 * 退出码：0 无漂移；1 有漂移/违规；2 真值计算失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { collectFacts, ROOT } = require('./doc-truth.js');

const A1_FILES = [
  'README.md',
  'docs/交接说明.md',
  'docs/云开发控制台操作指南.md',
  'docs/数据库索引清单.md',
];

/** 必改/现行文档白名单：命中冻结模式也要放行 */
const CURRENT_WHITELIST = [
  '网球计分-需求与实施方案',
  '石榴籽杯-需求确认与实施方案',
  'Elo逐场结算改造-交付与发布准备',
  '运动会栏目-发布准备',
  '施工切片账本',
  '云开发控制台操作指南',
  '赛事管理员操作手册',
  '交接说明',
  '数据库索引清单',
  '前端样式规范',
  'mock演示账号',
  'AI接手与后续施工指南',
];

const FROZEN_PATTERNS = [
  /验收记录/,
  /需求整理/,
  /实施记录/,
  /修复记录/,
  /审计/,
  /隐患/,
  /调查/,
];

/**
 * 断言规则。每条返回 [{ declared, truth, what }]。
 * 所有正则都不带 g，逐行执行。
 */
const RULES = [
  // ── 页面 ──────────────────────────────────────────────
  {
    id: 'pages-total-readme',
    files: ['README.md'],
    label: '页面总数',
    re: /app\.json\s*(\d+)\s*页/,
    pick: (m, f) => [{ declared: +m[1], truth: f.pages.total, what: '总数' }],
  },
  {
    id: 'pages-split-readme',
    files: ['README.md'],
    label: '页面分解',
    re: /主包\s*(\d+)\s*\+\s*分包\s*(\d+)/,
    pick: (m, f) => [
      { declared: +m[1], truth: f.pages.main, what: '主包' },
      { declared: +m[2], truth: f.pages.subTotal, what: '分包' },
    ],
  },
  {
    id: 'pages-plain',
    files: ['docs/交接说明.md'],
    label: '页面总数',
    re: /(\d+)\s*个页面/,
    pick: (m, f) => [{ declared: +m[1], truth: f.pages.total, what: '总数' }],
  },
  {
    id: 'subpackage-pages',
    files: ['README.md'],
    label: '分包页数',
    re: /^\s+(package\w+)\/.*?（(\d+)\s*页）/,
    pick: (m, f) => {
      const root = m[1];
      const truth = f.pages.sub[root];
      if (truth === undefined) return [];
      return [{ declared: +m[2], truth, what: root }];
    },
  },

  // ── action ────────────────────────────────────────────
  {
    id: 'actions-total',
    files: ['README.md'],
    label: 'action 总数',
    re: /共\s*(\d+)\s*个/,
    lineFilter: (line) => /action/i.test(line),
    pick: (m, f) => [{ declared: +m[1], truth: f.actions.total, what: '总数' }],
  },
  {
    id: 'actions-current',
    files: ['README.md'],
    label: 'action 总数',
    re: /当前\s*(\d+)\s*个\s*action/,
    pick: (m, f) => [{ declared: +m[1], truth: f.actions.total, what: '总数' }],
  },
  {
    id: 'actions-groups',
    files: ['README.md'],
    label: 'action 分组',
    re: /会员与身份\s*(\d+)、协会空间与个人赛\/团队\s*(\d+)、跨校邀请赛\s*(\d+)、运动会\s*(\d+)/,
    pick: (m, f) => {
      const g = f.actions.groups;
      return [
        { declared: +m[1], truth: g.SCHOOL_IDENTITY_ACTIONS, what: '会员与身份' },
        { declared: +m[2], truth: g.SCHOOL_SPACE_ACTIONS, what: '协会空间' },
        { declared: +m[3], truth: g.SCHOOL_EXCHANGE_ACTIONS, what: '跨校' },
        { declared: +m[4], truth: g.SCHOOL_MEET_ACTIONS, what: '运动会' },
      ];
    },
  },
  {
    id: 'actions-jiemian',
    files: ['docs/交接说明.md'],
    label: 'action 总数',
    re: /(\d+)\s*个云函数\s*action/,
    pick: (m, f) => [{ declared: +m[1], truth: f.actions.total, what: '总数' }],
  },

  // ── 集合 ──────────────────────────────────────────────
  {
    id: 'collections-build',
    files: ['README.md', 'docs/交接说明.md', 'docs/云开发控制台操作指南.md'],
    label: '集合总数',
    re: /建\s*(\d+)\s*个集合/,
    pick: (m, f) => [{ declared: +m[1], truth: f.collections, what: '总数' }],
  },
  {
    id: 'collections-plain',
    files: ['docs/交接说明.md'],
    label: '集合总数',
    re: /(\d+)\s*个数据库集合/,
    pick: (m, f) => [{ declared: +m[1], truth: f.collections, what: '总数' }],
  },
  {
    id: 'collections-total-word',
    files: ['docs/交接说明.md', 'docs/云开发控制台操作指南.md', 'docs/数据库索引清单.md'],
    label: '集合总数',
    re: /集合总数\s*(\d+)/,
    pick: (m, f) => [{ declared: +m[1], truth: f.collections, what: '总数' }],
  },

  // ── 镜像 ──────────────────────────────────────────────
  {
    id: 'mirrors-consistent',
    files: ['README.md'],
    label: '镜像文件',
    re: /(\d+)\s*个文件一致/,
    pick: (m, f) => [{ declared: +m[1], truth: f.mirrors.actual, what: '镜像' }],
  },
  {
    id: 'mirrors-paren',
    files: ['README.md'],
    label: '镜像文件',
    re: /（(\d+)\s*文件）/,
    pick: (m, f) => [{ declared: +m[1], truth: f.mirrors.actual, what: '镜像' }],
  },
  {
    id: 'mirrors-plain',
    files: ['docs/交接说明.md'],
    label: '镜像文件',
    re: /(\d+)\s*个云端镜像文件/,
    pick: (m, f) => [{ declared: +m[1], truth: f.mirrors.actual, what: '镜像' }],
  },

  // ── 测试基线 ──────────────────────────────────────────
  {
    id: 'cases',
    files: ['README.md'],
    label: '测试用例数',
    re: /(\d+)\s*项用例通过/,
    needsCases: true,
    pick: (m, f) => [{ declared: +m[1], truth: f.cases, what: '用例' }],
  },
  {
    id: 'test-files',
    files: ['README.md'],
    label: '测试文件数',
    re: /（(\d+)\s*个测试文件/,
    pick: (m, f) => [{ declared: +m[1], truth: f.testFiles, what: '文件' }],
  },
];

function auditNumbers(facts) {
  const results = [];
  const skipped = [];

  A1_FILES.forEach((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      skipped.push({ file: rel, reason: '文件不存在' });
      return;
    }
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

    RULES.filter((r) => r.files.includes(rel)).forEach((rule) => {
      if (rule.needsCases && facts.cases === null) {
        skipped.push({ file: rel, reason: `${rule.label}：未提供 --cases，跳过（需实跑 npm test）` });
        return;
      }
      lines.forEach((line, idx) => {
        if (rule.lineFilter && !rule.lineFilter(line)) return;
        const m = rule.re.exec(line);
        if (!m) return;
        rule.pick(m, facts).forEach((hit) => {
          results.push({
            file: rel,
            line: idx + 1,
            rule: rule.id,
            label: rule.label,
            what: hit.what,
            declared: hit.declared,
            truth: hit.truth,
            ok: hit.declared === hit.truth,
          });
        });
      });
    });
  });

  return { results, skipped };
}

function frozenCheck() {
  let entries = [];
  try {
    // core.quotepath=false：否则中文路径会被转义成 "docs/\344\272..."，模式全部失效
    const out = execSync('git -c core.quotepath=false status --porcelain', {
      cwd: ROOT,
      encoding: 'utf8',
    });
    entries = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).trim().replace(/^"|"$/g, '') }));
  } catch (err) {
    return { error: `git status 失败：${err.message}`, hits: [] };
  }

  // 只查「已跟踪文件的修改/删除」。新建（??）不拦 —— 新建验收记录是本批正常产物，
  // 冻结的含义是「已存在的历史记录不许回写」。
  const touched = entries.filter((e) => /[MDR]/.test(e.code));

  const hits = touched
    .filter((e) => {
      const p = e.path;
      if (!/^docs\/|^\.workbuddy\/memory\//.test(p)) return false;
      const base = path.basename(p);
      if (CURRENT_WHITELIST.some((w) => base.includes(w))) return false;
      if (p.startsWith('.workbuddy/memory/')) return true;
      return FROZEN_PATTERNS.some((re) => re.test(base));
    })
    .map((e) => e.path);

  return { hits, changedCount: touched.length, untracked: entries.length - touched.length };
}

function linkCheck() {
  const targets = A1_FILES.concat(['docs/施工切片账本.md']).filter((p) =>
    fs.existsSync(path.join(ROOT, p))
  );
  const broken = [];
  let total = 0;

  targets.forEach((rel) => {
    const dir = path.dirname(path.join(ROOT, rel));
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0]);
      if (!clean) continue;
      total += 1;
      const abs = path.resolve(dir, clean);
      if (!fs.existsSync(abs)) broken.push({ file: rel, target });
    }
  });

  return { total, broken };
}

function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const casesArg = argv.find((a) => a.startsWith('--cases='));
  const onlyFrozen = argv.includes('--only-frozen');
  const onlyLinks = argv.includes('--only-links');
  const doFrozen = argv.includes('--frozen-check') || onlyFrozen;
  const doLinks = argv.includes('--links') || onlyLinks;
  const skipNumbers = onlyFrozen || onlyLinks;

  let facts;
  try {
    facts = collectFacts();
  } catch (err) {
    console.error(`真值计算失败：${err.message}`);
    process.exit(2);
  }
  if (casesArg) {
    const n = Number(casesArg.split('=')[1]);
    if (Number.isFinite(n) && n > 0) facts.cases = n;
  }

  const output = { facts, numbers: null, frozen: null, links: null };
  let failed = false;

  if (!skipNumbers) {
    const { results, skipped } = auditNumbers(facts);
    const bad = results.filter((r) => !r.ok);
    output.numbers = { results, skipped, drift: bad.length, checked: results.length };
    failed = failed || bad.length > 0;
  }

  if (doFrozen) {
    const res = frozenCheck();
    output.frozen = res;
    failed = failed || (res.hits || []).length > 0 || Boolean(res.error);
  }

  if (doLinks) {
    const res = linkCheck();
    output.links = res;
    failed = failed || res.broken.length > 0;
  }

  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
    process.exit(failed ? 1 : 0);
  }

  if (output.numbers) {
    console.log('=== 数字校对（A1 四份）===');
    const rows = output.numbers.results;
    const bad = rows.filter((r) => !r.ok);
    if (!bad.length) {
      console.log(`0 差异（已核对 ${rows.length} 条断言）`);
    } else {
      bad.forEach((r) => {
        console.log(
          `${r.file}:${r.line}  ${r.label}${r.what && r.what !== '总数' ? `（${r.what}）` : ''}  ` +
            `声明 ${r.declared}  →  真值 ${r.truth}   [漂移]`
        );
      });
      console.log(`\n${bad.length} 条漂移 / 共 ${rows.length} 条断言`);
    }
    output.numbers.skipped.forEach((s) => console.log(`跳过：${s.file} — ${s.reason}`));
  }

  if (output.frozen) {
    console.log('\n=== 冻结文档检查 ===');
    if (output.frozen.error) console.log(output.frozen.error);
    else if (!output.frozen.hits.length) {
      console.log(`无冻结文档被改动（工作区改动 ${output.frozen.changedCount} 个）`);
    } else {
      output.frozen.hits.forEach((h) => console.log(`${h}   [冻结文件被修改]`));
    }
  }

  if (output.links) {
    console.log('\n=== 链接可达性 ===');
    if (!output.links.broken.length) console.log(`全部可达（${output.links.total} 条）`);
    else
      output.links.broken.forEach((b) =>
        console.log(`${b.file} → ${b.target}   [链接失效]`)
      );
  }

  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { auditNumbers, frozenCheck, linkCheck, RULES, A1_FILES };
