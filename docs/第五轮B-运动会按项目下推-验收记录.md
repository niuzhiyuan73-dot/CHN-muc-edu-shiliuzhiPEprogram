# 第五轮 B：运动会按项目下推验收记录

## 一 元信息

- 日期：2026-10-26（晚，第三批）。
- 基线：`70f6412`（第五轮 A/C/E 已提交，工作区干净，镜像 91 一致）。
- 开工基线：**183 文件 / 3045 用例 / 0 失败 / 28.6s**。
- 来源：第五轮排查的 B 项——运动会域「读一届全部再按 `eventKey` 过滤」共 45 处。
- 范围：`school-repository.js` / `school-memory-repo.js`（`listByProject` 扩到 7 个集合）、5 个 `meet-*-service.js` 的 33 处调用点、1 条新用例、4 条索引。

## 二 本批完成

| 问题 | 最终实现 | 回归位置 |
|---|---|---|
| `listByProject` 只覆盖报名与场次 | 扩到 7 个集合：报名 / 场次 / 意向 / 成绩 / 发布快照 / 裁判指派 / 结果明细——**它们的文档全部带 `eventKey`** | `tests/meet-repo-contract.test.js`（方法面） |
| 晋级：抽签/晋级/编排/判胜/重抽 6 个动作读整届 | 全部改 `listByProject(eventKey)`；`setMeetMatchWinner` 先点读场次、再按**场次文档里的** `eventKey` 取同项目场次 | `tests/meet-progression.test.js`、`tests/bracket.test.js` |
| 成绩：预览/发布/已发布结果读整届 | 同上；`listMeetPublishedResults`（全届公示）保持整届，理由见 §三.3 | `tests/meet-score.test.js`（新增「按项目下推」） |
| 赛程：事件场次清单与「我的任务」读整届 | 事件清单按项目取；「我的任务」改 `listByJudge(ctx.actorId)`（现成原语） | `tests/meet-judge-assign.test.js` |
| 报名池：某项目的意向读整届 | `sportsMeetInterests.listByProject(eventKey)` | 同「按项目下推」用例 |
| 改赛制：读整届场次与快照 | `listByProject(eventKey)` | `tests/meet-procedure.test.js` |

效果：六集合的整表读 **45 处 → 12 处**（其余 7 处涉及学院目录/总榜/荣誉，本就是跨届聚合）。

## 三 关键口径

1. **七个集合共用一个原语，不新增概念。** `listByProject(eventKey)` 就是 `where({...meetScope, eventKey})`。之所以不叫 `listByEvent`：运动会的 `sportsMeetEvents` 是「比赛项目」，而协会侧的 `listByEvent` 指的是「一场赛事」，同名不同义会让仓储契约扫描把两者混为一谈。
2. **`eventKey` 一律取自刚点读出来的文档，不取入参。** `setMeetMatchWinner` 只收 `sessionKey`，项目编号从场次文档读——入参里的 eventKey 是客户端可控的，用它拼查询等于把范围校验交给调用方。
3. **留下 12 处整表读，是「页面本来就跨全部项目」，不是漏改。** 逐条登记：
   - 学院报名工作台（`listMeetCollegeEvents`）：一次列出**所有项目**的已报/上限/待审/意向；
   - 名单管理（`listMeetEntries`）：管理员看全届进度；
   - 赛程页（`getMeetSchedule`）：所有项目的场次与裁判；
   - 成绩公示（`listMeetPublishedResults`）：一次读全届，替代「120 个项目各调一次」；
   - 结束运动会（`finishSportsMeet`）：要判「哪些项目还没发布」；
   - 概览计数（`getSportsMeet`）：每个项目各收了多少人。
   这些接口的输入里没有项目编号，收窄就改变了语义；真正的解法是分页或聚合计数，属于另一类改造。
4. **结果明细能下推，是因为写入时就落了 `eventKey`**（`writeMeetResultDetail` 的文档含 `schoolId/meetId/eventKey/publicationKey/version`）。这条在补索引前先核对过，否则下推会查空。

## 四 踩坑与纠正

1. **`setMeetMatchWinner` 原来是「场次 + 全届场次 + 项目」三个并发读。** 想按项目取，就必须先知道项目——改成先用 `sessionKey` 点读场次（1 次），再按它的 `eventKey` 取同项目场次。多了一次串行 RPC，但换来「从读 120 场变成读几场」。
2. **回归用例又踩了同一个坑：拿「让 `.list()` 抛错」当探针。** 内存 mock 的 `listByProject` 内部就是 `list()` + 过滤（与云端真条件查询不同构），探针会打到自己。改成「记录 `forMeet` 表面上调用了哪些方法」——这个断言对两种实现都成立。第五轮 C 已经踩过一次，这次直接按同样写法做，不再试错。
3. **新用例第一次跑发布失败：「还有 2 条参赛记录没有收齐裁判成绩」。** 发布是**整场校验**（缺一个人的分就不发），我一开始只给一个学院录了分。改成三个学院 × 三名裁判全部收齐——这条也说明了为什么发布必须在服务端整场判，而不是「有多少发多少」。

## 五 验证结果

```text
npm test                  → 183 文件 / 3046 用例 / 通过 183 / 失败 0 / 超时 0 / 27.5s
npm run check:cloud-sync  → 云函数共享库已同步，共 91 个文件
node tools/acceptance-audit.cjs → probes 5 / failed 0
doc-audit --cases=3046    → 0 差异（25 条断言）
```

## 六 部署前必做

1. `npm run sync:cloud`（已跑）→ **重新部署 `data` 云函数**。5 个 service 都在共享库里；漏部署的症状是运动会各页读量不变。
2. **新增 4 条索引**（见索引清单 §2.2）：`sportsMeetScores`、`sportsMeetPublications`、`sportsMeetJudgeAssignments`、`sportsMeetResultRows`，字段都是 `schoolId + meetId + eventKey`。不建则下推无效，退回整届扫。
3. 无数据回填：`eventKey` 一直在写，只是此前没有按它查。

## 七 未完成及原因

| 项 | 结论 | 触发条件与将来怎么改 |
|---|---|---|
| D `buildDirectory` 读全校名册（约 20 个调用点） | 未做，**下一批** | 拆成 `memberLookup(ctx, ids)` 与全量 `buildDirectory`。触发：无（排定中） |
| 学籍的「学校级按编号批读」入口（第五轮 E 留下的半项） | 未做 | 需要动 `attachSchoolRepository` 的分层（`forSchool(schoolId)` 或给顶层加带范围的 `listByIds`）。当前 E 的收益是 `3N → N+2`（N ≤ 20），补这一层的收益约 18 次读；权衡后不与本批混做，避免为一个小收益引入新的分层概念 |
| 12 处跨项目的整表读 | 只登记 | 解法是分页或聚合计数（例如「每个项目的报名数」用 `count` 而不是读文档）。触发：某届项目数 × 名额明显上涨，或赛程页打开变慢 |
| 篮球判分每次重写整份统计文档 | 只登记 | 数据模型使然，见第五轮验收记录 §七 |

## 八 回归与反向验证

- **契约面**：`meet-repo-contract` 的 `PROJECT_SCOPED` 清单从 3 个扩到 7 个，两端方法面逐字比对；单边缺失即红。
- **行为面**：新用例断言 `getMeetResultPreview` / `getPublishedResults` / `getMeetApplicantPool` 三条路径上「六集合的 `.list()` 一次都没被调用」，且有 `listByProject` 被用到。只断言返回对不对的话，退回整届读照样绿。
- **范围来自文档而不是入参**：`setMeetMatchWinner` 的改造显式写在注释里；`eventKey` 取自刚点读的场次。

## 九 文档同步

- `docs/数据库索引清单.md`：§2.2 新增 4 条运动会 `schoolId+meetId+eventKey`。
- `README.md`、`docs/交接说明.md`（docx 已重建）、`docs/AI接手与后续施工指南.md`：测试基线 3045 → 3046。
- `docs/施工切片账本.md`：追加本批一行。
- `doc-audit.js --cases=3046 --frozen-check --links`：25 条断言 0 差异、冻结文档零改动、链接可达。

## 十 队列收尾

账本追加行：

```markdown
| 第五轮 B | 运动会 `listByProject` 扩到 7 个集合，33 处「读一届」改按项目下推（45 → 12 处，余下均为跨项目聚合） | **已完成** | 基线 `70f6412` / [验收](第五轮B-运动会按项目下推-验收记录.md) |
```
