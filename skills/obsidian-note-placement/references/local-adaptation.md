# 本地适配层 · 环境事实（obsidian-note-placement）

> **这是模板，clone 下来后先把占位符换成你自己的库事实再使用。**
> 本文件记**环境的事实**，与"哪个 agent 在读"无关：库在哪、归类总表在哪、各项目的分类表与登记点、移动笔记的本机做法。
> **本文件在同一环境的所有 agent 下应当逐字节一致**——环境值只有这一处真源，改完复制到各处。
> "本 agent 能用什么工具、有什么能力限制"不放这里，见同目录 `harness.md`。
> 换库或换工作时：替换本文件（或删掉它，退化为纯通用流程）；`SKILL.md` 的判定流程与规则不动。
> **真源与分发**：本方案会在多处存在副本（用户级 skill 目录、项目级 skill 目录，各宿主各有自己的解析顺序，项目级通常优先）。**先指定其中一份为真源，改动一律从真源发起再分发到各处**——只改一处会造成加载漂移。

## 1. 库与规则文件位置

- 笔记库路径：`<绝对路径>`（若有其它写法如 POSIX 风格，一并写明）
- **归类总表**：`<库根的文件名>`——项目边界、体裁表、命名对照、裁决先例、目录结构纪律
- **项目内分类表**（每个一级项目一份）：

| 一级项目 | 项目内分类表 |
|---|---|
| `<项目A>` | `<路径>` |
| `<项目B>` | `<路径>`（或"暂无，笔记少，直接看目录"） |

- **自动索引**：若工具会扫描目录生成索引（如 `INDEX.md`），它是**只读、不要手改**的；人维护的登记表（如 `index.md`）才是要写的那个。**二者常只差大小写，不要混**。
  若你的库没有自动索引，这条忽略。

## 2. 登记对照表（写完必须登记的手维护索引）

| 落点 | 手维护登记点 |
|---|---|
| `<落点A>` | `<登记点1>` + `<登记点2>` |
| `<落点B>` | `<登记点>` |
| 其它项目的 `<项目>/故障手册/...` | `<登记点>` |
| 任何新建目录 | 所属项目的项目内分类表 + 目录配套动作（见 §4） |

登记行格式沿用各索引既有行的格式；写作 skill 的适配层里若有更细的行格式，以那边为准。

## 3. frontmatter 最小归类字段（新笔记）

- `tags` 第 1 位 = 项目标签，第 2 位 = 体裁或一级分类；其后自由
- `summary` 必填（自动索引页的摘要就是它；检索走正文，不依赖本字段）。缺了会回退显示**正文首行**，所以正文首行要写一句人话，别以 `##` 节名开头
- **来源分级 `origin`（用按来源分级的索引工具时必填）**：本地实测或使用者确认 → `local`；外部资料 → `web`；自行推理未验证 → `inferred`。**缺该字段时工具按 `local` 处理**，外部内容会被默认检索当成已验证知识
- 体裁 skill 规定的其它字段照其规定
- 只约束新笔记；存量是否回填由你定，回填了就写明回填范围

| 一级项目 | 项目标签（`tags` 第 1 位） |
|---|---|
| `<项目A>` | `<标签>` |

## 4. 目录配套动作（可选）

> 通用层说的「**目录配套动作**」在本库具体指什么。如果用 Obsidian + Iconize，就是配图标；**如果你不用 Obsidian 或没装该插件，把本节整节删掉即可，通用层不会因此失效**。

- 规范见：`<规范文档路径>`
- 一句话版：`<命令或操作>`
- 写入是否成功以 `<落盘物，如 data.json 的键>` 为准；`<副作用与验证方式，如"侧边栏要重启应用才刷新，不要据此判断失败">`

## 5. 搜索与移动的本机做法

**命令形态按当前运行环境选**：同一台机器上，不同 agent 会话的默认 shell 与 PATH 不同。自测 `grep`（`Get-Command grep` / `which grep`）：**有 GNU grep 用通用层的 bash 版命令，没有就用本机 shell 的等价写法**。

> **不要拿 `bash` 当判据**：Windows 上 `Get-Command bash` 可能命中 WSL 启动器（不认 `/d/...` 路径）；Git Bash 必带 grep，**grep 在不在才是准的**。

- 库**没有版本管理**时，批量移动前先整库备份到库外：
  ```bash
  <备份命令，注明在哪个 shell 下执行>
  ```
- **备份完立刻试解压校验**，并在包名旁注明用什么工具打的——不同 `tar` 实现对非 ASCII 路径的处理不互通，混用会解出一堆乱码和缺失文件。
- 在库外用文件工具移动，**库不会自动改链接**：移动前查出所有全路径链接，移动后逐条改成新路径
- 短链接（按文件名解析）移动后不受影响，前提是**文件名在全库唯一**（移动前确认目标位置没有同名文件）
- 移动后同步改：`tags` 等元数据、手维护索引里登记的路径
- 移动记录写进 `<操作记录目录>`，含"原路径 → 新路径"清单，便于回滚

## 6. 来源分级 `origin` 的检出

`origin` 缺失时按来源分级的索引工具通常按 `local` 处理（`dsh-kb` 的 `originOf()` 缺省即 local），而存量笔记大多没有这个字段——**光在骨架里写"必填"不够，得能检出漏填**。

新笔记写完，回读时用文件工具核对 frontmatter 里有 `origin:` 键；给全库做普查用下面两条命令（等价，后者按 YAML 精确解析，不漏块列表与多行值）。

PowerShell：

```powershell
$vault = '<vault 绝对路径>'
Get-ChildItem $vault -Recurse -Filter *.md |
  Where-Object { $_.FullName -notmatch '\\\.' -and $_.Name -notlike 'INDEX.md' } |
  ForEach-Object {
    $t = Get-Content $_.FullName -Raw
    if ($t -match '^---' -and $t -notmatch '(?m)^origin:\s*\S') {
      [pscustomobject]@{ 路径 = $_.FullName.Replace("$vault\", ''); 改动 = $_.LastWriteTime.ToString('yyyy-MM-dd') }
    }
  } | Sort-Object 改动 -Descending | Format-Table -AutoSize
```

Python + PyYAML：

```bash
python - <<'PY'
import pathlib, yaml
vault = pathlib.Path(r'<vault 绝对路径>')
missing = []
for p in vault.rglob('*.md'):
    if any(part.startswith('.') for part in p.parts) or p.name.startswith('INDEX'):
        continue
    text = p.read_text(encoding='utf-8-sig', errors='replace')
    if not text.startswith('---'):
        continue
    try:
        fm = yaml.safe_load(text.split('---', 2)[1]) or {}
    except Exception:
        missing.append((str(p.relative_to(vault)), 'frontmatter 解析失败'))
        continue
    if not fm.get('origin'):
        missing.append((str(p.relative_to(vault)), str(fm.get('updated') or '')))
print(f'缺 origin：{len(missing)} 篇')
for path, updated in missing[:50]:
    print(' -', path, updated)
PY
```

判读口径：约定只约束新笔记、存量不回填，输出里越早的条目优先级越低；要处理的是刚写的那几篇。装了本仓库内置的 `dsh-kb` 时，`kb_doctor` 会报一条**聚合**提示（缺 `origin` 的篇数 + 前若干路径，不逐篇刷屏）；上面两条命令用于按需普查与定位到具体文件。
