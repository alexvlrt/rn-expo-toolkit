<div align="center">

# 📱 React Native + Expo Toolkit

### Reusable, **authority-led** conventions for production React Native + Expo apps — packaged as a Claude Code plugin.

<sub><code>rn-expo-toolkit</code></sub>

<br/>

[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED?logo=anthropic&logoColor=white)](https://docs.claude.com/en/docs/claude-code)
[![Expo](https://img.shields.io/badge/Expo-SDK%2055%2B-000020?logo=expo&logoColor=white)](https://expo.dev)
[![React Native](https://img.shields.io/badge/React%20Native-0.83-61DAFB?logo=react&logoColor=white)](https://reactnative.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg)](./LICENSE)

<sub>13 skills · 2 reviewer agents · 3 commands · 3 hooks · zero drop-in code</sub>

</div>

---

> **🧭 Authority-led** — this toolkit never re-teaches setup the ecosystem already owns. It layers *on top* of the source-of-truth skills (`building-native-ui`, `react-native-best-practices`, `tanstack-query-best-practices`, `native-data-fetching`, the RevenueCat plugin, `expo-deployment`, `expo-cicd-workflows`, `eas-update-insights`) and adds only the opinionated glue, conventions, and battle-tested gotchas they leave out. Every skill opens with a **Complements** header pointing at the authority it builds on.
>
> **📚 Knowledge-only** — skills teach patterns through inline snippets in their markdown. There are **no `.tsx`/`.ts` files to copy**: Claude generates the code in-context from the rules + snippets, and the bundled reviewer agents police any drift. Same convention the ecosystem skills use.

---

## 📦 Install

From inside a Claude Code session:

```text
/plugin marketplace add https://github.com/alexvlrt/rn-expo-toolkit
/plugin install expo-toolkit@rn-expo-toolkit
```

<details>
<summary>From a local clone</summary>

```text
/plugin marketplace add /path/to/rn-expo-toolkit
/plugin install expo-toolkit@rn-expo-toolkit
```
</details>

**Verify it's active:** `/plugin` lists `expo-toolkit` · `/new-expo-app`, `/polish`, `/ship-check` appear as commands · `expo-code-reviewer` / `expo-security-reviewer` show in the agents list · editing a `.ts` file under `apps/mobile/**` with an `sk_live_…` literal gets blocked by a hook.

---

## 🧱 The layered model

The guiding principle: **use the cheapest primitive that achieves the goal.** "Always-clean lint" is a hook, not an agent. Recurring judgment is an agent. User-triggered orchestration is a command. Reusable knowledge is a skill.

```
🪝  hooks/      AUTO enforcement        silent, deterministic, on every edit
⌨️  commands/   USER-triggered flows    /new-expo-app · /polish · /ship-check
🤖  agents/     JUDGMENT personas       review · security
🧠  skills/     KNOWLEDGE               the 13 — referenced by everything above
```

A `/new-expo-app` invocation *consumes* the skills · the reviewer agents *apply* their conventions · the hooks *enforce* what they recommend.

---

## 🧠 Skills

| Skill | What it covers | Complements |
|-------|----------------|-------------|
| **`expo-ui-kit`** | Normalized `AppModal` / `ConfirmModal` / `SheetBackdrop` / `Toast` / `Card` / `Button` / progress + safe-area sheet rules (`topInset`, footer math) + Reanimated 4 animation idioms. | `building-native-ui`, `react-native-best-practices`, `ui-ux-pro-max` |
| **`expo-app-bootstrap`** | Root `_layout.tsx` provider tree + hydration gates, ordered cold-start init, `app.config.ts` variant pattern, `runtimeVersion: fingerprint`. | `building-native-ui` |
| **`expo-i18n`** | i18next + Zustand with cross-device locale sync (one-shot server-locale latch), resolution hierarchy, missing-key dev warnings. | — |
| **`expo-state-data`** | TanStack Query + Zustand: query-keys factory, the 4-step optimistic-update lifecycle, the `setQueriesData` locale-prefix gotcha, SecureStore tokens, single-flight identity-pinned refresh. | `tanstack-query-best-practices`, `native-data-fetching` |
| **`expo-revenuecat-superwall`** | RevenueCat + Superwall: anonymous-until-sign-in identity, the custom `PurchaseController` bridge, gate hook + fallback overlay, server-side never-trust-the-webhook reconciliation. | `RevenueCat:*` |
| **`expo-observability`** | Sentry + PostHog with privacy enforcement: `beforeSend` PII scrub, sensitive-field blocklist, env-prefixed `distinct_id`, variant tagging. | — |
| **`expo-notifications`** | Local notifications: permission flow with graceful denial, OS-revocation reconciliation, time-based scheduling, i18n-aware copy. | — |
| **`expo-dx-scripts`** | pnpm dev/build wrappers + cloudflared backend tunnel + ADB device picker + WSL `usbipd` auto-attach. | `expo-dev-client` |
| **`expo-release-discipline`** | OTA-vs-native-rebuild classification, CHANGELOG discipline, the pre-OTA runtime-cohort guard. | `expo-deployment`, `expo-cicd-workflows`, `eas-update-insights` |
| **`api-backend-patterns`** | Backend-agnostic (Hono+Drizzle ref + Laravel note): per-resource authz-404, JWT token-versioning revocation, OIDC verify, webhook reconciliation, shared Zod, GDPR cascade. | — |
| **`expo-env-setup`** | One-time cross-OS machine bootstrap (`setup.sh` + `doctor.sh`): JDK 17, Android SDK, ADB (WSL2 usbipd / Linux udev / macOS), and the iOS toolchain on macOS (Xcode, CocoaPods via rbenv, simulators). | `expo-dev-client` |
| **`expo-offline-queue`** | Offline-first mutations: a persisted optimistic queue with revert-on-fail, batch `/sync-offline` replay on reconnect (NetInfo), idempotency keys, and dead-letter handling. | `native-data-fetching` |
| **`expo-auth-mobile`** | Sign in with Apple/Google (raw token → backend), stable device identity (SecureStore/localStorage), and the in-place anonymous→identified merge checklist (email-vs-OAuth parity, RC continuity). | `api-backend-patterns` |

<sub>Dense sub-patterns live in `references/`: <code>expo-ui-kit/references/sheets.md</code> (gorhom bottom-sheet deep-dive) and <code>expo-revenuecat-superwall/references/superwall-bridge.md</code> (the full <code>PurchaseController</code> lifecycle).</sub>

---

## 🤖 Agents

| Agent | Role | Composes |
|-------|------|----------|
| **`expo-code-reviewer`** | RN+Expo + toolkit-conventions review: NativeWind className-only, normalized modals, safe-area sheet footers, query-keys factory, Lucide-only icons, i18n coverage, authz-404. | `code-review` |
| **`expo-security-reviewer`** | Mobile-security review: no keys in mobile, no PII to analytics, SecureStore tokens, OIDC at JWKS, RC identity, `runtimeVersion` regression. | `cso`, `cybersecurity`, `security-review` |

---

## ⌨️ Commands

| Command | What it does |
|---------|--------------|
| **`/new-expo-app`** | Scaffolds a fresh app by orchestrating the scaffold skills in order (bootstrap → NativeWind → i18n → state-data → ui-kit → observability → notifications → dx-scripts), with an interactive input-gathering step. |
| **`/polish`** | Runs the post-implementation review pipeline on the current diff: `code-simplifier` then `code-review`. |
| **`/ship-check`** | Pre-ship gate — classifies the diff OTA-safe vs native-rebuild, runs the security reviewer, emits a CHANGELOG entry stub. Read-only; never deploys. |

---

## 🪝 Hooks

| Hook | Event | Behavior |
|------|-------|----------|
| **`block-mobile-secrets`** | `PreToolUse` | **Blocks** edits that introduce an API-key-shaped literal under `apps/mobile/**`. Server-side env vars only. |
| **`format-on-edit`** | `PostToolUse` | Runs `oxlint --fix` + `prettier --write` on edited TS/JS files — **only inside an RN/Expo project** (no-op in unrelated repos, so it's safe installed user-wide). Best-effort, never blocks. |
| **`i18n-key-guard`** | `PostToolUse` | **Warns** (doesn't block) when a user-facing JSX string is added without a `t("…")` wrapper. |

<sub>Hooks are portable Node ESM (<code>.mjs</code>) — no <code>jq</code> or other shell dependencies.</sub>

---

## 🎛️ Adapt to your project

The skills are written generically. Each ends with an **"Adapt for your project"** checklist for the values you parameterize — color tokens, entitlement ids, env var names, locale list, API base URL, sensitive-field blocklist. Reference implementations use `<YOUR_*>` placeholders; no legal/medical/product-specific copy is baked in.

## 🗂️ Repository layout

```
.claude-plugin/marketplace.json     marketplace manifest
expo-toolkit/
├── .claude-plugin/plugin.json      plugin manifest
├── SKILL_TEMPLATE.md               template for new skills
├── skills/        13 skills (2 with references/)
├── agents/        expo-code-reviewer · expo-security-reviewer
├── commands/      new-expo-app · polish · ship-check
└── hooks/         hooks.json + 3 .mjs scripts
```

## 🤝 Contributing

New skills follow `expo-toolkit/SKILL_TEMPLATE.md`: a `name` + trigger-condition `description`, a **Complements** header, the conventions, representative inline snippets, and an "Adapt for your project" checklist. Keep them knowledge-only — no drop-in source files.

---

<div align="center">
<sub>📄 <a href="./LICENSE">MIT</a> © Alexandre Vuillerot</sub>
</div>
