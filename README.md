# rn-expo-toolkit

> A Claude Code plugin of **reusable, opinionated conventions** for building production React Native + Expo apps.

![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)
![React Native](https://img.shields.io/badge/React%20Native-Expo%20SDK%2055%2B-000020)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

**Authority-led.** This toolkit doesn't re-teach setup that the ecosystem already owns — it layers *on top* of the source-of-truth skills (`building-native-ui`, `react-native-best-practices`, `tanstack-query-best-practices`, `native-data-fetching`, the RevenueCat plugin, `expo-deployment`, `expo-cicd-workflows`, `eas-update-insights`) and adds only the opinionated glue, conventions, and battle-tested gotchas they don't cover. Every skill opens with a **Complements** header pointing at the authority it builds on.

**Knowledge-only.** Skills teach patterns through inline snippets in their markdown — there are **no `.tsx`/`.ts` files to copy**. Claude generates the code in-context from the rules + snippets, and the bundled reviewer agents police any drift. Same convention the ecosystem skills use.

---

## Install

From inside a Claude Code session:

```text
/plugin marketplace add https://github.com/alexvlrt/rn-expo-toolkit
/plugin install expo-toolkit@rn-expo-toolkit
```

Or from a local clone:

```text
/plugin marketplace add /path/to/rn-expo-toolkit
/plugin install expo-toolkit@rn-expo-toolkit
```

**Verify it's active:** `/plugin` lists `expo-toolkit`; `/new-expo-app`, `/polish`, `/ship-check` appear as commands; the agents `expo-code-reviewer` / `expo-security-reviewer` show in the agents list; editing a `.ts` file under `apps/mobile/**` with an `sk_live_…` literal gets blocked by a hook.

---

## The layered model

The plugin ships four kinds of components. The guiding principle: **use the cheapest primitive that achieves the goal.** "Always-clean lint" is a hook, not an agent. Recurring judgment is an agent. User-triggered orchestration is a command. Reusable knowledge is a skill.

```
hooks/      ← AUTO enforcement        (silent, deterministic, on every edit)
commands/   ← USER-triggered flows    (/new-expo-app, /polish, /ship-check)
agents/     ← JUDGMENT personas       (review, security)
skills/     ← KNOWLEDGE               (the 10 — referenced by everything above)
```

A `/new-expo-app` invocation *consumes* the skills; the reviewer agents *apply* the skills' conventions; the hooks *enforce* what the skills recommend.

---

## Skills

| Skill | What it covers | Complements |
|-------|----------------|-------------|
| **`expo-ui-kit`** | Normalized `AppModal` / `ConfirmModal` / `SheetBackdrop` / `Toast` / `Card` / `Button` / progress + safe-area sheet rules (`topInset`, footer math), Reanimated 4 animation idioms. | `building-native-ui`, `react-native-best-practices`, `ui-ux-pro-max` |
| **`expo-app-bootstrap`** | Root `_layout.tsx` provider tree + hydration gates, ordered cold-start init, `app.config.ts` variant pattern, `runtimeVersion: fingerprint`. | `building-native-ui` |
| **`expo-i18n`** | i18next + Zustand store with cross-device locale sync (one-shot server-locale latch), resolution hierarchy, missing-key dev warnings. | — |
| **`expo-state-data`** | TanStack Query + Zustand: a query-keys factory, the 4-step optimistic-update lifecycle, the `setQueriesData` locale-prefix gotcha, SecureStore tokens, single-flight identity-pinned refresh. | `tanstack-query-best-practices`, `native-data-fetching` |
| **`expo-revenuecat-superwall`** | RevenueCat + Superwall wiring: anonymous-until-sign-in identity, the custom `PurchaseController` bridge, gate hook + fallback overlay, server-side never-trust-the-webhook reconciliation. | `RevenueCat:*` |
| **`expo-observability`** | Sentry + PostHog with privacy enforcement: `beforeSend` PII scrub, sensitive-field blocklist, env-prefixed `distinct_id`, variant tagging. | — |
| **`expo-notifications`** | Local notifications: permission flow with graceful denial, OS-revocation reconciliation, time-based scheduling, i18n-aware copy. | — |
| **`expo-dx-scripts`** | pnpm dev/build wrappers + cloudflared backend tunnel + ADB device picker + WSL `usbipd` auto-attach. | `expo-dev-client` |
| **`expo-release-discipline`** | OTA-vs-native-rebuild classification, CHANGELOG discipline, the pre-OTA runtime-cohort guard. | `expo-deployment`, `expo-cicd-workflows`, `eas-update-insights` |
| **`api-backend-patterns`** | Backend-agnostic (Hono+Drizzle ref + Laravel note): per-resource authz-404, JWT token-versioning revocation, OIDC verify, webhook reconciliation, shared Zod, GDPR cascade. | — |

Dense sub-patterns live in `references/`: `expo-ui-kit/references/sheets.md` (the gorhom bottom-sheet deep-dive) and `expo-revenuecat-superwall/references/superwall-bridge.md` (the full `PurchaseController` lifecycle).

## Agents

- **`expo-code-reviewer`** — reviews RN+Expo code against the toolkit's conventions (NativeWind className-only, normalized modals, safe-area sheet footers, query-keys factory, Lucide-only icons, i18n coverage, authz-404). Composes the generic `code-review`.
- **`expo-security-reviewer`** — mobile-security review (no keys in mobile, no PII to analytics, SecureStore tokens, OIDC at JWKS, RC identity, `runtimeVersion` regression). Composes `cso` / `cybersecurity` / `security-review`.

## Commands

- **`/new-expo-app`** — scaffolds a fresh app by orchestrating the scaffold skills in order (bootstrap → NativeWind → i18n → state-data → ui-kit → observability → notifications → dx-scripts), with an interactive input-gathering step.
- **`/polish`** — runs the post-implementation review pipeline on the current diff: `code-simplifier` then `code-review`.
- **`/ship-check`** — pre-ship gate: classifies the diff OTA-safe vs native-rebuild, runs the security reviewer, emits a CHANGELOG entry stub. Read-only — it never deploys.

## Hooks

- **`block-mobile-secrets`** (`PreToolUse`) — blocks edits that introduce an API-key-shaped literal under `apps/mobile/**`. Server-side env vars only.
- **`format-on-edit`** (`PostToolUse`) — runs `oxlint --fix` + `prettier --write` on every edited TS/JS file. Best-effort, never blocks.
- **`i18n-key-guard`** (`PostToolUse`) — warns (doesn't block) when a user-facing JSX string is added without a `t("…")` wrapper.

> Hooks are implemented as portable Node ESM (`.mjs`) scripts — no `jq` or other shell dependencies.

---

## Adapt to your project

The skills are written generically. Each ends with an **"Adapt for your project"** checklist for the values you parameterize: color tokens, entitlement ids, env var names, locale list, API base URL, sensitive-field blocklist. Reference implementations use `<YOUR_*>` placeholders. No legal/medical/product-specific copy is baked in.

## Repository layout

```
.claude-plugin/marketplace.json     # marketplace manifest
expo-toolkit/
├── .claude-plugin/plugin.json      # plugin manifest
├── SKILL_TEMPLATE.md               # template for new skills
├── skills/        (10 skills, 2 with references/)
├── agents/        (expo-code-reviewer, expo-security-reviewer)
├── commands/      (new-expo-app, polish, ship-check)
└── hooks/         (hooks.json + 3 .mjs scripts)
```

## Contributing

New skills follow `expo-toolkit/SKILL_TEMPLATE.md`: a `name` + trigger-condition `description`, a **Complements** header, the conventions, representative inline snippets, and an "Adapt for your project" checklist. Keep them knowledge-only — no drop-in source files.

## License

[MIT](./LICENSE) © Alexandre Vuillerot
