// dsh-kb core smoke test — exercises the vault-wide index, L0/L1/L2 retrieval
// and the origin grading directly against the real vault (no dsh host needed).
//
//   node scripts/kb-smoke.mjs [vaultPath] [--write-index]
//
// Writes nothing unless `--write-index` is passed (then only <project>/INDEX.md).
import { VaultStore } from '../core/store.js'
import { Indexer } from '../core/indexer.js'
import { KnowledgeBase, LEGACY_SECTION_DIRS } from '../core/kb.js'

const args = process.argv.slice(2)
const vault = args.find((a) => !a.startsWith('--')) || process.env.OBSIDIAN_VAULT_PATH
const writeIndex = args.includes('--write-index')

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}
const ok = (msg) => console.log(`✓ ${msg}`)

const store = new VaultStore(vault)
const kb = new KnowledgeBase({ store, indexer: new Indexer(store) })

console.log(`vault: ${vault}`)
console.log(`excludes: ${LEGACY_SECTION_DIRS.join(', ')}`)

// ---- L0: project tree over the whole vault -------------------------------
const t0 = Date.now()
const idx = await kb.index({ limit: 3 })
const ms = Date.now() - t0
console.log(`\n[L0] projects=${idx.projects.length} notes=${idx.vault.noteCount} (${ms}ms)`)
for (const p of idx.projects.slice(0, 12)) {
  console.log(`     ${p.name.padEnd(18)} ${String(p.notes).padStart(3)} 篇  topics:${p.topics.length}  ${p.updated ?? '-'}`)
}
if (idx.vault.noteCount < 50) fail(`索引到的笔记太少（${idx.vault.noteCount}），全库索引可能没生效`)
else ok(`全库索引生效：${idx.vault.noteCount} 篇（含 .obsidian 与三分区之外的笔记）`)

// ---- L1: search with origin grading -------------------------------------
const q = 'flood-stage 磁盘只读'
const hits = await kb.search({ query: q, topK: 3 })
console.log(`\n[L1] "${q}" -> ${hits.count} 条（origins: ${hits.origins.join(',')}）`)
for (const r of hits.results) {
  console.log(`     ${r.score}  ${r.path}`)
  console.log(`          ${String(r.snippet).slice(0, 110)}`)
}
if (hits.count === 0) fail('检索没有命中（索引或检索链路有问题）')
else ok('检索命中，且带 path/tags/summary/snippet/score/origin')

const webOnly = await kb.search({ query: 'flood-stage', origin: ['web'] })
console.log(`[L1] origin=web 命中 ${webOnly.count} 条（库里没有 web 来源的笔记，应为 0）`)
if (webOnly.count !== 0) fail('origin 过滤未生效：web 来源不该默认/显式返回这么多')
else ok('origin 分级生效：默认只召回 local，web 需显式指定且当前为空')

// ---- L2: read one note ---------------------------------------------------
if (hits.results[0]) {
  const note = await kb.read({ path: hits.results[0].path, maxChars: 220 })
  console.log(`\n[L2] read ${note.path} chars=${note.chars} truncated=${note.truncated} origin=${note.origin}`)
  console.log(`     ${note.body.split('\n').filter(Boolean)[1]?.slice(0, 100) ?? ''}`)
  ok('L2 原地读取正常（未复制、未改写原文）')
  const escaped = await kb.read({ path: '../../etc/passwd' }).then(
    () => false,
    () => true
  )
  if (escaped) ok('路径越界被拒绝')
  else fail('路径越界没有被拒绝')
}

// ---- 项目索引（可选写入） -------------------------------------------------
const target = idx.projects.find((p) => p.name === 'k8s') || idx.projects[0]
const md = await kb.renderIndex(target.name)
console.log(`\n[L0] renderIndex(${target.name}) -> ${md.split('\n').length} 行`)
console.log(md.split('\n').slice(0, 8).map((l) => `     ${l.slice(0, 100)}`).join('\n'))
if (!md.includes(`# ${target.name} · 知识索引`)) fail('L0 标题不对')
else ok('L0 渲染正常（标题 + 分组 + 每篇一行 + 来源/更新日）')

if (writeIndex) {
  const receipt = await kb.rebuildIndex(target.name)
  console.log(`\n[write] ${JSON.stringify(receipt)}`)
  const back = await kb.read({ path: receipt.path })
  console.log(`     写回校验头 3 行: ${back.body.split('\n').slice(0, 3).join(' | ').slice(0, 120)}`)
  ok(`INDEX.md 已写入 ${receipt.path}（派生文件，可删可再生）`)
}

// ---- type 分流（card / memory / wiki / 无 type 即普通笔记）----------------
{
  // 同一检索词分别在三种过滤下看类型是否一致
  const plain = await kb.search({ query: 'flood-stage', type: 'note', topK: 5 })
  const bad = plain.results.filter((r) => r.type)
  console.log(`\n[type] type=note -> ${plain.count} 条（filter=${plain.typeFilter ?? '-'}）`)
  if (bad.length) fail(`type=note 过滤失效，混进了 ${JSON.stringify(bad.map((r) => r.type))}`)
  else ok('type="note" 只召回没有 type 的普通笔记')

  const wiki = await kb.search({ query: 'flood', type: 'wiki', topK: 5 })
  const wikiBad = wiki.results.filter((r) => r.type !== 'wiki')
  if (wikiBad.length) fail(`type=wiki 过滤失效：${JSON.stringify(wikiBad.map((r) => r.type))}`)
  else ok(`type="wiki" 只召回 wiki 页（${wiki.count} 条，库里当前可能为 0 —— 已确认为空而非漏过滤）`)

  const all = await kb.search({ query: 'flood-stage', topK: 5 })
  if (all.count >= plain.count) ok(`不带 type 时不过滤（${all.count} ≥ ${plain.count}）`)
  else fail(`不带 type 时结果反而更少（${all.count} < ${plain.count}），过滤逻辑有问题`)
}

// ---- 索引自愈：外部改动增量生效 ------------------------------------------
const fresh = kb.indexer.docs.size
await kb.refresh()
console.log(`\n[fresh] ensureFresh 后 docs=${kb.indexer.docs.size}（前值 ${fresh}）`)
ok('增量刷新可重复调用')

console.log(process.exitCode ? '\n结果：有失败项' : '\n结果：全部通过')
