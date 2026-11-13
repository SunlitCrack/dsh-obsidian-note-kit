// dsh-kb supplies a small amount of relevant vault context when a skill loads.

const MAX_CANDIDATES = 3
const TOP_DOMINANCE = 1.5

export function pickRelevant(results, { dominance = TOP_DOMINANCE, max = MAX_CANDIDATES } = {}) {
  const rows = (results ?? []).filter((row) => Number.isFinite(row?.score))
  if (!rows.length) return []
  const sorted = [...rows].sort((a, b) => b.score - a.score)
  const [top, ...rest] = sorted
  if (!rest.length) return top.score >= 8 ? [top] : []
  const mean = rest.reduce((sum, row) => sum + row.score, 0) / rest.length
  if (mean <= 0 || top.score / mean < dominance) return []
  return sorted.filter((row, index) => index === 0 || row.score >= mean * 1.1).slice(0, max)
}

export async function buildSkillContext(kb, skillName, { max = MAX_CANDIDATES } = {}) {
  const name = String(skillName ?? '').trim()
  if (!name) return null
  const query = name.replace(/[-_]+/g, ' ').trim()
  if (!query) return null
  const hit = await kb.search({ query, topK: Math.max(max, 5), includeWeb: false })
  const rows = pickRelevant(hit?.results, { max })
  if (!rows.length) return null
  const lines = [`[dsh-kb] 库内与技能 \`${name}\` 相关的笔记：`]
  for (const row of rows) {
    lines.push(`- ${row.path}${row.summary ? ` —— ${String(row.summary).slice(0, 60)}` : ''}（origin: ${row.origin}）`)
  }
  lines.push('', '需要正文时用 `kb_read` 取对应 path；修改时遵循该技能的 DSH 写入适配层。')
  return lines.join('\n')
}

export function makeContextMessage(text) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `dsh-kb-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'dsh-kb', form: 'notice' },
  }
}

function extractSkillName(source) {
  if (typeof source === 'string') return source
  if (!source || typeof source !== 'object') return ''
  return String(source.name ?? source.skill ?? source.skillName ?? source.id ?? source.value?.name ?? '').trim()
}

export function installKbHooks(ctx, { getKb, options = {}, logger = null } = {}) {
  const disposers = []
  if (options.skillContext === false || typeof ctx?.on !== 'function') return () => {}

  try {
    const off = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'accept' || exec?.name !== 'skill') return decision
      try {
        const skillName = extractSkillName(exec?.arguments ?? result?.value)
        const text = await buildSkillContext(getKb(), skillName)
        if (!text) return decision
        return {
          ...decision,
          additionalContexts: [...(decision.additionalContexts ?? []), makeContextMessage(text)],
        }
      } catch (err) {
        logger?.warn?.(`[dsh-kb] 技能上下文构建失败（忽略）：${err?.message ?? err}`)
        return decision
      }
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (err) {
    logger?.warn?.(`[dsh-kb] tools/post-execute 钩子装不上（忽略）：${err?.message ?? err}`)
  }

  return () => {
    for (const off of disposers) {
      try {
        off()
      } catch {
        /* dispose 失败不影响卸载 */
      }
    }
  }
}
