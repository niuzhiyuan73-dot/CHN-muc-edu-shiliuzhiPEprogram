# mock 演示数据扩充 + 「民大春季杯」修复 + 提交历史整理 验收记录

日期：2026-10-16（12:00 定时任务）。三件事一起做：扩充 mock 演示数据与差异性、
修复「民大春季杯」打不开、把 B4～B8 与本次改动合并为一次本地提交。

## 一、mock 演示数据扩充

**权威来源**：`miniprogram/services/school-seed.js` 的 `DEMO_ACCOUNTS` 与
`DEMO_CONTENT_SPECS`（由 `school-mock.reset()` 默认挂进内存仓储）。

| 范围 | 公告 | 赛事 | 比赛 |
|---|---|---|---|
| 民大 · 匹克球 `muc/pkb` | 5 | 3 | 14 |
| 民大 · 乒乓 `muc/tt` | 4 | 2 | 8 |
| 民大 · 羽球 `muc/bd` | 3 | 1 | 6 |
| 北航 · 匹克球 `buaa/pkb` | 4 | 2 | 8 |
| 北航 · 乒乓 `buaa/tt` | 2 | 1 | 3 |
| **合计** | **18** | **9** | **39** |

三层差异性（用户 10:30 补充口径）：

1. **不同协会**：公告 5 / 4 / 3 条、赛事 3 / 2 / 1 场，标题与分类各不相同且两两不重名；
   榜单各是各的（乒乓榜上是 u04 等，匹克球榜上是 u03 等）。
2. **不同演示账号**：比赛分给不同会员，场次与等级分不同。北航内部
   `demo_buaa_member` / `_member_2` / `_member_3` / `_leader` / `_college_leader`
   分别为 3 / 3 / 2 / 2 / 1 场。
3. **跨校**：北航新增 4 位演示账号（会员二 / 三、学院负责人、协会负责人），
   配齐北航自己的公告 / 赛事 / 比赛；民大身份读北航协会空间被拒（范围隔离生效），
   切到北航账号才读得到。

文档：`docs/mock演示账号.md` 新增第七节（规模表、差异说明、北航账号表、切换步骤、
改动须知）。

## 二、「民大春季杯」打不开 —— 确诊与修复

**现象**：mock 里点「民大春季杯男单赛」进详情，显示「这场赛事不存在或已被删除」。

**根因**：S2 编号形如 `sev:muc:pkb:spring-cup`，跳转方一律
`encodeURIComponent(eventId)` 拼 URL（变成 `%3A` 形式）。**query 值是否已解码取决于
运行环境**：Node 测试替身（`URLSearchParams`）解码一次，所以测试一直通过；
微信开发者工具 / 真机**原样透传**，详情页拿编码串去 `getById` → 查不到 → 报「不存在」。
（用真实 mock 复现两条路径，确认「未解码」时正是用户看到的这句话。）

**修复**：新增 `miniprogram/utils/route-query.js`：

- `routeIdCandidates(value)`：不含 `%` 时只有一个候选；含 `%` 时给
  `[原值, 解码值]`——**不无条件解码**，因为 `schoolKey` 复合键本身含 `%`，
  二次解码会把编号改坏；
- `resolveRouteId(value, probe)`：按候选顺序探测，命中即用。

接入点：

- `services/school-event-view.js`：赛事详情、名次录入两个装载器（`loadEventParts`
  用命中的真实编号）；
- `services/school-college-view.js`：名单提交 / 名单审核 / 学院赛详情 / 名次录入
  四个装载器（新增 `resolveCollegeEventId`）、排阵页（大场编号）、学院赛比赛页；
- `pages/match-entry`、`pages/live-score`：进页先解析 `matchId`。

回归测试：

- `tests/route-query.test.js`（新，6 条）：候选顺序、含 `%` 的编号不被解坏、
  非法百分号序列不抛错、探测命中与全未命中；
- `tests/school-event-view.test.js`（+2 条）：**未解码的 query 也能打开详情**、
  真正不存在的编号仍是 notFound、名次页同样兼容。

## 三、提交历史整理

- `git reset --soft 925010e9e3a1a4ad79053ae8cc7c453e1c85b0c3`（B3 登录与会话统一），
  撤回其后的 12 个提交，工作区内容一字未动；
- 文档中引用的这 12 个旧 hash 全部改为「本轮统一提交」等不依赖散列的说法
  （指南、账本、B4～B8 验收记录与切片文档）；
- B4～B8 全部成果 + 本次 mock 扩充、春季杯修复，合并为**一次本地提交**。

## 验证结果

- 全量测试（逐文件 `node --test-isolation=none --test`）：**2516 条通过，0 失败**
  （扩充前基线 2505；新增 6 条路由编号用例、2 条事件视图用例，并同步了演示条数断言）。
- `npm run check:cloud-sync`：55 个共享文件一致。
- `git diff --check`：通过。
- 同步更新的既有断言（因演示数据变多）：`school-demo-content`（18/9/39 与各范围规模）、
  `school-home-view`（民大首页汇总 12 公告 / 28 比赛 / 6 赛事）、
  `school-member`（北航名录 6 位）、`page.test.js`（北航榜单有真实流水、
  协会榜单各读各的、资料页性别显示）、`school-profile`（种子自带性别）。

## 未完成 / 说明

- 旧栈 `mock.js` 与 `association-flavor.js` 未改：各协会本就有 4 条不同公告与错开的
  起始日期，本轮差异性重点落在 S2 演示内容；且改 `SEED_OPTIONS.weeks/casualPerWeek`
  会动随机序列与默认协会判定，风险大于收益。
- 演示内容条数是「契约」，改动要同步上表与相关断言（已写入 `docs/mock演示账号.md` §7.5）。
- 依然没有真实云端 / 真机验收；不推送远程、不部署、不改真实数据。
