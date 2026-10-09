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
//   * **origin grading** (`local` | `web` | `inferred`, missing = local) keeps
//     web/inferred material out of default recall, so the vault cannot be
//     silently polluted from the internet.

import path from 'node:path'
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
/** Origins returned by default. `web` / `inferred` must be asked for. */
export const DEFAULT_ORIGINS = ['local']

const ORIGINS = new Set(['local', 'web', 'inferred'])

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
 * Group label for one note. RepoWiki pages live flat on disk (`<repo>/src-a.md`)
 * but carry their real source path in frontmatter, so group them by *that* —
 * the index then shows the code's directory structure instead of one flat list.
 */function groupOf(rel, frontmatter, project) {
  const type = String(frontmatter?.type ?? '')
  const sourcePath = frontmatter?.path
  if (type === 'wiki' && sourcePath) {
    const dir = path.posix.dirname(String(sourcePath).replace(/\\/g, '/'))
    return dir === '.' || dir === '/' ? '' : dir
  }
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

function originOf(frontmatter) {
  const raw = frontmatter?.origin
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return ORIGINS.has(value) ? value : 'local'
}

function firstLine(body) {
  for (const line of String(body ?? '').split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text && !text.startsWith('---') && !text.startsWith('<!--')) return text
  }
  return ''
}

function snippetOf(body, query, max = 180) {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  const q = String(query ?? '').trim()
  const needles = q ? [q, ...q.split(/[\s,，、]+/).filter((t) => t.length >= 2)] : []
  let idx = -1
  for (const needle of needles) {
    idx = text.toLowerCase().indexOf(needle.toLowerCase())
    if (idx >= 0) break
  }
  if (idx < 0) return text.slice(0, max)
  const start = Math.max(0, idx - 60)
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max)}${
    start + max < text.length ? '…' : ''
  }`
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
        index: p.name === '(vault 根目录)' ? INDEX_FILE : `${p.name}/${INDEX_FILE}`,
        topics: [...p.topics].sort(),
        types: Object.fromEntries([...p.types.entries()].sort()),
      }))
      .sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name))
  }

  /**
   * INDEX.md 是否失真：两条判据，doctor 与 kb_reindex(fixIndexes) 共用。
   *
   * 1. `rows`   —— 索引**行数**与项目笔记数不一致。只比时间戳会漏掉"笔记被删/
   *    被移走"的情形：删掉一篇后 INDEX.md 的 updated 反而比所有存活笔记都新，
   *    于是"落后"判据永远不触发，索引里会长期留着一行指向不存在的文件。
   *    （2026-09-15 验收时实测到：删掉一张卡片后再 kb_reindex({fixIndexes:true})
   *    什么也没修，INDEX.md 里那行还在。）
   * 2. `behind` —— 笔记的 max(frontmatter.updated, 文件 mtime) 比 INDEX.md 的
   *    updated 新。只看 frontmatter 会漏掉手写笔记（它们没有 updated），所以带
   *    mtime 兜底。
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
      const rows = (String(idx.body ?? '').match(/^- \[/gm) ?? []).length
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

  /** L0: the index tree (and the rendered INDEX.md of one project, if asked). */
  async index({ project = null, rebuild = false, limit = 300 } = {}) {
    await this.refresh()
    const projects = this.projectStats()
    const total = [...this.indexer.docs.keys()].length

    let markdown = null
    let written = null
    const wanted = project === null || project === undefined || project === '' ? null : String(project)
    if (wanted) {
      if (rebuild) written = await this.rebuildIndex(wanted)
      markdown = await this.renderIndex(wanted)
    } else if (rebuild) {
      written = []
      for (const p of projects) {
        if (p.name === '(vault 根目录)') continue
        written.push(await this.rebuildIndex(p.name))
      }
    }

    // Surface the staging queue + open gaps in L0 so an agent notices both the
    // unreviewed knowledge and what the library still does not know.
    const inbox = await this.inboxList({})
    const pending = new Map()
    for (const item of inbox.items) pending.set(item.project, (pending.get(item.project) ?? 0) + 1)
    const gaps = await this.gapList({})
    const openGaps = new Map()
    for (const gap of gaps.items) {
      if (gap.done) continue
      openGaps.set(gap.project, (openGaps.get(gap.project) ?? 0) + 1)
    }
    for (const p of projects) {
      const n = pending.get(p.name) ?? 0
      if (n > 0) p.pendingInbox = n
      const g = openGaps.get(p.name) ?? 0
      if (g > 0) p.pendingGaps = g
    }

    // NOTE: never put `undefined` in a returned object — the host validates tool
    // results as lossless JSON and rejects the whole call ("value is not lossless
    // JSON"). Only attach keys that carry a value.
    const result = {
      vault: {
        path: this.root,
        projectCount: projects.length,
        noteCount: total,
        inboxCount: inbox.count,
        gapCount: gaps.open,
      },
      projects,
      index: markdown,
      written,
      usage: {
        step1: 'kb_index(project) 读该项目 INDEX.md（L0）',
        step2: 'kb_search({ query, project }) 拿 L1 元数据与片段',
        step3: 'kb_read({ path }) 只读真正要用的正文（L2）',
        rule: '先读库，库内无解再联网；联网/推理得来的结论先写进 <project>/Inbox/，不要直接改正式笔记。',
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
   * L1 retrieval. `origin` defaults to local-only, so web/inferred notes stay
   * out of recall unless explicitly requested.
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
          ? ['local', 'web', 'inferred']
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
        '库内没有命中。若本任务不得不联网或自行推理，请把结论写进 <project>/Inbox/ 并标记 origin，等待归库（不要直接改正式笔记）。'
    }
    return result
  }

  /** L2: the body of one note, path-guarded to the vault. */
  async read({ path: ref, maxChars = 0 } = {}) {
    const rel = normalizeRel(ref)
    const note = await this.store.read(rel)
    if (!note) throw new NotFoundError(`笔记不存在: ${rel}`)
    const body = String(note.body ?? '')
    const truncated = maxChars > 0 && body.length > maxChars
    await this.refresh()
    const doc = this.indexer.docs.get(rel)
    return {
      path: rel,
      frontmatter: note.frontmatter ?? {},
      title: doc?.frontmatter?.title ?? note.frontmatter?.title ?? path.basename(rel, '.md'),
      origin: originOf(note.frontmatter),
      type: note.frontmatter?.type ?? null,
      chars: body.length,
      truncated,
      body: truncated ? `${body.slice(0, maxChars)}\n\n…（已截断，共 ${body.length} 字）` : body,
    }
  }

  /** Render the L0 index markdown for a project (does not write). */
  async renderIndex(project) {
    const rels = (await this.store.allFiles({ excludes: this.excludes })).filter(
      (rel) => topSegment(rel) === project
    )
    const notes = await this.store.snapshotOf(rels)
    const rows = notes.map(({ rel, frontmatter: fm, body }) => ({
      path: rel,
      rel: rel.slice(project.length + 1),
      title: fm.title ?? path.basename(rel, '.md'),
      tags: fm.tags ?? [],
      summary: fm.summary ?? firstLine(body),
      group: groupOf(rel, fm, project),
      updated: fmtDate(fm.updated),
      type: fm.type ?? null,
      origin: originOf(fm),
    }))
    if (rows.length === 0 && project !== '(vault 根目录)') {
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
          row.origin && row.origin !== 'local' ? `⚠️${row.origin}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
        const summary = row.summary ? ` — ${String(row.summary).replace(/\s+/g, ' ').slice(0, 120)}` : ''
        lines.push(`- [${row.title}](${encodeURI(row.rel)})${summary}${meta ? ` *(${meta})*` : ''}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  /** Write `<project>/INDEX.md` (L0) atomically. Returns a small receipt. */
  async rebuildIndex(project) {
    const name = String(project ?? '').trim()
    if (!name) throw new ValidationError('缺少项目名')
    const rel = `${name}/${INDEX_FILE}`
    const markdown = await this.renderIndex(name)
    const store = this.store
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
  } = {}) {
    const name = String(project ?? '').trim()
    if (!name) throw new ValidationError('缺少 project（vault 顶级目录名）')
    const text = String(content ?? '').trim()
    if (!text) throw new ValidationError('缺少 content')
    const heading = String(title ?? '').trim() || firstLine(text) || '未命名'
    const slug = slugify(heading) || 'note'
    const now = new Date().toISOString()
    const originValue = ORIGINS.has(String(origin).toLowerCase()) ? String(origin).toLowerCase() : 'inferred'
    const rel = `${this.inboxDir(name)}/${slug}.md`
    const candidates = await this.dedupe({ project: name, title: heading, content: text })
    const confidenceValue =
      confidence === null || confidence === undefined || confidence === ''
        ? null
        : Math.min(1, Math.max(0, Number(confidence) || 0))
    const frontmatter = {
      title: heading,
      type: String(kind ?? 'card'),
      tags: Array.isArray(tags) ? tags : [],
      origin: originValue,
      confidence: confidenceValue,
      source: source ? String(source) : null,
      session: session ? String(session) : null,
      status: 'inbox',
      captured: now,
      updated: now,
      suggest: candidates.slice(0, 3).map((c) => c.path),
    }
    await this.store.write(rel, { frontmatter, body: `${text}\n` })
    return {
      staged: rel,
      project: name,
      title: heading,
      origin: originValue,
      candidates,
      next: candidates.length
        ? `若与候选同主题：kb_inbox({ action:"merge", path:"${rel}", into:"<候选 path>" })（需用户批准）；否则 kb_inbox({ action:"promote", path:"${rel}" }) 归入正式目录`
        : `kb_inbox({ action:"promote", path:"${rel}" }) 归入正式目录（可加 targetDir 指定项目内子目录）`,
      indexRefreshed: false,
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
    const stagedRel = normalizeRel(staged)
    if (!stagedRel.includes(`/${INBOX_DIR}/`)) {
      throw new ValidationError(`不是 Inbox 待审条目: ${stagedRel}`)
    }
    const stagedNote = await this.store.read(stagedRel)
    if (!stagedNote) throw new NotFoundError(`待审条目不存在: ${stagedRel}`)
    const project = stagedRel.split('/')[0]
    const rawDir = String(targetDir ?? '').replace(/^[/\\]+|[/\\]+$/g, '')
    const dir = !rawDir ? project : rawDir.startsWith(`${project}/`) || rawDir === project ? rawDir : `${project}/${rawDir}`
    const file = `${dir}/${path.basename(stagedRel)}`
    if (await this.store.exists(file)) {
      throw new ValidationError(`目标已存在：${file}`, { suggestion: '改用 kb_inbox({ action:"merge", path, into })' })
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
    const index = await this.rebuildIndex(project)
    return { promoted: file, from: stagedRel, project, index }
  }

  /**
   * Staged → existing note. Append-only: `append` adds a dated section,
   * `conflict` parks it under a「⚖️ 冲突（待裁决）」section keeping both sides.
   * Callers must gate this behind user approval.
   */
  async mergeInto({ staged, into, mode = 'append', note = null } = {}) {
    const stagedRel = normalizeRel(staged)
    const targetRel = normalizeRel(into)
    if (stagedRel === targetRel) throw new ValidationError('into 不能等于 path')
    if (targetRel.includes(`/${INBOX_DIR}/`)) {
      throw new ValidationError('into 必须是正式笔记（不能是 Inbox 待审条目）')
    }
    const stagedNote = await this.store.read(stagedRel)
    if (!stagedNote) throw new NotFoundError(`待审条目不存在: ${stagedRel}`)
    const target = await this.store.read(targetRel)
    if (!target) throw new NotFoundError(`目标笔记不存在: ${targetRel}`)

    const now = new Date().toISOString()
    const day = now.slice(0, 10)
    const sfm = stagedNote.frontmatter ?? {}
    const stagedBody = String(stagedNote.body ?? '').trim()
    const provenance = `> 来源：${sfm.source ?? sfm.session ?? stagedRel}（origin: ${originOf(sfm)}, ${day}）`
    const heading = mode === 'conflict' ? '⚖️ 冲突（待裁决）' : note ? String(note) : `补充 · ${day}`
    const section = `\n\n## ${heading}\n\n${stagedBody}\n\n${provenance}\n`
    const body = `${String(target.body ?? '').replace(/\s+$/, '')}${section}`

    const prevConfidence = Number.isFinite(Number(target.frontmatter?.confidence))
      ? Number(target.frontmatter.confidence)
      : 0.7
    const previousSources = Array.isArray(target.frontmatter?.sources) ? target.frontmatter.sources : []
    const sourceRef = sfm.source ?? sfm.session ?? stagedRel
    const frontmatter = {
      ...(target.frontmatter ?? {}),
      status: target.frontmatter?.status ?? 'published',
      confidence: Math.min(1, Math.round((prevConfidence + 0.1) * 100) / 100),
      sources: [...previousSources, sourceRef].filter(Boolean),
      updated: now,
    }
    await this.store.write(targetRel, { frontmatter, body })
    await this.store.remove(stagedRel)
    const project = targetRel.split('/')[0]
    const index = await this.rebuildIndex(project)
    return {
      merged: targetRel,
      from: stagedRel,
      mode,
      addedChars: section.length,
      confidence: frontmatter.confidence,
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
    if (targetRel.includes(`/${INBOX_DIR}/`)) {
      throw new ValidationError('revise 只作用于正式笔记（Inbox 待审条目走 merge / drop）')
    }
    const list = Array.isArray(edits) ? edits : []
    if (list.length === 0) {
      throw new ValidationError('revise 需要 edits: [{ find, replace }]', {
        suggestion: '先 kb_read 取当前正文，再按实际文本给出要替换的片段',
      })
    }
    const targetNote = await this.store.read(targetRel)
    if (!targetNote) throw new NotFoundError(`目标笔记不存在: ${targetRel}`)

    const brief = (s) => (s.length > 70 ? `${s.slice(0, 70)}…` : s)
    let body = String(targetNote.body ?? '')
    const applied = []
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
      applied.push({ find: brief(find), replace: brief(replace) })
    }

    const now = new Date().toISOString()
    const prevRevisions = Array.isArray(targetNote.frontmatter?.revisions)
      ? targetNote.frontmatter.revisions.map((v) => String(v))
      : []
    // NOTE: 只写标量数组。core/frontmatter.js 的数组分支不缩进多行对象
    // （stringifyFrontmatter → keyValueLine），写对象数组会把 count/note 泄漏成
    // 顶层键并覆盖同名正式字段 —— 实测踩过，所以这里压成单行字符串。
    const stamp = [now, `${applied.length} 处`, note ? String(note).replace(/[\r\n]+/g, ' ') : null]
      .filter(Boolean)
      .join(' · ')
    const frontmatter = {
      ...(targetNote.frontmatter ?? {}),
      status: targetNote.frontmatter?.status ?? 'published',
      revisions: [...prevRevisions, stamp].slice(-20),
      updated: now,
    }
    await this.store.write(targetRel, { frontmatter, body })
    const proj = project ?? targetRel.split('/')[0]
    const index = await this.rebuildIndex(proj)
    return { revised: targetRel, edits: applied, chars: body.length, index }
  }

  /** Staged → `<project>/Inbox/.dropped/` (hidden, recoverable, out of the index). */
  async dropStaged({ path: staged, reason = null } = {}) {
    const stagedRel = normalizeRel(staged)
    if (!stagedRel.includes(`/${INBOX_DIR}/`)) {
      throw new ValidationError(`不是 Inbox 待审条目: ${stagedRel}`)
    }
    const stagedNote = await this.store.read(stagedRel)
    if (!stagedNote) throw new NotFoundError(`待审条目不存在: ${stagedRel}`)
    const project = stagedRel.split('/')[0]
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = `${project}/${INBOX_DIR}/.dropped/${path.basename(stagedRel, '.md')}.${stamp}.md`
    const frontmatter = {
      ...(stagedNote.frontmatter ?? {}),
      status: 'dropped',
      droppedAt: new Date().toISOString(),
    }
    if (reason) frontmatter.droppedReason = String(reason)
    await this.store.write(dest, { frontmatter, body: stagedNote.body ?? '' })
    await this.store.remove(stagedRel)
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
   * Checks: missing title · expired (`expires`) · broken wikilinks · duplicate
   * titles · stale `INDEX.md` · pending Inbox items.
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
    const resolves = (target) => {
      const raw = String(target).replace(/\\/g, '/')
      if (known.has(slugify(raw))) return true
      const last = raw.split('/').filter(Boolean).pop()
      return last ? known.has(slugify(last)) : false
    }

    const byTitle = new Map()
    for (const rel of rels) {
      const doc = this.indexer.docs.get(rel)
      const fm = doc.frontmatter ?? {}
      if (!fm.title) problems.push({ level: 'warn', path: rel, issue: '缺少 title' })

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

    for (const [key, list] of byTitle) {
      if (list.length > 1) {
        problems.push({ level: 'warn', path: list.join(' / '), issue: `标题/文件名重复（${list.length} 篇都叫 ${key}）` })
      }
    }

    for (const stale of await this.staleProjects(project)) {
      problems.push({
        level: 'info',
        path: stale.index,
        issue:
          stale.reason === 'missing'
            ? '缺少 INDEX.md（kb_index({ rebuild:true, project }) 或 kb_reindex({ fixIndexes:true }) 可生成）'
            : stale.reason === 'rows'
              ? `INDEX.md 与实际笔记数不一致（索引 ${stale.rows} 行 / 实际 ${stale.notes} 篇，笔记可能被删或移走；kb_reindex({ fixIndexes:true }) 可刷新）`
              : 'INDEX.md 落后于项目内最新笔记（kb_reindex({ fixIndexes:true }) 可刷新）',
      })
    }

    const inbox = await this.inboxList({ project })
    if (inbox.count > 0) {
      problems.push({
        level: 'info',
        path: `${project ?? '(全部项目)'}/${INBOX_DIR}`,
        issue: `有 ${inbox.count} 条待审知识未归库`,
      })
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
      const existing = await this.store.read(rel)
      if (!existing) plan.added.push(rel)
      else if (String(existing.body ?? '') !== String(item.body ?? '')) plan.updated.push(rel)
      else plan.unchanged.push(rel)
    }

    const summary = {
      added: plan.added.length,
      updated: plan.updated.length,
      unchanged: plan.unchanged.length,
      skipped: plan.skipped.length,
    }
    if (dryRun) {
      return {
        dryRun: true,
        plan: summary,
        sample: {
          added: plan.added.slice(0, 5),
          updated: plan.updated.slice(0, 5),
          skipped: plan.skipped.slice(0, 5),
        },
      }
    }

    let written = 0
    for (const item of safe) {
      if (plan.unchanged.includes(item.rel)) continue
      await this.store.write(item.rel, { frontmatter: item.frontmatter, body: item.body })
      written += 1
    }
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
      '- 网上/推理得来的新结论先按 dsh-kb 的 Inbox 流程待审，不要直接改正式笔记。',
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
    const rel = await this.resolveRef(ref)
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
    let index = null
    try {
      index = await this.rebuildIndex(rel.split('/')[0])
    } catch {
      index = null
    }
    return { path: rel, kind, confidence: rounded, corrections: corrections.length, index }
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
    const existing = await this.store.read(rel)
    const body0 = existing?.body ?? gapHeader(name)
    const list = parseGaps(body0)
    const id = shortHash(`${name}:${q}`)
    const dup = list.find((gap) => gap.id === id)
    if (dup) {
      return { path: rel, id, duplicate: true, done: dup.done, open: list.filter((g) => !g.done).length }
    }
    const now = new Date().toISOString()
    const line = formatGap({ id, question: q, clues, source, origin, createdAt: now })
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
  }

  /** 缺口补齐后勾掉。 */
  async gapResolve({ project, id, note = null } = {}) {
    const name = String(project ?? '').trim()
    if (!name || !id) throw new ValidationError('resolve 需要 project + id')
    const rel = this.gapFile(name)
    const existing = await this.store.read(rel)
    if (!existing) throw new NotFoundError(`没有缺口清单: ${rel}`)
    const wanted = String(id)
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
