// dsh-kb P5 smoke test — 缺口清单（用出来的知识库）+ 链接图谱 + 索引自愈。
//
// 一次性临时 vault，绝不碰真实 vault。
//
//   node scripts/p5-smoke.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-p5-vault-'))
const proj = 'proj'

const put = (rel, frontmatter, body) => {
  const abs = path.join(vault, ...rel.split('/'))
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
}

put('proj/hub.md', 'title: 中枢\ntags: [x]', '# 中枢\n\n见 [[leaf-a]] 与 [[leaf-b]]。')
put('proj/leaf-a.md', 'title: 叶子 A\ntags: [x]', '# 叶子 A\n\n见 [[hub]]。')
put('proj/leaf-b.md', 'title: 叶子 B\ntags: [y]', '# 叶子 B\n\n正文。')
put('proj/orphan.md', 'title: 孤儿\ntags: [y]', '# 孤儿\n\n谁也不引用我，我也不引用谁。')
put('proj/sub/deep.md', 'title: 深层\ntags: [x]', '# 深层\n\n见 [[hub]]。')
// stale INDEX.md：updated 远早于项目内最新笔记 → 体检应该抓到，fixIndexes 应该修好
put('proj/INDEX.md', 'title: proj 索引\ntype: index\nupdated: 2000-01-01T00:00:00.000Z\ngenerator: dsh-kb', '# proj\n\n（故意过期）')

process.env.OBSIDIAN_VAULT_PATH = vault
const mod = await import('../lib/index.js')

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- 假 cordis 上下文（严格 inject）---------------------------------------
const declared = new Set(Array.isArray(mod.inject) ? mod.inject : [])
const routes = new Map()
const tools = new Map()
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
      return 'allowed-once'
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
const exec = { agent: { session: {} }, callId: 'call-p5' }
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
      end(payloadText) {
        resolve({ status: this.status, body: payloadText ? JSON.parse(payloadText) : null })
      },
    }
    handler(req, res)
  })
}

// ---- 1. 工具面 -------------------------------------------------------------
{
  const expected = ['kb_gap', 'kb_graph', 'kb_reindex']
  const names = [...tools.keys()]
  check(expected.every((n) => names.includes(n)), `3 个 P5 工具已注册（共 ${names.length} 个）`)
  check(names.length === 22, `工具总数为 22（实际 ${names.length}）`)
}

// ---- 2. 缺口清单 -----------------------------------------------------------
let gapId = null
{
  const listed = await tool('kb_gap').execute({ action: 'list' }, exec)
  check(listed.count === 0 && listed.open === 0, '初始没有缺口')

  const added = await tool('kb_gap').execute(
    { action: 'add', project: proj, question: 'k8s 里 Pod 一直 Pending 有哪些原因？', clues: 'Pending / 调度', origin: 'web' },
    exec
  )
  gapId = added.id
  check(added.duplicate === false && added.open === 1, `记下缺口：id=${added.id}，未补 1 条`)
  check(added.path === `${proj}/Inbox/缺口.md` && existsSync(path.join(vault, proj, 'Inbox', '缺口.md')), '缺口落在 Inbox/缺口.md')

  const dup = await tool('kb_gap').execute(
    { action: 'add', project: proj, question: 'k8s 里 Pod 一直 Pending 有哪些原因？' },
    exec
  )
  check(dup.duplicate === true && dup.open === 1, '同一问题重复记录 → 幂等（不新增条目）')

  const bad = await tool('kb_gap').execute({ action: 'add', project: proj }, exec)
  check(bad?.ok === false && bad?.error?.code === 'VALIDATION', '缺 question → 校验错误（VALIDATION）')

  const file = readFileSync(path.join(vault, proj, 'Inbox', '缺口.md'), 'utf8')
  check(file.includes(gapId) && file.includes('- [ ]'), '缺口文件含 id 与未完成复选框')
  check(/- \[( |x)\] <!--gap:[0-9a-f]+--> \*\*/.test(file), `缺口行格式可回读：${file.split('\n')[6] ?? ''}`)

  const idx = await tool('kb_index').execute({}, exec)
  const row = idx.projects.find((p) => p.name === proj)
  check(row?.pendingGaps === 1, `L0 索引暴露 pendingGaps=${row?.pendingGaps}`)
  check(idx.vault.gapCount === 1, `L0 vault.gapCount=${idx.vault.gapCount}`)
  check(idx.vault.noteCount === 5, `缺口文件在 Inbox 内，未污染索引（仍 ${idx.vault.noteCount} 篇）`)

  const doc = await tool('kb_doctor').execute({ project: proj }, exec)
  const issues = doc.problems.map((p) => p.issue)
  check(issues.some((i) => i.includes('缺口未补') && i.includes('Pending')), '体检把未补缺口报成 info')
  check(issues.some((i) => i.includes('INDEX.md 与实际笔记数不一致')), '体检抓到 INDEX.md 行数不一致（人为造的陈旧索引：0 行 vs 5 篇）')
}

// ---- 3. HTTP 缺口路由 ------------------------------------------------------
{
  const listed = await request('/api/dsh-kb/knowledge/gaps', { query: { project: proj } })
  check(listed.body.open === 1, 'HTTP GET /knowledge/gaps 可用')

  const resolved = await request('/api/dsh-kb/knowledge/gaps', {
    method: 'POST',
    payload: { action: 'resolve', project: proj, id: gapId, note: 'proj/调度排查.md' },
  })
  check(resolved.body.open === 0 && resolved.body.done === 1, 'HTTP POST resolve 勾掉缺口')

  const file = readFileSync(path.join(vault, proj, 'Inbox', '缺口.md'), 'utf8')
  check(file.includes('- [x]') && file.includes('已补：proj/调度排查.md'), '缺口文件落了完成状态与补充说明')

  const after = await tool('kb_gap').execute({ action: 'resolve', project: proj, id: 'deadbeef' }, exec)
  check(after?.ok === false && after?.error?.code === 'NOT_FOUND', '未知缺口 id → NOT_FOUND')

  const idx = await tool('kb_index').execute({}, exec)
  check(idx.vault.gapCount === 0, `补齐后 L0 vault.gapCount=${idx.vault.gapCount}`)
}

// ---- 4. 链接图谱 -----------------------------------------------------------
{
  const graph = await tool('kb_graph').execute({ project: proj }, exec)
  const byPath = new Map(graph.nodes.map((n) => [n.path, n]))
  check(graph.nodeCount === 5 && graph.edgeCount === 4, `图谱：${graph.nodeCount} 节点 / ${graph.edgeCount} 边`)
  check(byPath.get('proj/hub.md')?.in === 2 && byPath.get('proj/hub.md')?.out === 2, `hub 入链 ${byPath.get('proj/hub.md')?.in} / 出链 ${byPath.get('proj/hub.md')?.out}`)
  check(graph.nodes[0].path === 'proj/hub.md', `节点按 degree 降序（第一 = ${graph.nodes[0].path}，degree=${graph.nodes[0].degree}）`)
  check(byPath.get('proj/orphan.md')?.degree === 0 && graph.isolated === 1, '孤儿笔记被识别（isolated=1）')
  check(byPath.get('proj/sub/deep.md')?.group === 'sub', `group 由目录派生（deep → ${byPath.get('proj/sub/deep.md')?.group}）`)

  const viaRoute = await request('/api/dsh-kb/knowledge/graph', { query: { project: proj, limit: '3' } })
  check(viaRoute.body.nodes.length === 3 && viaRoute.body.nodeCount === 5, 'HTTP /knowledge/graph 支持 limit')
}

// ---- 5. 索引自愈 -----------------------------------------------------------
{
  const once = await tool('kb_reindex').execute({}, exec)
  check(once.notes === 5 && typeof once.ms === 'number', `强制全量重建：${once.notes} 篇 / ${once.ms}ms`)

  const fixed = await tool('kb_reindex').execute({ fixIndexes: true, project: proj }, exec)
  check(fixed.fixed.length === 1 && fixed.fixed[0].project === proj, `fixIndexes 刷新了落后索引：${JSON.stringify(fixed.fixed.map((f) => f.project))}`)
  const idxText = readFileSync(path.join(vault, proj, 'INDEX.md'), 'utf8')
  check(!idxText.includes('2000-01-01'), 'INDEX.md 的 updated 已被刷新')

  const doc = await tool('kb_doctor').execute({ project: proj }, exec)
  check(!doc.problems.some((p) => p.issue.includes('INDEX.md 落后')), '修复后体检不再报 INDEX.md 落后')

  // 2026-09-15 真实验收踩到的坑：**笔记被删**时 INDEX.md 的 updated 反而比存活
  // 笔记都新 → "落后"判据永不触发，索引里会长期留一行指向不存在的文件。所以要
  // 额外比"行数 vs 实际笔记数"。
  {
    const idxPath = path.join(vault, proj, 'INDEX.md')
    const before = readFileSync(idxPath, 'utf8')
    writeFileSync(idxPath, `${before}- [已删除的笔记](gone.md) — 这行指向不存在的文件\n`, 'utf8')
    const detected = await tool('kb_reindex').execute({ fixIndexes: true, project: proj }, exec)
    check(
      detected.fixed.some((f) => f.reason === 'rows'),
      `INDEX.md 行数与实际笔记数不一致被抓到（reasons=${detected.fixed.map((f) => f.reason).join(',')}）`
    )
    const after = readFileSync(idxPath, 'utf8')
    check(!after.includes('已删除的笔记'), 'fixIndexes 重写后幽灵条目消失')
    check((after.match(/^- \[/gm) ?? []).length === 5, `重写后行数 = 笔记数（${(after.match(/^- \[/gm) ?? []).length}）`)
    const ghostDoc = await tool('kb_doctor').execute({ project: proj }, exec)
    check(!ghostDoc.problems.some((p) => p.issue.includes('不一致')), '修复后体检不再报"索引行数与笔记数不一致"')
  }

  // 外部改动后索引按 mtime 自愈（不靠 reindex）
  put('proj/leaf-c.md', 'title: 叶子 C\ntags: [z]', '# 叶子 C\n\n见 [[hub]]。')
  const search = await tool('kb_search').execute({ query: '叶子 C' }, exec)
  check(search.results.some((r) => r.path === 'proj/leaf-c.md'), '外部新增文件后 kb_search 自动可见（mtime 自愈）')
  const graph2 = await tool('kb_graph').execute({ project: proj }, exec)
  check(graph2.nodeCount === 6 && graph2.edgeCount === 5, `新文件进图谱：${graph2.nodeCount} 节点 / ${graph2.edgeCount} 边`)

  // 面板「洞察 · 体检」里的一键按钮走的就是这条 POST
  const viaRoute = await request('/api/dsh-kb/knowledge/reindex', {
    method: 'POST',
    payload: { fixIndexes: true, project: proj },
  })
  check(
    viaRoute.body.notes === 6 && viaRoute.body.fixed.length === 1,
    `HTTP POST /knowledge/reindex 可用（重建 ${viaRoute.body.notes} 篇 / 刷新 ${viaRoute.body.fixed.length} 个项目索引）`
  )
  const afterFix = await tool('kb_doctor').execute({ project: proj }, exec)
  check(!afterFix.problems.some((p) => p.issue.includes('INDEX.md')), '一键重建后体检不再报 INDEX.md')
}

rmSync(vault, { recursive: true, force: true })
console.log('\n临时 vault 已清理')
console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
