// dsh-kb host integration smoke: tools, prompt, hooks, and the read-only API.

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-host-'))
process.env.OBSIDIAN_VAULT_PATH = vault
const { apply } = await import('../lib/index.js')
const project = path.join(vault, 'demo')
mkdirSync(project, { recursive: true })
const writeNote = (name, frontmatter, body) =>
  writeFileSync(path.join(project, name), `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
writeNote('local.md', 'title: Local\ntags: [demo]\norigin: local\nsummary: Alpha retrieval fixture', '# AlphaSearchToken local knowledge')
writeNote('unlabeled.md', 'title: Unlabeled\ntags: [demo]\nsummary: Alpha retrieval fixture', '# AlphaSearchToken hand-written knowledge')
writeNote('web.md', 'title: Web\ntags: [demo]\norigin: web\nsummary: Alpha retrieval fixture', '# AlphaSearchToken external knowledge')
writeNote('inferred.md', 'title: Inferred\ntags: [demo]\norigin: inferred\nsummary: Alpha retrieval fixture', '# AlphaSearchToken inferred knowledge')

const fail = []
const ok = (message) => console.log(`✓ ${message}`)
const check = (condition, message) => (condition ? ok(message) : (fail.push(message), console.error(`✗ ${message}`)))
const routes = new Map()
const tools = new Map()
const effects = []
const prompts = []
const hooks = []
const commandDefs = []
const services = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  webServer: { register: ({ path: route, handler }) => { routes.set(route, handler); return () => routes.delete(route) } },
  systemPrompt: { section: (section) => { prompts.push(section); return () => {} } },
  commands: { register: (definition) => { commandDefs.push(definition); return () => {} } },
}
const declared = new Set(['tools'])
const makeCtx = (allowed) => new Proxy({}, {
  get(_target, property) {
    if (property === 'inject') return (deps, callback) => callback(makeCtx(new Set([...allowed, ...deps])))
    if (property === 'effect') return (_setup, label) => { effects.push(label) }
    if (property === 'on') return (name, callback) => { hooks.push(name); return () => {} }
    if (property === 'logger') return { warn: () => {} }
    if (typeof property === 'string' && Object.hasOwn(services, property)) {
      if (!allowed.has(property)) throw new Error(`service ${property} was not injected`)
      return services[property]
    }
    throw new Error(`unexpected context access: ${String(property)}`)
  },
})

try {
  apply(makeCtx(declared))
  const expectedTools = ['kb_doctor', 'kb_find', 'kb_gap', 'kb_read']
  check(JSON.stringify([...tools.keys()].sort()) === JSON.stringify(expectedTools), `工具表精简为 ${expectedTools.join(', ')}`)
  for (const removed of ['kb_index', 'kb_search', 'kb_capture', 'kb_inbox', 'kb_import', 'kb_export', 'kb_feedback', 'kb_graph', 'kb_tagcloud', 'kb_skill_export', 'kb_reindex']) {
    check(!tools.has(removed), `${removed} 不再暴露为模型工具`)
  }

  for (const route of ['/api/dsh-kb/knowledge/index', '/api/dsh-kb/knowledge/search', '/api/dsh-kb/knowledge/read', '/api/dsh-kb/knowledge/gaps']) {
    check(routes.has(route), `只读/缺口路由已注册：${route}`)
  }
  for (const route of ['/api/dsh-kb/save', '/api/dsh-kb/create-note', '/api/dsh-kb/create-folder', '/api/dsh-kb/rename', '/api/dsh-kb/move', '/api/dsh-kb/delete', '/api/dsh-kb/undo-delete', '/api/dsh-kb/knowledge/inbox', '/api/dsh-kb/knowledge/reindex']) {
    check(!routes.has(route), `重复笔记写入路由已移除：${route}`)
  }

  const find = tools.get('kb_find')
  check(find.readOnly === true && find.behavior === 'read', 'kb_find 标记为只读')
  const defaults = await find.execute({ query: 'AlphaSearchToken', project: 'demo' })
  check(defaults.origins.includes('local') && defaults.origins.includes('unlabeled'), '默认召回 local + unlabeled')
  check(!defaults.origins.includes('web') && !defaults.origins.includes('inferred'), '默认过滤 web/inferred')
  check(defaults.results.some((row) => row.path === 'demo/local.md'), '检索命中本地笔记')
  check(defaults.results.some((row) => row.path === 'demo/unlabeled.md'), '检索命中未标注笔记')
  check(!defaults.results.some((row) => /web|inferred/.test(row.path)), '默认结果不包含 web/inferred 笔记')

  const expanded = await find.execute({ query: 'AlphaSearchToken', project: 'demo', includeWeb: true })
  check(expanded.results.some((row) => row.path === 'demo/web.md'), '显式 includeWeb 才包含外部来源')
  const l0 = await find.execute({ project: 'demo' })
  check(l0.index?.startsWith('# demo · 知识索引'), '项目清单按需返回内存 L0')
  check(!existsSync(path.join(project, 'INDEX.md')), 'L0 查询不生成磁盘 INDEX.md')

  const read = await tools.get('kb_read').execute({ path: 'demo/unlabeled.md' })
  check(read.origin === 'unlabeled' && read.body.includes('hand-written'), 'kb_read 返回准确的来源与正文')
  const doctor = await tools.get('kb_doctor').execute({ project: 'demo' })
  check(!doctor.problems.some((problem) => /INDEX\.md/.test(problem.issue)), 'doctor 不再检查磁盘派生索引')

  const gapTool = tools.get('kb_gap')
  const gap = await gapTool.execute({ action: 'add', project: 'demo', question: 'AlphaSearchToken gap fixture' })
  const duplicate = await gapTool.execute({ action: 'add', project: 'demo', question: 'AlphaSearchToken gap fixture' })
  check(Boolean(gap.id) && duplicate.duplicate === true && duplicate.id === gap.id, 'kb_gap 对重复问题幂等')
  const resolved = await gapTool.execute({ action: 'resolve', project: 'demo', id: gap.id, note: 'covered by fixture' })
  check(resolved.done === 1 && resolved.open === 0, 'kb_gap 可按 ID resolve')

  const prompt = String(prompts.find((item) => item.name === 'dsh-kb:knowledge-base')?.text ?? '')
  check(prompt.includes('kb_find') && prompt.includes('unlabeled'), '提示词使用统一发现工具和来源状态')
  check(prompt.includes('Obsidian MCP') && prompt.includes('prevHash'), '提示词指定唯一笔记 writer 与 CAS 写入')
  check(prompt.includes('kb_gap') && !prompt.includes('kb_capture') && !prompt.includes('kb_inbox'), '提示词只保留结构化缺口特例')
  check(!hooks.includes('session/event') && hooks.includes('tools/post-execute'), '仅保留技能上下文 hook')
  check(commandDefs.some((definition) => definition.name === 'kb'), '/kb 命令已注册')
  check(effects.includes('dsh-kb: route lifecycle'), '只读路由 lifecycle 已挂载')
} catch (error) {
  fail.push(error.stack || error.message)
  console.error(error.stack || error)
} finally {
  rmSync(vault, { recursive: true, force: true })
}

console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
