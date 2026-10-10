# 云函数部署说明

全站只有一个云函数，名为 `data`。前端把请求包成 `{ action, payload }`，
它按 action 分发。等级分不落库，每次读时从比赛流水重放出来——写操作只改
状态并把 `seasons.version` 加一，读操作发现版本变了才重算。

按下面九节做完，小程序就从本地模拟数据切到云端。**代码这边已经就绪，
部署需要你的云环境与微信开发者工具。**

---

## 一、开通云开发、拿到环境 ID

1. 微信开发者工具 → 云开发 → 开通（选按量付费的免费额度即可）。记下**环境 ID**，
   形如 `pickleball-1a2b3c`。
2. 把环境 ID 填进 `miniprogram/config.js` 的 `CLOUD_ENV_ID`：

   ```js
   const CLOUD_ENV_ID = 'cloud1-d7g9o5ift32b465d7';
   ```

   留空时小程序会自动退回本地模拟数据，功能仍可完整演示，只是数据存在内存里，
   关掉就没了。填上即走云端，页面代码一行都不用改。

3. 同时确认 `project.config.json` 的 `appid` 是你自己的小程序 AppID
   （`project.private.config.json` 里是个人的本地配置，已在 `.gitignore` 中）。

> 基础库需 ≥ 2.2.3（`wx.cloud` 从这版起提供）。`app.js` 的 `initDataSource()`
> 在基础库过旧时会打印明确的中文错误并继续用模拟数据，不会白屏。

## 二、部署云函数

> **改了代码就一定要重新部署。** 云函数不跟着小程序编译自动更新——只改
> `miniprogram/` 或 `cloudfunctions/` 却没点「上传并部署」，线上跑的还是旧包。
> 典型症状是新增的接口报 **`未知的操作：xxx`**：前端在调一个新 action，云端
> 的处理器表里却没有它。本项目全部接口都挤在这一个 `data` 函数里，它不更新，
> 新增的功能（学院赛的 `getCollegeEvents`、`publishCollegeEvent` 等）一律不生效。
>
> 判断依据：控制台 → 云函数 → `data` 的「更新时间」；改了代码没重新部署，
> 这个时间就不会变。

1. 在开发者工具里右键 `cloudfunctions/data` → **在终端中打开**，安装依赖：

   ```
   npm install
   ```

   `wx-server-sdk` 不进仓库，只在云函数目录本地装（镜像同步的是我们自己写的
   纯逻辑，与 SDK 无关）。

2. 右键 `cloudfunctions/data` → **上传并部署：云端安装依赖**。

   > 选「云端安装依赖」而非「所有文件」，这样 `node_modules` 不必上传。

3. 上传前若改过 `miniprogram/` 下的共享纯逻辑（详见第六节），先跑一次
   `npm run sync:cloud`，否则云端跑的还是旧算法；`npm run check:cloud-sync`
   可确认镜像没有漂移。
4. 部署要选对环境：必须是 `miniprogram/config.js` 里 `CLOUD_ENV_ID` 指向的
   那个环境（当前为 `cloud1-d7g9o5ift32b465d7`）。账号下有多个环境时传错环境，
   小程序连的仍是旧的。

## 三、建集合与索引

在云开发控制台 → 数据库里建 **11 个**集合（名称须完全一致）：个人赛 7 个，
学院赛 4 个。学院赛独立成体系，不与个人赛共用集合。

个人赛：

| 集合 | 用途 |
|---|---|
| `users` | 会员档案与入会申请（含 `openId`、`college`；等级分本身不存这里） |
| `matches` | 比赛流水，等级分的唯一来源（学院赛小场也写在这里） |
| `events` | 个人赛事 |
| `event_signups` | 赛事报名与签到 |
| `announcements` | 公告 |
| `seasons` | 赛季锚点与版本号，只会有 `_id = 'current'` 一条 |
| `rankings` | 排行榜快照，只会有 `_id = 'current'` 一条。它是**纯缓存**：删了会自动重算，写失败也不影响读 |
| `audit_logs` | 写操作留痕（当前不写入，可选） |

学院赛：

| 集合 | 用途 |
|---|---|
| `college_events` | 学院团体赛本体，与 `events` 平行 |
| `college_entries` | 各学院参赛名单，键为「赛事 + 学院」 |
| `ties` | 大场：两院之间的一轮对抗 |
| `lineups` | 大场排阵，键为「大场 + 学院」 |

索引（**权限选「仅创建者可读写」或「所有用户不可读写」，见第五节**）：

| 集合 | 字段 | 唯一 | 为什么 |
|---|---|---|---|
| `users` | `openId` | ✅ | 一个微信号只能有一个人，重复入会必须被挡在数据库层 |
| `matches` | `_id` | 主键 | 自然键当 `_id`，重复导入同一场比赛会撞主键而不是产生第二条 |
| `matches` | `status` + `matchTime` | — | 回放要按「已生效 + 时间」扫流水 |
| `matches` | `eventId` | — | 按赛事取比赛 |
| `event_signups` | `eventId` + `userId` | — | 查某场赛事某人是否报名 |
| `events` | `status` | — | 按状态筛选赛事 |
| `announcements` | `status` | — | 首页只取已发布的 |
| `college_entries` | `eventId` | — | 按学院赛查名单 |
| `ties` | `eventId` + `round` | — | 按赛事与轮次查大场 |
| `lineups` | `eventId` + `tieId` | — | 按赛事或大场查排阵 |

> **所有集合都是必建的**（含 `rankings`）。等级分仍以比赛流水为唯一事实
> 来源，`rankings` 只存一份「重放结果的落库缓存」：容器冷启动时先读它，
> 省掉全表读 + 两遍回放。它的键由赛季版本号 + 算法版本 + 锚点拼成，任何
> 写操作让版本号 +1，旧快照即作废；**读不到或读坏了都会退回现场重放**，
> 不会因为缺它而算错分数。少建它只会让每次读都重算（慢），不会报错。
>
> `event_signups` 与 4 个学院赛集合是**必建**的：报名 / 签到会写
> `event_signups`；学院赛的名单、大场、排阵分别写另外 4 个。少建任何一个，
> 对应步骤会直接报错。

## 四、创建第一个管理员（首次部署必做）

云端的权限是严格的：审核入会、发布赛事、抽签都要求 `role >= STAFF`，而
`role`、`status` 一律由服务端盖章，客户端递不上去。新注册的账号又都是
「待审核」，于是**没有第一个管理员，就没人能审自己**——后台一步都走不动。

所以第一个人要手工造。**推荐这么做**（字段最全，也最不容易填错）：

1. 用管理员的微信号在小程序里走一遍**注册**（注册页现在必选性别）。这条申请
   会以「待审核」出现在 `users` 集合里，`openId`、`gender`、`joinDate` 都是
   服务端填好的。
2. 到云开发控制台 → 数据库 → `users` 找到这条文档，改两个字段：

   | 字段 | 改成 | 含义 |
   |---|---|---|
   | `role` | `2` | 管理员（`ROLE.ADMIN`；填 `1` 是学院负责人，也能审核与办赛） |
   | `status` | `1` | 正常（`USER_STATUS.ACTIVE`；`0` 是待审核，登不进后台） |

改完刷新小程序即可，不用重传云函数。

也可以直接新增一条文档，但下面这些字段一个都不能少：

```json
{
  "_id": "u_admin",
  "openId": "该微信号的 OpenID",
  "nickName": "管理员",
  "realName": "真实姓名",
  "gender": "M",
  "studentId": "2023000001",
  "college": "体育学院",
  "phone": "13800000000",
  "role": 2,
  "status": 1,
  "joinDate": "2026-04-08T18:00:00"
}
```

> **`gender` 不是可有可无的展示字段，别省。** 它决定两件事：女会员的初始分比
> 男会员低 `genderInitialGap`（150）分（`utils/elo.js`）；男单榜 / 女单榜按它
> 过滤（`utils/leaderboard.js` 的 `buildProjectLeaderboard`）。**没有 `gender`
> 的账号会同时从两张单打榜上消失，界面上没有任何提示。** 走小程序注册的会员
> 不会遇到这个问题——注册页把性别设成了必填；只有手工插入的这条要自己记得补。

> **已经建好、但没有 `gender` 的账号**：在控制台给该文档加一个 `gender` 字段
> （`"M"` 或 `"F"`），保存后刷新即可，同样不用重传云函数。性别属于实名信息，
> 本人改不了（`services/profile.js` 的 `EDITABLE_FIELDS` 只有昵称与头像），
> 当前版本也没有管理端改性别的界面，所以补录只能在控制台做。

## 五、数据库安全规则

**等级分只允许云函数写**——靠的是客户端根本没有写入口，而不是靠规则。
但为了挡住绕过小程序直接调 SDK 的写，请把 **11 个业务集合全部** 的权限设为
**「所有用户不可读写」**（云函数以管理员身份运行，不受该规则限制）。

不要设成「所有用户可读」：那样任何人都能直接拉走全量会员与比赛数据。

## 六、共享逻辑镜像（`lib/`）

微信云函数是**按目录打包**的，`cloudfunctions/data/` 无法 `require` 目录以外的
文件。而等级分回放、比分校验这些纯逻辑住在 `miniprogram/` 里，云端必须用**同一份
实现**——两份各自手抄的算法迟早分叉，那时同一场比赛在两边的分数就对不上了。

所以 `tools/sync-cloud-lib.js` 按清单把纯模块复制进 `cloudfunctions/data/lib/`，
并保留 `utils/`、`services/` 的目录层级，让模块内部的相对 `require`
（如 `'../utils/constants.js'`）在镜像里原样成立。

```
npm run sync:cloud          # 生成 / 更新镜像（改完 miniprogram/ 下的纯逻辑后跑）
npm run check:cloud-sync    # 只校验不写入，漂移时退出码 1
```

镜像**提交进仓库**：开发者工具上传云函数时不会替你跑构建脚本，干净检出也要能直接
跑测试。`tests/cloud-lib-sync.test.js` 逐字节守着它——谁改了源文件却忘了同步，
测试立刻变红。

清单在 `tools/sync-cloud-lib.js` 的 `MANIFEST`，只收「纯模块」（不碰 `wx`、不碰
Node API、不做 I/O）。当前共 27 个文件，学院赛的纯逻辑（`college-event.js`、
`college-entry.js`、`college-draw.js`、`college-tie.js`、`college-lineup.js`）
与 `standings.js`、`permission.js` 都在其中。`seed.js`、`mock.js`、`*-store.js`、
`*-view.js`（含 `college-store.js`、`college-view.js`）都不上云。

## 七、赛季初始化

**通常什么都不用做。** 数据库里还没有 `seasons` 文档时，读接口按默认值工作
（`anchorTime: null`，即按流水里最早一场比赛定锚）。锚点在**首次写入时**落库，
此后不再重算——这样管理员撤销最早那场比赛，不会把一批创始会员重新判定成
中途入会者、静默改变多人的初始分。

只有一种情况需要手动介入：**导入历史比赛之前**先把锚点定死。否则首次写入可能
发生在历史数据导入的中间态，锚点会取到错误的日期。

若确实要手工初始化，在云开发控制台向 `seasons` 集合插入一条：

```json
{
  "_id": "current",
  "anchorTime": "2026-04-08T18:00:00",
  "version": 0,
  "algoVersion": 1
}
```

**`anchorTime` 要照抄赛季首场那条比赛的 `matchTime` 原文**，不要自己换算时区。
`tools/import-matches.py` 会把候选值原样打印给你（形如 `2026-04-08T18:00:00`），
直接复制即可。

> 为什么不做时区换算：比赛流水里的 `matchTime`、会员的 `joinDate` 都是**不带时区
> 后缀**的串，JS 按「运行时所在时区」解析。小程序跑在国内是 UTC+8，云函数容器
> 却可能是 UTC——同一个串在两处会解析成不同的瞬间。锚点只要和流水用同一种写法，
> 两边就按同一规则解析，误差自然抵消；一旦给锚点加上 `Z` 后缀，它和 `joinDate`
> 就站在了两个时区基准上，所有「中途入会」判定会整体偏移 8 小时。

> 改了 ELO 参数、K 值、积分规则或定级规则时，把 `algoVersion` 加一，
> 否则容器里缓存的旧结果会被继续沿用——改了算法却不生效。

## 八、导入历史成绩

导入用 `tools/import-matches.py`，与云函数无关，但产出的 JSON 就是要写进
`matches` 集合的文档。步骤：

1. 按 `tools/匹克球比赛导入模板.xlsx` 整理成绩（比分用 `11:9,11:7` 形式）。
2. 先跑一次拿候选赛季首场时间：

   ```
   python tools/import-matches.py 成绩.xlsx 输出.json --report 问题行.xlsx
   ```

   标准输出会打印 `共 N 行，通过 M 行，问题 K 行` 与「已导入比赛中最早的一场」。
   问题行为空才继续。

3. 按第六节把 `seasons/current` 的 `anchorTime` 定死。
4. 用控制台的「导入」功能把 JSON 写进 `matches` 集合。

导入的文档 `_id` 是按（项目、双方阵容、比分、时间、录入人）算出的自然键，
**同一张表导入两次不会产生两份记录**——等级分是零和的，重复计分会把同一个人
算两次，这条是硬性要求。`tests/importer-contract.test.js` 在 Node 侧逐条复查
Python 算出的 `_id` 与云端 `matchNaturalKey` 是否逐字节一致。

## 九、回包契约（改云函数时别破坏）

```
{ ok: true,  data }        正常。业务失败也在 data 里：{ ok: false, match: null, errors, message }
{ ok: false, message }     仅基础设施故障：未知 action、调用者无档案、payload 结构错误、数据库异常
```

前端 `services/cloud.js` 只要顶层 `ok !== true` 就抛错；而模拟数据源的写接口在
业务失败时是**正常 resolve** 出 `{ ok:false, ... }`。所以业务失败**必须**包在顶层
`ok:true` 里，否则页面行为会从「拿到失败对象」变成「抛异常」，两条数据源就此分叉。
