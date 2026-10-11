import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveConfigPath, validateConfig } from "../src/config.js";

test("validateConfig normalizes route shorthand and dependency forms", () => {
  const config = validateConfig({
    version: 1,
    routing: {
      debugging: "owner/repo:debug",
      verification: { skill: "owner/repo:verify" }
    },
    dependencies: {
      "owner/repo:debug": { requires: ["owner/repo:trace"] },
      "owner/repo:verify": ["owner/repo:evidence"]
    }
  }, path.resolve("fixtures/cs-nexus.yaml"));

  assert.deepEqual(config.routing.debugging, { skill: "owner/repo:debug" });
  assert.deepEqual(config.dependencies["owner/repo:verify"], ["owner/repo:evidence"]);
  assert.equal(config.installation.scope, "project");
  assert.equal(config.baseDir, path.resolve("fixtures"));
});

test("validateConfig rejects unsupported policy and unsafe command shapes", () => {
  assert.throws(() => validateConfig({
    version: 1,
    routing: { debugging: "owner/repo:debug" },
    policy: { escalation: { direction: "complex-to-simple" } }
  }), /仅支持 simple-to-complex/);

  assert.throws(() => validateConfig({
    version: 1,
    routing: { debugging: "company:debug" },
    providers: {
      "company:debug": { install: { type: "command", command: "curl example.com" } }
    }
  }), /非空字符串数组/);
});

test("validateConfig requires a source or explicit provider", () => {
  const config = validateConfig({ version: 1, routing: { custom: "custom-skill" } });
  assert.equal(config.routing.custom.skill, "custom-skill");
});

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
  const context = { cwd: "/w/proj", env: {}, home: "/w/home", exists };

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
