// dsh-kb tool-output smoke — every tool result must survive the HOST's own
// lossless-JSON boundary.
//
// Why this exists: the host validates each tool's return value with
// `snapshotJsonValue()` from @deepseek-ai/dsh-util-values and rejects the call
// with `tool "X" returned invalid output: value is not lossless JSON` if any
// property is `undefined` (or a function/symbol/NaN/-0/sparse array). The
// in-process smokes call `execute()` directly, so they never exercise that
// boundary — that is exactly how the P1 `kb_index` bug reached the live host,
// and this script later caught the same leak in `kb_backlinks`/`kb_related`
// (`type: undefined` on notes without a `type`).
//
// Two modes:
//   node scripts/tool-output-smoke.mjs              # 一次性临时 vault：22 个工具全跑
//   node scripts/tool-output-smoke.mjs --readonly   # 真实 vault：只跑只读工具（不写盘）
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REAL = process.argv.includes('--readonly')
const DSH_APP = process.env.DSH_APP_DIR || 'D:/DSH Desktop/resources/app'
const validatorPath = `${DSH_APP}/node_modules/@deepseek-ai/dsh-util-values/lib/index.js`
if (!existsSync(validatorPath)) {
  console.error(`✗ 找不到宿主校验器: ${validatorPath}（用 DSH_APP_DIR 指定 DSH 安装目录）`)
  process.exit(1)
}
const { snapshotJsonValue } = await import(pathToFileURL(validatorPath).href)

// ---- 一次性临时 vault + fixture 仓库（真实模式不建、不写）------------------
let vault = null
let repoDir = null
const proj = 'proj'
const repo = 'demorepo'

if (REAL) {
  vault = process.env.OBSIDIAN_VAULT_PATH || 'D:/obsidian-repo'
  if (!existsSync(vault)) {
    console.error(`✗ 找不到真实 vault: ${vault}`)
    process.exit(1)
  }
  console.log(`真实 vault（只读）：${vault}`)
} else {
  vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-toolout-vault-'))
  repoDir = mkdtempSync(path.join(tmpdir(), 'dsh-kb-toolout-repo-'))
  const put = (root, rel, frontmatter, body) => {
    const abs = path.join(root, ...rel.split('/'))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
  }
  put(vault, `${proj}/hub.md`, 'title: 中枢\ntags: [x]\norigin: local', '# 中枢\n\n见 [[leaf]]。')
  put(vault, `${proj}/leaf.md`, 'title: 叶子\ntags: [x, y]', '# 叶子\n\n见 [[hub]]，断链 [[missing-one]]。')
  put(repoDir, 'src/a.js', '', "import './b.js'\nexport const A = 1\n")
  put(repoDir, 'src/b.js', '', 'export const B = 2\n')
}

process.env.OBSIDIAN_VAULT_PATH = vault
const mod = await import('../lib/index.js')

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- 假 ctx（严格 inject，approval 一律放行）-------------------------------
const declared = new Set(Array.isArray(mod.inject) ? mod.inject : [])
const tools = new Map()
const services = {
  tools: {
    register(def) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  webServer: {
    register() {
      return () => {}
    },
  },
  approval: {
    async request() {
      return 'allowed-once'
    },
  },
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

const exec = { agent: { session: {} }, callId: 'call-out' }

/**
 * Mirror the host rules to report WHERE losslessness breaks — the host only
 * says "value is not lossless JSON", which is useless for fixing it.
 */
function firstLossyPath(value, at = 'result', seen = new Set()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'boolean' || type === 'string') return null
  if (type === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? null : `${at} (非法数字 ${String(value)})`
  }
  if (type === 'undefined') return `${at} = undefined`
  if (type !== 'object') return `${at} (${type})`
  if (seen.has(value)) return `${at} (循环引用)`
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length !== Reflect.ownKeys(value).length - 1) return `${at} (稀疏数组)`
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.hasOwn(value, i)) return `${at}[${i}] 缺失`
      const found = firstLossyPath(value[i], `${at}[${i}]`, seen)
      if (found) return found
    }
    return null
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return `${at} (原型非普通对象)`
  for (const key of Object.keys(value)) {
    const found = firstLossyPath(value[key], `${at}.${key}`, seen)
    if (found) return found
  }
  return null
}

/** Run one tool the way the host does: execute → validate → describe. */
const called = new Set()
async function run(name, args) {
  const tool = tools.get(name)
  assert.ok(tool, `工具未注册: ${name}`)
  called.add(name)
  const value = await tool.execute(args, exec)
  const lossy = firstLossyPath(value)
  if (lossy) {
    check(false, `${name} 结果不是无损 JSON → ${lossy}（宿主会报 INVALID_TOOL_OUTPUT）`)
    return value
  }
  check(
    snapshotJsonValue(value) !== undefined,
    `${name} 结果通过宿主校验器 snapshotJsonValue()`
  )
  return value
}

// ---- 1. 工具输出必须过宿主校验器 -------------------------------------------
const snapshot = { format: 'dsh-kb-snapshot', version: 1, notes: [] }
// 只读计划：真实 vault 模式用（绝不写盘）。
const readPlan = [
  ['kb_index', {}],
  ['kb_search', { query: 'elasticsearch' }],
  ['kb_search', { query: 'elasticsearch', type: 'note' }],
  ['kb_search', { query: '不存在的词 zzz-not-here' }],
  ['kb_tagcloud', {}],
  ['kb_doctor', {}],
  ['kb_export', {}],
  ['kb_import', { data: snapshot }],
  ['kb_gap', { action: 'list' }],
  ['kb_graph', {}],
  ['kb_wiki_list', {}],
]
// 全量计划：一次性临时 vault，22 个工具全跑（含写入路径）。
const writePlan = [
  ['kb_index', {}],
  ['kb_index', { project: proj, rebuild: true }],
  ['kb_search', { query: '中枢' }],
  ['kb_search', { query: '中枢', type: 'note' }],
  ['kb_search', { query: '不存在的词 zzz' }],
  ['kb_read', { path: `${proj}/hub.md` }],
  ['kb_capture', { project: proj, title: '工具输出冒烟', content: '这条用来验证沉淀链路。', tags: ['smoke'] }],
  ['kb_inbox', { action: 'list' }],
  ['kb_wiki_ingest', { repoPath: repoDir, repoName: repo, maxFiles: 10 }],
  ['kb_wiki_list', {}],
  ['kb_wiki_list', { repo }],
  ['kb_wiki_graph', { repo }],
  ['kb_wiki_upsert', { repo, path: 'src/a.js', content: '## 职责\n\nA 模块。\n', title: 'A 模块' }],
  ['kb_wiki_overview', { repo }],
  ['kb_wiki_sync', { repoPath: repoDir, repoName: repo, maxFiles: 10 }],
  ['kb_tagcloud', {}],
  ['kb_backlinks', { path: `${proj}/hub.md` }],
  ['kb_doctor', {}],
  ['kb_export', {}],
  ['kb_import', { data: snapshot }],
  ['kb_skill_export', { name: 'smoke', refs: [`${proj}/hub.md`] }],
  ['kb_feedback', { path: `${proj}/leaf.md`, kind: 'confirm', text: '输出冒烟' }],
  ['kb_gap', { action: 'list' }],
]

const results = new Map()
for (const [name, args] of REAL ? readPlan : writePlan) {
  const value = await run(name, args)
  if (!results.has(name)) results.set(name, value)
}

// 真实 vault 模式：用第 1 条命中当 kb_read / kb_backlinks 的输入（真实中文路径）。
if (REAL) {
  const hit = results.get('kb_search')?.results?.[0]?.path
  if (hit) {
    await run('kb_read', { path: hit, maxChars: 200 })
    await run('kb_backlinks', { path: hit })
  } else {
    check(false, 'kb_search 在真实 vault 上没有命中，无法覆盖 kb_read/kb_backlinks')
  }
}

// ---- 2. 依赖上一步结果的工具（缺口 / 图谱 / 自愈）--------------------------
if (!REAL) {
  const added = await run('kb_gap', {
    action: 'add',
    project: proj,
    question: '这条缺口用来验证 kb_gap 输出无损',
    origin: 'inferred',
  })
  if (added?.id) {
    await run('kb_gap', { action: 'resolve', project: proj, id: added.id, note: '输出冒烟' })
  } else {
    check(false, `kb_gap add 未返回 id：${JSON.stringify(added)}`)
  }

  await run('kb_graph', {})
  await run('kb_reindex', { fixIndexes: true })
  await run('kb_wiki_delete', { repo, path: 'src/a.js' })
}

// ---- 3. 错误路径也必须无损（结构化错误 payload）----------------------------
{
  const missing = await run('kb_read', {})
  check(missing?.ok === false && missing?.error?.code === 'VALIDATION', `缺参错误也是无损 JSON：${missing?.error?.code}`)

  const notFound = await run('kb_read', { path: `${proj}/does-not-exist.md` })
  check(notFound?.ok === false, `不存在的笔记返回结构化错误：${notFound?.error?.code ?? '(非错误)'}`)

  // 真值必须带上 suggestion 字段（agent 靠它自纠）；这里只要求"不出现 undefined 键"
  check(
    Object.keys(notFound?.error ?? {}).every((key) => notFound.error[key] !== undefined),
    '错误对象里没有 undefined 值'
  )
}

// ---- 4. 覆盖检查 -----------------------------------------------------------
{
  const registered = [...tools.keys()].sort()
  check(registered.length === 22, `工具数 22（实际 ${registered.length}）`)
  if (REAL) {
    check(called.size >= 8, `真实 vault 模式覆盖了 ${called.size} 个只读工具：${[...called].sort().join(', ')}`)
  } else {
    const missed = registered.filter((name) => !called.has(name))
    check(missed.length === 0, `${registered.length} 个工具全部过校验器（漏掉：${missed.join(', ') || '无'}）`)
  }
}

// 只在临时 vault 模式清理；**绝不**对真实 vault 做任何删除。
if (!REAL) {
  rmSync(vault, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
  console.log('\n临时 vault / 仓库已清理')
} else {
  console.log(`\n真实 vault 未被写入（只读模式）：${vault}`)
}
console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
