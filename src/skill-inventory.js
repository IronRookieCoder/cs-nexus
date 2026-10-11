import path from "node:path";
import YAML from "yaml";
import { createDefaultIo } from "./io.js";

export async function listInstalledSkills({ roots, io = createDefaultIo() }) {
  const byName = new Map();

  for (const root of roots) {
    let entries;
    try {
      entries = await io.readdir(root);
    } catch {
      continue; // 根目录不存在 → 跳过该根（spec §8）
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const skillPath = path.join(root, entry);
      const info = await io.lstat(skillPath).catch(() => null);
      if (!info) continue;

      let kind = "dir";
      let target;
      if (info.isSymbolicLink()) {
        // Windows junction 在 lstat 下同样报 isSymbolicLink（spec §2.2）。
        // 链接不要求 SKILL.md 可读：悬挂链接仍纳入（spec §8：按链接正常处理并提示）。
        kind = "link";
        target = await io.readlink(skillPath).catch(() => null);
      } else if (!info.isDirectory()) {
        continue;
      } else {
        const hasSkillMd = await io.readFile(path.join(skillPath, "SKILL.md"), "utf8")
          .then(() => true)
          .catch(() => false);
        if (!hasSkillMd) continue;
      }

      const record = byName.get(entry) ?? { name: entry, description: null, installedAt: null, locations: [] };
      record.locations.push(target ? { path: skillPath, kind, target } : { path: skillPath, kind });
      byName.set(entry, record);
    }
  }

  for (const record of byName.values()) {
    const dirLocation = record.locations.find((location) => location.kind === "dir");
    const source = dirLocation ?? record.locations[0];
    if (dirLocation) {
      const info = await io.stat(dirLocation.path).catch(() => null);
      if (info) {
        record.installedAt = info.birthtimeMs && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
      }
    }
    const frontmatter = await parseSkillFrontmatter(path.join(source.path, "SKILL.md"), io);
    record.description = frontmatter?.description ?? null;
  }
  return [...byName.values()];
}

export async function parseSkillFrontmatter(skillMdPath, io = createDefaultIo()) {
  const source = await io.readFile(skillMdPath, "utf8").catch(() => null);
  if (!source) return null;
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const parsed = YAML.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
