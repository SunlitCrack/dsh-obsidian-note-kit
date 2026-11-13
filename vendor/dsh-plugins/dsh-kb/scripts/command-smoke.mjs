// dsh-kb — `/kb` 命令逻辑测试（不依赖宿主 UI）。
//
// 覆盖：输入解析、每个子命令的输出形态、错误兜底、以及注册器的降级行为。
// 用一次性临时 vault，绝不碰真实库。

import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const base = pathToFileURL('D:/dsh-plugins/dsh-kb/core/').href
const { VaultStore } = await import(`${base}store.js`)
const { Indexer } = await import(`${base}indexer.js`)
const { KnowledgeBase } = await import(`${base}kb.js`)
const cmdUrl = pathToFileURL('D:/dsh-plugins/dsh-kb/lib/commands.js').href
const { parseKbInput, runKbCommand, installKbCommand } = await import(`${cmdUrl}?v=${Date.now()}`)

const fail = []
const ok = (msg) => console.log(`✓ ${msg}`)
const check = (cond, msg) => (cond ? ok(msg) : (fail.push(msg), console.error(`✗ ${msg}`)))

// ---- 1. 输入解析 -----------------------------------------------------------
{
  check(parseKbInput('').sub === 'help', '空输入 → help')
  check(parseKbInput('  ').sub === 'help', '纯空白 → help')
  const s = parseKbInput('search ES 磁盘只读')
  check(s.sub === 'find' && s.rest === 'ES 磁盘只读', `旧 search 命令归一为 find：sub=${s.sub} rest=${s.rest}`)
  check(parseKbInput('STATUS').sub === 'status', '子命令名大小写归一')
}

let vault = null
try {
  vault = mkdtempSync(path.join(tmpdir(), 'dsh-kb-cmd-'))
  const put = (rel, fm, body) => {
    const abs = path.join(vault, ...rel.split('/'))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, `---\n${fm}\n---\n${body}\n`, 'utf8')
  }
  put('demo/note-a.md', 'title: A\ntags: [x]\norigin: local', '# A\n\nflood-stage 磁盘只读块。')
  put('demo/note-b.md', 'title: B\ntags: [x]\norigin: local', '# B\n\n另一篇。')

  const store = new VaultStore(vault)
  const kb = new KnowledgeBase({ store, indexer: new Indexer(store) })

  // ---- 2. help -------------------------------------------------------------
  {
    const r = await runKbCommand(kb, '')
    check(r.kind === 'success', 'help 返回 success')
    check(r.text.includes('/kb status'), 'help 列出 status')
    check(r.text.includes('/kb find'), 'help 列出 find')
  }

  // ---- 3. status -----------------------------------------------------------
  {
    const r = await runKbCommand(kb, 'status')
    check(r.kind === 'success', 'status 返回 success')
    check(r.text.includes('项目'), 'status 含项目数')
    check(r.text.includes('demo'), `status 列出项目名（含 demo? ${r.text.includes('demo')}）`)
  }

  // ---- 4. search -----------------------------------------------------------
  {
    const hit = await runKbCommand(kb, 'search flood-stage')
    check(hit.kind === 'success', 'search 返回 success')
    check(hit.text.includes('demo/note-a.md'), 'search 命中预期笔记')

    const miss = await runKbCommand(kb, 'search 完全不存在的词组xyz')
    check(miss.kind === 'success', 'search 无命中仍是 success')
    check(miss.text.includes('没有命中'), 'no-hit 文本可读')

    const noArg = await runKbCommand(kb, 'search')
    check(noArg.kind === 'error', 'search 缺参数 → error')
    check(noArg.text.includes('用法'), '缺参数给出用法')
  }

  // ---- 5. doctor -----------------------------------------------------------
  {
    const r = await runKbCommand(kb, 'doctor')
    check(r.kind === 'success', 'doctor 返回 success')
    check(/体检\s*\d+\s*篇/.test(r.text) || r.text.includes('体检通过'), `doctor 文本可读：${r.text.split('\n')[0]}`)
  }

  // ---- 6. gaps -------------------------------------------------------------
  {
    const gaps = await runKbCommand(kb, 'gaps')
    check(gaps.kind === 'success', 'gaps 返回 success')
  }

  // ---- 8. 未知子命令 -------------------------------------------------------
  {
    const r = await runKbCommand(kb, 'nonsense')
    check(r.kind === 'error', '未知子命令 → error')
    check(r.text.includes('未知子命令'), '未知子命令给出明确提示')
    check(r.text.includes('/kb status'), '未知子命令附帮助表')
  }

  // ---- 9. kb 不可用时 handler 不抛 ----------------------------------------
  {
    const broken = { index: () => { throw new Error('vault 挂了') } }
    const r = await runKbCommand(broken, 'status')
    check(r.kind === 'error', 'kb 抛错 → error（不外泄）')
    check(r.text.includes('执行失败'), '错误文本可读')
  }

  // ---- 10. 注册器：装得上、可卸载、缺服务时降级 ----------------------------
  {
    const registered = []
    const fakeCtx = {
      inject(deps, fn) {
        assert.deepEqual(deps, ['commands'])
        fn({ commands: { register: (d) => { registered.push(d); return () => { registered.pop() } } } })
      },
      logger: { warn: () => {} },
    }
    const dispose = installKbCommand(fakeCtx, { getKb: () => kb })
    check(registered.length === 1, `注册了 1 个命令（${registered.length}）`)
    check(registered[0].name === 'kb', '命令名是 kb')
    const out = await registered[0].handler({ rawInput: 'status' })
    check(out.kind === 'success', 'handler 可直接执行并返回 success')
    dispose()
    check(registered.length === 0, 'dispose 后命令被撤销')

    // 无 commands 服务 → 不抛、不注册
    const noService = { inject: (deps, fn) => fn({}), logger: { warn: () => {} } }
    let threw = null
    try {
      installKbCommand(noService, { getKb: () => kb })()
    } catch (err) {
      threw = err
    }
    check(threw === null, '无 commands 服务时静默降级')

    // handler 内部抛错 → 兜成 error 文本，不冒泡
    const badCtx = {
      inject(deps, fn) {
        fn({ commands: { register: (d) => { registered.push(d); return () => {} } } })
      },
      logger: { warn: () => {} },
    }
    installKbCommand(badCtx, {
      getKb: () => {
        throw new Error('boom')
      },
    })
    const badOut = await registered[registered.length - 1].handler({ rawInput: 'status' })
    check(badOut.kind === 'error', 'handler 内 kb 抛错 → error 文本')
    check(badOut.text.includes('知识库不可用'), '错误文本指明知识库不可用')
  }
} finally {
  if (vault) rmSync(vault, { recursive: true, force: true })
}

console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
if (fail.length) process.exitCode = 1
