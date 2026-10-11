import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultIo } from "../../src/io.js";
import { scanUsage } from "../../src/usage/scan.js";

function claudeLine(name, timestamp) {
  return JSON.stringify({
    type: "assistant", timestamp, cwd: "D:\\proj-a",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: name } }] }
  });
}

async function prepare() {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-scan-"));
  const claudeDir = path.join(home, ".claude", "projects", "D--proj-a");
  const codexDir = path.join(home, ".codex", "sessions", "2026", "10", "11");
  await mkdir(claudeDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await writeFile(path.join(claudeDir, "session-1.jsonl"),
    claudeLine("task-router", "2026-10-01T08:00:00.000Z") + "\n" +
    "{ 坏行\n" +
    claudeLine("task-router", "2026-10-02T08:00:00.000Z") + "\n", "utf8");
  await writeFile(path.join(codexDir, "rollout-2026-10-11.jsonl"), JSON.stringify({
    timestamp: "2026-10-11T07:00:00.000Z", type: "response_item",
    payload: { type: "function_call", name: "shell_command",
      arguments: '{"command":"cat C:/Users/demo/.codex/skills/zhihu-analyzer/SKILL.md"}' }
  }) + "\n", "utf8");
  const statePath = path.join(home, ".cs-nexus", "usage-state.json");
  return { home, claudeDir, codexDir, statePath };
}

test("scanUsage aggregates both agents, skips bad lines, and writes cursor state", async () => {
  const { claudeDir, codexDir, statePath } = await prepare();
  const io = createDefaultIo();
  const result = await scanUsage({
    claudeProjectsDir: path.dirname(path.dirname(claudeDir)),
    codexSessionsDir: path.dirname(path.dirname(path.dirname(codexDir))),
    statePath,
    archiveRoot: "C:\\Users\\demo\\.cs-nexus\\skill-archive",
    skillRoots: ["C:\\Users\\demo\\.codex\\skills"],
    io
  });

  assert.equal(result.usage.get("task-router").count, 2);
  assert.equal(result.usage.get("zhihu-analyzer").count, 1);
  assert.equal(result.skippedLines, 1);
  assert.equal(result.agents.claudeCode, true);
  assert.equal(result.agents.codex, true);
  assert.ok(result.discoveredProjects.includes("D:\\proj-a"));
  assert.equal(io.exists(statePath), true);
});

test("scanUsage replaces (not accumulates) counts when a file changes", async () => {
  const { claudeDir, codexDir, statePath } = await prepare();
  const claudeProjects = path.dirname(path.dirname(claudeDir));
  const codexSessions = path.dirname(path.dirname(path.dirname(codexDir)));
  const io = createDefaultIo();
  const options = {
    claudeProjectsDir: claudeProjects, codexSessionsDir: codexSessions, statePath,
    archiveRoot: "C:\\Users\\demo\\.cs-nexus\\skill-archive",
    skillRoots: ["C:\\Users\\demo\\.codex\\skills"], io
  };

  await scanUsage(options);
  // 追加一行后重扫：task-router 计数应为 3（替换语义），而不是 5（累加）
  await writeFile(path.join(claudeDir, "session-1.jsonl"),
    claudeLine("task-router", "2026-10-03T08:00:00.000Z") + "\n", { flag: "a" });
  const second = await scanUsage(options);
  assert.equal(second.usage.get("task-router").count, 3);
  assert.equal(second.usage.get("zhihu-analyzer").count, 1, "未变化文件走游标复用");
});

test("scanUsage filters junk names via keepNames and survives corrupt state", async () => {
  const { claudeDir, codexDir, statePath } = await prepare();
  const io = createDefaultIo();
  const sessionFile = path.join(claudeDir, "session-1.jsonl");
  await writeFile(sessionFile,
    JSON.stringify({ type: "user", timestamp: "2026-10-01T09:00:00.000Z",
      message: { role: "user", content: "<command-name>/clear</command-name>" } }) + "\n", { flag: "a" });
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, "{corrupt", "utf8");

  const result = await scanUsage({
    claudeProjectsDir: path.dirname(path.dirname(claudeDir)),
    codexSessionsDir: path.dirname(path.dirname(path.dirname(codexDir))),
    statePath,
    archiveRoot: "C:\\Users\\demo\\.cs-nexus\\skill-archive",
    skillRoots: [],
    keepNames: new Set(["task-router"]),
    io
  });
  assert.equal(result.usage.has("clear"), false);
  assert.equal(result.usage.get("task-router").count, 2);
});

test("scanUsage reports missing agent directories without throwing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-scan-"));
  const io = createDefaultIo();
  const result = await scanUsage({
    claudeProjectsDir: path.join(home, ".claude", "projects"),
    codexSessionsDir: path.join(home, ".codex", "sessions"),
    statePath: path.join(home, "usage-state.json"),
    io
  });
  assert.deepEqual(result.agents, { claudeCode: false, codex: false });
  assert.equal(result.usage.size, 0);
});
