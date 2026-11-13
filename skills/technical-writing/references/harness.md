# 本地适配层 · 运行环境能力：写入通道与限制

> 本文件记录当前 agent 能做什么，**不写死任何一套 MCP 的工具名**。四份笔记 skill 的这份 harness.md 内容相同；环境事实与落点规则见各自 `local-adaptation.md`。
> 工具名按本机 `tools/list` 实测填，不要照抄别处的清单：Obsidian 的 MCP 实现有多套，名字互不相同。

## 1. 写入通道

| 运行环境 | 检索与读取 | 写 / 改笔记库 | 索引刷新 | 远端命令 |
|---|---|---|---|---|
| **DSH** | `kb_find` 做项目索引、中文 BM25 和来源过滤；`kb_read` 读取正文与 frontmatter；需要更细的段落读取时用 MCP 的读取工具 | **笔记正文唯一 writer = Obsidian MCP**。能力见 §1.1 的四个槽位；具体工具名查 §1.2 或本机实测 | dsh-kb 的 L0 按需内存渲染，不新写 `INDEX.md`；手维护 `index.md` / `log.md` 仍由体裁 skill 用 MCP 登记 | 本地命令可代跑；集群侧命令默认由使用者执行 |
| **Qoder** | 文件工具或可用的本地检索；无 DSH 时不假定 `kb_*` 存在 | 按当前会话可用 MCP 或文件工具；先读再局部改；批量/移动保留回退记录 | 无 dsh-kb 时由使用者或当前工具刷新 | 不代执行；命令写明环境/节点 |
| **Claude Code / Codex** | 当前可用 MCP / 文件工具 | 同上；优先原生 Obsidian MCP | 视是否连接 dsh-kb；无则由当前工具处理 | 同上 |

### 1.1 需要的四个能力槽位（与实现无关）

先确认本机 MCP 能覆盖下面四项，再挑工具名。缺任一项时按 §3 降级。

| 槽位 | 要能做到 | 判定要点 |
|---|---|---|
| **新建** | 在 vault 相对路径建笔记，父目录自动创建；同名默认不覆盖 | 有「已存在则失败」的语义，别用会静默覆盖的写 |
| **局部改** | 按标题小节 / 块引用 / 行区间 / frontmatter 键精准改，不重写整篇 | 能只改一段而不是整文件覆盖 |
| **移动 / 改名** | 移动或重命名笔记，并同步改写全库指向它的 wikilink | 能自动改链才用；不能就按 §3 手工处理链接 |
| **并发保护** | 写入前拿到该笔记的版本标识，写入时带上；版本不符则拒绝而不是覆盖 | 有 etag / 版本令牌 / 内容哈希之一 |

**误操作恢复**：本机 MCP 若提供写日志与撤销能力（能列出最近写入并回滚），优先用它；没有就依赖 §2 的回退纪律（改前留副本或确认 vault 有版本管理）。**不要为插件另建一套写入日志。**

### 1.2 已知实现的名字对照（仅供查名，务必本机复核）

| 槽位 | seekstone 类实现 | Obsidian Local REST API 类实现 |
|---|---|---|
| 检索 / 读取 | `search`、`query_notes`、`read_note`、`list_notes` | `search_simple`、`search_query`、`vault_read`、`vault_list` |
| 新建 | `create_note` | `vault_write` |
| 追加 / 局部改 | `append_note`、`patch_note`、`replace_in_note`、`patch_frontmatter` | `vault_append`、`vault_patch` |
| 移动 / 改名 | `move_note`、`rename_heading` | `vault_move`（部分版本无改链，见 §3） |
| 删除 | `delete_note` | `vault_delete` |
| 并发保护 | 读 `contentHash`，写入传 `prevHash` | `vault_get_document_map` 取 version，`vault_patch({ ifMatch })` |
| 写日志 / 撤销 | `list_writes`、`undo_write` | 通常没有 |

**这张表只用来「查名」，不是契约。** 两套之外的实现（`obsidian-mcp-remote`、各类社区 server）名字又不同，一律以本机实测为准：

```bash
node scripts/probe-mcp-tools.mjs            # 打印本机 server 的全部工具名与说明
node scripts/probe-mcp-tools.mjs --json     # 机器可读，便于比对
```

把实测到的名字填回本机副本的 §1.2，或直接记在 `local-adaptation.md`。**通用层与本文件都不该出现某个实现专属的工具名。**

## 2. 共同限制

- 高风险动作只给步骤和回退，不代执行删除数据、重启生产组件或批量变更。
- 笔记归类、体裁、frontmatter、摘要、证据等级、手维护索引和日志由四份 skill 分工负责；dsh-kb 只提供发现、读取、体检和结构化缺口。
- **笔记正文不走 Inbox 待审中转。** 直接写目标目录；新建目录和登记动作按 `obsidian-note-placement` 与体裁适配层执行。
- `origin` 缺失在 dsh-kb 中显示为 `unlabeled`，仍参与默认召回；`web` / `inferred` 默认不进 `kb_find`，引用前核对 frontmatter。MCP 的通用检索工具不按 origin 过滤，知识发现优先使用 `kb_find`。
- **改已有笔记先拿版本标识**（§1.1 第四项），写入时带上。出现版本冲突就重新读、重新生成差异，**绝不覆盖并发修改**。误操作按 §1.1 的恢复能力处理，不要自行建立第二套写日志。
- `kb_gap` 是唯一的 dsh-kb 结构化写入特例：它维护带确定性 ID 的项目 `Inbox/缺口.md`，用于 `add/list/resolve` 幂等缺口记录；它不写知识笔记正文。该文件是插件元数据，不是待审笔记；MCP 的通用检索可能看到它，引用知识前不要把缺口清单当成事实笔记。
- dsh-kb 不开放 `.obsidian`、`.dsh-trash` 等隐藏路径；主题、界面和插件配置不属于知识索引，按文件工具与 Obsidian 配置流程处理。
- **不要手改或依赖磁盘上的 `<项目>/INDEX.md`**：dsh-kb 的 L0 是按需内存渲染，不再维护该文件。要看项目索引，用 `kb_find({ project })`。已有 `INDEX.md` 不迁移、不删除，但它不再随笔记更新。
- 手维护的 `index.md` / `log.md` 仍是笔记工作流的一部分，**必须当场登记**，不能由自动索引替代。注意大小写：大写 `INDEX.md` 是历史派生物，小写 `index.md` 是人维护的登记表。
- 写入配置类文件遵循：① 写盘 → ② 让宿主重载 → ③ 回读确认未被覆盖。运行中的 Obsidian 插件配置不要直接改 `data.json`。
- MCP 服务重载或宿主重启后，sessionful MCP 连接可能返回 `Session not found`；重建连接并确认状态后再继续。该问题属于 MCP 通道，不是 dsh-kb 检索层。

## 3. 通用降级顺序

① dsh-kb `kb_find` / `kb_read` 做发现与读取 → ② Obsidian MCP 的「局部改」槽位做笔记写入 → ③ 文件工具直写绝对路径。

降级时保持两条不变：

- **先读后写**，改前留可回退副本（无写日志时这是唯一退路）。
- **移动 / 改名**若 MCP 不自动改链，按 `obsidian-note-placement` 的移动流程手工修全库链接，并记「原路径 → 新路径」清单。

## 4. 能力表怎么用

- `SKILL.md` 只定义归类、证据与体裁；当前通道和限制以本文件为准。
- 换宿主或换 MCP 实现时重写本文件 §1.2，**不要改四份 `SKILL.md`**，也不要把具体工具名写进通用层。
- 无 dsh-kb 或 Obsidian MCP 时，按 §3 降级，并明确哪些索引/撤销能力未接入。
