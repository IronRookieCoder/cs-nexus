// 路径分隔符三种形态：JSON-in-JSON 的 \\（两个反斜杠字符）、单个 \、/
const SEPARATOR_SOURCE = "(?:\\\\\\\\|\\\\|/)";
const NAME_CLASS_SOURCE = "[^/\\\\:\"']";

export function extractCodexUsage(lines, { roots = [], archiveRoot } = {}) {
  const counts = {};
  const lastUsed = {};
  const cwds = new Set();
  const patterns = [...roots, archiveRoot]
    .filter((root) => typeof root === "string" && root !== "")
    .map((root) => rootSkillPattern(root));

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const payload = line.payload;
    if (!payload || typeof payload !== "object") continue;

    const isSessionMeta = payload.type === "session_meta" || line.type === "session_meta";
    if (isSessionMeta && typeof payload.cwd === "string" && payload.cwd !== "") {
      cwds.add(payload.cwd);
    }
    // 硬性约束（spec §2.1）：只统计 function_call。
    // developer/system 消息（skill 清单注入处）与 function_call_output（输出回显）一律排除。
    if (payload.type !== "function_call") continue;

    const haystack = `${payload.name ?? ""} ${payload.arguments ?? ""}`;
    const used = new Set();
    for (const pattern of patterns) {
      for (const match of haystack.matchAll(pattern)) used.add(match[1]);
    }
    const timestamp = typeof line.timestamp === "string" ? line.timestamp : null;
    for (const name of used) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (timestamp && (!lastUsed[name] || timestamp > lastUsed[name])) lastUsed[name] = timestamp;
    }
  }
  return { counts, lastUsed, cwds: [...cwds] };
}

function rootSkillPattern(root) {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const escaped = normalized
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\//g, SEPARATOR_SOURCE);
  return new RegExp(
    `${escaped}${SEPARATOR_SOURCE}(${NAME_CLASS_SOURCE}+?)${SEPARATOR_SOURCE}SKILL\\.md`,
    "gi"
  );
}
