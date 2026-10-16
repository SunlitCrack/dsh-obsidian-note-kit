# dsh-kb — DSH 本地知识数据库

把 **obsidian-workbench**（壳：vault 目录树 + CodeMirror 原地编辑 + 面板内 DSH 会话）与
**dsh-cardian**（服务层：store / indexer / embedder / links + 工具集）合并为一个插件，
目标不是"再做一个笔记浏览器"，而是做成 **agent 的知识后端**：

> agent 完成任务时**优先从本地知识库读取**（不靠网上搜），库里没有的知识，
> 任务完成后**自己分类归纳补进去**。

## 落点与来源

| | |
|---|---|
| 本插件 | `<plugins-dir>\dsh-kb`（新插件，可独立卸载） |
| 壳来源 | `<plugins-dir>\obsidian-workbench`（Bob-Bo1，MIT，**保持原样不动**） |
| 服务层来源 | `<plugins-dir>\dsh-cardian`（MIT，**保持原样不动**） |
| 构建 | `npm run build:client`（esbuild：`lib/client-source.js` → `lib/client.js`，CodeMirror 打进 bundle）<br>host 半 `lib/index.js` 是手写纯 ESM，**无需构建**，可直接 `import` 本包 `core/` |
| 注入 | `dev_inject_plugin(<plugins-dir>\dsh-kb)`；卸载 `dev_uninject_plugin("dsh-kb")` |

> ⚠️ `npm install` 必须带代理（本机 Clash `http://127.0.0.1:7897`），否则会静默卡死：
> ```powershell
> $env:HTTPS_PROXY='http://127.0.0.1:7897'; npm install --no-audit --no-fund
> ```

## 四个已冻结的设计决策

1. **数据形态：原地 + `type:` 分流**
   全 vault **原地**索引；`type: card | memory | wiki` 的笔记才获得对应能力，
   **没有 `type` 的就是普通笔记**（照样浏览 / 搜索 / 编辑）。
   不再有 cardian 那种"复制进 `Cards/` `Memory/` `Repos/` 三分区"的副本模型。
2. **项目 = vault 顶级目录**
   `k8s/`、`启智平台管理/`、`Obsidian-AI/` 各自一个项目；每项目一个 `INDEX.md` 作为 L0 入口。
3. **写入安全阀：Inbox 暂存 + 改旧需审批**
   新知识先落项目 `Inbox/`（自动）；修改 / 移动 / 删除**已有笔记**需审批（可配为每次 / 每任务一次）。
4. **工程：新建 `dsh-kb`**，不修改两个来源插件；workbench 那套已验证的 UI/编辑器不重造。

## 检索：三层渐进披露（别把库塞进 prompt）

| 层 | 内容 | 谁读 |
|---|---|---|
| **L0** | `<项目>/INDEX.md`：该项目每条知识一行（标题 + 一句话 + 路径） | agent **永远先读这个** |
| **L1** | 每篇 md 的 frontmatter（`title/summary/tags/type/confidence/updated/aliases/origin`） | `kb_search` 命中时批量返回 |
| **L2** | 正文 | 只在确定要用时读 1~3 篇 |

**type 分流**：`type` 是 frontmatter 里的分类（`card` / `memory` / `wiki` / 自定义），**没有 `type` 就是普通笔记**。
`kb_search({ type })` 精确匹配；`type: "note"`（或 `plain`）= **只召回没有 type 的普通笔记**；
面板「知识」页也给了 `全部 / 普通笔记 / card / memory / wiki` 一排过滤 chip（点击立刻按新过滤重搜，不依赖 setState 生效）。
`kb_index` 的每个项目会返回 `types` 计数，agent 据此决定要不要按 type 收窄。

## 防网络污染：来源分级

- 每条知识带 `source` + `confidence`（cardian 已有）+ **`origin: local | web | inferred`**
- `kb_search` **默认只召回 `local` / 已审核**；`web` 来源必须显式开启
- 网络 / 推理得来的内容**先进 Inbox**，不自动合并进正式知识
- 回答必须带来源（路径 + confidence）
- 另在项目 `AGENTS.md` 里写一条行为规则：**先查库 → 库内无解再联网 → 联网结论先入 Inbox**

## 自动沉淀流水线

```
触发（会话空闲 / 任务完成 / /沉淀 / 面板按钮）
  → 抽取（只抽可复用结论，不是流水账）
  → 检索去重（高相似 → 合并进既有笔记并提 confidence；冲突 → 进「⚖️ 冲突」小节保留双方来源；否则新建）
  → 分类（项目 + 主题 + type）
  → 落盘：写进真实目录结构 + 更新该项目 INDEX.md
  → 记来源（会话 id / 任务），可追溯
```

**缺口驱动生长**：`kb_search` 没命中、agent 不得不外部获取或自行推理时，
强制在 `<项目>/Inbox/缺口.md` 记一条（问题 + 现有线索 + 来源），任务结束后由沉淀流程转正。
知识库因此是**被使用驱动生长**的，而不是等你想起来才写。

## 工具面（host 半注册，命名空间 `kb_`）

| 阶段 | 工具 |
|---|---|
| P1 | `kb_index`（L0 索引）/ `kb_search`（L1 检索，带 origin + type 过滤）/ `kb_read`（L2 正文） |
| P2 | `kb_capture`（沉淀）/ `kb_inbox`（待审列表 + 归库；去重合并是它的 `action:'merge'`，就地修订是 `revise`） |
| P3 | `kb_wiki_ingest` / `kb_wiki_sync` / `kb_wiki_upsert` / `kb_wiki_overview` / `kb_wiki_graph` / `kb_wiki_list` / `kb_wiki_delete` |
| P4 | `kb_tagcloud` / `kb_backlinks` / `kb_doctor` / `kb_export` / `kb_import` / `kb_skill_export` / `kb_feedback`（确认 / 纠正会调整 confidence） |
| P5 | `kb_gap`（list/add/resolve 缺口清单）/ `kb_graph`（链接图谱）/ `kb_reindex`（索引自愈） |

> 上表按 `lib/tools.js` 里 `register()` 的工具逐个核对（2026-10-16，共 **22 个**）。**没有 `kb_merge` 这个工具**——去重合并走 `kb_inbox({ action: 'merge', path, into })`；照抄旧表会让 agent 去调一个不存在的工具名。

（不再做闪卡 / SM-2 —— 用户明确不要。）

## 提示词契约（"自动沉淀"的触发点）

工具存在不等于会被用。`apply()` 里动态 `ctx.inject(['systemPrompt'])` 注册一段系统提示词
（section 名 `dsh-kb:knowledge-base`，`order: 480` → 排在 persona 之后、`PLAN_POLICY` 之前），
把知识库的操作纪律写进 agent 的默认动作：

1. 动手前先查库：`kb_index`(L0) → `kb_search`(L1) → 只对真要用的 `kb_read`(L2)，不盲扫全文；
2. 只信 `local`：`origin: web|inferred` 必须显式 `includeWeb`，引用要标来源、不当既有事实；
3. **任务后自动沉淀**：值得复用的结论用 `kb_capture` 落 `<项目>/Inbox/`，先 `kb_search` 去重 —— 命中且只是补充 → `kb_inbox` merge（需批准），没命中 → 新建卡片；
4. 库里没有、不得不外部检索或推理 → `kb_gap({action:'add'})` 记缺口，补齐后 `resolve`；
5. 改已有笔记必须先拿批准（merge / feedback / import 写盘都弹审批），新知识只落 Inbox；
6. 索引失真 → `kb_reindex({fixIndexes:true})`；`kb_doctor` 体检断链/过期/重复/待审/缺口。

两个设计约束（都是踩过坑的）：

- 用**动态** `ctx.inject`，宿主没有 `systemPrompt` 服务时插件照常加载（只是没有这段提示词）；
- `section()` 调用包在 `try/catch` 里：**重复装配时 section 重名会抛**（cordis 的 `NamedEntries` 对同名插入直接 throw），绝不能让它发生在 `apply()` 里 —— 那就是 2026-09-14 那次启动崩溃的同类风险。
- 回归断言：`host-smoke`（假 ctx，逐条检查提示词覆盖了 9 个要点）+ `cordis-load`（真实 cordis，断言 section 注册与 order）。

## UI（client 半）

壳沿用 workbench 三栏（左目录树 / 中 CodeMirror 编辑器 / 右 DSH 会话），左栏分段开关 = **文件 / 知识 / 洞察 / 代码**：

- **文件**：原 workbench 的 vault 目录树 / 搜索 / 新建 / 改名 / 移动 / 删除（编辑器与 DSH 会话栏不变）
- **知识**：Inbox 待审卡片（归库 / 合并 / 丢弃）/ L0 项目索引树 / L1 搜索结果（评分 + `origin` 标记 + **type 过滤 chip**）/ 笔记详情（L2）
- **洞察**：标签云 / **关系图谱（SVG 力导向）** / **缺口清单** / 库体检（含 **「重建索引」按钮** → `POST /knowledge/reindex`，一键修好落后的 `INDEX.md`） / 当前笔记的反链与相关
- **代码**（RepoWiki）：仓库路径 + 仓库名 + 文件数 → **扫描仓库** / **同步**（复用同一份 `wiki/repos|list|overview|graph|scan|sync` 路由）；已收录仓库 chip 切换；页面清单（角标 `骨架 / AI / 人工` = `analysisLevel`，并提示还有多少页待凝练）；**import 依赖图**（同一 `GraphView`，节点带 `rel`，点击直接开对应 wiki 页）；项目概览（只读展示 `project-overview.md`，「刷新概览」才重写）
  - 「AI 凝练」有意**不在面板里**：它由 agent 读骨架后调 `kb_wiki_upsert` 回填，面板只负责告诉你哪些页还是骨架。

客户端源码是 **`React.createElement` 风格**（无 JSX），扩展时沿用；
两个插件都注册 `sidebar.footer.action` + `shell.overlay`（id 不同，additive 不冲突）。

**每个左栏分段都套了 `PanelBoundary`（错误边界）**：某一段渲染抛错时只在原位显示「X 渲染出错：<message>」，不会把整个知识中心变成白屏 —— 没有边界时 React 会卸载整棵树，用户看到的是"点了没反应"，无法定位。

## 阶段与状态

| 阶段 | 交付 | 状态 |
|---|---|---|
| **P0** | 骨架（workbench 壳 + cardian `core/` 搬入）、id/API/CSS 改名、构建链、注入闭环 | ✅ 2026-09-14 完成（构建 → 注入 host✓client✓ → 干净卸载已验证） |
| **P1** | 全库索引（Indexer 支持任意 roots）+ `kb_index`/`kb_search`/`kb_read` + 面板「知识」tab | ✅ 2026-09-14 完成（core 24 项 + host 24 项冒烟全通过；`k8s/INDEX.md` 已生成） |
| **P2** | 自动沉淀 + 去重合并 + Inbox 暂存 + 改旧审批 + INDEX.md 维护 | ✅ 2026-09-14 完成（`p2-smoke` 全通过）**⏳ 待重启生效** |
| **P3** | RepoWiki 移植（扫仓库 / 骨架 / 总览 / 依赖图 / 双向 sync） | ✅ 2026-09-14 完成（`p3-smoke` 全通过）**⏳ 待重启生效** |
| **P4** | 洞察面板 + 导入导出 + skill 导出 + 反馈闭环 | ✅ 2026-09-14 完成（`p4-smoke` 全通过）**⏳ 待重启生效** |
| **P5** | 缺口驱动补库 + 链接图谱 + 索引自愈 | ✅ 2026-09-14 完成（`p5-smoke` 全通过）**⏳ 待重启生效** |
| **P3+** | RepoWiki 面板化（左栏第四段「代码」+ 6 条 wiki 路由） | ✅ 2026-09-14 完成（`p3-smoke` 第 12 节全通过）**⏳ 待重启生效**（共 22 工具 + 29 路由 + 1 提示词 section） |

### 重启后验收清单（2 分钟）

1. **工具表**：工具列表里应出现 `kb_gap` / `kb_graph` / `kb_reindex`（若只有 `kb_index`/`kb_search`/`kb_read`，说明跑的还是 P1 代码 → 重启没生效）。
2. **右下角入口**：侧边栏底部应有整行「图标 + 知识中心」按钮（不是纯图标）→ 点击打开三栏工作台。
3. **左栏四段**：「文件 / 知识 / 洞察 / 代码」。点「知识」应看到 Inbox 卡片区 + 6 个项目（k8s / Obsidian-AI / 启智平台管理 / Excalidraw / Obsidian / omp），每个都能展开出自 `INDEX.md` 的 L1 行。
4. **「洞察」页**：标签云 / **图谱**（SVG 力导向，点节点开笔记，显示孤立数）/ **缺口**（当前为空）/ 体检（0 错误 / 70 警告 / 0 提示）+「重建索引」按钮。
5. **「代码」页**：真实 vault 里还没有 RepoWiki 页 → 应显示"扫描 / 同步本地仓库"表单（仓库绝对路径 + 仓库名 + 文件数）。想看效果就填 `<本地仓库绝对路径>` / `<仓库名>` / `<文件数>` 点「扫描仓库」，然后依赖图、页面清单、概览都会出来（会在 vault 里建 `<仓库名>/` 项目，可整目录删掉）。
6. **提示词**：让 agent 只说一句"我这条经验值得记下来吗"，它应该主动提 `kb_capture` / Inbox —— 说明提示词契约生效。
7. **沉淀闭环 demo**：让 agent 跑 `kb_capture`（项目 `k8s`）→ 「知识」页 Inbox 出现待审卡片 → 点「归库」→ `k8s/INDEX.md` 里多一条。
8. **回滚**：出问题就删 `~/.dsh/profiles/desktop/package.json` 里 `dependencies` 的 `dsh-kb` + `dsh.profile.bundles` 里的 `dsh-kb`（备份 `.bak-before-cardian-removal`），重启即可回到无插件状态。

### P1 已交付细节

- `core/store.js`：新增 `allFiles()`（全 vault 递归，跳过 `.obsidian` 等隐藏目录 / `node_modules` / 派生的 `INDEX.md`，支持 `excludes`）、`snapshotOf()`、`fileStatsOf()`。
- `core/indexer.js`：新增 `listFiles` 注入点 + `_allNotes()`/`_fileStats()`，索引范围从"三分区"变成**整个 vault**；`rebuild`/`_catchExternalEdits`/`_syncMtimes` 全部走同一文件集。
- `core/kb.js`（新）：`KnowledgeBase` 服务 —— `projectStats()` / `index()`（L0，含 `types` 计数）/ `list()`（L1 行，支持 tag/type）/ `search()`（L1，origin 闸门 + **type 分流**）/ `read()`（L2，路径与隐藏目录双重防护）/ `renderIndex()` / `rebuildIndex()`。
- `lib/tools.js`（新）：注册 `kb_index` / `kb_search` / `kb_read`（readOnly，结构化错误）。
- `lib/index.js`：新增 `/knowledge/index|search|read` 三条路由（保留 workbench 全部 13 条原路由），并在 `apply()` 末尾挂载工具（懒加载，无 vault 时不影响插件加载）。
- 客户端：左栏加「文件 / 知识」分段开关 + `KnowledgePanel`（项目清单 → 项目 L1 列表 / 检索结果，带 origin 徽标、score、snippet，点击在中间编辑器原地打开）。
- 冒烟脚本：`scripts/kb-smoke.mjs`（core，直连真实 vault）、`scripts/host-smoke.mjs`（假 ctx 驱动 `apply()`，验证路由/工具/越界/隐藏目录）。

### P2 已交付细节（自动沉淀闭环）

**core（`core/kb.js`）**：`stage()` 暂存 / `dedupe()` 去重候选 / `inboxList()` 待审列表 / `promote()` 归库 / `mergeInto()` 合并 / `dropStaged()` 丢弃；`INBOX_DIR = 'Inbox'` **永远不进索引**（`allFiles` 的 excludes 带上它），L0 用 `pendingInbox` / `inboxCount` 暴露待审计数。

- **暂存** → `<project>/Inbox/<slug>.md`，frontmatter 带 `origin`（默认 `inferred`）、`confidence`、`source`、`session`、`status: inbox`、`captured`、`suggest`（去重候选路径）。
- **去重**：暂存前先走 L1 检索（`includeWeb: true`，比对候选时得看得见 web 内容），最相似的三条写进 `suggest`。
- **归库 promote**（自动，不需审批）：搬进 `<project>/<targetDir>/`，`status: published`，清掉 `suggest`，刷新该项目 `INDEX.md`；目标同名则报错并提示改用 merge。
- **合并 merge**（**需审批**）：只追加、绝不改写既有内容 —— `mode=append` 追加「## 补充 · <日期>」小节，`mode=conflict` 追加到「## ⚖️ 冲突（待裁决）」；同时 `confidence` +0.1（上限 1）、`sources` 追加来源、`updated` 刷新，然后消费待审条目并刷新 INDEX。
- **丢弃 drop**（**需审批**）：移到 `<project>/Inbox/.dropped/<name>.<时间戳>.md`（隐藏、可恢复、不进索引）。

**审批闸门（`lib/tools.js` + `lib/index.js`）**：走宿主 `approval` 服务（`ctx.approval.request({ agent, toolName, callId, reason, signal })`，仅 `'allowed-once'` 算批准）。

- 工具包装器改为 `execute(args, exec)` —— **`exec` 第二参必须转发**，否则拿不到 `agent`，审批无从发起（这是从 workbench 继承的老包装器缺的一环）。
- **fail-closed**：无 approval 服务 / 无 exec / 服务抛错 → 直接拒绝改动（`ok:false, error.code=APPROVAL_REQUIRED`）并提示用户在面板手动处理；**不会**退回"agent 自己传 approve=true"的假审批。
- 面板点击（HTTP `/knowledge/inbox` POST）本身就是人的显式同意，**不再叠加** approval 弹窗 —— 审批只拦 agent 自己发起的改动。

**工具 / 路由**：`kb_capture`、`kb_inbox`（list/promote/merge/drop）；`GET|POST /api/dsh-kb/knowledge/inbox`。P2 结束时共 **5 个工具 + 17 条路由**。

**客户端**：知识面板顶部多出**待审区**卡片（`._kb_inbox`）：每条显示 标题/origin 徽标/confidence/日期/摘要 + 三个按钮「归库 / 合并（进 `suggest[0]`）/ 丢弃」，操作后自动刷新待审列表与项目索引。

**测试**：`scripts/p2-smoke.mjs` —— 全程跑在 `%TEMP%/dsh-kb-p2-*` 的**一次性临时 vault**（两篇 fixture + 一篇既有笔记），覆盖：落 Inbox、默认 inferred、去重命中、待审不进索引、L0 待审计数、无 exec fail-closed、用户拒绝、批准后合并（`## 补充` + confidence 0.8 + `sources` + 消费条目）、归库到子目录 + INDEX 刷新、丢弃到 `.dropped`、HTTP 面板路径。**绝不触碰真实 vault**。

### P3 已交付细节（RepoWiki 就地化）

**存储模型的关键改动**：cardian 把 wiki 页面放在 `Repos/<repo>/` 分区；dsh-kb 改成 **`<repo>/<扁平化源码路径>.md`，repo 自己就是 vault 顶级项目** —— 于是 RepoWiki 直接复用 P1 的 L0（每个 repo 一个 `INDEX.md`）与主题分组。

**移植手法（最小改动）**：`core/repowiki.js` 从 cardian 原样搬入，只替换两个存储接缝：

- 构造函数 `section: '.'`（让继承来的 `writeNote` 拼出 `./<repo>/…` = vault 根下的 `<repo>/…`）；
- 覆盖 `entries()`：wiki 页面 = 索引里 `type: wiki` 的那些（走 indexer 的 docs，只读 wiki 文件，不做全库扫描）；
- 覆盖 `refreshMoc()` 为空操作（L0 归 `kb_index` 管）；
- `writeNote()` 包一层，把返回 rel 的 `./` 前缀归一化，保持全库路径形态一致。

扫描/骨架/依赖图/总览/对账/剪枝等**原逻辑一行未改**。

**L0/L1 的源码结构**：页面在磁盘上是扁平的（`<repo>/src-a.md`，因为 `flattenPath('src/a.js')` → `src-a`），但 frontmatter 保留 `path: src/a.js`。`core/kb.js` 新增 `groupOf()`：`type=wiki` 的条目按 **frontmatter.path 的目录**分组 → INDEX.md / L1 行里能直接看出 `## src`、`## src/lib` 这样的代码结构。

**工具（7 个）**：`kb_wiki_ingest`（扫仓库→骨架）、`kb_wiki_upsert`（**AI 凝练的落点**：agent 读完骨架自己回填语义描述，不需要插件另起 agent 会话）、`kb_wiki_overview`（写 `project-overview.md` 项目概览）、`kb_wiki_graph`（节点+import 边+被引计数）、`kb_wiki_sync`（双向对账：新增/变更/剪孤儿，**已语义回填的页受保护**）、`kb_wiki_list`、`kb_wiki_delete`。工具共 **12 个**。

**共享索引**：`lib/index.js` 里 RepoWiki 与知识库**共用同一个 `VaultStore` + `Indexer`** —— 一份全库索引同时服务两者，wiki 页面因此天然可被 `kb_search` 检索（`kb_smoke`/`p3-smoke` 都验证了）。

**面板（P3+ 补的）**：左栏第四段「代码」= `WikiPanel`，走 6 条路由（`GET /wiki/repos|list|overview|graph`、`POST /wiki/scan|sync`）：

- 面板点击 = 人的显式同意，所以 scan/sync **不叠 approval 弹窗**（审批闸门只针对 agent 自己发起的动作）。
- 「概览」拆成读/写两条语义：`GET` 只读已存在的 `project-overview.md`，`POST` 才刷新（否则每次打开面板都在写盘）。
- `wiki/graph` 返回前给每个节点补 `rel`（仓库内源码路径 → vault 页面路径），否则面板点节点打开的是空路径。
- scan/sync 复用 `refreshRepoIndex()`：扫完自动重建该 repo 项目的 `INDEX.md`，「知识」页立刻能看到。

**测试**：`scripts/p3-smoke.mjs` —— 一次性临时 vault + 一次性临时 fixture 仓库（`src/a.js` import `./b.js`、`src/b.js`、`README.md`、应被跳过的 `node_modules/`）。覆盖：骨架页原地落盘 + frontmatter（type/repo/path/language/analysisLevel/imports/symbols）、node_modules 跳过、**wiki 页可被 kb_search 命中**、L0 按源码目录分组、语义回填（`analysisLevel: manual`）、**sync 不覆盖已回填页**、增量新增、删文件后剪孤儿、`project-overview.md` 含页面清单、`kb_wiki_delete`、删除后索引同步；第 12 节专测**面板那 6 条路由**（repos/list 带 rel+analysisLevel、graph 节点补 rel、overview 只读、scan 幂等只补回被删页、sync 出对账报告、缺参 400）。

> 开发坑（写给未来的自己）：正则里的 `\b` 经工具调用的 JSON 参数传递时会被解码成**退格符**（0x08），写进文件后正则静默失效。写正则请避开 `\b`（用 `^key:\s*[a-z]+` 之类的锚点）。
>
> 另一个：**别用 grep 在 `lib/client.js` 里找中文 UI 文案** —— esbuild 默认 `charset: ascii`，会把中文转义成 `\uXXXX`（例如「归库」→ `\u5f52\u5e93`）。要确认文案在不在，搜转义码点，或直接看 `client-source.js`。

### P4 已交付细节（洞察 / 导入导出 / 技能包 / 反馈闭环）

**core（`core/kb.js`）**：`tagCloud()`、`resolveRef()`（路径/文件名/标题/别名 → rel，含 Inbox 条目）、`backlinks()`、`related()`、`doctor()`、`exportSnapshot()`、`importSnapshot()`、`exportSkill()`、`feedback()`。

- **反链/相关**复用 cardian 的 `core/links.js`，但给它加了 `snapshot` 注入点：cardian 原版固定走 `store.snapshot()`（只覆盖三分区），dsh-kb 传"整个 vault"的快照 —— 否则你真实目录里的笔记互链根本看不见。
- **体检**（`doctor`）七类：缺 `title` / `expires` 已过期 / **断链**（wikilink 目标在库里解析不到）/ 标题或文件名重复 / `INDEX.md` 落后或缺失 / 有 `Inbox` 待审未归库 / **有未补缺口**。level = `error|warn|info`。断链判定对"路径式链接"也宽容（回退比最后一段）。`INDEX.md` 落后判定（P5 起与 `kb_reindex` 共用 `staleProjects()`）取项目内笔记的 **max(frontmatter.updated, 文件 mtime)** 对比 —— 只看 frontmatter 会漏掉手写笔记（它们没有 `updated`）。
- **快照**：`exportSnapshot()` 只导已发布知识（不含 Inbox 暂存）；`importSnapshot()` **默认 dryRun**（给 新增/更新/未变/跳过 计划），真正写盘要 `dryRun:false` **且经用户批准**；非法路径（`..`、隐藏段）直接进 `skipped`。
- **技能包**：`exportSkill()` 把选中笔记打包到**隐藏目录** `.dsh-kb/skills/<name>/`（`SKILL.md` + `references/`），不进索引、不污染项目列表；返回 `installHint` 提示复制到 `~/.dsh/skills/`。同一 rel 被多种写法引用时**自动去重**。
- **反馈闭环**：`feedback(kind=correction|confirm)` → confidence −0.2 / +0.1（clamp 0–1），并把 `[时间] [kind] 文本` 追加进 `corrections`，同时刷新该项目 INDEX。

**工具（7 个，当时共 19 个）**：`kb_tagcloud` / `kb_backlinks`（反链+相关一次给全）/ `kb_doctor` / `kb_export` / `kb_import` / `kb_skill_export` / `kb_feedback`。
**审批闸门**：`kb_import(dryRun:false)` 与 `kb_feedback` 都会改已有笔记 → **必须经宿主 approval**，否则返回 `APPROVAL_REQUIRED`（无 exec 上下文同样 fail-closed）。

**路由（+3，当时共 20 条）**：`GET /knowledge/tagcloud`、`GET /knowledge/doctor`、`GET /knowledge/links?path=&max=`（面板「洞察」页用）。

**客户端**：左侧栏分段开关从「文件 / 知识」扩成 **「文件 / 知识 / 洞察」**。

- 「洞察」页三块：**标签云**（chip = `标签 计数`，点击跳到「知识」页并自动检索该标签）、**体检**（按 level 列问题，点击打开对应笔记）、**当前笔记的反链/相关**（`←` 反链 / `≈` 相关，点击跳转）。
- 为此把知识面板的检索词提升到 Workbench 的 `kbQuery`（`KnowledgePanel` 支持 `query`/`onQueryChange` 外部驱动 + 只对"外部变化"自动搜一次，避免循环）。

**测试**：`scripts/p4-smoke.mjs`（一次性临时 vault）—— 标签云计数、反链（A 链 B）、相关（共享标签）、体检四类（断链/过期/重复标题/缺 title）+ 与 HTTP 路由一致、导出快照、`kb_import` 的 dryRun → 删一篇文章 → 计划新增 1 → **无 exec fail-closed** → **用户拒绝不写盘** → **批准后写回 1 篇**、技能包（隐藏目录 + 不污染索引）、`kb_feedback`（无 exec 被拒 / correction 1→0.8 / confirm 0.8→0.9 / frontmatter 留痕）。

### P5 已交付细节（缺口驱动补库 / 链接图谱 / 索引自愈）

**缺口清单** —— "库里缺什么"由**使用**驱动记下来，而不是靠人想起来：

- 文件落在 `<项目>/Inbox/缺口.md`（在 Inbox 内 → 天然不进索引、不污染项目列表），frontmatter `type: gap`。
- 行格式 `- [ ] <!--gap:<id>--> **<问题>**（线索：…；来源：…）`，`id = shortHash(project:question)` → **同一问题重复记录幂等**（二次 add 返回 `duplicate:true`，不新增行）；`parseGaps/formatGap` 双向可回读。
- `gapAdd()` 不碰任何已有笔记（只写插件自己的暂存文件）→ **不需要审批**；`gapResolve({project,id,note})` 勾成 `- [x]` 并追加「已补：…」。
- L0（`kb_index`）暴露 `projects[].pendingGaps` 与 `vault.gapCount`，`kb_doctor` 把未补缺口报成 `info` —— agent 每次进库都能看见"还欠什么"。
- 满环用法：`kb_search` 没命中 → `kb_gap({action:'add'})` 记一条 → 外部获取/推理完成 → `kb_capture` 沉淀 → `kb_gap({action:'resolve', note:'<路径>'})`。

**链接图谱**（`kb_graph` / `linkGraph()`）：整库 wikilink 解析（含标题、别名、路径回退），返回节点 `{path,title,group,in,out,degree}`（按 degree 降序）+ 边，并统计 `isolated`（既无入链也无出链）。图谱只在**同一项目内**连边（跨项目引用不算），避免大库变面条。

**索引自愈**（`kb_reindex`）：平时每次读取都按 mtime 差分自愈，这个工具是**强制兜底**（外部批量改动 / 怀疑索引失真）；`fixIndexes:true` 会用 `staleProjects()` 找出失真的项目并重写其 `INDEX.md`。只动派生文件，不改笔记正文 → 无需审批。

`staleProjects()` 有**两条判据**（第二条是 2026-09-15 真机验收时补的）：

1. **`rows`**：索引**行数** ≠ 项目实际笔记数。只比时间戳会漏掉"笔记被删 / 被移走"——删掉一篇后 `INDEX.md` 的 `updated` 反而比所有存活笔记都新，"落后"判据永远不触发，索引里就长期留着一行指向不存在的文件。（验收时我删掉那张冒烟卡片，`kb_reindex({fixIndexes:true})` 真的什么都没修，那行还在 → 现在就抓得到了。）
2. **`behind`**：笔记的 `max(frontmatter.updated, 文件 mtime)` 比 `INDEX.md` 的 `updated` 新（只看 frontmatter 会漏掉手写笔记）。

**工具（+3，共 22 个）**：`kb_gap`（action=list/add/resolve）/ `kb_graph` / `kb_reindex`。
**路由（+3，共 23 条）**：`GET /knowledge/graph?project=&limit=`、`GET|POST /knowledge/gaps`（POST `{action:'resolve',project,id,note}`；面板点击即人的显式同意，不再叠加 approval）、`POST /knowledge/reindex`（`{fixIndexes,project}`，面板「重建索引」按钮用；只重写派生的 `INDEX.md`）。

**客户端**（「洞察」页新增两块）：

- **图谱**：`GraphView` 用**确定性 Fruchterman-Reingold**（同步跑完，无动画、无 d3 依赖；≤60 节点 ×120 次迭代，毫秒级）算布局，SVG 画边 + 节点（半径随 degree，degree ≥ 3 标注标题），点节点打开笔记；附一行"`N` 篇孤立笔记"提示。
- **缺口**：未补条目逐条列出（`[项目] 问题`），每条右侧「补上」按钮 → `prompt` 填补充说明 → POST resolve；已补条目折叠展示 `✓ 问题`。

**测试**：`scripts/p5-smoke.mjs`（一次性临时 vault）—— 工具面（22）、add 落 `Inbox/缺口.md`、重复 add 幂等、缺 `question` → `VALIDATION`、缺口行格式可回读、L0 `pendingGaps`/`gapCount`、缺口不进索引、体检报未补缺口、**体检抓到 INDEX.md 落后**、HTTP GET 列表 / POST resolve（落 `- [x]` + 「已补：」）、未知 id → `NOT_FOUND`、图谱节点/边/度数/降序/孤立/`group`/`limit`、`kb_reindex` 全量重建、`fixIndexes` 修好落后索引且体检不再报、**HTTP POST `/knowledge/reindex`（面板按钮那条）**、外部新增文件后 `kb_search` 与图谱自动跟上（mtime 自愈）。

## 环境注意：本机热重载是降级的（2026-09-14 实测）

`dsh-super-injector` 在本机报告 `loader.internal 不可用：重载降级为重新装配（代码改动需重启内核生效）`，后果：

- `dev_inject_plugin` 建出的 entry 不在配置树里，**loader 对账会把它标 `[disabled]`**（防幽灵双实例）；注入器本该在注入后清除该标记，但这条清理依赖 `loader.internal`，本机没生效。
- 表现：`dev_plugin_status` 显示 `[active] xxx (dsh-kb) [injected] [disabled]`，而 **host 半根本没执行**。
  - **判据用哪个（2026-09-14 更正）**：**别**拿"`apply()` 里的 `console.log` 有没有进宿主日志"当判据 —— 插件的 `console.log` **不进** `%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log`（只有走宿主 logger 的日志才进；cardian 那几条 `[cardian] vault 变更…` 就是宿主 logger）。
  - 可靠判据：**看 agent 的工具表** —— host 半跑过的话 `kb_index`/`kb_search`/`kb_read` 会出现在工具表里，直接调一次 `kb_index` 能返回数据就是最终实证；辅助判据是 `dev_plugin_status` 的 `[disabled]` 标记。
- 因此 dsh-kb 改走**官方装配**：`dev_install_package(dir, profile='desktop')` → profile `package.json` 的 `dependencies: link:<plugins-dir>\dsh-kb` + `dsh.profile.bundles` 里都有 `dsh-kb`，junction 已建（`cordis.patch.yml` 保持干净，**不要**再加 insert，否则与 bundles 双装配）。
- **需要重启一次 DSH Desktop** 才会真正装配（重启后由 bundles 列表加载，双路径一致）。touch patch 触发 `include.refresh` 在本机实测无效。
- 结论：本机每个阶段的"在宿主内验收"都要重启一次；不依赖宿主的验证走下面两个冒烟脚本。
- **补充实测（2026-09-14，dsh-kb 已装配到 bundles 之后）**：`dev_reload_package('dsh-kb')` 返回 `OK: 坏缓存兜底重载完成（无旧代回滚）`、fiber 前后都是 `[active]`，看起来成功，但**运行中的代码没有换**：紧接着调 `kb_index({})` 仍然报 P1 那个 `value is not lossless JSON`（该 bug 在磁盘代码里早已修掉，且现在有 `tool-output-smoke` 断言）。判据很硬：**重载后调一次带已知修复的工具，看它有没有体现修复**。所以：bundle 装配的插件，代码改动**只能靠重启**（`dev_reload_package` 对 `[injected]` 的超级模组有效，对本机 bundles 装配的插件无效）。

### 客户端改动怎么生效

`dsh-client-modules` 用 `public, max-age=31536000, immutable` 下发客户端 bundle，并按内容哈希拼 URL。所以改完 `lib/client.js` 后：**先硬刷新页面（Ctrl+Shift+R）**；若界面没变，说明宿主没有重新计算哈希（本机 HMR/重载都降级）→ 需要重启一次。

### 侧边栏入口（UI）

入口注册在 `sidebar.footer.action`（槽主 = ui-sidebar），面板是插件自己的全屏 overlay（点击即打开"前端页面"）。

- 组件签名 `Launcher({ wide, sessions, workspaces, modelDirectories })`：**`wide` 是槽主作为 owner prop 传进来的**（与 cardian 同一机制），注册时必须把 `ownerProps` 透传给组件，否则永远拿到 `undefined`。
- 宽态 = 整行「图标 + 知识中心」文字按钮；rail 态 = 36×36 圆钮（样式对齐 cardian 的 `cardian-kt-trigger`，用宿主 `--dsw-alias-*` token）。
- `wide` 缺失时按宽态渲染（保证文字一定可见 —— 2026-09-14 用户明确要求"不要只有图标，要显示一个知识中心"）。

### 事故记录：2026-09-14 启动失败（已修复 + 已加回归测试）

用户重启后 DSH Desktop **启动不起来，删掉 dsh-kb 才能启动**。桌面壳日志（`%APPDATA%\DSH Desktop\logs\dsh-<date>.log`）给出精确栈：

```
Error: dsh-plugin-desktop: plugin tree failed to load:
  failed to apply loader entry dsh-kb (dsh-kb): cannot get property "tools" without inject
    at register (<plugins-dir>/dsh-kb/lib/tools.js:28:12)
    at registerKbTools (…/lib/tools.js:64:3)
    at new apply (…/lib/index.js:558:3)
```

**根因**：这个 cordis 是**严格 inject/provide 契约** —— 插件没声明 `inject` 时读 `ctx.<service>` **直接抛异常**（不是返回 undefined）。我那句"防御性判断" `if (!ctx.tools || typeof ctx.tools.register !== 'function') return` 本身就踩线：`ctx.tools` 的读取先抛，而且发生在 `apply()` 期间 → 整棵插件树加载失败 → 宿主起不来。workbench 从不碰 `ctx.tools`（只用动态 `ctx.inject(['webServer'])`）所以没事；cardian 有 `export const inject = ['tools']` 所以也没事。

**修复**：`lib/index.js` 补上
```js
export const name = "dsh-kb";
export const inject = ["tools"];
```
（`webServer` 继续走动态 `ctx.inject(['webServer'])`，无需静态声明。）

**防回归（三层，`npm test` 一条命令全跑）**：

1. `scripts/cordis-load.mjs` —— 用 **DSH 安装目录里真实的 cordis**（`D:\DSH Desktop\resources\app\node_modules\@deepseek-ai\cordis`）加载本插件：`ctx.provide('tools'|'webServer', stub)` 装桩 → `ctx.plugin(mod)`。最接近真实启动的验证，**同类错误在这一步就会炸，不用等你重启**。
2. `scripts/host-smoke.mjs` —— 假 ctx 升级成**严格 inject 模拟**（读未声明的服务即抛；`ctx.inject(deps, cb)` 回调收到派生 ctx），并加**反向对照**：用 `allowed=∅` 的 ctx 再跑一次 `apply()`，断言必须抛错 —— 证明这个测试真能抓住本次根因。
3. `lib/tools.js` 守卫处加注释，写明它合法**仅因为** `inject` 已静态声明，防止后人误删。

> 教训：**`apply()` 里读任何 `ctx.<service>` 之前，先确认它在 `inject` 里；在这个 cordis 上"防御性 undefined 判断"不是防御，是引信。**
> 另外 fail-soft 内核补丁当前是 rolled-back（`needs-adaptation`）→ **没有自动隔离兜底**，插件抛异常会直接拖垮启动 —— 所以真实 cordis 加载测试是装配/重启前的必过闸门。

### 事故记录：工具结果必须是"无损 JSON"（2026-09-14，抓到两个真 bug）

宿主在每次工具调用后会用 `@deepseek-ai/dsh-util-values` 的 `snapshotJsonValue()` 校验返回值，**任何一个属性是 `undefined`（或 NaN / -0 / 稀疏数组 / 非普通原型）就整条调用失败**：

```
tool "kb_index" returned invalid output: value is not lossless JSON
```

这个错误在 `execute()` 里根本不会出现 —— 进程内冒烟直接调 `execute()`，**从不经过宿主的输出校验**，所以它是唯一能从"冒烟全绿"漏到"真机报错"的失败模式：

1. P1 的 `kb_index({})` 会带上值为 `undefined` 的键 → 真机上每次都报这个错（改法是"只在有值时挂键"）。
2. 写这个测试时又抓到第二个同类 bug：`kb_backlinks` / `kb_related` 对**没有 `type` 的普通笔记**返回 `type: undefined`（设计上"无 type 即普通笔记"，所以这个字段本来就不该出现）→ 只要库里有普通笔记，这两个工具在真机上必然失败。修法：`...(x ? { type: x } : {})`。

**防回归**：`scripts/tool-output-smoke.mjs` —— 直接 `import` **DSH 安装目录里真实的校验器**，把工具结果一个个喂给 `snapshotJsonValue()`；失败时还给出精确路径（`result.backlinks[0].type = undefined`），比宿主那句笼统报错有用得多。

```powershell
node scripts/tool-output-smoke.mjs              # 一次性临时 vault：22 个工具全跑（含写入路径）
node scripts/tool-output-smoke.mjs --readonly   # 真实 vault：11 个只读工具（绝不写盘、绝不删除）
```

> 教训：**凡是会返回给宿主的对象，都不要留 `undefined` 值**（`JSON.stringify` 会悄悄丢掉它们，宿主的校验器不会）。可选字段一律用条件展开。

### 冒烟脚本（不依赖宿主）

```powershell
npm test                             # 全量闸门：check(语法+构建) + 下面 5 个冒烟 + 真实 cordis 加载
node scripts/kb-smoke.mjs            # core：全库索引 / L1 检索 / origin 分级 / L2 读取 / 路径越界
node scripts/kb-smoke.mjs <vault-path> --write-index   # 额外真写 <项目>/INDEX.md
node scripts/host-smoke.mjs          # host：假 ctx 驱动 apply()，验证路由注册 + 工具注册 + 真实执行
node scripts/p2-smoke.mjs            # P2 沉淀闭环（一次性临时 vault）
node scripts/p3-smoke.mjs            # P3 RepoWiki（一次性临时 vault + fixture 仓库，含面板 6 条路由）
node scripts/p4-smoke.mjs            # P4 洞察 / 导入导出 / 技能包 / 反馈
node scripts/p5-smoke.mjs            # P5 缺口 / 图谱 / 索引自愈
node scripts/tool-output-smoke.mjs   # 每个工具结果过宿主校验器 snapshotJsonValue()
node scripts/cordis-load.mjs         # 用 DSH 安装目录里真实的 cordis 加载插件（22 工具 + 29 路由 + 1 提示词 section）
```

`p2`~`p5` 全部跑在 `%TEMP%` 一次性 vault（p3 额外一个一次性 fixture 仓库）上，**绝不触碰真实 vault**。
`host-smoke.mjs` 覆盖 24+13 项：3 条新路由 + 3 个工具在册、原有 13 条路由未破坏、**系统提示词 section（含 9 个要点覆盖断言）**、L0 项目清单、单项目 INDEX.md、L1 命中与 origin 闸门、项目过滤、L2 截断、路径越界拒绝、隐藏目录拒绝、工具直接执行、缺参结构化错误。

## 与来源插件的差异（要点）

- cardian 的 `core/store.js` 把 `SECTIONS`（Cards/Memory/Repos）写死；dsh-kb 需要 Indexer 支持**任意 roots**（默认整个 vault，排除 `.obsidian` 与隐藏目录）。
- cardian 的 MOC 只维护三分区 README；dsh-kb 改成维护**每项目的 `INDEX.md`**。
- workbench 完全不碰 frontmatter；dsh-kb 的写入路径必须维护 `type/origin/confidence/updated` 等元数据。

## License

MIT（继承两个来源项目的许可）。
