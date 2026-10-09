// dsh-kb pre-boot load test — loads the plugin through the REAL cordis that
// DSH Desktop itself runs, with stub `tools` / `webServer` services.
//
// This is the closest thing to a real boot that can be run without restarting
// DSH: it exercises cordis's strict-inject contract for real, so a mistake like
// "touch ctx.tools without `export const inject`" fails HERE instead of taking
// DSH's startup down.
//
//   node scripts/cordis-load.mjs
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const DSH_APP = process.env.DSH_APP_DIR || 'D:/DSH Desktop/resources/app'
const cordisEntry = `${DSH_APP}/node_modules/@deepseek-ai/cordis/lib/index.js`
if (!existsSync(cordisEntry)) {
  console.error(`✗ 找不到 cordis: ${cordisEntry}（用 DSH_APP_DIR 指定 DSH 安装目录）`)
  process.exit(1)
}

const cordis = await import(pathToFileURL(cordisEntry).href)
const Context = cordis.Context ?? cordis.default?.Context ?? cordis.default
if (typeof Context !== 'function') {
  console.error('✗ cordis 没有导出 Context：', Object.keys(cordis))
  process.exit(1)
}

const tools = []
const routes = []
const effects = []
const promptSections = []

const ctx = new Context()

// cordis 4 is strict in BOTH directions: services are registered with
// `ctx.provide(name, impl)` and may only be read by a plugin that declared them
// in `inject`. `ctx.set()` only overwrites an existing implementation.
if (typeof ctx.provide !== 'function') {
  console.error('✗ cordis Context 没有 provide()，无法安装 stub 服务')
  process.exit(1)
}
ctx.provide('tools', {
  register(def) {
    tools.push(def)
    return () => {}
  },
})
ctx.provide('webServer', {
  register({ path }) {
    routes.push(path)
    return () => {}
  },
})
// 动态 inject 的提示词服务（真实名 = systemPrompt）。桩只记录注册进来的 section。
ctx.provide('systemPrompt', {
  section(entry) {
    promptSections.push(entry)
    return () => {}
  },
})

const mod = await import('../lib/index.js')
console.log(`plugin: name=${mod.name} inject=${JSON.stringify(mod.inject)}`)

let failure = null
try {
  await ctx.plugin(mod)
  await new Promise((resolve) => setTimeout(resolve, 150))
} catch (err) {
  failure = err
}

if (failure) {
  console.error(`✗ 真实 cordis 加载失败：${failure.message}`)
  console.error(failure.stack?.split('\n').slice(0, 6).join('\n'))
  process.exit(1)
}

const names = tools.map((t) => t.name)
console.log(`tools registered (${names.length}): ${names.join(', ')}`)
console.log(`routes registered: ${routes.length}`)

const problems = []
for (const name of [
  'kb_index',
  'kb_search',
  'kb_read',
  'kb_capture',
  'kb_inbox',
  'kb_gap',
  'kb_graph',
  'kb_reindex',
]) {
  if (!names.includes(name)) problems.push(`${name} 未注册`)
}
for (const routePath of [
  '/api/dsh-kb/knowledge/index',
  '/api/dsh-kb/knowledge/inbox',
  '/api/dsh-kb/knowledge/graph',
  '/api/dsh-kb/knowledge/gaps',
  '/api/dsh-kb/knowledge/reindex',
  '/api/dsh-kb/wiki/repos',
  '/api/dsh-kb/wiki/list',
  '/api/dsh-kb/wiki/overview',
  '/api/dsh-kb/wiki/graph',
  '/api/dsh-kb/wiki/scan',
  '/api/dsh-kb/wiki/sync',
]) {
  if (!routes.includes(routePath)) problems.push(`${routePath} 路由未注册`)
}
if (names.length !== 22) problems.push(`工具数异常（${names.length}，应为 22）`)
if (routes.length !== 29) problems.push(`路由数异常（${routes.length}，应为 29）`)

const section = promptSections.find((entry) => entry.name === 'dsh-kb:knowledge-base')
if (!section) problems.push('系统提示词 section 未注册（动态 inject systemPrompt 未生效）')
else {
  if (section.order !== 480) problems.push(`提示词 section order=${section.order}，应为 480`)
  if (!String(section.text).includes('kb_capture')) problems.push('提示词未覆盖任务后自动沉淀（kb_capture）')
}
if (promptSections.length !== 1) problems.push(`提示词 section 数量异常（${promptSections.length}）`)

if (problems.length) {
  console.error(`✗ ${problems.join('；')}`)
  process.exit(1)
}
console.log(
  `✓ 真实 cordis 加载通过：插件 apply() 无异常，${names.length} 个工具 + ${routes.length} 条路由 + ${promptSections.length} 个系统提示词 section 全部就位`
)
