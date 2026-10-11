import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ARCHIVING } from "../../src/config.js";
import { createDefaultIo } from "../../src/io.js";
import { buildReportRows, parseSkillUsageArgs, runSkillUsageCommand } from "../../src/commands/skill-usage.js";

const DAY_MS = 86400000;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

function fakeIo(home, logs) {
  return { ...createDefaultIo(), home, cwd: home, env: {}, log: (line) => logs.push(line) };
}

test("parseSkillUsageArgs accepts known flags and rejects unknown ones", () => {
  assert.deepEqual(parseSkillUsageArgs(["--json"]), { json: true });
  assert.deepEqual(parseSkillUsageArgs(["--config", "c.yaml"]), { json: false, config: "c.yaml" });
  assert.throws(() => parseSkillUsageArgs(["--json", "--wat"]), /未知 skill-usage 参数/);
  assert.throws(() => parseSkillUsageArgs(["--config"]), /--config 缺少参数/);
});

test("buildReportRows classifies candidate, grace, pinned and archived", () => {
  const inventory = [
    { name: "old", description: null, installedAt: NOW - 90 * DAY_MS,
      locations: [{ path: "C:\\s\\old", kind: "dir" }] },
    { name: "fresh", description: null, installedAt: NOW - 2 * DAY_MS,
      locations: [{ path: "C:\\s\\fresh", kind: "dir" }] },
    { name: "rarely", description: null, installedAt: NOW - 90 * DAY_MS,
      locations: [{ path: "C:\\s\\rarely", kind: "dir" }] },
    { name: "active", description: null, installedAt: NOW - 90 * DAY_MS,
      locations: [{ path: "C:\\s\\active", kind: "dir" }] },
    { name: "router", description: null, installedAt: NOW - 90 * DAY_MS,
      locations: [{ path: "C:\\s\\router", kind: "dir" }] }
  ];
  const usage = new Map([
    ["old", { count: 20, lastUsedAt: new Date(NOW - 45 * DAY_MS).toISOString() }],
    ["rarely", { count: 2, lastUsedAt: new Date(NOW - 5 * DAY_MS).toISOString() }],
    ["active", { count: 20, lastUsedAt: new Date(NOW - 5 * DAY_MS).toISOString() }]
  ]);
  const manifest = { version: 2, archived: [{ name: "boxed", description: "已归档",
    skillFile: "C:\\arc\\boxed\\SKILL.md", archivedAt: null, lastUsedAt: "2026-09-01T00:00:00.000Z",
    usageCount: 1, origin: { entries: [] } }] };
  const usageForBoxed = new Map(usage);
  usageForBoxed.set("boxed", { count: 4, lastUsedAt: "2026-10-10T00:00:00.000Z" });

  const rows = buildReportRows({
    inventory, manifest, usage: usageForBoxed,
    pinned: new Set(["router"]), archiving: DEFAULT_ARCHIVING, nowMs: NOW
  });
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.equal(byName.old.status, "candidate", "45 天未用 → candidate");
  assert.equal(byName.fresh.status, "active", "7 天豁免期内 → active");
  assert.equal(byName.rarely.status, "candidate", "豁免期后调用 < 5 → candidate");
  assert.equal(byName.active.status, "active");
  assert.equal(byName.router.status, "pinned");
  assert.equal(byName.boxed.status, "archived");
  assert.equal(byName.boxed.usageCount, 4, "归档区计数参与报告（spec §7）");
});

test("runSkillUsageCommand scans a fake home and prints json", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-cmd-"));
  const claudeDir = path.join(home, ".claude", "projects", "D--fake");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, "s.jsonl"), JSON.stringify({
    type: "assistant", timestamp: "2026-10-10T08:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "alpha" } }] }
  }) + "\n", "utf8");
  const agentsRoot = path.join(home, ".agents", "skills");
  await mkdir(path.join(agentsRoot, "alpha"), { recursive: true });
  await writeFile(path.join(agentsRoot, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha.\n---\n", "utf8");

  const logs = [];
  const io = fakeIo(home, logs);
  const result = await runSkillUsageCommand(["--json"], io);

  const alpha = result.rows.find((row) => row.name === "alpha");
  assert.equal(alpha.usageCount, 1);
  assert.equal(alpha.status, "active", "新装 7 天豁免期内 → active");
  assert.ok(result.notes.includes("未检测到 Codex"));
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(payload.skills.length, 1);
  assert.equal(payload.skills[0].name, "alpha");
});
