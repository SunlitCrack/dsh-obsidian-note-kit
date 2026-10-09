// dsh-kb — model-callable tools (host half).
//
// These are the "agent uses the knowledge base" surface. They are deliberately
// small and follow the L0 → L1 → L2 disclosure contract so an agent never has
// to load the whole vault into context:
//
//   kb_index  → L0: which projects exist + one project's INDEX.md
//   kb_search → L1: ranked metadata rows + snippets (origin-filtered)
//   kb_read   → L2: one note's body, only when it is actually needed
//
// Every tool result is plain structured JSON, and thrown errors are compacted
// into `{ ok:false, error:{code,message,suggestion} }` (same contract cardian
// used, so agents behave identically on failure).

import path from 'node:path'
import { toErrorPayload, ValidationError } from '../core/errors.js'
import { slugify } from '../core/slug.js'

const str = (description) => ({ type: 'string', description })
const strOpt = (description) => ({ type: 'string', description })
const arrOpt = (description) => ({ type: 'array', items: { type: 'string' }, description })
const numOpt = (description) => ({ type: 'number', description })
const boolOpt = (description) => ({ type: 'boolean', description })

function params(props, required = []) {
  return { type: 'object', properties: { ...props }, required }
}

function register(ctx, key, def) {
  // NOTE: reading `ctx.tools` here is only legal because lib/index.js declares
  // `export const inject = ['tools']`. This cordis build THROWS
  // `cannot get property "tools" without inject` on un-injected access, and that
  // throw happens inside apply() → it takes the whole plugin tree (and DSH
  // startup) down with it. 2026-09-14: exactly that broke startup.
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  const { behavior, execute, ...rest } = def
  const wrapped = async (rawArgs, exec) => {
    try {
      const args = rawArgs ?? {}
      const required = def.parameters?.required ?? []
      const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '')
      if (missing.length) throw new ValidationError(`缺少必填参数: ${missing.join(', ')}`)
      return await execute(args, exec)
    } catch (err) {
      return toErrorPayload(err)
    }
  }
  ctx.tools.register({
    ...rest,
    name: key,
    behavior,
    readOnly: behavior === 'read',
    idempotent: behavior === 'read' || behavior === 'idempotent' || behavior === 'destroy',
    destructive: behavior === 'destroy',
    output: {
      schema: {},
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: wrapped,
  })
}

/**
 * @param ctx      cordis context (needs ctx.tools)
 * @param getKb    lazy accessor → KnowledgeBase (so the plugin still loads when
 *                 no vault is configured; the failure surfaces per tool call)
 */
/**
 * Real user approval through the host's `approval` service. Fails CLOSED: when
 * the service (or the exec context) is missing, the modifying action is refused
 * and the caller points the user at the Inbox panel instead — the agent must
 * never be able to silently rewrite an existing note.
 */
async function askApproval(getApproval, exec, { toolName, reason }) {
  const service = getApproval()
  if (!service || typeof service.request !== 'function' || !exec || !exec.agent) {
    return { allowed: false, outcome: 'unavailable' }
  }
  try {
    const outcome = await service.request({
      agent: exec.agent,
      toolName,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    return { allowed: outcome === 'allowed-once', outcome }
  } catch (err) {
    return {
      allowed: false,
      outcome: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * @param ctx        cordis context (needs ctx.tools)
 * @param getKb      lazy accessor → KnowledgeBase
 * @param deps.getApproval  lazy accessor → 宿主 approval 服务（可缺）
 */
export function registerKbTools(ctx, getKb, deps = {}) {
  const getApproval = typeof deps.getApproval === 'function' ? deps.getApproval : () => null
  const getWiki =
    typeof deps.getWiki === 'function'
      ? deps.getWiki
      : () => {
          throw new ValidationError('RepoWiki 服务未就绪')
        }
  const ask = (exec, req) => askApproval(getApproval, exec, req)

  /** 让某个 repo 项目的 L0 INDEX.md 跟上（wiki 页面就是该项目的笔记）。 */
  const refreshRepoIndex = async (repo) => {
    const name = slugify(repo)
    if (!name) return null
    try {
      return await getKb().rebuildIndex(name)
    } catch {
      return null
    }
  }
  const repoNameOf = (args) => args.repoName || path.basename(String(args.repoPath || '').replace(/[/\\]+$/, ''))

  register(ctx, 'kb_index', {
    name: 'kb_index',
    description:
      '知识库 L0 入口：列出 vault 里所有「项目」(顶级目录) 及各自笔记数，或读取某个项目的 INDEX.md 索引页。' +
      '做任何任务前先调用它（或 kb_search），按索引决定要读哪几篇，而不是盲扫全文。' +
      '传 rebuild:true 会重写该项目的 INDEX.md（派生文件）。',
    behavior: 'read',
    parameters: params({
      project: strOpt('项目名（vault 顶级目录名，如 k8s）。省略则只返回项目清单'),
      rebuild: boolOpt('是否重写该项目的 INDEX.md（默认 false）'),
      limit: numOpt('项目清单里每个项目返回的条目上限（默认 300）'),
    }),
    async execute(args) {
      return getKb().index({ project: args.project ?? null, rebuild: args.rebuild === true, limit: args.limit })
    },
  })

  register(ctx, 'kb_search', {
    name: 'kb_search',
    description:
      '知识库 L1 检索：BM25（含中文二元组）+ 标签加权，返回 path/title/type/tags/summary/snippet/score/origin。' +
      '默认只召回 origin=local（本地已验证知识），web/inferred 需显式 includeWeb 或 origin 指定 —— 这是防网络污染的第一道闸。' +
      'type 可按 frontmatter type 分流（card / memory / wiki / 自定义）；type="note" 只召回没有 type 的普通笔记。' +
      '命中后用 kb_read 只读真正需要的那几篇正文。',
    behavior: 'read',
    parameters: params(
      {
        query: str('检索词（中文/英文均可；报错原文、组件名、机制名最好用）'),
        project: strOpt('限定某个项目（vault 顶级目录名）'),
        topK: numOpt('返回条数（默认 12）'),
        includeWeb: boolOpt('是否连同 origin=web|inferred 的笔记一起召回（默认 false）'),
        origin: arrOpt('显式指定允许的 origin 列表，如 ["local","web"]'),
        tag: strOpt('限定标签'),
        type: strOpt('按 type 分流：card | memory | wiki | 自定义；"note" = 只要没有 type 的普通笔记'),
      },
      ['query']
    ),
    async execute(args) {
      return getKb().search({
        query: args.query,
        project: args.project ?? null,
        topK: args.topK,
        origin: args.origin,
        includeWeb: args.includeWeb === true,
        tag: args.tag ?? null,
        type: args.type ?? null,
      })
    },
  })

  register(ctx, 'kb_read', {
    name: 'kb_read',
    description:
      '知识库 L2 读取：按 vault 相对路径读一篇笔记的 frontmatter + 正文（原地读取，不改写、不复制）。' +
      '路径必须落在 vault 内；正文过长时用 maxChars 截断。',
    behavior: 'read',
    parameters: params(
      {
        path: str('vault 相对路径，如 k8s/故障手册/elasticsearch/xxx.md'),
        maxChars: numOpt('正文最大字符数（默认 0 = 不截断）'),
      },
      ['path']
    ),
    async execute(args) {
      return getKb().read({ path: args.path, maxChars: args.maxChars })
    },
  })

  register(ctx, 'kb_capture', {
    name: 'kb_capture',
    description:
      '沉淀一条知识：先写进 <project>/Inbox/ 待审区（自动，绝不碰正式笔记），并返回相似度最高的既有笔记作为合并候选。' +
      'origin 默认 inferred —— 网上或推理得来的内容一律先待审（origin=web|inferred），只有本地已验证的才用 origin=local。' +
      '随后用 kb_inbox 归库（promote）或与候选合并（merge，需用户批准）。',
    behavior: 'idempotent',
    parameters: params(
      {
        project: str('项目（vault 顶级目录名，如 k8s）'),
        title: str('标题（会成为文件名）'),
        content: str('正文（Markdown；只写可复用的结论，不要写流水账）'),
        tags: arrOpt('标签'),
        origin: strOpt('local | web | inferred（默认 inferred）'),
        confidence: numOpt('置信度 0-1'),
        source: strOpt('来源（URL / 文件路径 / 会话 id）'),
        kind: strOpt('type 字段（默认 card）'),
      },
      ['project', 'title', 'content']
    ),
    async execute(args) {
      return getKb().stage({
        project: args.project,
        title: args.title,
        content: args.content,
        tags: args.tags,
        origin: args.origin,
        confidence: args.confidence,
        source: args.source,
        kind: args.kind,
      })
    },
  })

  register(ctx, 'kb_inbox', {
    name: 'kb_inbox',
    description:
      '待审区（<project>/Inbox/）与正式笔记修订：action=list 看待审条目；promote 归入正式目录（自动，刷新该项目 INDEX.md）；' +
      'merge 把待审条目合并进**已有笔记**（追加「补充」小节、提 confidence、记来源；mode=conflict 则进「⚖️ 冲突（待裁决）」小节）；' +
      'revise **就地修订正式笔记中被新证据证伪的片段**（edits: [{ find, replace }]，每个 find 必须在正文中唯一命中；替换记录写进 frontmatter.revisions）—— 用于改对过时的版本号 / 失效路径 / 已被推翻的结论，**不是**重写或新增知识的通道；' +
      'drop 丢弃到 Inbox/.dropped/（可恢复）。merge / revise / drop 会改动已有笔记，**必须经用户批准**（宿主 approval 弹窗）；' +
      '未获批准时返回 APPROVAL_REQUIRED，不要重试绕过 —— 让用户在「知识中心 → Inbox」面板里手动处理。',
    behavior: 'idempotent',
    parameters: params(
      {
        action: str('list | promote | merge | revise | drop'),
        project: strOpt('项目（list 时可限定）'),
        path: strOpt('待审条目路径（promote/merge/drop 必填）/ revise 的目标正式笔记路径'),
        into: strOpt('merge 的目标正式笔记路径'),
        targetDir: strOpt('promote 的目标目录（项目内子目录；默认项目根）'),
        mode: strOpt('merge 模式：append（默认）| conflict'),
        edits: {
          type: 'array',
          description:
            'revise 的就地替换指令：每项 { find, replace }。find 必须是正文中**唯一命中**的原文片段（0 处或多个匹配都会报错拒绝执行），replace 为替换文本。禁止用于自由重写、重排章节或写入新知识。',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: '要被替换的原文片段（必须唯一命中）' },
              replace: { type: 'string', description: '替换后的文本' },
            },
            required: ['find', 'replace'],
          },
        },
        note: strOpt('merge 的小节标题 / revise 的修订说明（记入 frontmatter.revisions） / promote 的备注'),
        reason: strOpt('drop 的原因（留痕）'),
      },
      ['action']
    ),
    async execute(args, exec) {
      const kb = getKb()
      const action = String(args.action ?? '').toLowerCase()
      if (action === 'list') return kb.inboxList({ project: args.project ?? null })
      if (!args.path) throw new ValidationError('缺少 path（待审条目的 vault 相对路径）')

      if (action === 'promote') {
        return kb.promote({
          path: args.path,
          targetDir: args.targetDir ?? null,
          note: args.note ?? null,
        })
      }

      if (action === 'merge' || action === 'revise' || action === 'drop') {
        const editCount = Array.isArray(args.edits) ? args.edits.length : 0
        const what =
          action === 'merge'
            ? `把 ${args.path} 合并进已有笔记 ${args.into ?? '?'}`
            : action === 'revise'
              ? `就地修订正式笔记 ${args.path}（${editCount} 处替换）`
              : `丢弃待审条目 ${args.path}`
        const gate = await ask(exec, { toolName: 'kb_inbox', reason: what })
        if (!gate.allowed) {
          return {
            ok: false,
            error: {
              code: 'APPROVAL_REQUIRED',
              message: `${what} 会改动已有内容，需要用户批准（approval=${gate.outcome}）${
                gate.message ? `：${gate.message}` : ''
              }`,
              suggestion:
                action === 'revise'
                  ? '让用户确认要修订的片段与替换文本后重试。'
                  : '让用户在「知识中心 → Inbox」面板里手动合并/丢弃，或批准本次请求后重试。',
            },
          }
        }
        if (action === 'merge') {
          if (!args.into) throw new ValidationError('merge 需要 into（目标正式笔记路径）')
          return kb.mergeInto({
            staged: args.path,
            into: args.into,
            mode: args.mode ?? 'append',
            note: args.note ?? null,
          })
        }
        if (action === 'revise') {
          return kb.reviseNote({
            path: args.path,
            edits: args.edits ?? [],
            note: args.note ?? null,
          })
        }
        return kb.dropStaged({ path: args.path, reason: args.reason ?? null })
      }

      throw new ValidationError(`未知 action: ${args.action}（可选 list | promote | merge | revise | drop）`)
    },
  })

  // ---- P3: RepoWiki（代码仓库 → 就地 wiki + 依赖图 + 双向 sync） --------------

  register(ctx, 'kb_wiki_ingest', {
    name: 'kb_wiki_ingest',
    description:
      '扫描本地代码仓库，为每个源文件生成一张 Wiki 骨架卡（路径、语言、行数、代码摘录），**原地**写进 vault 顶层项目 `<repo>/<源码路径>.md`。' +
      '生成后用 kb_wiki_upsert 回填语义描述（agent 自己凝练，不需要插件另起会话）。',
    behavior: 'idempotent',
    parameters: params(
      {
        repoPath: str('本地仓库绝对/相对路径'),
        repoName: strOpt('仓库名（默认取目录名；它同时是 vault 里的项目目录名）'),
        maxFiles: numOpt('最多扫描文件数（默认 50）'),
      },
      ['repoPath']
    ),
    async execute(args) {
      const repo = repoNameOf(args)
      const result = await getWiki().ingest(args.repoPath, { repoName: repo, maxFiles: args.maxFiles })
      return { ...result, repo, index: await refreshRepoIndex(repo) }
    },
  })

  register(ctx, 'kb_wiki_sync', {
    name: 'kb_wiki_sync',
    description:
      '以磁盘为准双向同步某仓库的 RepoWiki：新增生成骨架、变更重建骨架（已语义回填的页只刷指纹并标 staleSynced）、可剪除孤儿页。',
    behavior: 'idempotent',
    parameters: params(
      {
        repoPath: str('本地仓库绝对/相对路径'),
        repoName: strOpt('仓库名（默认取目录名）'),
        pruneOrphans: boolOpt('是否剪除孤儿页（默认 true）'),
        maxFiles: numOpt('最多扫描文件数（默认 100）'),
      },
      ['repoPath']
    ),
    async execute(args) {
      const repo = repoNameOf(args)
      const result = await getWiki().sync(args.repoPath, {
        repoName: repo,
        pruneOrphans: args.pruneOrphans !== false,
        maxFiles: args.maxFiles,
      })
      return { ...result, repo, index: await refreshRepoIndex(repo) }
    },
  })

  register(ctx, 'kb_wiki_upsert', {
    name: 'kb_wiki_upsert',
    description:
      '创建/更新一张 RepoWiki 页面（描述仓库里某个文件或模块的职责、结构、注意点）。' +
      '按 (repo, path) 原地更新，幂等；这是"AI 凝练"的落点 —— agent 读完骨架后用语义描述覆盖 body。',
    behavior: 'idempotent',
    parameters: params(
      {
        repo: str('仓库名（slug）'),
        path: str('仓库内相对路径，如 src/lib/store.js'),
        content: str('页面正文（Markdown）'),
        title: strOpt('标题（默认等于 path）'),
        tags: arrOpt('标签'),
        language: strOpt('语言'),
        summary: strOpt('一句话摘要'),
        status: strOpt('draft | published'),
      },
      ['repo', 'path', 'content']
    ),
    async execute(args) {
      const result = await getWiki().upsert({
        repo: args.repo,
        path: args.path,
        content: args.content,
        title: args.title,
        tags: args.tags,
        language: args.language,
        summary: args.summary,
        status: args.status,
      })
      return { ...result, index: await refreshRepoIndex(args.repo) }
    },
  })

  register(ctx, 'kb_wiki_overview', {
    name: 'kb_wiki_overview',
    description: '为人读者生成/刷新某仓库的项目级概览页（体量、目录、语言分布、核心模块被引排行、页面清单）。',
    behavior: 'idempotent',
    parameters: params({ repo: str('仓库名') }, ['repo']),
    async execute(args) {
      const result = await getWiki().overview(args.repo)
      return { ...result, index: await refreshRepoIndex(args.repo) }
    },
  })

  register(ctx, 'kb_wiki_graph', {
    name: 'kb_wiki_graph',
    description: '返回某仓库的代码图谱：节点（页面 + 导出符号）与依赖边（import 关系），含每个模块的被引计数。',
    behavior: 'read',
    parameters: params({ repo: str('仓库名') }, ['repo']),
    async execute(args) {
      return getWiki().graph(args.repo)
    },
  })

  register(ctx, 'kb_wiki_list', {
    name: 'kb_wiki_list',
    description: '列出 RepoWiki 页面；不传 repo 时返回所有已扫描仓库及其条目。',
    behavior: 'read',
    parameters: params({ repo: strOpt('仓库名（可选）') }),
    async execute(args) {
      if (!args.repo) return { repos: await getWiki().listRepos(), entries: await getWiki().list() }
      return getWiki().list({ group: args.repo })
    },
  })

  register(ctx, 'kb_wiki_delete', {
    name: 'kb_wiki_delete',
    description: '删除某仓库中指定路径的 RepoWiki 页面（用于清理已删除的源文件）。',
    behavior: 'destroy',
    parameters: params({ repo: str('仓库名'), path: str('文件相对路径') }, ['repo', 'path']),
    async execute(args) {
      const deleted = await getWiki().removeByPath(args.repo, args.path)
      return { deleted, index: await refreshRepoIndex(args.repo) }
    },
  })

  // ---- P4: 洞察 / 导入导出 / 技能包 / 反馈闭环 -------------------------------

  register(ctx, 'kb_tagcloud', {
    name: 'kb_tagcloud',
    description: '标签云：统计知识库各标签的条目数（可按项目限定），用来发现主题聚集与冷门标签。',
    behavior: 'read',
    parameters: params({ project: strOpt('限定项目'), limit: numOpt('返回条数上限（默认 200）') }),
    async execute(args) {
      return getKb().tagCloud({ project: args.project ?? null, limit: args.limit })
    },
  })

  register(ctx, 'kb_backlinks', {
    name: 'kb_backlinks',
    description:
      '反链 + 相关：谁用 [[wikilink]] 指向了这篇（backlinks），以及强关联的笔记（related：typed relations 优先，其次共享标签）。' +
      '做归纳/去重前先看这个，能避免重复造页。',
    behavior: 'read',
    parameters: params({ path: str('笔记路径 / 标题 / 别名'), max: numOpt('各自返回上限（默认 20）') }, ['path']),
    async execute(args) {
      const kb = getKb()
      const max = Number.isFinite(Number(args.max)) && Number(args.max) > 0 ? Number(args.max) : 20
      const [links, related] = await Promise.all([
        kb.backlinks({ path: args.path, max }),
        kb.related({ path: args.path, max }),
      ])
      return { path: links.path, backlinks: links.backlinks, related: related.related }
    },
  })

  register(ctx, 'kb_doctor', {
    name: 'kb_doctor',
    description:
      '库体检：缺 title / 已过期（expires）/ 断链（wikilink 指向不存在的笔记）/ 标题重复 / INDEX.md 落后 / 待审未归库。level = error|warn|info。',
    behavior: 'read',
    parameters: params({ project: strOpt('限定项目'), limit: numOpt('返回条数上限（默认 200）') }),
    async execute(args) {
      return getKb().doctor({ project: args.project ?? null, limit: args.limit })
    },
  })

  register(ctx, 'kb_export', {
    name: 'kb_export',
    description: '导出知识库快照（JSON：rel + frontmatter + 正文），用于迁移/备份；可只导一个项目。',
    behavior: 'read',
    parameters: params({ project: strOpt('只导出某个项目') }),
    async execute(args) {
      return getKb().exportSnapshot({ project: args.project ?? null })
    },
  })

  register(ctx, 'kb_import', {
    name: 'kb_import',
    description:
      '导入知识库快照。**默认 dryRun**（只返回计划：新增/更新/未变/跳过）；要真正写盘必须 dryRun:false **且经用户批准**（会批量新建/改动笔记）。',
    behavior: 'idempotent',
    parameters: params(
      {
        data: { type: 'object', description: 'kb_export 导出的快照对象' },
        dryRun: boolOpt('默认 true（只出计划，不写盘）'),
      },
      ['data']
    ),
    async execute(args, exec) {
      const kb = getKb()
      if (args.dryRun !== false) return kb.importSnapshot({ data: args.data, dryRun: true })
      const total = Array.isArray(args.data?.notes) ? args.data.notes.length : '?'
      const gate = await ask(exec, { toolName: 'kb_import', reason: `把快照写回 vault（${total} 篇）` })
      if (!gate.allowed) {
        return {
          ok: false,
          error: {
            code: 'APPROVAL_REQUIRED',
            message: `批量写回快照需要用户批准（approval=${gate.outcome}）`,
            suggestion: '先看 dryRun 计划，确认无误后再征得用户同意。',
          },
        }
      }
      return kb.importSnapshot({ data: args.data, dryRun: false })
    },
  })

  register(ctx, 'kb_skill_export', {
    name: 'kb_skill_export',
    description:
      '把若干笔记打包成技能包：`.dsh-kb/skills/<name>/SKILL.md` + `references/`。把该目录复制到 `~/.dsh/skills/` 即可被 DSH 技能系统加载。',
    behavior: 'idempotent',
    parameters: params(
      {
        name: str('技能名（会 slug 化）'),
        refs: { type: 'array', items: { type: 'string' }, description: '要打包的笔记（路径 / 标题 / 别名）' },
        description: strOpt('一句话描述'),
        limit: numOpt('最多打包几篇（默认 20）'),
      },
      ['name', 'refs']
    ),
    async execute(args) {
      return getKb().exportSkill({
        name: args.name,
        refs: args.refs,
        description: args.description,
        limit: args.limit,
      })
    },
  })

  register(ctx, 'kb_feedback', {
    name: 'kb_feedback',
    description:
      '人工反馈闭环：kind=correction 表示这条知识被纠正（confidence −0.2），kind=confirm 表示确认正确（+0.1），同时记进 corrections 留痕。' +
      '会改已有笔记 → **需要用户批准**。',
    behavior: 'idempotent',
    parameters: params(
      {
        path: str('笔记路径 / 标题'),
        kind: strOpt('correction（默认）| confirm'),
        text: strOpt('反馈内容（留痕用）'),
      },
      ['path']
    ),
    async execute(args, exec) {
      const kind = args.kind ?? 'correction'
      const gate = await ask(exec, {
        toolName: 'kb_feedback',
        reason: `对 ${args.path} 记一条 ${kind} 反馈（会改该笔记 frontmatter 的 confidence/corrections）`,
      })
      if (!gate.allowed) {
        return {
          ok: false,
          error: {
            code: 'APPROVAL_REQUIRED',
            message: `修改已有笔记需要用户批准（approval=${gate.outcome}）`,
            suggestion: '让用户确认这条反馈后再重试。',
          },
        }
      }
      return getKb().feedback({ path: args.path, kind, text: args.text ?? '' })
    },
  })

  register(ctx, 'kb_gap', {
    name: 'kb_gap',
    description:
      '缺口清单（用出来的知识库才会长大）：action=list 看缺口，action=add 记下「库里没有、我不得不外部检索/自行推理」的问题（落 `Inbox/缺口.md`，不写已有笔记，无需批准），action=resolve 在补齐后勾掉（id + 可选 note）。' +
      '先 kb_search，没命中（或 origin=web/inferred 才够用）时用 add 记一条，回头补齐知识库。',
    behavior: 'idempotent',
    parameters: params(
      {
        action: strOpt('list（默认）| add | resolve'),
        project: strOpt('项目名（vault 顶级目录）；list 省略 = 全部项目'),
        question: strOpt('库里缺什么（add 必填）'),
        clues: strOpt('已知线索 / 关键词（add 可选）'),
        source: strOpt('这次不得已用了什么外部来源（add 可选）'),
        origin: strOpt('缺口来源：inferred（默认）| web'),
        id: strOpt('缺口 id（resolve 必填，list 结果里有）'),
        note: strOpt('补到了哪篇笔记 / 怎么补的（resolve 可选）'),
      },
      []
    ),
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

  register(ctx, 'kb_graph', {
    name: 'kb_graph',
    description:
      '链接图谱（wikilink）：节点（path/title/group/in 入链/out 出链/degree）+ 边，按 degree 降序。' +
      '用来找核心笔记（degree 高）、孤儿笔记（isolated）和某篇的上下文；面板「洞察」也用这份数据画图。',
    behavior: 'read',
    parameters: params({ project: strOpt('限定项目'), limit: numOpt('节点上限（默认 200）') }),
    async execute(args) {
      return getKb().linkGraph({ project: args.project ?? null, limit: args.limit })
    },
  })

  register(ctx, 'kb_reindex', {
    name: 'kb_reindex',
    description:
      '索引自愈兜底：强制全量重建（平时每次读取已按 mtime 差分自愈，这里只在下手改过文件/怀疑索引失真时用）；' +
      'fixIndexes:true 会把「INDEX.md 落后于项目内最新笔记」的索引一并重写。只动派生文件，不改笔记正文。',
    behavior: 'idempotent',
    parameters: params({
      fixIndexes: boolOpt('同时刷新落后的 INDEX.md（默认 false）'),
      project: strOpt('只处理某个项目'),
    }),
    async execute(args) {
      return getKb().reindex({ fixIndexes: args.fixIndexes === true, project: args.project ?? null })
    },
  })
}
