import path from "node:path";
import { DEFAULT_ARCHIVING, loadCommandConfig } from "../config.js";
import { loadManifest, pinnedSkillNames } from "../archive.js";
import { listInstalledSkills } from "../skill-inventory.js";
import { scanUsage } from "../usage/scan.js";
import { createDefaultIo, defaultPaths } from "../io.js";

export function parseSkillUsageArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--config") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("--config 缺少参数");
      options.config = value;
    } else {
      throw new Error(`未知 skill-usage 参数：${argument}`);
    }
  }
  return options;
}

export async function runSkillUsageCommand(argv, io = createDefaultIo()) {
  const options = parseSkillUsageArgs(argv);
  const config = await loadCommandConfig(options.config, io);
  const archiving = config?.archiving ?? { ...DEFAULT_ARCHIVING };
  const paths = defaultPaths(io.home);

  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  const inventory = await listInstalledSkills({ roots: paths.skillRoots, io });
  const scan = await scanUsage({
    claudeProjectsDir: path.join(io.home, ".claude", "projects"),
    codexSessionsDir: path.join(io.home, ".codex", "sessions"),
    statePath: paths.statePath,
    archiveRoot: paths.archiveDir,
    skillRoots: paths.skillRoots,
    keepNames: new Set([...inventory.map((item) => item.name), ...manifest.archived.map((entry) => entry.name)]),
    io
  });
  const pinned = pinnedSkillNames([config].filter(Boolean));
  const rows = buildReportRows({ inventory, manifest, usage: scan.usage, pinned, archiving });

  const notes = [];
  if (!scan.agents.claudeCode) notes.push("未检测到 Claude Code");
  if (!scan.agents.codex) notes.push("未检测到 Codex");

  if (options.json) {
    io.log(JSON.stringify({ generatedAt: new Date().toISOString(), notes, skills: rows }, null, 2));
  } else {
    io.log(renderReport(rows, notes));
  }
  return { rows, notes };
}

export function buildReportRows({ inventory, manifest, usage, pinned, archiving, nowMs = Date.now() }) {
  const rows = [];
  for (const item of inventory) {
    const usageInfo = usage.get(item.name);
    rows.push({
      name: item.name,
      locations: item.locations,
      usageCount: usageInfo?.count ?? 0,
      lastUsedAt: usageInfo?.lastUsedAt ?? null,
      status: classifyUsage({ name: item.name, installedAt: item.installedAt, usageInfo, pinned, archiving, nowMs })
    });
  }
  for (const entry of manifest.archived) {
    if (rows.some((row) => row.name === entry.name)) continue;
    const usageInfo = usage.get(entry.name);
    rows.push({
      name: entry.name,
      locations: [{ path: path.dirname(entry.skillFile), kind: "dir" }],
      usageCount: usageInfo?.count ?? entry.usageCount ?? 0,
      lastUsedAt: usageInfo?.lastUsedAt ?? entry.lastUsedAt ?? null,
      status: "archived"
    });
  }
  return rows;
}

function classifyUsage({ name, installedAt, usageInfo, pinned, archiving, nowMs }) {
  if (pinned.has(name)) return "pinned";
  if (typeof installedAt === "number" && nowMs - installedAt < archiving.newSkillGraceDays * 86400000) {
    return "active"; // 新装豁免期（spec §6）
  }
  if (usageInfo?.lastUsedAt && nowMs - Date.parse(usageInfo.lastUsedAt) > archiving.unusedAfterDays * 86400000) {
    return "candidate";
  }
  if ((usageInfo?.count ?? 0) < archiving.minInvocations) return "candidate";
  return "active";
}

function renderReport(rows, notes) {
  const lines = [];
  if (notes.length > 0) lines.push(`注意：${notes.join("；")}`);
  lines.push(`skill                                     调用次数  最近使用                    状态`);
  for (const row of rows) {
    lines.push(`${row.name.padEnd(41)}${String(row.usageCount).padEnd(9)}  ${(row.lastUsedAt ?? "-").padEnd(27)}${row.status}`);
    const locations = row.locations
      .map((location) => (location.kind === "link" ? `${location.path} -> ${location.target ?? "?"}` : location.path))
      .join("; ");
    lines.push(`    位置：${locations}`);
  }
  return lines.join("\n");
}
