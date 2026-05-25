#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) hook — auto-format the touched file with
// oxlint --fix + prettier --write, if the file is a TS/JS variant under a
// directory that has a package.json. Best-effort: never blocks, never prints.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname } from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let filePath;
  try { filePath = JSON.parse(raw)?.tool_input?.file_path; } catch { /* silent */ }
  if (!filePath) process.exit(0);

  const ext = extname(filePath).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) process.exit(0);

  // Walk up to the nearest package.json
  let dir = dirname(filePath);
  while (dir !== "/" && dir !== "." && !existsSync(`${dir}/package.json`)) {
    dir = dirname(dir);
  }
  if (!existsSync(`${dir}/package.json`)) process.exit(0);

  const opts = { cwd: dir, stdio: "ignore" };
  // pnpm first, npx fallback. spawnSync returns status<0 (ENOENT) if missing.
  const pnpmOk = spawnSync("pnpm", ["exec", "oxlint", "--fix", filePath], opts).status === 0;
  if (pnpmOk) {
    spawnSync("pnpm", ["exec", "prettier", "--write", filePath], opts);
  } else {
    spawnSync("npx", ["--no-install", "oxlint", "--fix", filePath], opts);
    spawnSync("npx", ["--no-install", "prettier", "--write", filePath], opts);
  }
  process.exit(0);
});
