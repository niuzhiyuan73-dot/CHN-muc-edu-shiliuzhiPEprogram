# 中央民族大学石榴籽体育管理小程序

原生微信小程序（WXML / WXSS / JS，零框架）+ 唯一云函数 `cloudfunctions/data`。
现行文档入口：[README](README.md)；进度与批次见 [施工切片账本](docs/施工切片账本.md)。

## 按任务意图和涉及文件读取对应 skill

| 你要做 | 先读 |
|---|---|
| 需求与方案评估、理解代码 / 接手、代码改动、审查 / Review、性能与安全检查、故障排查、测试 / 构建 / 环境诊断、重构、维护项目指令与 Skill | `.workbuddy/skills/shilzi-construction-guard/SKILL.md` |
| 新增 / 迁移 / 修改 / 审查页面或组件，调整布局主题、表单、导航、权限展示、搜索分页、加载与生命周期，排查前端交互或渲染问题 | 加上 `.workbuddy/skills/shilzi-page-work/SKILL.md` |
| 新增 / 修改 / 下线 / 审查接口，维护云端执行的共享逻辑、双端仓储、权限与隐私、事务并发、缓存、查询索引、导入回填、镜像或云端部署 | 加上 `.workbuddy/skills/shilzi-cloud-action/SKILL.md` |
| 功能 / 修复 / 重构批次收尾，正式验收、阶段交付、发布准备、交接材料或审计结果留痕 | `.workbuddy/skills/shilzi-acceptance-doc/SKILL.md` → `.workbuddy/skills/shilzi-doc-sync/SKILL.md` |
| 核对或更新文档、操作说明、规模数字、链接，以及规则 / 配置 / 项目指令 / Skill 变更后的关联说明 | `.workbuddy/skills/shilzi-doc-sync/SKILL.md` |

按当前项目上下文、用户意图和实际涉及文件触发，不要求用户点名技能或命中固定关键词；“帮我看看”“优化一下”“检查性能和安全”“这个页面有问题”等也按对应任务加载。跨前后端任务可以组合使用，只读审查也读取相关约束。

加载 Skill 后按任务粒度执行：只读分析按需核查与复现；实际代码修改执行施工基线与验证矩阵；仅改文档或 Skill 时检查相关内容、结构与引用。不因技能触发自动扩大修改范围、生成完整验收记录或重建无关产物。

> **非 WorkBuddy 环境（Codex / Cursor / Claude Code 等）**：这些是纯 Markdown 指令文件，
> 没有可调用的「skill 工具」。直接按上面的路径读取文件、按其中步骤执行即可。
> `.workbuddy/skills/` 已从 `.gitignore` 放行，随仓库分发；若你的工具支持
> `~/.codex/skills/` 之类的技能目录，可把本目录软链过去以获得原生发现。

## 三条红线（其余见上面的 skill）

1. 改 `miniprogram/` 下的纯模块后必须 `npm run sync:cloud`，否则测试读到旧镜像、改动**静默不生效**。
2. 分包可引主包，**主包不可引分包**；`miniprogram/**` 禁止裸写 `process` / `Buffer` / `__dirname` / `require('fs')`（测试全跑在 Node，这类写法全绿但真机白屏）。
3. `docs/*验收记录*`、`*只读审计*`、`*需求整理*`、`*隐患*` 是历史留痕，**冻结不改**；docx 只由 md 构建，不手改。

## 常用命令

```bash
npm test                  # 全量（约 30s；文件数/用例数以输出末行为准）
npm run check:cloud-sync  # 镜像一致性
node .workbuddy/skills/shilzi-doc-sync/scripts/doc-audit.js --cases=<用例数> --frozen-check --links
```

## 数字以代码为准

文档里的规模数字会过期。要引用前先跑
`node .workbuddy/skills/shilzi-doc-sync/scripts/doc-truth.js`，不要抄文档或上一份验收记录。
