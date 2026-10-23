# 石榴籽项目 skill 速查

五份 skill 都在 `.workbuddy/skills/`，随代码入库。本文件供人查，不自动注入上下文。

| skill | 一句话 | 何时加载 |
|---|---|---|
| `shilzi-construction-guard` | 施工总纲：分层、镜像、路由、权限、容量、样式、运行时禁区、验证矩阵 | **任何代码改动前**（其它 skill 的前置） |
| `shilzi-page-work` | 页面新增/迁移：分包归属、四件套、主题、五态、装配测试 | 改 `miniprogram/**` 里的页面 |
| `shilzi-cloud-action` | 云函数 action：白名单注册、信封、双端仓储、事务预算、索引 | 改 `cloudfunctions/**` |
| `shilzi-acceptance-doc` | 收尾留痕：十段验收记录、账本追加、docx 构建 | 一批活儿做完 |
| `shilzi-doc-sync` | 文档同步：真值计算、数字校对、冻结检查、链接检查 | 每批收尾，或怀疑文档过期 |

## 触发词表（按你可能会说的话查）

### 动手类

| 你可能会说 | 命中 |
|---|---|
| 改石榴籽 / 动这个项目 / 加个功能 / 改个规则 | construction-guard |
| 这个项目怎么改 / 从哪下手 / 第一次看这个项目 / 接手 | construction-guard |
| 加个页面 / 做个页面 / 写个界面 / 页面改版 | construction-guard + page-work |
| 迁移页面 / S2 迁移 / 页面重构 | construction-guard + page-work |
| 加接口 / 新增 action / 改接口 / 下线接口 | construction-guard + cloud-action |
| 加个仓储方法 / 仓储原语 / 双端实现 | construction-guard + cloud-action |

### 排错类

| 你可能会说 | 命中 |
|---|---|
| 白屏 / 真机报错 / process is not defined | construction-guard |
| 文件找不到 / 编译失败 / 分包报错 | construction-guard + page-work |
| 样式不生效 / 换肤失效 / 主题不对 | construction-guard + page-work |
| 测试变红 / 用例失败 / npm test 失败 | construction-guard |
| 接口报错 / 该操作尚未支持学校范围 | construction-guard + cloud-action |
| 列表空白 / 页面没数据 / 加载不出来 / 点了没反应 | page-work |
| 慢 / 读放大 / 配额 / 事务超限 | construction-guard + cloud-action |
| 越权 / 权限漏洞 / 安全 | construction-guard + cloud-action |

### 收尾类

| 你可能会说 | 命中 |
|---|---|
| 这批做完了 / 收尾 / 总结这次改动 / 写报告 | acceptance-doc + doc-sync |
| 写验收 / 补验收 / 留痕 / 记录一下 | acceptance-doc |
| 更新账本 / 施工切片账本 / 追加一行 | acceptance-doc |
| 同步文档 / 文档对不对 / 文档过时 / 文档漂移 | doc-sync |
| 这个数对吗 / 页面数不对 / action 数不对 / 镜像数不对 | doc-sync |
| README 更新 / 交接说明更新 / 索引清单更新 | doc-sync |
| 重建 docx / docx 没更新 / md 转 docx | acceptance-doc（构建脚本在 doc-sync） |
| 链接失效 / 文档校对 / 哪些文档要改 | doc-sync |

## 常见组合

```
只改页面        → construction-guard → page-work
只加接口        → construction-guard → cloud-action
页面+接口 一起   → construction-guard → page-work → cloud-action
一批做完        → acceptance-doc → doc-sync
只想确认文档是否过期 → doc-sync（只跑 audit，不改代码）
```

## 怎么确认命中

加载成功的标志：回答里出现 skill 名，或按 skill 的固定流程走（例如 construction-guard 一定先跑 `git status` / `git log` / `npm test`）。

没命中时的兜底，任选一句：

```
读 .workbuddy/skills/shilzi-construction-guard/SKILL.md 再动手
用 shilzi-cloud-action 处理这个接口
```

## 非 WorkBuddy 环境

Codex / Cursor / Claude Code 里没有 skill 自动加载，改由根目录 `AGENTS.md` 提供路径指针。详见 `AGENTS.md` 的「非 WorkBuddy 环境」一段。

## 维护

改了某个 skill 的触发词后，同步更新本文件对应行；`description` 是模型判断的唯一依据，本表只是人读的索引，两者不一致时以 `SKILL.md` 为准。
