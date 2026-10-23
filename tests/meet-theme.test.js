/**
 * 运动会恒定金色主题
 * ============================================================
 * 运动会的配色**不跟协会换肤**：一届运动会同时包含篮球、足球、匹克球等多个
 * 协会的项目，跟着当前协会变色会出现「切到匹克球，篮球项目也变蓝」的错位。
 *
 * 这条测试盯住四件事，任何一条被改回去都会红：
 *   1. 七个页面根节点固定挂 `page-container meet-theme`，不再是动态 themeClass；
 *   2. 页面 JS 不再引 branding（去掉「跟着协会变」的能力，而不只是改个值）；
 *   3. app.wxss 里 `.page-container.meet-theme` 覆盖了四个主题变量，
 *      且特异性高于 `.assoc-*`——这是「恒定」的实现方式；
 *   4. 错误 / 删除 / 作废这类**危险语义**用 danger 变量，不用主色。
 *      否则金色主题一上，报错提示会变成金底金字，语义丢失。
 *
 * 另有一条看导航栏：默认导航栏是石榴红，运动会页面若不单独配置，
 * 会出现「红顶配金内容」。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const MEET = path.join(MINI, 'packageMeet');

/** 运动会分包下的七个页面名。与 app.json 的 packageMeet.pages 同集合。 */
const PAGES = [
  'meet-list', 'meet-detail', 'meet-setup', 'meet-schedule',
  'meet-score', 'meet-college', 'meet-standing',
];

const read = (file) => fs.readFileSync(file, 'utf8');

test('七个页面根节点固定挂 meet-theme，不再有动态换肤类', () => {
  for (const name of PAGES) {
    const wxml = read(path.join(MEET, name, `${name}.wxml`));
    assert.ok(wxml.includes('class="page-container meet-theme"'),
      `${name}.wxml 的根节点必须是 page-container meet-theme（运动会恒定金色）`);
    assert.ok(!wxml.includes('{{themeClass}}'),
      `${name}.wxml 还在绑动态主题类，运动会会跟着协会变色`);
  }
});

test('页面 JS 不再引 branding：去掉跟随协会的能力，而不是把值写死', () => {
  for (const name of PAGES) {
    const js = read(path.join(MEET, name, `${name}.js`));
    assert.ok(!/currentThemeClass|themeClassOf|applyBranding/.test(js),
      `${name}.js 还在调协会品牌接口`);
    assert.ok(!js.includes('themeClass'), `${name}.js 还留着 themeClass 字段`);
  }
});

test('.page-container.meet-theme 覆盖四个主题变量，且压得过 .assoc-*', () => {
  const app = read(path.join(MINI, 'app.wxss'));

  // 特异性 (0,2,0) > .assoc-* 的 (0,1,0)：即使某页误挂了协会主题类，
  // 运动会仍然是金色。用两个类选择器是刻意的，不要简化成 .meet-theme。
  const block = /\.page-container\.meet-theme\s*\{([^}]*)\}/.exec(app);
  assert.ok(block, 'app.wxss 缺少 .page-container.meet-theme（运动会恒定金色主题）');

  const body = block[1];
  for (const name of ['--color-primary', '--color-primary-dark', '--color-primary-light', '--color-accent']) {
    assert.ok(new RegExp(`${name}\\s*:`).test(body), `运动会主题没有覆盖 ${name}`);
  }
  // 主色必须是金色系（R 明显大于 B），而不是石榴红或其它协会色
  const primary = /--color-primary\s*:\s*#([0-9a-f]{6})/i.exec(body);
  assert.ok(primary, '运动会主题的主色不是十六进制值');
  const r = parseInt(primary[1].slice(0, 2), 16);
  const g = parseInt(primary[1].slice(2, 4), 16);
  const b = parseInt(primary[1].slice(4, 6), 16);
  assert.ok(r > b + 80 && g > b + 40, `运动会主色 #${primary[1]} 不是金色系（暖色、蓝通道最低）`);
});

test('导航栏也是金色，避免红顶配金内容', () => {
  for (const name of PAGES) {
    const json = JSON.parse(read(path.join(MEET, name, `${name}.json`)));
    assert.strictEqual(json.navigationBarBackgroundColor, '#96700F',
      `${name}.json 的导航栏没有配成金色（默认是石榴红）`);
    assert.strictEqual(json.navigationBarTextStyle, 'white',
      `${name}.json 的导航栏文字必须是白色（金色底上黑字不可读）`);
  }
});

test('危险语义用 danger 变量，不吃主色', () => {
  // 报错 / 删除 / 作废这类提示本来就是红色，换个主题色不该把它们也染色。
  const DANGER = ['meet-error', 'meet-warn', 'meet-danger', 'meet-judge-remove',
    'meet-pick-failed', 'meet-pick-error', 'is-no', 'is-void'];
  for (const name of PAGES) {
    const wxss = read(path.join(MEET, name, `${name}.wxss`));
    for (const line of wxss.split('\n')) {
      if (!DANGER.some((key) => line.includes(key))) continue;
      assert.ok(!/color:\s*var\(--color-primary\)/.test(line),
        `${name}.wxss 的危险语义用了主色（换主题后会变金色）：${line.trim()}`);
    }
  }
});

test('运动会页面不出现协会主题类', () => {
  for (const name of PAGES) {
    const wxml = read(path.join(MEET, name, `${name}.wxml`));
    assert.ok(!/class="[^"]*assoc-/.test(wxml), `${name}.wxml 挂了协会主题类`);
  }
});
