import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.js";

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
