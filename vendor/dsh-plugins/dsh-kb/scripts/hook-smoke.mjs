// dsh-kb skill-context hook smoke test.

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { VaultStore } from '../core/store.js'
import { Indexer } from '../core/indexer.js'
import { KnowledgeBase } from '../core/kb.js'
import { buildSkillContext, installKbHooks, pickRelevant } from '../lib/capture-hook.js'

const fail = []
const check = (condition, message) => {
  if (condition) console.log(`✓ ${message}`)
  else {
    fail.push(message)
    console.error(`✗ ${message}`)
  }
}

let vault
try {
  vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-hooks-'))
  const notePath = path.join(vault, 'deepseek-harness', 'skill-context.md')
  mkdirSync(path.dirname(notePath), { recursive: true })
  writeFileSync(notePath,
    '---\ntitle: dsh-kb skill context\ntags: [dsh]\norigin: local\nsummary: skill context test\n---\n# dsh-kb skill context\n\nThe plugin supplies ranked local context.\n',
    'utf8')

  const store = new VaultStore(vault)
  const kb = new KnowledgeBase({ store, indexer: new Indexer(store, { listFiles: () => store.allFiles() }) })
  const rows = [
    { path: 'a', score: 90 },
    { path: 'b', score: 50 },
    { path: 'c', score: 45 },
  ]
  check(pickRelevant(rows).length > 0, '相关性门槛保留明显命中')
  check(pickRelevant([{ path: 'a', score: 5 }]).length === 0, '单条低分不作为相关笔记')
  check(pickRelevant([{ path: 'a', score: 30 }]).length === 1, '单条高分保留')

  const contextKb = {
    search: async () => ({ results: [{ path: 'deepseek-harness/skill-context.md', score: 90, origin: 'local', summary: 'skill context test' }] }),
  }
  const context = await buildSkillContext(contextKb, 'dsh-kb-skill-context')
  check(context?.includes('deepseek-harness/skill-context.md'), '技能加载上下文包含命中的本地笔记路径')
  check(context?.includes('origin: local'), '技能上下文显示来源分级')
  check(context?.includes('kb_read'), '技能上下文指向结构化正文读取工具')

  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const dispose = installKbHooks(ctx, { getKb: () => contextKb })
  check(listeners.size === 1 && listeners.has('tools/post-execute'), '只监听技能工具结果，不收集回合文本')
  const decision = await listeners.get('tools/post-execute')(
    { name: 'skill', arguments: { name: 'dsh-kb-skill-context' } },
    { value: null },
    async () => ({ kind: 'accept', additionalContexts: [{ id: 'prior' }] })
  )
  check(decision.additionalContexts.length === 2, '相关笔记追加到既有 additionalContexts 后面')
  check(decision.additionalContexts[0].id === 'prior', '保留其他插件已追加的上下文')
  check(decision.additionalContexts[1].source.kind === 'dsh-kb', '附加消息具有 dsh-kb 来源')
  dispose()
  check(listeners.size === 0, '卸载时移除 hook')
  check(!existsSync(path.join(vault, 'deepseek-harness', 'INDEX.md')), '查询 L0 不写入磁盘 INDEX.md')
} catch (error) {
  fail.push(error.stack || error.message)
  console.error(error.stack || error)
} finally {
  if (vault) rmSync(vault, { recursive: true, force: true })
}

console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
