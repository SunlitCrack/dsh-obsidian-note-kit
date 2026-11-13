// dsh-kb — Host half.
//
// Reads the active local Obsidian vault and exposes a narrow HTTP API to the
// browser half. Every path is resolved below the selected vault root.

import path from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";

import { VaultStore } from "../core/store.js";
import { Indexer } from "../core/indexer.js";
import { KnowledgeBase } from "../core/kb.js";
import { registerKbTools } from "./tools.js";
import { installKbHooks } from "./capture-hook.js";
import { installKbCommand } from "./commands.js";

const API = "/api/dsh-kb";
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 32000;
const MAX_CONTEXT_FILES = 80;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_RESULTS = 100;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"]
]);

function appDataPath() {
  return process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Roaming");
}

function readObsidianVaults() {
  const configPath = path.join(appDataPath(), "obsidian", "obsidian.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return Object.values(raw?.vaults || {}).filter((item) => item && typeof item.path === "string");
  } catch {
    return [];
  }
}

function resolveVaultPath() {
  const configured = process.env.OBSIDIAN_VAULT_PATH?.trim();
  if (configured && existsSync(configured) && statSync(configured).isDirectory()) return path.resolve(configured);

  const vaults = readObsidianVaults();
  const openVault = vaults.find((item) => item.open && existsSync(item.path));
  if (openVault) return path.resolve(openVault.path);

  const newest = [...vaults]
    .filter((item) => existsSync(item.path))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  return newest ? path.resolve(newest.path) : null;
}

let vaultRoot = resolveVaultPath();

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(value);
}

function ensureVault() {
  if (!vaultRoot || !existsSync(vaultRoot) || !statSync(vaultRoot).isDirectory()) {
    throw new Error("没有找到 Obsidian 仓库，请设置 OBSIDIAN_VAULT_PATH");
  }
  return realpathSync(vaultRoot);
}

// ---- knowledge base (whole-vault, indexed in place) ----------------------
// One service per resolved vault root, rebuilt if the vault is switched.
// NOTE: VaultStore.init() is deliberately NOT called — that would create the
// legacy cardian sections (Cards/Memory/Repos), which dsh-kb does not use.
let kbService = null;

function kb() {
  const root = ensureVault();
  if (!kbService || kbService.root !== root) {
    const store = new VaultStore(root);
    const indexer = new Indexer(store, { listFiles: () => store.allFiles() });
    kbService = new KnowledgeBase({ store, indexer });
  }
  return kbService;
}

function relativePath(raw, { mustExist = true } = {}) {
  const root = ensureVault();
  const decoded = decodeURIComponent(String(raw || "")).replace(/^[/\\]+/, "");
  const absolute = path.resolve(root, decoded);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("路径超出 Obsidian 仓库范围");
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.some((part) => part === ".obsidian" || part.startsWith("."))) throw new Error("隐藏目录不开放访问");
  if (!existsSync(absolute)) {
    if (mustExist) throw new Error("文件或目录不存在");
    const parent = path.dirname(absolute);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error("目标文件夹不存在");
    const realParent = realpathSync(parent);
    const parentRelative = path.relative(root, realParent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new Error("路径超出 Obsidian 仓库范围");
    return { relative: relative.replace(/\\/g, "/"), absolute };
  }
  const realAbsolute = realpathSync(absolute);
  const realRelative = path.relative(root, realAbsolute);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("路径超出 Obsidian 仓库范围");
  return { relative: realRelative.replace(/\\/g, "/"), absolute: realAbsolute };
}

function readTree(relative) {
  const { absolute } = relativePath(relative);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error("目录不存在");
  const entries = readdirSync(absolute, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = path.relative(ensureVault(), path.join(absolute, entry.name)).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: childRelative, kind: "directory" });
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) || IMAGE_TYPES.has(ext)) {
      files.push({ name: entry.name, path: childRelative, kind: IMAGE_TYPES.has(ext) ? "image" : "file", ext });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { path: String(relative || ""), dirs, files };
}

function readContext(relative) {
  const target = relativePath(relative || "");
  const targetStat = statSync(target.absolute);
  const files = [];
  let usedChars = 0;
  let truncated = false;

  const addTextFile = (absolute, fileRelative) => {
    if (files.length >= MAX_CONTEXT_FILES) {
      truncated = true;
      return;
    }
    const stat = statSync(absolute);
    if (stat.size > MAX_NOTE_BYTES) {
      truncated = true;
      return;
    }
    const raw = readFileSync(absolute, "utf8");
    const remaining = MAX_CONTEXT_CHARS - usedChars;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const content = raw.slice(0, remaining);
    if (content.length < raw.length) truncated = true;
    usedChars += content.length;
    files.push({ path: fileRelative, content });
  };

  const walk = (directory) => {
    if (files.length >= MAX_CONTEXT_FILES || usedChars >= MAX_CONTEXT_CHARS) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        if (files.length >= MAX_CONTEXT_FILES || usedChars >= MAX_CONTEXT_CHARS) return;
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const fileRelative = path.relative(ensureVault(), absolute).replace(/\\/g, "/");
      addTextFile(absolute, fileRelative);
    }
  };

  if (targetStat.isDirectory()) {
    walk(target.absolute);
  } else if (TEXT_EXTENSIONS.has(path.extname(target.absolute).toLowerCase())) {
    addTextFile(target.absolute, target.relative);
  } else {
    return { path: target.relative, kind: "file", files: [], truncated: false, content: `附件文件：${target.relative}\n当前只读取 Markdown 和文本文件内容。` };
  }

  const content = files.map((file) => `### ${file.path}\n${file.content}`).join("\n\n");
  return {
    path: target.relative,
    kind: targetStat.isDirectory() ? "directory" : "file",
    files: files.map((file) => file.path),
    truncated,
    content: content || `路径：${target.relative || "仓库根目录"}\n没有找到可读取的 Markdown 或文本文件。`
  };
}

function searchVault(rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) return { query: "", results: [], truncated: false };
  const normalized = query.toLocaleLowerCase("zh-CN");
  const results = [];
  let scannedFiles = 0;
  let truncated = false;

  const walk = (directory) => {
    if (results.length >= MAX_SEARCH_RESULTS || scannedFiles >= MAX_SEARCH_FILES) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        if (truncated) return;
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      scannedFiles += 1;
      const relative = path.relative(ensureVault(), absolute).replace(/\\/g, "/");
      const nameMatch = entry.name.toLocaleLowerCase("zh-CN").includes(normalized);
      let excerpt = "";
      let lineNumber = 0;
      try {
        const stat = statSync(absolute);
        if (stat.size <= MAX_NOTE_BYTES) {
          const content = readFileSync(absolute, "utf8");
          const lines = content.split(/\r?\n/);
          const matchIndex = lines.findIndex((line) => line.toLocaleLowerCase("zh-CN").includes(normalized));
          if (matchIndex >= 0) {
            lineNumber = matchIndex + 1;
            excerpt = lines[matchIndex].trim().slice(0, 160);
          }
        }
      } catch {
        continue;
      }
      if (!nameMatch && !excerpt) continue;
      results.push({ name: entry.name, path: relative, kind: "file", lineNumber, excerpt });
      if (results.length >= MAX_SEARCH_RESULTS) {
        truncated = true;
        return;
      }
    }
  };

  walk(ensureVault());
  return { query, results, truncated };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_NOTE_BYTES) {
        reject(new Error("笔记超过 4 MB，暂不支持保存"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function register(serverCtx, route, handler) {
  return serverCtx.webServer.register({ kind: "exact", path: route, handler });
}

function routeHandler(req, res, action) {
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  Promise.resolve().then(() => action(req, res)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    json(res, message.includes("范围") || message.includes("隐藏") ? 403 : 400, { error: message });
  });
}

// Cordis 插件契约：必须显式声明 inject。
// 这个 cordis 版本是**严格 inject**：没声明就访问 ctx.<service> 会直接抛
// `cannot get property "X" without inject`，而这发生在 apply() 期间 →
// 整棵插件树加载失败 → DSH 启动不起来（2026-09-14 实际踩到）。
// webServer 走动态 ctx.inject(['webServer']) 无需静态声明；tools 必须静态声明。
export const name = "dsh-kb";
export const inject = ["tools"];

/**
 * 读插件配置（cordis 会把 profile 里的 config 挂在 fiber 上）。
 *
 * 只认少数几个开关，且全部默认开启 —— 用户要静音时写 `captureNudge: false`
 * 即可，不需要卸载插件。读不到就当空配置，绝不因为配置形状不对而抛。
 */
function kbPluginOptions(ctx) {
  try {
    const candidates = [ctx?.config, ctx?.fiber?.config, ctx?.scope?.config];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object") return candidate;
    }
  } catch {
    /* 读取失败按无配置处理 */
  }
  return {};
}

export function apply(ctx) {
  console.log(`[dsh-kb] apply(): host half loading (vault=${vaultRoot || "unresolved"})`);
  ctx.inject(["webServer"], (serverCtx) => {
    const disposers = [];

    disposers.push(register(serverCtx, `${API}/meta`, (_req, res) => routeHandler(_req, res, () => {
      vaultRoot = resolveVaultPath() || vaultRoot;
      if (!vaultRoot || !existsSync(vaultRoot)) return json(res, 200, { configured: false, vault: null });
      return json(res, 200, { configured: true, vault: { name: path.basename(vaultRoot), path: vaultRoot } });
    })));

    disposers.push(register(serverCtx, `${API}/tree`, (req, res) => routeHandler(req, res, () => {
      const url = new URL(req.url || `${API}/tree`, "http://localhost");
      return json(res, 200, readTree(url.searchParams.get("path") || ""));
    })));

    disposers.push(register(serverCtx, `${API}/search`, (req, res) => routeHandler(req, res, () => {
      const url = new URL(req.url || `${API}/search`, "http://localhost");
      return json(res, 200, searchVault(url.searchParams.get("q") || ""));
    })));

    // ---- knowledge base (L0 / L1 / L2) -----------------------------------
    disposers.push(register(serverCtx, `${API}/knowledge/index`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/index`, "http://localhost");
      const limit = Number(url.searchParams.get("limit"));
      return json(res, 200, await kb().index({
        project: url.searchParams.get("project") || null,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {})
      }));
    })));

    disposers.push(register(serverCtx, `${API}/knowledge/search`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/search`, "http://localhost");
      const origin = url.searchParams.getAll("origin").filter(Boolean);
      const topK = Number(url.searchParams.get("topK"));
      return json(res, 200, await kb().search({
        query: url.searchParams.get("q") || "",
        project: url.searchParams.get("project") || null,
        origin: origin.length ? origin : null,
        includeWeb: url.searchParams.get("includeWeb") === "1",
        ...(url.searchParams.get("type") ? { type: url.searchParams.get("type") } : {}),
        ...(Number.isFinite(topK) && topK > 0 ? { topK } : {})
      }));
    })));

    disposers.push(register(serverCtx, `${API}/knowledge/read`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/read`, "http://localhost");
      const maxChars = Number(url.searchParams.get("maxChars"));
      return json(res, 200, await kb().read({
        path: url.searchParams.get("path") || "",
        maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 0
      }));
    })));

    // 洞察（面板「洞察」页）：标签云 / 体检 / 反链相关。
    disposers.push(register(serverCtx, `${API}/knowledge/tagcloud`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/tagcloud`, "http://localhost");
      return json(res, 200, await kb().tagCloud({ project: url.searchParams.get("project") || null }));
    })));

    disposers.push(register(serverCtx, `${API}/knowledge/doctor`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/doctor`, "http://localhost");
      return json(res, 200, await kb().doctor({ project: url.searchParams.get("project") || null }));
    })));

    disposers.push(register(serverCtx, `${API}/knowledge/links`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/links`, "http://localhost");
      const ref = url.searchParams.get("path") || "";
      const max = Number(url.searchParams.get("max")) || 20;
      const [links, related] = await Promise.all([
        kb().backlinks({ path: ref, max }),
        kb().related({ path: ref, max })
      ]);
      return json(res, 200, { path: links.path, backlinks: links.backlinks, related: related.related });
    })));

    // 链接图谱（面板「洞察」画图用）。
    disposers.push(register(serverCtx, `${API}/knowledge/graph`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/graph`, "http://localhost");
      const limit = Number(url.searchParams.get("limit"));
      return json(res, 200, await kb().linkGraph({
        project: url.searchParams.get("project") || null,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {})
      }));
    })));

    // 缺口清单：GET 列表 / POST resolve（add/resolve 由面板或 agent 工具发起；
    // 缺口文件在 Inbox 内，属于插件自有的暂存产物，不触发笔记改动审批）。
    disposers.push(register(serverCtx, `${API}/knowledge/gaps`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/gaps`, "http://localhost");
      if (req.method === "GET") {
        return json(res, 200, await kb().gapList({ project: url.searchParams.get("project") || null }));
      }
      if (req.method !== "POST") throw new Error("缺口接口只接受 GET / POST");
      const payload = JSON.parse(await readBody(req));
      const action = String(payload.action || "").toLowerCase();
      if (action === "resolve") {
        return json(res, 200, await kb().gapResolve({
          project: payload.project,
          id: payload.id,
          note: payload.note ?? null
        }));
      }
      throw new Error(`未知 action: ${payload.action}`);
    })));

    disposers.push(register(serverCtx, `${API}/file`, (req, res) => routeHandler(req, res, () => {
      const url = new URL(req.url || `${API}/file`, "http://localhost");
      const { relative, absolute } = relativePath(url.searchParams.get("path") || "");
      if (!TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) throw new Error("当前只支持 Markdown 或文本文件");
      const stat = statSync(absolute);
      if (stat.size > MAX_NOTE_BYTES) throw new Error("笔记超过 4 MB，暂不支持打开");
      return json(res, 200, { path: relative, name: path.basename(absolute), content: readFileSync(absolute, "utf8"), modifiedAt: stat.mtimeMs });
    })));

    disposers.push(register(serverCtx, `${API}/context`, (req, res) => routeHandler(req, res, () => {
      const url = new URL(req.url || `${API}/context`, "http://localhost");
      return json(res, 200, readContext(url.searchParams.get("path") || ""));
    })));

    disposers.push(register(serverCtx, `${API}/asset`, (req, res) => routeHandler(req, res, () => {
      const url = new URL(req.url || `${API}/asset`, "http://localhost");
      const { absolute } = relativePath(url.searchParams.get("path") || "");
      const type = IMAGE_TYPES.get(path.extname(absolute).toLowerCase());
      if (!type) throw new Error("附件类型不支持");
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(readFileSync(absolute));
    })));

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose?.();
    }, "dsh-kb: route lifecycle");
  });

  // Model tools are read-oriented; note writes use the connected Obsidian MCP.
  registerKbTools(ctx, kb);

  // Related note context is added only when a writing skill loads. The optional
  // capture nudge was removed because the four note skills own that workflow.
  try {
    const disposeHooks = installKbHooks(ctx, {
      getKb: kb,
      logger: ctx.logger ?? null,
      options: { skillContext: kbPluginOptions(ctx).skillContext !== false },
    });
    ctx.effect(() => () => {
      try {
        disposeHooks?.();
      } catch {}
    }, "dsh-kb: skill context");
  } catch (err) {
    console.log(`[dsh-kb] apply(): host hooks skipped: ${err?.message ?? err}`);
  }

  // `/kb` 斜杠命令：宿主原生命令面，不进模型消息、零 token。
  // 只暴露只读与低成本操作，写盘仍走工具 + 审批。
  try {
    const disposeCommand = installKbCommand(ctx, { getKb: kb, logger: ctx.logger ?? null });
    ctx.effect(() => () => {
      try {
        disposeCommand?.();
      } catch {}
    }, "dsh-kb: /kb command");
  } catch (err) {
    console.log(`[dsh-kb] apply(): /kb command skipped: ${err?.message ?? err}`);
  }

  // Minimal discovery contract. Note classification and writing rules belong to the four skills.
  // Dynamic inject keeps hosts without systemPrompt support loadable.
  ctx.inject(["systemPrompt"], (promptCtx) => {
    try {
      const service = promptCtx.systemPrompt;
      if (!service || typeof service.section !== "function") return;
      service.section({
        name: "dsh-kb:knowledge-base",
        order: 480,
        text: [
          "## 本地知识库（dsh-kb）",
          "",
          "需要检索本地知识时先用 `kb_find`，命中后用 `kb_read` 获取结构化正文。",
          "",
          "1. **来源可信的发现**：用 `kb_find` 搜索；默认允许 local/unlabeled，不包含 web/inferred。MCP search 不过滤 origin，也可能命中隐藏归档或派生索引。",
          "2. `kb_read` 返回笔记 frontmatter。MCP 的直接读取不按来源过滤；引用前核对 origin，web/inferred 内容要标清来源。",
          "3. 笔记类型、内容结构与手维护索引日志由四份笔记 skill 决定；dsh-kb 不替代这些规则。",
          "4. `kb_gap` 只用于维护结构化缺口清单；笔记正文的创建、修订、移动和撤销走 Obsidian MCP。读取 contentHash 后传 prevHash，误操作用 undo_write 撤销。",
          "5. 主题与界面设置不属于 dsh-kb 知识索引；按 DSH 适配层指定的文件操作方式处理。", 
        ].join("\n"),
      });
      // 注册走 promptCtx 作用域，随注入 fiber 释放，无需再包一层 effect。
      console.log("[dsh-kb] apply(): system prompt section registered");
    } catch (err) {
      console.log(`[dsh-kb] system prompt section skipped: ${err?.message ?? err}`);
    }
  });

  console.log("[dsh-kb] apply(): kb_* tools registered");
}
