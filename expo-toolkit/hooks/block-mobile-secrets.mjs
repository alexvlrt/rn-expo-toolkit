#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit) hook — block edits that introduce an
// API-key-looking literal under apps/mobile/**. Exits 2 with stderr message
// to block the tool call. CLAUDE.md: never store API keys in mobile code
// (server-side env vars only).

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let toolInput;
  try { toolInput = JSON.parse(raw)?.tool_input; } catch { /* silent */ }
  if (!toolInput) process.exit(0);

  const filePath = toolInput.file_path ?? "";
  if (!filePath) process.exit(0);

  // Match anywhere in the path: /apps/mobile/ OR starting with apps/mobile/
  if (!/(^|\/)apps\/mobile\//.test(filePath)) process.exit(0);

  // Collect added content from Edit (new_string), Write (content), and
  // MultiEdit (edits[].new_string).
  const parts = [];
  if (typeof toolInput.new_string === "string") parts.push(toolInput.new_string);
  if (typeof toolInput.content === "string") parts.push(toolInput.content);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (typeof e?.new_string === "string") parts.push(e.new_string);
    }
  }
  const content = parts.join("\n");
  if (!content) process.exit(0);

  // Patterns: Stripe live/test, OpenAI sk-, AWS access key, Google API key,
  // GitHub PAT/OAuth, RevenueCat-ish prefixes. Tune as needed.
  const patterns = [
    /sk_(live|test)_[A-Za-z0-9]{16,}/,
    /pk_(live|test)_[A-Za-z0-9]{16,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /AIza[0-9A-Za-z_-]{35}/,
    /gho_[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /appl_[A-Za-z0-9]{20,}/,
    /goog_[A-Za-z0-9]{20,}/,
  ];

  const violations = [];
  content.split("\n").forEach((line, i) => {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        violations.push(`  line ${i + 1}: ${m[0].slice(0, 24)}…`);
        break;
      }
    }
  });

  if (violations.length) {
    console.error("BLOCKED by rn-expo-toolkit: API-key-shaped literal in apps/mobile/");
    console.error(`File: ${filePath}`);
    console.error("Match(es):");
    for (const v of violations) console.error(v);
    console.error("");
    console.error("Per CLAUDE.md: never store API keys in mobile code (server-side env vars only).");
    console.error("If this is a false positive, refactor to keep the secret server-side or rename the literal.");
    process.exit(2);
  }
  process.exit(0);
});
