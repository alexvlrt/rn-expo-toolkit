---
description: Run the post-implementation review pipeline on the current diff — code-simplifier first (clean up dead/redundant code), then code-review (correctness, spec compliance). Use after any non-trivial change before declaring done.
allowed-tools: Task, Bash, Read, Grep, Glob
---

You are running the user's standard post-implementation review pipeline on the current branch.

## Steps

1. **Identify the diff.** Run:
   - `git rev-parse --abbrev-ref HEAD` to confirm the branch.
   - `BASE=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD master 2>/dev/null || git merge-base HEAD main)` to find the merge base.
   - `git diff --name-only "$BASE"...HEAD` to list changed files.
   - `git diff --stat "$BASE"...HEAD` for the summary.

2. **Dispatch the simplifier.** Use the Task tool with `subagent_type: "code-simplifier:code-simplifier"`. Instructions:
   - Focus exclusively on the changed files listed above.
   - Apply ONLY clearly safe simplifications (no behavior change).
   - After any edit, re-run the project's tests/typecheck/lint (`pnpm test && pnpm typecheck && pnpm lint` if those scripts exist; otherwise the project's standard verification).
   - Report what was applied, what was considered-but-not-applied, and the green verification output.

3. **If the simplifier applied edits,** re-confirm the suite is still green before continuing.

4. **Dispatch the reviewer.** Use the Task tool with `subagent_type: "code-review:code-review"`. Instructions:
   - Review the post-simplifier diff against the merge base.
   - Severities: BLOCKER / IMPORTANT / NIT.
   - Verdict at the end: APPROVED / APPROVED-WITH-NITS / CHANGES-REQUESTED.

5. **Summarize.** Combine both reports into a single ship-readiness summary: simplifications applied, review findings by severity, ready-to-merge verdict.

## Rules

- **Never `git add`/`git commit`.** Leave all staging to the user.
- **Never invent or write tests** — recommend them, don't author them.
- If a BLOCKER is found, surface it prominently and recommend pausing before merge.
