const COMMAND_NAME_PATTERN = /<command-name>\/([^<\s/]+)<\/command-name>/g;

// 信号①：assistant tool_use {"name":"Skill","input":{"skill":...}}
// 信号②：user message 内 <command-name>/<name></command-name>
// 信号③：assistant Read 落在归档区根下（动态加载，spec §2）
export function extractClaudeUsage(lines, { archiveRoot } = {}) {
  const counts = {};
  const lastUsed = {};
  const cwds = new Set();
  const normalizedRoot = normalizeRoot(archiveRoot);

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (typeof line.cwd === "string" && line.cwd !== "") cwds.add(line.cwd);

    const used = new Set();
    const content = Array.isArray(line.message?.content) ? line.message.content : [];

    if (line.type === "assistant") {
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        if (block.name === "Skill" && typeof block.input?.skill === "string" && block.input.skill !== "") {
          used.add(block.input.skill);
        }
        if (block.name === "Read" && normalizedRoot) {
          const name = archivedSkillName(block.input?.file_path, normalizedRoot);
          if (name) used.add(name);
        }
      }
    } else if (line.type === "user") {
      for (const match of extractText(line.message?.content).matchAll(COMMAND_NAME_PATTERN)) used.add(match[1]);
    }

    const timestamp = typeof line.timestamp === "string" ? line.timestamp : null;
    for (const name of used) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (timestamp && (!lastUsed[name] || timestamp > lastUsed[name])) lastUsed[name] = timestamp;
    }
  }
  return { counts, lastUsed, cwds: [...cwds] };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => typeof block?.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function normalizeRoot(root) {
  if (typeof root !== "string" || root === "") return null;
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function archivedSkillName(filePath, normalizedRoot) {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (!normalized.startsWith(`${normalizedRoot}/`)) return null;
  const match = normalized.slice(normalizedRoot.length + 1).match(/^([^/]+)\/skill\.md$/);
  return match ? match[1] : null;
}
