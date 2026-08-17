import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkillClosure } from "../src/dependencies.js";

test("resolveSkillClosure installs dependencies first and deduplicates them", () => {
  const result = resolveSkillClosure(["a:root", "a:other"], {
    "a:root": ["a:shared", "a:leaf"],
    "a:other": ["a:shared"],
    "a:shared": ["a:leaf"]
  });

  assert.deepEqual(result, ["a:leaf", "a:shared", "a:root", "a:other"]);
});

test("resolveSkillClosure reports the complete cycle", () => {
  assert.throws(
    () => resolveSkillClosure(["a:one"], {
      "a:one": ["a:two"],
      "a:two": ["a:three"],
      "a:three": ["a:one"]
    }),
    /a:one -> a:two -> a:three -> a:one/
  );
});
