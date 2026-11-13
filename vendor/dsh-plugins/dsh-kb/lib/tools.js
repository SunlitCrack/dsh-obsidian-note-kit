// dsh-kb model tools: knowledge discovery and the structured gap ledger.

import { toErrorPayload, ValidationError } from '../core/errors.js'

const str = (description) => ({ type: 'string', description })
const strOpt = (description) => ({ type: 'string', description })
const arrOpt = (description) => ({ type: 'array', items: { type: 'string' }, description })
const numOpt = (description) => ({ type: 'number', description })

function params(props, required = []) {
  return { type: 'object', properties: { ...props }, required }
}

function register(ctx, key, def) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  const { behavior, execute, ...rest } = def
  const wrapped = async (rawArgs) => {
    try {
      const args = rawArgs ?? {}
      const required = def.parameters?.required ?? []
      const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '')
      if (missing.length) throw new ValidationError(`缺少必填参数: ${missing.join(', ')}`)
      return await execute(args)
    } catch (err) {
      return toErrorPayload(err)
    }
  }
  ctx.tools.register({
    ...rest,
    name: key,
    behavior,
    readOnly: behavior === 'read',
    idempotent: behavior === 'read' || behavior === 'idempotent',
    output: {
      schema: {},
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: wrapped,
  })
}

/** Register the compact agent-facing surface. */
export function registerKbTools(ctx, getKb) {
  register(ctx, 'kb_find', {
    name: 'kb_find',
    description:
      '本地知识库发现入口。省略 query 时返回项目清单，指定 project 时同时返回该项目的 L0 索引与条目；指定 query 时返回 BM25 中文/英文检索结果、摘要和片段。' +
      '默认召回 origin=local 与 origin=unlabeled，过滤 web/inferred；如需外部或推理来源，显式设 includeWeb:true 或 origin。' +
      'MCP 的通用 search 不做 origin 过滤；知识发现优先使用本工具。命中后可用 kb_read 获取正文。',
    behavior: 'read',
    parameters: params({
      query: strOpt('检索词；省略时列出项目或读取项目 L0 索引'),
      project: strOpt('限定项目（vault 顶级目录名）'),
      topK: numOpt('检索结果条数（默认 12）'),
      limit: numOpt('项目列表或 L1 条目上限（默认 300）'),
      includeWeb: { type: 'boolean', description: '是否同时召回 web/inferred 来源（默认 false）' },
      origin: arrOpt('允许的来源列表，如 ["local", "unlabeled"]'),
      tag: strOpt('限定标签'),
      type: strOpt('按 type 精确过滤；"note" 表示没有 type 的普通笔记'),
    }),
    async execute(args) {
      const kb = getKb()
      if (typeof args.query === 'string' && args.query.trim()) {
        return kb.search({
          query: args.query,
          project: args.project ?? null,
          topK: args.topK,
          origin: args.origin,
          includeWeb: args.includeWeb === true,
          tag: args.tag ?? null,
          type: args.type ?? null,
        })
      }
      return kb.index({ project: args.project ?? null, limit: args.limit })
    },
  })

  register(ctx, 'kb_read', {
    name: 'kb_read',
    description:
      '按 vault 相对路径读取一篇笔记的 frontmatter 与正文，不改写、不复制。返回 origin 等来源元数据；编辑已有笔记前，用 obsidian MCP read_note 获取 contentHash，再用对应的 MCP 写入操作。',
    behavior: 'read',
    parameters: params({
      path: str('vault 相对路径，如 k8s/知识笔记/elasticsearch/xxx.md'),
      maxChars: numOpt('正文最大字符数（默认 0 = 不截断）'),
    }, ['path']),
    async execute(args) {
      return getKb().read({ path: args.path, maxChars: args.maxChars })
    },
  })

  register(ctx, 'kb_doctor', {
    name: 'kb_doctor',
    description: '知识库只读体检：缺标题、来源未标注、过期、断链、重复标题和未补缺口。level = error|warn|info。',
    behavior: 'read',
    parameters: params({
      project: strOpt('限定项目'),
      limit: numOpt('返回条数上限（默认 200）'),
    }),
    async execute(args) {
      return getKb().doctor({ project: args.project ?? null, limit: args.limit })
    },
  })

  register(ctx, 'kb_gap', {
    name: 'kb_gap',
    description:
      '维护 dsh-kb 的结构化知识缺口清单（项目 Inbox/缺口.md）。缺口使用确定性 ID，可幂等去重与按 ID 勾销；本工具只拥有缺口记录，不写知识笔记。' +
      '先用 kb_find 检索；确实缺失且需要外部检索或推理时用 add，补齐后用 resolve。',
    behavior: 'idempotent',
    parameters: params({
      action: strOpt('list（默认）| add | resolve'),
      project: strOpt('项目名（vault 顶级目录）；list 省略 = 全部项目'),
      question: strOpt('库里缺什么（add 必填）'),
      clues: strOpt('已知线索 / 关键词（add 可选）'),
      source: strOpt('不得不使用的外部来源（add 可选）'),
      origin: strOpt('缺口来源：inferred（默认）| web'),
      id: strOpt('缺口 ID（resolve 必填）'),
      note: strOpt('补到了哪篇笔记 / 怎么补的（resolve 可选）'),
    }),
    async execute(args) {
      const kb = getKb()
      const action = String(args.action ?? 'list')
      if (action === 'list') return kb.gapList({ project: args.project ?? null })
      if (action === 'add') {
        return kb.gapAdd({
          project: args.project,
          question: args.question,
          clues: args.clues ?? null,
          source: args.source ?? null,
          origin: args.origin ?? 'inferred',
        })
      }
      if (action === 'resolve') {
        return kb.gapResolve({ project: args.project, id: args.id, note: args.note ?? null })
      }
      throw new ValidationError(`未知 action: ${action}（list | add | resolve）`)
    },
  })
}
