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
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const asJson = argv.includes('--json')
const configPath = argOf('--config', path.join(os.homedir(), '.dsh', 'mcp.json'))
const wantServer = argOf('--server', 'obsidian')
const timeoutMs = Number(argOf('--timeout', '20000')) || 20000

const die = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(configPath)) die(`找不到 MCP 配置：${configPath}（用 --config 指定）`)
let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (err) {
  die(`MCP 配置不是合法 JSON：${err.message}`)
}
const servers = Array.isArray(config?.servers) ? config.servers : []
const server =
  servers.find((item) => item?.name === wantServer && item?.enabled !== false) ??
  servers.find((item) => item?.enabled !== false)
if (!server) die(`配置里没有启用的 MCP server（找过「${wantServer}」）`)
if (server.transport && server.transport !== 'stdio') {
  die(`只支持 stdio 传输，当前是「${server.transport}」`)
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
  const tools = (listed?.tools ?? []).map((tool) => ({
    name: tool.name,
    description: String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 120),
  }))

  if (asJson) {
    console.log(JSON.stringify({
      server: server.name,
      serverVersion: info?.serverInfo?.version ?? null,
      tools,
    }, null, 2))
  } else {
    console.log(`server: ${server.name}${info?.serverInfo?.version ? ` ${info.serverInfo.version}` : ''}`)
    console.log(`tools: ${tools.length}`)
    console.log('')
    for (const tool of tools) console.log(`- ${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
    console.log('')
    console.log('把上面与写入相关的那几个名字填进 skills/*/references/harness.md 的能力表。')
  }
  finish(0)
} catch (err) {
  die(`${err.message}\nserver stderr 末段：\n${stderrTail || '(空)'}`)
}
