#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) hook — WARNS (does NOT block) when a JSX
// text literal that looks like prose is added to a .tsx file without an i18n
// wrapper (t("…")). Heuristic — best-effort, ALWAYS exit 0.

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let toolInput;
  try { toolInput = JSON.parse(raw)?.tool_input; } catch { /* silent */ }
  if (!toolInput) process.exit(0);

  const filePath = toolInput.file_path ?? "";
  if (!/\.tsx?$/.test(filePath)) process.exit(0);
  // Limit to mobile dir. Edit this regex if your mobile lives elsewhere.
  if (!/(^|\/)apps\/mobile\//.test(filePath)) process.exit(0);

  // Collect added content from Edit (new_string), Write (content), MultiEdit (edits[].new_string)
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

  // Heuristic: JSX text node between `>` and `<` that looks like prose.
  // Capital-letter start, ≥6 chars, ≤16 words.
  const JSX_TEXT = />\s*([A-Z][\w''\-]+(?:\s+[\w''\-]+){0,15}[.!?]?)\s*</g;

  const lines = content.split("\n");
  const warnings = [];

  lines.forEach((line, i) => {
    // Skip lines that already use translation
    if (/\bt\(/.test(line)) return;
    // Skip non-JSX lines
    if (/^\s*(import|export|return|const|let|var|function|interface|type|\/\/|\*)/.test(line)) return;
    // Skip if explicitly marked
    if (/i18n-key-guard:\s*skip/i.test(line)) return;

    JSX_TEXT.lastIndex = 0;
    let m;
    while ((m = JSX_TEXT.exec(line))) {
      const text = m[1].trim();
      if (text.length < 6) continue;
      if (/^[A-Z_]+$/.test(text)) // ALL_CAPS const-like
        continue;
      if (/^(true|false|null|undefined)$/i.test(text)) continue;
      warnings.push(`  line ${i + 1}: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
      break;
    }
  });

  if (warnings.length) {
    console.error("i18n-key-guard: possible untranslated user-facing strings (warning only — does not block).");
    console.error(`File: ${filePath}`);
    for (const w of warnings) console.error(w);
    console.error('Wrap in t("…") if user-facing, or add `/* i18n-key-guard: skip */` on the line if intentional.');
  }
  process.exit(0); // ALWAYS allow — heuristic warns only
});
