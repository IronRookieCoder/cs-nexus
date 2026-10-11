import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../../src/archive.js";
import { parseArchiveArgs, runArchiveCommand } from "../../src/commands/archive.js";
import { createDefaultIo } from "../../src/io.js";

function fakeIo(home, logs) {
  return { ...createDefaultIo(), home, cwd: home, env: {}, log: (line) => logs.push(line) };
}

async function createSkill(root, name) {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n---\n`, "utf8");
}

test("parseArchiveArgs supports list, restore, to, yes and names", () => {
  assert.deepEqual(parseArchiveArgs(["--list", "--json"]), { names: [], json: true, list: true });
  assert.deepEqual(parseArchiveArgs(["alpha", "beta", "--yes"]), { names: ["alpha", "beta"], json: false, yes: true });
  assert.deepEqual(parseArchiveArgs(["--restore", "alpha", "--to", "D:\\x"]),
    { names: [], json: false, restore: "alpha", to: "D:\\x" });
  assert.throws(() => parseArchiveArgs(["--wat"]), /未知 archive 参数/);
  assert.throws(() => parseArchiveArgs(["--restore"]), /--restore 缺少参数/);
});

test("runArchiveCommand lists the manifest as json", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-acmd-"));
  const logs = [];
  const manifest = await runArchiveCommand(["--list", "--json"], fakeIo(home, logs));
  assert.equal(manifest.version, 2);
  assert.deepEqual(JSON.parse(logs.join("\n")), { version: 2, archived: [] });
});

test("runArchiveCommand archives a skill and refuses keep-alive names from other projects", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-acmd-"));
  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(codexRoot, { recursive: true });
  await createSkill(codexRoot, "freeme");
  await createSkill(codexRoot, "keepme");

  // 另一个项目的配置引用了 keepme；会话 cwd 指向该项目（保活合并的发现来源）
  const projectDir = path.join(home, "code", "proj-b");
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, "cs-nexus.yaml"),
    "version: 1\nrouting:\n  verification: example/repo:keepme\n", "utf8");
  const claudeDir = path.join(home, ".claude", "projects", "fake");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, "s.jsonl"), JSON.stringify({
    type: "assistant", timestamp: "2026-10-10T08:00:00.000Z", cwd: projectDir,
    message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "keepme" } }] }
  }) + "\n", "utf8");

  const logs = [];
  const removed = [];
  const io = fakeIo(home, logs);
  const { results } = await runArchiveCommand(["freeme", "keepme", "--yes"], io, {
    removeWithSkillsCli: async (name) => removed.push(name)
  });

  assert.equal(results.find((result) => result.name === "freeme").status, "archived");
  assert.equal(results.find((result) => result.name === "keepme").status, "refused",
    "其他项目配置引用的 skill 应保活（spec §4.4）");
  assert.deepEqual(removed, ["freeme"]);
  assert.equal(io.exists(path.join(codexRoot, "keepme")), true);
  assert.equal(io.exists(path.join(codexRoot, "freeme")), false);

  const manifest = await loadManifest(path.join(home, ".cs-nexus", "skill-archive.json"), { io });
  assert.deepEqual(manifest.archived.map((entry) => entry.name), ["freeme"]);

  // 命令对 refused 结果会置 process.exitCode = 1（预期行为）；归零，
  // 避免 node:test 子进程以非零码退出导致整个测试文件被误判为失败。
  process.exitCode = 0;
});

test("runArchiveCommand restore round-trips an archived skill", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-acmd-"));
  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(codexRoot, { recursive: true });
  await createSkill(codexRoot, "gamma");
  const logs = [];
  const io = fakeIo(home, logs);
  await runArchiveCommand(["gamma", "--yes"], io, { removeWithSkillsCli: async () => {} });
  assert.equal(io.exists(path.join(codexRoot, "gamma")), false);

  const result = await runArchiveCommand(["--restore", "gamma"], io);
  assert.equal(result.status, "restored");
  assert.equal(io.exists(path.join(codexRoot, "gamma", "SKILL.md")), true);
});

test("runArchiveCommand refuses when archiving is disabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-acmd-"));
  const configPath = path.join(home, "cs-nexus.yaml");
  await writeFile(configPath,
    "version: 1\nrouting:\n  debugging: owner/repo:debug\narchiving:\n  enabled: false\n", "utf8");
  const logs = [];
  await assert.rejects(
    () => runArchiveCommand(["whatever", "--yes", "--config", configPath], fakeIo(home, logs),
      { removeWithSkillsCli: async () => {} }),
    /archiving 已在配置中禁用/
  );
});
