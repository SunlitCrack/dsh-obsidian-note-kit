// dsh-kb read-only core smoke: whole-vault search, origin filtering, and L0/L2.
// Usage: node scripts/kb-smoke.mjs [vaultPath]
import { existsSync, statSync } from 'node:fs'
import { VaultStore } from '../core/store.js'
import { Indexer } from '../core/indexer.js'
import { KnowledgeBase, LEGACY_SECTION_DIRS } from '../core/kb.js'

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT_PATH || 'D:/obsidian-repo'
const fail = []
const ok = (message) => console.log(`✓ ${message}`)
const check = (condition, message) => (condition ? ok(message) : (fail.push(message), console.error(`✗ ${message}`)))
const store = new VaultStore(vault)
const kb = new KnowledgeBase({ store, indexer: new Indexer(store) })

console.log(`vault: ${vault}`)
console.log(`legacy excludes: ${LEGACY_SECTION_DIRS.join(', ')}`)

const index = await kb.index({ limit: 3 })
console.log(`\n[L0] projects=${index.projects.length} notes=${index.vault.noteCount}`)
check(index.vault.noteCount >= 50, `全 vault 索引正常（${index.vault.noteCount} 篇）`)
check(!Object.hasOwn(index, 'written'), 'L0 接口不返回写入结果')

const q = 'flood-stage 磁盘只读'
const hits = await kb.search({ query: q, topK: 3 })
console.log(`[L1] ${q} -> ${hits.count} 条（origins: ${hits.origins.join(',')}）`)
check(hits.count > 0, 'BM25 检索命中')
check(hits.origins.includes('local') && hits.origins.includes('unlabeled'), '默认来源包含 local 与 unlabeled')
check(!hits.origins.includes('web') && !hits.origins.includes('inferred'), '默认来源排除 web 与 inferred')
check(hits.results.every((row) => row.path && row.origin && typeof row.score === 'number'), '检索结果包含路径、来源和分数')

const web = await kb.search({ query: 'flood-stage', origin: ['web'] })
check(web.results.every((row) => row.origin === 'web'), '显式 origin 过滤结果只含 web')
const expanded = await kb.search({ query: 'flood-stage', includeWeb: true })
check(hits.origins.every((origin) => expanded.origins.includes(origin)), 'includeWeb 保留默认召回面')

if (hits.results[0]) {
  const note = await kb.read({ path: hits.results[0].path, maxChars: 220 })
  check(note.path === hits.results[0].path && note.origin, 'L2 返回正文与 frontmatter 来源')
  for (const path of ['../../etc/passwd', '.obsidian/app.json', '%2Eobsidian/app.json']) {
    const rejected = await kb.read({ path }).then(() => false, () => true)
    check(rejected, `读取边界拒绝 ${path}`)
  }
}

const project = index.projects.find((item) => item.name === 'k8s') || index.projects[0]
const indexPath = `${project.name}/INDEX.md`
const absoluteIndexPath = store.abs(indexPath)
const before = existsSync(absoluteIndexPath) ? statSync(absoluteIndexPath).mtimeMs : null
const inMemory = await kb.index({ project: project.name })
check(inMemory.index?.startsWith(`# ${project.name} · 知识索引`), '项目 L0 可按需内存渲染')
const after = existsSync(absoluteIndexPath) ? statSync(absoluteIndexPath).mtimeMs : null
check(before === after, 'L0 查询不创建或改写磁盘 INDEX.md')

const plain = await kb.search({ query: 'flood-stage', type: 'note', topK: 5 })
check(plain.results.every((row) => !row.type), 'type=note 只召回无 type 普通笔记')

console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
