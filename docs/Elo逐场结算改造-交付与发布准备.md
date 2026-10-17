# Elo 逐场结算改造：交付与发布准备

完成日期：2026-10-17。实施依据：`docs/Elo逐场结算改造-AI实施交接.md`。提交序列：`6ab0515`（阶段B）→ `f733c37`（阶段C）→ `b34239c`（阶段D）→ 本批（阶段E+F，提交号以 `git log -1` 为准）。

## 一、改造结果（对照交接文档 §13 完成定义）

- [x] 当前 Elo 及完整评级状态持久化（member_ratings），在确认事务中逐场更新。
- [x] 每场只有一次最终结算决定：计分场带结算快照（players 赛前/赛后分链），弃权与学院赛双打写 excluded 快照并注明原因，不占序号。
- [x] 共享选手并发（内存仓储串行队列 + 云端事务冲突重试）、事务失败回滚、请求重试均不会错分；防重以比赛上的 `settlement.id` 为准，与请求 ID 无关。
- [x] 所有在线成绩读取（榜单 / 会员成绩 / 个人主页）脱离全量回放：评级点读评级表，历史与走势读结算快照。
- [x] 已生效比赛撤销与间接修改路径全部关闭（服务端 action、白名单、门面、UI 按钮一并移除）；待确认驳回保留。
- [x] 固定起评分（男 1450 / 女 1300，管理员预设 initialElo 仅首次建档生效）、结算顺序（范围级 settlementSeq）、补录语义（按当前位置入链、不倒退 lastMatchTime、占当前提交赛季额度）落地。
- [x] 赛事积分与训练积分独立聚合（school-points-service），个人战绩、走势、交锋、搭档、荣誉、签表晋级全部可用。
- [x] 旧回放源文件（replay.js 及镜像）、孤儿模块（elo-store、member-review「改当前分」孤儿链）与退役工具（singles-experiment）已删除；rating-cap 的链序比较器提取为 match-order.js，无双轨。
- [x] 演示数据与测试夹具遵循新结算规则（school-seed 经同一纯结算内核重建）。
- [x] 云端镜像一致（58 文件），测试如实记录（见 §四）。

## 二、数据库集合与键（部署日需在云开发控制台新建两个集合）

| 集合（物理名） | 逻辑名 | 主键 `_id`（确定性键） | 内容 |
| --- | --- | --- | --- |
| `member_ratings` | memberRatings | `mr:<schoolId>:<association>:<userId>:<pool>`（schoolKey 编码） | 每「学校+协会+用户+池」一条：elo / startElo / startSource / matchCount / wins / losses / lastMatchTime / lastSettledAt / lastSettlementSeq / lastLedgerId / version / algorithmVersion='elo-v2' |
| `rating_counters` | ratingCounters | `mrseq:<schoolId>:<association>` | 每范围一条：seq（结算序号，事务内原子递增）、lastMatchId |

- 两个集合都已加入 `forScope` 的归属校验（SCHOOL_COLLECTIONS + SCOPED_COLLECTIONS），跨范围读不到也写不进。
- **索引**：当前读取路径只按 `_id` 点读与 `memberRatings.listByScope`（schoolId+association 等值查询）。如控制台支持，为 `member_ratings` 建 `(schoolId, association)` 组合索引即可；不假定其它组合索引可用。
- **写权限**：评级表只允许云函数（服务端）写——评级只由 `settleMatchInTransaction` 在事务内更新；客户端无任何直接写评级入口，也不要授予。
- 不引入 `users.elo` 全局字段；Elo 表主键不含 seasonId（评级跨赛季连续）。

## 三、部署与重建

1. **云函数同步部署**：源代码在 `miniprogram/`，`cloudfunctions/data/lib/` 是逐字节镜像（`tests/cloud-lib-sync.test.js` 守护）。部署前 `node tools/sync-cloud-lib.js`，再 `npm run check:cloud-sync` 确认一致，然后按既有流程上传 `data` 云函数。
2. **集合创建**：控制台新建 `member_ratings`、`rating_counters`（其余集合不变）。集合不存在时读路径会以「-502005 集合不存在」响亮报错，不会静默当空。
3. **模拟数据重建**：`school-mock.reset()` 重建演示内容；演示比赛由 `school-seed.js` 内部经**同一个纯结算内核**（materializeRatings + computeSettlement）按发生时间逐场结算，评级文档随 `content.memberRatings` 落种子。导入工具路径同源：导入的 ACTIVE 文档必须经受控结算（见 `tests/importer-contract.test.js`），不得绕过。
4. **真实云端验收（尚需环境操作，本地未验）**：
   - 真实事务冲突与重试（两个并发确认共享选手）只能在真机/云端验证；内存仓储已模拟串行化与冲突，但 SDK 行为需实机确认。
   - 云函数事务写预算（TX_WRITE_BUDGET，默认 200）：一场结算的写入 = 评级 2–4 条 + 序号 1 条 + 比赛 1 条 + 审计 1 条 ≈ 5–7 写，远低于预算。
   - 首次部署冒烟：确认一场比赛 → 检查 member_ratings 文档与比赛 settlement、再确认第二场验证 seq 递增与幂等重试。

## 四、验证结果（如实记录）

- `npm test`：**2161 / 2161 通过，0 失败**。数量变化：阶段D收口时 2236；本批删除 `tests/replay.test.js`（旧引擎专测）与 `tests/season-anchor.test.js`（追溯定级锚点，语义已随「固定起点」废除），改造 stats / training-points / importer-contract / cloud-lib-sync / member-review / bug-regressions 六个文件的旧引擎夹具为结算内核夹具。数学沿用、池隔离、scope 隔离、并发/回滚/幂等、补录/额度/赛季等行为守卫全部由 `tests/school-rating-service.test.js` 与改造后的各套件承接，无行为守卫缺口。
- `npm run check:cloud-sync`：58 个文件一致（新增 match-order.js / school-points-service.js，移除 replay.js）。
- `npm run test:py`：34 / 34 通过（导入工具未改行为，仅其契约测试改用结算内核）。
- 旧链路残留搜索：`replaySeason|runReplay|planInitialRatings|eloOverrides|currentEloByAssoc` 在 miniprogram / cloudfunctions / tools **零命中**；`revokeSchoolMatch|revokeExchangeScore|revertMatchResult|revertLegResult` 仅存于解释性注释。

## 五、已知取舍与说明

- **范围序号串行**：同范围的确认在 rating_counters 文档上串行竞争（当前规模可接受，交接文档 §4.2 记录在案）。
- **excluded 不占序号**：不计分比赛不进 Elo 链，快照 settlementSeq 为 null。
- **pointDelta 挂载**：赛事积分挂在该用户该赛事结算序号最大的一场（派生展示位，不改不可变快照）。
- **管理员当前评级调整**：协议 1 的「改当前分」孤儿链（elo-store / currentEloByAssoc）已删除；若产品需要，将来按交接文档 §5.3 以 adjustment 记录重新实现（带审计、复用范围序号）。
- **交流赛**：不纳入个人 Elo；已确认比分不可撤销。
