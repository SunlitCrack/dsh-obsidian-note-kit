# 依赖清单

分六类。标「必需」的缺了方案无法完整工作；标「可选」的按目标环境取舍。**已内置的依赖**在下面单列并标出路径。

## 已内置

| 路径 | 是什么 | 许可 |
|---|---|---|
| `vendor/dsh-plugins/dsh-kb/` | 必需的 DSH 知识库插件源码 | MIT，随附原 `LICENSE` |

内置时**排除了 `node_modules`**（体积 16 MB → 1.6 MB），运行期依赖很少，需要时在其目录里装一次即可。`lib/client.js` 是已构建好的 web 面板产物（约 1.1 MB），**不需要重新构建**——只有改过 `lib/client-source.js` 才要跑 `npm run build:client`。

---

## A. 宿主 agent（任选其一）

| 依赖 | 说明 | 必需 |
|---|---|---|
| DSH / Qoder / Claude Code / Codex | 任一能加载 skill、能读写文件的 agent | 是 |

> 三份 skill 的 `references/harness.md` 按宿主分别描述写入通道；换宿主时重写它即可。

## B. DSH 插件（以 DSH 为宿主时）

| 插件 | 作用 | 获取方式 | 必需 |
|---|---|---|---|
| `dsh-kb` | `kb_*` 工具族：L0 索引 / 分层检索 / 收件箱 / 库体检 / 索引重建 | **本仓库内置** → `vendor/dsh-plugins/dsh-kb/` | 是 |
| `dsh-skills-mcp-manager` | 浏览 / 启停 / 导入 skill 与 MCP 服务器 | 未内置——它自带独立 git 仓库与发布渠道，从你的来源获取 | 可选 |
| `dshmarket` | 插件市场与安装通道 | 包管理器 | 可选 |

> **为什么只内置 `dsh-kb`**：它是本方案的实际依赖，且以本地 `link:` 方式安装（不是 npm 包，光看依赖声明会以为能从包管理器装）。其余插件要么能从包管理器直接获取，要么自带独立仓库——直接内置会把另一个项目的完整 git 历史混进本仓库，得不偿失。

> `dsh-kb` 也是唯一提供「自动索引 + 检索 + 收件箱」的工具。**若宿主不是 DSH**，用别的检索手段替代即可——通用层只要求"能查重、能检索"，不绑定具体工具。

## C. Obsidian 插件（以 Obsidian 为笔记库时）

均未内置——从 Obsidian 社区插件市场安装即可。

| 插件 | 插件 id | 作用 | 必需 |
|---|---|---|---|
| Iconize | `obsidian-icon-folder` | 目录图标——**即通用层所说的「目录配套动作」** | 否 |
| Claude Code MCP | `claude-code-mcp` | 给 agent 一条 HTTP 写入通道（默认端口 22360） | 否 |
| Supercharged Links | `supercharged-links-obsidian` | 按前置元数据渲染链接样式 | 否 |
| Style Settings | `obsidian-style-settings` | 主题参数面板 | 否 |
| Hider | `obsidian-hider` | 界面元素隐藏 | 否 |
| Excalidraw | `obsidian-excalidraw-plugin` | 笔记配图（骨架用 mermaid 即可，此为增强） | 否 |

> **不用 Obsidian 也可以**：本方案只要求"一个 markdown 笔记库 + 某种检索手段"。此时 C、E 两类整类去掉，适配层里的图标一节整节删掉，**通用层不受影响**——这是把图标从通用层移出去的直接好处。

> **插件 id 变更提醒**：Iconize 与 Supercharged Links 都改过 id。旧 id `obsidian-iconize`、`obsidian-supercharged-links` 已失效——若在 `community-plugins.json` 里看到它们，属历史残留，不影响功能。

## D. 本机工具链

| 工具 | 用途 | 必需 |
|---|---|---|
| `tar` | 整库备份与还原 | 做批量移动时必需 |
| Git Bash 或等价 POSIX shell | 跑通用层给的 bash 参考命令 | 可选 |
| Python + PyYAML | frontmatter 的 YAML 合法性与类型校验 | 可选（验证用） |

> **两个 tar 对中文路径不通用**：Windows 自带 `tar`（bsdtar）与 Git 自带 `tar`（GNU tar）互不兼容——GNU tar 打的包用 bsdtar 解会报 `Invalid empty pathname` 并漏掉大量文件，反过来则通常正常。
>
> 结论：**备份与回滚必须用同一个工具**，优先用系统自带那份（兼容性更好）；**打完包立刻试解压校验**（数条目、数文件），并在包名旁注明打包工具。

## E. 随方案走的脚本

| 文件 | 作用 | 必需 |
|---|---|---|
| 配图标的写入脚本 | 写目录图标（依赖 Iconize） | 用配图标时必需 |
| 图标规范文档 | 图标命名前缀、配色语义、核对命令 | 同上 |

> 这两个属于**各环境的实现**，不在本仓库内。用自己的方式配图标即可——只要在适配层里记下做法，通用层不关心你用什么脚本。

## F. 外部素材库（只读，可选）

知识笔记常从排障知识库、最佳实践库、官方文档里提炼机制。若你的环境里有这类只读素材库，在适配层的「素材源」一节记下路径；没有就不填，**通用层不依赖它**。
