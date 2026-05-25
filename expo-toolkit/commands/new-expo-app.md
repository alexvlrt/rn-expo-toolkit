---
description: Scaffold a new React Native + Expo app by running the toolkit's scaffold skills in order (bootstrap → nativewind → i18n → state-data → ui-kit → observability → notifications → dx-scripts). Walks the user through naming, variant setup, and the cold-start init order. Use to start a new app from scratch with the project's conventions baked in.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill
---

This command orchestrates the toolkit's scaffold skills in sequence to bootstrap a new React Native + Expo app with all project conventions — provider tree, styling, i18n, data layer, UI kit, observability, payments, notifications, and DX scripts — baked in from the start.

## Step 0 — Gather inputs

Ask the user for the following before writing a single file:

1. **App name** — display name shown on the home screen (e.g. `My App`) and the bundle base ID (e.g. `com.example.myapp`). The bundle ID will be expanded to `com.example.myapp.development` / `.staging` / `.production` if multi-variant is enabled.
2. **Multi-variant builds?** — support `development` / `staging` / `production` build variants with separate bundle IDs, `.env.<variant>` files, and EAS build profiles. Default: **yes**.
3. **Observability stack** — one of:
   - `sentry+posthog` (recommended — structured error monitoring + product analytics)
   - `sentry-only`
   - `none`
4. **In-app purchases?** — does the app need RevenueCat entitlements and Superwall paywall templates? If **yes**, Step 7 (`expo-revenuecat-superwall`) is enabled.
5. **Analytics blocklist** (only if observability ≠ `none`) — sensitive field names that must never appear in analytics events or Sentry breadcrumbs. Examples: health metrics, biometric values, financial fields. List them comma-separated; the skill will wire them into the PostHog capture filter.
6. **Locale list** — comma-separated ISO 639-1 codes to scaffold. Default: `en`. The first code is the source-of-truth locale.
7. **Local reminders?** — does the app schedule time-based local push notifications (e.g. meal reminders, habit nudges)? If **yes**, Step 8 (`expo-notifications`) is enabled.

Do not proceed to Step 1 until all answers are confirmed.

## Steps

### Step 1 — App bootstrap

Invoke the `expo-app-bootstrap` skill.

Provide it: app name, bundle base ID, and the multi-variant flag.

The skill generates:
- `app/_layout.tsx` with the ordered provider tree, hydration gates, and the cold-start init `useEffect` (i18n → auth → onboarding check, in that order).
- `app.config.ts` with the variant selector pattern (`process.env.APP_VARIANT`) and `runtimeVersion: { policy: 'fingerprint' }`.
- `.env.development`, `.env.staging`, `.env.production` skeletons.

### Step 2 — NativeWind v5

Invoke the authoritative `expo-tailwind-setup` skill (this is a first-party Expo/NativeWind skill, not a toolkit skill).

This installs and configures NativeWind v5 + Tailwind CSS v4, sets up `tailwind.config.ts` with the `apps/mobile` content glob, and verifies `className` prop support is wired into Metro and Expo.

### Step 3 — i18n

Invoke the `expo-i18n` skill.

Provide it: the locale list from Step 0 (first locale = source of truth).

The skill generates:
- `src/i18n/index.ts` — i18next init with per-locale JSON imports.
- `src/i18n/i18n-store.ts` — Zustand slice with a `serverApplied` latch (prevents re-applying the server locale if the user has manually overridden it).
- `src/i18n/resolve-locale.ts` — device locale → supported locale resolver with fallback.
- `src/i18n/locales/<code>.json` skeletons for each requested locale.

### Step 4 — State & data layer

Invoke the `expo-state-data` skill.

The skill generates:
- `src/lib/query-client.ts` — TanStack Query v5 client with retry/stale config.
- `src/lib/query-keys.ts` — typed factory for all query key tuples.
- `src/lib/api.ts` — fetch wrapper with network-error normalization, 401 detection, and a single-flight token-refresh guard (concurrent 401s collapse into one refresh call).
- `src/stores/auth-store.ts` — Zustand + SecureStore slice for JWT and user ID.
- `src/stores/onboarding-store.ts` — persisted Zustand slice tracking onboarding completion state.

### Step 5 — UI kit

Invoke the `expo-ui-kit` skill.

The skill generates shared primitive components:
- `AppModal` — centered modal with 50 % dim scrim, tap-outside-to-close, and consistent title/body/CTA sizing.
- `ConfirmModal` — two-button variant of `AppModal` (confirm / cancel).
- `Card` — surface card with standard padding and border radius.
- `Button` — primary/secondary/destructive variants with loading state.
- `SheetBackdrop` — gorhom `BottomSheet` backdrop at 50 % black opacity.
- `Toast` — ephemeral feedback component with auto-dismiss.

Also applies the sheet conventions: `topInset`, `footerComponent` (opaque `bg-surface-card`), and home-indicator bottom padding.

### Step 6 — Observability

Invoke the `expo-observability` skill only if the user chose an observability stack other than `none` in Step 0.

Provide it: the stack choice (`sentry+posthog` or `sentry-only`) and the analytics blocklist.

The skill generates:
- `src/lib/sentry.ts` — Sentry init with `app.config.ts` `extra.variant` routing (dev → staging DSN, prod → production DSN), breadcrumb filter.
- `src/lib/posthog.ts` (if `sentry+posthog`) — PostHog client with a `captureEvent` wrapper that strips all blocklisted fields before the event leaves the device.
- `app.config.ts` additions: `extra.variant`, Sentry plugin config.

### Step 7 — Payments (conditional)

Invoke the `expo-revenuecat-superwall` skill only if the user said **yes** to in-app purchases in Step 0.

The skill generates:
- RevenueCat init wired into the provider tree (from Step 1).
- Superwall `PurchaseController` bridge delegating purchase calls to RevenueCat.
- `useSubscriptionGate` hook — reads the RC entitlement, shows the paywall if unpaid, and returns the gate result.
- Fallback overlay for when the paywall SDK is not yet loaded.

### Step 8 — Notifications (conditional)

Invoke the `expo-notifications` skill only if the user said **yes** to local reminders in Step 0.

The skill generates:
- Notification handler registration (foreground + background).
- `scheduleReminder` / `cancelReminder` helpers (time-based, local only).
- Permission-request flow with graceful degradation when denied.
- OS-revocation reconciliation: on app foreground, re-check `getPermissionsAsync` and sync stored `notificationsEnabled` state.

### Step 9 — DX scripts

Invoke the `expo-dx-scripts` skill.

Provide it: the backend dev port (e.g. `8787` for Workers, `3000` for Node/Express) and whether the team uses WSL2 (enables the `usbipd` auto-attach path).

The skill generates:
- `scripts/dev.sh` — Metro + cloudflared backend tunnel + `adb reverse` + `expo start --dev-client`.
- `scripts/dev-ios.sh` — two cloudflared tunnels + `EXPO_PACKAGER_PROXY_URL`.
- `scripts/build-android.sh` — `expo run:android --no-bundler` compile + install.
- `scripts/setup.sh` — idempotent bootstrap (OS detection → Node → pnpm → Java → Android SDK → `.env.local` copy).
- `scripts/lib/adb.sh` — ADB device picker: USB → usbipd → mDNS waterfall.
- `scripts/lib/usbip.sh` (if WSL2) — `usbipd` list-parse + auto-attach.
- `package.json` `scripts` entries: `dev`, `dev:ios`, `build:android`, `install:env`.

## Verify

After all steps complete, run the following and confirm each passes before declaring done:

```bash
pnpm typecheck    # zero TypeScript errors
pnpm lint         # zero lint errors/warnings
pnpm test         # green (if any tests were scaffolded)
```

Also manually confirm:
- The provider tree in `app/_layout.tsx` renders without a crash on a cold launch (no undefined store reads, all hydration gates guard downstream consumers).
- The `APP_VARIANT` environment variable resolves correctly for each `.env.*` variant.

## Rules

- **NEVER `git add` or `git commit`.** Leave all files in the working tree; staging and committing are the user's responsibility.
- **NEVER run `eas` or build commands.** The user classifies and ships; this command only scaffolds.
- Each skill must be invoked via the `Skill` tool by name (e.g. `expo-app-bootstrap`, `expo-i18n`, etc.).
- If a skill is not installed in the current session, fall back to its inline patterns by reading the skill's `SKILL.md` from disk (path: `<toolkit-root>/expo-toolkit/skills/<skill-name>/SKILL.md`).
- All scaffolded user-facing strings must go through i18n from the start — no hardcoded literals, even for placeholder copy.
