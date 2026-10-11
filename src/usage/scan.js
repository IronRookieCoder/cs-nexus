import path from "node:path";
import { extractClaudeUsage } from "./claude-code.js";
import { extractCodexUsage } from "./codex.js";
import { createDefaultIo } from "../io.js";

export async function scanUsage({
  claudeProjectsDir, codexSessionsDir, statePath, archiveRoot, skillRoots = [], keepNames = null,
  io = createDefaultIo()
}) {
  const state = await loadState(statePath, io);
  const usage = new Map();
  const discoveredProjects = new Set();
  let skippedLines = 0;
  const agents = {
    claudeCode: io.exists(claudeProjectsDir),
    codex: io.exists(codexSessionsDir)
  };

  const addUsage = (fileResult) => {
    for (const [name, count] of Object.entries(fileResult.counts)) {
      const entry = usage.get(name) ?? { count: 0, lastUsedAt: null };
      entry.count += count;
      const lastUsedAt = fileResult.lastUsed[name];
      if (lastUsedAt && (!entry.lastUsedAt || lastUsedAt > entry.lastUsedAt)) entry.lastUsedAt = lastUsedAt;
      usage.set(name, entry);
    }
    for (const cwd of fileResult.cwds ?? []) discoveredProjects.add(cwd);
  };

  const claudeFiles = agents.claudeCode
    ? await listFiles(claudeProjectsDir, (name) => name.endsWith(".jsonl"), io)
    : [];
  for (const file of claudeFiles) {
    const outcome = await scanFile({ file, state, parse: extractClaudeUsage, options: { archiveRoot }, keepNames, io });
    skippedLines += outcome.skippedLines;
    addUsage(outcome.parsed);
  }

  const codexFiles = agents.codex
    ? await listFiles(codexSessionsDir, (name) => /^rollout-.*\.jsonl$/.test(name), io)
    : [];
  for (const file of codexFiles) {
    const outcome = await scanFile({
      file, state, parse: extractCodexUsage, options: { roots: skillRoots, archiveRoot }, keepNames, io
    });
    skippedLines += outcome.skippedLines;
    addUsage(outcome.parsed);
  }

  await saveState(statePath, state, io);
  return { usage, agents, discoveredProjects: [...discoveredProjects], skippedLines };
}

async function scanFile({ file, state, parse, options, keepNames, io }) {
  let info;
  try {
    info = await io.stat(file);
  } catch {
    return { skippedLines: 0, parsed: { counts: {}, lastUsed: {}, cwds: [] } };
  }
  const cursor = state.files[file];
  if (cursor && cursor.mtimeMs === info.mtimeMs && cursor.size === info.size) {
    return { skippedLines: 0, parsed: { counts: cursor.counts, lastUsed: cursor.lastUsed, cwds: cursor.cwds } };
  }

  let source;
  try {
    source = await io.readFile(file, "utf8");
  } catch {
    return { skippedLines: 0, parsed: { counts: {}, lastUsed: {}, cwds: [] } };
  }
  const lines = [];
  let skippedLines = 0;
  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      skippedLines += 1; // 单行损坏跳过并计数（spec §8）
    }
  }

  const parsed = parse(lines, options);
  const filtered = keepNames
    ? {
        counts: Object.fromEntries(Object.entries(parsed.counts).filter(([name]) => keepNames.has(name))),
        lastUsed: Object.fromEntries(Object.entries(parsed.lastUsed).filter(([name]) => keepNames.has(name))),
        cwds: parsed.cwds
      }
    : parsed;
  // 游标语义：重扫即替换，绝不累加（spec §4.6）
  state.files[file] = { mtimeMs: info.mtimeMs, size: info.size, counts: filtered.counts, lastUsed: filtered.lastUsed, cwds: filtered.cwds };
  return { skippedLines, parsed: filtered };
}

async function listFiles(root, filter, io) {
  const result = [];
  const entries = await io.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full, filter, io));
    else if (entry.isFile() && filter(entry.name)) result.push(full);
  }
  return result;
}

async function loadState(statePath, io) {
  const source = await io.readFile(statePath, "utf8").catch(() => null);
  if (!source) return { files: {} };
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return { files: parsed.files };
    }
  } catch {
    // 状态损坏 → 重新开始（spec §8）
  }
  return { files: {} };
}

async function saveState(statePath, state, io) {
  await io.mkdir(path.dirname(statePath), { recursive: true });
  await io.writeFile(statePath, JSON.stringify(state), "utf8");
}
