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
