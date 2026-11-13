# dsh-kb

DSH 的本地知识发现插件：对 Obsidian vault 做原地索引，提供中文/英文 BM25 检索、来源分级、按需正文读取、只读体检和结构化知识缺口。

## 边界

- vault 顶级目录视为项目；Markdown 笔记原地索引，隐藏目录和非知识派生目录不进入索引。
- `origin: local` 与缺失来源的 `origin: unlabeled` 默认参与 `kb_find`；`web` / `inferred` 只有显式请求才进入结果。
- L0 项目索引由 `kb_find({ project })` 在内存中渲染，不新写磁盘 `INDEX.md`。已有索引文件不迁移、不删除。
- dsh-kb 不写笔记正文，不管理 Inbox 审批，不提供文件编辑器写入、移动、删除、导入导出或批量快照。
- Obsidian MCP 是 DSH 环境的唯一笔记 writer：`create_note`、`append_note`、`patch_note`、`replace_in_note`、`patch_frontmatter`、`move_note`、`delete_note`、`undo_write`。正文改写先读取 `contentHash`，再传 `prevHash`。
- `kb_gap` 是唯一结构化写入特例，维护项目 `Inbox/缺口.md` 的确定性缺口 ID；它不写知识笔记正文。
- 主题、界面、插件配置不属于 dsh-kb 知识索引，按对应文件工具与 Obsidian 配置流程处理。

## 模型工具

| 工具 | 用途 |
|---|---|
| `kb_find` | 无 query 时返回项目清单或项目 L0；有 query 时返回来源过滤后的 BM25 结果、摘要和片段 |
| `kb_read` | 按路径读取 frontmatter 与正文 |
| `kb_doctor` | 只读检查标题、来源标注、过期、断链、重复标题和未补缺口 |
| `kb_gap` | `list` / `add` / `resolve` 结构化缺口 |

`/kb` 命令提供 `status`、`find`、`doctor`、`gaps`、`help`。技能加载时，插件可把相关本地笔记作为附加上下文；已移除回合沉淀催促。

## 构建和测试

```powershell
npm install
npm test
```

`npm test` 覆盖核心索引、来源闸门、L0 内存渲染、工具输出的无损 JSON、skill 上下文、命令注册和真实 Cordis 装载。`npm run build:client` 构建只读知识面板。

## 安装

插件目录：`D:\dsh-plugins\dsh-kb`。以 DSH profile 的 link/bundle 方式装配后重启 DSH。修改 `lib/client-source.js` 后重新运行 `npm run build:client`。
