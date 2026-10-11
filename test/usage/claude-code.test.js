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
