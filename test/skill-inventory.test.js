import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultIo } from "../src/io.js";
import { listInstalledSkills } from "../src/skill-inventory.js";

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

async function createSkill(root, name, description) {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
}

test("listInstalledSkills merges real dirs and links by name across roots", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-inv-"));
  const agentsRoot = path.join(home, ".agents", "skills");
  const claudeRoot = path.join(home, ".claude", "skills");
  const codexRoot = path.join(home, ".codex", "skills");
  for (const root of [agentsRoot, claudeRoot, codexRoot]) await mkdir(root, { recursive: true });

  await createSkill(agentsRoot, "alpha", "Alpha skill.");
  await createSkill(codexRoot, "gamma", "Gamma skill.");
  // beta：canonical 在 agents 根，claude 根下是指向它的链接
  await createSkill(agentsRoot, "beta", "Beta skill.");
  await symlink(path.join(agentsRoot, "beta"), path.join(claudeRoot, "beta"), LINK_TYPE);
  // 无 SKILL.md 的目录与点开头目录不纳入；悬挂链接仍作为 link 位置纳入（spec §8）
  await mkdir(path.join(codexRoot, "not-a-skill"));
  await mkdir(path.join(codexRoot, ".system"));
  await symlink(path.join(codexRoot, "stale-target-not-exist"), path.join(codexRoot, "stale"), LINK_TYPE);

  const io = createDefaultIo();
  const skills = await listInstalledSkills({ roots: [agentsRoot, claudeRoot, codexRoot], io });

  assert.deepEqual(skills.map((item) => item.name).sort(), ["alpha", "beta", "gamma", "stale"]);
  const stale = skills.find((item) => item.name === "stale");
  assert.equal(stale.locations.length, 1);
  assert.equal(stale.locations[0].kind, "link");
  assert.equal(stale.description, null, "悬挂链接读不到 frontmatter");
  const beta = skills.find((item) => item.name === "beta");
  assert.equal(beta.locations.length, 2);
  const link = beta.locations.find((location) => location.kind === "link");
  const dir = beta.locations.find((location) => location.kind === "dir");
  assert.ok(link, "beta 应有一个 link 位置");
  assert.ok(dir, "beta 应有一个 dir 位置");
  assert.equal(path.dirname(link.path), claudeRoot);
  assert.equal(beta.description, "Beta skill.");
  assert.equal(typeof beta.installedAt, "number");
});

test("listInstalledSkills skips a missing root without throwing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-inv-"));
  const io = createDefaultIo();
  const skills = await listInstalledSkills({ roots: [path.join(home, ".claude", "skills")], io });
  assert.deepEqual(skills, []);
});
