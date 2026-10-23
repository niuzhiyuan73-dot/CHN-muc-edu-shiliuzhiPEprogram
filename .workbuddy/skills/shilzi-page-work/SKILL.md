---
name: shilzi-page-work
description: 在石榴籽小程序里新增、迁移或改造页面时使用（涉及 miniprogram 下页面文件、wxml、wxss、app.json 登记）。包含分包归属决策、四件套与 app.json 登记、主题接线（themeClass 或 meet-theme）、视图层与数据层契约、加载/空/错/竞态/重复提交五态处理、page-registry 与 page-harness 测试写法、收尾自检命令。触发词：新增页面、加页面、加个页面、做个页面、开发页面、写个界面、改页面、页面改版、页面重构、迁移页面、S2 迁移、页面白屏、页面报错、页面没数据、列表空白、空状态、加载不出来、点了没反应、重复提交、双击提交、分包、子包、分包体积、app.json、注册页面、页面路径、wxml、wxss、页面样式、硬编码颜色、字号、tabBar、导航栏、themeClass、换肤、协会主题、运动会主题、meet-theme、page-registry、pageFileOf、页面装配、页面测试。不适用：只改云函数或仓储时用 shilzi-cloud-action；纯文档收尾用 shilzi-acceptance-doc。 同样适用于现有页面或共享组件的交互、表单校验、搜索筛选、分页、轮询与生命周期、权限展示、导航传参、可访问性、渲染性能的审查排错与优化；根据前端调用链触发，不限于新建页面。
---

# 页面新增与迁移

前置：先读 `shilzi-construction-guard`，按只读分析、指令维护或实际代码修改选择执行方式。页面是最外层，最容易把一个局部改动扩散成全项目问题。

## 触发范围

- 新增、迁移、修改、审查或排查现有页面，以及页面依赖的 `components/`、`templates/`、视图模型、路由和 `app.json` 配置；用户无需明确说“页面开发”。
- 包括布局与主题、按钮与表单、搜索筛选与分页、权限入口、导航和参数编码、加载与错误提示、请求竞态、重复提交、轮询与订阅释放、渲染性能及可访问性。
- “这个按钮没反应”“返回后数据不对”“换协会颜色没变”“帮我 review 这个组件”等均按页面任务处理。涉及接口或仓储问题时叠加 `shilzi-cloud-action`，沿调用链选择，不因入口在前端而漏掉后端约束。
- 只读审查按下方规则检查并报告；局部修改只执行相关章节，新增页面时才执行四件套和登记流程。

## 一、先定边界：放主包还是分包

主包只留 **tabBar 三页 + 登录 + 协会工作台外壳**。其余按域进五个分包：

| 分包 | 域 |
|---|---|
| `packageEvent` | 赛事、比赛录分 |
| `packageMeet` | 运动会 |
| `packageTeam` | 球队、团队赛事、实时计分 |
| `packageCollege` | 石榴籽杯、学院赛 |
| `packageMember` | 会员、公告、资料、学校身份、跨校 |

判断顺序：

1. 是 tabBar 页？→ 主包。
2. 属于哪个域？→ 对应分包。
3. 两个域都用？→ **不要新建第六个分包**，先问：是不是该做成主包组件而不是页面。

页面目录深度固定两级（`<包>/<页面>/`），`require('../../services/...')` 因此不用改。

## 二、四件套 + 登记

```
miniprogram/<包>/<页面>/<页面>.{js,wxml,wxss,json}
```

1. 四个文件同名，目录名与页面名一致。
2. 在 `miniprogram/app.json` 的对应分包 `pages` 里登记 —— **分包页不写进 `app.pages`**。
3. `json` 至少给 `navigationBarTitleText`；运动会页面另加金色 `navigationBarBackgroundColor`。
4. `wxss` 不 `@import` 分包外的文件；共用样式放 `miniprogram/templates/` 由主包提供。

漏登记的典型症状：跳转 `fail page "xxx" is not found`，但文件明明在。

## 三、主题接线（两选一，不许都不选）

**普通协会页面**：

```js
const { currentThemeClass } = require('../../services/branding.js');
Page({
  data: { themeClass: '' },
  onLoad() { this.setData({ themeClass: currentThemeClass() }); },
});
```

```html
<view class="page-container {{themeClass}}">
```

**运动会（`packageMeet`）例外**：根节点固定 `page-container meet-theme`，**不要**引 branding，**不要**挂 `{{themeClass}}`，json 里补 `navigationBarBackgroundColor: "#96700F"`。

原因与四件套照抄方式见 `docs/前端样式规范-2026-10-23.md §三`；`tests/meet-theme.test.js` 会检查这四件。

三个易踩点：

- `position: fixed` 的浮层、`picker` 弹窗在根容器**之外**，拿不到主题色 → 要么放进根容器，要么显式用主色变量。
- 危险操作（删除、作废、报错）用 `--color-danger-text`，不要用主色。
- 页面里不要重定义 `.btn` / `.card` / `.tag`。

## 四、数据层契约

- 页面只 `require('../../services/...')`，**不直接**碰 `mock.js` 或云函数；MOCK / CLOUD 必须是同一套接口。
- 视图层只做整形：DTO → `data`。权限判断只读服务端返回的 `can*` 字段，不在页面里发明规则。
- 新接口若只在云端有，要确认 `services` 门面已切换（`CLOUD_ENV_ID` 空 = 本地 mock），否则页面在本地永远拿不到数据。

## 五、五种状态，一个都不能省

| 状态 | 要求 | 漏了会怎样 |
|---|---|---|
| 加载中 | `loading` 且**不清空**已有列表 | 列表闪一下变白 |
| 空 | 用全局 `.empty-state`，文案说清「是没数据还是没权限」 | 白屏，用户以为坏了 |
| 失败 | 捕获后给可重试提示，**清掉旧数据** | 旧数据配新错误，看着像成功 |
| 竞态 | 请求序号 / epoch，过期响应不回写 | 快速切页签后被子孙请求覆盖 |
| 重复提交 | `submitting` 置位，`finally` 释放 | 双击提交两次 |

`onShow` 里刷新要判首次加载已完成，否则每次返回都闪一次骨架。

## 六、测试怎么写

用夹具，**不写死页面路径**：

```js
const { pageFileOf, isRegistered } = require('../helpers/page-registry.js');
const { loadPage } = require('../helpers/page-harness.js');
```

- `pageFileOf(name)` / `pagePathOf(name)`：从 `app.json` 查（主包与分包都能查）。
- `isRegistered(name)`：判断是否注册（**不要**用 `app.pages.includes`，分包页不在里面）。
- `loadPage` / `instantiate` / `withWx`：喂假 `wx` 跑页面配置。

页面装配用例集中在 `tests/page.test.js`（约 17s，慢是正常的）。域级页面用例按业务走（如 `meet-pages.test.js`、`team-pages.test.js`）。

## 七、收尾自检

```bash
node tools/run-tests.js --filter page                # 装配回归
node --test tests/subpackage-boundaries.test.js      # 引用方向
node --test tests/miniprogram-runtime-safety.test.js  # Node 全局禁区
npm test                                              # 全量
```

再人工过一遍：新页面在真机上换协会后颜色变不变、空列表有没有提示、双击提交会不会两次。

## 八、交付清单模板

```
- [ ] 四件套齐全，目录两级
- [ ] app.json 对应分包已登记（未写进 app.pages）
- [ ] 主题：{{themeClass}} 或 meet-theme（含金色导航栏）
- [ ] 无硬编码颜色/字号，未重定义全局类
- [ ] 五态齐（加载/空/失败/竞态/重复提交）
- [ ] 装配用例通过，边界与运行时自检通过
- [ ] 新增页面数已同步进文档（交给 shilzi-doc-sync）
```
