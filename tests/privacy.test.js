/**
 * 隐私授权桥（2026-10-21）
 * ============================================================
 * 背景：全项目只有一个隐私接口——`<button open-type="chooseAvatar">`
 * （登录页与编辑资料页各一处，`<input type="nickname">` 同属一类）。
 * 用户**首次**点它时，微信不会直接给头像，而是先拦下这次调用，把挂起凭证
 * 交给 `onNeedPrivacyAuthorization`。没人 resolve 它，那次调用就永远悬着，
 * 界面表现为「按钮点下去毫无反应」——既不报错，也不弹框。
 *
 * 这里钉住三件事：
 *   ① 凭证的登记与结算语义（同意必须带 buttonId，否则微信不认）；
 *   ② 边界情形：重复结算、旧请求被新请求顶掉、退订之后不再通知；
 *   ③ 静态事实：「同意」按钮的 open-type 与两处页面挂载不许被改掉。
 *      第 ③ 条是防退化——把 open-type 写成 bindtap 一样能点，但授权不生效，
 *      单元测试看不出问题，只能静态守护。
 * ============================================================
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram');
const privacy = require('../miniprogram/services/privacy.js');

const read = (rel) => fs.readFileSync(path.join(MINIPROGRAM, rel), 'utf8');

describe('隐私授权桥 —— 凭证语义', () => {
  test('登记后进入「待授权」，结算后复位', () => {
    assert.equal(privacy.hasPending(), false);
    privacy.request(() => {});
    assert.equal(privacy.hasPending(), true);
    privacy.settle('disagree');
    assert.equal(privacy.hasPending(), false);
  });

  test('同意时 resolve 必须带上按钮 id，微信据此认定授权来源', () => {
    let got = null;
    privacy.request((arg) => {
      got = arg;
    });
    privacy.settle('agree');
    assert.deepEqual(got, { buttonId: 'privacy-agree-btn', event: 'agree' });
  });

  test('拒绝时只回 event，不带 buttonId', () => {
    let got = null;
    privacy.request((arg) => {
      got = arg;
    });
    privacy.settle('disagree');
    assert.deepEqual(got, { event: 'disagree' });
  });

  test('重复结算不抛错：用户连点两下「同意」不该把页面搞崩', () => {
    privacy.request(() => {});
    privacy.settle('agree');
    assert.doesNotThrow(() => privacy.settle('agree'));
    assert.doesNotThrow(() => privacy.settle('disagree'));
  });

  test('旧请求被新请求顶掉时，旧的按拒绝结掉，不会永远悬着', () => {
    let first = null;
    let second = null;
    privacy.request((arg) => {
      first = arg;
    });
    privacy.request((arg) => {
      second = arg;
    });
    assert.deepEqual(first, { event: 'disagree' }, '旧的必须被拒绝，否则那次调用永远等不到结果');
    privacy.settle('agree');
    assert.deepEqual(second, { buttonId: 'privacy-agree-btn', event: 'agree' });
  });

  test('非函数凭证直接忽略，不污染状态', () => {
    privacy.request(null);
    privacy.request(undefined);
    assert.equal(privacy.hasPending(), false);
  });
});

describe('隐私授权桥 —— 订阅', () => {
  test('登记与结算都会通知订阅者', () => {
    let count = 0;
    const off = privacy.subscribe(() => {
      count += 1;
    });
    privacy.request(() => {});
    assert.equal(count, 1);
    privacy.settle('agree');
    assert.equal(count, 2);
    off();
  });

  test('退订之后不再收到通知', () => {
    let count = 0;
    const off = privacy.subscribe(() => {
      count += 1;
    });
    off();
    privacy.request(() => {});
    privacy.settle('disagree');
    assert.equal(count, 0);
  });

  test('一个订阅者抛错不影响其他订阅者', () => {
    let ok = false;
    const offBad = privacy.subscribe(() => {
      throw new Error('故意抛错');
    });
    const offGood = privacy.subscribe(() => {
      ok = true;
    });
    assert.doesNotThrow(() => privacy.request(() => {}));
    assert.equal(ok, true);
    offBad();
    offGood();
    privacy.settle('disagree');
  });
});

describe('隐私授权桥 —— 静态守护', () => {
  test('app.js 在 onLaunch 里接上 onNeedPrivacyAuthorization', () => {
    const src = read('app.js');
    assert.ok(src.includes('wx.onNeedPrivacyAuthorization'), 'app 必须接住拦截回调，否则首次点换头像静默失败');
    assert.ok(src.includes('initPrivacyBridge'), '启动时就要接好，不能等页面渲染完');
  });

  test('两个用到 chooseAvatar 的页面都挂了 privacy-gate', () => {
    for (const rel of ['pages/login/login.wxml', 'packageMember/profile-edit/profile-edit.wxml']) {
      assert.ok(read(rel).includes('<privacy-gate'), `${rel} 缺 privacy-gate，用户点换头像会卡住`);
    }
  });

  test('两个页面的 json 都注册了 privacy-gate 组件', () => {
    for (const rel of ['pages/login/login.json', 'packageMember/profile-edit/profile-edit.json']) {
      const cfg = JSON.parse(read(rel));
      assert.ok(
        cfg.usingComponents && cfg.usingComponents['privacy-gate'],
        `${rel} 未注册 privacy-gate`,
      );
    }
  });

  test('「同意」按钮必须是 open-type="agreePrivacyAuthorization"', () => {
    const src = read('components/privacy-gate/privacy-gate.wxml');
    assert.ok(
      src.includes('open-type="agreePrivacyAuthorization"'),
      '改成 bindtap 也能点，但微信不认那次授权，接口照样失败',
    );
    assert.ok(src.includes('bindagreeprivacyauthorization'), '缺这个事件，点了同意也结算不了凭证');
    assert.ok(src.includes('privacy-agree-btn'), '按钮 id 要与 services/privacy.js 的 AGREE_BUTTON_ID 一致');
  });

  test('「我的」页有隐私指引与用户协议两个入口', () => {
    const wxml = read('pages/profile/profile.wxml');
    assert.ok(wxml.includes('onOpenPrivacyContract'), '缺隐私指引入口');
    assert.ok(wxml.includes('onGoAgreement'), '缺用户协议入口');
  });

  test('用户协议页已在 app.json 注册', () => {
    const app = JSON.parse(read('app.json'));
    const pack = (app.subPackages || []).find((item) => item.root === 'packageMember');
    assert.ok(pack, 'packageMember 分包不存在');
    assert.ok(pack.pages.includes('agreement/agreement'), '用户协议页未注册');
  });
});
