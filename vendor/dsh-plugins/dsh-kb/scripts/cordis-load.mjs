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

// 内核根目录：先把 DSH_APP_DIR 当候选，再依次探本机已知的安装目录。
// 直接写死 `D:/DSH Desktop/resources/app` 会在新装目录里一直报「找不到 cordis」，
// 看起来像测试坏了。
const CANDIDATES = [
  process.env.DSH_APP_DIR,
  'D:/DSH Desktop/resources/app',
  'D:/DeepSeek Harness/resources/app/dsh',
  'D:/DeepSeek Harness/resources/app',
].filter(Boolean)
const cordisOf = (base) => `${base}/node_modules/@deepseek-ai/cordis/lib/index.js`
const DSH_APP = CANDIDATES.find((base) => existsSync(cordisOf(base)))
const cordisEntry = DSH_APP ? cordisOf(DSH_APP) : cordisOf(CANDIDATES[0])
if (!cordisEntry || !existsSync(cordisEntry)) {
  // DSH 桌面版把内核整体打进 `app.asar` 后，普通 Node 进程用 fs / import 都
  // 读不到 asar 内的文件（只有 Electron 打补丁的模块加载器能读）。这种情况下
  // 本脚本**本质上无法运行** —— 明确跳过并说明原因，比报「找不到 cordis」
  // 更诚实：后者看起来像测试坏了，而实际是环境变化。
  const asarHint = CANDIDATES.some((b) => existsSync(`${b}/../app.asar`))
  if (asarHint) {
    console.log(
      '⚠ 跳过真实 cordis 加载测试：内核已打包进 app.asar，普通 Node 进程读不到 asar 内的模块。'
    )
    console.log('  这不是失败 —— 插件在宿主里运行时走 Electron 的 asar 加载器。')
    console.log('  需要跑这条测试时，装一份解包版内核并用 DSH_APP_DIR 指向它。')
    process.exit(0)
  }
  console.error(
    `✗ 找不到 cordis：试过 ${CANDIDATES.map(cordisOf).join(' , ')}（用 DSH_APP_DIR 指定 DSH 内核目录）`
  )
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
const hookEvents = []
const commandDefs = []

const ctx = new Context()

// 记录插件挂的事件钩子名。真实 cordis 的 ctx.on 会返回 disposer；这里包一层
// 只为断言「钩子确实挂上了」——不包的话 apply() 静默跳过也看不出来。
const rawOn = ctx.on.bind(ctx)
ctx.on = (name, ...rest) => {
  hookEvents.push(String(name))
  return rawOn(name, ...rest)
}

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
// /kb 斜杠命令面（真实名 = commands，提供者 dsh-commands）。
ctx.provide('commands', {
  register(definition) {
    commandDefs.push(definition)
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
console.log(`host hooks: ${hookEvents.join(', ') || '(none)'}`)
console.log(`commands: ${commandDefs.map((d) => `/${d.name}`).join(', ') || '(none)'}`)

const problems = []
for (const name of ['kb_find', 'kb_read', 'kb_doctor', 'kb_gap']) {
  if (!names.includes(name)) problems.push(`${name} 未注册`)
}
for (const gone of ['kb_index', 'kb_search', 'kb_capture', 'kb_inbox', 'kb_import', 'kb_export', 'kb_feedback', 'kb_graph', 'kb_tagcloud', 'kb_skill_export', 'kb_reindex']) {
  if (names.includes(gone)) problems.push(`${gone} 应已下线却仍注册`)
}
for (const routePath of [
  '/api/dsh-kb/knowledge/index',
  '/api/dsh-kb/knowledge/search',
  '/api/dsh-kb/knowledge/read',
  '/api/dsh-kb/knowledge/gaps',
]) {
  if (!routes.includes(routePath)) problems.push(`${routePath} 路由未注册`)
}
for (const gone of [
  '/api/dsh-kb/knowledge/inbox',
  '/api/dsh-kb/knowledge/reindex',
  '/api/dsh-kb/save',
  '/api/dsh-kb/create-note',
  '/api/dsh-kb/create-folder',
  '/api/dsh-kb/rename',
  '/api/dsh-kb/move',
  '/api/dsh-kb/delete',
  '/api/dsh-kb/undo-delete',
]) {
  if (routes.includes(gone)) problems.push(`${gone} 应为只读而仍注册`)
}
if (names.length !== 4) problems.push(`工具数异常（${names.length}，应为 4）`)
if (routes.length !== 14) problems.push(`只读路由数异常（${routes.length}，应为 14）`)

const section = promptSections.find((entry) => entry.name === 'dsh-kb:knowledge-base')
if (!section) problems.push('系统提示词 section 未注册（动态 inject systemPrompt 未生效）')
else {
  if (section.order !== 480) problems.push(`提示词 section order=${section.order}，应为 480`)
  if (!String(section.text).includes('kb_find')) problems.push('提示词没有指向 kb_find 作为发现入口')
  if (!String(section.text).includes('Obsidian MCP')) problems.push('提示词未说明 MCP 是笔记 writer')
}
if (promptSections.length !== 1) problems.push(`提示词 section 数量异常（${promptSections.length}）`)

if (!hookEvents.includes('tools/post-execute')) problems.push('tools/post-execute 技能上下文 hook 未挂载')
if (hookEvents.includes('session/event')) problems.push('已移除的 captureNudge 仍订阅 session/event')

// /kb 命令：宿主原生命令面。装不上会静默降级成「只有工具、没有命令」，
// 所以必须显式断言它真的注册进来了。
const kbCommand = commandDefs.find((d) => d?.name === 'kb')
if (!kbCommand) problems.push('/kb 命令未注册')
else {
  if (typeof kbCommand.handler !== 'function') problems.push('/kb handler 不是函数')
  if (!kbCommand.description) problems.push('/kb 缺 description（宿主会拒绝注册）')
  if (!kbCommand.input?.hint) problems.push('/kb 缺 input.hint')
}

if (problems.length) {
  console.error(`✗ ${problems.join('；')}`)
  process.exit(1)
}
console.log(
  `✓ 真实 cordis 加载通过：插件 apply() 无异常，${names.length} 个工具 + ${routes.length} 条路由 + ${promptSections.length} 个系统提示词 section 全部就位`
)
