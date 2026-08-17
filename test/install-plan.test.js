import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { buildListArgs, buildNpxArgs, createInstallPlan } from "../src/install-plan.js";

test("createInstallPlan groups agent skills by source and separates external providers", () => {
  const configPath = path.resolve("fixtures/ai-coding.yaml");
  const config = validateConfig({
    version: 1,
    routing: {
      design: "obra/superpowers:brainstorming",
      planning: "obra/superpowers:writing-plans",
      browser: "browser:browser-skill",
      internal: "company:deploy"
    },
    providers: {
      "local:task-router": {
        source: "../skills/task-router",
        name: "task-router"
      },
      "browser:browser-skill": {
        install: { type: "upstream-guide", url: "https://example.com/install", actions: ["Install extension"] }
      },
      "company:deploy": {
        install: { type: "command", command: ["company-cli", "install"], verify: [["company-cli", "doctor"]] }
      }
    },
    installation: { include: ["local:task-router"], scope: "global" }
  }, configPath);

  const plan = createInstallPlan(config, { agent: "codex" });

  assert.deepEqual(plan.agentSkills[0], {
    type: "agent-skill",
    source: "obra/superpowers",
    scope: "global",
    copy: false,
    skills: ["brainstorming", "writing-plans"]
  });
  assert.equal(plan.agentSkills[1].source, path.resolve("skills/task-router"));
  assert.equal(plan.agentSkills[1].copy, true);
  assert.equal(plan.manual[0].url, "https://example.com/install");
  assert.deepEqual(plan.commands[0].command, ["company-cli", "install"]);
});

test("createInstallPlan expands dependency closure and rejects unresolved references", () => {
  const config = validateConfig({
    version: 1,
    routing: { entry: "owner/repo:entry" },
    dependencies: { "owner/repo:entry": ["owner/repo:base"] }
  });
  const plan = createInstallPlan(config, { agent: "codex" });
  assert.deepEqual(plan.agentSkills[0].skills, ["base", "entry"]);

  const invalid = validateConfig({ version: 1, routing: { entry: "unresolved" } });
  assert.throws(() => createInstallPlan(invalid, { agent: "codex" }), /缺少 provider 声明/);
});

test("createInstallPlan preserves dependency order across installer types", () => {
  const config = validateConfig({
    version: 1,
    routing: { entry: "owner/repo:entry" },
    dependencies: {
      "owner/repo:entry": ["company:runtime"],
      "company:runtime": ["owner/repo:base"]
    },
    providers: {
      "company:runtime": {
        install: { type: "command", command: ["company-cli", "install-runtime"] }
      }
    }
  });

  const plan = createInstallPlan(config, { agent: "codex" });
  assert.deepEqual(plan.steps.map((step) => step.type), ["agent-skill", "command", "agent-skill"]);
  assert.deepEqual(plan.steps[0].skills, ["base"]);
  assert.deepEqual(plan.steps[2].skills, ["entry"]);
});

test("npx arguments are non-interactive and preserve installation scope", () => {
  assert.deepEqual(buildNpxArgs({
    source: "owner/repo",
    scope: "global",
    copy: false,
    skills: ["one", "two"]
  }, "codex"), [
    "--yes", "skills", "add", "owner/repo",
    "--skill", "one", "--skill", "two",
    "--global", "--agent", "codex", "--yes"
  ]);
  assert.ok(buildNpxArgs({
    source: path.resolve("skills/task-router"),
    scope: "global",
    copy: true,
    skills: ["task-router"]
  }, "codex").includes("--copy"));
  assert.deepEqual(buildListArgs("project", "codex"), ["--yes", "skills", "list", "--agent", "codex", "--json"]);
});
