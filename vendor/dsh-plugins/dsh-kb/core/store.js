import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { stringifyFrontmatter, parseFrontmatter } from './frontmatter.js'
import { PathError } from './errors.js'

// Marks "this asynchronous call chain is already inside a transaction".
//
// 为什么用 AsyncLocalStorage 而不是一个深度计数器：计数器分不清「同一事务内的
// 嵌套调用」与「另一个并发调用方」。两个并发 merge 时，第二个的 transact() 会
// 在第一个的 fn 还在 await 的时候被调用，计数器看到 depth>0 就把它当成重入直接
// 放行 —— 那正好把本类要提供的隔离破坏掉，而且是最难复现的那种破坏。ALS 的
// 上下文只沿同一条异步调用链传播，外部并发调用拿不到它，因此照常排队。
//
// 已知边界：事务内**不要**发起 fire-and-forget 的写（不 await 就丢出去），
// 那条链会继承上下文、在临界区之外落盘。当前代码没有这种调用。
const TXN = new AsyncLocalStorage()

// Section folders inside the vault. Keeping the three knowledge-center
// features in separate folders makes the Obsidian graph and file explorer
// clean, and lets each section own an index (Map of Content) note.
export const SECTIONS = { wiki: 'Repos', card: 'Cards', memory: 'Memory' }

// Low-level markdown store over a local directory (the "Obsidian vault").
//
// Engineering invariants:
//   * Every note is a `.md` file with YAML frontmatter + a markdown body.
//   * Writes are atomic (temp file + rename) so a crashed write never leaves a
//     half-written note, and concurrent readers see either the old or new file.
//   * Mutations are serialized through an internal queue; `transact()` lets
//     callers run a whole read-modify-write atomically with respect to other
//     mutations (so parallel upserts cannot interleave).
//   * All paths are validated so a tool argument can never escape the vault,
//     including through symlinked directories.
export class VaultStore {
  constructor(rootPath, opts = {}) {
    this.root = path.resolve(rootPath)
    this.realRoot = null
    this.logger = opts.logger ?? null
    this.version = 0
    this._queue = Promise.resolve()
  }

  abs(relPath) {
    const target = path.resolve(this.root, relPath)
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new PathError(`路径越界: ${relPath}`, { suggestion: '路径必须位于 vault 内' })
    }
    return target
  }

  rel(absPath) {
    return path.relative(this.root, absPath).split(path.sep).join('/')
  }

  /**
   * Prepare the vault root and resolve the real path used by `_guard`.
   *
   * 只创建 root 本身。历史遗留的 cardian 三区（`Repos/` `Cards/` `Memory/`）
   * 已随 RepoWiki 下线一并移除 —— dsh-kb 原地索引整个 vault，从不写那些分区，
   * 以前无条件 mkdir 它们等于让任何「只读体检」都往用户的库里塞三个空目录。
   */
  async init() {
    await fs.mkdir(this.root, { recursive: true })
    this.realRoot = await fs.realpath(this.root)
  }

  // Serialize a mutation and isolate its rejection so one failed op never
  // poisons the queue for the next.
  _enqueue(fn) {
    const run = this._queue.then(() => fn())
    this._queue = run.catch(() => {})
    return run
  }

  // 是否已在事务临界区内（决定 write/remove 要不要再排队）。
  get inTransaction() {
    return TXN.getStore() === this
  }

  /**
   * Run a read-modify-write atomically with respect to other mutations.
   *
   * 事务体内的 `read()`/`write()`/`remove()` 不再各自入队（否则会与自己的父
   * 事务互相等待，永久挂死），而是标记为「已在临界区」直接执行 —— 事务本身
   * 就是那把锁。事务外的调用不受影响，照常 `_enqueue`。
   *
   * 嵌套 `transact()` 直接执行内层 fn：它本来就在同一个临界区里，再排一次队
   * 就是自锁。
   *
   * 抛错语义与 `_enqueue` 一致：rejection 交给调用方，队列本身被 catch 隔离，
   * 一个失败的事务不会毒化后续写入。
   */
  transact(fn) {
    if (TXN.getStore() === this) return Promise.resolve().then(() => fn())
    return this._enqueue(() => TXN.run(this, () => fn()))
  }

  // Verify the resolved path does not escape the vault through a symlinked
  // directory. `parent` is the deepest existing ancestor to realpath.
  async _guard(absPath) {
    if (!this.realRoot) {
      try {
        this.realRoot = await fs.realpath(this.root)
      } catch {
        return // root does not exist yet; nothing to guard
      }
    }
    let dir = path.dirname(absPath)
    let real
    while (true) {
      try {
        real = await fs.realpath(dir)
        break
      } catch {
        const parent = path.dirname(dir)
        if (parent === dir) return // reached root without resolution
        dir = parent
      }
    }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
      throw new PathError(`路径经符号链接逃逸 vault: ${absPath}`, {
        suggestion: '移除指向 vault 外部的符号链接',
      })
    }
  }

  // Raw write (no queue). Used inside transactions.
  async _write(relPath, note) {
    const absPath = this.abs(relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await this._guard(absPath)
    const text = stringifyFrontmatter(note.frontmatter) + (note.body ?? '')
    const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, absPath)
    this.version++
    return absPath
  }

  write(relPath, note) {
    // 事务内：写已经处在临界区里，再排队就是自锁。
    if (this.inTransaction) return this._write(relPath, note)
    return this._enqueue(() => this._write(relPath, note))
  }

  async _remove(relPath) {
    await fs.rm(this.abs(relPath), { force: true })
    this.version++
  }

  remove(relPath) {
    if (this.inTransaction) return this._remove(relPath)
    return this._enqueue(() => this._remove(relPath))
  }

  async read(relPath) {
    const absPath = this.abs(relPath)
    try {
      const text = await fs.readFile(absPath, 'utf8')
      return parseFrontmatter(text)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  /**
   * Resolve `relPath` to the path **as stored on disk**, or null when absent.
   *
   * Needed because the file systems we run on (NTFS, APFS) are case-insensitive:
   * `fs.readFile('p/Inbox/x.md')` happily returns `p/inbox/x.md`, so a caller can
   * present a casing that passes a string check and still hit a different file.
   * Guard code that must reason about the real layout (Inbox boundaries) uses
   * this instead of trusting the caller's spelling.
   */
  async realRel(relPath) {
    const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    const segments = rel.split('/').filter(Boolean)
    if (!segments.length) return null
    let current = ''
    for (const segment of segments) {
      let entries
      try {
        entries = await fs.readdir(this.abs(current || '.'))
      } catch {
        return null
      }
      const exact = entries.find((name) => name === segment)
      if (exact) {
        current = current ? `${current}/${exact}` : exact
        continue
      }
      // 大小写不敏感兜底：只接受唯一的大小写变体，多个候选视为歧义 → 不解析。
      const folded = entries.filter((name) => name.toLowerCase() === segment.toLowerCase())
      if (folded.length !== 1) return null
      current = current ? `${current}/${folded[0]}` : folded[0]
    }
    return current
  }

  async exists(relPath) {
    try {
      await fs.access(this.abs(relPath))
      return true
    } catch {
      return false
    }
  }

  // List `.md` files under a directory (recursive), returned as vault-relative
  // paths with forward slashes. Skips derived index / MOC notes.
  async list(dirRel) {
    const dirAbs = this.abs(dirRel)
    const out = []
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return out
      throw err
    }
    for (const entry of entries) {
      const rel = this.rel(path.join(dirAbs, entry.name))
      if (entry.isDirectory()) {
        out.push(...(await this.list(rel)))
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // 与 allFiles() 共用同一条判定：只有「项目根层的派生索引 / MOC」才算
        // 派生文件，嵌套的 `index.md` / `moc.md` 是真实笔记。两处口径必须一致，
        // 否则同一文件在 list() 与 allFiles() 里会得到相反答案。
        if (isDerivedFileName(rel)) continue
        out.push(rel)
      }
    }
    return out
  }

  // Per-file mtimes for every non-index note, WITHOUT reading or parsing file
  // contents. The indexer diffs these per-note mtimes to catch external/hand
  // edits cheaply (stat sweep, not re-tokenize).
  async fileStats() {
    const out = []
    for (const dir of Object.values(SECTIONS)) {
      for (const rel of await this.list(dir)) {
        try {
          const st = await fs.stat(this.abs(rel))
          out.push({ rel, mtimeMs: st.mtimeMs })
        } catch {
          /* removed between listing and statting */
        }
      }
    }
    return out
  }

  // dsh-kb: enumerate EVERY markdown note in the vault (not just the three
  // legacy sections), so the knowledge base can index notes where they live.
  // Hidden dirs (`.obsidian`, `.git`, `.dsh-trash`, …), `node_modules`, the
  // derived `INDEX.md` files and `excludes` (top-level names) are skipped.
  async allFiles({ excludes = [], root = '' } = {}) {
    const skip = new Set(
      (Array.isArray(excludes) ? excludes : []).map((e) => String(e).replace(/[\\/]+$/, ''))
    )
    const out = []
    const walk = async (dirRel) => {
      let entries
      try {
        entries = await fs.readdir(this.abs(dirRel || '.'), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || skip.has(entry.name)) {
            continue
          }
          await walk(rel)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // 与 list() 共用同一个谓词。此前这里是 isDerivedIndex（只认 INDEX.md），
          // 而 list() 用 isDerivedFileName（还认 README/_index/MOC/moc），
          // 两套口径让根层的 README.md 进索引却在 list() 里被跳过。
          if (isDerivedFileName(rel)) continue
          out.push(rel)
        }
      }
    }
    await walk(root)
    return out
  }

  // Read an explicit list of notes (pair with allFiles()).
  async snapshotOf(rels) {
    const notes = []
    for (const rel of rels ?? []) {
      const note = await this.read(rel)
      if (note) notes.push({ rel, frontmatter: note.frontmatter, body: note.body })
    }
    return notes
  }

  // Per-file mtimes for an explicit list of notes.
  async fileStatsOf(rels) {
    const out = []
    for (const rel of rels ?? []) {
      try {
        const st = await fs.stat(this.abs(rel))
        out.push({ rel, mtimeMs: st.mtimeMs })
      } catch {
        /* removed between listing and statting */
      }
    }
    return out
  }

  // Read every non-index note in every section in one pass.
  async snapshot() {
    const notes = []
    for (const dir of Object.values(SECTIONS)) {
      for (const rel of await this.list(dir)) {
        const note = await this.read(rel)
        if (note) notes.push({ rel, frontmatter: note.frontmatter, body: note.body })
      }
    }
    return notes
  }
}

function isIndexName(name) {
  const stem = name.replace(/\.md$/i, '')
  return /^(README|_index|index|MOC|moc)$/i.test(stem)
}

// dsh-kb 把「vault 根 / 项目根」这一层的索引类文件（`INDEX.md`、`README.md`、
// `_index.md`、`MOC.md`、`moc.md`）当作派生 L0 产物：allFiles() 与 list() 都跳过，
// 索引才不会把自己收进检索、也不会让每个标题都重复一遍。
//
// 只有根层：更深的 `<project>/<topic>/index.md` 是**手写笔记**（真实库里
// `k8s/知识笔记/index.md` 就是手写分类总表）。早先按 basename 单独匹配
// `/^INDEX\.md$/i`，把嵌套 index 一并排除，导致 `kb_search` 搜不到它、
// 任何 `[[…/index]]` 链接都判成断链。
//
// 两条 API 必须共用这一个谓词 —— 否则同一文件会在 list() 与 allFiles() 里
// 得到相反答案（此前 `README.md` / `moc.md` 正是如此）。
function isDerivedFileName(rel) {
  const parts = String(rel ?? '').split('/')
  if (parts.length > 2) return false
  return isIndexName(parts[parts.length - 1])
}

// 兼容旧名：外部只关心「派生索引」语义时用它。
function isDerivedIndex(rel) {
  const parts = String(rel ?? '').split('/')
  return parts.length <= 2 && /^INDEX\.md$/i.test(parts[parts.length - 1])
}
