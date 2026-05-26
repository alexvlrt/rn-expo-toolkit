#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) hook — auto-format the touched file with
// oxlint --fix + prettier --write, but ONLY inside a React Native / Expo
// project. This lets the plugin be installed user-wide without reformatting
// files in unrelated (Laravel, web, plain-Node…) repos. Best-effort: never
// blocks, never prints.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";

// Treat the touched file as belonging to an Expo/RN project if, walking up from
// it, any level has a package.json declaring expo/react-native or an Expo
// `app.config.{ts,js}`, OR the repo root has an `app.json` or a monorepo
// workspace (apps/* | packages/*) that is itself RN. The app config / workspace
// checks are NOT gated behind `.git`, so a freshly-created Expo app (no git yet)
// still counts. Cheap, synchronous, best-effort — returns false, never throws.
function isExpoProject(startDir) {
  const RN_DEPS = ["expo", "react-native", "expo-router"];
  const hasRnDeps = (pkgPath) => {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      return RN_DEPS.some((d) => d in deps);
    } catch {
      return false;
    }
  };
  // `app.config.{ts,js}` is Expo-specific → safe to trust at any level. `app.json`
  // is ambiguous (other tools use it) → only trusted at the repo root.
  const hasExpoConfig = (d) => existsSync(`${d}/app.config.ts`) || existsSync(`${d}/app.config.js`);
  // Any apps/* or packages/* workspace that is itself an RN package.
  const hasRnWorkspace = (d) =>
    ["apps", "packages"].some((group) => {
      let entries;
      try {
        entries = readdirSync(`${d}/${group}`, { withFileTypes: true });
      } catch {
        return false; // no such workspace dir
      }
      return entries.some((e) => e.isDirectory() && hasRnDeps(`${d}/${group}/${e.name}/package.json`));
    });

  let dir = startDir;
  for (;;) {
    if (hasRnDeps(`${dir}/package.json`) || hasExpoConfig(dir)) return true;
    // Repo root: trust the ambiguous app.json here, and scan monorepo workspaces.
    if (existsSync(`${dir}/.git`)) return existsSync(`${dir}/app.json`) || hasRnWorkspace(dir);
    const parent = dirname(dir);
    if (parent === dir) return false; // filesystem root, no RN signal
    dir = parent;
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let filePath;
  try { filePath = JSON.parse(raw)?.tool_input?.file_path; } catch { /* silent */ }
  if (!filePath) process.exit(0);

  const ext = extname(filePath).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) process.exit(0);

  // Scope to RN/Expo projects only — no-op in unrelated repos.
  if (!isExpoProject(dirname(filePath))) process.exit(0);

  // Walk up to the nearest package.json (the cwd we format from).
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
