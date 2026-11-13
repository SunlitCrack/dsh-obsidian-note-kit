// dsh-kb — low-cost `/kb` discovery and maintenance commands.

const SUBCOMMANDS = [
  ['status', '库概览：项目数 / 笔记数 / 未补缺口'],
  ['find <词>', '本地知识检索（local + unlabeled）'],
  ['doctor [项目]', '体检：断链 / 缺标题 / 重复标题 / 来源标注 / 缺口'],
  ['gaps', '列出未补缺口'],
  ['help', '显示命令列表'],
]

function helpText() {
  return ['dsh-kb 命令：', ...SUBCOMMANDS.map(([usage, desc]) => `  /kb ${usage.padEnd(16)} ${desc}`)].join('\n')
}

function oneLine(value, max = 70) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function parseKbInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (!text) return { sub: 'help', rest: '' }
  const [head, ...tail] = text.split(/\s+/)
  const sub = head.toLowerCase() === 'search' ? 'find' : head.toLowerCase()
  return { sub, rest: tail.join(' ').trim() }
}

export async function runKbCommand(kb, rawInput) {
  let parsed
  try {
    parsed = parseKbInput(rawInput)
  } catch (err) {
    return { kind: 'error', text: `命令解析失败：${err?.message ?? err}` }
  }
  const { sub, rest } = parsed

  try {
    switch (sub) {
      case 'help':
      case '?':
        return { kind: 'success', text: helpText() }

      case 'status': {
        const idx = await kb.index({ limit: 1 })
        const vault = idx?.vault ?? {}
        const projects = idx?.projects ?? []
        const distribution = projects
          .filter((project) => project.name !== '(vault 根目录)')
          .map((project) => `${project.name}(${project.notes})`)
          .join(' · ')
        return {
          kind: 'success',
          text: [
            `vault: ${vault.path ?? '(未配置)'}`,
            `项目 ${vault.projectCount ?? 0} · 笔记 ${vault.noteCount ?? 0} · 未补缺口 ${vault.gapCount ?? 0}`,
            `分布: ${distribution || '(空)'}`,
          ].join('\n'),
        }
      }

      case 'find': {
        if (!rest) return { kind: 'error', text: '用法：/kb find <关键词>' }
        const hit = await kb.search({ query: rest, topK: 10 })
        const rows = hit?.results ?? []
        if (!rows.length) return { kind: 'success', text: `没有命中「${rest}」（可用 kb_gap 记录知识缺口）` }
        return {
          kind: 'success',
          text: [`命中 ${rows.length} 条（${hit.origins?.join('/') ?? 'local/unlabeled'}）：`]
            .concat(rows.map((row) => `  ${row.path}${row.summary ? `\n    ${oneLine(row.summary)}` : ''}`))
            .join('\n'),
        }
      }

      case 'doctor': {
        const report = await kb.doctor({ project: rest || null })
        const problems = report?.problems ?? []
        if (!problems.length) return { kind: 'success', text: `体检通过（${report?.scanned ?? 0} 篇）` }
        const byLevel = (level) => problems.filter((problem) => problem.level === level)
        const lines = [
          `体检 ${report?.scanned ?? 0} 篇：${report?.errors ?? 0} error / ${report?.warns ?? 0} warn / ${report?.infos ?? 0} info`,
        ]
        for (const level of ['error', 'warn', 'info']) {
          for (const problem of byLevel(level).slice(0, 8)) {
            lines.push(`  [${level}] ${problem.path} :: ${oneLine(problem.issue, 90)}`)
          }
          const extra = byLevel(level).length - 8
          if (extra > 0) lines.push(`  … 另有 ${extra} 条 ${level}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'gaps': {
        const gaps = await kb.gapList({})
        const open = (gaps?.items ?? []).filter((item) => !item.done)
        if (!open.length) return { kind: 'success', text: '没有未补缺口' }
        return {
          kind: 'success',
          text: [`未补缺口 ${open.length} 条：`]
            .concat(open.slice(0, 12).map((item) => `  [${item.project}] ${oneLine(item.question, 100)}`))
            .join('\n'),
        }
      }

      default:
        return { kind: 'error', text: `未知子命令「${sub}」\n${helpText()}` }
    }
  } catch (err) {
    return { kind: 'error', text: `执行失败：${err?.message ?? err}` }
  }
}

export function installKbCommand(ctx, { getKb, logger = null } = {}) {
  if (!ctx?.inject) return () => {}
  let dispose = null
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        const service = commandCtx?.commands
        if (!service || typeof service.register !== 'function') return
        const off = service.register({
          name: 'kb',
          description: '本地知识库：概览 / 检索 / 体检 / 缺口',
          input: { hint: 'status | find <词> | doctor [项目] | gaps | help' },
          handler: async ({ rawInput }) => {
            try {
              return await runKbCommand(getKb(), rawInput)
            } catch (err) {
              return { kind: 'error', text: `知识库不可用：${err?.message ?? err}` }
            }
          },
        })
        if (typeof off === 'function') dispose = off
      } catch (err) {
        logger?.warn?.(`[dsh-kb] /kb 命令注册失败（忽略）：${err?.message ?? err}`)
      }
    })
  } catch (err) {
    logger?.warn?.(`[dsh-kb] commands 服务不可用（忽略）：${err?.message ?? err}`)
  }
  return () => {
    try {
      dispose?.()
    } catch {
      /* dispose 失败不影响卸载 */
    }
  }
}
