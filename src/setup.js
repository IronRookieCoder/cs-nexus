import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildListArgs, buildNpxArgs, createInstallPlan } from "./install-plan.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(packageRoot, "package.json");

export async function runCli(argv, io = defaultIo()) {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h"].includes(command)) {
    io.log(helpText());
    return;
  }
  if (["--version", "-v", "version"].includes(command)) {
    const packageJson = JSON.parse(await io.readFile(packageJsonPath, "utf8"));
    io.log(packageJson.version);
    return;
  }
  if (command !== "setup") {
    throw new Error(`未知命令：${command}\n\n${helpText()}`);
  }
  const options = parseSetupArgs(rest);
  return setup(options, io);
}

export async function setup(options, io = defaultIo()) {
  const configPath = options.config ?? path.join(packageRoot, "cs-nexus.yaml");
  const config = await loadConfig(configPath);
  const configuredAgent = options.agent ?? config.installation.agent;
  const agent = configuredAgent === "auto" ? detectAgent(io) : configuredAgent;
  const scope = options.scope ?? config.installation.scope;
  const plan = createInstallPlan(config, { agent, scope });

  io.log(`检测到 Agent：${agent}`);
  io.log(`安装范围：${scope === "global" ? "全局" : "当前项目"}`);
  const policyPath = policyConfigPath(scope, io);
  io.log(`策略配置：${policyPath}`);
  io.log(formatPlan(plan, io));

  if (options.dryRun) {
    io.log("Dry run 完成，未执行任何安装。 ");
    return plan;
  }

  if (!options.yes) {
    const approved = await io.confirm("以上操作将安装 Skill，是否继续？ [y/N] ");
    if (!approved) {
      io.log("已取消，未修改环境。");
      return plan;
    }
  }

  for (const step of plan.steps) {
    if (step.type === "agent-skill") {
      const [executable, ...args] = npxInvocation(buildNpxArgs(step, agent), io);
      runChecked(io, executable, args);
    } else if (step.type === "command") {
      io.log(`外部安装器 ${step.reference} 即将执行：${renderCommand(step.command)}`);
      if (!options.yes) {
        const approved = await io.confirm("是否授权执行该外部安装器？ [y/N] ");
        if (!approved) throw new Error(`未授权外部安装器：${step.reference}`);
      }
      runChecked(io, step.command[0], step.command.slice(1));
      for (const verify of step.verify) runChecked(io, verify[0], verify.slice(1));
    }
  }

  const [listExecutable, ...listArgs] = npxInvocation(buildListArgs(scope, agent), io);
  const installed = runCapturedJson(io, listExecutable, listArgs);
  verifyInstalledSkills(plan, installed);
  await persistPolicyConfig(config.configPath, policyPath, io);
  if (plan.manual.length > 0) {
    io.log("Agent Skill 已安装；仍有外部能力需要按上方官方指南手动完成。");
  } else {
    io.log("Ready.");
  }
  return plan;
}

export function policyConfigPath(scope, io = defaultIo()) {
  const base = scope === "project" ? io.cwd : io.home;
  return path.join(base, ".cs-nexus", "cs-nexus.yaml");
}

export function verifyInstalledSkills(plan, installed) {
  if (!Array.isArray(installed)) {
    throw new Error("skills list 返回的 JSON 必须是数组");
  }
  const installedNames = new Set(installed.map((item) => item?.name).filter(Boolean));
  const expectedNames = [...new Set(plan.agentSkills.flatMap((group) => group.skills))];
  const missing = expectedNames.filter((name) => !installedNames.has(name));
  if (missing.length > 0) {
    throw new Error(`安装验证失败，缺少 Skill：${missing.join(", ")}`);
  }
}

export function detectAgent(io = defaultIo()) {
  const explicit = io.env.CS_NEXUS_AGENT;
  if (explicit) return explicit;
  if (io.env.CODEX_HOME || io.env.CODEX_THREAD_ID) return "codex";
  if (io.env.CLAUDE_CODE || io.env.CLAUDECODE) return "claude-code";

  const projectCandidates = [
    [".codex", "codex"],
    [".claude", "claude-code"],
    [".cursor", "cursor"]
  ].filter(([directory]) => io.exists(path.join(io.cwd, directory)));
  if (projectCandidates.length === 1) return projectCandidates[0][1];

  const homeCandidates = [
    [".codex", "codex"],
    [".claude", "claude-code"],
    [".cursor", "cursor"]
  ].filter(([directory]) => io.exists(path.join(io.home, directory)));
  if (homeCandidates.length === 1) return homeCandidates[0][1];

  throw new Error("无法唯一识别 Agent，请使用 --agent codex（或其他 skills CLI Agent 名称）明确指定");
}

export function parseSetupArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--global") options.scope = "global";
    else if (argument === "--project") options.scope = "project";
    else if (["--config", "--agent"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`${argument} 缺少参数`);
      options[argument.slice(2)] = value;
    } else {
      throw new Error(`未知 setup 参数：${argument}`);
    }
  }
  return options;
}

function formatPlan(plan, io) {
  const lines = ["将执行以下操作："];
  for (const step of plan.steps) {
    if (step.type === "agent-skill") {
      lines.push(`- ${renderCommand(npxInvocation(buildNpxArgs(step, plan.agent), io))}`);
    } else if (step.type === "command") {
      lines.push(`- [需单独授权] ${renderCommand(step.command)}`);
      for (const verify of step.verify) lines.push(`  - 验证：${renderCommand(verify)}`);
    } else {
      lines.push(`- [需手动操作] ${step.reference}: ${step.url}`);
      for (const action of step.actions) lines.push(`  - ${action}`);
    }
  }
  return lines.join("\n");
}

function runChecked(io, executable, args) {
  const result = io.spawn(executable, args, { stdio: "inherit", shell: false });
  if (result.error) throw new Error(`无法执行 ${executable}：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`命令执行失败（退出码 ${String(result.status)}）：${renderCommand([executable, ...args])}`);
  }
}

function runCapturedJson(io, executable, args) {
  const result = io.spawn(executable, args, { encoding: "utf8", shell: false });
  if (result.error) throw new Error(`无法执行 ${executable}：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`命令执行失败（退出码 ${String(result.status)}）：${renderCommand([executable, ...args])}`);
  }
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch (error) {
    throw new Error(`无法解析 Skill 安装验证结果：${error.message}`);
  }
}

async function persistPolicyConfig(sourcePath, destinationPath, io) {
  const source = await io.readFile(sourcePath, "utf8");
  await io.mkdir(path.dirname(destinationPath), { recursive: true });
  await io.writeFile(destinationPath, source, "utf8");
}

function npxInvocation(args, io) {
  const platform = io.platform ?? process.platform;
  if (platform !== "win32") return ["npx", ...args];

  const execPath = io.execPath ?? process.execPath;
  const npxCli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return [execPath, npxCli, ...args];
}

function renderCommand(command) {
  return command.map((part) => (/^[\w./:@\\-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

function helpText() {
  return `用法：
  cs-nexus setup [--config <path>] [--agent <name>] [--global|--project] [--dry-run] [--yes]
  cs-nexus --version

setup 默认读取随包提供的 cs-nexus.yaml，展示完整安装计划并在执行前请求确认。`;
}

function defaultIo() {
  return {
    env: process.env,
    platform: process.platform,
    execPath: process.execPath,
    cwd: process.cwd(),
    home: os.homedir(),
    exists: existsSync,
    spawn: spawnSync,
    readFile,
    writeFile,
    mkdir,
    log: console.log,
    async confirm(question) {
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await terminal.question(question);
        return /^(y|yes)$/i.test(answer.trim());
      } finally {
        terminal.close();
      }
    }
  };
}
