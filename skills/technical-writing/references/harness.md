# 本地适配层 · 运行环境能力：写入通道与限制

> 本文件记录当前 agent 能力。四份笔记 skill 的这份 harness.md 内容相同；环境事实与落点规则见各自 `local-adaptation.md`。

## 1. 写入通道

| 运行环境 | 检索与读取 | 写 / 改笔记库 | 索引刷新 | 远端命令 |
|---|---|---|---|---|
| **DSH** | `kb_find` 做项目索引、中文 BM25 和来源过滤；`kb_read` 读取正文与 frontmatter | **唯一笔记 writer = Obsidian MCP**：`create_note`、`append_note`、`patch_note`、`replace_in_note`、`patch_frontmatter`、`move_note`、`delete_note`；写前读 `contentHash`，写入传 `prevHash` | dsh-kb 的 L0 按需内存渲染，不新写 `INDEX.md`；手维护 `index.md` / `log.md` 仍由体裁 skill 用 MCP 登记 | 本地命令可代跑；集群侧命令默认由使用者执行 |
| **Qoder** | 文件工具或可用的本地检索；无 DSH 时不假定 `kb_*` 存在 | 按当前会话可用 MCP 或文件工具；先 Read，再局部改；批量/移动操作保留回退记录 | 无 dsh-kb 时由使用者或当前工具刷新 | 不代执行；命令写明环境/节点 |
| **Claude Code / Codex** | 当前可用 MCP / 文件工具 | 同上；优先原生 Obsidian MCP | 视是否连接 dsh-kb；无则由当前工具处理 | 同上 |

## 2. 共同限制

- 高风险动作只给步骤和回退，不代执行删除数据、重启生产组件或批量变更。
- 笔记归类、体裁、frontmatter、摘要、证据等级、手维护索引和日志由四份 skill 分工负责；dsh-kb 只提供发现、读取、体检和结构化缺口。
- **笔记正文不走 Inbox 待审中转。** 直接写目标目录；新建目录和登记动作按 `obsidian-note-placement` 与体裁适配层执行。
- `origin` 缺失在 dsh-kb 中显示为 `unlabeled`，仍参与默认召回；`web` / `inferred` 默认不进 `kb_find`，引用前核对 frontmatter。Obsidian MCP 的通用 search 不按 origin 过滤，知识发现优先使用 `kb_find`。
- 笔记改写先用 MCP 读取 `contentHash`，再传 `prevHash`；出现 `hash_conflict` 时重新读取并重新生成差异，不覆盖并发修改。误操作使用 `undo_write`，不要自行建立第二套 journal。
- `kb_gap` 是唯一的 dsh-kb 结构化写入特例：它维护带确定性 ID 的项目 `Inbox/缺口.md`，用于 `add/list/resolve` 幂等缺口记录；它不写知识笔记正文。该文件是插件元数据，不是待审笔记；Obsidian MCP 的通用 search 可能看到它，引用知识前不要把缺口清单当成事实笔记。
- dsh-kb 不开放 `.obsidian`、`.dsh-trash` 等隐藏路径；主题、界面和插件配置不属于知识索引，按文件工具与 Obsidian 配置流程处理。
- 自动生成的项目 L0 只在 dsh-kb 内存返回，不再新写磁盘 `INDEX.md`；已有 `INDEX.md` 不迁移、不删除。手维护的 `index.md` / `log.md` 仍是笔记工作流的一部分，不能由自动索引替代。
- 写入配置类文件遵循：① 写盘 → ② 让宿主重载 → ③ 回读确认未被覆盖。运行中的 Obsidian 插件配置不要直接改 `data.json`。
- MCP 服务重载或宿主重启后，sessionful MCP 连接可能返回 `Session not found`；重建连接并确认状态后再继续。该问题属于 MCP 通道，不是 dsh-kb 检索层。

## 3. 通用降级顺序

① dsh-kb `kb_find` / `kb_read` 做发现与读取 → ② Obsidian MCP 做笔记写入 → ③ 文件工具直写绝对路径；所有局部修改先读取并保留可回退信息。

## 4. 能力表怎么用

- `SKILL.md` 只定义归类、证据与体裁；当前通道和限制以本文件为准。
- 换宿主时重写本文件，不把具体 DSH 工具名写入通用层。
- 无 dsh-kb 或 Obsidian MCP 时，按文件工具降级，并明确哪些索引/撤销能力未接入。
