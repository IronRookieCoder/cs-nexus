import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveSkills, loadManifest, pinnedSkillNames, readLockEntry, rebuildManifest, restoreSkill, saveManifest, writeLockEntry } from "../src/archive.js";
import { validateConfig } from "../src/config.js";
import { createDefaultIo } from "../src/io.js";

async function tempHome(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

async function createSkill(root, name, description) {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
}

function emptyManifest() {
  return { version: 2, archived: [] };
}

test("loadManifest returns an empty v2 manifest when the file is missing", async () => {
  const home = await tempHome("cs-nexus-manifest-");
  const io = createDefaultIo();
  const manifest = await loadManifest(path.join(home, "skill-archive.json"), { io });
  assert.deepEqual(manifest, { version: 2, archived: [] });
});

test("loadManifest propagates read errors other than ENOENT", async () => {
  const home = await tempHome("cs-nexus-manifest-");
  const io = {
    ...createDefaultIo(),
    readFile: async () => {
      throw Object.assign(new Error("read denied"), { code: "EACCES" });
    }
  };
  await assert.rejects(
    () => loadManifest(path.join(home, "skill-archive.json"), { io }),
    (error) => error.code === "EACCES"
  );
});

test("saveManifest and loadManifest round-trip entries", async () => {
  const home = await tempHome("cs-nexus-manifest-");
  const io = createDefaultIo();
  const manifestPath = path.join(home, "skill-archive.json");
  const manifest = {
    version: 2,
    archived: [{
      name: "zhihu-analyzer", description: "知乎分析", skillFile: path.join(home, "skill-archive", "zhihu-analyzer", "SKILL.md"),
      archivedAt: "2026-10-11T12:00:00.000Z", lastUsedAt: null, usageCount: 3,
      origin: { entries: [{ path: "C:\\Users\\demo\\.codex\\skills\\zhihu-analyzer", kind: "dir" }] }
    }]
  };
  await saveManifest(manifestPath, manifest, io);
  const loaded = await loadManifest(manifestPath, { io });
  assert.deepEqual(loaded, manifest);
});

test("loadManifest rebuilds from the archive directory when JSON is corrupt", async () => {
  const home = await tempHome("cs-nexus-manifest-");
  const io = createDefaultIo();
  const archiveDir = path.join(home, "skill-archive");
  const manifestPath = path.join(home, "skill-archive.json");
  await mkdir(path.join(archiveDir, "zhihu-analyzer"), { recursive: true });
  await writeFile(path.join(archiveDir, "zhihu-analyzer", "SKILL.md"),
    "---\nname: zhihu-analyzer\ndescription: 知乎分析\n---\n", "utf8");
  await writeFile(manifestPath, "{corrupt", "utf8");

  const manifest = await loadManifest(manifestPath, { archiveDir, io });
  assert.equal(manifest.version, 2);
  assert.equal(manifest.archived.length, 1);
  assert.equal(manifest.archived[0].name, "zhihu-analyzer");
  assert.equal(manifest.archived[0].usageCount, null);
  assert.deepEqual(manifest.archived[0].origin.entries, []);
});

test("rebuildManifest ignores directories without SKILL.md", async () => {
  const home = await tempHome("cs-nexus-manifest-");
  const io = createDefaultIo();
  const archiveDir = path.join(home, "skill-archive");
  await mkdir(path.join(archiveDir, "junk"), { recursive: true });
  const manifest = await rebuildManifest(archiveDir, io);
  assert.deepEqual(manifest.archived, []);
});

test("pinnedSkillNames merges routing refs, dependency closure, include and provider names", () => {
  const config = validateConfig({
    version: 1,
    routing: { debugging: "obra/superpowers:systematic-debugging" },
    dependencies: { "obra/superpowers:systematic-debugging": ["obra/superpowers:writing-plans"] },
    providers: { "local:router": { source: "./skills/task-router", name: "task-router" } },
    installation: { include: ["local:router"] }
  });
  const pinned = pinnedSkillNames([config]);
  assert.ok(pinned.has("systematic-debugging"));
  assert.ok(pinned.has("writing-plans"));
  assert.ok(pinned.has("task-router"), "providers.name 应优先于引用后段（local:router → task-router）");
  assert.equal(pinned.has("router"), false);
});

test("archiveSkills moves a copy-layout skill and records the manifest entry", async () => {
  const home = await tempHome("cs-nexus-archive-");
  const io = createDefaultIo();
  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(codexRoot, { recursive: true });
  await createSkill(codexRoot, "gamma", "Gamma skill.");
  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  const manifestPath = path.join(home, ".cs-nexus", "skill-archive.json");
  const lockPath = path.join(home, ".agents", ".skill-lock.json");
  const removed = [];
  const usage = new Map([["gamma", { count: 3, lastUsedAt: "2026-05-01T08:10:26.000Z" }]]);

  const inventory = [{ name: "gamma", description: "Gamma skill.", installedAt: 1,
    locations: [{ path: path.join(codexRoot, "gamma"), kind: "dir" }] }];
  const { results } = await archiveSkills({
    names: ["gamma"], inventory, usage, manifest: emptyManifest(), manifestPath,
    archiveDir, lockPath, pinned: new Set(), io,
    removeWithSkillsCli: async (name) => removed.push(name)
  });

  assert.deepEqual(results, [{ name: "gamma", status: "archived", differingCopies: [] }]);
  assert.equal(io.exists(path.join(codexRoot, "gamma")), false);
  assert.equal(io.exists(path.join(archiveDir, "gamma", "SKILL.md")), true);
  assert.deepEqual(removed, ["gamma"]);

  const manifest = await loadManifest(manifestPath, { io });
  const entry = manifest.archived[0];
  assert.equal(entry.name, "gamma");
  assert.equal(entry.usageCount, 3);
  assert.equal(entry.lastUsedAt, "2026-05-01T08:10:26.000Z");
  assert.equal(entry.skillFile, path.join(archiveDir, "gamma", "SKILL.md"));
  assert.deepEqual(entry.origin.entries, [{ path: path.join(codexRoot, "gamma"), kind: "dir" }]);
});

test("archiveSkills removes links before moving the canonical dir", async () => {
  const home = await tempHome("cs-nexus-archive-");
  const io = createDefaultIo();
  const agentsRoot = path.join(home, ".agents", "skills");
  const claudeRoot = path.join(home, ".claude", "skills");
  await mkdir(agentsRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });
  await createSkill(agentsRoot, "beta", "Beta skill.");
  const betaLink = path.join(claudeRoot, "beta");
  await symlink(path.join(agentsRoot, "beta"), betaLink, LINK_TYPE);

  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  const inventory = [{ name: "beta", description: "Beta skill.", installedAt: 1,
    locations: [
      { path: path.join(agentsRoot, "beta"), kind: "dir" },
      { path: betaLink, kind: "link", target: path.join(agentsRoot, "beta") }
    ] }];
  const { results } = await archiveSkills({
    names: ["beta"], inventory, manifest: emptyManifest(),
    manifestPath: path.join(home, ".cs-nexus", "skill-archive.json"),
    archiveDir, lockPath: path.join(home, ".agents", ".skill-lock.json"),
    pinned: new Set(), io
  });

  assert.equal(results[0].status, "archived");
  assert.equal(io.exists(betaLink), false, "链接应被摘除");
  assert.equal(io.exists(path.join(agentsRoot, "beta")), false, "实体应被迁走");
  assert.equal(io.exists(path.join(archiveDir, "beta", "SKILL.md")), true);

  const manifest = await loadManifest(path.join(home, ".cs-nexus", "skill-archive.json"), { io });
  assert.equal(manifest.archived[0].origin.entries.length, 2);
});

test("archiveSkills reports differing extra copies and removes them", async () => {
  const home = await tempHome("cs-nexus-archive-");
  const io = createDefaultIo();
  const agentsRoot = path.join(home, ".agents", "skills");
  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(agentsRoot, { recursive: true });
  await mkdir(codexRoot, { recursive: true });
  await createSkill(agentsRoot, "delta", "Delta skill.");
  await createSkill(codexRoot, "delta", "Delta skill (different).");

  const inventory = [{ name: "delta", description: "Delta skill.", installedAt: 1,
    locations: [
      { path: path.join(agentsRoot, "delta"), kind: "dir" },
      { path: path.join(codexRoot, "delta"), kind: "dir" }
    ] }];
  const { results } = await archiveSkills({
    names: ["delta"], inventory, manifest: emptyManifest(),
    manifestPath: path.join(home, ".cs-nexus", "skill-archive.json"),
    archiveDir: path.join(home, ".cs-nexus", "skill-archive"),
    lockPath: path.join(home, ".agents", ".skill-lock.json"),
    pinned: new Set(), io
  });

  assert.equal(results[0].status, "archived");
  assert.deepEqual(results[0].differingCopies, [path.join(codexRoot, "delta")]);
  assert.equal(io.exists(path.join(codexRoot, "delta")), false);
});

test("archiveSkills refuses pinned names and reports already/missing states", async () => {
  const home = await tempHome("cs-nexus-archive-");
  const io = createDefaultIo();
  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(codexRoot, { recursive: true });
  await createSkill(codexRoot, "gamma", "Gamma skill.");
  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  await mkdir(path.join(archiveDir, "omega"), { recursive: true });
  await writeFile(path.join(archiveDir, "omega", "SKILL.md"), "---\nname: omega\n---\n", "utf8");

  const inventory = [{ name: "gamma", description: null, installedAt: 1,
    locations: [{ path: path.join(codexRoot, "gamma"), kind: "dir" }] }];
  const manifest = emptyManifest();
  const { results } = await archiveSkills({
    names: ["gamma", "omega", "ghost"],
    inventory,
    manifest: { ...manifest, archived: [{ name: "omega", skillFile: path.join(archiveDir, "omega", "SKILL.md"), origin: { entries: [] } }] },
    manifestPath: path.join(home, ".cs-nexus", "skill-archive.json"),
    archiveDir, lockPath: path.join(home, ".agents", ".skill-lock.json"),
    pinned: new Set(["gamma"]), io
  });

  assert.equal(results[0].status, "refused");
  assert.equal(io.exists(path.join(codexRoot, "gamma")), true, "保活 skill 不被移动");
  assert.equal(results[1].status, "already-archived");
  assert.equal(results[2].status, "missing");
});

test("archiveSkills snapshots the lock entry for the archived name", async () => {
  const home = await tempHome("cs-nexus-archive-");
  const io = createDefaultIo();
  const lockPath = path.join(home, ".agents", ".skill-lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lockEntry = { source: "example/zhihu-skills", sourceType: "github", skillFolderHash: "abc" };
  await writeFile(lockPath, JSON.stringify({ version: 3, skills: { "zhihu-analyzer": lockEntry } }), "utf8");

  assert.deepEqual(await readLockEntry(lockPath, "zhihu-analyzer", io), lockEntry);
  assert.equal(await readLockEntry(lockPath, "absent", io), null);

  const codexRoot = path.join(home, ".codex", "skills");
  await mkdir(codexRoot, { recursive: true });
  await createSkill(codexRoot, "zhihu-analyzer", "知乎分析");
  const inventory = [{ name: "zhihu-analyzer", description: "知乎分析", installedAt: 1,
    locations: [{ path: path.join(codexRoot, "zhihu-analyzer"), kind: "dir" }] }];
  await archiveSkills({
    names: ["zhihu-analyzer"], inventory, manifest: emptyManifest(),
    manifestPath: path.join(home, ".cs-nexus", "skill-archive.json"),
    archiveDir: path.join(home, ".cs-nexus", "skill-archive"), lockPath,
    pinned: new Set(), io
  });
  const manifest = await loadManifest(path.join(home, ".cs-nexus", "skill-archive.json"), { io });
  assert.deepEqual(manifest.archived[0].lockEntry, lockEntry);
});

test("restoreSkill moves the dir back, recreates links and rewrites the lock entry", async () => {
  const home = await tempHome("cs-nexus-restore-");
  const io = createDefaultIo();
  const agentsRoot = path.join(home, ".agents", "skills");
  const claudeRoot = path.join(home, ".claude", "skills");
  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  const manifestPath = path.join(home, ".cs-nexus", "skill-archive.json");
  const lockPath = path.join(home, ".agents", ".skill-lock.json");

  // 归档区里已有 beta；lock 里保留着另一个 skill 的条目
  await mkdir(path.join(archiveDir, "beta"), { recursive: true });
  await writeFile(path.join(archiveDir, "beta", "SKILL.md"), "---\nname: beta\ndescription: Beta skill.\n---\n", "utf8");
  const betaLockEntry = { source: "example/beta", sourceType: "github", skillFolderHash: "def" };
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ version: 3, skills: { "other-skill": { source: "x" } } }), "utf8");

  const betaDir = path.join(agentsRoot, "beta");
  const betaLink = path.join(claudeRoot, "beta");
  const manifest = {
    version: 2,
    archived: [{
      name: "beta", description: "Beta skill.", skillFile: path.join(archiveDir, "beta", "SKILL.md"),
      archivedAt: "2026-10-11T12:00:00.000Z", lastUsedAt: null, usageCount: 0,
      origin: { entries: [
        { path: betaDir, kind: "dir" },
        { path: betaLink, kind: "link", target: betaDir }
      ] },
      lockEntry: betaLockEntry
    }]
  };

  const result = await restoreSkill({ name: "beta", manifest, manifestPath, archiveDir, lockPath, io });
  assert.equal(result.status, "restored");
  assert.equal(result.restoredTo, betaDir);
  assert.equal(result.lockRestored, true);

  assert.equal(io.exists(path.join(betaDir, "SKILL.md")), true);
  const info = await lstat(betaLink);
  assert.equal(info.isSymbolicLink(), true, "链接应被重建");
  assert.equal((await readFile(path.join(betaLink, "SKILL.md"), "utf8")).includes("name: beta"), true, "链接应可解析到实体");

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.deepEqual(lock.skills.beta, betaLockEntry);
  assert.ok(lock.skills["other-skill"], "其他 lock 条目应保留");
  const saved = await loadManifest(manifestPath, { io });
  assert.deepEqual(saved.archived, []);
});

test("restoreSkill refuses to overwrite existing entries at origin paths", async () => {
  const home = await tempHome("cs-nexus-restore-");
  const io = createDefaultIo();
  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  const conflictDir = path.join(home, ".codex", "skills", "gamma");
  await mkdir(path.join(archiveDir, "gamma"), { recursive: true });
  await writeFile(path.join(archiveDir, "gamma", "SKILL.md"), "---\nname: gamma\n---\n", "utf8");
  await mkdir(conflictDir, { recursive: true });

  const manifest = {
    version: 2,
    archived: [{
      name: "gamma", description: null, skillFile: path.join(archiveDir, "gamma", "SKILL.md"),
      archivedAt: null, lastUsedAt: null, usageCount: null,
      origin: { entries: [{ path: conflictDir, kind: "dir" }] }
    }]
  };
  await assert.rejects(
    () => restoreSkill({ name: "gamma", manifest, manifestPath: path.join(home, "m.json"), archiveDir,
      lockPath: path.join(home, ".skill-lock.json"), io }),
    /恢复冲突[\s\S]*gamma/
  );
  assert.equal(io.exists(path.join(archiveDir, "gamma", "SKILL.md")), true, "冲突时归档区不被改动");
});

test("restoreSkill treats dangling links at origin paths as conflicts", async () => {
  const home = await tempHome("cs-nexus-restore-");
  const io = createDefaultIo();
  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  const claudeRoot = path.join(home, ".claude", "skills");
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(path.join(archiveDir, "beta"), { recursive: true });
  await writeFile(path.join(archiveDir, "beta", "SKILL.md"), "---\nname: beta\ndescription: Beta skill.\n---\n", "utf8");

  const betaDir = path.join(home, ".agents", "skills", "beta");
  const goneTarget = path.join(claudeRoot, "gone-target");
  const danglingLink = path.join(claudeRoot, "beta");
  await symlink(goneTarget, danglingLink, LINK_TYPE);
  assert.equal(io.exists(danglingLink), false, "前置条件：existsSync 应无视悬挂链接");

  const manifest = {
    version: 2,
    archived: [{
      name: "beta", description: "Beta skill.", skillFile: path.join(archiveDir, "beta", "SKILL.md"),
      archivedAt: null, lastUsedAt: null, usageCount: null,
      origin: { entries: [
        { path: betaDir, kind: "dir" },
        { path: danglingLink, kind: "link", target: goneTarget }
      ] }
    }]
  };

  await assert.rejects(
    () => restoreSkill({ name: "beta", manifest, manifestPath: path.join(home, "m.json"), archiveDir,
      lockPath: path.join(home, ".skill-lock.json"), io }),
    /恢复冲突[\s\S]*beta/
  );
  assert.equal(io.exists(path.join(archiveDir, "beta", "SKILL.md")), true, "冲突时归档区不被改动");
});

test("restoreSkill supports rebuilt entries via targetDir and degrades on lock mismatch", async () => {
  const home = await tempHome("cs-nexus-restore-");
  const io = createDefaultIo();
  const archiveDir = path.join(home, ".cs-nexus", "skill-archive");
  await mkdir(path.join(archiveDir, "omega"), { recursive: true });
  await writeFile(path.join(archiveDir, "omega", "SKILL.md"), "---\nname: omega\n---\n", "utf8");
  const manifestPath = path.join(home, "m.json");
  const lockPath = path.join(home, "lock.json");
  await writeFile(lockPath, JSON.stringify({ version: 9, skills: {} }), "utf8");

  const noOrigin = { version: 2, archived: [{ name: "omega", description: null,
    skillFile: path.join(archiveDir, "omega", "SKILL.md"), archivedAt: null, lastUsedAt: null,
    usageCount: null, origin: { entries: [] }, lockEntry: { source: "x" } }] };

  const refused = await restoreSkill({ name: "omega", manifest: noOrigin, manifestPath, archiveDir, lockPath, io });
  assert.equal(refused.status, "no-origin");

  const target = path.join(home, "restored", "omega");
  const result = await restoreSkill({ name: "omega", targetDir: target, manifest: noOrigin, manifestPath, archiveDir, lockPath, io });
  assert.equal(result.status, "restored");
  assert.equal(result.restoredTo, target);
  assert.equal(result.lockRestored, false, "lock 版本不兼容时应跳过回写");
});

test("writeLockEntry returns false without a snapshot or with a broken lock", async () => {
  const home = await tempHome("cs-nexus-lock-");
  const io = createDefaultIo();
  const lockPath = path.join(home, "lock.json");
  assert.equal(await writeLockEntry(lockPath, "x", null, io), false);
  await writeFile(lockPath, "{corrupt", "utf8");
  assert.equal(await writeLockEntry(lockPath, "x", { source: "y" }, io), false);
});

test("restoreSkill reports missing names", async () => {
  const home = await tempHome("cs-nexus-restore-");
  const io = createDefaultIo();
  const manifest = { version: 2, archived: [] };
  const result = await restoreSkill({ name: "ghost", manifest, manifestPath: path.join(home, "m.json"),
    archiveDir: path.join(home, "skill-archive"), lockPath: path.join(home, "lock.json"), io });
  assert.equal(result.status, "missing");
});
