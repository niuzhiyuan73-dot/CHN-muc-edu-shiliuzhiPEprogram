# 云函数部署说明

全站只有一个云函数，名为 `data`。前端把请求包成
`{ protocolVersion: 2, schoolId, association, action, payload }`，它按 action 分发到
`src/core/school-*-handlers.js`（共 170 个动作，四组：会员 13 / 协会空间与个人赛 89 /
跨校 15 / 运动会 53）。

等级分**在确认比分时逐场结算并落库**（`member_ratings` + `rating_counters` 序号），
不再每次读时全量回放；`rankings` 是已退役的旧回放缓存，不必建。

> 运营侧的日常操作（审核会员、调角色、换赛季、救急）见 [云开发控制台操作指南](../docs/云开发控制台操作指南.md)，
> 本文只讲部署。

---

## 一、开通云开发、拿到环境 ID

1. 微信开发者工具 → 云开发 → 开通。记下环境 ID。
2. 填进 `miniprogram/config.js` 的 `CLOUD_ENV_ID`：

```js
const CLOUD_ENV_ID = 'cloud1-xxxxxxxxxxxx';
```

留空时小程序自动退回本地模拟数据，功能完整但存在内存里，关闭即失效。

3. 确认 `project.config.json` 的 `appid` 是自己的；`project.private.config.json` 是个人配置，已在 `.gitignore`。

> 基础库需 ≥ 2.2.3。`app.js` 的 `initDataSource()` 在版本过旧时会给出中文提示并继续用模拟数据。

## 二、同步共享库，再部署

微信云函数按目录打包，`require` 不出目录；而计分、校验、抽签这些纯逻辑住在
`miniprogram/` 里，云端必须用**同一份实现**。所以：

```bash
npm run sync:cloud        # 按 MANIFEST 复制到 cloudfunctions/data/lib/（当前 75 个文件）
npm run check:cloud-sync  # 只校验不写入；漂移时退出码 1
```

镜像**提交进仓库**，`tests/cloud-lib-sync.test.js` 逐字节守着。只收纯模块（不碰 `wx`、
不做 I/O）；`seed.js`、`mock.js`、`*-store.js`、`*-view.js` 都不上云。

部署：

1. 右键 `cloudfunctions/data` → 在终端中打开 → `npm install`（`wx-server-sdk` 不进仓库）。
2. 右键 →「上传并部署：云端安装依赖」。
3. 确认部署到 `CLOUD_ENV_ID` 指向的环境。

> **改完代码一定要重新部署。** 云函数不随小程序编译更新。漏部署的典型症状是
> 「该操作尚未支持学校范围」（前端在调一个新 action，云端处理器表里没有）。
> 判断依据：控制台 → 云函数 → `data` 的「更新时间」。

## 三、建集合（53 个）

名称须与 `miniprogram/utils/constants.js` 的 `COLLECTION`、`cloudfunctions/data/src/repository.js`
的 `COLLECTIONS` 完全一致。按域分组：

| 域 | 数量 | 集合 |
|---|---|---|
| 学校与身份 | 6 | `schools`、`school_associations`、`colleges`、`school_members`、`school_roles`、`student_id_claims` |
| 账号与角色 | 2 | `users`、`memberships` |
| 比赛与等级分 | 4 | `matches`、`member_ratings`、`rating_counters`、`pair_counts` |
| 个人赛与公共 | 5 | `events`、`event_signups`、`seasons`、`announcements`、`audit_logs` |
| 学院赛 | 4 | `college_events`、`college_entries`、`ties`、`lineups` |
| 实时计分 | 1 | `live_scores` |
| 团队运动（篮球） | 6 | `teams`、`team_members`、`team_events`、`team_event_entries`、`team_matches`、`team_match_stats` |
| 协会空间 | 5 | `association_groups`、`association_group_members`、`association_notices`、`association_trainings`、`training_registrations` |
| 跨校邀请赛 | 4 | `exchange_events`、`exchange_invitations`、`exchange_signups`、`exchange_matches` |
| 运动会 | 15 | `sports_meets` 及其 `_events` / `_colleges` / `_interests` / `_entries` / `_sessions` / `_judge_assignments` / `_scores` / `_publications` / `_result_rows` / `_quota_usage` / `_standings` / `_honors` / `_participant_claims` / `_college_leads` |
| 已退役 | 1 | `rankings`（旧回放缓存，代码不再读写；建了也不用，可以不建） |

> **`member_ratings` 与 `rating_counters` 是必建的**（Elo 逐场结算改造新增）。
> 历史上曾因「等级分回放、不落库」而删掉过 `member_ratings`，那一版已经过去，
> 现在缺这两个集合会在确认比分时直接报「集合不存在」。
>
> `live_scores`、`pair_counts`、以及 15 个运动会集合同样是硬依赖。
> `announcements` 是公共公告（首页与公告中心），与协会内部的 `association_notices` 各自独立。

索引（权限见第四节）：

| 集合 | 字段 | 唯一 |
|---|---|---|
| `users` | `openId` | ✅ |
| `matches` | `schoolId` + `association` + `status` | — |
| `matches` | `eventId` / `collegeEventId` / `tieId` | — |
| `member_ratings` | `schoolId` + `association` | — |
| `school_members` / `school_roles` / `colleges` | `schoolId` | — |
| `memberships` / `association_*` / `exchange_*` / `pair_counts` | `schoolId` + `association` | — |
| `sports_meet_*` | `schoolId` + `meetId` | — |
| `event_signups` | `eventId` + `userId` | — |
| `college_entries` / `ties` / `lineups` | `eventId`（大场再加 `round`，排阵再加 `tieId`） | — |

> 学校维度的记录一律用确定性复合 `_id`（`utils/school.js` 的 `schoolKey`），
> 按主键点读最省事；上面这些联合索引服务于「取一批」。

## 四、安全规则

把每个业务集合的权限设为**「所有用户不可读写」**：

```json
{ "read": false, "write": false }
```

云函数以管理员身份运行，不受影响。不要设成「所有用户可读」——那等于公开全量会员与比赛数据。

## 五、建学校、协会与第一个管理员

```json
// schools
{ "_id": "muc", "schoolId": "muc", "name": "中央民族大学", "status": "active" }

// school_associations —— 每个启用的协会一条（pkb / tt / bd / tn）
{ "_id": "sa:muc:pkb", "schoolId": "muc", "association": "pkb", "status": "active" }
```

`colleges` 需要该学校 26 所学院，名字与 `constants.COLLEGES` 完全一致（学院名是学院赛的对阵主键）。

第一个管理员：

1. 用管理员微信在小程序注册（写 `users` + `school_members`，均为待审核）。
2. `users`：`role` → `2`，`status` → `1`。
3. `school_members`（`_id = sm:<schoolId>:<userId>`）：`status` → `1`。
4. `school_roles` 插 `{ "_id": "sr:muc:<userId>", "schoolId": "muc", "userId": "<userId>", "role": "schoolAdmin" }`。
5. 重开小程序。

> 只改 `users.role` 不改会籍状态，会出现「设了管理员还是没权限」。
> `gender` 不可省：它决定女性起评分低 150 分，也决定单打榜的男女分组——缺了会静默从两张榜上消失。

## 六、赛季

不需要手工初始化。`seasons` 里没有该范围（`_id = <schoolId>:<association>`）的记录时，
读接口按默认第一赛季工作。

赛季更新只能调云函数（小程序无入口）：

```json
{ "protocolVersion": 2, "schoolId": "muc", "association": "pkb", "action": "resetSchoolSeason", "payload": {} }
```

它只写下分界时刻并让赛季号 +1：赛事 / 训练积分从零开始，**等级分不变**（评级跨赛季连续）。

> 起评分是**固定**的（男 1450 / 女 1300），不再按「赛季锚点 + 首场时间」追溯定级，
> 所以旧文档里「先把 `anchorTime` 定死再导入历史数据」的做法已不适用。

## 七、导入历史成绩（先读再动）

`tools/import-matches.py` 把历史 Excel 转成 `matches` 文档，自然键与云端
`idempotency.matchNaturalKey` 一致（重复导入不会产生两条）。

**风险**：它产出的记录是 `status=1`（已生效），**不经过结算链**。直接灌进 `matches` 的结果是
「比赛在列表里，但评级表里没有对应结算，等级分不变」。

推荐：优先在小程序补录；确需批量导入，先确认是否一并生成 `member_ratings` 结算与
`rating_counters` 序号，并在测试环境验证评级变化、序号递增、列表可打开。

## 八、回包契约（改云函数时别破坏）

```
{ ok: true,  data }        正常；业务失败也在 data 里：{ ok: false, message, ... }
{ ok: false, message }     仅基础设施故障：未知 action、无档案、payload 结构错误、数据库异常
```

前端只要顶层 `ok !== true` 就抛错。业务失败必须包在顶层 `ok:true` 里，否则页面行为会从
「拿到失败对象」变成「抛异常」，两条数据源就此分叉。

## 九、时区

云函数入口在模块加载时把 `process.env.TZ` 钉成 `Asia/Shanghai`（未显式配置时），
`config.json` 里也可设 `TZ=Asia/Shanghai`。客户端一律发送 ISO 绝对串；
控制台直写 naive 串会重新引入 8 小时偏移。
