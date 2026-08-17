import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { detectAgent, parseSetupArgs, setup } from "../src/setup.js";

function fakeIo(overrides = {}) {
  return {
    env: {},
    cwd: "/workspace",
    home: "/home/user",
    exists: () => false,
    readFile: async () => "version: 1\n",
    mkdir: async () => {},
    writeFile: async () => {},
    ...overrides
  };
}

const installedSkills = [
  "grilling",
  "writing-plans",
  "brainstorming",
  "systematic-debugging",
  "using-git-worktrees",
  "finishing-a-development-branch",
  "executing-plans",
  "requesting-code-review",
  "subagent-driven-development",
  "verification-before-completion",
  "task-router"
].map((name) => ({ name }));

test("detectAgent honors explicit environment and agent runtime markers", () => {
  assert.equal(detectAgent(fakeIo({ env: { CS_NEXUS_AGENT: "cursor" } })), "cursor");
  assert.equal(detectAgent(fakeIo({ env: { CODEX_HOME: "/tmp/codex" } })), "codex");
  assert.equal(detectAgent(fakeIo({ env: { CLAUDECODE: "1" } })), "claude-code");
});

test("detectAgent accepts one unambiguous installation and rejects ambiguity", () => {
  assert.equal(detectAgent(fakeIo({
    exists: (candidate) => candidate === path.join("/home/user", ".codex")
  })), "codex");

  assert.throws(() => detectAgent(fakeIo({
    exists: (candidate) => candidate.endsWith(".codex") || candidate.endsWith(".claude")
  })), /无法唯一识别 Agent/);
});

test("parseSetupArgs recognizes setup controls and rejects missing values", () => {
  assert.deepEqual(parseSetupArgs([
    "--config", "custom.yaml", "--agent", "codex", "--project", "--dry-run", "-y"
  ]), {
    config: "custom.yaml",
    agent: "codex",
    scope: "project",
    dryRun: true,
    yes: true
  });
  assert.deepEqual(parseSetupArgs(["--global"]), { scope: "global" });
  assert.throws(() => parseSetupArgs(["--agent"]), /缺少参数/);
  assert.throws(() => parseSetupArgs(["--unsafe"]), /未知 setup 参数/);
});

test("setup dry-run renders the default install plan without spawning", async () => {
  const logs = [];
  let spawnCount = 0;
  const io = {
    ...fakeIo(),
    log: (message) => logs.push(message),
    spawn: () => {
      spawnCount += 1;
      return { status: 0 };
    },
    confirm: async () => {
      throw new Error("dry-run must not ask for confirmation");
    }
  };

  const plan = await setup({
    config: path.resolve("cs-nexus.yaml"),
    agent: "codex",
    dryRun: true
  }, io);

  assert.equal(spawnCount, 0);
  assert.equal(plan.scope, "project");
  assert.ok(plan.agentSkills.every((group) => group.scope === "project"));
  assert.doesNotMatch(logs.join("\n"), /--global/);
  assert.equal(plan.agentSkills.length, 3);
  assert.match(logs.join("\n"), /obra\/superpowers/);
  assert.match(logs.join("\n"), /using-git-worktrees/);
  assert.match(logs.join("\n"), /requesting-code-review/);
  assert.match(logs.join("\n"), /finishing-a-development-branch/);
  assert.match(logs.join("\n"), /task-router/);
});

test("setup executes install groups followed by installed-skill verification", async () => {
  const calls = [];
  const writes = [];
  const io = {
    ...fakeIo(),
    platform: "win32",
    execPath: "C:\\nodejs\\node.exe",
    log: () => {},
    spawn: (command, args) => {
      calls.push([command, ...args]);
      return args.includes("list")
        ? { status: 0, stdout: JSON.stringify(installedSkills) }
        : { status: 0 };
    },
    mkdir: async (...args) => writes.push(["mkdir", ...args]),
    writeFile: async (...args) => writes.push(["writeFile", ...args]),
    confirm: async () => true
  };

  await setup({
    config: path.resolve("cs-nexus.yaml"),
    agent: "codex",
    scope: "project"
  }, io);

  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call[0] === "C:\\nodejs\\node.exe"));
  assert.ok(calls.every((call) => call[1] === "C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"));
  assert.ok(calls.slice(0, 3).every((call) => call.includes("add")));
  assert.ok(calls.slice(0, 3).every((call) => !call.includes("--global")));
  assert.ok(calls[3].includes("list"));
  assert.ok(calls[3].includes("--json"));
  assert.equal(writes[0][1], path.join("/workspace", ".cs-nexus"));
  assert.equal(writes[1][1], path.join("/workspace", ".cs-nexus", "cs-nexus.yaml"));
});

test("setup fails when an expected skill is absent and does not persist policy", async () => {
  let writeCount = 0;
  const io = {
    ...fakeIo(),
    log: () => {},
    spawn: (command, args) => args.includes("list")
      ? { status: 0, stdout: JSON.stringify(installedSkills.filter(({ name }) => name !== "task-router")) }
      : { status: 0 },
    writeFile: async () => {
      writeCount += 1;
    },
    confirm: async () => true
  };

  await assert.rejects(() => setup({
    config: path.resolve("cs-nexus.yaml"),
    agent: "codex",
    scope: "global"
  }, io), /安装验证失败，缺少 Skill：task-router/);
  assert.equal(writeCount, 0);
});
