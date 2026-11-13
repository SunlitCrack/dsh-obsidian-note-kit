#!/usr/bin/env node
// probe-mcp-tools.mjs 的自测：用本地 SSE mock 覆盖 streamable-http 分支。
//
// 为什么需要 mock：真实实现（Obsidian 的 Local REST API with MCP）要求 Obsidian
// 正在运行且插件已启用，CI 与多数开发机上都没有。这里复刻它的三个协议行为，
// 验证探测脚本本身：
//   1. initialize 用 text/event-stream 回包（data: 行携带 JSON-RPC，含 event:/id: 噪声行）；
//   2. 服务端下发 mcp-session-id，后续请求必须带回，否则 400；
//   3. 连不上时必须非零退出 —— 早期版本会把 --url 静默忽略、改连 mcp.json 里的
//      另一台 server 并报成功，这条断言就是防它复发。
//
//   node scripts/probe-mcp-tools.test.mjs
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const probe = path.join(here, 'probe-mcp-tools.mjs')

// 复刻 Local REST API with MCP v5.1.0 的 16 个 vault_* 工具名。
const TOOLS = [
  ['vault_read', 'Read a note'],
  ['vault_write', 'Create or overwrite a vault file'],
  ['vault_append', 'Append under a heading or block'],
  ['vault_patch', 'Patch a heading, block or frontmatter field'],
  ['vault_move', 'Move or rename and rewrite links'],
  ['vault_delete', 'Move a file to .trash'],
  ['vault_list', 'List files and folders'],
  ['vault_get_document_map', 'Headings, blocks and frontmatter with version'],
  ['search_simple', 'Simple search'],
  ['search_query', 'Structured search'],
  ['tag_list', 'List tags'],
  ['command_list', 'List commands'],
  ['command_execute', 'Run a command'],
  ['open_file', 'Open a file'],
  ['active_file', 'Get the active file'],
  ['periodic_notes', 'Periodic notes'],
].map(([name, description]) => ({ name, description }))

const fail = []
const ok = (message) => console.log(`✓ ${message}`)
const check = (condition, message) => (condition ? ok(message) : (fail.push(message), console.error(`✗ ${message}`)))

const sse = (message) => `event: message\nid: 1\ndata: ${JSON.stringify(message)}\n\n`

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }
    const sid = req.headers['mcp-session-id']
    if (message.method !== 'initialize' && sid !== 'mock-sess-1') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing or wrong mcp-session-id' }))
      return
    }
    if (message.id === undefined) {
      res.writeHead(202).end() // 通知无响应体
      return
    }
    if (message.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'mock-sess-1' })
      res.end(sse({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'obsidian-local-rest-api', version: '1.0.0' },
        },
      }))
      return
    }
    if (message.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } }))
  })
})

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [probe, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/mcp/`
console.log(`mock MCP: ${url}`)

const cfgPath = path.join(tmpdir(), `mock-mcp-http-${process.pid}.json`)
writeFileSync(cfgPath, JSON.stringify({
  servers: [{
    name: 'obsidian',
    transport: 'streamable-http',
    enabled: true,
    url,
    headers: { Authorization: 'Bearer test-key' },
  }],
}, null, 2))

try {
  // 1. 走 mcp.json：url + transport 都在配置里。
  const viaConfig = await run(['--config', cfgPath, '--json'])
  check(viaConfig.code === 0, `按 mcp.json 探测成功（exit=${viaConfig.code}）${viaConfig.code ? `\n${viaConfig.stderr}` : ''}`)
  let parsed = null
  try {
    parsed = JSON.parse(viaConfig.stdout)
  } catch {
    check(false, `--json 输出可解析：${viaConfig.stdout.slice(0, 200)}`)
  }
  check(parsed?.serverVersion === '1.0.0', `读到 serverInfo 版本（${parsed?.serverVersion}）`)
  check(parsed?.tools?.length === 16, `工具 16 个（${parsed?.tools?.length}）`)
  check(
    parsed?.tools?.some((tool) => tool.name === 'vault_patch') &&
      parsed?.tools?.some((tool) => tool.name === 'vault_get_document_map'),
    'vault_patch / vault_get_document_map 在清单里'
  )

  // 2. --url 直接指定端点：不读 mcp.json 也要通。这条防「--url 被忽略、偷偷连到
  //    配置里另一台 server 并报成功」。
  const viaUrl = await run(['--url', url, '--header', 'Authorization: Bearer test-key', '--json'])
  check(viaUrl.code === 0, `--url 探测成功（exit=${viaUrl.code}）${viaUrl.code ? `\n${viaUrl.stderr}` : ''}`)
  check(viaUrl.stdout.includes('"transport": "streamable-http"'), '--url 被识别为 streamable-http')

  // 3. 文本模式要标出传输方式。
  const text = await run(['--config', cfgPath])
  check(text.code === 0 && /streamable-http/.test(text.stdout), '文本模式标出 transport')
  check(text.stdout.includes('vault_write'), '文本模式列出 vault_write')

  // 4. 连不上必须非零退出，且给可读错误而不是堆栈。
  const dead = await run(['--url', 'http://127.0.0.1:1/mcp/', '--timeout', '3000'])
  check(dead.code !== 0 && dead.stderr.includes('✗'), `连不上时非零退出并报可读错误（exit=${dead.code}）`)
} finally {
  rmSync(cfgPath, { force: true })
  server.close()
}

console.log(fail.length ? `\n结果：${fail.length} 项失败` : '\n结果：全部通过')
process.exitCode = fail.length ? 1 : 0
