#!/usr/bin/env node
// 列出本机 MCP server 实际暴露的工具名，用来填 harness.md 的能力表。
//
// 为什么需要它：不同 Obsidian MCP 实现的工具名完全不同（seekstone 用
// create_note/patch_note/…，另一套用 vault_write/vault_patch/…），照别人
// 的清单抄名字会在自己机器上全部调用失败。工具名只能以本机 tools/list 为准。
//
//   node scripts/probe-mcp-tools.mjs                      # 默认读 ~/.dsh/mcp.json 的 obsidian
//   node scripts/probe-mcp-tools.mjs --server obsidian
//   node scripts/probe-mcp-tools.mjs --config <path>
//   node scripts/probe-mcp-tools.mjs --json               # 只输出 JSON，便于脚本消费
//
// 两种传输都支持：
//   - stdio：子进程 + 行分隔 JSON-RPC（seekstone 这类命令行 server）
//   - streamable-http：HTTP POST + SSE 响应，按 Mcp-Session-Id 维持会话
//     （Obsidian Local REST API 插件自带的 MCP 走这条，实测
//      serverInfo obsidian-local-rest-api 1.0.0 / 16 个 vault_* 工具）
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const argsOf = (name) => {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1])
  }
  return out
}
const asJson = argv.includes('--json')
const configPath = argOf('--config', path.join(os.homedir(), '.dsh', 'mcp.json'))
const wantServer = argOf('--server', 'obsidian')
const timeoutMs = Number(argOf('--timeout', '20000')) || 20000
// 直接指定端点：此时不读 mcp.json。存在的理由是很多机器上 mcp.json 里压根没有
// 那条 HTTP server（或写的是别的实现），照配置文件探测会连错对象还报成功。
const overrideUrl = argOf('--url', null)
const overrideHeaders = argsOf('--header')

const die = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/** 解析 `Name: value` 形式的 header 参数。 */
const parseHeaders = (list) => {
  const out = {}
  for (const raw of list ?? []) {
    const at = raw.indexOf(':')
    if (at <= 0) die(`--header 需要 "Name: value" 形式，收到「${raw}」`)
    out[raw.slice(0, at).trim()] = raw.slice(at + 1).trim()
  }
  return out
}

const printReport = (server, info, listed) => {
  const tools = (listed?.tools ?? []).map((tool) => ({
    name: tool.name,
    description: String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 120),
  }))
  if (asJson) {
    console.log(JSON.stringify({
      server: server.name,
      transport: server.transport ?? 'stdio',
      serverVersion: info?.serverInfo?.version ?? null,
      serverInfo: info?.serverInfo ?? null,
      tools,
    }, null, 2))
    return
  }
  console.log(`server: ${server.name}${info?.serverInfo?.version ? ` ${info.serverInfo.version}` : ''} (${server.transport ?? 'stdio'})`)
  console.log(`tools: ${tools.length}`)
  console.log('')
  for (const tool of tools) console.log(`- ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
  console.log('')
  console.log('把上面与写入相关的那几个名字填进 skills/*/references/harness.md 的能力表。')
}

// `--url` 优先：显式端点不依赖 mcp.json，避免「连到配置里另一台、却报成功」。
let server
if (overrideUrl) {
  server = {
    name: overrideUrl,
    transport: 'streamable-http',
    url: overrideUrl,
    headers: parseHeaders(overrideHeaders),
  }
} else {
  if (!existsSync(configPath)) die(`找不到 MCP 配置：${configPath}（用 --config 或 --url 指定）`)
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    die(`MCP 配置不是合法 JSON：${err.message}`)
  }
  const servers = Array.isArray(config?.servers) ? config.servers : []
  server =
    servers.find((item) => item?.name === wantServer && item?.enabled !== false) ??
    servers.find((item) => item?.enabled !== false)
  if (!server) die(`配置里没有启用的 MCP server（找过「${wantServer}」）`)
  // 命令行 header 补充配置里的 header（同名以命令行为准）。
  const extra = parseHeaders(overrideHeaders)
  if (Object.keys(extra).length) server = { ...server, headers: { ...(server.headers ?? {}), ...extra } }
}

// —— streamable-http 分支：先于 stdio 处理，不需要子进程 ——
// 用 node:http/https 的 agent:false（不复用连接），拿到的 socket 随响应关闭，
// 因此结尾可以直接 process.exit；用 fetch(undici) 会在 Windows 上撞
// UV_HANDLE_CLOSING 断言。
if (server.transport === 'streamable-http') {
  if (!server.url) die(`server「${server.name}」没有 url`)
  const url = new URL(server.url)
  const pick = url.protocol === 'https:' ? httpsRequest : httpRequest
  const state = { sessionId: null }
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(server.headers ?? {}),
  }
  let nextId = 1

  const post = (body) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      const headers = {
        ...baseHeaders,
        'content-length': String(payload.length),
        ...(state.sessionId ? { 'mcp-session-id': state.sessionId } : {}),
      }
      const req = pick(url, { method: 'POST', headers, agent: false }, (res) => {
        const sid = res.headers['mcp-session-id']
        if (sid) state.sessionId = Array.isArray(sid) ? sid[0] : sid
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}${text ? ` — ${text.slice(0, 300)}` : ''}`))
            return
          }
          resolve({ text, contentType: String(res.headers['content-type'] ?? '') })
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`等 MCP 响应超时（${timeoutMs}ms）`)))
      req.on('error', reject)
      req.end(payload)
    })

  const rpc = async (method, params, isNotification = false) => {
    const body = { jsonrpc: '2.0', method }
    if (!isNotification) body.id = nextId++
    if (params) body.params = params
    const { text, contentType } = await post(body)
    if (isNotification) return null
    const messages = contentType.includes('text/event-stream')
      ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).map((line) => JSON.parse(line))
      : [JSON.parse(text)]
    for (const message of messages) {
      if (message.id === undefined) continue
      if (message.error) throw new Error(message.error.message ?? JSON.stringify(message.error))
      if (message.result !== undefined) return message.result
    }
    throw new Error('响应里没有匹配的 result')
  }

  const timer = setTimeout(() => die(`等 MCP 响应超时（${timeoutMs}ms）`), timeoutMs)
  try {
    const info = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe-mcp-tools', version: '1.0.0' },
    })
    await rpc('notifications/initialized', null, true)
    const listed = await rpc('tools/list', {})
    clearTimeout(timer)
    printReport(server, info, listed)
    process.exit(0)
  } catch (err) {
    clearTimeout(timer)
    die(err.message)
  }
}

if (server.transport && server.transport !== 'stdio') {
  die(`只支持 stdio 与 streamable-http，当前是「${server.transport}」`)
}
if (!server.command) die(`server「${server.name}」没有 command`)

const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ...(server.env ?? {}) },
  ...(server.cwd ? { cwd: server.cwd } : {}),
})

const pending = new Map()
let nextId = 1
let stderrTail = ''

const send = (message) => {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })

const settle = (message) => {
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
  else entry.resolve(message.result)
}

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue // 非 JSON 行（日志等）忽略
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) settle(message)
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-2000)
})

const timer = setTimeout(() => {
  die(`等 MCP 响应超时（${timeoutMs}ms）。server stderr 末段：\n${stderrTail || '(空)'}`)
}, timeoutMs)

const finish = (code = 0) => {
  clearTimeout(timer)
  try {
    child.stdin.end()
    child.kill()
  } catch {
    /* 关不掉也不影响结果 */
  }
  process.exit(code)
}

try {
  const info = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe-mcp-tools', version: '1.0.0' },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const listed = await request('tools/list', {})
  printReport(server, info, listed)
  finish(0)
} catch (err) {
  die(`${err.message}\nserver stderr 末段：\n${stderrTail || '(空)'}`)
}
