# 第六轮 D：目录读取收窄验收记录

## 一 元信息

- 日期：2026-10-26（晚，第四批）。
- 基线：`f5f39e6`（第五轮 B 已提交，工作区干净，镜像 91 一致）。
- 开工基线：**183 文件 / 3046 用例 / 0 失败 / 27.5s**。
- 来源：第五轮排查清单的 D 项——`buildDirectory` 每次读全校名册 + 全量账号。
- 范围：`school-actor.js`（两个新读法）、`school-event-service`、`school-match-service`、`school-rank-service`、`team-event-service` 共 8 处调用点、1 个新用例文件。

## 二 本批完成

| 调用点 | 原来要什么 | 现在怎么读 |
|---|---|---|
| `startSchoolEvent` / `finishSchoolEvent` | 只把目录喂给身份闸（`legacyActorOf` 只取 `actorCollege`） | `actorDirectory(ctx)`：一次点读学院名 |
| `resetSchoolSeason` | 同上 | `actorDirectory(ctx)` |
| `checkInSchoolEvent` | 「目标会员 + 操作者」两个人的学院 | `userDirectory(ctx, [userId])`：学院目录 1 页 + 两人学籍一次批读 |
| `transition`（确认/开始/驳回比分） | 这场比赛两队的参赛者学院 | `recordDirOf(ctx, snapshot)`：2~4 人点读 + 学院点读 |
| `assignSchoolMatchReferee` | 同上（`matchSummary` 要 `collegeOf`） | 同上 |
| `forfeitSchoolMatch` | 只取 `recordOptions(...).role`，而 role 来自 `legacyRoleOf(ctx)` | `EMPTY_RECORD_DIR`：**零读** |
| `listTeamEvents` | 只取 `collegeIdOf(ctx.actorId)` | 直接用 `ctx.schoolMember.collegeId`：**零读** |

调用点数：`buildDirectory` 23 → **15**。按 2000 人的学校算，每次调用从约 40 页 RPC 降到 0~6 次。影响最大的是 `transition` 与 `forfeitSchoolMatch`——它们**每确认/弃权一场**都走一遍。

## 三 关键口径

1. **`actorDirectory` 只解析操作者自己，别人的学院一律空串。** 空串在旧栈判定里等于「不同学院」，是**收紧**不是放行。需要别人学院的地方（代签、指派、判分）必须用 `userDirectory` / `recordDirOf`，这条写进了函数注释与用例。
2. **`checkInSchoolEvent` 不能用 `actorDirectory`。** `canCheckIn` 把「目标学院为空」当作「未指定目标」直接放行——而注释里那句「始终带上目标学院，避免学院边界被放行」正是为这个分支写的。用 `actorDirectory` 会给目标空串，等于把学院边界放开一个口子；所以这里用 `userDirectory`（不做「操作者无学院就短路」）。
3. **`recordDirOfUsers` 改成 `userDirectory` 的薄包装，短路语义保留。** 判球路径的短路是对的（同学院判定必然不成立），代签/指派的短路是错的——两者共用一个实现，但入口分开、语义写在名字上。
4. **15 处仍读全校名册，是「真的要花名册」。** 抽签按性别种子（`drawSchoolEvent`）、录入表单的候选人（`getSchoolMatchEntryContext`）、球队成员姓名（`team-service` 六处、`team-event-service` 五处）。这些要的是「全校在册会员」本身，收窄会改变语义。

## 四 踩坑与纠正

1. **差点把 `actorDirectory` 用到代签路径上。** 一开始按「只喂给 `legacyActorOf`」的规则归类，`checkInSchoolEvent` 看着也符合；读 `canCheckIn` 才发现目标学院为空会**放行**。这类「返回空值 = 权限放开」的分支是权限改造里最危险的一种，所以本轮给两个新读法起了区分明显的名字，并把理由写进注释和用例。
2. **`transition` 需要比赛文档才能算参与者学院**，而文档原本只在事务内读。现在事务外先点读一次（1 次），换来「40 页 → 5 次」的净减少；事务内仍重读一次做权威判定，顺序没有变（判权仍在事务内）。
3. **新用例第一版断言太弱**（只断言 `typeof === 'string'`），等于没验证解析是否真的发生。改成断言演示数据里的真实学院名（`中华民族共同体学院`），这样「短路返回空串」的实现会红。
4. **探针这次没踩坑。** 前两轮都在「让 `.list()` 抛错」上翻过车（mock 的 `listByStatus` / `listByProject` 内部会调 `list()`）。这次确认内存仓储的 `listByIds` 走的是 **base 仓储**的 `list`，不是 `forScope` 表面上的 `list`，所以只封 forScope 表面的 `list` 是安全的——避开方法名相同、实现路径不同的那一类误伤。

## 五 验证结果

```text
npm test                  → 184 文件 / 3049 用例 / 通过 184 / 失败 0 / 超时 0 / 27.6s
npm run check:cloud-sync  → 云函数共享库已同步，共 91 个文件
node tools/acceptance-audit.cjs → probes 5 / failed 0
doc-audit --cases=3049    → 0 差异（25 条断言）
```

## 六 部署前必做

1. `npm run sync:cloud`（已跑）→ **重新部署 `data` 云函数**（`school-actor.js` 与四个 service 都在共享库里）。
2. **无新增索引**：只改了读法，没有新增查询条件字段。
3. 无数据回填。

## 七 未完成及原因

| 项 | 结论 | 触发条件与将来怎么改 |
|---|---|---|
| `submitSchoolMatch` 的 `activeMemberIds` | **暂不动** | 它把「在册且账号可用」的名单交给 `buildMatchRecord` 做资格校验；要收窄就得先按参赛者编号查在册状态，而现有原语里没有「给一批 id 返回其中在册的」这一形态。**收益 40 RPC/次，风险是松开资格校验**（把停用会员的编号收进来），权衡后不动。触发：录分提交出现性能投诉，或补上 `schoolMembers.listByIds` + 账号状态的组合原语 |
| 其余 14 处 `buildDirectory` | 保留 | 都需要真实花名册（抽签种子、录入候选人、球队成员姓名）。真正的解法是「按队 / 按项目取成员」，属另一类改造 |
| `getSchoolMatchEntryContext`（392） | 保留 | 录入表单要列出可选会员与性别；可收窄到「本赛事报名者」，但会改变「管理员可代任意会员报名」的现有口径 |

## 八 回归与反向验证

- **探针式回归**：`tests/actor-directory-scope.test.js` 把 `forScope(...).schoolMembers.list` 换成抛错，再跑 `resetSchoolSeason` + `listTeamEvents`——任何退回整表读的实现当场红。
- **语义回归**：`userDirectory` 的用例断言目标会员的**真实学院名**，短路返回空串会红；`actorDirectory` 的用例反过来断言「别人的学院是空串」，防止有人把它当通用目录用。
- **既有行为**：`school-match.test.js`（11 文件 / 263 用例）、`school-event` 系列、`school-rank`、`team-event` 系列全绿——`transition` / 弃权 / 指派 / 代签的权限判定没有被削弱。

## 九 文档同步

- `README.md`、`docs/交接说明.md`（docx 已重建）、`docs/AI接手与后续施工指南.md`：测试基线 3046 → 3049（183 → 184 文件）。
- `docs/施工切片账本.md`：追加本批一行。
- 索引清单无需改动（没有新增查询条件）。
- `doc-audit.js --cases=3049 --frozen-check --links`：25 条断言 0 差异、冻结文档零改动、链接可达。

## 十 队列收尾

账本追加行：

```markdown
| 第六轮 D | `buildDirectory` 收窄：新增 actorDirectory / userDirectory，8 处调用点改为点读（23 → 15 处） | **已完成** | 基线 `f5f39e6` / [验收](第六轮D-目录读取收窄-验收记录.md) |
```
