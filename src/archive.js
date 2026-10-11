import path from "node:path";
import process from "node:process";
import { resolveSkillClosure } from "./dependencies.js";
import { skillNameFromReference } from "./install-plan.js";
import { createDefaultIo } from "./io.js";
import { parseSkillFrontmatter } from "./skill-inventory.js";

export const MANIFEST_VERSION = 2;

export async function loadManifest(manifestPath, { archiveDir = null, io = createDefaultIo() } = {}) {
  const source = await io.readFile(manifestPath, "utf8").catch(() => null);
  if (source === null) return { version: MANIFEST_VERSION, archived: [] };
  try {
    const parsed = JSON.parse(source);
    if (parsed && parsed.version === MANIFEST_VERSION && Array.isArray(parsed.archived)) {
      return { version: MANIFEST_VERSION, archived: parsed.archived };
    }
    throw new Error("version-mismatch");
  } catch {
    // 清单损坏 → 从归档区重建（spec §8）
    if (!archiveDir) throw new Error(`归档清单损坏且无法重建：${manifestPath}`);
    return rebuildManifest(archiveDir, io);
  }
}

export async function saveManifest(manifestPath, manifest, io = createDefaultIo()) {
  await io.mkdir(path.dirname(manifestPath), { recursive: true });
  await io.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export async function rebuildManifest(archiveDir, io = createDefaultIo()) {
  const entries = await io.readdir(archiveDir).catch(() => []);
  const archived = [];
  for (const name of entries) {
    const skillDir = path.join(archiveDir, name);
    const info = await io.stat(skillDir).catch(() => null);
    if (!info || !info.isDirectory()) continue;
    const frontmatter = await parseSkillFrontmatter(path.join(skillDir, "SKILL.md"), io);
    if (!frontmatter) continue;
    archived.push({
      name,
      description: frontmatter.description ?? null,
      skillFile: path.join(skillDir, "SKILL.md"),
      archivedAt: null,
      lastUsedAt: null,
      usageCount: null,
      origin: { entries: [] }
    });
  }
  return { version: MANIFEST_VERSION, archived };
}

export function pinnedSkillNames(configs) {
  const pinned = new Set();
  for (const config of configs) {
    if (!config) continue;
    const selected = [
      ...Object.values(config.routing ?? {}).map((route) => route.skill),
      ...(config.installation?.include ?? [])
    ];
    let referenced = [...selected];
    try {
      referenced = [...new Set([...selected, ...resolveSkillClosure(selected, config.dependencies ?? {})])];
    } catch {
      // 依赖环等异常 → 退化为仅直接引用（不让单份坏配置阻塞保活合并）
    }
    for (const reference of referenced) {
      pinned.add(config.providers?.[reference]?.name ?? skillNameFromReference(reference));
    }
  }
  return pinned;
}
