const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { cloneData, instantiate } = require('./helpers/page-harness');

function component() {
  let config;
  const previous = global.Component;
  global.Component = definition => { config = definition; };
  const target = require.resolve(path.join(__dirname, '../miniprogram/components/football-event-form/football-event-form.js'));
  try { delete require.cache[target]; require(target); } finally { global.Component = previous; }
  const instance = instantiate({ data: config.data, ...config.methods });
  instance.properties = { submitting: false, serverError: '' };
  const events = [];
  instance.triggerEvent = (name, payload) => events.push([name, cloneData(payload)]);
  config.lifetimes.attached.call(instance);
  return { instance, config, events };
}
const event = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value } });
const named = instance => instance.onInput(event('name', '自由组队足球杯'));

test('足球建赛组件初始化、字段编辑、完整规则预览与返回修改', () => {
  const { instance, events } = component();
  assert.equal(instance.data.ready, true);
  assert.equal(instance.data.preview, false);
  assert.match(instance.data.presetLabel, /校园/);
  instance.onPreview();
  assert.match(instance.data.error, /名称/);
  assert.equal(instance.data.preview, false);
  named(instance);
  instance.onInput(event('halfMinutes', '35'));
  instance.onPreview();
  assert.equal(instance.data.preview, true);
  assert.equal(instance.data.previewName, '自由组队足球杯');
  assert.ok(instance.data.summaryLines.some(line => line.includes('35 分钟')));
  instance.onInput(event('halfMinutes', '45'));
  assert.equal(instance.form.halfMinutes, '35', '预览期间不能偷偷改请求');
  instance.onBack();
  assert.equal(instance.data.preview, false);
  assert.deepEqual(events, []);
});

test('足球组件提交必须经过预览，重复点击只发一次，失败重试沿用同一请求号', () => {
  const { instance, config, events } = component();
  named(instance);
  instance.onSubmit();
  assert.equal(events.length, 0);
  instance.onPreview(); instance.onSubmit(); instance.onSubmit();
  assert.equal(events.length, 1);
  const payload = events[0][1];
  assert.equal(events[0][0], 'submit');
  assert.equal(payload.sportFormat, 'football11');
  assert.equal(payload.rules.eventRosterMin, 11);
  assert.equal(payload.rules.scoringMode, 'post_match');
  assert.match(payload.requestId, /^fb_/);
  assert.equal(instance.data.pending, true);
  instance.onBack(); assert.equal(instance.data.preview, true);
  config.observers.serverError.call(instance, '暂时保存失败');
  instance.onSubmit();
  assert.equal(events.length, 2);
  assert.equal(events[1][1].requestId, payload.requestId);
  config.observers.submitting.call(instance, false);
  instance.onBack(); instance.onInput(event('name', '另一届足球杯')); instance.onPreview(); instance.onSubmit();
  assert.equal(events.length, 3);
  assert.notEqual(events[2][1].requestId, payload.requestId, '改变表单后须使用新请求号');
});

test('足球组件切换预设保护修改，取消不覆盖，确认后保留赛事名称及赛制', () => {
  const { instance } = component();
  named(instance);
  instance.onSelect(event('format', '1'));
  instance.onInput(event('halfMinutes', '35'));
  const previous = global.wx;
  const modals = [];
  global.wx = { showModal: options => modals.push(options) };
  try {
    instance.onPreset({ detail: { value: '1' } });
    assert.equal(modals.length, 1);
    modals[0].success({ confirm: false });
    assert.equal(instance.form.halfMinutes, '35');
    instance.onPreset({ detail: { value: '1' } });
    modals[1].success({ confirm: true });
    assert.equal(instance.form.halfMinutes, '45');
    assert.equal(instance.form.name, '自由组队足球杯');
    assert.equal(instance.form.format, 'round_robin');
    assert.equal(instance.data.customized, false);
  } finally { global.wx = previous; }
});

test('过期预设确认与已销毁组件的回调不覆盖新输入', () => {
  const { instance, config } = component();
  const previous = global.wx;
  let modal;
  global.wx = { showModal: options => { modal = options; } };
  try {
    instance.onInput(event('halfMinutes', '35'));
    instance.onPreset({ detail: { value: '1' } });
    instance.onInput(event('halfMinutes', '30'));
    modal.success({ confirm: true });
    assert.equal(instance.form.halfMinutes, '30');
    instance.onPreset({ detail: { value: '1' } });
    config.lifetimes.detached.call(instance);
    modal.success({ confirm: true });
    assert.equal(instance.form.halfMinutes, '30');
  } finally { global.wx = previous; }
});

test('足球组件换人额度/不限模式保留数值，等待保存时不能改动或取消', () => {
  const { instance, events } = component();
  named(instance);
  instance.onInput(event('substitutionLimit', '7'));
  instance.onQuotaMode(event('substitutionLimit', '1'));
  assert.equal(instance.form.substitutionLimit, 'all_named');
  instance.onQuotaMode(event('substitutionLimit', '0'));
  assert.equal(instance.form.substitutionLimit, '7');
  instance.onQuotaMode(event('substitutionOpportunities', '1'));
  assert.equal(instance.form.substitutionOpportunities, 'unlimited');
  instance.onSwitch(event('returnAllowed', true));
  assert.equal(instance.form.returnAllowed, true);
  instance.onPreview(); instance.onSubmit();
  const before = JSON.stringify(instance.form);
  instance.onQuotaMode(event('substitutionOpportunities', '0'));
  instance.onSwitch(event('returnAllowed', false));
  instance.onCancel();
  assert.equal(JSON.stringify(instance.form), before);
  assert.equal(events.length, 1);
});

test('足球组件先加时选项动态出现；循环赛不展示淘汰赛选项', () => {
  const { instance } = component();
  instance.onSelect(event('knockoutTieBreak', '1'));
  assert.ok(instance.data.fields.some(field => field.key === 'extraTimeHalfMinutes'));
  instance.onSwitch(event('extraTimeAdditional', true));
  instance.onSelect(event('knockoutTieBreak', '0'));
  assert.equal(instance.form.extraTimeAdditional, false);
  assert.equal(instance.data.fields.some(field => field.key === 'extraTimeHalfMinutes'), false);
  instance.onSelect(event('format', '1'));
  assert.equal(instance.data.fields.some(field => field.key === 'knockoutTieBreak'), false);
  assert.doesNotMatch(instance.data.summary, /淘汰赛|加时|点球各/);
});

test('足球组件保留无效输入并定位错误，不发布半成品请求', () => {
  const { instance, events } = component();
  named(instance);
  instance.onInput(event('halfMinutes', ''));
  instance.onPreview(); instance.onSubmit();
  assert.equal(instance.data.preview, false);
  assert.equal(instance.form.halfMinutes, '');
  assert.ok(instance.data.fields.find(field => field.key === 'halfMinutes').error);
  assert.deepEqual(events, []);
  instance.onCancel(); assert.equal(events[0][0], 'cancel');
});

test('足球组件模板的交互绑定均有方法，组件声明可解析', () => {
  const { config } = component();
  const root = path.join(__dirname, '../miniprogram/components/football-event-form');
  const wxml = fs.readFileSync(path.join(root, 'football-event-form.wxml'), 'utf8');
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'football-event-form.json'), 'utf8'));
  assert.equal(declared.component, true);
  for (const match of wxml.matchAll(/bind(?:tap|input|change)="([^"]+)"/g)) {
    assert.equal(typeof config.methods[match[1]], 'function', `${match[1]} 缺失`);
  }
});
