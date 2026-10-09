// dsh-kb P3 smoke test — RepoWiki：扫仓库 → 骨架页 → 依赖图 → 双向 sync →
// 语义回填保护 → 增量新增/剪除孤儿。
//
// 一次性临时 vault + 一次性临时 fixture 仓库，**绝不碰真实 vault / 真实仓库**。
//
//   node scripts/p3-smoke.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-p3-vault-'))
const repoDir = mkdtempSync(path.join(tmpdir(), 'dsh-kb-p3-repo-'))
const repo = 'demorepo'

mkdirSync(path.join(repoDir, 'src'), { recursive: true })
mkdirSync(path.join(repoDir, 'node_modules', 'x'), { recursive: true })
writeFileSync(
  path.join(repoDir, 'src', 'a.js'),
  "import { b } from './b.js'\n\nexport function a() {\n  return b()\n}\n",
  'utf8'
)
writeFileSync(path.join(repoDir, 'src', 'b.js'), "export function b() {\n  return 'MARKER_BEE'\n}\n", 'utf8')
writeFileSync(path.join(repoDir, 'README.md'), '# Demo repo\n\nfixture for dsh-kb P3.\n', 'utf8')
writeFileSync(path.join(repoDir, 'node_modules', 'x', 'skip.js'), 'export const skip = true\n', 'utf8')

process.env.OBSIDIAN_VAULT_PATH = vault
const mod = await import('../lib/index.js')

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- 假 cordis 上下文（严格 inject，同 host-smoke / p2-smoke）-------------
const declared = new Set(Array.isArray(mod.inject) ? mod.inject : [])
const routes = new Map()
const tools = new Map()
let approvalOutcome = 'allowed-once'
const services = {
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  webServer: {
    register({ path: routePath, handler }) {
      routes.set(routePath, handler)
      return () => routes.delete(routePath)
    },
  },
  approval: {
    async request() {
      return approvalOutcome
    },
  },
  // 插件动态 inject systemPrompt（提示词契约）；本冒烟只需要它别抛。
  systemPrompt: {
    section() {
      return () => {}
    },
  },
}
function makeCtx(allowed) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'inject') {
          return (deps, fn) => {
            for (const dep of deps) assert.ok(services[dep], `inject 了未知服务: ${dep}`)
            return fn(makeCtx(new Set([...allowed, ...deps])))
          }
        }
        if (prop === 'effect') return (fn) => fn()
        if (typeof prop === 'string' && Object.hasOwn(services, prop)) {
          if (!allowed.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
          return services[prop]
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
      has: () => true,
    }
  )
}
mod.apply(makeCtx(declared))

const tool = (name) => {
  const item = tools.get(name)
  assert.ok(item, `工具未注册: ${name}`)
  return item
}
const exec = { agent: { session: {} }, callId: 'call-p3' }
const pageRel = (flattened) => path.join(vault, repo, `${flattened}.md`)
const readPage = (flattened) => readFileSync(pageRel(flattened), 'utf8')

// ---- 1. 工具面 -------------------------------------------------------------
{
  const names = [...tools.keys()]
  const expected = [
    'kb_wiki_ingest',
    'kb_wiki_sync',
    'kb_wiki_upsert',
    'kb_wiki_overview',
    'kb_wiki_graph',
    'kb_wiki_list',
    'kb_wiki_delete',
  ]
  check(
    expected.every((n) => names.includes(n)),
    `7 个 kb_wiki_* 工具已注册（共 ${names.length} 个工具）`
  )
}

// ---- 2. ingest：扫仓库 → 每个源文件一张骨架页 ------------------------------
let ingest = null
{
  ingest = await tool('kb_wiki_ingest').execute({ repoPath: repoDir, repoName: repo, maxFiles: 20 }, exec)
  check(ingest.count >= 3, `ingest 生成 ${ingest.count} 张骨架页（a.js / b.js / README.md）`)
  check(ingest.repo === repo, `repo 名归一到 slug：${ingest.repo}`)

  const aPage = readPage('src-a')
  check(existsSync(pageRel('src-a')), `页面原地落在 <repo>/：${path.relative(vault, pageRel('src-a'))}`)
  check(/^type:\s*wiki$/m.test(aPage) && /^repo:\s*demorepo$/m.test(aPage) && /^path:\s*src\/a\.js$/m.test(aPage), 'frontmatter: type=wiki / repo / path 保留源码路径')
  const fmBlock = (aPage.split('---')[1] ?? '').trim()
  if (!/analysisLevel:\s*static/.test(aPage) || !/language:\s*js/.test(aPage)) {
    console.error('--- src-a.md frontmatter（诊断用）---\n' + fmBlock + '\n---')
  }
  check(/analysisLevel:\s*static/.test(aPage), 'frontmatter: analysisLevel=static（骨架页标记）')
  check(/^language:\s*[a-z]+/im.test(aPage), 'frontmatter: language 记录了源文件语言')

  const list = await tool('kb_wiki_list').execute({ repo }, exec)
  const listRows = Array.isArray(list) ? list : (list.entries ?? list.rows ?? [])
  const paths = listRows.map((e) => e.path ?? e.rel)
  check(!paths.some((p) => String(p).includes('node_modules')), 'node_modules 被跳过（没有对应页面）')
  check(!existsSync(pageRel('node_modules-x-skip')), 'node_modules 里的文件确实没有生成页面')
}

// ---- 3. 页面进共享索引 + L0 按源码路径分组 ---------------------------------
{
  const search = await tool('kb_search').execute({ query: 'MARKER_BEE' })
  check(
    search.results.some((r) => r.path === `${repo}/src-b.md`),
    `wiki 页可被 kb_search 命中（${search.results[0]?.path}）`
  )

  const idx = await tool('kb_index').execute({ project: repo })
  check(String(idx.index).startsWith(`# ${repo} · 知识索引`), 'L0：该 repo 已是 vault 项目并生成 INDEX.md')
  check(/^## src$/m.test(String(idx.index)), 'L0 按源码目录分组（## src）')
  check(existsSync(path.join(vault, repo, 'INDEX.md')), 'INDEX.md 已落盘')
  const rows = idx.entries?.rows ?? []
  check(
    rows.find((r) => r.path === `${repo}/src-a.md`)?.group === 'src',
    'L1 行的 group 用的是源码路径（src），不是磁盘扁平路径'
  )
}

// ---- 4. 语义回填（AI 凝练的落点）-------------------------------------------
{
  const up = await tool('kb_wiki_upsert').execute(
    {
      repo,
      path: 'src/b.js',
      content: '## 职责\n\n导出 `b()`，返回常量 MARKER_BEE。\n',
      summary: 'b 模块：返回 MARKER_BEE',
      status: 'published',
    },
    exec
  )
  check(Boolean(up.rel ?? up.path ?? up.title), `upsert 完成：${up.rel ?? up.path ?? ''}`)
  const page = readPage('src-b')
  check(page.includes('## 职责') && page.includes('analysisLevel: manual'), '回填后 body 被语义描述替换，analysisLevel=manual')
}

// ---- 5. 依赖图：a.js → b.js 的 import 边 -----------------------------------
{
  const graph = await tool('kb_wiki_graph').execute({ repo }, exec)
  const edges = graph.edges ?? []
  const nodes = graph.nodes ?? []
  check(Array.isArray(edges) && edges.length >= 1, `依赖图有 ${edges.length} 条边 / ${nodes.length} 个节点`)
  const flat = JSON.stringify(graph)
  check(flat.includes('src/a.js') && flat.includes('src/b.js'), '依赖图节点含 a.js 与 b.js')
}

// ---- 6. sync：不冲掉已语义回填的页面 --------------------------------------
{
  const sync = await tool('kb_wiki_sync').execute(
    { repoPath: repoDir, repoName: repo, pruneOrphans: true, maxFiles: 50 },
    exec
  )
  check(readPage('src-b').includes('## 职责'), 'sync 之后语义回填页**未被骨架覆盖**（ai/manual 受保护）')
  check(
    (sync.unchanged ?? 0) + (sync.preserved ?? []).length >= 1,
    `sync 报告：added=${(sync.added ?? []).length} changed=${(sync.changed ?? []).length} pruned=${(sync.pruned ?? []).length} unchanged=${sync.unchanged ?? 0} preserved=${(sync.preserved ?? []).length}`
  )
}

// ---- 7. sync：新增文件 → 增量新增骨架 --------------------------------------
{
  writeFileSync(path.join(repoDir, 'src', 'c.js'), "export const c = 'CEE'\n", 'utf8')
  const sync = await tool('kb_wiki_sync').execute({ repoPath: repoDir, repoName: repo }, exec)
  const added = (sync.added ?? []).map((a) => a.path ?? a)
  check(added.includes('src/c.js') && existsSync(pageRel('src-c')), `增量新增：${JSON.stringify(added)}`)
}

// ---- 8. sync：删文件 → 剪除孤儿页 ------------------------------------------
{
  rmSync(path.join(repoDir, 'src', 'a.js'))
  const sync = await tool('kb_wiki_sync').execute({ repoPath: repoDir, repoName: repo, pruneOrphans: true }, exec)
  const pruned = (sync.pruned ?? []).map((p) => p.path ?? p)
  check(pruned.includes('src/a.js'), `剪除孤儿页：${JSON.stringify(pruned)}`)
  check(!existsSync(pageRel('src-a')), '被剪除的页面确实从磁盘删除')
}

// ---- 9. overview：项目级概览 ----------------------------------------------
{
  const ov = await tool('kb_wiki_overview').execute({ repo }, exec)
  check(ov.pages >= 2, `概览页生成，覆盖 ${ov.pages} 个页面（写入 ${ov.rel}）`)
  const ovPage = readFileSync(path.join(vault, repo, 'project-overview.md'), 'utf8')
  check(
    ovPage.includes('src/b.js') || ovPage.includes('src-c.js') || ovPage.includes('src/c.js'),
    '概览页 project-overview.md 含页面清单'
  )
}

// ---- 10. delete：按 (repo, path) 删除页面 ---------------------------------
{
  const del = await tool('kb_wiki_delete').execute({ repo, path: 'src/b.js' }, exec)
  check(del.deleted === true && !existsSync(pageRel('src-b')), 'kb_wiki_delete 删掉了 src/b.js 的页面')
}

// ---- 11. 索引仍一致 --------------------------------------------------------
{
  const search = await tool('kb_search').execute({ query: 'MARKER_BEE' })
  check(!search.results.some((r) => r.path === `${repo}/src-b.md`), '删除后索引里也不再返回该页（增量刷新生效）')
}

// ---- 12. 面板「代码」页走的 HTTP 路由 -------------------------------------
// 面板不经过 agent 工具，走的是这 6 条路由；它们必须与上面的工具结果一致。
{
  const request = (routePath, { method = 'GET', query = {}, payload = null } = {}) => {
    const handler = routes.get(routePath)
    assert.ok(handler, `路由不存在: ${routePath}`)
    const url = `${routePath}?${new URLSearchParams(query)}`
    const bodyText = payload === null ? '' : JSON.stringify(payload)
    return new Promise((resolve) => {
      const req = {
        method,
        url,
        on(event, fn) {
          if (event === 'data' && bodyText) fn(Buffer.from(bodyText, 'utf8'))
          if (event === 'end') fn()
          return req
        },
      }
      const res = {
        status: 0,
        writeHead(s) {
          this.status = s
        },
        end(text) {
          resolve({ status: this.status, body: text ? JSON.parse(text) : null })
        },
      }
      handler(req, res)
    })
  }

  const repos = await request('/api/dsh-kb/wiki/repos')
  check(repos.body.repos.includes(repo), `GET /wiki/repos 列出仓库：${JSON.stringify(repos.body.repos)}`)

  const list = await request('/api/dsh-kb/wiki/list', { query: { repo } })
  check(list.body.entries.length >= 2, `GET /wiki/list 返回 ${list.body.entries.length} 页`)
  check(
    list.body.entries.every((e) => Boolean(e.rel)) && list.body.entries.some((e) => e.analysisLevel),
    '每页含 rel（代码页另有 analysisLevel，面板据此翻角标）'
  )

  const graphRoute = await request('/api/dsh-kb/wiki/graph', { query: { repo } })
  const linked = graphRoute.body.nodes.filter((n) => n.rel)
  check(linked.length === graphRoute.body.nodes.length, `GET /wiki/graph 给每个节点补上 vault rel（${linked.length}/${graphRoute.body.nodes.length}）`)
  check(Array.isArray(graphRoute.body.edges) && Boolean(graphRoute.body.callers), '图谱带 edges + callers（面板画依赖图）')

  const overviewRoute = await request('/api/dsh-kb/wiki/overview', { query: { repo } })
  check(String(overviewRoute.body.body).includes('# 项目概览'), 'GET /wiki/overview 只读返回概览正文（不刷新）')

  // 再扫一次：全部命中幂等保护 → written 0 / skipped 全部
  const scan = await request('/api/dsh-kb/wiki/scan', {
    method: 'POST',
    payload: { repoPath: repoDir, repoName: repo, maxFiles: 20 },
  })
  check(
    scan.body.skipped >= 2 && scan.body.count === 1 && scan.body.files?.[0]?.path === 'src/b.js',
    `POST /wiki/scan：写入 ${scan.body.count} 页 / 跳过 ${scan.body.skipped} 页已存在页（只补回第 10 步删掉的 src/b.js）`
  )

  const syncRoute = await request('/api/dsh-kb/wiki/sync', {
    method: 'POST',
    payload: { repoPath: repoDir, repoName: repo, maxFiles: 20 },
  })
  check(
    Array.isArray(syncRoute.body.added) && Array.isArray(syncRoute.body.preserved),
    `POST /wiki/sync 返回对账报告：${syncRoute.body.added ? `新增 ${syncRoute.body.added.length} / 保留 ${syncRoute.body.preserved.length}` : JSON.stringify(syncRoute.body).slice(0, 300)}`
  )

  const missingRepo = await request('/api/dsh-kb/wiki/graph')
  check(missingRepo.status >= 400, `GET /wiki/graph 缺 repo → 报错（HTTP ${missingRepo.status}）`)
  const missingPath = await request('/api/dsh-kb/wiki/scan', { method: 'POST', payload: {} })
  check(missingPath.status >= 400, `POST /wiki/scan 缺 repoPath → 报错（HTTP ${missingPath.status}）`)
}

rmSync(vault, { recursive: true, force: true })
rmSync(repoDir, { recursive: true, force: true })
console.log(`\n临时 vault / 仓库已清理`)
console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
