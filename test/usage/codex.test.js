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
