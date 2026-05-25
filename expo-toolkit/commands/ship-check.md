---
description: Pre-ship gate for any change about to be deployed to a published RN+Expo app. Classifies the diff as OTA-safe vs native-rebuild (per expo-release-discipline), runs expo-security-reviewer on the diff, and emits a CHANGELOG entry stub the user can fill in. Use before `eas update` or `eas build` to catch misclassification + privacy regressions.
allowed-tools: Task, Bash, Read, Grep, Glob
---

This command is a **read-only gate**. It does NOT ship anything. It classifies the diff against the `expo-release-discipline` rules, runs a security review via the `expo-security-reviewer` agent, and emits a CHANGELOG stub for the human to paste, fill in, and commit manually after the actual EAS command completes.

## Step 1 — Identify the diff

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE=$(git merge-base HEAD origin/main 2>/dev/null \
     || git merge-base HEAD master 2>/dev/null \
     || git merge-base HEAD main)
git diff --name-only "$BASE"...HEAD
git diff --stat "$BASE"...HEAD
```

If the diff is empty, stop here and report: **no changes to ship**.

## Step 2 — Classify

Walk every file in the changed-file list and emit **one verdict** for the entire diff, with a per-file rationale.

**NATIVE_REBUILD** — required if ANY of the following is true for any changed file:
- `app.config.ts` touched (plugins, infoPlist, icon, splash, scheme, `version`, `runtimeVersion`, owner, bundleIdentifier, capabilities)
- `package.json` adds or removes a package with native code (`react-native-*`, `expo-*` modules, any non-pure-JS package)
- Capability changes in App Store Connect or Play Console configuration
- Icon or splash screen assets changed
- Minimum iOS or Android version bumped
- App Privacy declarations affected (new data collection or sharing)
- Age-rating-affecting content changes
- Subscription product, price, or trial term changes

**OTA_SAFE** — only if ALL changed files are in these categories:
- JS / TSX / styles / hooks / components
- Bundled copy, layout changes
- Logic fixes, performance optimizations, bug fixes
- Localizations
- A/B tests of existing UX (not paywall structure)

**UNCLEAR** — at least one file cannot be confidently classified. List each uncertain file and explain why. Ask the human to resolve before proceeding.

> Rule of thumb: **when unsure → NATIVE_REBUILD.** The cost of an unnecessary rebuild is ~30 min; the cost of a mistaken OTA in a health/finance/children-category app is potential account suspension.

## Step 3 — Runtime-version sanity

If `app.config.ts` is in the diff, read the file and check the `runtimeVersion` field.

- If `runtimeVersion.policy === 'fingerprint'` → pass.
- If `runtimeVersion.policy === 'appVersion'` → emit a **BLOCKER**:

  > `appVersion` couples the OTA runtime to a manually edited string. This is the documented root cause of runtime-skew incidents where OTAs pushed at runtime `X` are invisible to the embedded cohort sitting at runtime `Y` after a version bump. Fix:
  > ```ts
  > runtimeVersion: { policy: 'fingerprint' }
  > ```

- If the field is absent or set to a literal string → flag as **WARNING** (fingerprint policy is strongly preferred; a hardcoded string requires manual discipline to avoid skew).

## Step 4 — Security review

Dispatch the `expo-security-reviewer` agent via the Task tool, scoped to the diff produced in Step 1.

If `expo-security-reviewer` is not installed, fall back in order: `cso` → `cybersecurity` → `security-review`.

Wait for the agent's report. If the verdict is **BLOCKING-ISSUES**, surface each finding prominently before the summary verdict in Step 6.

## Step 5 — CHANGELOG stub

Emit the following fenced block, pre-filled where possible:

- Run `git log -1 --format=%H` → commit SHA.
- Run `date +%Y-%m-%d` → today's date.
- Use the branch name from Step 1 as the channel hint.
- Use the classification verdict from Step 2 → `Build` (NATIVE_REBUILD) or `OTA` (OTA_SAFE).

```markdown
## [<Build|OTA>] <YYYY-MM-DD> — <platforms>
- Channel: <branch-name / production>
- <Build|Update> ID: <fill-after-eas>
- Runtime: <fill>
- Commit: <sha>
- Paired API deploy: <ref or N/A>

### Changes
- <bullet 1>
- <bullet 2>
```

Tell the user:
> Paste this block into `CHANGELOG.md`. Fill every `<fill-…>` placeholder after running the EAS command — the build or update ID is only known post-run. Then `git add CHANGELOG.md` manually and commit it alongside any other staged changes. Do NOT commit until the EAS run succeeds.

## Step 6 — Summary verdict

Emit one of:

- **READY-TO-SHIP** — classification is unambiguous, no security blockers, no runtime-policy issues.
- **READY-WITH-NOTES** — classified successfully, but there are MEDIUM/LOW security findings or non-blocking notes the human should be aware of.
- **BLOCKING-ISSUES** — at least one of: UNCLEAR classification unresolved, NATIVE_REBUILD verdict not acknowledged, runtime-policy BLOCKER, or security BLOCKING-ISSUES from the reviewer.

List:
1. Classification verdict (OTA_SAFE / NATIVE_REBUILD / UNCLEAR) with per-file rationale.
2. Runtime-version sanity result.
3. Security review verdict + any findings.
4. Any open blockers.

Close with:

> This command never deploys. Run the actual `eas update` or `eas build` yourself once all blockers are resolved.

## Rules

- NEVER run `git add`, `git commit`, `eas update`, `eas build`, or any write/deploy command.
- READ-ONLY: this command analyzes; the human ships.
- If the diff is empty, exit early with "no changes to ship".
- Do not invent classification verdicts — if a file is ambiguous, emit UNCLEAR and ask.
