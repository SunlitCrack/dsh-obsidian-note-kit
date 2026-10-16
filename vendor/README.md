# vendor · 内置依赖副本

本目录存放**本方案直接依赖、且无法从包管理器直接获取**的插件源码副本。

## dsh-plugins/dsh-kb

| 项 | 说明 |
|---|---|
| 来源 | `dsh-kb` 插件 v0.1.0 |
| 许可 | MIT，见其目录下的 `LICENSE` |
| 为什么内置 | 它以本地 `link:` 方式装配（不是 npm 包），且是本方案"查重 / 检索 / 索引"能力的唯一提供者 |
| 内置时的处理 | ① 排除 `node_modules`；② 对本机路径做脱敏（见下） |

`lib/` 下的 web 面板产物保持**已构建状态**，无需重新构建。

## 本副本相对上游的改动

### 1. 排除 `node_modules`

上游目录含 `node_modules`（约 14 MB）。本副本不纳入——需要时在其目录里装一次即可。

### 2. 本机路径脱敏

上游源码的文档与测试脚本里带着作者本机的绝对路径。这些不应随仓库分发，已全部换成占位符：

| 文件 | 改动 |
|---|---|
| `README.md` | 7 处：`<plugins-dir>` 替换原插件目录；`<本地仓库绝对路径>` / `<仓库名>` / `<文件数>` 替换原仓库扫描示例；`<vault-path>` 替换原库路径 |
| `scripts/host-smoke.mjs` | 去掉硬编码的 vault 默认值，改为 `process.argv[2] \|\| process.env.OBSIDIAN_VAULT_PATH` |
| `scripts/kb-smoke.mjs` | 同上，删掉末尾的硬编码默认值 |
| `scripts/tool-output-smoke.mjs` | 同上 |
| `lib/client-source.js` | 表单 placeholder 的示例路径 → `D:\code\my-repo`（通用示例） |
| `lib/client.js` | 同上（构建产物，手工同步以保证与源码一致） |

> `lib/client.js` 由 `lib/client-source.js` 构建而来，两处都已改；重新构建会从已脱敏的源码生成，结果一致。

**跑这些 smoke 脚本时请显式传库路径，或设 `OBSIDIAN_VAULT_PATH` 环境变量——不再有默认值。**

### 3. `kb_doctor` 增加 `origin` 覆盖提示（本方案的适配）

本方案要求新笔记显式标注来源分级 `origin`。该字段缺失时 `originOf()` 会兜底成 `local`，外部资料与推理内容会被当成"本地已验证知识"召回。为让漏填可被检出，`core/kb.js` 的 `doctor()` 增加一条**聚合** info 提示（不逐篇刷屏）：

| 位置 | 改动 |
|---|---|
| `doctor()` 文档注释（约 886 行） | 检查项清单加入 missing `origin` |
| `doctor()` 逐篇循环内（约 917 行） | 收集 `fm.origin` 为空的笔记 |
| `doctor()` 循环之后（约 938 行） | 报一条 info：缺 `origin` 的篇数 + 前 10 条路径 |

合计 +20 −2 行。判读口径（只约束新笔记、存量不回填）见 `skills/obsidian-note-placement/references/local-adaptation.md` §6。

> 该改动属于"因本方案需要额外适配"，合并上游时需保留。

## 未纳入本目录的邻居插件

`dsh-skills-mcp-manager`、`dshmarket` 等依赖**自带独立 git 仓库与发布渠道**。直接内置会把另一个项目的完整 git 历史混进本仓库，因此未纳入——获取方式见仓库根的 [`DEPENDENCIES.md`](../DEPENDENCIES.md)。

## 关于修改

本目录是**上游副本**，除上述两类处理外不建议再改。若因本方案需要额外适配，必须记录在本文件的表格里并注明改了哪几行，避免与上游漂移后无法合并。
