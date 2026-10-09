// dsh-kb P4 smoke test — 洞察（标签云/反链/相关/体检）+ 导入导出 + 技能包 + 反馈闭环。
//
// 一次性临时 vault，绝不碰真实 vault。
//
//   node scripts/p4-smoke.mjs
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-p4-vault-'))
const proj = 'proj'

const put = (rel, frontmatter, body) => {
  const abs = path.join(vault, ...rel.split('/'))
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
}

put('proj/note-a.md', 'title: A\ntags: [x, y]', '# A\n\n见 [[note-b]]，以及一个不存在的 [[nope-missing]]。')
put('proj/note-b.md', 'title: B\ntags: [y]', '# B\n\n正文。')
put('proj/sub/note-a.md', 'title: A\ntags: [z]', '# A（同名另一篇）\n\n用来触发重复标题检测。')
put('proj/expired.md', 'title: 过期条目\nexpires: 2020-01-01', '# 过期条目\n\n这条已经过期。')
put('proj/no-title.md', 'tags: [orphan]', '# 没写 title\n\n该篇故意不写 title。')

process.env.OBSIDIAN_VAULT_PATH = vault
const mod = await import('../lib/index.js')

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- 假 cordis 上下文（严格 inject）---------------------------------------
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
const exec = { agent: { session: {} }, callId: 'call-p4' }
const call = (routePath, query = {}) => {
  const handler = routes.get(routePath)
  assert.ok(handler, `路由不存在: ${routePath}`)
  const url = `${routePath}?${new URLSearchParams(query)}`
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(s) {
        this.status = s
      },
      end(payload) {
        resolve({ status: this.status, body: payload ? JSON.parse(payload) : null })
      },
    }
    handler({ method: 'GET', url }, res)
  })
}

// ---- 1. 工具面 -------------------------------------------------------------
{
  const expected = [
    'kb_tagcloud',
    'kb_backlinks',
    'kb_doctor',
    'kb_export',
    'kb_import',
    'kb_skill_export',
    'kb_feedback',
  ]
  const names = [...tools.keys()]
  check(expected.every((n) => names.includes(n)), `7 个 P4 工具已注册（共 ${names.length} 个）`)
}

// ---- 2. 标签云 -------------------------------------------------------------
{
  const cloud = await tool('kb_tagcloud').execute({ project: proj }, exec)
  const map = new Map(cloud.tags.map((t) => [t.tag, t.count]))
  check(map.get('y') === 2 && map.get('x') === 1 && map.get('z') === 1, `标签云计数正确：${JSON.stringify([...map])}`)
}

// ---- 3. 反链 + 相关 --------------------------------------------------------
{
  const back = await tool('kb_backlinks').execute({ path: 'proj/note-b' }, exec)
  check(
    back.backlinks.some((b) => b.path === 'proj/note-a.md'),
    `note-b 的反链包含 note-a：${JSON.stringify(back.backlinks.map((b) => b.path))}`
  )
  const rel = await tool('kb_backlinks').execute({ path: 'proj/note-a.md' }, exec)
  check(
    rel.related.some((r) => r.path === 'proj/note-b.md'),
    `note-a 的相关包含 note-b（共享标签 y）：${JSON.stringify(rel.related.map((r) => r.path))}`
  )
}

// ---- 4. 体检 ---------------------------------------------------------------
{
  const doc = await tool('kb_doctor').execute({ project: proj }, exec)
  const issues = doc.problems.map((p) => p.issue)
  check(issues.some((i) => i.includes('断链') && i.includes('nope-missing')), '体检抓到断链 [[nope-missing]]')
  check(issues.some((i) => i.includes('已过期')), '体检抓到过期条目')
  check(issues.some((i) => i.includes('重复')), '体检抓到重复标题')
  check(issues.some((i) => i.includes('缺少 title')), '体检抓到缺少 title')
  check(doc.scanned === 5 && doc.count >= 4, `体检扫描 ${doc.scanned} 篇，报出 ${doc.count} 条问题（warn=${doc.warns} info=${doc.infos}）`)

  const viaRoute = await call('/api/dsh-kb/knowledge/doctor', { project: proj })
  check(viaRoute.body.count === doc.count, 'HTTP /knowledge/doctor 与工具结果一致')
  const tagsRoute = await call('/api/dsh-kb/knowledge/tagcloud', { project: proj })
  check(tagsRoute.body.tags.length >= 3, 'HTTP /knowledge/tagcloud 可用')
  const linksRoute = await call('/api/dsh-kb/knowledge/links', { path: 'proj/note-b' })
  check(linksRoute.body.backlinks.length === 1, 'HTTP /knowledge/links 可用')
}

// ---- 5. 导出快照 -----------------------------------------------------------
let snapshot = null
{
  snapshot = await tool('kb_export').execute({ project: proj }, exec)
  check(
    snapshot.format === 'dsh-kb-snapshot' && snapshot.count === 5 && Array.isArray(snapshot.notes),
    `导出快照：${snapshot.count} 篇 / format=${snapshot.format}`
  )
  check(
    snapshot.notes.every((n) => n.rel && n.frontmatter && typeof n.body === 'string'),
    '快照含 rel + frontmatter + 正文'
  )
}

// ---- 6. 导入：dryRun → 审批闸门 → 写入 -------------------------------------
{
  const same = await tool('kb_import').execute({ data: snapshot }, exec)
  check(same.dryRun === true && same.plan.unchanged === 5, `dryRun 计划：未变 ${same.plan.unchanged} / 新增 ${same.plan.added}`)

  rmSync(path.join(vault, proj, 'note-b.md'))
  const afterDelete = await tool('kb_import').execute({ data: snapshot }, exec)
  check(afterDelete.plan.added === 1, `删掉 note-b 后 dryRun 计划新增 ${afterDelete.plan.added} 篇`)

  // fail-closed：不带 exec（没有 agent 上下文）时，即使要写入也必须被拒
  const noExec = await tool('kb_import').execute({ data: snapshot, dryRun: false })
  check(noExec?.ok === false && noExec?.error?.code === 'APPROVAL_REQUIRED', 'dryRun:false 但无 exec 上下文 → 被拒（fail-closed）')

  approvalOutcome = 'denied'
  const denied = await tool('kb_import').execute({ data: snapshot, dryRun: false }, exec)
  check(denied?.ok === false && denied?.error?.code === 'APPROVAL_REQUIRED', '用户拒绝 → 不写盘')

  approvalOutcome = 'allowed-once'
  const applied = await tool('kb_import').execute({ data: snapshot, dryRun: false }, exec)
  check(applied.written === 1 && existsSync(path.join(vault, proj, 'note-b.md')), `批准后写回 ${applied.written} 篇，note-b 已恢复`)
}

// ---- 7. 技能包导出 ---------------------------------------------------------
{
  const skill = await tool('kb_skill_export').execute(
    { name: 'Demo Skill', refs: ['proj/note-b', 'B'], description: '演示技能包' },
    exec
  )
  const skillFile = path.join(vault, ...skill.skill.split('/'))
  check(existsSync(skillFile), `SKILL.md 已生成：${skill.skill}`)
  const text = readFileSync(skillFile, 'utf8')
  check(text.includes('# Demo Skill') || text.includes('demo-skill'), 'SKILL.md 含技能名')
  check(skill.entries === 1 && existsSync(path.join(vault, ...skill.references[0].split('/'))), 'references/ 里拷进了选中的笔记（去重后 1 篇）')
  check(String(skill.installHint).includes('~/.dsh/skills'), '返回了安装提示')
  const idx = await tool('kb_index').execute({ project: proj }, exec)
  check(idx.vault.noteCount === 5, `技能包放在隐藏目录，未污染索引（仍 ${idx.vault.noteCount} 篇）`)
}

// ---- 8. 反馈闭环（需审批）-------------------------------------------------
{
  const gate = await tool('kb_feedback').execute({ path: 'proj/note-a', kind: 'correction', text: '不准确' }, exec)
  const noExec = await tool('kb_feedback').execute({ path: 'proj/note-a', kind: 'correction', text: '不准确' })
  check(noExec?.ok === false && noExec?.error?.code === 'APPROVAL_REQUIRED', '无 exec 上下文 → 反馈被拒（fail-closed）')
  check(gate.confidence === 0.8, `correction 后 confidence = ${gate.confidence}（1 → 0.8）`)
  const page = readFileSync(path.join(vault, proj, 'note-a.md'), 'utf8')
  check(/confidence:\s*0\.8/.test(page) && page.includes('corrections:') && page.includes('[correction] 不准确'), 'frontmatter 落了 confidence + corrections 留痕')

  approvalOutcome = 'allowed-once'
  const confirm = await tool('kb_feedback').execute({ path: 'proj/note-a', kind: 'confirm', text: '复核无误' }, exec)
  check(confirm.confidence === 0.9, `confirm 后 confidence = ${confirm.confidence}（0.8 → 0.9）`)
}

rmSync(vault, { recursive: true, force: true })
console.log('\n临时 vault 已清理')
console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
