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
