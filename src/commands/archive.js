import path from "node:path";
import process from "node:process";
import { DEFAULT_ARCHIVING, loadCommandConfig, loadConfig, resolveConfigPath } from "../config.js";
import { archiveSkills, loadManifest, pinnedSkillNames, restoreSkill } from "../archive.js";
import { listInstalledSkills } from "../skill-inventory.js";
import { scanUsage } from "../usage/scan.js";
import { createDefaultIo, defaultPaths } from "../io.js";
import { npxInvocation } from "../setup.js";

export function parseArchiveArgs(argv) {
  const options = { names: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.list = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (["--config", "--restore", "--to"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error(`${argument} 缺少参数`);
      options[argument.slice(2)] = value;
    } else if (argument.startsWith("-")) {
      throw new Error(`未知 archive 参数：${argument}`);
    } else {
      options.names.push(argument);
    }
  }
  return options;
}

export async function runArchiveCommand(argv, io = createDefaultIo(), deps = {}) {
  const options = parseArchiveArgs(argv);
  const paths = defaultPaths(io.home);

  if (options.list) return listEntries(options, paths, io);
  if (options.restore) return restoreOne(options, paths, io);
  return archiveMany(options, paths, io, deps);
}

async function listEntries(options, paths, io) {
  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  if (options.json) {
    io.log(JSON.stringify(manifest, null, 2));
  } else if (manifest.archived.length === 0) {
    io.log("归档区为空。");
  } else {
    for (const entry of manifest.archived) {
      io.log(`${entry.name}  归档于 ${entry.archivedAt ?? "未知时间"}  原调用 ${entry.usageCount ?? 0} 次`);
      io.log(`    ${entry.description ?? "（无描述）"}`);
    }
  }
  return manifest;
}

async function restoreOne(options, paths, io) {
  if (options.names.length > 0) throw new Error("--restore 不接受额外名称参数");
  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  const result = await restoreSkill({
    name: options.restore,
    targetDir: options.to ?? null,
    manifest,
    manifestPath: paths.manifestPath,
    archiveDir: paths.archiveDir,
    lockPath: paths.lockPath,
    io
  });
  if (result.status === "restored") {
    io.log(`已恢复 ${result.name} → ${result.restoredTo}`);
    if (result.lockRestored === false) {
      io.log("提示：skills lock 元数据未回写（快照缺失或版本不兼容）；如需 update 能力可重新安装。");
    }
  } else if (result.status === "no-origin") {
    io.log(`无法恢复 ${result.name}：${result.message}`);
    process.exitCode = 1;
  } else {
    io.log(`清单中没有 ${result.name}。`);
    process.exitCode = 1;
  }
  return result;
}

async function archiveMany(options, paths, io, deps) {
  if (options.names.length === 0) throw new Error("缺少要归档的 skill 名，用法见 cs-nexus --help");
  const config = await loadCommandConfig(options.config, io);
  const archiving = config?.archiving ?? { ...DEFAULT_ARCHIVING };
  if (!archiving.enabled) throw new Error("archiving 已在配置中禁用（archiving.enabled: false）");

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

  const configs = await collectKeepAliveConfigs({ config, discoveredProjects: scan.discoveredProjects, io });
  const pinned = pinnedSkillNames(configs);

  if (!options.yes) {
    const approved = await io.confirm(`将归档以下 skill：${options.names.join(", ")}，是否继续？ [y/N] `);
    if (!approved) {
      io.log("已取消，未做任何修改。");
      return { cancelled: true };
    }
  }

  const removeWithSkillsCli = deps.removeWithSkillsCli ?? createSkillsRemove(io);
  const { results } = await archiveSkills({
    names: options.names,
    inventory,
    usage: scan.usage,
    manifest,
    manifestPath: paths.manifestPath,
    archiveDir: paths.archiveDir,
    lockPath: paths.lockPath,
    pinned,
    io,
    removeWithSkillsCli
  });
  for (const result of results) {
    if (result.status === "archived") {
      io.log(`已归档 ${result.name}（清单已登记，动态加载可用）。`);
      for (const copy of result.differingCopies ?? []) {
        io.log(`  提示：副本内容与首份不一致，已按首份归档：${copy}`);
      }
    } else if (result.status === "refused") {
      io.log(`拒绝归档 ${result.name}：${result.reason}`);
      process.exitCode = 1;
    } else if (result.status === "already-archived") {
      io.log(`${result.name} 已在归档区，跳过。`);
    } else {
      io.log(`未找到已安装的 skill：${result.name}`);
      process.exitCode = 1;
    }
  }
  return { results };
}

async function collectKeepAliveConfigs({ config, discoveredProjects, io }) {
  const configs = [];
  const seen = new Set();
  const warnings = [];

  if (config) {
    configs.push(config);
    seen.add(config.configPath);
  }
  for (const project of discoveredProjects) {
    try {
      const resolved = resolveConfigPath({ cwd: project, env: {}, home: io.home, exists: io.exists });
      if (!resolved) continue;
      const loaded = await loadConfig(resolved);
      if (seen.has(loaded.configPath)) continue;
      seen.add(loaded.configPath);
      configs.push(loaded);
    } catch (error) {
      warnings.push(`${project}：${error.message}`); // 单项目配置损坏 → 跳过并提示（spec §4.4）
    }
  }
  const globalPath = path.join(io.home, ".cs-nexus", "cs-nexus.yaml");
  if (io.exists(globalPath) && !seen.has(globalPath)) {
    try {
      configs.push(await loadConfig(globalPath));
    } catch (error) {
      warnings.push(`全局配置：${error.message}`);
    }
  }

  for (const warning of warnings) io.log(`提示：跳过一份配置（${warning}）`);
  return configs;
}

function createSkillsRemove(io) {
  return async (name) => {
    const [executable, ...args] = npxInvocation(["--yes", "skills", "remove", name, "--global", "--yes"], io);
    const result = io.spawn(executable, args, { stdio: "ignore", shell: false });
    if (result.error || (result.status !== 0 && result.status !== null)) {
      io.log(`警告：skills remove 清理 ${name} 失败（lock 残留可稍后手动清理）。`);
    }
  };
}
