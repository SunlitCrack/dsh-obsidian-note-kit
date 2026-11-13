// dsh-kb knowledge base service — the layer that turns a whole Obsidian vault
// into an agent-readable knowledge base, *in place*.
//
// Model (frozen 2026-09-14):
//   * a **project** is a top-level directory of the vault (`k8s/`, `启智平台管理/`, …);
//   * every `.md` in the vault is indexed in place — nothing is copied and no
//     cardian-style `Cards/ Memory/ Repos/` sections are required;
//   * `type:` in frontmatter only decides *extra* capabilities
//     (`card` / `memory` / `wiki`); a note without `type:` is a plain note;
//   * **L0 → L1 → L2 progressive disclosure**: `<project>/INDEX.md` (L0) is the
//     entry point an agent reads first, `kb_search` returns L1 metadata, and
//     `kb_read` fetches L2 bodies only when a note is actually needed;
//   * **origin grading** (`local` | `web` | `inferred` | `unlabeled`) keeps
//     web/inferred material out of default recall, so the vault cannot be
//     silently polluted from the internet. A note with **no** `origin:` field
//     is `unlabeled` — "this file was never tagged", NOT "suspicious": the
//     hand-written notes that bypass `kb_capture` all look like that. It stays
//     in default recall (see DEFAULT_ORIGINS) but is reported as `unlabeled` so
//     the honest label survives into search results.

import path from 'node:path'
import fs from 'node:fs'
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js'
import { NotFoundError, ValidationError } from './errors.js'
import { slugify, shortHash } from './slug.js'
import { LinkIndex, extractWikilinks } from './links.js'

/** Legacy cardian section directories: derived copies, not the user's notes. */
export const LEGACY_SECTION_DIRS = ['Cards', 'Memory', 'Repos']
export const INDEX_FILE = 'INDEX.md'
/** Staging area: new knowledge lands here first and stays OUT of the index. */
export const INBOX_DIR = 'Inbox'
/** The rolling "what the library does not know yet" list, one per project. */
export const GAP_FILE = '缺口.md'
/**
 * Origins returned by default.
 *
 * `unlabeled` 必须在里面：全库 99/222 篇手写笔记没有 `origin:` 字段，加三态
 * 之前它们被兜底成 `local` 召回。若默认集合只留 `local`，这 99 篇会在一夜
 * 之间从检索里消失 —— 那是彻头彻尾的回归。`unlabeled` 只改变**展示**口径
 * （如实标出来源未标注），不改变召回面。`web` / `inferred` 仍须显式索取。
 */
export const DEFAULT_ORIGINS = ['local', 'unlabeled']

/** Every origin value the system understands, including the "never tagged" state. */
export const ORIGINS = new Set(['local', 'web', 'inferred', 'unlabeled'])

function normalizeRel(value) {
  const rel = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!rel) throw new ValidationError('缺少 path')
  const parts = rel.split('/')
  if (parts.includes('..')) throw new ValidationError(`非法路径: ${value}`)
  // Same boundary the vault tree UI enforces: `.obsidian` (and every other
  // hidden entry, including `.dsh-trash`) stays closed to the knowledge base.
  if (parts.some((part) => part.startsWith('.'))) {
    throw new ValidationError(`隐藏目录不开放访问: ${value}`)
  }
  return rel
}

function topSegment(rel) {
  const i = rel.indexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}

function subDir(rel, project) {
  const rest = project ? rel.slice(project.length + 1) : rel
  const i = rest.lastIndexOf('/')
  return i === -1 ? '' : rest.slice(0, i)
}

/**
 * 一篇笔记在 L0 索引里所属的分组标签：项目内的磁盘目录。
 *
 * 早先 type=wiki 的页面在磁盘上是扁平的（`<repo>/src-a.md`）却用
 * frontmatter.path 表达真实源码目录，所以这里有过一个 wiki 分支。RepoWiki
 * 已下线（全库 0 篇 type=wiki），那个分支不会再命中，已移除。
 */
function groupOf(rel, frontmatter, project) {
  return subDir(rel, project ?? topSegment(rel))
}

// ---- 缺口清单（gap list）的解析/序列化 -----------------------------------
// 每行一条，单行格式便于解析，同时在 Obsidian 里仍然可读可勾选：
//   - [ ] <!--gap:ab12cd34--> **库里缺什么**（来源：…；线索：…；记录：2026-09-14）
const GAP_RE = /^- \[( |x)\] <!--gap:([0-9a-f]+)--> \*\*(.+?)\*\*(.*)$/

function parseGaps(body) {
  const out = []
  for (const raw of String(body ?? '').split('\n')) {
    const m = GAP_RE.exec(raw.trim())
    if (!m) continue
    const meta = {}
    for (const part of String(m[4] ?? '').replace(/^[（(]|[）)]$/g, '').split('；')) {
      const kv = /^\s*(来源|线索|origin|记录)\s*[:：]\s*(.*)$/.exec(part.trim())
      if (kv) meta[kv[1]] = kv[2]
    }
    out.push({
      id: m[2],
      done: m[1] === 'x',
      question: m[3].trim(),
      source: meta['来源'] ?? null,
      clues: meta['线索'] ?? null,
      origin: meta['origin'] ?? null,
      createdAt: meta['记录'] ?? null,
    })
  }
  return out
}

function formatGap({ id, question, clues, source, origin, createdAt }) {
  const parts = []
  if (source) parts.push(`来源：${source}`)
  if (clues) parts.push(`线索：${String(clues).replace(/\s+/g, ' ')}`)
  if (origin) parts.push(`origin：${origin}`)
  parts.push(`记录：${String(createdAt ?? '').slice(0, 10)}`)
  return `- [ ] <!--gap:${id}--> **${String(question).replace(/\s+/g, ' ')}**（${parts.join('；')}）`
}

function gapHeader(project) {
  return `# 知识缺口（${project}）\n\n> agent 检索未命中、不得不外部获取或自行推理时记在这里；补齐知识后勾掉（\`kb_gap({ action:"resolve" })\`）。\n`
}

/**
 * 一篇笔记的来源分级。**三态 + 未标注**，不再把「没写」偷偷算成 `local`。
 *
 * 缺失 → `'unlabeled'`。这不是「可疑」也不是「可能被污染」：全库 99/222 篇
 * 无字段笔记里 88 篇集中在 k8s / Obsidian-AI / 启智平台管理，正是本项目按
 * 约定体裁**手工直接写目标目录**的那批 —— 它们绕开 `kb_capture`，所以从来
 * 没有 origin 字段。真实成因是「手写路径不写 frontmatter origin」，不是外部
 * 内容混入。展示上如实标 `unlabeled`，别渲染成警告。
 *
 * `local` 只由**显式** `origin: local` 产生，于是「已验证」这个判断重新有了
 * 分量；召回面不变，因为 DEFAULT_ORIGINS 同时含 local 与 unlabeled。
 *
 * 无法识别的值（例如 `origin: 自己写的`）同样归 `unlabeled`：它确实没有做出
 * 可用的来源声明，冒充 local 才是错的。
 */
function originOf(frontmatter) {
  const raw = frontmatter?.origin
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return ORIGINS.has(value) ? value : 'unlabeled'
}

/**
 * 一条**已按磁盘解析过**的 rel 是不是「某项目根下的 Inbox 待审条目」。
 *
 * 此前三处调用点各自写 `rel.includes('/Inbox/')`，有两个真问题：
 *   1. 大小写 —— Windows 文件系统不敏感。`p/Inbox/x.md` 与 `p/inbox/x.md`
 *      指向同一个文件，但只有前者才是真正的待审区；`inbox/` 是用户自己的
 *      普通目录，里面的东西是已发布笔记。
 *   2. 不校验段位 —— `p/别的目录/Inbox/x.md` 这种深层同名目录也曾算合法待审源。
 *
 * 因此这里对**第二段**做大小写敏感的精确匹配 `Inbox`，并要求恰好三段。
 * 调用方必须先 `store.realRel()` 把路径解析成磁盘真实大小写，否则大小写
 * 不敏感的文件系统会让字符串判定与实际命中的文件不一致。
 */
function isInboxRel(rel) {
  const parts = String(rel ?? '')
    .split('/')
    .filter(Boolean)
  if (parts.length !== 3) return false
  if (!/\.md$/i.test(parts[2])) return false
  return parts[1] === INBOX_DIR
}

/**
 * `renderIndex()` 用 `encodeURI()` 生成 L0 链接（中文与空格会被编码，`#` 不会），
 * 而 agent 会把那串路径原样喂回 `kb_read`。这里只在读侧做一次容错解码：
 * 先按 decodeURIComponent（覆盖编码过的 `#`），再退回 decodeURI（覆盖
 * `encodeURI` 保留的 `#`）。解不开就原样返回，绝不让畸形转义序列抛错。
 */
function safeDecodeUri(value) {
  const raw = String(value ?? '')
  if (!raw.includes('%')) return raw
  for (const decode of [decodeURIComponent, decodeURI]) {
    try {
      const out = decode(raw)
      if (out !== raw) return out
    } catch {
      /* 不是这层编码，试下一个 */
    }
  }
  return raw
}

function firstLine(body) {
  for (const line of String(body ?? '').split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text && !text.startsWith('---') && !text.startsWith('<!--')) return text
  }
  return ''
}

// ---- L1 片段（snippet）长度与窗口选择 -------------------------------------
//
// 长度上限公式：limit = clamp(BASE + PER_QUERY_CHAR × len(query), BASE, MAX)
//
//   1. BASE = 200 —— 一条中文分句 + 它所在的引导句通常在 30–60 字，200 能装下
//      「命中句 + 前后各半句」。旧值写死 180，8KB 笔记被切成 180 字，剩下的
//      信息密度接近于零，agent 还得再调一次 kb_read。
//   2. PER_QUERY_CHAR = 6 —— query 里每个字符换 6 个正文字符。依据：中文检索词
//      本身 2–4 字，它命中时落在一个 15–45 字的分句内；6 倍是为了让**多词**
//      查询能覆盖相邻分句，而单词查询不会被无谓撑长。
//   3. MAX = 560 —— topK 默认 12，12 × 560 ≈ 6.7KB，是「一个工具结果仍能被整段
//      读进上下文」的实用上限。超过这个量级，片段就该让位给 kb_read。
//
// 窗口选择：不是取第一次命中，而是把每个命中点当作候选窗口的锚，按「窗口内
// 命中的**不同检索词**数 → 命中总数 → 更靠前」打分取最高。查询词散落在两三处
// 时，片段落在信息最密的那一段，而不是标题行或开头那截铺垫。
//
// 锚点前只留 SNIPPET_LEAD（min(60, limit/5)）的上下文，不按窗口比例留：
// 比例留法在长 query 上会给到 100+ 字的命中前铺垫，把真正有用的正文挤到窗口
// 尾部。60 字 ≈ 一个中文分句 + 半句引导，够 agent 判断上下文，又不会吃掉预算。
const SNIPPET_BASE = 200
const SNIPPET_PER_QUERY_CHAR = 6
const SNIPPET_MAX = 560
const SNIPPET_LEAD_CAP = 60
const SNIPPET_LEAD_RATIO = 0.2

// ---- 检索词数与总命中数的硬上限 -------------------------------------------
//
// 这两个数一起构成「片段抽取的扫描量有界」这条保证。**两个上限缺一不可**：
// 早先只有 SNIPPET_MAX_HITS，且每个检索词的配额写成 `Math.max(20, 400/n)` ——
// n > 20 时 floor(400/n) 归 0，下限 20 立刻接管，总命中变成 20×n，400 这个数
// 完全不参与运算。于是 2000 个检索词 × 844KB 正文实测 3396ms（旧实现在 24ms），
// 而打分阶段对每个候选窗口都 hits.filter 扫全部命中，是实打实的 O(H²)。
//
// 现在的约束写法：
//   needles.length ≤ SNIPPET_MAX_NEEDLES，且 perNeedle = floor(HITS / needles.length)，
//   于是总命中 ≤ needles.length × perNeedle ≤ SNIPPET_MAX_HITS —— 恒成立。
// 推导：needles.length ≤ floor(HITS / MIN_PER_NEEDLE) ⇒ 400/n ≥ MIN_PER_NEEDLE ≥ 1
// ⇒ floor(400/n) ≥ 1，`Math.max(1, …)` 的兜底只是 defensive，不再是决定性因素。
//
// 为什么 MIN_PER_NEEDLE 取 8：单个检索词至少要能命中 8 次，密度打分才有意义
// （少于此数时「命中数」这一维退化成 0/1，窗口选择等价于找第一个命中）。
// 由此得出 MAX_NEEDLES = 400/8 = 50 —— 一句查询里出现 >50 个不同的 ≥2 字分词
// 已经是病态输入，不是检索，截断它不损失真实场景的召回质量。
const SNIPPET_MAX_HITS = 400
const SNIPPET_MIN_PER_NEEDLE = 8
const SNIPPET_MAX_NEEDLES = Math.max(1, Math.floor(SNIPPET_MAX_HITS / SNIPPET_MIN_PER_NEEDLE))

function snippetLimit(query) {
  const charCount = [...String(query ?? '')].length
  const raw = SNIPPET_BASE + SNIPPET_PER_QUERY_CHAR * charCount
  return Math.min(SNIPPET_MAX, Math.max(SNIPPET_BASE, raw))
}

/**
 * 把 query 拆成「整串 + 各分词」，去重、去短词，全部小写化后供定位使用。
 *
 * **超出 SNIPPET_MAX_NEEDLES 的部分在这里就截掉**（不是留到配额计算里兜底）：
 * 保留顺序是「整串优先、然后按 query 里出现的先后」，被截掉的永远是尾部那些
 * 更泛的分词，整串匹配这个最有价值的检索词一定在前 50 里。
 */
function snippetNeedles(query) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const seen = new Set()
  const out = []
  for (const raw of [q, ...q.split(/[\s,，、;；|/]+/)]) {
    if (out.length >= SNIPPET_MAX_NEEDLES) break
    const needle = raw.trim().toLowerCase()
    if (needle.length < 2 || seen.has(needle)) continue
    seen.add(needle)
    out.push(needle)
  }
  return out
}

/**
 * L1 片段。**返回值始终是字符串**（空正文返回空串），不改结构、不返回数组 ——
 * kb_search 的输出契约与面板渲染都按字符串消费。
 *
 * `max` 传正数时按调用方给的上限切（历史调用方式）；省略则用上面那条公式。
 */
function snippetOf(body, query, max = 0) {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  const limit = Number(max) > 0 ? Math.floor(Number(max)) : snippetLimit(query)
  if (text.length <= limit) return text

  const needles = snippetNeedles(query)
  if (!needles.length) return text.slice(0, limit)

  const lower = text.toLowerCase()
  const hits = [] // { at, needleIndex }
  // needles.length 已被 snippetNeedles() 夹在 ≤ SNIPPET_MAX_NEEDLES(50)，
  // 因此这里的 floor 恒 ≥ SNIPPET_MIN_PER_NEEDLE(8)，`Math.max(1, …)` 只是
  // defensive。总命中数 = needles.length × perNeedle ≤ 50 × 8 = 400 = 上限，
  // 这条不等式由构造保证，不依赖运行期侥幸。
  const perNeedle = Math.max(1, Math.floor(SNIPPET_MAX_HITS / needles.length))
  for (const [needleIndex, needle] of needles.entries()) {
    let from = 0
    for (let taken = 0; taken < perNeedle; taken += 1) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      hits.push({ at, needleIndex })
      from = at + Math.max(1, needle.length)
    }
  }
  if (!hits.length) return text.slice(0, limit)

  // 打分要保持「同分取更靠前」的语义，需要按文本位置升序。
  hits.sort((a, b) => a.at - b.at)

  // 候选窗口左边界：命中点前留一小段上下文（见 SNIPPET_LEAD_CAP 的说明）。
  const lead = Math.min(SNIPPET_LEAD_CAP, Math.floor(limit * SNIPPET_LEAD_RATIO))
  const lastStart = Math.max(0, text.length - limit)
  const candidates = [...new Set(hits.map((h) => Math.min(lastStart, Math.max(0, h.at - lead))))].sort(
    (a, b) => a - b
  )

  // 滑动窗口打分：candidates 升序 ⇒ 窗口 [start, start+limit) 的左右边界都单调
  // 前进，每个命中最多进出窗口各一次，整体 O(H + C)。早先对**每个**候选窗口
  // 都 `hits.filter(...)` 扫全部命中，是 O(C×H)；命中数与候选数同阶时可到
  // 数十万次比较，正是那条「防 O(n²)」注释想避免却没防住的东西。
  let best = candidates[0]
  let bestScore = -Infinity
  const perNeedleInWindow = new Map()
  let left = 0
  let right = 0
  let total = 0
  for (const start of candidates) {
    const end = start + limit
    while (right < hits.length && hits[right].at < end) {
      const k = hits[right].needleIndex
      perNeedleInWindow.set(k, (perNeedleInWindow.get(k) ?? 0) + 1)
      total += 1
      right += 1
    }
    while (left < right && hits[left].at < start) {
      const k = hits[left].needleIndex
      const rest = (perNeedleInWindow.get(k) ?? 0) - 1
      if (rest <= 0) perNeedleInWindow.delete(k)
      else perNeedleInWindow.set(k, rest)
      total -= 1
      left += 1
    }
    if (total === 0) continue
    const distinct = perNeedleInWindow.size
    // 不同检索词优先（覆盖面），其次命中总数（密度）；同分取更靠前的窗口
    // （candidates 升序，`>` 而非 `>=` 让先到者保持优势）。
    const score = distinct * 10000 + Math.min(total, 99) * 100 - start / text.length
    if (score > bestScore) {
      bestScore = score
      best = start
    }
  }
  const head = text.slice(best, best + limit)
  const prefix = best > 0 ? '…' : ''
  const suffix = best + limit < text.length ? '…' : ''
  return `${prefix}${head}${suffix}`
}

function fmtDate(value) {
  const t = Date.parse(String(value ?? ''))
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

/**
 * Knowledge base over a whole vault.
 *
 * `store` is the cardian-derived VaultStore (vault-rooted, path-guarded) and
 * `indexer` an Indexer whose file list we override to cover the whole vault.
 */
export class KnowledgeBase {
  constructor({ store, indexer, excludes = LEGACY_SECTION_DIRS, logger = null }) {
    this.store = store
    this.indexer = indexer
    /** Excludes for enumerating *projects* (Inbox still visible to the inbox flow). */
    this.legacyExcludes = Array.isArray(excludes) ? excludes.filter(Boolean) : []
    /** Index excludes: staged `Inbox/` items must never enter the knowledge index. */
    this.excludes = [...this.legacyExcludes, INBOX_DIR]
    this.logger = logger
    // The indexer must enumerate the whole vault, not the three legacy sections.
    this.indexer.listFiles = () => this.store.allFiles({ excludes: this.excludes })
    // 反链/相关：同样要吃"整个 vault"，而不是 cardian 的三分区快照。
    this.links = new LinkIndex(store, { snapshot: () => this._snapshotAll() })
  }

  /** Whole-vault snapshot (published notes only — Inbox staging is excluded). */
  async _snapshotAll() {
    return this.store.snapshotOf(await this.store.allFiles({ excludes: this.excludes }))
  }

  get root() {
    return this.store.root
  }

  async refresh() {
    await this.indexer.ensureFresh()
  }

  /** Project names discovered from the indexed note paths, with counts. */
  projectStats() {
    const map = new Map()
    for (const [rel, doc] of this.indexer.docs) {
      const name = topSegment(rel) || '(vault 根目录)'
      const cur = map.get(name) ?? { name, notes: 0, updated: null, topics: new Set(), types: new Map() }
      cur.notes += 1
      const updated = fmtDate(doc.frontmatter?.updated)
      if (updated && (!cur.updated || updated > cur.updated)) cur.updated = updated
      const type = String(doc.frontmatter?.type ?? '').trim()
      if (type) cur.types.set(type, (cur.types.get(type) ?? 0) + 1)
      const topic = subDir(rel, name === '(vault 根目录)' ? '' : name)
      if (topic) cur.topics.add(topic)
      map.set(name, cur)
    }
    return [...map.values()]
      .map((p) => ({
        name: p.name,
        notes: p.notes,
        updated: p.updated,

        topics: [...p.topics].sort(),
        types: Object.fromEntries([...p.types.entries()].sort()),
      }))
      .sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name))
  }

  /**
   * INDEX.md 是否失真：三条判据，doctor 与 kb_reindex(fixIndexes) 共用。
   *
   * 1. `rows`   —— 索引**行数**与项目笔记数不一致。只比时间戳会漏掉"笔记被删/
   *    被移走"的情形：删掉一篇后 INDEX.md 的 updated 反而比所有存活笔记都新，
   *    于是"落后"判据永远不触发，索引里会长期留着一行指向不存在的文件。
   *    （2026-09-15 验收时实测到：删掉一张卡片后再 kb_reindex({fixIndexes:true})
   *    什么也没修，INDEX.md 里那行还在。）
   * 2. `behind` —— 笔记的 max(frontmatter.updated, 文件 mtime) 比 INDEX.md 的
   *    updated 新。只看 frontmatter 会漏掉手写笔记（它们没有 updated），所以带
   *    mtime 兜底。
   * 3. `format` —— 行数与时间戳都对，但链接指向的是**项目相对**路径
   *    （`00-索引.md`）而不是 vault 相对路径（`k8s/00-索引.md`）。前者是
   *    agent 喂回 `kb_read` 时打不开的旧格式，纯内容判据看不出来 —— 2026-10-29
   *    真机验收时 7 个项目里有 6 个正是这种「看似健康、实则读不了」的状态。
   */
  async staleProjects(project = null) {
    await this.refresh()
    const mtimes = this.indexer.mtimes ?? new Map()
    const newest = new Map()
    const counts = new Map()
    for (const rel of this.indexer.docs.keys()) {
      const name = topSegment(rel)
      if (!name) continue
      if (project && name !== project) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
      const fmAt = Date.parse(String(this.indexer.docs.get(rel)?.frontmatter?.updated ?? ''))
      const mtime = Number(mtimes.get(rel))
      const at = Math.max(Number.isFinite(fmAt) ? fmAt : 0, Number.isFinite(mtime) ? mtime : 0)
      if (at > (newest.get(name) ?? 0)) newest.set(name, at)
    }
    const stale = []
    for (const [name, at] of newest) {
      const idx = await this.store.read(`${name}/${INDEX_FILE}`)
      if (!idx) {
        stale.push({ project: name, reason: 'missing', index: `${name}/${INDEX_FILE}` })
        continue
      }
      const body = String(idx.body ?? '')
      const rows = (body.match(/^- \[/gm) ?? []).length
      const notes = counts.get(name) ?? 0
      if (rows !== notes) {
        stale.push({
          project: name,
          reason: 'rows',
          index: `${name}/${INDEX_FILE}`,
          rows,
          notes,
        })
        continue
      }
      // 旧格式：**存在任意一条**链接不以 `<project>/` 开头。只采样第一条会漏掉
      // 混合态（第一条新、第二条旧），而那种 INDEX 同样有读不了的链接。
      const links = [...body.matchAll(/^- \[[^\]]*\]\(([^)]+)\)/gm)].map((m) => m[1])
      const legacy = links.find((link) => {
        let target = link
        try {
          target = decodeURIComponent(link)
        } catch {
          /* 保持原样 */
        }
        return !target.startsWith(`${name}/`)
      })
      if (legacy) {
        stale.push({
          project: name,
          reason: 'format',
          index: `${name}/${INDEX_FILE}`,
          sampleLink: legacy,
        })
        continue
      }
      const idxAt = Date.parse(String(idx.frontmatter?.updated ?? ''))
      if (!Number.isFinite(idxAt) || idxAt < at) {
        stale.push({
          project: name,
          reason: 'behind',
          index: `${name}/${INDEX_FILE}`,
          indexUpdated: idx.frontmatter?.updated ?? null,
          newestNoteAt: new Date(at).toISOString(),
        })
      }
    }
    return stale.sort((a, b) => a.project.localeCompare(b.project))
  }

  /** L0: render one project's index in memory; never writes INDEX.md. */
  async index({ project = null, limit = 300 } = {}) {
    await this.refresh()
    const projects = this.projectStats()
    const total = [...this.indexer.docs.keys()].length
    const wanted = project === null || project === undefined || project === '' ? null : String(project)
    const markdown = wanted ? await this.renderIndex(wanted) : null
    const gaps = await this.gapList({})
    const openGaps = new Map()
    for (const gap of gaps.items) {
      if (!gap.done) openGaps.set(gap.project, (openGaps.get(gap.project) ?? 0) + 1)
    }
    for (const item of projects) {
      const count = openGaps.get(item.name) ?? 0
      if (count > 0) item.pendingGaps = count
    }

    const result = {
      vault: { path: this.root, projectCount: projects.length, noteCount: total, gapCount: gaps.open },
      projects,
      index: markdown,
      usage: {
        step1: 'kb_find({ project }) 读取内存渲染的 L0 项目索引',
        step2: 'kb_find({ query, project }) 获取来源过滤后的 BM25 结果',
        step3: 'kb_read({ path }) 按需读取正文',
        rule: '笔记落点、体裁、frontmatter 与手维护索引日志由配套 skill 决定；正文写入通过 Obsidian MCP。',
      },
    }
    if (wanted) result.entries = await this.list({ project: wanted, limit })
    return result
  }
  /** L1: metadata rows for a project (or the whole vault). */
  async list({ project = null, limit = 300, tag = null, type = null } = {}) {
    await this.refresh()
    const rows = []
    for (const [rel, doc] of this.indexer.docs) {
      if (project && topSegment(rel) !== project) continue
      const fm = doc.frontmatter ?? {}
      if (tag && !(fm.tags ?? []).includes(tag)) continue
      if (type && String(fm.type ?? '') !== type) continue
      rows.push({
        path: rel,
        title: fm.title ?? path.basename(rel, '.md'),
        type: fm.type ?? null,
        tags: fm.tags ?? [],
        summary: fm.summary ?? null,
        origin: originOf(fm),
        confidence: fm.confidence ?? null,
        updated: fmtDate(fm.updated),
        group: groupOf(rel, fm, project),
      })
    }
    rows.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    return { project, count: rows.length, rows: rows.slice(0, limit) }
  }

  /**
   * L1 retrieval. `origin` defaults to `local` + `unlabeled`, so web/inferred
   * notes stay out of recall unless explicitly requested, while notes that were
   * simply never tagged stay recallable (they are the hand-written majority).
   *
   * `type` 是「分流」闸门：`wiki` / `card` / `memory` / 任意自定义 type 精确匹配；
   * `note`（或 `plain`）= 只召回**没有 type** 的普通笔记（设计上"无 type 即普通笔记"）。
   */
  async search({ query, project = null, topK = 12, origin = null, includeWeb = false, tag = null, type = null } = {}) {
    const q = String(query ?? '').trim()
    if (!q) throw new ValidationError('缺少 query')
    await this.refresh()

    const wantType = type == null || type === '' ? null : String(type).trim().toLowerCase()
    const wantsPlain = wantType === 'note' || wantType === 'plain'

    const allowed = new Set(
      Array.isArray(origin) && origin.length
        ? origin.map((o) => String(o).toLowerCase())
        : includeWeb
          ? // 必须**包含**默认集合，否则 includeWeb:true 反而比默认更窄 —— 那 99 篇
            // 未标注手写笔记会在「允许更多来源」的调用里凭空消失。
            ['local', 'unlabeled', 'web', 'inferred']
          : DEFAULT_ORIGINS
    )

    const hits = await this.indexer.search(q, { topK: Math.max(topK * 4, 40), tag })
    const out = []
    for (const hit of hits) {
      const rel = hit.path
      if (project && topSegment(rel) !== project) continue
      const note = await this.store.read(rel)
      if (!note) continue
      const fm = note.frontmatter ?? {}
      const originValue = originOf(fm)
      if (!allowed.has(originValue)) continue
      if (wantType) {
        const noteType = String(fm.type ?? '').trim().toLowerCase()
        if (wantsPlain ? noteType !== '' : noteType !== wantType) continue
      }
      out.push({
        path: rel,
        title: fm.title ?? hit.title ?? path.basename(rel, '.md'),
        type: fm.type ?? null,
        tags: fm.tags ?? [],
        group: groupOf(rel, fm, project),
        summary: fm.summary ?? firstLine(note.body) ?? null,
        origin: originValue,
        confidence: fm.confidence ?? null,
        updated: fmtDate(fm.updated),
        score: hit.score,
        snippet: snippetOf(note.body, q),
      })
      if (out.length >= topK) break
    }
    const result = {
      query: q,
      project,
      origins: [...allowed],
      count: out.length,
      results: out,
    }
    if (wantType) result.typeFilter = wantsPlain ? 'note（无 type 的普通笔记）' : wantType
    if (out.length === 0) {
      result.note =
        '库内没有命中。落点、体裁、frontmatter 和手维护索引日志遵循四份笔记 skill；笔记正文写入、修订、移动和撤销统一使用 Obsidian MCP，并按实际 origin 标注外部或推理内容。'
    }
    return result
  }

  /** L2: the body of one note, path-guarded to the vault. */
  async read({ path: ref, maxChars = 0 } = {}) {
    const rel = normalizeRel(ref)
    // L0（`<project>/INDEX.md`）里的链接是 encodeURI 过的，agent 会原样把它
    // 喂回来。只在**读**这一侧回退解码：写路径（promote/merge/revise）仍用
    // 原始字符串，避免把文件名里真实存在的 `%` 改坏。
    //
    // 关键：解码结果**必须重新过一遍 normalizeRel**。`normalizeRel` 的隐藏段
    // 判定作用在原文上，而 `%2Eobsidian/app.json` 解码后才是 `.obsidian/…`
    // —— 只校验原文等于把 `.obsidian` 闸门整个绕开（真机实测可读出 app.json /
    // workspace.json / 插件 data.json）。解码后非法就当作未命中，退回 NOT_FOUND。
    let note = await this.store.read(rel)
    let resolvedRel = rel
    if (!note) {
      const decoded = safeDecodeUri(rel)
      if (decoded !== rel) {
        let safeRel = null
        try {
          safeRel = normalizeRel(decoded)
        } catch {
          safeRel = null // 解码后越界 / 隐藏目录：不重试
        }
        if (safeRel) {
          const retry = await this.store.read(safeRel)
          if (retry) {
            note = retry
            resolvedRel = safeRel
          }
        }
      }
    }
    if (!note) throw new NotFoundError(`笔记不存在: ${rel}`)
    const body = String(note.body ?? '')
    const truncated = maxChars > 0 && body.length > maxChars
    await this.refresh()
    const doc = this.indexer.docs.get(resolvedRel)
    return {
      path: resolvedRel,
      frontmatter: note.frontmatter ?? {},
      title: doc?.frontmatter?.title ?? note.frontmatter?.title ?? path.basename(resolvedRel, '.md'),
      origin: originOf(note.frontmatter),
      type: note.frontmatter?.type ?? null,
      chars: body.length,
      truncated,
      body: truncated ? `${body.slice(0, maxChars)}\n\n…（已截断，共 ${body.length} 字）` : body,
    }
  }

  /** Render the L0 index markdown for a project (does not write). */
  async renderIndex(project) {
    // 根目录项目的名字是 `(vault 根目录)`，但根层笔记的 topSegment 是空串，
    // 两者对不上 —— 用 `topSegment(rel) === project` 过滤会让根项目永远 0 条，
    // L0→L2 在最上面一层就断了。这里按「项目名 → 路径判定」显式分支。
    const isRoot = project === '(vault 根目录)'
    const rels = (await this.store.allFiles({ excludes: this.excludes })).filter((rel) =>
      isRoot ? topSegment(rel) === '' : topSegment(rel) === project
    )
    const notes = await this.store.snapshotOf(rels)
    const rows = notes.map(({ rel, frontmatter: fm, body }) => ({
      path: rel,
      rel: isRoot ? rel : rel.slice(project.length + 1),
      title: fm.title ?? path.basename(rel, '.md'),
      tags: fm.tags ?? [],
      summary: fm.summary ?? firstLine(body),
      group: groupOf(rel, fm, project),
      updated: fmtDate(fm.updated),
      type: fm.type ?? null,
      origin: originOf(fm),
    }))
    if (rows.length === 0 && !isRoot) {
      throw new NotFoundError(`项目不存在或没有笔记: ${project}`)
    }
    rows.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title))

    const byGroup = new Map()
    for (const row of rows) {
      const list = byGroup.get(row.group) ?? []
      list.push(row)
      byGroup.set(row.group, list)
    }

    const lines = [
      `# ${project} · 知识索引`,
      '',
      `> 由 dsh-kb 自动维护（共 ${rows.length} 篇）。这是 agent 的 L0 入口：先读本页，再按需 \`kb_read\` 正文。`,
      '> 修改本文件不会影响任何笔记内容，它只是索引。',
      '',
    ]
    for (const [group, list] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`## ${group || '（本层）'}`, '')
      for (const row of list) {
        const meta = [
          row.type ? `\`${row.type}\`` : null,
          row.updated,
          // 只有 web / inferred 需要警示。`unlabeled` 是**手写笔记的正常状态**
          // （占全库 99/222，集中在 k8s / Obsidian-AI / 启智平台管理），给它们
          // 逐行刷 ⚠️ 等于把 L0 索引变成噪音墙，而它们本身没有任何问题。
          // L1 检索结果仍如实返回 origin: 'unlabeled'（那是机器读的字段）。
          row.origin === 'web' || row.origin === 'inferred' ? `⚠️${row.origin}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
        const summary = row.summary ? ` — ${String(row.summary).replace(/\s+/g, ' ').slice(0, 120)}` : ''
        // 链接写 **vault 相对路径**（`k8s/00-索引.md`），不是项目相对路径：
        // 本文件的唯一用途是「agent 的 L0 入口，先读本页再按需 kb_read」，
        // 而 kb_read 收的就是 vault 相对路径。此前写项目相对路径（`00-索引.md`），
        // agent 照抄去读必然 NOT_FOUND —— L0→L2 链路是断的。
        lines.push(
          `- [${row.title}](${encodeURI(row.path)})${summary}${meta ? ` *(${meta})*` : ''}`
        )
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  /** Write `<project>/INDEX.md` (L0) atomically. Returns a small receipt. */
  async rebuildIndex(project) {
    const name = String(project ?? '').trim()
    if (!name) throw new ValidationError('缺少项目名')
    // 根目录项目的索引就是 vault 根的 `INDEX.md`。此前一律拼 `${name}/INDEX.md`，
    // 会在用户库里物理创建一个叫 `(vault 根目录)` 的目录 —— 垃圾目录还会被
    // projectStats() 当成新项目继续递归。
    const rel = name === '(vault 根目录)' ? INDEX_FILE : `${name}/${INDEX_FILE}`
    // 渲染是纯读（整库快照），放在临界区之外；只有「读旧 INDEX → 写新 INDEX」
    // 这一段必须原子，否则并发重建会各自基于旧 frontmatter 覆盖对方。
    const markdown = await this.renderIndex(name)
    const store = this.store
    return store.transact(async () => {
      const previous = await store.read(rel)
      const frontmatter = {
        ...(previous?.frontmatter ?? {}),
        type: 'index',
        project: name,
        generator: 'dsh-kb',
        updated: new Date().toISOString(),
      }
      await store.write(rel, { frontmatter, body: `${markdown}\n` })
      // INDEX.md is derived: keep it out of the knowledge index.
      this.indexer._purge?.(rel)
      return {
        path: rel,
        project: name,
        bytes: markdown.length,
        noteCount: (markdown.match(/^- \[/gm) ?? []).length,
      }
    })
  }

  // ---------------------------------------------------------------- P2: Inbox
  // 沉淀闭环：抽取 → 先落 Inbox（暂存，不进索引）→ 检索去重 → 归库 or 合并 or
  // 丢弃 → 刷新该项目 INDEX.md。动「已有笔记」的动作（merge/drop）由工具层
  // 走宿主 approval 审批；promote 只是把待审条目搬进正式目录，不需要审批。

  /** `<project>/Inbox/` — the staging area for unreviewed knowledge. */
  inboxDir(project) {
    return `${String(project)}/${INBOX_DIR}`
  }

  /** Stage one piece of knowledge for review. Never touches published notes. */
  /**
   * 校验并归一 targetDir 到 `<project>/<sub>`。
   *
   * 三条都必须查（都是实测过的坑，不是假想）：
   *   1. **拒绝 `..`**：早先 promote 只剥首尾斜杠，`targetDir='../proj2/x'`
   *      能把跨项目的笔记写出去，且返回值里带着 `..`。
   *   2. **必须落在该项目下**：解析后不以 `<project>/` 开头一律拒。
   *   3. **必须命中已有目录**：`store._write` 里有 `mkdir(recursive)`，
   *      拼错一个字符（`单插件实测选型` 少写「与」）就会静默长出幽灵目录。
   *      这里拿项目内已有目录集合比对，不命中就报错并给出最接近的几个。
   */
  async resolveTargetDir(project, targetDir) {
    const name = String(project ?? '').trim()
    if (!name) throw new ValidationError('缺少 project')
    const raw = String(targetDir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
    if (!raw) throw new ValidationError('缺少 targetDir（目标分类目录，如 插件生态/安装与加载）')

    // 1 + 2：用 normalizeRel 的重量级校验（拒 `..`、拒隐藏段），再确认前缀。
    const normalized = normalizeRel(`${name}/${raw}`)
    if (!normalized.startsWith(`${name}/`)) {
      throw new ValidationError(`targetDir 必须落在 ${name}/ 下：${targetDir}`)
    }

    // 3：白名单——项目内已有的目录集合（含 `<project>/<a>/<b>` 两段）。
    const known = await this.knownDirs()
    const dirs = known.get(name) ?? new Set()
    const wanted = normalized.slice(name.length + 1) // 去掉 `<project>/`
    // 硬拦截：Inbox 永远不是笔记落点（它被排除在索引外，写进去会「写成功但搜不到」）。
    if (wanted === INBOX_DIR || wanted.startsWith(`${INBOX_DIR}/`)) {
      throw new ValidationError(
        `targetDir 不能是 ${INBOX_DIR}（那里只放缺口清单，且不进索引）：${raw}`,
        { suggestion: '改用一个正式分类目录；落点约定见该项目 00-索引.md / INDEX.md' }
      )
    }
    if (dirs.has(wanted)) return { dir: normalized, sub: wanted, created: false }

    // 也允许指向「已存在的目录的父级」：如项目根下的新分类表文件
    const matches = [...dirs]
      .filter((d) => d === wanted || d.startsWith(`${wanted}/`) || wanted.startsWith(`${d}/`))
      .sort((a, b) => a.length - b.length)
      .slice(0, 3)
    throw new ValidationError(
      `targetDir 不是 ${name} 下已有目录：${raw}`,
      matches.length
        ? { suggestion: `最接近的已有目录：${matches.join(' · ')}` }
        : { suggestion: `先看 ${name}/00-索引.md 或 ${name}/INDEX.md 的目录约定` }
    )
  }

  /** `<project>` → 该项目下所有子目录（相对项目，正斜杠）。 */
  async knownDirs() {
    // 用 legacyExcludes（不含 Inbox）枚举，才能发现 Inbox 目录本身；随后显式
    // 把它从可选落点里剔掉 —— 否则 agent 可以 `targetDir: 'Inbox'` 把正式笔记
    // 塞回待审区，而 Inbox 又被排除在索引外，笔记会「写成功但搜不到」。
    const files = await this.store.allFiles({ excludes: this.legacyExcludes })
    const map = new Map()
    for (const rel of files) {
      const parts = rel.split('/')
      if (parts.length < 3) continue
      const project = parts[0]
      if (!map.has(project)) map.set(project, new Set())
      const set = map.get(project)
      // 从一层到倒数第二层都算合法落点
      for (let i = 1; i < parts.length - 1; i += 1) {
        const dir = parts.slice(1, i + 1).join('/')
        // Inbox 及其子目录（含 .dropped）不是笔记落点
        if (dir === INBOX_DIR || dir.startsWith(`${INBOX_DIR}/`)) continue
        set.add(dir)
      }
    }
    return map
  }

  /**
   * 沉淀一条知识。**默认直写正式目录**（`status: published`），不留待审。
   *
   * 为什么不再走 `<project>/Inbox/`：实测 73 次 `captured`→`promoted` 的中位时延
   * 是 4.37 秒、43 次在 5 秒内 —— 「人看过再归库」这道审核从未真正发生，Inbox
   * 只剩「会忘的待办」这一个副作用。所以取消目录，但**把它真正在做的两件事
   * 搬进来**：
   *
   *   1. **同名拦截**（原先由 `promote()` 的 `store.exists` 提供）。缺了它就是
   *      `store.write()` 的静默全量覆盖 —— 实测会把既有笔记的 `revisions` /
   *      `sources` / `summary` 一起冲掉。命中同名时**不写**，返回候选交给 merge。
   *   2. **落点校验**（见 `resolveTargetDir`）。缺了它拼错目录就长幽灵目录。
   *
   * `targetDir` 省略时落到项目根（`<project>/<slug>.md`）；给出时必须是已有目录。
   */
  async stage({
    project,
    title,
    content,
    tags = [],
    origin = 'inferred',
    confidence = null,
    source = null,
    session = null,
    kind = 'card',
    summary = null,
    targetDir = null,
  } = {}) {
    const name = String(project ?? '').trim()
    if (!name) throw new ValidationError('缺少 project（vault 顶级目录名）')
    const text = String(content ?? '').trim()
    if (!text) throw new ValidationError('缺少 content')
    const heading = String(title ?? '').trim() || firstLine(text) || '未命名'
    const slug = slugify(heading) || 'note'
    const now = new Date().toISOString()
    const originValue = ORIGINS.has(String(origin).toLowerCase()) ? String(origin).toLowerCase() : 'inferred'

    // 落点：给了 targetDir 就校验，没给就落项目根。
    const resolved = targetDir
      ? await this.resolveTargetDir(name, targetDir)
      : { dir: name, sub: '', created: false }
    const rel = `${resolved.dir}/${slug}.md`

    const candidates = await this.dedupe({ project: name, title: heading, content: text })

    const confidenceValue =
      confidence === null || confidence === undefined || confidence === ''
        ? null
        : Math.min(1, Math.max(0, Number(confidence) || 0))
    // L1 约定 `summary` 必填（`renderIndex()` 的摘要就取它，取不到才回退正文
    // 首行）。早先 stage() 不落这个字段，等于插件自己的沉淀入口违反自己的契约。
    const summaryValue = (() => {
      const given = typeof summary === 'string' ? summary.trim() : ''
      if (given) return given.replace(/\s+/g, ' ').slice(0, 200)
      const derived = firstLine(text)
      return derived ? derived.replace(/\s+/g, ' ').slice(0, 200) : null
    })()
    const frontmatter = {
      title: heading,
      type: String(kind ?? 'card'),
      tags: Array.isArray(tags) ? tags : [],
      origin: originValue,
      confidence: confidenceValue,
      source: source ? String(source) : null,
      session: session ? String(session) : null,
      status: 'published',
      captured: now,
      updated: now,
      ...(summaryValue ? { summary: summaryValue } : {}),
    }
    // 事务外声明的两个结果位：临界区里只知道「发现同名」或「确实写成了」。
    let conflict = null
    let wrote = false
    await this.store.transact(async () => {
      // **同名拦截**：命中已有笔记就绝不写。这是替代 Inbox 的那道防线 ——
      // 原先每次进正式目录都会经过 promote 的 `store.exists`，现在直写必须自带。
      // 判定与写入必须在同一个临界区：拆开的话，两个并发 capture 会双双读到
      // 「不存在」，然后后者静默覆盖前者。
      const realExisting = await this.store.realRel(rel)
      if (realExisting) {
        conflict = realExisting
        return
      }
      await this.store.write(rel, { frontmatter, body: `${text}\n` })
      wrote = true
    })
    if (!wrote) {
      return {
        ok: false,
        code: 'EXISTS',
        conflict,
        project: name,
        title: heading,
        candidates,
        next:
          `目标已存在，**没有写入任何内容**。若只是补充既有内容：` +
          `kb_capture 换一个 title，或让用户确认后用 kb_inbox({action:"merge", path:"<新 Inbox 路径>", into:"${conflict}"})（需批准）。` +
          `若确认要替换：先用 obsidian MCP 的 move_note 备份或人工确认，不要硬写。`,
      }
    }
    let index = null
    try {
      index = await this.rebuildIndex(name)
    } catch {
      index = null // 项目还没有可渲染的笔记时 rebuildIndex 会抛，索引稍后自愈
    }
    return {
      captured: rel,
      staged: rel, // 兼容旧调用方字段名
      project: name,
      title: heading,
      targetDir: resolved.sub || null,
      origin: originValue,
      status: 'published',
      candidates,
      index,
      indexRefreshed: Boolean(index),
      next: candidates.length
        ? `已直接落库（不再有待审环节）。若发现与候选同主题、应当合并而非新建：` +
          `让用户确认后走 merge（需批准），或直接用 obsidian MCP 移动/合并。`
        : `已直接落库。落点如不合适，用 kb_move 迁到正确目录（会提示 wikilink 风险）。`,
    }
  }

  /** Rank published notes as merge candidates for staged content (L1 search). */
  async dedupe({ project = null, title = '', content = '', topK = 5 } = {}) {
    const headings = String(content ?? '')
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .slice(0, 3)
    const query = [title, firstLine(content), ...headings].filter(Boolean).join(' ').slice(0, 300)
    if (!query.trim()) return []
    const hits = await this.search({ query, project, topK: Math.max(topK * 2, 8), includeWeb: true })
    return hits.results
      .filter((row) => !row.path.includes(`/${INBOX_DIR}/`))
      .slice(0, topK)
      .map((row) => ({
        path: row.path,
        title: row.title,
        score: row.score,
        origin: row.origin,
        updated: row.updated,
        summary: row.summary,
      }))
  }

  /** Pending items, newest first. `project` narrows to one project. */
  async inboxList({ project = null, limit = 200 } = {}) {
    let names
    if (project) {
      names = [String(project)]
    } else {
      const all = await this.store.allFiles({ excludes: this.legacyExcludes })
      names = [...new Set(all.map((rel) => rel.split('/')[0]).filter(Boolean))]
    }
    const items = []
    for (const name of names) {
      for (const rel of await this.store.allFiles({ root: this.inboxDir(name) })) {
        if (path.basename(rel) === GAP_FILE) continue // 缺口清单单独走 kb_gap
        const note = await this.store.read(rel)
        if (!note) continue
        const fm = note.frontmatter ?? {}
        items.push({
          path: rel,
          project: name,
          title: fm.title ?? path.basename(rel, '.md'),
          origin: originOf(fm),
          confidence: fm.confidence ?? null,
          source: fm.source ?? null,
          session: fm.session ?? null,
          captured: fm.captured ?? fm.updated ?? null,
          tags: fm.tags ?? [],
          suggest: Array.isArray(fm.suggest) ? fm.suggest : [],
          summary: firstLine(note.body),
          chars: String(note.body ?? '').length,
        })
      }
    }
    items.sort((a, b) => String(b.captured ?? '').localeCompare(String(a.captured ?? '')))
    return { count: items.length, projects: names.length, items: items.slice(0, limit) }
  }

  /** Staged → published: move into the project tree (no approval needed). */
  async promote({ path: staged, targetDir = null, note = null } = {}) {
    const givenRel = normalizeRel(staged)
    // 先解析成磁盘真实大小写再判边界：`p/Inbox/x.md` 在大小写不敏感的文件
    // 系统上会命中 `p/inbox/x.md`，那里放的是用户自己目录里的正式笔记。
    const stagedRel = (await this.store.realRel(givenRel)) ?? givenRel
    if (!isInboxRel(stagedRel)) {
      throw new ValidationError(`不是 Inbox 待审条目: ${givenRel}`)
    }
    const project = stagedRel.split('/')[0]
    const rawDir = String(targetDir ?? '').replace(/^[/\\]+|[/\\]+$/g, '')
    const dir = !rawDir ? project : rawDir.startsWith(`${project}/`) || rawDir === project ? rawDir : `${project}/${rawDir}`
    const file = `${dir}/${path.basename(stagedRel)}`
    // 「读待审条目 → 判目标存在 → 写目标 → 删待审」是一个整体：拆开时并发
    // promote 同一篇会双双通过 exists 检查，后者覆盖前者。
    await this.store.transact(async () => {
      const stagedNote = await this.store.read(stagedRel)
      if (!stagedNote) throw new NotFoundError(`待审条目不存在: ${stagedRel}`)
      if (await this.store.exists(file)) {
        throw new ValidationError(`目标已存在：${file}`, {
          suggestion: '改用 kb_inbox({ action:"merge", path, into })',
        })
      }
      const now = new Date().toISOString()
      const frontmatter = {
        ...(stagedNote.frontmatter ?? {}),
        status: 'published',
        promoted: now,
        updated: now,
      }
      delete frontmatter.suggest
      if (note) frontmatter.note = String(note)
      await this.store.write(file, { frontmatter, body: stagedNote.body ?? '' })
      await this.store.remove(stagedRel)
    })
    const index = await this.rebuildIndex(project)
    return { promoted: file, from: stagedRel, project, index }
  }

  /**
   * Staged → existing note. Append-only: `append` adds a dated section,
   * `conflict` parks it under a「⚖️ 冲突（待裁决）」section keeping both sides.
   * Callers must gate this behind user approval.
   */
  /**
   * 合并进一篇已有笔记。Append-only：`append` 加一个带日期的小节，
   * `conflict` 停到「⚖️ 冲突（待裁决）」下保留双方。调用方必须过审批。
   *
   * 源有两种形态：
   *   * **Inbox 条目**（`staged`）—— 历史通道，会消费（删除）该条目。
   *   * **直接内容**（`content`）—— capture 直写后没有 Inbox 了，冲突时
   *     agent 手里只有一段想写进去的正文。没有这个入口，「同名冲突 → 想合并」
   *     就无路可走，只剩「换标题」或「硬覆盖」两条坏路。
   *
   * 两者都不允许拿**正式笔记**当源（`staged` 指向 Inbox 之外一律拒），
   * 否则一次合并会把那篇的正文追加进目标再把源文件删掉。
   */
  async mergeInto({ staged = null, content = null, into, mode = 'append', note = null, source = null } = {}) {
    const targetRel = normalizeRel(into)
    const hasContent = typeof content === 'string' && content.trim().length > 0
    if (!staged && !hasContent) {
      throw new ValidationError('缺少合并来源：staged（Inbox 条目路径）或 content（直接正文）二选一')
    }
    if (staged && hasContent) {
      throw new ValidationError('staged 与 content 不能同时给')
    }

    let sourceRef = source ? String(source) : null
    if (staged) {
      const stagedRel = normalizeRel(staged)
      if (stagedRel === targetRel) throw new ValidationError('into 不能等于 path')
      // 判定必须用**磁盘上的真实路径**：NTFS 大小写不敏感，`p/Inbox/x.md` 与
      // `p/inbox/x.md` 指向同一个文件。只校验调用方给的字符串，会让大写的
      // `Inbox` 通过检查、实际删掉小写 `inbox` 里的正式笔记。
      const stagedReal = await this.store.realRel(stagedRel)
      if (!stagedReal || !isInboxRel(stagedReal)) {
        throw new ValidationError(`不是 Inbox 待审条目: ${stagedRel}`)
      }
      const targetReal = await this.store.realRel(targetRel)
      if (targetReal && isInboxRel(targetReal)) {
        throw new ValidationError('into 必须是正式笔记（不能是 Inbox 待审条目）')
      }
    } else {
      sourceRef = sourceRef ?? 'kb_capture（直写冲突后的合并）'
    }

    // **整个读-改-写必须在一个临界区里。** 早先这里是裸 read + write：两个并发
    // merge 读到同一份旧正文，各自追加自己的小节，后写的那份把前一节的补充
    // 直接抹掉（丢更新，且没有任何报错）。事务让「读旧正文 → 拼新正文 → 落盘」
    // 与其它变更互斥。
    const outcome = await this.store.transact(async () => {
      let stagedRel = null
      let stagedBody = ''
      let sfm = {}
      if (staged) {
        stagedRel = normalizeRel(staged)
        const stagedNote = await this.store.read(stagedRel)
        if (!stagedNote) throw new NotFoundError(`待审条目不存在: ${stagedRel}`)
        sfm = stagedNote.frontmatter ?? {}
        stagedBody = String(stagedNote.body ?? '').trim()
        sourceRef = sourceRef ?? sfm.source ?? sfm.session ?? stagedRel
      } else {
        stagedBody = String(content).trim()
      }

      const target = await this.store.read(targetRel)
      if (!target) throw new NotFoundError(`目标笔记不存在: ${targetRel}`)

      const now = new Date().toISOString()
      const day = now.slice(0, 10)
      const originValue = staged ? originOf(sfm) : originOf(target.frontmatter)
      const provenance = `> 来源：${sourceRef}（origin: ${originValue}, ${day}）`
      const heading = mode === 'conflict' ? '⚖️ 冲突（待裁决）' : note ? String(note) : `补充 · ${day}`
      const section = `\n\n## ${heading}\n\n${stagedBody}\n\n${provenance}\n`
      const body = `${String(target.body ?? '').replace(/\s+$/, '')}${section}`

      const prevConfidence = Number.isFinite(Number(target.frontmatter?.confidence))
        ? Number(target.frontmatter.confidence)
        : 0.7
      const previousSources = Array.isArray(target.frontmatter?.sources) ? target.frontmatter.sources : []
      const frontmatter = {
        ...(target.frontmatter ?? {}),
        status: target.frontmatter?.status ?? 'published',
        confidence: Math.min(1, Math.round((prevConfidence + 0.1) * 100) / 100),
        sources: [...previousSources, sourceRef].filter(Boolean),
        updated: now,
      }
      await this.store.write(targetRel, { frontmatter, body })
      if (stagedRel) await this.store.remove(stagedRel)
      return { stagedRel, section, confidence: frontmatter.confidence }
    })

    // 索引重建是整库快照，放在临界区外：它自己那次写入另有事务。
    const project = targetRel.split('/')[0]
    const index = await this.rebuildIndex(project)
    return {
      merged: targetRel,
      ...(outcome.stagedRel ? { from: outcome.stagedRel } : { fromContent: true }),
      mode,
      addedChars: outcome.section.length,
      confidence: outcome.confidence,
      index,
    }
  }

  /**
   * In-place correction of a published note: replace fragments that new evidence
   * has falsified (a stale version number, a dead path, a conclusion that got
   * overturned). Deliberately narrow — every `find` must match EXACTLY ONCE, so
   * ambiguity is an error instead of a guess, and the applied edits are recorded
   * in frontmatter so the change stays traceable.
   *
   * This is the ONLY in-place channel for existing notes. It exists so falsified
   * text can be corrected instead of piling up append-only 「补充」 sections.
   * It is NOT a rewrite channel: no new knowledge, no restyling, no reordering.
   * Callers must gate this behind user approval.
   */
  async reviseNote({ path: target, edits = [], note = null, project = null } = {}) {
    const targetRel = normalizeRel(target)
    if (isInboxRel(targetRel)) {
      throw new ValidationError('revise 只作用于正式笔记（Inbox 待审条目走 merge / drop）')
    }
    const list = Array.isArray(edits) ? edits : []
    if (list.length === 0) {
      throw new ValidationError('revise 需要 edits: [{ find, replace }]', {
        suggestion: '先 kb_read 取当前正文，再按实际文本给出要替换的片段',
      })
    }
    // 读 → 唯一性校验 → 写入是同一件事：两个并发 revise 打同一篇时，第二个的
    // `find` 命中数必须基于第一个已落盘的新正文来判断，不能基于旧快照。
    const applied = await this.store.transact(async () => {
      const targetNote = await this.store.read(targetRel)
      if (!targetNote) throw new NotFoundError(`目标笔记不存在: ${targetRel}`)

      const brief = (s) => (s.length > 70 ? `${s.slice(0, 70)}…` : s)
      let body = String(targetNote.body ?? '')
      const done = []
      for (const [i, raw] of list.entries()) {
        const find = String(raw?.find ?? '')
        const replace = String(raw?.replace ?? '')
        if (!find) throw new ValidationError(`edits[${i}] 缺少 find`)
        const hits = body.split(find).length - 1
        if (hits === 0) {
          throw new ValidationError(`edits[${i}] 在正文中找不到：${brief(find)}`, {
            suggestion: '先 kb_read 取当前正文，按实际文本给出 find',
          })
        }
        if (hits > 1) {
          throw new ValidationError(`edits[${i}] 在正文中匹配 ${hits} 处，无法唯一确定：${brief(find)}`, {
            suggestion: '带上前后文让 find 唯一命中',
          })
        }
        body = body.replace(find, replace)
        done.push({ find: brief(find), replace: brief(replace) })
      }

      const now = new Date().toISOString()
      const prevRevisions = Array.isArray(targetNote.frontmatter?.revisions)
        ? targetNote.frontmatter.revisions.map((v) => String(v))
        : []
      // NOTE: 只写标量数组。core/frontmatter.js 的数组分支不缩进多行对象
      // （stringifyFrontmatter → keyValueLine），写对象数组会把 count/note 泄漏成
      // 顶层键并覆盖同名正式字段 —— 实测踩过，所以这里压成单行字符串。
      const stamp = [now, `${done.length} 处`, note ? String(note).replace(/[\r\n]+/g, ' ') : null]
        .filter(Boolean)
        .join(' · ')
      const frontmatter = {
        ...(targetNote.frontmatter ?? {}),
        status: targetNote.frontmatter?.status ?? 'published',
        revisions: [...prevRevisions, stamp].slice(-20),
        updated: now,
      }
      await this.store.write(targetRel, { frontmatter, body })
      return { applied: done, chars: body.length }
    })

    const proj = project ?? targetRel.split('/')[0]
    const index = await this.rebuildIndex(proj)
    return { revised: targetRel, edits: applied.applied, chars: applied.chars, index }
  }

  /** Staged → `<project>/Inbox/.dropped/` (hidden, recoverable, out of the index). */
  async dropStaged({ path: staged, reason = null } = {}) {
    const givenRel = normalizeRel(staged)
    const stagedRel = (await this.store.realRel(givenRel)) ?? givenRel
    if (!isInboxRel(stagedRel)) {
      throw new ValidationError(`不是 Inbox 待审条目: ${givenRel}`)
    }
    const project = stagedRel.split('/')[0]
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = `${project}/${INBOX_DIR}/.dropped/${path.basename(stagedRel, '.md')}.${stamp}.md`
    // 「搬到 .dropped 再删原件」不能断开：中途失败会留下两份，或一份都不剩。
    await this.store.transact(async () => {
      const stagedNote = await this.store.read(stagedRel)
      if (!stagedNote) throw new NotFoundError(`待审条目不存在: ${stagedRel}`)
      const frontmatter = {
        ...(stagedNote.frontmatter ?? {}),
        status: 'dropped',
        droppedAt: new Date().toISOString(),
      }
      if (reason) frontmatter.droppedReason = String(reason)
      await this.store.write(dest, { frontmatter, body: stagedNote.body ?? '' })
      await this.store.remove(stagedRel)
    })
    return { dropped: dest, from: stagedRel, restorable: true }
  }

  // ------------------------------------------------------- P4: 洞察 / 导出
  // 标签云、反链、相关、体检、快照导出导入、skill 打包、人工反馈闭环。

  /** Tag cloud over the indexed notes (optionally one project). */
  async tagCloud({ project = null, limit = 200 } = {}) {
    await this.refresh()
    const counts = new Map()
    for (const [rel, doc] of this.indexer.docs) {
      if (project && topSegment(rel) !== project) continue
      for (const tag of doc.frontmatter?.tags ?? []) {
        const key = String(tag).trim()
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    return { project, total: tags.length, tags: tags.slice(0, limit) }
  }

  /** Resolve a loose ref (vault path / filename stem / title / alias) to a rel. */
  async resolveRef(ref) {
    await this.refresh()
    const needle = String(ref ?? '').trim()
    if (!needle) throw new ValidationError('缺少 path')
    const cleaned = needle.replace(/^[/\\]+/, '')
    if (this.indexer.docs.has(cleaned)) return cleaned
    const want = slugify(cleaned.replace(/\.md$/, ''))
    for (const [rel, doc] of this.indexer.docs) {
      const stem = rel.split('/').pop().replace(/\.md$/, '')
      if (slugify(stem) === want) return rel
      if (doc.frontmatter?.title && slugify(doc.frontmatter.title) === want) return rel
      const aliases = doc.frontmatter?.aliases ?? []
      if (aliases.some((a) => slugify(String(a)) === want)) return rel
      if (slugify(rel.replace(/\.md$/, '')) === want) return rel
    }
    const inbox = await this.inboxList({})
    const hit = inbox.items.find((item) => {
      const stem = item.path.split('/').pop().replace(/\.md$/, '')
      return slugify(stem) === want || slugify(item.title) === want
    })
    if (hit) return hit.path
    throw new NotFoundError(`找不到条目: ${ref}`)
  }

  /** Notes that link to `path` via wikilinks. */
  async backlinks({ path: ref, max = 50 } = {}) {
    const rel = await this.resolveRef(ref)
    const hits = await this.links.backlinks(rel)
    return { path: rel, count: hits.length, backlinks: hits.slice(0, max) }
  }

  /** Related notes: typed relations first, then shared-tag overlap. */
  async related({ path: ref, max = 10 } = {}) {
    const rel = await this.resolveRef(ref)
    const hits = await this.links.related(rel, { max })
    return { path: rel, count: hits.length, related: hits }
  }

  /**
   * Vault health check. Levels: error / warn / info.
   * Checks: missing title · missing `origin` (aggregated) · expired (`expires`) ·
   * broken wikilinks · duplicate titles · missing origin.
   */
  async doctor({ project = null, limit = 200 } = {}) {
    await this.refresh()
    const problems = []
    const rels = [...this.indexer.docs.keys()].filter((rel) => !project || topSegment(rel) === project)

    // Build the resolvable-name set once: stems, titles, aliases, full paths.
    const known = new Set()
    for (const [rel, doc] of this.indexer.docs) {
      const fm = doc.frontmatter ?? {}
      known.add(slugify(rel.replace(/\.md$/, '')))
      known.add(slugify(rel.split('/').pop().replace(/\.md$/, '')))
      if (fm.title) known.add(slugify(fm.title))
      for (const alias of fm.aliases ?? []) known.add(slugify(String(alias)))
    }
    // 附件（png / pdf / 任意非 .md）不在笔记索引里，但 Obsidian 里 `[[a.png]]`
    // 与 `![[a.png]]` 都是合法嵌入，且库约定（`知识库约定.md`）明确写了
    // 「文件名在库内唯一时写短名」，所以短名引用必须能解析。走两条：
    //   ① 全路径 → 直接 disk 判定；
    //   ② 短名   → 全库附件清单（一次遍历建 basename 计数，只在唯一时命中）。
    // 只查 `known` 会把所有附件引用都判成断链 —— 真机验收时那 3 条 png
    // 「断链」的目标就都真实存在于磁盘上。
    const attachmentCache = new Map()
    let attachmentNames = null
    const attachmentNameSet = () => {
      if (attachmentNames) return attachmentNames
      // basename(小写) → 出现次数。多于一次即视为歧义，不当作可解析。
      attachmentNames = new Map()
      const walk = (dirRel) => {
        let entries
        try {
          entries = fs.readdirSync(this.store.abs(dirRel || '.'), { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
            walk(rel)
          } else if (entry.isFile() && !/\.md$/i.test(entry.name)) {
            const key = entry.name.toLowerCase()
            attachmentNames.set(key, (attachmentNames.get(key) ?? 0) + 1)
          }
        }
      }
      walk('')
      return attachmentNames
    }
    const attachmentExists = (raw) => {
      if (attachmentCache.has(raw)) return attachmentCache.get(raw)
      let hit = false
      if (raw.includes('/')) {
        try {
          // 必须是**文件**：`existsSync` 对目录也返回 true，一个与附件同名的
          // 目录会把断链掩盖成"已解析"。
          hit = fs.statSync(this.store.abs(raw)).isFile()
        } catch {
          // 路径越界 / 非法 rel / 不存在：当作未命中，不抛。
          hit = false
        }
      }
      // 短名：库约定允许「文件名在库内唯一时写短名」，但只在**全库唯一**时才算
      // 解析成功。多于一处同名说明引用本身有歧义，按断链报出来更有用。
      if (!hit && !raw.includes('/')) {
        const dupes = attachmentNameSet().get(raw.toLowerCase()) ?? 0
        hit = dupes === 1
      }
      attachmentCache.set(raw, hit)
      return hit
    }
    const resolves = (target) => {
      const raw = String(target).replace(/\\/g, '/')
      if (known.has(slugify(raw))) return true
      const last = raw.split('/').filter(Boolean).pop()
      if (last && known.has(slugify(last))) return true
      // 带扩展名且不是 .md → 附件，按磁盘存在性判定（只认同路径命中；
      // 短名全库搜索成本过高，宁可漏报也不误报）。
      if (/\.[A-Za-z0-9]{1,8}$/.test(raw) && !/\.md$/i.test(raw)) {
        return attachmentExists(raw)
      }
      return false
    }

    const byTitle = new Map()
    const missingOrigin = []
    for (const rel of rels) {
      const doc = this.indexer.docs.get(rel)
      const fm = doc.frontmatter ?? {}
      if (!fm.title) problems.push({ level: 'warn', path: rel, issue: '缺少 title' })

      // `origin` 缺失现在是显式的第三态 `unlabeled`，不再被兜底成 local 冒充
      // 「已验证」。这里仍然只做**聚合**提示、不逐篇刷屏：99/222 篇手写笔记
      // 就是这个状态（k8s / Obsidian-AI / 启智平台管理三块，按约定体裁直接写
      // 目标目录、绕开了 kb_capture），逐篇报就是 99 条常驻噪音，而它们本身
      // 没有任何问题。因此保持 info 级 + 单条聚合。
      if (originOf(fm) === 'unlabeled') missingOrigin.push(rel)

      const expires = Date.parse(String(fm.expires ?? ''))
      if (Number.isFinite(expires) && expires < Date.now()) {
        problems.push({ level: 'info', path: rel, issue: `已过期（${fmtDate(fm.expires)}）` })
      }

      const label = fm.title ?? rel.split('/').pop().replace(/\.md$/, '')
      const key = slugify(label)
      byTitle.set(key, [...(byTitle.get(key) ?? []), rel])

      const note = await this.store.read(rel)
      for (const target of extractWikilinks(note?.body ?? '')) {
        if (!resolves(target)) problems.push({ level: 'warn', path: rel, issue: `断链：[[${target}]]` })
      }
    }

    if (missingOrigin.length) {
      const head = missingOrigin.slice(0, 10)
      // 措辞必须中立：这些是**手写**笔记，只是没做来源标注，不是可疑内容。
      problems.push({
        level: 'info',
        path: `${missingOrigin.length} 篇笔记`,
        issue: `origin 未标注（手写笔记的正常状态，不影响召回：默认召回 local 与 unlabeled；仅在证据支持时用 Obsidian MCP 补 origin: local）：${head.join('、')}${
          missingOrigin.length > head.length ? ` 等 ${missingOrigin.length} 篇` : ''
        }`,
      })
    }

    for (const [key, list] of byTitle) {
      if (list.length > 1) {
        problems.push({ level: 'warn', path: list.join(' / '), issue: `标题/文件名重复（${list.length} 篇都叫 ${key}）` })
      }
    }

    const gaps = await this.gapList({ project })
    for (const gap of gaps.items) {
      if (gap.done) continue
      problems.push({
        level: 'info',
        path: gap.path,
        issue: `缺口未补：${gap.question}`,
      })
    }

    const count = (level) => problems.filter((p) => p.level === level).length
    return {
      project,
      scanned: rels.length,
      errors: count('error'),
      warns: count('warn'),
      infos: count('info'),
      count: problems.length,
      problems: problems.slice(0, limit),
    }
  }

  /** Portable JSON snapshot of the published knowledge (no Inbox staging). */
  async exportSnapshot({ project = null } = {}) {
    await this.refresh()
    const rels = [...this.indexer.docs.keys()].filter((rel) => !project || topSegment(rel) === project)
    const notes = []
    for (const rel of rels) {
      const note = await this.store.read(rel)
      if (!note) continue
      notes.push({ rel, frontmatter: note.frontmatter ?? {}, body: note.body ?? '' })
    }
    return {
      format: 'dsh-kb-snapshot',
      version: 1,
      exportedAt: new Date().toISOString(),
      vault: this.root,
      project,
      count: notes.length,
      notes,
    }
  }

  /** Validate a snapshot and (only with dryRun:false) write it back. */
  async importSnapshot({ data, dryRun = true } = {}) {
    const notes = Array.isArray(data?.notes) ? data.notes : null
    if (!notes) throw new ValidationError('无效快照：缺少 notes 数组')

    // 第一遍只做**纯校验**（不碰磁盘），因此不需要事务。结果分进 skipped / safe。
    const plan = { added: [], updated: [], unchanged: [], skipped: [] }
    const safe = []
    for (const item of notes) {
      const rel = String(item?.rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      const parts = rel.split('/')
      const bad =
        !rel ||
        !item?.frontmatter ||
        typeof item.frontmatter !== 'object' ||
        parts.includes('..') ||
        parts.some((seg) => seg.startsWith('.'))
      if (bad) {
        plan.skipped.push(rel || '(空路径)')
        continue
      }
      safe.push({ rel, frontmatter: item.frontmatter, body: String(item.body ?? '') })
    }

    // 三分类的唯一实现。**每次分类都必须紧跟它自己的那份写入/统计**，不许把
    // 结果留到临界区外再复用 —— 早先正是这么错的：分类在 store.transact() 之外
    // 跑完，事务里只剩写循环，还用陈旧的 plan.unchanged 做 includes。并发写落在
    // 「分类之后、回写之前」时，一篇已经被并发改过的笔记仍被判成 unchanged 而
    // 跳过，调用方却收到 unchanged 的回执：库与快照已经不一致，报告还说一致。
    const classify = async (item) => {
      const existing = await this.store.read(item.rel)
      if (!existing) return 'added'
      return String(existing.body ?? '') !== item.body ? 'updated' : 'unchanged'
    }
    const summarize = () => ({
      added: plan.added.length,
      updated: plan.updated.length,
      unchanged: plan.unchanged.length,
      skipped: plan.skipped.length,
    })

    if (dryRun) {
      // dryRun 不写盘：分类读到什么就报什么，不需要事务 —— 进了事务只会把一段
      // 本可并发的只读扫描塞进临界区，白占队列。它描述的是「此刻看起来会怎样」，
      // 本来就不是承诺，所以这里允许与随后真跑的结果不同。
      for (const item of safe) plan[await classify(item)].push(item.rel)
      return {
        dryRun: true,
        plan: summarize(),
        sample: {
          added: plan.added.slice(0, 5),
          updated: plan.updated.slice(0, 5),
          skipped: plan.skipped.slice(0, 5),
        },
      }
    }

    // dryRun:false：分类与回写必须在**同一个**临界区里，每一次分类都以当时读到
    // 的状态为准。代价是这个批量操作持有队列的时间更长（N 次读 + N 次写，而不是
    // 只在 N 次写上排队），但批量导入本来就是独占型管理操作 —— 这个代价就是
    // 原子性的价格；付不起就不该声称它是原子的。
    let written = 0
    await this.store.transact(async () => {
      for (const item of safe) {
        const kind = await classify(item)
        plan[kind].push(item.rel)
        if (kind === 'unchanged') continue
        await this.store.write(item.rel, { frontmatter: item.frontmatter, body: item.body })
        written += 1
      }
    })

    const summary = summarize()
    // touched 现在反映「实际写了哪些项目」，而不是「计划要写哪些」。
    const touched = new Set([...plan.added, ...plan.updated].map((rel) => rel.split('/')[0]))
    const indexes = []
    for (const name of touched) {
      try {
        indexes.push(await this.rebuildIndex(name))
      } catch {
        /* 该顶层目录可能不是项目（例如根目录文件）*/
      }
    }
    return { dryRun: false, written, plan: summary, indexes }
  }

  /**
   * Bundle selected notes into a portable skill package under `.dsh-kb/skills/`
   * (hidden → not a project, not indexed). Copy the folder into `~/.dsh/skills/`
   * to let the host skill system load it.
   */
  async exportSkill({ name, description = '', refs = [], limit = 20 } = {}) {
    const skillName = slugify(name)
    if (!skillName) throw new ValidationError('缺少 name')
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new ValidationError('缺少 refs（要打包进技能的笔记路径/标题列表）')
    }
    const picked = []
    const seen = new Set()
    for (const ref of refs.slice(0, limit)) {
      const rel = await this.resolveRef(ref)
      if (seen.has(rel)) continue // 同一个 rel 被多种写法引用时只打包一次
      seen.add(rel)
      const note = await this.store.read(rel)
      if (note) picked.push({ rel, frontmatter: note.frontmatter ?? {}, body: note.body ?? '' })
    }
    if (picked.length === 0) throw new NotFoundError('refs 里没有解析到任何笔记')

    const dir = `.dsh-kb/skills/${skillName}`
    const body = [
      `# ${name}`,
      '',
      description || '由 dsh-kb 从本地知识库导出的技能包。',
      '',
      '## 何时使用',
      '',
      '任务涉及以下主题时，先读 `references/` 里的笔记再动手：',
      '',
      ...picked.map((p) => `- ${p.frontmatter.title ?? p.rel} → \`references/${path.basename(p.rel)}\``),
      '',
      '## 纪律',
      '',
      '- 先读本技能包的 references，再考虑联网；',
      '- 网上/推理得来的新结论标清楚 origin（web / inferred），落点判准后再写；不要直接改别人的正式笔记。',
      '',
    ].join('\n')

    await this.store.write(`${dir}/SKILL.md`, {
      frontmatter: {
        type: 'skill',
        name: skillName,
        description,
        generator: 'dsh-kb',
        updated: new Date().toISOString(),
        sources: picked.map((p) => p.rel),
      },
      body,
    })
    const references = []
    for (const p of picked) {
      const target = `${dir}/references/${path.basename(p.rel)}`
      await this.store.write(target, { frontmatter: p.frontmatter, body: p.body })
      references.push(target)
    }
    return {
      skill: `${dir}/SKILL.md`,
      name: skillName,
      entries: picked.length,
      references,
      installHint: `把 ${dir} 整个目录复制到 ~/.dsh/skills/ 下即可被 DSH 技能系统加载`,
    }
  }

  /** Human feedback loop: correction lowers confidence, confirm raises it. */
  async feedback({ path: ref, kind = 'correction', text = '' } = {}) {
    // resolveRef 会 refresh 整个索引（重活），放在临界区外做；它只产出路径，
    // 不产出待改内容。
    const rel = await this.resolveRef(ref)
    // 「读 confidence → 加减 → 写回」必须原子：并发两次 feedback 各自读旧值
    // 时，第二次会把第一次的 confidence 调整和 corrections 条目一起覆盖掉。
    const after = await this.store.transact(async () => {
      const note = await this.store.read(rel)
      if (!note) throw new NotFoundError(`笔记不存在: ${rel}`)
      const fm = note.frontmatter ?? {}
      const corrections = Array.isArray(fm.corrections) ? fm.corrections.slice(-19) : []
      const entry = `${new Date().toISOString()} [${kind}] ${String(text).trim()}`.trim()
      corrections.push(entry)
      let confidence = fm.confidence == null ? 1 : Number(fm.confidence)
      if (!Number.isFinite(confidence)) confidence = 1
      if (kind === 'correction') confidence = Math.max(0, confidence - 0.2)
      else if (kind === 'confirm') confidence = Math.min(1, confidence + 0.1)
      const rounded = Math.round(confidence * 100) / 100
      await this.store.write(rel, {
        frontmatter: { ...fm, corrections, confidence: rounded, updated: new Date().toISOString() },
        body: note.body ?? '',
      })
      return { confidence: rounded, corrections: corrections.length }
    })
    let index = null
    try {
      index = await this.rebuildIndex(rel.split('/')[0])
    } catch {
      index = null
    }
    return { path: rel, kind, confidence: after.confidence, corrections: after.corrections, index }
  }

  // ------------------------------------------------- P5: 缺口 / 图谱 / 自愈
  // 「库里缺什么」被使用驱动地记下来（缺口清单），索引可强制重建兜底，
  // 链接图谱同时服务 agent 与面板「洞察」。

  /** `<project>/Inbox/缺口.md` —— 缺口清单（在 Inbox 里，因此不进索引）。 */
  gapFile(project) {
    return `${this.inboxDir(project)}/${GAP_FILE}`
  }

  async gapList({ project = null } = {}) {
    const names = project ? [String(project)] : await this._projectNames()
    const items = []
    for (const name of names) {
      const note = await this.store.read(this.gapFile(name))
      if (!note) continue
      for (const gap of parseGaps(note.body ?? '')) {
        items.push({ ...gap, project: name, path: this.gapFile(name) })
      }
    }
    const open = items.filter((item) => !item.done).length
    return { count: items.length, open, done: items.length - open, items }
  }

  /** 记一条缺口：检索没命中、不得不外部获取/自行推理时调用。 */
  async gapAdd({ project, question, clues = null, source = null, origin = 'inferred' } = {}) {
    const name = String(project ?? '').trim()
    if (!name) throw new ValidationError('缺少 project（vault 顶级目录名）')
    const q = String(question ?? '').trim()
    if (!q) throw new ValidationError('缺少 question（库里缺什么）')
    const rel = this.gapFile(name)
    const now = new Date().toISOString()
    const id = shortHash(`${name}:${q}`)
    const line = formatGap({ id, question: q, clues, source, origin, createdAt: now })
    // 「读清单 → 查重 → 追加一行」必须原子：并发 add 各自读到旧清单时会互相
    // 覆盖，表现是其中一条缺口凭空消失（清单是 append-only 的文本文件，没有
    // 任何结构能承载并发合并）。
    return this.store.transact(async () => {
      const existing = await this.store.read(rel)
      const body0 = existing?.body ?? gapHeader(name)
      const list = parseGaps(body0)
      const dup = list.find((gap) => gap.id === id)
      if (dup) {
        return {
          path: rel,
          id,
          duplicate: true,
          done: dup.done,
          open: list.filter((g) => !g.done).length,
        }
      }
      const body = `${body0.replace(/\s+$/, '')}\n${line}\n`
      await this.store.write(rel, {
        frontmatter: {
          ...(existing?.frontmatter ?? {}),
          type: 'gap',
          project: name,
          generator: 'dsh-kb',
          updated: now,
        },
        body,
      })
      return { path: rel, id, duplicate: false, open: parseGaps(body).filter((g) => !g.done).length }
    })
  }

  /** 缺口补齐后勾掉。 */
  async gapResolve({ project, id, note = null } = {}) {
    const name = String(project ?? '').trim()
    if (!name || !id) throw new ValidationError('resolve 需要 project + id')
    const rel = this.gapFile(name)
    const wanted = String(id)
    // 与 gapAdd 同理：勾选是基于整份清单的读-改-写。
    return this.store.transact(async () => {
      const existing = await this.store.read(rel)
      if (!existing) throw new NotFoundError(`没有缺口清单: ${rel}`)
      let hit = false
      const body = String(existing.body ?? '')
        .split('\n')
        .map((line) => {
          const m = GAP_RE.exec(line.trim())
          if (!m || m[2] !== wanted) return line
          hit = true
          const suffix = note ? `；已补：${String(note).replace(/\s+/g, ' ')}` : ''
          return line.replace('- [ ]', '- [x]').replace(/[）)]\s*$/, `${suffix}）`)
        })
        .join('\n')
      if (!hit) throw new NotFoundError(`找不到缺口 id: ${wanted}`)
      await this.store.write(rel, {
        frontmatter: {
          ...(existing.frontmatter ?? {}),
          type: 'gap',
          project: name,
          generator: 'dsh-kb',
          updated: new Date().toISOString(),
        },
        body,
      })
      const list = parseGaps(body)
      return {
        path: rel,
        id: wanted,
        open: list.filter((g) => !g.done).length,
        done: list.filter((g) => g.done).length,
      }
    })
  }

  /** Wikilink 图谱：节点（含被引/出链度数）+ 边。 */
  async linkGraph({ project = null, limit = 200 } = {}) {
    await this.refresh()
    const allRels = [...this.indexer.docs.keys()]
    const rels = allRels.filter((rel) => !project || topSegment(rel) === project)
    const inProject = new Set(rels)

    const known = new Map()
    for (const rel of allRels) {
      const fm = this.indexer.docs.get(rel)?.frontmatter ?? {}
      known.set(slugify(rel.split('/').pop().replace(/\.md$/, '')), rel)
      if (fm.title) known.set(slugify(fm.title), rel)
      for (const alias of fm.aliases ?? []) known.set(slugify(String(alias)), rel)
    }

    const degree = new Map()
    for (const rel of rels) degree.set(rel, { in: 0, out: 0 })
    const bump = (rel, key) => {
      const cur = degree.get(rel) ?? { in: 0, out: 0 }
      cur[key] += 1
      degree.set(rel, cur)
    }

    const edges = []
    for (const rel of rels) {
      const note = await this.store.read(rel)
      for (const target of extractWikilinks(note?.body ?? '')) {
        const raw = String(target).replace(/\\/g, '/')
        const to =
          known.get(slugify(raw)) ?? known.get(slugify(raw.split('/').filter(Boolean).pop() ?? ''))
        if (!to || to === rel || !inProject.has(to)) continue
        edges.push({ from: rel, to })
        bump(rel, 'out')
        bump(to, 'in')
      }
    }

    const nodes = [...degree.entries()]
      .map(([rel, d]) => ({
        path: rel,
        title: this.indexer.docs.get(rel)?.frontmatter?.title ?? rel.split('/').pop(),
        group: groupOf(rel, this.indexer.docs.get(rel)?.frontmatter ?? {}, project),
        in: d.in,
        out: d.out,
        degree: d.in + d.out,
      }))
      .sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path))

    return {
      project,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      isolated: nodes.filter((n) => n.degree === 0).length,
      nodes: nodes.slice(0, limit),
      edges: edges.slice(0, limit * 4),
    }
  }

  /**
   * 索引自愈：强制全量重建（mtime 差分之外的兜底）；`fixIndexes` 会把
   * 「INDEX.md 落后于项目内最新笔记」的那些项目索引一并刷新。
   */
  async reindex({ fixIndexes = false, project = null } = {}) {
    const started = Date.now()
    this.indexer._built = false
    this.indexer.version = -1
    const notes = await this.indexer.rebuild()
    const ms = Date.now() - started
    const fixed = []
    if (fixIndexes) {
      for (const stale of await this.staleProjects(project)) {
        fixed.push({ ...(await this.rebuildIndex(stale.project)), reason: stale.reason })
      }
    }
    return { notes, ms, fixed, note: 'mtime 差分已在每次读取时自愈；本工具是强制兜底' }
  }

  /** 项目名列表（不含保留目录）。 */
  async _projectNames() {
    const all = await this.store.allFiles({ excludes: this.legacyExcludes })
    return [...new Set(all.map((rel) => rel.split('/')[0]).filter(Boolean))]
  }

  /** Parse one note without going through the index (used by the Inbox flow). */
  async peek(rel) {
    const note = await this.store.read(normalizeRel(rel))
    if (!note) return null
    return { path: rel, frontmatter: note.frontmatter ?? {}, body: note.body ?? '' }
  }

  /** Serialize frontmatter+body exactly the way the store would. */
  serialize(frontmatter, body) {
    return `${stringifyFrontmatter(frontmatter)}${body ?? ''}`
  }

  /** Frontmatter parser re-export for callers that only embed this service. */
  parse(raw) {
    return parseFrontmatter(raw)
  }
}

export { originOf, snippetOf, topSegment, subDir }
