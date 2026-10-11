# Skill 使用统计与归档管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 skill 使用统计（双 agent 会话扫描）、归档/恢复（兼容 copy 与 symlink 布局）与 skill-manager 常驻 skill，完整落地 v2 设计。

**Architecture:** 纯 Node ESM CLI 新增两组命令（`skill-usage` / `archive`），底层按"解析器（claude-code/codex）→ 扫描调度（增量游标）→ 库存/归档核心"分层；skill-manager 作为薄交互层只读清单与指引 CLI，不做文件操作。所有文件操作走可注入 `io`（沿用 `src/setup.js` 的 defaultIo 模式）。

**Tech Stack:** Node.js ≥20（内置 `node:test`、`fs/promises`）、已有依赖 `yaml`（frontmatter/配置解析）。**不新增任何运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-10-11-skill-usage-archiving-design.md`（v2，含 symlink 支持修订；执行者须同时阅读 spec 与本计划）

## Global Constraints

- Node ≥ 20，`"type": "module"`（ESM `import`），无新运行时依赖（spec §4.1）。
- 测试框架 `node:test` + `node:assert/strict`；单文件运行 `node --test test/<file>`，全量 `node --test`。
- CLI 用户可见输出使用中文，风格与 `src/setup.js` 现有文案一致；代码标识符用英文。
- 模块一律接受可注入 `io` 参数（默认值由模块提供），参照 `src/setup.js` 的 `defaultIo()` 模式（src/setup.js:210-233）。
- Windows 优先：会话记录路径匹配必须同时兼容 `/`、`\` 与 JSON-in-JSON 的 `\\` 双反斜杠分隔符；skill 目录链接 win32 用 junction（`fs.symlink(target, path, "junction")`，无需管理员权限），posix 用相对 symlink。
- Codex 解析器**只**处理 `payload.type === "function_call"` 的行（spec §2.1 硬性约束，防 developer 消息清单注入造成的全量误报）。
- 增量游标语义：按文件存储计数，文件重扫时**替换**该文件的计数，绝不累加（spec §4.6）。
- 每个任务只运行本任务相关的测试文件（用户全局规则：不做全量测试）；Task 12 统一全量跑一次。
- 新建 `src/*.js` 须同步加入 `package.json` 的 `check` 脚本。
- Commit 遵循仓库现有惯例：英文 conventional 格式（`feat(usage): ...`），消息末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 运行时数据全部落在 `~/.cs-nexus/`（`skill-archive/`、`skill-archive.json`、`usage-state.json`）；锁文件为 `~/.agents/.skill-lock.json`。
- 归档清单结构 version 为 `2`（spec §4.3）。

---

### Task 1: archiving 配置校验与四级配置解析

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`

**Interfaces:**
- Consumes: 现有 `validateConfig(value, configPath)`（src/config.js:30）。
- Produces:
  - `validateConfig` 返回值新增 `archiving` 字段：`{ enabled: boolean, unusedAfterDays: number, minInvocations: number, newSkillGraceDays: number, auto: boolean }`
  - `export const DEFAULT_ARCHIVING`（同上形状，值为 `true/30/5/7/false`）
  - `export function resolveConfigPath({ cwd, env, home, exists }) → string | null`（四级顺序：`cwd/cs-nexus.yaml` → `cwd/.cs-nexus/cs-nexus.yaml` → `env.CS_NEXUS_CONFIG` → `home/.cs-nexus/cs-nexus.yaml`）

- [ ] **Step 1: Write the failing tests**

追加到 `test/config.test.js`（文件顶部 import 区补充 `resolveConfigPath`）：

```js
import { resolveConfigPath, validateConfig } from "../src/config.js";

test("validateConfig normalizes archiving defaults and rejects invalid values", () => {
  const config = validateConfig({ version: 1, routing: { debugging: "owner/repo:debug" } });
  assert.deepEqual(config.archiving, {
    enabled: true,
    unusedAfterDays: 30,
    minInvocations: 5,
    newSkillGraceDays: 7,
    auto: false
  });

  assert.throws(() => validateConfig({
    version: 1,
    routing: { debugging: "owner/repo:debug" },
    archiving: { unused_after_days: 0 }
  }), /archiving.unused_after_days 必须是正整数/);

  assert.throws(() => validateConfig({
    version: 1,
    routing: { debugging: "owner/repo:debug" },
    archiving: { auto: "yes" }
  }), /archiving.auto 必须是布尔值/);
});

test("validateConfig applies explicit archiving values", () => {
  const config = validateConfig({
    version: 1,
    routing: { debugging: "owner/repo:debug" },
    archiving: {
      enabled: false,
      unused_after_days: 14,
      min_invocations: 2,
      new_skill_grace_days: 3,
      auto: true
    }
  });
  assert.equal(config.archiving.enabled, false);
  assert.equal(config.archiving.unusedAfterDays, 14);
  assert.equal(config.archiving.minInvocations, 2);
  assert.equal(config.archiving.newSkillGraceDays, 3);
  assert.equal(config.archiving.auto, true);
});

test("resolveConfigPath follows the four-level order", () => {
  const existing = new Set();
  const exists = (candidate) => existing.has(candidate);
  const context = { cwd: "/w/proj", env: {}, home: "/w/home" };

  existing.add(path.join("/w/home/.cs-nexus", "cs-nexus.yaml"));
  assert.equal(resolveConfigPath(context), path.join("/w/home/.cs-nexus", "cs-nexus.yaml"));

  context.env.CS_NEXUS_CONFIG = "/w/env/cs-nexus.yaml";
  existing.add("/w/env/cs-nexus.yaml");
  assert.equal(resolveConfigPath(context), "/w/env/cs-nexus.yaml");

  existing.add(path.join("/w/proj/.cs-nexus", "cs-nexus.yaml"));
  assert.equal(resolveConfigPath(context), path.join("/w/proj/.cs-nexus", "cs-nexus.yaml"));

  existing.add(path.join("/w/proj", "cs-nexus.yaml"));
  assert.equal(resolveConfigPath(context), path.join("/w/proj", "cs-nexus.yaml"));

  existing.clear();
  assert.equal(resolveConfigPath(context), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL —— `config.archiving` 为 `undefined`（deepEqual 不匹配）、`resolveConfigPath is not a function`。

- [ ] **Step 3: Write minimal implementation**

`src/config.js`：顶部常量区后新增：

```js
export const DEFAULT_ARCHIVING = Object.freeze({
  enabled: true,
  unusedAfterDays: 30,
  minInvocations: 5,
  newSkillGraceDays: 7,
  auto: false
});

const ARCHIVING_INT_KEYS = [
  ["unused_after_days", "unusedAfterDays"],
  ["min_invocations", "minInvocations"],
  ["new_skill_grace_days", "newSkillGraceDays"]
];

export function normalizeArchiving(raw) {
  const result = { ...DEFAULT_ARCHIVING };
  if (raw === undefined) return result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("archiving 必须是对象");
  }
  for (const [snakeKey, camelKey] of ARCHIVING_INT_KEYS) {
    const value = raw[snakeKey];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`archiving.${snakeKey} 必须是正整数`);
    }
    result[camelKey] = value;
  }
  for (const key of ["enabled", "auto"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`archiving.${key} 必须是布尔值`);
    }
    result[key] = value;
  }
  return result;
}

export function resolveConfigPath({ cwd, env, home, exists }) {
  const candidates = [
    path.join(cwd, "cs-nexus.yaml"),
    path.join(cwd, ".cs-nexus", "cs-nexus.yaml"),
    env.CS_NEXUS_CONFIG,
    path.join(home, ".cs-nexus", "cs-nexus.yaml")
  ];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}
```

`validateConfig` 内（policy 校验之后、return 之前）加：

```js
  const archiving = normalizeArchiving(value.archiving);
```

return 对象中 `configPath` 之前加一行 `archiving,`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: PASS（新增 3 个用例 + 原有用例全部通过——`archiving` 为新增字段，不影响原断言）。

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): add archiving section and config path resolution

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Claude Code 会话解析器

**Files:**
- Create: `src/usage/claude-code.js`
- Create: `test/usage/claude-code.test.js`
- Modify: `package.json`（check 脚本追加 `src/usage/claude-code.js`）

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces: `export function extractClaudeUsage(lines, { archiveRoot } = {}) → { counts: Object<string, number>, lastUsed: Object<string, string>, cwds: string[] }`。`lines` 为已 `JSON.parse` 的 transcript 行对象数组；同一行内多个信号指向同一 skill 只计 1 次；`lastUsed` 取该 skill 见过的最大 `timestamp`；`cwds` 为行内 `cwd` 字段去重集合（供保活配置合并的项目发现用）。

- [ ] **Step 1: Write the failing test**

`test/usage/claude-code.test.js`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { extractClaudeUsage } from "../../src/usage/claude-code.js";

const ARCHIVE_ROOT = "C:\\Users\\demo\\.cs-nexus\\skill-archive";

test("extractClaudeUsage counts Skill tool_use invocations", () => {
  const lines = [
    { type: "assistant", timestamp: "2026-10-01T08:00:00.000Z", cwd: "D:\\proj",
      message: { role: "assistant", content: [
        { type: "tool_use", name: "Skill", input: { skill: "task-router", args: "审查文档" } }
      ] } },
    { type: "assistant", timestamp: "2026-10-02T08:00:00.000Z", cwd: "D:\\proj",
      message: { role: "assistant", content: [
        { type: "tool_use", name: "Skill", input: { args: "x", skill: "task-router" } }
      ] } }
  ];
  const result = extractClaudeUsage(lines);
  assert.deepEqual(result.counts, { "task-router": 2 });
  assert.equal(result.lastUsed["task-router"], "2026-10-02T08:00:00.000Z");
  assert.deepEqual(result.cwds, ["D:\\proj"]);
});

test("extractClaudeUsage counts slash commands from user messages", () => {
  const lines = [
    { type: "user", timestamp: "2026-10-01T09:00:00.000Z",
      message: { role: "user", content: "<command-name>/brainstorming</command-name>\n<command-arguments>新功能</command-arguments>" } },
    { type: "user", timestamp: "2026-10-01T09:05:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "<command-name>/clear</command-name>" }] } }
  ];
  const result = extractClaudeUsage(lines);
  // 非 skill 命令同样计数，由 scan 层按 keepNames 过滤（spec §2.1）
  assert.deepEqual(result.counts, { brainstorming: 1, clear: 1 });
});

test("extractClaudeUsage counts Read of archived SKILL.md under archive root only", () => {
  const lines = [
    { type: "assistant", timestamp: "2026-10-03T08:00:00.000Z",
      message: { role: "assistant", content: [
        { type: "tool_use", name: "Read", input: { file_path: "C:\\Users\\demo\\.cs-nexus\\skill-archive\\zhihu-analyzer\\SKILL.md" } }
      ] } },
    { type: "assistant", timestamp: "2026-10-03T08:01:00.000Z",
      message: { role: "assistant", content: [
        { type: "tool_use", name: "Read", input: { file_path: "C:\\Users\\demo\\.agents\\skills\\brainstorming\\SKILL.md" } }
      ] } }
  ];
  const result = extractClaudeUsage(lines, { archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, { "zhihu-analyzer": 1 });
  assert.equal(result.lastUsed["zhihu-analyzer"], "2026-10-03T08:00:00.000Z");
});

test("extractClaudeUsage skips malformed lines without throwing", () => {
  const result = extractClaudeUsage([null, 42, "x", {}, { type: "assistant", message: {} }]);
  assert.deepEqual(result.counts, {});
  assert.deepEqual(result.cwds, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/usage/claude-code.test.js`
Expected: FAIL —— `Cannot find module '../../src/usage/claude-code.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/usage/claude-code.js`：

```js
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
      for (const match of extractText(content).matchAll(COMMAND_NAME_PATTERN)) used.add(match[1]);
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
```

`package.json` 的 `check` 脚本：在 `node --check src/setup.js` 之后追加 `&& node --check src/usage/claude-code.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/usage/claude-code.test.js && npm run check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/usage/claude-code.js test/usage/claude-code.test.js package.json
git commit -m "feat(usage): parse claude code skill invocation signals

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: Codex 会话解析器（含 developer 消息误报回归）

**Files:**
- Create: `src/usage/codex.js`
- Create: `test/usage/codex.test.js`
- Modify: `package.json`（check 脚本追加 `src/usage/codex.js`）

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces: `export function extractCodexUsage(lines, { roots = [], archiveRoot } = {})`，返回值与 `extractClaudeUsage` 相同结构。`roots` 为三个安装根的绝对路径数组；`archiveRoot` 为归档区绝对路径。只统计 `payload.type === "function_call"` 行内对 `<根>/<name>/SKILL.md` 的引用；`session_meta` 行的 `payload.cwd` 进入 `cwds`。

- [ ] **Step 1: Write the failing test**

`test/usage/codex.test.js`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { extractCodexUsage } from "../../src/usage/codex.js";

const AGENTS_ROOT = "C:\\Users\\demo\\.agents\\skills";
const CODEX_ROOT = "C:\\Users\\demo\\.codex\\skills";
const ARCHIVE_ROOT = "C:\\Users\\demo\\.cs-nexus\\skill-archive";
const ROOTS = [AGENTS_ROOT, CODEX_ROOT];

test("extractCodexUsage counts function_call reads with escaped backslash paths", () => {
  // arguments 是 JSON-in-JSON：文件内容里每个字面反斜杠以 \\ 两个字符出现
  const lines = [
    { timestamp: "2026-04-27T02:02:17.668Z", type: "response_item",
      payload: { type: "function_call", name: "shell_command",
        arguments: '{"command":"Get-Content -Path C:\\\\Users\\\\demo\\\\.agents\\\\skills\\\\brainstorming\\\\SKILL.md -TotalCount 170","workdir":"D:\\\\code","timeout_ms":30000}',
        call_id: "call_1" } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, { brainstorming: 1 });
  assert.equal(result.lastUsed.brainstorming, "2026-04-27T02:02:17.668Z");
});

test("extractCodexUsage counts function_call reads with forward slash paths", () => {
  const lines = [
    { timestamp: "2026-05-01T08:10:26.000Z", type: "response_item",
      payload: { type: "function_call", name: "shell_command",
        arguments: '{"command":"cat C:/Users/demo/.codex/skills/zhihu-analyzer/SKILL.md"}', call_id: "call_2" } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, { "zhihu-analyzer": 1 });
});

test("extractCodexUsage counts archived skill loads against the archive root", () => {
  const lines = [
    { timestamp: "2026-10-05T10:00:00.000Z", type: "response_item",
      payload: { type: "function_call", name: "shell_command",
        arguments: '{"command":"Get-Content C:/Users/demo/.cs-nexus/skill-archive/zhihu-analyzer/SKILL.md"}', call_id: "call_3" } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, { "zhihu-analyzer": 1 });
});

test("extractCodexUsage ignores developer-message skill list injections (regression)", () => {
  const lines = [
    { timestamp: "2026-05-20T14:58:46.000Z", type: "response_item",
      payload: { type: "message", role: "developer", content: [
        { type: "input_text", text: "- find-skills: 搜索 skill (file: C:/Users/demo/.agents/skills/find-skills/SKILL.md)\n- frontend-design: 前端设计 (file: C:/Users/demo/.agents/skills/frontend-design/SKILL.md)" }
      ] } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, {});
});

test("extractCodexUsage ignores function_call_output path echoes", () => {
  const lines = [
    { timestamp: "2026-05-20T15:00:00.000Z", type: "response_item",
      payload: { type: "function_call_output", call_id: "call_2",
        output: '{"output":"C:/Users/demo/.codex/skills/zhihu-analyzer/SKILL.md:23: 内容"}' } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, {});
});

test("extractCodexUsage ignores relative project paths that lack a known root", () => {
  const lines = [
    { timestamp: "2026-04-27T02:03:00.000Z", type: "response_item",
      payload: { type: "function_call", name: "shell_command",
        arguments: '{"command":"Get-Content -Path skills\\\\docs2md\\\\SKILL.md -TotalCount 170"}', call_id: "call_4" } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, {});
});

test("extractCodexUsage mentions inside search commands count as conservative usage", () => {
  // spec §2.1：function_call 内的提及型误报是可接受的保守误差（只会延迟归档）
  const lines = [
    { timestamp: "2026-05-18T23:43:06.000Z", type: "response_item",
      payload: { type: "function_call", name: "shell_command",
        arguments: '{"command":"rg -n \\"loadPluginSkills\\" C:/Users/demo/.agents/skills/grilling/SKILL.md"}', call_id: "call_5" } }
  ];
  const result = extractCodexUsage(lines, { roots: ROOTS, archiveRoot: ARCHIVE_ROOT });
  assert.deepEqual(result.counts, { grilling: 1 });
});

test("extractCodexUsage collects cwd from session_meta", () => {
  const lines = [
    { timestamp: "2026-05-19T07:36:52.000Z", type: "session_meta",
      payload: { type: "session_meta", cwd: "D:\\PR\\cs-nexus", originator: "codex_cli_rs" } },
    { timestamp: "2026-05-19T08:00:00.000Z", type: "session_meta",
      payload: { id: "x", cwd: "D:\\code\\doc2ai" } }
  ];
  const result = extractCodexUsage(lines);
  assert.deepEqual(result.cwds, ["D:\\PR\\cs-nexus", "D:\\code\\doc2ai"]);
  assert.deepEqual(result.counts, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/usage/codex.test.js`
Expected: FAIL —— `Cannot find module '../../src/usage/codex.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/usage/codex.js`：

```js
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
```

`package.json` 的 `check` 脚本追加 `&& node --check src/usage/codex.js`。

说明：`SEPARATOR_SOURCE` 的字符串字面量在文件里就是 `"(?:\\\\\\\\|\\\\|/)"`（十一个字符转义后得到正则源 `(?:\\\\|\\|/)`，分别匹配 `\\`、`\`、`/`）。实现时照抄本代码块，不要手工改写转义。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/usage/codex.test.js && npm run check`
Expected: PASS（8 个用例全过，特别是 developer 消息回归用例计数为空）。

- [ ] **Step 5: Commit**

```bash
git add src/usage/codex.js test/usage/codex.test.js package.json
git commit -m "feat(usage): parse codex function_call skill reads with root matching

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: 共享 io 基建与全局 skill 库存枚举（实体/链接识别）

**Files:**
- Create: `src/io.js`
- Create: `src/skill-inventory.js`
- Create: `test/skill-inventory.test.js`
- Modify: `package.json`（check 脚本追加 `src/io.js`、`src/skill-inventory.js`）

**Interfaces:**
- Produces（src/io.js）:
  - `export function createDefaultIo() → io`：`{ env, platform, cwd, home, exists, stat, lstat, readdir, readlink, readFile, writeFile, mkdir, rm, rename, symlink, cp, spawn, log, confirm }`（fs 函数来自 `node:fs/promises`，`exists` 用 `node:fs` 的 `existsSync`，`confirm` 与 `src/setup.js` 的 defaultIo 相同语义）
  - `export function defaultPaths(home) → { base, archiveDir, manifestPath, statePath, lockPath, skillRoots }`：`skillRoots` = `[home/.agents/skills, home/.claude/skills, home/.codex/skills]`
- Produces（src/skill-inventory.js）:
  - `export async function listInstalledSkills({ roots, io }) → [{ name, description, installedAt, locations: [{ path, kind: "dir" | "link", target? }] }]`——同名跨根合并为一条；`installedAt` 为首个实体目录的 `birthtimeMs`（为 0 时回退 `mtimeMs`，spec §6）；frontmatter 从首个实体目录的 SKILL.md 读取
  - `export async function parseSkillFrontmatter(skillMdPath, io) → Object | null`
- Consumes: `yaml` 依赖（frontmatter 解析）。

- [ ] **Step 1: Write the failing test**

`test/skill-inventory.test.js`：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill-inventory.test.js`
Expected: FAIL —— `Cannot find module '../src/io.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/io.js`：

```js
import { existsSync } from "node:fs";
import {
  cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";

export function createDefaultIo() {
  return {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    home: os.homedir(),
    exists: existsSync,
    stat,
    lstat,
    readdir,
    readlink,
    readFile,
    writeFile,
    mkdir,
    rm,
    rename,
    symlink,
    cp,
    spawn: spawnSync,
    log: console.log,
    async confirm(question) {
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await terminal.question(question);
        return /^(y|yes)$/i.test(answer.trim());
      } finally {
        terminal.close();
      }
    }
  };
}

export function defaultPaths(home) {
  const base = path.join(home, ".cs-nexus");
  return {
    base,
    archiveDir: path.join(base, "skill-archive"),
    manifestPath: path.join(base, "skill-archive.json"),
    statePath: path.join(base, "usage-state.json"),
    lockPath: path.join(home, ".agents", ".skill-lock.json"),
    skillRoots: [
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      path.join(home, ".codex", "skills")
    ]
  };
}
```

`src/skill-inventory.js`：

```js
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
```

`package.json` 的 `check` 脚本追加 `&& node --check src/io.js && node --check src/skill-inventory.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/skill-inventory.test.js && npm run check`
Expected: PASS（Windows 下 junction 创建无需管理员权限；若 CI 在 posix，LINK_TYPE 自动切换为 dir symlink）。

- [ ] **Step 5: Commit**

```bash
git add src/io.js src/skill-inventory.js test/skill-inventory.test.js package.json
git commit -m "feat(archive): enumerate installed skills with dir/link detection

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: 增量使用扫描（游标替换语义）

**Files:**
- Create: `src/usage/scan.js`
- Create: `test/usage/scan.test.js`
- Modify: `package.json`（check 脚本追加 `src/usage/scan.js`）

**Interfaces:**
- Consumes: `extractClaudeUsage(lines, { archiveRoot })`（Task 2）、`extractCodexUsage(lines, { roots, archiveRoot })`（Task 3）、`createDefaultIo()`（Task 4）。
- Produces: `export async function scanUsage({ claudeProjectsDir, codexSessionsDir, statePath, archiveRoot, skillRoots = [], keepNames = null, io }) → { usage: Map<name, { count, lastUsedAt }>, agents: { claudeCode: boolean, codex: boolean }, discoveredProjects: string[], skippedLines: number }`
  - 游标文件 `{ files: { <绝对路径>: { mtimeMs, size, counts, lastUsed, cwds } } }`；文件未变直接复用游标，变化则整文件重扫并**替换**该条目（spec §4.6）。
  - `keepNames`（`Set<string> | null`）：非 null 时只保留集合内的名字（防 `clear` 等非 skill 命令污染状态文件）。
  - Claude 侧收集 `*.jsonl`（任意深度），Codex 侧只收集 `rollout-*.jsonl`。

- [ ] **Step 1: Write the failing test**

`test/usage/scan.test.js`：

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultIo } from "../../src/io.js";
import { scanUsage } from "../../src/usage/scan.js";

function claudeLine(name, timestamp) {
  return JSON.stringify({
    type: "assistant", timestamp, cwd: "D:\\proj-a",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: name } }] }
  });
}

async function prepare() {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-scan-"));
  const claudeDir = path.join(home, ".claude", "projects", "D--proj-a");
  const codexDir = path.join(home, ".codex", "sessions", "2026", "10", "11");
  await mkdir(claudeDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await writeFile(path.join(claudeDir, "session-1.jsonl"),
    claudeLine("task-router", "2026-10-01T08:00:00.000Z") + "\n" +
    "{ 坏行\n" +
    claudeLine("task-router", "2026-10-02T08:00:00.000Z") + "\n", "utf8");
  await writeFile(path.join(codexDir, "rollout-2026-10-11.jsonl"), JSON.stringify({
    timestamp: "2026-10-11T07:00:00.000Z", type: "response_item",
    payload: { type: "function_call", name: "shell_command",
      arguments: '{"command":"cat C:/Users/demo/.codex/skills/zhihu-analyzer/SKILL.md"}' }
  }) + "\n", "utf8");
  const statePath = path.join(home, ".cs-nexus", "usage-state.json");
  return { home, claudeDir, codexDir, statePath };
}

test("scanUsage aggregates both agents, skips bad lines, and writes cursor state", async () => {
  const { claudeDir, codexDir, statePath } = await prepare();
  const io = createDefaultIo();
  const result = await scanUsage({
    claudeProjectsDir: path.dirname(path.dirname(claudeDir)),
    codexSessionsDir: path.dirname(path.dirname(path.dirname(codexDir))),
    statePath,
    archiveRoot: "C:\\Users\\demo\\.cs-nexus\\skill-archive",
    skillRoots: ["C:\\Users\\demo\\.codex\\skills"],
    io
  });

  assert.equal(result.usage.get("task-router").count, 2);
  assert.equal(result.usage.get("zhihu-analyzer").count, 1);
  assert.equal(result.skippedLines, 1);
  assert.equal(result.agents.claudeCode, true);
  assert.equal(result.agents.codex, true);
  assert.ok(result.discoveredProjects.includes("D:\\proj-a"));
  assert.equal(io.exists(statePath), true);
});

test("scanUsage replaces (not accumulates) counts when a file changes", async () => {
  const { claudeDir, codexDir, statePath } = await prepare();
  const claudeProjects = path.dirname(path.dirname(claudeDir));
  const codexSessions = path.dirname(path.dirname(path.dirname(codexDir)));
  const io = createDefaultIo();
  const options = {
    claudeProjectsDir: claudeProjects, codexSessionsDir: codexSessions, statePath,
    archiveRoot: "C:\\Users\\demo\\.cs-nexus\\skill-archive",
    skillRoots: ["C:\\Users\\demo\\.codex\\skills"], io
  };

  await scanUsage(options);
  // 追加一行后重扫：task-router 计数应为 3（替换语义），而不是 5（累加）
  await writeFile(path.join(claudeDir, "session-1.jsonl"),
    claudeLine("task-router", "2026-10-03T08:00:00.000Z") + "\n", { flag: "a" });
  const second = await scanUsage(options);
  assert.equal(second.usage.get("task-router").count, 3);
  assert.equal(second.usage.get("zhihu-analyzer").count, 1, "未变化文件走游标复用");
});

test("scanUsage filters junk names via keepNames and survives corrupt state", async () => {
  const { claudeDir, codexDir, statePath } = await prepare();
  const io = createDefaultIo();
  const sessionFile = path.join(claudeDir, "session-1.jsonl");
  await writeFile(sessionFile,
    JSON.stringify({ type: "user", timestamp: "2026-10-01T09:00:00.000Z",
      message: { role: "user", content: "<command-name>/clear</command-name>" } }) + "\n", { flag: "a" });
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, "{corrupt", "utf8");

  const result = await scanUsage({
    claudeProjectsDir: path.dirname(path.dirname(claudeDir)),
    codexSessionsDir: path.dirname(path.dirname(path.dirname(codexDir))),
    statePath,
    archiveRoot: "C:\\Users\\demo\\.cs-nexus\\skill-archive",
    skillRoots: [],
    keepNames: new Set(["task-router"]),
    io
  });
  assert.equal(result.usage.has("clear"), false);
  assert.equal(result.usage.get("task-router").count, 2);
});

test("scanUsage reports missing agent directories without throwing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cs-nexus-scan-"));
  const io = createDefaultIo();
  const result = await scanUsage({
    claudeProjectsDir: path.join(home, ".claude", "projects"),
    codexSessionsDir: path.join(home, ".codex", "sessions"),
    statePath: path.join(home, "usage-state.json"),
    io
  });
  assert.deepEqual(result.agents, { claudeCode: false, codex: false });
  assert.equal(result.usage.size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/usage/scan.test.js`
Expected: FAIL —— `Cannot find module '../../src/usage/scan.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/usage/scan.js`：

```js
import path from "node:path";
import { extractClaudeUsage } from "./claude-code.js";
import { extractCodexUsage } from "./codex.js";
import { createDefaultIo } from "../io.js";

export async function scanUsage({
  claudeProjectsDir, codexSessionsDir, statePath, archiveRoot, skillRoots = [], keepNames = null,
  io = createDefaultIo()
}) {
  const state = await loadState(statePath, io);
  const usage = new Map();
  const discoveredProjects = new Set();
  let skippedLines = 0;
  const agents = {
    claudeCode: io.exists(claudeProjectsDir),
    codex: io.exists(codexSessionsDir)
  };

  const addUsage = (fileResult) => {
    for (const [name, count] of Object.entries(fileResult.counts)) {
      const entry = usage.get(name) ?? { count: 0, lastUsedAt: null };
      entry.count += count;
      const lastUsedAt = fileResult.lastUsed[name];
      if (lastUsedAt && (!entry.lastUsedAt || lastUsedAt > entry.lastUsedAt)) entry.lastUsedAt = lastUsedAt;
      usage.set(name, entry);
    }
    for (const cwd of fileResult.cwds ?? []) discoveredProjects.add(cwd);
  };

  const claudeFiles = agents.claudeCode
    ? await listFiles(claudeProjectsDir, (name) => name.endsWith(".jsonl"), io)
    : [];
  for (const file of claudeFiles) {
    const outcome = await scanFile({ file, state, parse: extractClaudeUsage, options: { archiveRoot }, keepNames, io });
    skippedLines += outcome.skippedLines;
    addUsage(outcome.parsed);
  }

  const codexFiles = agents.codex
    ? await listFiles(codexSessionsDir, (name) => /^rollout-.*\.jsonl$/.test(name), io)
    : [];
  for (const file of codexFiles) {
    const outcome = await scanFile({
      file, state, parse: extractCodexUsage, options: { roots: skillRoots, archiveRoot }, keepNames, io
    });
    skippedLines += outcome.skippedLines;
    addUsage(outcome.parsed);
  }

  await saveState(statePath, state, io);
  return { usage, agents, discoveredProjects: [...discoveredProjects], skippedLines };
}

async function scanFile({ file, state, parse, options, keepNames, io }) {
  let info;
  try {
    info = await io.stat(file);
  } catch {
    return { skippedLines: 0, parsed: { counts: {}, lastUsed: {}, cwds: [] } };
  }
  const cursor = state.files[file];
  if (cursor && cursor.mtimeMs === info.mtimeMs && cursor.size === info.size) {
    return { skippedLines: 0, parsed: { counts: cursor.counts, lastUsed: cursor.lastUsed, cwds: cursor.cwds } };
  }

  let source;
  try {
    source = await io.readFile(file, "utf8");
  } catch {
    return { skippedLines: 0, parsed: { counts: {}, lastUsed: {}, cwds: [] } };
  }
  const lines = [];
  let skippedLines = 0;
  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      skippedLines += 1; // 单行损坏跳过并计数（spec §8）
    }
  }

  const parsed = parse(lines, options);
  const filtered = keepNames
    ? {
        counts: Object.fromEntries(Object.entries(parsed.counts).filter(([name]) => keepNames.has(name))),
        lastUsed: Object.fromEntries(Object.entries(parsed.lastUsed).filter(([name]) => keepNames.has(name))),
        cwds: parsed.cwds
      }
    : parsed;
  // 游标语义：重扫即替换，绝不累加（spec §4.6）
  state.files[file] = { mtimeMs: info.mtimeMs, size: info.size, counts: filtered.counts, lastUsed: filtered.lastUsed, cwds: filtered.cwds };
  return { skippedLines, parsed: filtered };
}

async function listFiles(root, filter, io) {
  const result = [];
  const entries = await io.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full, filter, io));
    else if (entry.isFile() && filter(entry.name)) result.push(full);
  }
  return result;
}

async function loadState(statePath, io) {
  const source = await io.readFile(statePath, "utf8").catch(() => null);
  if (!source) return { files: {} };
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return { files: parsed.files };
    }
  } catch {
    // 状态损坏 → 重新开始（spec §8）
  }
  return { files: {} };
}

async function saveState(statePath, state, io) {
  await io.mkdir(path.dirname(statePath), { recursive: true });
  await io.writeFile(statePath, JSON.stringify(state), "utf8");
}
```

`package.json` 的 `check` 脚本追加 `&& node --check src/usage/scan.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/usage/scan.test.js && npm run check`
Expected: PASS（重点：替换语义用例 count 为 3 而非 5）。

- [ ] **Step 5: Commit**

```bash
git add src/usage/scan.js test/usage/scan.test.js package.json
git commit -m "feat(usage): incremental dual-agent scan with per-file cursor

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 6: 归档清单读写/重建与保活集合

**Files:**
- Create: `src/archive.js`
- Create: `test/archive.test.js`
- Modify: `src/install-plan.js:97`（`function skillNameFromReference` 改为 `export function`）
- Modify: `package.json`（check 脚本追加 `src/archive.js`）

**Interfaces:**
- Consumes: `resolveSkillClosure`（src/dependencies.js）、`parseSkillFrontmatter`（Task 4）、`createDefaultIo`（Task 4）。
- Produces:
  - `export const MANIFEST_VERSION = 2`
  - `export async function loadManifest(manifestPath, { archiveDir = null, io }) → { version: 2, archived: [...] }`（缺失 → 空清单；损坏且给了 archiveDir → 重建；损坏且无 archiveDir → throw）
  - `export async function saveManifest(manifestPath, manifest, io)`
  - `export async function rebuildManifest(archiveDir, io)`（统计字段置 null、`origin.entries` 为空数组，spec §8）
  - `export function pinnedSkillNames(configs) → Set<string>`（configs 为 `validateConfig` 产物数组；providers.name 优先于 ref 后段；单份配置依赖环时退化为仅直接引用）

- [ ] **Step 1: Write the failing test**

`test/archive.test.js`：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/archive.test.js`
Expected: FAIL —— `Cannot find module '../src/archive.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/install-plan.js`：把 `function skillNameFromReference(reference) {` 改为 `export function skillNameFromReference(reference) {`（行为不变）。

`src/archive.js`：

```js
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
```

`package.json` 的 `check` 脚本追加 `&& node --check src/archive.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/archive.test.js test/install-plan.test.js && npm run check`
Expected: PASS（含原有 install-plan 测试——导出符号不改变行为）。

- [ ] **Step 5: Commit**

```bash
git add src/archive.js src/install-plan.js test/archive.test.js package.json
git commit -m "feat(archive): manifest persistence, rebuild and keep-alive set

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 7: 归档执行（symlink 摘链 → 迁实体 → lock 快照）

**Files:**
- Modify: `src/archive.js`（追加 `archiveSkills` 及辅助函数）
- Modify: `test/archive.test.js`（追加用例）

**Interfaces:**
- Consumes: `listInstalledSkills` 产物（inventory 记录）、`scanUsage` 产物的 `usage` Map、`pinnedSkillNames` 产物、`saveManifest`。
- Produces: `export async function archiveSkills({ names, inventory, usage = new Map(), manifest, manifestPath, archiveDir, lockPath, pinned, io, now = () => new Date().toISOString(), removeWithSkillsCli = null }) → { results: [{ name, status: "archived" | "already-archived" | "missing" | "refused", differingCopies?: string[], reason?: string }], manifest }`。执行顺序（spec §4.5）：摘链接 → 迁实体（首个）→ 对比并删除多余副本 → lock 快照 → `removeWithSkillsCli(name)`（由命令层注入，可为 null）→ 更新并保存清单。
- 附带导出：`export async function readLockEntry(lockPath, name, io) → Object | null`。

- [ ] **Step 1: Write the failing tests**

追加到 `test/archive.test.js`（import 区补充 `archiveSkills`、`readLockEntry`、`symlink`、`readFile`）：

```js
import { readFile, symlink } from "node:fs/promises";
import { archiveSkills, loadManifest, readLockEntry } from "../src/archive.js";

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

async function createSkill(root, name, description) {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
}

function emptyManifest() {
  return { version: 2, archived: [] };
}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/archive.test.js`
Expected: FAIL —— `archiveSkills is not a function`（新增用例），原 Task 6 用例仍 PASS。

- [ ] **Step 3: Write minimal implementation**

追加到 `src/archive.js`：

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/archive.test.js && npm run check`
Expected: PASS（10 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/archive.js test/archive.test.js
git commit -m "feat(archive): archive skills across dir and link layouts

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 8: 恢复（实体迁回 + 链接重建 + lock 回写）

**Files:**
- Modify: `src/archive.js`（追加 `restoreSkill`、`writeLockEntry`、`createLink`）
- Modify: `test/archive.test.js`（追加用例）

**Interfaces:**
- Consumes: `loadManifest` 产物的清单条目（`origin.entries`、`lockEntry`）、`moveDir`（Task 7 内部函数）。
- Produces: `export async function restoreSkill({ name, targetDir = null, manifest, manifestPath, archiveDir, lockPath, io }) → { name, status: "restored" | "missing" | "no-origin", restoredTo?, lockRestored?, message? }`
  - 冲突（任一 origin 路径或目标目录已存在同名条目）→ throw Error，信息列出全部冲突路径，不做任何变更（spec §8）。
  - 链接重建：win32 用 junction（绝对目标），posix 用相对 symlink（与 skills CLI 行为一致，spec §4.5）。
  - lock 回写：仅当快照存在且 lock 为 `version: 3` 对象结构时执行；否则跳过并返回 `lockRestored: false`（降级提示，spec §4.3）。
- 附带导出：`export async function writeLockEntry(lockPath, name, lockEntry, io) → boolean`。

- [ ] **Step 1: Write the failing tests**

追加到 `test/archive.test.js`（import 区补充 `restoreSkill`、`writeLockEntry`、`lstat`）：

```js
import { lstat } from "node:fs/promises";
import { restoreSkill, writeLockEntry } from "../src/archive.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/archive.test.js`
Expected: FAIL —— `restoreSkill is not a function`。

- [ ] **Step 3: Write minimal implementation**

追加到 `src/archive.js`：

```js
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

  const conflictPaths = [...originEntries.map((item) => item.path), restorePath]
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => io.exists(candidate));
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/archive.test.js && npm run check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/archive.js test/archive.test.js
git commit -m "feat(archive): restore skills with link recreation and lock write-back

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 9: skill-usage 命令与 bin 分发

**Files:**
- Create: `src/commands/skill-usage.js`
- Create: `test/commands/skill-usage.test.js`
- Modify: `src/config.js`（新增 `loadCommandConfig`，供两个命令共用）
- Modify: `bin/cs-nexus.js`（按首参数分发）
- Modify: `src/setup.js:202-208`（helpText 增加新命令说明）
- Modify: `package.json`（check 脚本追加 `src/commands/skill-usage.js`）

**Interfaces:**
- Consumes: `loadConfig`、`resolveConfigPath`、`DEFAULT_ARCHIVING`（Task 1）、`listInstalledSkills`（Task 4）、`loadManifest`、`pinnedSkillNames`（Task 6）、`scanUsage`（Task 5）、`createDefaultIo`、`defaultPaths`（Task 4）。
- Produces:
  - `export function parseSkillUsageArgs(argv) → { json: boolean, config?: string }`（未知参数 throw）
  - `export function buildReportRows({ inventory, manifest, usage, pinned, archiving, nowMs = Date.now() }) → [{ name, locations, usageCount, lastUsedAt, status }]`（status ∈ active/candidate/pinned/archived；阈值规则见 spec §1/§6）
  - `export async function runSkillUsageCommand(argv, io = createDefaultIo()) → { rows, notes }`（打印表格或 `--json`）

- [ ] **Step 1: Write the failing test**

`test/commands/skill-usage.test.js`：

```js
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
  assert.equal(alpha.status, "candidate", "无配置时 keep-alive 为空，计数 1 < 5 → candidate");
  assert.ok(result.notes.includes("未检测到 Codex"));
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(payload.skills.length, 1);
  assert.equal(payload.skills[0].name, "alpha");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/commands/skill-usage.test.js`
Expected: FAIL —— `Cannot find module '../../src/commands/skill-usage.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/commands/skill-usage.js`：

```js
import path from "node:path";
import { DEFAULT_ARCHIVING, loadCommandConfig } from "../config.js";
import { loadManifest, pinnedSkillNames } from "../archive.js";
import { listInstalledSkills } from "../skill-inventory.js";
import { scanUsage } from "../usage/scan.js";
import { createDefaultIo, defaultPaths } from "../io.js";

export function parseSkillUsageArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--config") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error("--config 缺少参数");
      options.config = value;
    } else {
      throw new Error(`未知 skill-usage 参数：${argument}`);
    }
  }
  return options;
}

export async function runSkillUsageCommand(argv, io = createDefaultIo()) {
  const options = parseSkillUsageArgs(argv);
  const config = await loadCommandConfig(options.config, io);
  const archiving = config?.archiving ?? { ...DEFAULT_ARCHIVING };
  const paths = defaultPaths(io.home);

  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  const inventory = await listInstalledSkills({ roots: paths.skillRoots, io });
  const scan = await scanUsage({
    claudeProjectsDir: path.join(io.home, ".claude", "projects"),
    codexSessionsDir: path.join(io.home, ".codex", "sessions"),
    statePath: paths.statePath,
    archiveRoot: paths.archiveDir,
    skillRoots: paths.skillRoots,
    keepNames: new Set([...inventory.map((item) => item.name), ...manifest.archived.map((entry) => entry.name)]),
    io
  });
  const pinned = pinnedSkillNames([config].filter(Boolean));
  const rows = buildReportRows({ inventory, manifest, usage: scan.usage, pinned, archiving });

  const notes = [];
  if (!scan.agents.claudeCode) notes.push("未检测到 Claude Code");
  if (!scan.agents.codex) notes.push("未检测到 Codex");

  if (options.json) {
    io.log(JSON.stringify({ generatedAt: new Date().toISOString(), notes, skills: rows }, null, 2));
  } else {
    io.log(renderReport(rows, notes));
  }
  return { rows, notes };
}

`src/config.js` 追加（在 `resolveConfigPath` 之后；Task 10 的 archive 命令也会用到）：

```js
export async function loadCommandConfig(explicitPath, io) {
  if (explicitPath) return loadConfig(explicitPath);
  const resolved = resolveConfigPath({ cwd: io.cwd, env: io.env, home: io.home, exists: io.exists });
  return resolved ? loadConfig(resolved) : null;
}
```

export function buildReportRows({ inventory, manifest, usage, pinned, archiving, nowMs = Date.now() }) {
  const rows = [];
  for (const item of inventory) {
    const usageInfo = usage.get(item.name);
    rows.push({
      name: item.name,
      locations: item.locations,
      usageCount: usageInfo?.count ?? 0,
      lastUsedAt: usageInfo?.lastUsedAt ?? null,
      status: classifyUsage({ name: item.name, installedAt: item.installedAt, usageInfo, pinned, archiving, nowMs })
    });
  }
  for (const entry of manifest.archived) {
    if (rows.some((row) => row.name === entry.name)) continue;
    const usageInfo = usage.get(entry.name);
    rows.push({
      name: entry.name,
      locations: [{ path: path.dirname(entry.skillFile), kind: "dir" }],
      usageCount: usageInfo?.count ?? entry.usageCount ?? 0,
      lastUsedAt: usageInfo?.lastUsedAt ?? entry.lastUsedAt ?? null,
      status: "archived"
    });
  }
  return rows;
}

function classifyUsage({ name, installedAt, usageInfo, pinned, archiving, nowMs }) {
  if (pinned.has(name)) return "pinned";
  if (typeof installedAt === "number" && nowMs - installedAt < archiving.newSkillGraceDays * 86400000) {
    return "active"; // 新装豁免期（spec §6）
  }
  if (usageInfo?.lastUsedAt && nowMs - Date.parse(usageInfo.lastUsedAt) > archiving.unusedAfterDays * 86400000) {
    return "candidate";
  }
  if ((usageInfo?.count ?? 0) < archiving.minInvocations) return "candidate";
  return "active";
}

function renderReport(rows, notes) {
  const lines = [];
  if (notes.length > 0) lines.push(`注意：${notes.join("；")}`);
  lines.push(`skill                                     调用次数  最近使用                    状态`);
  for (const row of rows) {
    lines.push(`${row.name.padEnd(41)}${String(row.usageCount).padEnd(9)}  ${(row.lastUsedAt ?? "-").padEnd(27)}${row.status}`);
    const locations = row.locations
      .map((location) => (location.kind === "link" ? `${location.path} -> ${location.target ?? "?"}` : location.path))
      .join("; ");
    lines.push(`    位置：${locations}`);
  }
  return lines.join("\n");
}
```

`bin/cs-nexus.js` 整体替换为：

```js
#!/usr/bin/env node

import { runCli } from "../src/setup.js";
import { runSkillUsageCommand } from "../src/commands/skill-usage.js";

const argv = process.argv.slice(2);
const [command = "help"] = argv;
const handler = command === "skill-usage" ? runSkillUsageCommand : runCli;

handler(command === "skill-usage" ? argv.slice(1) : argv).catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
```

`src/setup.js` 的 `helpText()` 改为：

```js
function helpText() {
  return `用法：
  cs-nexus setup [--config <path>] [--agent <name>] [--global|--project] [--dry-run] [--yes]
  cs-nexus skill-usage [--json] [--config <path>]
  cs-nexus archive <name...> [--yes] [--config <path>]
  cs-nexus archive --list [--json]
  cs-nexus archive --restore <name> [--to <dir>] [--config <path>]
  cs-nexus --version

setup 默认读取随包提供的 cs-nexus.yaml，展示完整安装计划并在执行前请求确认。
skill-usage 扫描 Claude Code 与 Codex 会话统计全局 skill 使用情况。
archive 将不常用 skill 迁入 ~/.cs-nexus/skill-archive 并登记清单，--restore 恢复。`;
}
```

`package.json` 的 `check` 脚本追加 `&& node --check src/commands/skill-usage.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/commands/skill-usage.test.js test/setup.test.js && npm run check`
Expected: PASS（已核对 test/setup.test.js 无 helpText 断言，helpText 变更不影响现有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/commands/skill-usage.js test/commands/skill-usage.test.js bin/cs-nexus.js src/setup.js package.json
git commit -m "feat(cli): add skill-usage report command with bin dispatch

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 10: archive 命令（确认制、跨项目保活、skills remove 注入）

**Files:**
- Create: `src/commands/archive.js`
- Create: `test/commands/archive.test.js`
- Modify: `bin/cs-nexus.js`（增加 archive 分支）
- Modify: `src/setup.js:189`（`function npxInvocation` 改为 `export function`，行为不变）
- Modify: `package.json`（check 脚本追加 `src/commands/archive.js`）

**Interfaces:**
- Consumes: `loadCommandConfig`（Task 9 加入 config.js）、`DEFAULT_ARCHIVING`、`loadManifest`/`archiveSkills`/`restoreSkill`/`pinnedSkillNames`（Task 6-8）、`listInstalledSkills`、`scanUsage`、`createDefaultIo`/`defaultPaths`、`npxInvocation`（setup.js 导出）。
- Produces:
  - `export function parseArchiveArgs(argv) → { names: string[], json, list?, yes?, restore?, to?, config? }`
  - `export async function runArchiveCommand(argv, io = createDefaultIo(), deps = {})`，`deps.removeWithSkillsCli` 可注入（默认走 `npx skills remove <name> --global --yes`，失败降级为警告，spec §4.5）。三种形态：`--list`、`--restore <name> [--to <dir>]`、`<name...> [--yes]`。
  - 归档形态内部流程：加载配置（`enabled: false` → throw）→ 清单+库存+扫描（快照 usageCount/lastUsedAt、拿 discoveredProjects）→ 合并保活配置 → 确认（`--yes` 跳过）→ `archiveSkills` → 逐名输出（spec §4.2/§4.4）。

- [ ] **Step 1: Write the failing test**

`test/commands/archive.test.js`：

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/commands/archive.test.js`
Expected: FAIL —— `Cannot find module '../../src/commands/archive.js'`。

- [ ] **Step 3: Write minimal implementation**

`src/setup.js`：`function npxInvocation(args, io) {` 改为 `export function npxInvocation(args, io) {`。

`src/commands/archive.js`：

```js
import path from "node:path";
import process from "node:process";
import { DEFAULT_ARCHIVING, loadCommandConfig } from "../config.js";
import { archiveSkills, loadManifest, pinnedSkillNames, restoreSkill } from "../archive.js";
import { listInstalledSkills } from "../skill-inventory.js";
import { scanUsage } from "../usage/scan.js";
import { createDefaultIo, defaultPaths } from "../io.js";
import { npxInvocation } from "../setup.js";

export function parseArchiveArgs(argv) {
  const options = { names: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.list = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (["--config", "--restore", "--to"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error(`${argument} 缺少参数`);
      options[argument.slice(2)] = value;
    } else if (argument.startsWith("-")) {
      throw new Error(`未知 archive 参数：${argument}`);
    } else {
      options.names.push(argument);
    }
  }
  return options;
}

export async function runArchiveCommand(argv, io = createDefaultIo(), deps = {}) {
  const options = parseArchiveArgs(argv);
  const paths = defaultPaths(io.home);

  if (options.list) return listEntries(options, paths, io);
  if (options.restore) return restoreOne(options, paths, io);
  return archiveMany(options, paths, io, deps);
}

async function listEntries(options, paths, io) {
  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  if (options.json) {
    io.log(JSON.stringify(manifest, null, 2));
  } else if (manifest.archived.length === 0) {
    io.log("归档区为空。");
  } else {
    for (const entry of manifest.archived) {
      io.log(`${entry.name}  归档于 ${entry.archivedAt ?? "未知时间"}  原调用 ${entry.usageCount ?? 0} 次`);
      io.log(`    ${entry.description ?? "（无描述）"}`);
    }
  }
  return manifest;
}

async function restoreOne(options, paths, io) {
  if (options.names.length > 0) throw new Error("--restore 不接受额外名称参数");
  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  const result = await restoreSkill({
    name: options.restore,
    targetDir: options.to ?? null,
    manifest,
    manifestPath: paths.manifestPath,
    archiveDir: paths.archiveDir,
    lockPath: paths.lockPath,
    io
  });
  if (result.status === "restored") {
    io.log(`已恢复 ${result.name} → ${result.restoredTo}`);
    if (result.lockRestored === false) {
      io.log("提示：skills lock 元数据未回写（快照缺失或版本不兼容）；如需 update 能力可重新安装。");
    }
  } else if (result.status === "no-origin") {
    io.log(`无法恢复 ${result.name}：${result.message}`);
    process.exitCode = 1;
  } else {
    io.log(`清单中没有 ${result.name}。`);
    process.exitCode = 1;
  }
  return result;
}

async function archiveMany(options, paths, io, deps) {
  if (options.names.length === 0) throw new Error("缺少要归档的 skill 名，用法见 cs-nexus --help");
  const config = await loadCommandConfig(options.config, io);
  const archiving = config?.archiving ?? { ...DEFAULT_ARCHIVING };
  if (!archiving.enabled) throw new Error("archiving 已在配置中禁用（archiving.enabled: false）");

  const manifest = await loadManifest(paths.manifestPath, { archiveDir: paths.archiveDir, io });
  const inventory = await listInstalledSkills({ roots: paths.skillRoots, io });
  const scan = await scanUsage({
    claudeProjectsDir: path.join(io.home, ".claude", "projects"),
    codexSessionsDir: path.join(io.home, ".codex", "sessions"),
    statePath: paths.statePath,
    archiveRoot: paths.archiveDir,
    skillRoots: paths.skillRoots,
    keepNames: new Set([...inventory.map((item) => item.name), ...manifest.archived.map((entry) => entry.name)]),
    io
  });

  const configs = await collectKeepAliveConfigs({ config, discoveredProjects: scan.discoveredProjects, io });
  const pinned = pinnedSkillNames(configs);

  if (!options.yes) {
    const approved = await io.confirm(`将归档以下 skill：${options.names.join(", ")}，是否继续？ [y/N] `);
    if (!approved) {
      io.log("已取消，未做任何修改。");
      return { cancelled: true };
    }
  }

  const removeWithSkillsCli = deps.removeWithSkillsCli ?? createSkillsRemove(io);
  const { results } = await archiveSkills({
    names: options.names,
    inventory,
    usage: scan.usage,
    manifest,
    manifestPath: paths.manifestPath,
    archiveDir: paths.archiveDir,
    lockPath: paths.lockPath,
    pinned,
    io,
    removeWithSkillsCli
  });
  for (const result of results) {
    if (result.status === "archived") {
      io.log(`已归档 ${result.name}（清单已登记，动态加载可用）。`);
      for (const copy of result.differingCopies ?? []) {
        io.log(`  提示：副本内容与首份不一致，已按首份归档：${copy}`);
      }
    } else if (result.status === "refused") {
      io.log(`拒绝归档 ${result.name}：${result.reason}`);
      process.exitCode = 1;
    } else if (result.status === "already-archived") {
      io.log(`${result.name} 已在归档区，跳过。`);
    } else {
      io.log(`未找到已安装的 skill：${result.name}`);
      process.exitCode = 1;
    }
  }
  return { results };
}

async function collectKeepAliveConfigs({ config, discoveredProjects, io }) {
  const configs = [];
  const seen = new Set();
  const warnings = [];

  if (config) {
    configs.push(config);
    seen.add(config.configPath);
  }
  for (const project of discoveredProjects) {
    try {
      const resolved = resolveConfigPath({ cwd: project, env: {}, home: io.home, exists: io.exists });
      if (!resolved) continue;
      const loaded = await loadConfig(resolved);
      if (seen.has(loaded.configPath)) continue;
      seen.add(loaded.configPath);
      configs.push(loaded);
    } catch (error) {
      warnings.push(`${project}：${error.message}`); // 单项目配置损坏 → 跳过并提示（spec §4.4）
    }
  }
  const globalPath = path.join(io.home, ".cs-nexus", "cs-nexus.yaml");
  if (io.exists(globalPath) && !seen.has(globalPath)) {
    try {
      configs.push(await loadConfig(globalPath));
    } catch (error) {
      warnings.push(`全局配置：${error.message}`);
    }
  }

  for (const warning of warnings) io.log(`提示：跳过一份配置（${warning}）`);
  return configs;
}

function createSkillsRemove(io) {
  return async (name) => {
    const [executable, ...args] = npxInvocation(["--yes", "skills", "remove", name, "--global", "--yes"], io);
    const result = io.spawn(executable, args, { stdio: "ignore", shell: false });
    if (result.error || (result.status !== 0 && result.status !== null)) {
      io.log(`警告：skills remove 清理 ${name} 失败（lock 残留可稍后手动清理）。`);
    }
  };
}
```

注意：`collectKeepAliveConfigs` 里用到 `resolveConfigPath` 和 `loadConfig`——在文件顶部 import 中补上（`import { DEFAULT_ARCHIVING, loadCommandConfig, loadConfig, resolveConfigPath } from "../config.js";`）。

`bin/cs-nexus.js` 整体替换为：

```js
#!/usr/bin/env node

import { runCli } from "../src/setup.js";
import { runSkillUsageCommand } from "../src/commands/skill-usage.js";
import { runArchiveCommand } from "../src/commands/archive.js";

const argv = process.argv.slice(2);
const [command = "help"] = argv;
const ownCommands = new Set(["skill-usage", "archive"]);
const handler = command === "skill-usage" ? runSkillUsageCommand
  : command === "archive" ? runArchiveCommand
  : runCli;

handler(ownCommands.has(command) ? argv.slice(1) : argv).catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
```

`package.json` 的 `check` 脚本追加 `&& node --check src/commands/archive.js`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/commands/archive.test.js test/commands/skill-usage.test.js test/setup.test.js && npm run check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/commands/archive.js test/commands/archive.test.js bin/cs-nexus.js src/setup.js package.json
git commit -m "feat(cli): add archive command with cross-project keep-alive

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 11: skill-manager skill 与配置接线

**Files:**
- Create: `skills/skill-manager/SKILL.md`
- Create: `skills/skill-manager/agents/openai.yaml`
- Modify: `cs-nexus.yaml`（providers + installation.include）
- Modify: `skills/task-router/SKILL.md`（"Add capabilities on demand" 补一句）
- Modify: `test/setup.test.js`（安装计划数字随 include 变化同步）

**Interfaces:**
- Consumes: CLI 命令 `skill-usage` / `archive`（Task 9-10）、归档清单路径 `~/.cs-nexus/skill-archive.json`。
- Produces: 名为 `skill-manager` 的本地 provider（`local:skill-manager`），随 setup 安装。

- [ ] **Step 1: Write the skill files**

`skills/skill-manager/SKILL.md`：

```markdown
---
name: skill-manager
description: 查看/整理 skill 使用情况、归档不常用 skill、恢复或按需加载已归档 skill。当任务需要的 capability 没有已安装 skill 可用时，先查归档清单 ~/.cs-nexus/skill-archive.json，按绝对路径 Read 加载已归档 skill 的 SKILL.md 并严格按其内容执行。用户要求统计 skill 使用、清理不常用 skill、恢复或动态加载已归档 skill 时使用；本 skill 绝不直接移动、删除或修改 skill 文件，一切文件操作走 cs-nexus CLI。
---

# Skill Manager

管理本机全局 skill 的生命周期：使用统计 → 归档 → 按需动态加载 → 恢复。

## 行为协议

1. **查清单**：读 `~/.cs-nexus/skill-archive.json`；文件不存在即当前无归档。
2. **动态加载**：按清单条目的 description 匹配任务所需能力 → `Read` 该条目 `skillFile` 字段的绝对路径 → 严格按其内容执行（skill 本质是 markdown 注入，读取即等效正式加载；附属脚本/引用文件随整目录归档，相对路径仍有效）。
3. **管理指引**：建议用户运行 `cs-nexus skill-usage` 查看使用报告（含归档计数）；确认名单后运行 `cs-nexus archive <names>` 归档；恢复运行 `cs-nexus archive --restore <name>`。若近期多次按需加载同一 skill（报告 usageCount 持续增长），主动建议 restore。
4. **边界**：绝不直接移动/删除/修改任何 skill 文件或清单文件；一切文件操作走 cs-nexus CLI。

## 已知限制

- 归档后 `/name` 斜杠命令入口消失；用户显式点名已归档 skill 时，直接读清单按第 2 条加载。
- 归档区内容是归档时的快照；如需更新，先 restore 再 `skills update`。
```

`skills/skill-manager/agents/openai.yaml`：

```yaml
interface:
  display_name: "Skill Manager"
  short_description: "查看 skill 使用情况，归档不常用 skill，按需加载已归档 skill"
  default_prompt: "Use $skill-manager to review skill usage or load an archived skill."
```

- [ ] **Step 2: Wire cs-nexus.yaml**

`providers:` 段（`local:task-router` 之后）追加：

```yaml
  local:skill-manager:
    source: ./skills/skill-manager
    name: skill-manager
    install:
      type: agent-skill
```

`installation.include` 改为：

```yaml
  include:
    - local:task-router
    - local:skill-manager
```

- [ ] **Step 3: Patch task-router SKILL.md**

`skills/task-router/SKILL.md` "Add capabilities on demand" 一节，将：

```text
If no configured provider exists, prefer project skills, team skills, configured trusted skills, then mainstream community skills. Recommend discovery before building a reusable capability from scratch.
```

改为：

```text
If no configured provider exists, prefer project skills, team skills, configured trusted skills, then mainstream community skills. Before turning to the community, check the skill-manager archive manifest (`~/.cs-nexus/skill-archive.json`) for an archived skill that already provides the capability and load it via skill-manager. Recommend discovery before building a reusable capability from scratch.
```

- [ ] **Step 4: Update setup test expectations and verify**

`test/setup.test.js` 三处数字与一处 fixture 同步（include 多了 `local:skill-manager`，本地源不同会多出一个安装步骤）：

- `installedSkills` 数组追加 `"skill-manager"`（test/setup.test.js:19-31）；
- `assert.equal(plan.agentSkills.length, 3);` → `assert.equal(plan.agentSkills.length, 4);`（test/setup.test.js:89）；
- `assert.equal(calls.length, 4);` → `assert.equal(calls.length, 5);`（test/setup.test.js:122）；
- 两处 `calls.slice(0, 3)` → `calls.slice(0, 4)`（test/setup.test.js:125-126）；
- dry-run 用例可加一行 `assert.match(logs.join("\n"), /skill-manager/);`。

Run: `node --test test/setup.test.js test/config.test.js test/install-plan.test.js`
Expected: PASS。

再跑配置冒烟（验证 cs-nexus.yaml 仍能通过校验且 provider/include 生效）：

```bash
node -e "import('./src/config.js').then(async (m) => { const c = await m.loadConfig('cs-nexus.yaml'); if (!c.providers['local:skill-manager']) throw new Error('providers missing'); if (!c.installation.include.includes('local:skill-manager')) throw new Error('include missing'); console.log('ok'); })"
```

Expected: 输出 `ok`。

- [ ] **Step 5: Commit**

```bash
git add skills/skill-manager cs-nexus.yaml skills/task-router/SKILL.md test/setup.test.js
git commit -m "feat(skills): add skill-manager skill and wire providers

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 12: 全量验证与真机冒烟

**Files:**
- Modify: 无新文件（验证任务；如冒烟暴露问题，回对应任务修复后重跑）

**Interfaces:**
- Consumes: 全部前序任务产物。
- Produces: 可交付状态（全部测试通过 + 真机只读冒烟通过）。

- [ ] **Step 1: Run the full test suite**

Run: `node --test`
Expected: 全部 PASS（test/config、dependencies、install-plan、setup、skill-inventory、archive、usage/claude-code、usage/codex、usage/scan、commands/skill-usage、commands/archive）。

- [ ] **Step 2: Run syntax check**

Run: `npm run check`
Expected: 无输出（全部 `node --check` 通过）。

- [ ] **Step 3: Real-machine read-only smoke**

```bash
node bin/cs-nexus.js skill-usage --json
node bin/cs-nexus.js archive --list
node bin/cs-nexus.js
```

Expected:
- 第一条：输出 JSON，`skills` 数组包含本机真实安装的 skill（本机预期 ≥ 20 条：`.agents` 13 + `.claude` 12 + `.codex` 8 去重合并），`notes` 视本机 agent 安装情况；会在真实 `~/.cs-nexus/usage-state.json` 写入游标（这是功能自身的状态数据，预期行为）。
- 第二条：输出 `归档区为空。`（或既有清单内容）。
- 第三条：help 文案包含 `skill-usage` 与 `archive` 用法。

- [ ] **Step 4: Verify spec §10 implementation-time checkpoints against real data**

对照 spec §10 逐项确认（只读检查，不改代码；结论记录在最终汇报里）：

1. 抽一条真实 Claude transcript，确认信号①/②/③ 的形态与 fixture 一致；
2. 抽一条真实 Codex rollout，确认 `function_call` 读取命令与提及型误报的匹配边界；
3. 确认 Windows 无管理员权限下 junction 创建/摘除正常（Task 4/7/8 测试已覆盖，此处复核测试确实在本机跑过而非跳过）。

- [ ] **Step 5: Final commit (if any fixups were needed)**

```bash
git status --short
git add -A && git commit -m "test: full verification for skill usage archiving

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

（若工作区已干净则跳过本步。）

---

## Spec Coverage Map（自查用，执行者可忽略）

| Spec 章节 | 落点 |
|---|---|
| §2.1 Codex 信号硬性约束 | Task 3（实现 + developer 消息回归用例） |
| §2.2 skills CLI 布局事实 | Task 4（lstat/链接识别）、Task 7/8（摘链/重建） |
| §4.1 模块表 | Task 2-6 与 src/commands/* 一一对应 |
| §4.2 命令与报告列 | Task 9（skill-usage + 状态分类）、Task 10（archive 三形态） |
| §4.3 清单数据模型（origin.entries/lockEntry/version 2） | Task 6/7 |
| §4.4 保活规则 + 配置作用域合并 | Task 6（pinnedSkillNames）、Task 10（collectKeepAliveConfigs） |
| §4.5 symlink 归档/恢复顺序 | Task 7（摘链→迁实体→skills remove）、Task 8（迁回→重建链接→lock 回写） |
| §4.6 增量游标替换语义 | Task 5 |
| §5 skill-manager + task-router 补丁 | Task 11 |
| §6 archiving 配置 + 四级解析 + 豁免期 | Task 1（配置）、Task 9（grace/candidate 分类） |
| §7 数据流（归档区计数闭环） | Task 2（信号③）、Task 3（archiveRoot 匹配）、Task 9（archived 行计数） |
| §8 错误处理表 | Task 5（坏行/缺目录/坏状态）、Task 6（清单重建）、Task 7/8（幂等/保活/冲突/no-origin）、Task 10（skills remove 失败降级、enabled=false） |
| §9 测试计划 | 各任务测试文件 + Task 12 全量 |
| §10 验证点 1-5 | Task 12 Step 4 |
| §11 范围外 | 未实现（auto 归档、history.jsonl、跨机器同步、项目级 skill）——符合设计 |

