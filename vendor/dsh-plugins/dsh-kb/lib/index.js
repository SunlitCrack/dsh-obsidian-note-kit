// dsh-kb — Host half.
//
// Reads the active local Obsidian vault and exposes a narrow HTTP API to the
// browser half. Every path is resolved below the selected vault root.

import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";

import { VaultStore } from "../core/store.js";
import { Indexer } from "../core/indexer.js";
import { KnowledgeBase } from "../core/kb.js";
import { RepoWikiService } from "../core/repowiki.js";
import { registerKbTools } from "./tools.js";

const API = "/api/dsh-kb";
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 32000;
const MAX_CONTEXT_FILES = 80;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_RESULTS = 100;
const TRASH_DIR_NAME = ".dsh-trash";
const TRASH_MANIFEST_NAME = "index.json";
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
let wikiService = null;

function kb() {
  const root = ensureVault();
  if (!kbService || kbService.root !== root) {
    const store = new VaultStore(root);
    const indexer = new Indexer(store);
    kbService = new KnowledgeBase({ store, indexer });
    // RepoWiki 与知识库**共用同一份 store/indexer**：一份全库索引同时服务两者，
    // wiki 页面（type: wiki）也因此天然可被 kb_search 检索到。
    wikiService = new RepoWikiService(store, { indexer });
  }
  return kbService;
}

function wiki() {
  kb(); // 确保 store/indexer/wikiService 就绪
  return wikiService;
}

/** 概览页是派生页（落在 `<repo>/project-overview.md`）；GET 只读它、不刷新。 */
async function readOverviewBody(repo) {
  try {
    const note = await kb().store.read(`${String(repo)}/project-overview.md`);
    return note?.body ?? null;
  } catch {
    return null;
  }
}

/** 扫仓库/同步之后，让该 repo 项目的 L0 INDEX.md 跟上（wiki 页就是它的笔记）。 */
async function refreshRepoIndex(repoSlug) {
  if (!repoSlug) return null;
  try {
    return await kb().rebuildIndex(String(repoSlug));
  } catch {
    return null;
  }
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

function validateName(raw, label) {
  const name = String(raw || "").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`${label}名称不合法`);
  }
  if (name.startsWith(".")) throw new Error("隐藏文件或文件夹不开放操作");
  return name;
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

function writeAtomically(filePath, content) {
  const tempPath = `${filePath}.dsh-tmp-${process.pid}`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

function ensureTrashRoot() {
  const root = ensureVault();
  const trashRoot = path.join(root, TRASH_DIR_NAME);
  mkdirSync(trashRoot, { recursive: true });
  return trashRoot;
}

function readTrashManifest() {
  const manifestPath = path.join(ensureTrashRoot(), TRASH_MANIFEST_NAME);
  if (!existsSync(manifestPath)) return [];
  try {
    const payload = JSON.parse(readFileSync(manifestPath, "utf8"));
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function writeTrashManifest(entries) {
  writeAtomically(path.join(ensureTrashRoot(), TRASH_MANIFEST_NAME), JSON.stringify(entries, null, 2));
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
        rebuild: url.searchParams.get("rebuild") === "1",
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

    // 待审区（Inbox）：GET 列表 / POST 归库·合并·丢弃。
    // 面板上的点击本身就是人的显式同意，所以这里不再叠加 approval 弹窗；
    // 审批闸门只针对「agent 自己发起的改动」（kb_inbox 工具）。
    disposers.push(register(serverCtx, `${API}/knowledge/inbox`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/knowledge/inbox`, "http://localhost");
      if (req.method === "GET") {
        return json(res, 200, await kb().inboxList({ project: url.searchParams.get("project") || null }));
      }
      if (req.method !== "POST") throw new Error("待审区接口只接受 GET / POST");
      const payload = JSON.parse(await readBody(req));
      const action = String(payload.action || "").toLowerCase();
      if (action === "promote") {
        return json(res, 200, await kb().promote({
          path: payload.path,
          targetDir: payload.targetDir ?? null,
          note: payload.note ?? null
        }));
      }
      if (action === "merge") {
        return json(res, 200, await kb().mergeInto({
          staged: payload.path,
          into: payload.into,
          mode: payload.mode ?? "append",
          note: payload.note ?? null
        }));
      }
      if (action === "drop") {
        return json(res, 200, await kb().dropStaged({ path: payload.path, reason: payload.reason ?? null }));
      }
      throw new Error(`未知 action: ${payload.action}`);
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

    // 索引自愈（面板「洞察 · 体检」里的一键按钮）：只重写派生的 INDEX.md。
    disposers.push(register(serverCtx, `${API}/knowledge/reindex`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("重建索引接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      return json(res, 200, await kb().reindex({
        fixIndexes: payload.fixIndexes !== false,
        project: payload.project || null
      }));
    })));

    // ---- RepoWiki（面板「代码」页）---------------------------------------
    // 扫描/同步会直接在 vault 里建/改 wiki 页；面板上的点击本身就是人的显式
    // 同意，因此这里不叠 approval 弹窗（审批闸门只针对 agent 自己发起的动作）。
    disposers.push(register(serverCtx, `${API}/wiki/repos`, (req, res) => routeHandler(req, res, async () => {
      const service = wiki();
      return json(res, 200, { repos: await service.listRepos(), entries: await service.list() });
    })));

    disposers.push(register(serverCtx, `${API}/wiki/list`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/wiki/list`, "http://localhost");
      const repo = url.searchParams.get("repo") || null;
      if (!repo) return json(res, 200, { repos: await wiki().listRepos(), entries: await wiki().list() });
      return json(res, 200, { repo, entries: await wiki().list({ group: repo }) });
    })));

    // GET 只读已存在的概览页；POST 才刷新（写派生页 project-overview.md）。
    disposers.push(register(serverCtx, `${API}/wiki/overview`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/wiki/overview`, "http://localhost");
      const repo = url.searchParams.get("repo") || "";
      if (!repo) throw new Error("缺少 repo 参数");
      const service = wiki();
      if (req.method === "POST") {
        const result = await service.overview(repo);
        return json(res, 200, { ...result, body: await readOverviewBody(repo) });
      }
      if (req.method !== "GET") throw new Error("概览接口只接受 GET / POST");
      return json(res, 200, { repo, body: await readOverviewBody(repo) });
    })));

    // 代码图谱：节点补上 vault 内 rel，面板点击才能直接打开对应 wiki 页。
    disposers.push(register(serverCtx, `${API}/wiki/graph`, (req, res) => routeHandler(req, res, async () => {
      const url = new URL(req.url || `${API}/wiki/graph`, "http://localhost");
      const repo = url.searchParams.get("repo") || "";
      if (!repo) throw new Error("缺少 repo 参数");
      const service = wiki();
      const graph = await service.graph(repo);
      const relOf = new Map();
      for (const entry of await service.entries()) {
        if (entry.group === graph.repo && entry.frontmatter?.path) relOf.set(entry.frontmatter.path, entry.rel);
      }
      return json(res, 200, {
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, rel: relOf.get(node.path) ?? null }))
      });
    })));

    disposers.push(register(serverCtx, `${API}/wiki/scan`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("扫描接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const repoPath = String(payload.repoPath || "").trim();
      if (!repoPath) throw new Error("缺少 repoPath");
      const repoName = String(payload.repoName || "").trim() || path.basename(repoPath.replace(/[/\\]+$/, ""));
      const result = await wiki().ingest(repoPath, {
        repoName,
        ...(Number.isFinite(Number(payload.maxFiles)) && Number(payload.maxFiles) > 0
          ? { maxFiles: Number(payload.maxFiles) }
          : {})
      });
      return json(res, 200, { ...result, index: await refreshRepoIndex(result.repo) });
    })));

    disposers.push(register(serverCtx, `${API}/wiki/sync`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("同步接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const repoPath = String(payload.repoPath || "").trim();
      if (!repoPath) throw new Error("缺少 repoPath");
      const repoName = String(payload.repoName || "").trim() || path.basename(repoPath.replace(/[/\\]+$/, ""));
      const result = await wiki().sync(repoPath, {
        repoName,
        pruneOrphans: payload.pruneOrphans !== false,
        ...(Number.isFinite(Number(payload.maxFiles)) && Number(payload.maxFiles) > 0
          ? { maxFiles: Number(payload.maxFiles) }
          : {})
      });
      return json(res, 200, { ...result, index: await refreshRepoIndex(result.repo) });
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

    disposers.push(register(serverCtx, `${API}/save`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "PUT" && req.method !== "POST") throw new Error("保存接口只接受 PUT");
      const payload = JSON.parse(await readBody(req));
      const { relative, absolute } = relativePath(payload.path || "");
      if (!TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) throw new Error("当前只支持保存 Markdown 或文本文件");
      if (typeof payload.content !== "string") throw new Error("保存内容必须是文本");
      writeAtomically(absolute, payload.content);
      return json(res, 200, { ok: true, path: relative, modifiedAt: statSync(absolute).mtimeMs });
    })));

    disposers.push(register(serverCtx, `${API}/create-folder`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("新建文件夹接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const name = validateName(payload.name, "文件夹");
      const parent = relativePath(payload.parent || "");
      const target = relativePath(path.join(parent.relative, name), { mustExist: false });
      if (existsSync(target.absolute)) throw new Error("同名文件或文件夹已经存在");
      mkdirSync(target.absolute);
      return json(res, 201, { ok: true, path: target.relative, kind: "directory" });
    })));

    disposers.push(register(serverCtx, `${API}/create-note`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("新建笔记接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      let name = validateName(payload.name, "笔记");
      if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) name += ".md";
      const parent = relativePath(payload.parent || "");
      const target = relativePath(path.join(parent.relative, name), { mustExist: false });
      if (existsSync(target.absolute)) throw new Error("同名文件已经存在");
      writeAtomically(target.absolute, typeof payload.content === "string" ? payload.content : "");
      return json(res, 201, { ok: true, path: target.relative, name, kind: "file", content: typeof payload.content === "string" ? payload.content : "" });
    })));

    disposers.push(register(serverCtx, `${API}/rename`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("重命名接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const source = relativePath(payload.path || "");
      if (!source.relative) throw new Error("不能重命名仓库根目录");
      const name = validateName(payload.name, "名称");
      if (name === path.basename(source.absolute)) throw new Error("名称没有变化");
      const parent = path.relative(ensureVault(), path.dirname(source.absolute)).replace(/\\/g, "/");
      const target = relativePath(path.join(parent, name), { mustExist: false });
      if (existsSync(target.absolute)) throw new Error("同名文件或文件夹已经存在");
      const kind = statSync(source.absolute).isDirectory() ? "directory" : "file";
      renameSync(source.absolute, target.absolute);
      return json(res, 200, { ok: true, from: source.relative, path: target.relative, name, kind });
    })));

    disposers.push(register(serverCtx, `${API}/move`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("移动接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const source = relativePath(payload.source || "");
      if (!source.relative) throw new Error("不能移动仓库根目录");
      const destination = relativePath(payload.destination || "");
      if (!statSync(destination.absolute).isDirectory()) throw new Error("目标位置必须是文件夹");
      const sourceIsDirectory = statSync(source.absolute).isDirectory();
      const nested = path.relative(source.absolute, destination.absolute);
      if (sourceIsDirectory && nested && !nested.startsWith("..") && !path.isAbsolute(nested)) {
        throw new Error("不能把文件夹移动到自己或子文件夹内");
      }
      const targetAbsolute = path.join(destination.absolute, path.basename(source.absolute));
      if (existsSync(targetAbsolute)) throw new Error("目标位置已有同名文件或文件夹");
      renameSync(source.absolute, targetAbsolute);
      const movedPath = path.relative(ensureVault(), targetAbsolute).replace(/\\/g, "/");
      return json(res, 200, { ok: true, from: source.relative, path: movedPath, kind: sourceIsDirectory ? "directory" : "file" });
    })));

    disposers.push(register(serverCtx, `${API}/delete`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("删除接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const target = relativePath(payload.path || "");
      if (!target.relative) throw new Error("不能删除 Obsidian 仓库根目录");
      const targetIsDirectory = statSync(target.absolute).isDirectory();
      const undoId = randomUUID();
      const trashedName = `${undoId}--${path.basename(target.absolute)}`;
      const trashedAbsolute = path.join(ensureTrashRoot(), trashedName);
      renameSync(target.absolute, trashedAbsolute);
      const entries = readTrashManifest();
      entries.push({ id: undoId, originalPath: target.relative, trashedName, kind: targetIsDirectory ? "directory" : "file", deletedAt: Date.now() });
      try {
        writeTrashManifest(entries);
      } catch (error) {
        renameSync(trashedAbsolute, target.absolute);
        throw error;
      }
      return json(res, 200, { ok: true, path: target.relative, kind: targetIsDirectory ? "directory" : "file", undoId });
    })));

    disposers.push(register(serverCtx, `${API}/undo-delete`, (req, res) => routeHandler(req, res, async () => {
      if (req.method !== "POST") throw new Error("撤销删除接口只接受 POST");
      const payload = JSON.parse(await readBody(req));
      const undoId = String(payload.id || "").trim();
      if (!undoId) throw new Error("缺少撤销删除标识");
      const entries = readTrashManifest();
      const index = entries.findIndex((entry) => entry?.id === undoId);
      if (index === -1) throw new Error("找不到可恢复的删除记录");
      const entry = entries[index];
      const trashedName = path.basename(String(entry.trashedName || ""));
      if (!trashedName || trashedName !== entry.trashedName) throw new Error("回收站记录无效");
      const trashedAbsolute = path.join(ensureTrashRoot(), trashedName);
      if (!existsSync(trashedAbsolute)) throw new Error("回收站中的文件不存在");
      const target = relativePath(entry.originalPath || "", { mustExist: false });
      if (existsSync(target.absolute)) throw new Error("原位置已有同名文件或文件夹");
      renameSync(trashedAbsolute, target.absolute);
      entries.splice(index, 1);
      writeTrashManifest(entries);
      return json(res, 200, { ok: true, path: target.relative, kind: entry.kind });
    })));

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose?.();
    }, "dsh-kb: route lifecycle");
  });

  // 宿主 approval 服务：改「已有笔记」的动作（kb_inbox 的 merge/drop）走真审批弹窗。
  // 动态 inject：服务不存在时插件照常加载，工具层 fail-closed（拒绝改动并要求人工处理）。
  let approvalService = null;
  ctx.inject(["approval"], (approvalCtx) => {
    approvalService = approvalCtx.approval ?? null;
  });

  // Model-callable tools: kb_index / kb_search / kb_read / kb_capture / kb_inbox
  // + RepoWiki (kb_wiki_*). Registered lazily so the plugin still loads when no
  // vault is configured (the error surfaces per tool call instead of at load).
  registerKbTools(ctx, kb, { getApproval: () => approvalService, getWiki: wiki });

  // 系统提示词契约：让「先查库 → 用本地知识 → 任务后自动沉淀 → 记缺口」成为
  // agent 的默认动作，而不是靠它想起来。放在 PLAN_POLICY(500) 之前。
  // 动态 inject + try/catch：宿主没有 systemPrompt 服务（或被重复装配）时
  // 只降级为"没有这段提示词"，绝不拖垮 apply()。
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
          "你的长期知识库是一个 Obsidian vault，通过 `kb_*` 工具读写；**先查库，再回答**。",
          "",
          "1. **动手前先查库**：`kb_index`（L0，vault 顶级目录 = 项目，每个项目一张 `INDEX.md`）→ `kb_search`（L1，元数据 + 摘要）→ 只对真正要用的那几篇 `kb_read`（L2 正文）。不要盲扫全文。",
          "2. **只信 local**：`kb_search` 默认只召回 `origin: local`（你/用户验证过的知识）。`origin: web|inferred` 是外部抓取或推理产物，必须显式 `includeWeb` 才返回，引用时要说明来源、不要当既有事实。",
          "3. **任务后自动沉淀**：本次任务产生了值得复用的结论（排障过程 / 机制解释 / 参数与坑）时，用 `kb_capture` 落到 `<项目>/Inbox/`（项目 = vault 顶级目录；不确定就选最贴切的已有项目）。落之前先 `kb_search` 去重：命中已有笔记且只是补充 → `kb_inbox` merge（**需要用户批准**）；没有命中 → 新建卡片。",
          "4. **库里缺什么就记下来**：检索没命中、你不得不外部检索或自行推理时，`kb_gap({ action: 'add', project, question })` 记一条缺口；后来补齐了就 `action: 'resolve'` 勾掉。",
          "5. **改已有笔记必须先拿批准**：merge / revise / feedback / import 写盘都会弹审批；新知识一律先落 `Inbox`，不要直接改写别人的笔记。",
          "6. **索引失真时**：`kb_reindex({ fixIndexes: true })` 强制重建（只动派生的 `INDEX.md`）。`kb_doctor` 可体检断链/过期/重复/待审/缺口。",
          "7. **写盘分工（装了 Obsidian MCP 时）**：`mcp__obsidian__*` 只用来做 `kb_*` 做不到的事 —— ① 批量/结构性笔记操作：重命名笔记或标题并**重写全库 wikilink**、批量改 frontmatter、移动/删除、误操作回滚（`undo_write`）；② **非笔记件**：附件、图片、`.obsidian/` 配置、vault 之外的文件。",
          "8. **写盘按变更性质分档（不是按工具分）**：① 沉淀新知识、与已有笔记合并 → `kb_capture` + `kb_inbox` promote/merge；② **事实性就地修订**（把被新实测证伪的旧值改对：版本号、失效路径、已被推翻的结论）→ `kb_inbox({ action: 'revise', path, edits: [{ find, replace }], note })`，**需批准**，每个 find 必须正文唯一命中，**禁止借此自由重写或写入新知识**；③ **大段措辞 / 结构性重写**（换说法、重排章节、压缩扩写、改结论口径）→ 改法由用户定，你只出 diff 与候选方案，不自行决定；④ 重命名 / 移动 / 删除 / 批量改 frontmatter / 非笔记件 → 用 `mcp__obsidian__*`，收尾跑 `kb_reindex`。**不得用 MCP 的 `create_note|patch_note|append_note|replace_in_note` 替代 ①②③ 三条通道。**",
          "9. **沉淀即归库（Inbox 不是终点）**：`kb_capture` 落到 `<项目>/Inbox/` 只是**待审暂存**。写完必须立刻 `kb_inbox({ action: 'promote', path, targetDir })` 归到该项目**对应的分类目录**（`targetDir` 照该项目 `INDEX.md` / `00-索引.md` 的目录约定选，如 `插件生态/`、`本机环境/`、`操作记录/`）—— promote **不需要批准**，不要留在 Inbox 等用户来问。只有「要合并进已有笔记 / 冲突待裁决」才留在 Inbox 走批准。归库后若文件名不符合该目录的命名约定（如 `操作记录/` 要求 `YYYY-MM-DD-动作.md`），用 Obsidian MCP 的 `move_note` 改名（它会重写全库 wikilink），再 `kb_reindex`。",
        ].join("\n"),
      });
      // 注册走 promptCtx 作用域，随注入 fiber 释放，无需再包一层 effect。
      console.log("[dsh-kb] apply(): system prompt section registered");
    } catch (err) {
      console.log(`[dsh-kb] system prompt section skipped: ${err?.message ?? err}`);
    }
  });

  console.log("[dsh-kb] apply(): kb_index / kb_search / kb_read / kb_capture / kb_inbox / kb_wiki_* registered");
}
