import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManifest, pinnedSkillNames, rebuildManifest, saveManifest } from "../src/archive.js";
import { validateConfig } from "../src/config.js";
import { createDefaultIo } from "../src/io.js";

async function tempHome(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("loadManifest returns an empty v2 manifest when the file is missing", async () => {
  const home = await tempHome("cs-nexus-manifest-");
  const io = createDefaultIo();
  const manifest = await loadManifest(path.join(home, "skill-archive.json"), { io });
  assert.deepEqual(manifest, { version: 2, archived: [] });
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
