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
// 内核根目录：先把 DSH_APP_DIR 当候选，再依次探本机已知的安装目录（见
// cordis-load.mjs 里的同款候选列表）。硬编码单一目录会在换装路径后一直报错。
const CANDIDATES = [
  process.env.DSH_APP_DIR,
  'D:/DSH Desktop/resources/app',
  'D:/DeepSeek Harness/resources/app/dsh',
  'D:/DeepSeek Harness/resources/app',
].filter(Boolean)
const validatorOf = (base) => `${base}/node_modules/@deepseek-ai/dsh-util-values/lib/index.js`
const DSH_APP = CANDIDATES.find((base) => existsSync(validatorOf(base)))
const validatorPath = DSH_APP ? validatorOf(DSH_APP) : validatorOf(CANDIDATES[0])

/**
 * `snapshotJsonValue()` 的等价实现（宿主那份是纯函数，逻辑见 dsh-util-values）。
 *
 * 为什么本地复刻：DSH 桌面版把内核打进 `app.asar` 后，普通 Node 进程用 fs /
 * import 都读不到 asar 内的模块（只有 Electron 打补丁的加载器能读）。这时
 * 拿不到宿主那份实现，但「无损 JSON」这条约束本身完全可以本地校验。
 *
 * 规则（与宿主一致）：
 *   - `undefined` / 函数 / symbol / bigint → 失败（JSON.stringify 会静默丢掉）
 *   - `NaN` / `Infinity` → 失败（会序列化成 null）
 *   - 稀疏数组 / 含上述值的数组 → 失败
 *   - 循环引用 → 失败
 *   - 通过则返回深拷贝
 */
function localSnapshotJsonValue(value, seen = new Set()) {
  if (value === undefined) throw new TypeError('contains undefined')
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`contains ${typeof value}`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('contains non-finite number')
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) throw new TypeError('contains circular reference')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!(i in value)) throw new TypeError('contains sparse array hole')
        localSnapshotJsonValue(value[i], seen)
      }
      return [...value]
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) throw new TypeError(`contains undefined at "${k}"`)
      out[k] = localSnapshotJsonValue(v, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

let snapshotJsonValue = localSnapshotJsonValue
if (existsSync(validatorPath)) {
  ;({ snapshotJsonValue } = await import(pathToFileURL(validatorPath).href))
  console.log(`宿主校验器：${validatorPath}`)
} else {
  // 不硬失败：内核打进 asar 是环境变化，不是代码问题。本地复刻能守住同一条约束。
  console.log('⚠ 内核已打包进 app.asar，普通 Node 读不到宿主校验器；改用本地等价实现')
  console.log('  （规则与 dsh-util-values 的 snapshotJsonValue 一致：拒 undefined / NaN / 稀疏数组）')
}

// ---- 一次性临时 vault（真实模式不建、不写）--------------------------------
let vault = null
const proj = 'proj'

if (REAL) {
  vault = process.env.OBSIDIAN_VAULT_PATH || 'D:/obsidian-repo'
  if (!existsSync(vault)) {
    console.error(`✗ 找不到真实 vault: ${vault}`)
    process.exit(1)
  }
  console.log(`真实 vault（只读）：${vault}`)
} else {
  vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-toolout-vault-'))
  const put = (root, rel, frontmatter, body) => {
    const abs = path.join(root, ...rel.split('/'))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
  }
  put(vault, `${proj}/hub.md`, 'title: 中枢\ntags: [x]\norigin: local', '# 中枢\n\n见 [[leaf]]。')
  put(vault, `${proj}/leaf.md`, 'title: 叶子\ntags: [x, y]', '# 叶子\n\n见 [[hub]]，断链 [[missing-one]]。')
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

// ---- 1. Compact read surface and the gap-ledger exception ------------------
const readPlan = [
  ['kb_find', {}],
  ['kb_find', { project: proj }],
  ['kb_find', { query: '中枢' }],
  ['kb_find', { query: '中枢', type: 'note' }],
  ['kb_find', { query: '不存在的词 zzz-not-here' }],
  ['kb_read', { path: `${proj}/hub.md` }],
  ['kb_doctor', {}],
  ['kb_gap', { action: 'list' }],
]

const results = new Map()
for (const [name, args] of readPlan) {
  const value = await run(name, args)
  if (!results.has(name)) results.set(name, value)
}

if (REAL) {
  const found = await run('kb_find', { query: 'flood-stage', topK: 3 })
  const hit = found?.results?.[0]?.path
  if (hit) await run('kb_read', { path: hit, maxChars: 200 })
  else check(false, '真实 vault 模式未命中，无法覆盖正文读取')
} else {
  const added = await run('kb_gap', {
    action: 'add', project: proj, question: '结构化缺口输出验证', origin: 'inferred',
  })
  const duplicate = await run('kb_gap', {
    action: 'add', project: proj, question: '结构化缺口输出验证', origin: 'inferred',
  })
  if (added?.id) {
    check(duplicate.duplicate === true && duplicate.id === added.id, 'kb_gap 重复 add 幂等')
    await run('kb_gap', { action: 'resolve', project: proj, id: added.id, note: '冒烟完成' })
  } else check(false, `kb_gap 未返回 id：${JSON.stringify(added)}`)
}

const missing = await run('kb_read', {})
check(missing?.ok === false && missing?.error?.code === 'VALIDATION', `缺参错误无损：${missing?.error?.code}`)
const notFound = await run('kb_read', { path: `${proj}/does-not-exist.md` })
check(notFound?.ok === false, `不存在路径返回结构化错误：${notFound?.error?.code ?? '(非错误)'}`)

{
  const registered = [...tools.keys()].sort()
  check(JSON.stringify(registered) === JSON.stringify(['kb_doctor', 'kb_find', 'kb_gap', 'kb_read']), `工具表恰为四项：${registered.join(', ')}`)
  if (REAL) {
    check(called.size >= 5, `真实 vault 模式覆盖 ${called.size} 个调用`)
  } else {
    check(called.size === registered.length, '每个注册工具都通过无损 JSON 校验')
  }
}
// 只在临时 vault 模式清理；**绝不**对真实 vault 做任何删除。
if (!REAL) {
  rmSync(vault, { recursive: true, force: true })
  console.log('\n临时 vault 已清理')
} else {
  console.log(`\n真实 vault 未被写入（只读模式）：${vault}`)
}
console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
