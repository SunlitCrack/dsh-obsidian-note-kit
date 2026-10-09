// dsh-kb P2 smoke test — 自动沉淀 / 去重 / Inbox 待审 / 审批闸门 / INDEX 刷新。
//
// 整个流程跑在一个**一次性临时 vault**里（%TEMP%/dsh-kb-p2-*），绝不会碰真实
// vault。审批用一个可控的 stub：'allowed-once' / 'denied' 两种结果都测，并且
// 验证「没有 exec 上下文时 fail-closed」。
//
//   node scripts/p2-smoke.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'dsh-kb-p2-'))
const project = 'demo'
const esDir = path.join(root, project, '故障手册', 'elasticsearch')
mkdirSync(esDir, { recursive: true })

const fixture = (file, frontmatter, body) =>
  writeFileSync(path.join(esDir, file), `---\n${frontmatter}\n---\n${body}\n`, 'utf8')

fixture(
  '磁盘只读.md',
  'title: ES 磁盘打满导致只读\ntags: [es, 磁盘]\nupdated: 2026-08-01',
  '# ES 磁盘打满导致只读\n\nflood-stage 水位触发只读块，写受阻。'
)
fixture(
  '索引清理.md',
  'title: ES 索引清理\ntags: [es]\nupdated: 2026-08-02',
  '# ES 索引清理\n\n按天删旧索引，注意隐藏索引要与精确名单一起删。'
)

process.env.OBSIDIAN_VAULT_PATH = root
const mod = await import('../lib/index.js')

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- 假 cordis 上下文（严格 inject，同 host-smoke）-------------------------
const declared = new Set(Array.isArray(mod.inject) ? mod.inject : [])
const routes = new Map()
const tools = new Map()
const effects = []
let approvalOutcome = 'allowed-once'
let approvalCalls = 0

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
      approvalCalls += 1
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
        if (prop === 'effect') {
          return (fn, label) => {
            effects.push(label)
            return fn()
          }
        }
        if (typeof prop === 'string' && Object.hasOwn(services, prop)) {
          if (!allowed.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
          return services[prop]
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
      has() {
        return true
      },
    }
  )
}

// apply() must not throw（严格 inject 模拟；抛错就是启动崩溃那类问题）
mod.apply(makeCtx(declared))

// ---- 路由驱动 --------------------------------------------------------------
function call(routePath, query = {}, body = null) {
  const handler = routes.get(routePath)
  if (!handler) throw new Error(`路由不存在: ${routePath}`)
  const url = `${routePath}?${new URLSearchParams(query)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`路由超时: ${url}`)), 60000)
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(payload) {
        clearTimeout(timer)
        resolve({ status: this.status, body: payload ? JSON.parse(payload) : null })
      },
    }
    const req = { method: body ? 'POST' : 'GET', url }
    if (body) {
      // readBody() 用的是 Node 的 req.on('data'|'end')，所以假 req 要按事件喂。
      const listeners = { data: [], end: [], error: [] }
      req.on = (event, fn) => {
        ;(listeners[event] ?? listeners.error).push(fn)
        return req
      }
      req.destroy = () => {}
      setTimeout(() => {
        const payload = Buffer.from(JSON.stringify(body))
        for (const fn of listeners.data) fn(payload)
        for (const fn of listeners.end) fn()
      }, 0)
    }
    handler(req, res)
  })
}

// 给工具用的 exec 上下文（approval 需要 agent；callId/signal 可选）
const goodExec = { agent: { session: {} }, callId: 'call-1' }
const tool = (name) => tools.get(name)

// ---- 1. 初始状态 -----------------------------------------------------------
{
  const idx = await tool('kb_index').execute({})
  check(idx.vault.noteCount === 2 && idx.vault.inboxCount === 0, `初始：${idx.vault.noteCount} 篇 / Inbox ${idx.vault.inboxCount}`)
  check(idx.projects.some((p) => p.name === project), `项目识别：${idx.projects.map((p) => p.name).join(',')}`)
}

// ---- 2. kb_capture：落 Inbox + 去重候选 ------------------------------------
let stagedPath = null
{
  const r = await tool('kb_capture').execute(
    {
      project,
      title: 'ES flood-stage 只读解除',
      content: 'flood-stage 水位下 ES 自动加 read_only_allow_delete 块；解除要先把磁盘降到水位以下再清块。',
      tags: ['es', '磁盘'],
      source: 'session:test',
    },
    goodExec
  )
  stagedPath = r.staged
  check(String(r.staged).startsWith(`${project}/Inbox/`), `落 Inbox：${r.staged}`)
  check(r.origin === 'inferred', `默认 origin=inferred（防污染闸门）：${r.origin}`)
  check(existsSync(path.join(root, ...r.staged.split('/'))), '待审文件已真实写盘')
  check(r.candidates.length > 0 && r.candidates[0].path.includes('磁盘只读'), `去重候选命中：${r.candidates[0]?.path} (score ${r.candidates[0]?.score})`)
}

// ---- 3. 待审条目不进索引 ---------------------------------------------------
{
  const s = await tool('kb_search').execute({ query: '只读解除', includeWeb: true })
  check(!s.results.some((r) => r.path.includes('/Inbox/')), `检索不含 Inbox 待审条目（${s.count} 条结果）`)
  const idx = await tool('kb_index').execute({ project })
  check(idx.vault.inboxCount === 1 && idx.projects[0].pendingInbox === 1, `L0 暴露待审计数：inboxCount=${idx.vault.inboxCount}, pendingInbox=${idx.projects[0].pendingInbox}`)
  const list = await tool('kb_inbox').execute({ action: 'list' })
  check(list.count === 1 && list.items[0].path === stagedPath, `待审列表 1 条：${list.items[0]?.title}`)
}

// ---- 4. 审批闸门：无 exec → fail-closed ------------------------------------
{
  const r = await tool('kb_inbox').execute({ action: 'merge', path: stagedPath, into: `${project}/故障手册/elasticsearch/磁盘只读.md` })
  check(r?.ok === false && r?.error?.code === 'APPROVAL_REQUIRED', `无 exec 上下文时 merge 被拒（${r?.error?.code}: ${String(r?.error?.message).slice(0, 40)}…）`)
}

// ---- 5. 审批闸门：denied → 仍拒绝 ------------------------------------------
{
  approvalOutcome = 'denied'
  const r = await tool('kb_inbox').execute(
    { action: 'merge', path: stagedPath, into: `${project}/故障手册/elasticsearch/磁盘只读.md` },
    goodExec
  )
  check(r?.ok === false && r?.error?.code === 'APPROVAL_REQUIRED', `用户拒绝时 merge 仍被拒（outcome=denied）`)
  const target = readFileSync(path.join(esDir, '磁盘只读.md'), 'utf8')
  check(!target.includes('## 补充'), '被拒时目标笔记未被改动')
  check(approvalCalls === 1, `审批弹窗只在有 exec 时被调用一次（${approvalCalls} 次；无 exec 那条 fail-closed 不打扰用户）`)
}

// ---- 6. 审批通过 → 合并进已有笔记 ------------------------------------------
{
  approvalOutcome = 'allowed-once'
  const r = await tool('kb_inbox').execute(
    { action: 'merge', path: stagedPath, into: `${project}/故障手册/elasticsearch/磁盘只读.md`, source: 'x' },
    goodExec
  )
  check(r.merged === `${project}/故障手册/elasticsearch/磁盘只读.md`, `合并完成：${r.merged}（+${r.addedChars} 字符）`)
  check(r.confidence === 0.8, `confidence 提升到 ${r.confidence}（默认 0.7 + 0.1）`)

  const target = readFileSync(path.join(esDir, '磁盘只读.md'), 'utf8')
  check(target.includes('## 补充 · ') && target.includes('flood-stage 水位下 ES 自动加'), '目标笔记追加了「## 补充」小节且含新内容')
  check(target.includes('> 来源：session:test'), '新内容带来源留痕')
  check(target.includes('sources:'), 'frontmatter 记录 sources')
  check(!existsSync(path.join(root, ...stagedPath.split('/'))), '合并后待审文件已消费（删除）')
  const idx = await tool('kb_index').execute({ project })
  check(idx.vault.inboxCount === 0, '合并后 Inbox 清空')
}

// ---- 7. promote：归入正式目录 + INDEX 刷新 ---------------------------------
{
  const cap = await tool('kb_capture').execute(
    { project, title: 'ES 通配删索引的假成功', content: '通配符删隐藏索引会返回 acknowledged 但没删掉，必须带精确名单。', tags: ['es'], origin: 'local' },
    goodExec
  )
  const r = await tool('kb_inbox').execute({ action: 'promote', path: cap.staged, targetDir: '故障手册/elasticsearch' }, goodExec)
  check(r.promoted === `${project}/故障手册/elasticsearch/es-通配删索引的假成功.md`, `归库到子目录：${r.promoted}`)
  const promoted = readFileSync(path.join(root, ...r.promoted.split('/')), 'utf8')
  check(promoted.includes('status: published') && promoted.includes('origin: local'), '归库后 status=published / origin 保留')
  check(!promoted.includes('suggest:'), '归库后清掉 suggest 字段')
  const index = readFileSync(path.join(root, project, 'INDEX.md'), 'utf8')
  check(index.includes('ES 通配删索引的假成功'), 'INDEX.md 已刷新并包含新笔记')
  check(r.index?.noteCount === 3, `INDEX 记录 3 篇（实际 ${r.index?.noteCount}）`)
}

// ---- 8. drop：丢弃到 .dropped（可恢复）-------------------------------------
{
  const cap = await tool('kb_capture').execute({ project, title: '临时草稿', content: '这条不要。', origin: 'inferred' }, goodExec)
  approvalOutcome = 'allowed-once'
  const r = await tool('kb_inbox').execute({ action: 'drop', path: cap.staged, reason: '测试丢弃' }, goodExec)
  check(String(r.dropped).includes('/Inbox/.dropped/'), `丢弃到隐藏目录：${r.dropped}`)
  check(existsSync(path.join(root, ...r.dropped.split('/'))), '丢弃文件仍在磁盘（可恢复）')
  const list = await tool('kb_inbox').execute({ action: 'list' })
  check(list.count === 0, '丢弃后待审队列为空')
}

// ---- 9. HTTP 路由（面板走这条）--------------------------------------------
{
  const cap = await tool('kb_capture').execute({ project, title: '面板路由测试', content: '通过 HTTP 归库。', origin: 'local' }, goodExec)
  const listed = await call('/api/dsh-kb/knowledge/inbox', {})
  check(listed.body.count === 1, `GET /knowledge/inbox 返回 ${listed.body.count} 条`)
  const promoted = await call('/api/dsh-kb/knowledge/inbox', {}, { action: 'promote', path: cap.staged })
  check(promoted.body.promoted?.startsWith(`${project}/`), `POST 归库：${promoted.body.promoted}`)
  const empty = await call('/api/dsh-kb/knowledge/inbox', {})
  check(empty.body.count === 0, '面板归库后待审队列清空（面板点击=人的同意，不再叠加审批）')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n临时 vault 已清理：${root}`)
console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
