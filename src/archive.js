import path from "node:path";
import process from "node:process";
import { resolveSkillClosure } from "./dependencies.js";
import { skillNameFromReference } from "./install-plan.js";
import { createDefaultIo } from "./io.js";
import { parseSkillFrontmatter } from "./skill-inventory.js";

export const MANIFEST_VERSION = 2;

export async function loadManifest(manifestPath, { archiveDir = null, io = createDefaultIo() } = {}) {
  let source = null;
  try {
    source = await io.readFile(manifestPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error; // 仅文件缺失视为空清单，其余错误必须上抛（EACCES/EBUSY 等不可吞掉）
  }
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

export async function archiveSkills({
  names, inventory, usage = new Map(), manifest, manifestPath, archiveDir, lockPath,
  pinned, io = createDefaultIo(), now = () => new Date().toISOString(), removeWithSkillsCli = null
}) {
  const results = [];
  for (const name of names) {
    const already = manifest.archived.find((entry) => entry.name === name);
    const record = inventory.find((item) => item.name === name);
    if (!record && already) {
      results.push({ name, status: "already-archived" });
      continue;
    }
    if (!record) {
      results.push({ name, status: "missing" });
      continue;
    }
    if (pinned.has(name)) {
      results.push({ name, status: "refused", reason: "被 routing/dependencies/installation.include 引用（保活）" });
      continue;
    }
    const archiveSkillDir = path.join(archiveDir, name);
    if (io.exists(archiveSkillDir)) {
      results.push({ name, status: "already-archived" });
      continue;
    }

    // 1. 摘除全部链接（只删链接本身，不动 target，spec §4.5）
    for (const location of record.locations.filter((location) => location.kind === "link")) {
      await io.rm(location.path, { recursive: true, force: true });
    }
    // 2. 首个实体迁入归档区；其余独立副本对比 SKILL.md 后删除（spec §4.3）
    const dirs = record.locations.filter((location) => location.kind === "dir");
    if (dirs.length === 0) {
      // 仅剩悬挂链接（实体已不在）：链接已在第 1 步摘除，无内容可归档
      results.push({ name, status: "missing", reason: "仅存在悬挂链接，已摘除，无实体可归档" });
      continue;
    }
    await io.mkdir(archiveDir, { recursive: true });
    await moveDir(dirs[0].path, archiveSkillDir, io);
    const differingCopies = [];
    for (const extra of dirs.slice(1)) {
      const same = await sameFile(path.join(extra.path, "SKILL.md"), path.join(archiveSkillDir, "SKILL.md"), io);
      if (!same) differingCopies.push(extra.path);
      await io.rm(extra.path, { recursive: true, force: true });
    }
    // 3. lock 快照（spec §4.3）
    const lockEntry = await readLockEntry(lockPath, name, io);
    // 4. skills remove 清残留（命令层注入，失败由命令层降级提示，spec §4.5）
    if (removeWithSkillsCli) await removeWithSkillsCli(name);
    // 5. 更新并保存清单
    const usageInfo = usage.get(name);
    manifest.archived = manifest.archived.filter((entry) => entry.name !== name);
    manifest.archived.push({
      name,
      description: record.description,
      skillFile: path.join(archiveSkillDir, "SKILL.md"),
      archivedAt: now(),
      lastUsedAt: usageInfo?.lastUsedAt ?? null,
      usageCount: usageInfo?.count ?? 0,
      origin: { entries: record.locations },
      ...(lockEntry ? { lockEntry } : {})
    });
    results.push({ name, status: "archived", differingCopies });
  }
  await saveManifest(manifestPath, manifest, io);
  return { results, manifest };
}

export async function readLockEntry(lockPath, name, io = createDefaultIo()) {
  const source = await io.readFile(lockPath, "utf8").catch(() => null);
  if (!source) return null;
  try {
    const parsed = JSON.parse(source);
    const entry = parsed?.skills?.[name];
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

async function moveDir(from, to, io) {
  try {
    await io.rename(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await io.cp(from, to, { recursive: true });
    await io.rm(from, { recursive: true, force: true });
  }
}

async function sameFile(a, b, io) {
  const [left, right] = await Promise.all([
    io.readFile(a, "utf8").catch(() => null),
    io.readFile(b, "utf8").catch(() => null)
  ]);
  return left !== null && left === right;
}

export async function restoreSkill({
  name, targetDir = null, manifest, manifestPath, archiveDir, lockPath, io = createDefaultIo()
}) {
  const entry = manifest.archived.find((item) => item.name === name);
  if (!entry) return { name, status: "missing" };

  const originEntries = Array.isArray(entry.origin?.entries) ? entry.origin.entries : [];
  const dirEntries = originEntries.filter((item) => item.kind === "dir");
  const restorePath = targetDir ?? dirEntries[0]?.path ?? null;
  if (!restorePath) {
    return { name, status: "no-origin", message: "清单缺少 origin 实体路径，请用 --to <目录> 指定恢复位置" };
  }

  const candidates = [...originEntries.map((item) => item.path), restorePath]
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  const conflictPaths = [];
  for (const candidate of candidates) {
    // 用 lstat 而非 exists：链接本身存在即算占用，悬挂链接也不能绕过冲突检查
    const present = await io.lstat(candidate).then(() => true).catch(() => false);
    if (present) conflictPaths.push(candidate);
  }
  if (conflictPaths.length > 0) {
    throw new Error(`恢复冲突，以下路径已存在，不覆盖：\n${conflictPaths.join("\n")}`);
  }

  const archiveSkillDir = path.join(archiveDir, name);
  if (!io.exists(archiveSkillDir)) {
    return { name, status: "missing", message: `归档区中没有 ${name} 的文件` };
  }

  await io.mkdir(path.dirname(restorePath), { recursive: true });
  await moveDir(archiveSkillDir, restorePath, io);

  for (const location of originEntries.filter((item) => item.kind === "link")) {
    await createLink(restorePath, location.path, io);
  }

  const lockRestored = await writeLockEntry(lockPath, name, entry.lockEntry, io);

  manifest.archived = manifest.archived.filter((item) => item.name !== name);
  await saveManifest(manifestPath, manifest, io);
  return { name, status: "restored", restoredTo: restorePath, lockRestored };
}

export async function writeLockEntry(lockPath, name, lockEntry, io = createDefaultIo()) {
  if (!lockEntry) return false;
  const source = await io.readFile(lockPath, "utf8").catch(() => null);
  let lock = null;
  try {
    lock = source ? JSON.parse(source) : null;
  } catch {
    lock = null;
  }
  if (!lock || lock.version !== 3 || !lock.skills || typeof lock.skills !== "object") {
    return false; // lock 缺失或版本不兼容 → 跳过回写（spec §4.3）
  }
  lock.skills[name] = lockEntry;
  await io.mkdir(path.dirname(lockPath), { recursive: true });
  await io.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  return true;
}

async function createLink(targetPath, linkPath, io) {
  await io.mkdir(path.dirname(linkPath), { recursive: true });
  const platform = io.platform ?? process.platform;
  if (platform === "win32") {
    await io.symlink(path.resolve(targetPath), linkPath, "junction");
  } else {
    const relative = path.relative(path.dirname(linkPath), targetPath);
    await io.symlink(relative, linkPath);
  }
}
