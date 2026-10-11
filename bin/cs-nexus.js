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
