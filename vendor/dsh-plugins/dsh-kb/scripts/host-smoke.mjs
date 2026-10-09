// dsh-kb host-half smoke test — boots the plugin's apply() with a fake cordis
// context, then drives the real HTTP routes and the model-callable tools
// against the real vault. No dsh host, no browser, no auth involved.
//
//   node scripts/host-smoke.mjs [vaultPath]
import { strict as assert } from 'node:assert'

const vault = process.argv[2] || 'D:/obsidian-repo'
process.env.OBSIDIAN_VAULT_PATH = vault

const mod = await import('../lib/index.js')
const { apply } = mod

// ---- strict-inject emulation ---------------------------------------------
// This cordis build THROWS when a plugin reads ctx.<service> without declaring
// it in `inject` (`cannot get property "X" without inject`), and that throw
// happens inside apply() → the whole plugin tree fails to load. The fake ctx
// below mirrors that strictly, so this harness catches the exact bug that broke
// DSH startup on 2026-09-14 (kb tool registration touching ctx.tools without
// `export const inject = ['tools']`).
const declared = new Set(Array.isArray(mod.inject) ? mod.inject : [])
assert.ok(
  declared.has('tools'),
  'lib/index.js 必须 `export const inject = ["tools"]`（严格 inject 契约）'
)

const routes = new Map()
const tools = new Map()
const effects = []
const promptSections = []

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
  // 插件会动态 inject approval（"改旧笔记需审批"的闸门）。这里给个"永远拒绝"的
  // 桩：本冒烟只做只读检查，任何误触审批的动作都应被拒。
  approval: {
    async request() {
      return 'denied'
    },
  },
  // 插件会动态 inject systemPrompt（「先查库 + 任务后自动沉淀」的提示词契约）。
  // 桩只记录注册进来的 section，供断言使用。
  systemPrompt: {
    section(entry) {
      promptSections.push(entry)
      return () => {}
    },
  },
}

const ctx = makeCtx(declared)

/**
 * Fake cordis context. `allowed` is the set of service names this context lets
 * the plugin read — mirroring `inject`. `ctx.inject(deps, cb)` hands the
 * callback a CHILD context where those extra services became readable (that is
 * how the real host behaves: the plugin's own apply() body may only touch
 * statically declared services).
 */
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

// apply() must not throw: a throw here is what takes DSH's startup down.
apply(ctx)

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- wiring ---------------------------------------------------------------
console.log(`vault: ${vault}\nroutes: ${[...routes.keys()].join('\n        ')}\n`)
for (const want of [
  '/api/dsh-kb/knowledge/index',
  '/api/dsh-kb/knowledge/search',
  '/api/dsh-kb/knowledge/read',
]) {
  check(routes.has(want), `路由已注册 ${want}`)
}
check(routes.size >= 16, `原有路由未被破坏（共 ${routes.size} 条）`)
for (const want of ['kb_index', 'kb_search', 'kb_read']) {
  check(tools.has(want), `工具已注册 ${want}`)
}
check(effects.includes('dsh-kb: route lifecycle'), '路由生命周期 effect 已登记')

// ---- 系统提示词契约（「自动沉淀」的触发点）---------------------------------
{
  const section = promptSections.find((s) => s.name === 'dsh-kb:knowledge-base')
  check(Boolean(section), '系统提示词 section 已注册')
  check(section?.order === 480, `section order=${section?.order}（在 persona 与 PLAN_POLICY 之间）`)
  const text = String(section?.text ?? '')
  for (const [needle, label] of [
    ['kb_index', '先查库（kb_index）'],
    ['kb_search', '检索（kb_search）'],
    ['kb_read', '按需读正文（kb_read）'],
    ['origin: local', 'origin 分级（只信 local）'],
    ['kb_capture', '任务后自动沉淀（kb_capture）'],
    ['Inbox', '新知识落 Inbox'],
    ['kb_gap', '记缺口（kb_gap）'],
    ['需要用户批准', '改旧笔记需批准'],
    ['kb_reindex', '索引自愈（kb_reindex）'],
  ]) {
    check(text.includes(needle), `提示词覆盖：${label}`)
  }
  check(promptSections.length === 1, `只注册 1 个 section（${promptSections.length}）`)
}

// ---- route driver ---------------------------------------------------------
function call(routePath, query = {}) {
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
      end(body) {
        clearTimeout(timer)
        try {
          resolve({ status: this.status, body: body ? JSON.parse(body) : null })
        } catch (err) {
          reject(new Error(`响应不是 JSON: ${String(body).slice(0, 200)}`))
        }
      },
    }
    handler({ method: 'GET', url }, res)
  })
}

// ---- L0 -------------------------------------------------------------------
const l0 = await call('/api/dsh-kb/knowledge/index')
check(l0.status === 200 && l0.body.vault.noteCount > 50, `L0 项目清单：${l0.body.vault.projectCount} 个项目 / ${l0.body.vault.noteCount} 篇`)
check(
  Array.isArray(l0.body.projects) && l0.body.projects.every((p) => p.name && p.index),
  'L0 返回每个项目的 INDEX.md 路径'
)
console.log(`  项目: ${l0.body.projects.map((p) => `${p.name}(${p.notes})`).join('  ')}`)
console.log(`  usage.rule: ${l0.body.usage.rule.slice(0, 70)}…`)

const k8s = await call('/api/dsh-kb/knowledge/index', { project: 'k8s' })
check(typeof k8s.body.index === 'string' && k8s.body.index.startsWith('# k8s · 知识索引'), 'L0 单项目：返回 INDEX.md 正文')
check(Array.isArray(k8s.body.entries?.rows) && k8s.body.entries.rows.length > 0, `L0 单项目：附带 L1 行（${k8s.body.entries?.rows?.length}）`)

// ---- L1 -------------------------------------------------------------------
const s1 = await call('/api/dsh-kb/knowledge/search', { q: 'flood-stage 磁盘只读', topK: 3 })
check(s1.body.count > 0, `L1 检索命中 ${s1.body.count} 条`)
check(
  s1.body.results.every((r) => r.path && r.origin && 'snippet' in r && typeof r.score === 'number'),
  'L1 结果含 path/origin/snippet/score'
)
check(s1.body.origins.join() === 'local', `默认只召回 local（origins=${s1.body.origins.join()})`)
console.log(`  top: ${s1.body.results[0]?.score} ${s1.body.results[0]?.path}`)

const s2 = await call('/api/dsh-kb/knowledge/search', { q: 'flood-stage', origin: 'web' })
check(s2.body.count === 0, '显式 origin=web 也拿不到未标注的笔记（防污染闸门）')

const s3 = await call('/api/dsh-kb/knowledge/search', { q: 'flood-stage', project: '启智平台管理' })
check(s3.body.count === 0, '项目过滤生效（启智平台管理 里没有 flood-stage）')

// type 分流：note = 只要没有 type 的普通笔记；wiki = 只 wiki 页
const s4 = await call('/api/dsh-kb/knowledge/search', { q: 'flood-stage', type: 'note' })
check(
  s4.body.results.every((r) => !r.type),
  `type=note 只召回普通笔记（${s4.body.count} 条，filter=${s4.body.typeFilter}）`
)
const s5 = await call('/api/dsh-kb/knowledge/search', { q: 'flood-stage', type: 'wiki' })
check(s5.body.results.every((r) => r.type === 'wiki'), `type=wiki 只召回 wiki 页（${s5.body.count} 条）`)

// ---- L2 -------------------------------------------------------------------
const r1 = await call('/api/dsh-kb/knowledge/read', { path: 'k8s/INDEX.md', maxChars: 200 })
check(r1.body.truncated === true && r1.body.body.length < 400, 'L2 读取 + maxChars 截断生效')
check(r1.body.frontmatter?.type === 'index', 'L2 返回 frontmatter')

const bad = await call('/api/dsh-kb/knowledge/read', { path: '../../../windows/win.ini' })
check(!bad.body?.body && Boolean(bad.body?.error), `路径越界被拒绝（${bad.body?.error?.slice(0, 40)}）`)

const hidden = await call('/api/dsh-kb/knowledge/read', { path: '.obsidian/app.json' })
check(Boolean(hidden.body?.error), '隐藏目录被拒绝')

// ---- tools ----------------------------------------------------------------
const searchTool = tools.get('kb_search')
const toolOut = await searchTool.execute({ query: 'mcpbridge host 头 403', topK: 2 })
check(toolOut && toolOut.count >= 1, `工具 kb_search 直接执行命中 ${toolOut?.count}`)
check(searchTool.readOnly === true && searchTool.behavior === 'read', 'kb_search 标注 readOnly/behavior')
console.log(`  ${toolOut.results?.[0]?.path}`)

const typedTool = await searchTool.execute({ query: 'flood-stage', type: 'note' })
check(
  Array.isArray(typedTool.results) && typedTool.results.every((r) => !r.type) && Boolean(typedTool.typeFilter),
  `工具 kb_search 支持 type 分流（typeFilter=${typedTool.typeFilter}）`
)

const indexTool = tools.get('kb_index')
const indexOut = await indexTool.execute({ project: '启智平台管理' })
check(indexOut?.index?.startsWith('# 启智平台管理 · 知识索引'), '工具 kb_index 能按项目出 L0')

const missing = await tools.get('kb_search').execute({})
check(missing?.ok === false && missing?.error?.code, `缺参返回结构化错误（${missing?.error?.code}）`)

const readTool = tools.get('kb_read')
const readOut = await readTool.execute({
  path: '启智平台管理/平台功能/鉴权/inspire-auth鉴权链路与servingId解密.md',
  maxChars: 120,
})
check(readOut?.path?.startsWith('启智平台管理/'), '工具 kb_read 原地读取中文路径笔记')

// ---- 反向对照：没有 inject 声明时 apply() 必须炸 ---------------------------
// 2026-09-14 的启动崩溃就是这条路径（访问 ctx.tools 而没声明 inject）。这里
// 用一个"什么都不允许"的 ctx 复现它，证明本测试确实能抓住该根因。
// ---- 反向对照：没有静态 inject 声明时 apply() 必须炸 -----------------------
// 2026-09-14 的启动崩溃正是这条路径：访问 ctx.tools 而插件没声明
// `export const inject = ['tools']`。这里用 allowed=∅ 的 ctx 精确复现它
// （webServer 那段仍走动态 inject 成功，只有 tools 会炸），证明本测试能抓住根因。
let threwWithoutInject = false
try {
  apply(makeCtx(new Set()))
} catch {
  threwWithoutInject = true
}
check(threwWithoutInject, '对照组：未声明 inject 时 apply() 必须抛错（证明测试能抓住启动崩溃根因）')

console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
