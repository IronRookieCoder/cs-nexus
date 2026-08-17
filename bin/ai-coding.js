#!/usr/bin/env node

import { runCli } from "../src/setup.js";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
