---
name: expo-observability
description: "Use when wiring Sentry and PostHog into a RN+Expo app (privacy-safe init, PII scrubbing, environment partitioning, variant tagging, env/secrets handling). Enforces: never sending sensitive/health fields to analytics, env-prefixed distinct_id to protect prod users sharing a UUID, beforeSend scrub before dispatch, lifecycle/replay disabled to control free-tier budget."
---

> **Complements:** no single authoritative plugin skill covers Sentry + PostHog wiring together; this skill encodes the project's privacy-safe wiring directly, distilled from a production Expo SDK 55 app. For the GDPR account-deletion cascade (PostHog person delete + Sentry feedback delete), see `api-backend-patterns`.

---

## Conventions

### Sentry

- Initialize in `_layout.tsx` **before** auth load — catches crashes during auth setup.
- DSN from `EXPO_PUBLIC_SENTRY_DSN` (bundled-public; Sentry DSNs are non-secret).
- `environment` tag from `Constants.expoConfig?.extra?.variant` (`"development"` /
  `"staging"` / `"production"`) — falls back to `"development"` for local runs. Keeps
  non-prod events out of the production Sentry dashboard.
- `tracesSampleRate: 0.1` is a safe default; never set to `1.0` in production.
- Add a **`beforeSend(event)` hook** that walks `event.extra`, `event.contexts.*`, and
  `event.breadcrumbs[*].data`, deleting keys on your project's sensitive-field blocklist.
  Defense-in-depth: catches accidental leakage before it leaves the device.
- Keep the blocklist as a module-level constant — one auditable place.
- Optionally wrap the root layout with `Sentry.wrap(RootLayout)` for automatic
  unhandled-error boundaries and component-name breadcrumbs.
- `SENTRY_AUTH_TOKEN` (source-map upload at EAS build time) is an EAS secret — never in
  mobile code.

### PostHog

- Single shared project across staging + production (free-tier). Partition via:
  (1) `environment` super-property for dashboard filtering, and
  (2) env-prefixed `distinct_id` in non-prod to prevent staging cascades from wiping
      production users that share a UUID.
- **`HEALTH_BLOCKLIST`** constant: every field name that must never reach PostHog.
  Keep it `as const` for the TypeScript `includes()` guard.
- Two scrubbing helpers: `scrub(props)` (drops blocklisted keys) for `capture()`, and
  `sanitizeUserProps(props)` (also drops `null`/`undefined`) for `identify()`.
- Set `captureAppLifecycleEvents: false`, `enableSessionReplay: false`,
  `disableSurveys: true` at init to control free-tier budget.
- Initialize **after Sentry, before auth load** in `_layout.tsx`.
- Mirror the `distinct_id` prefix in your server-side GDPR cascade
  (`analytics-deletion.ts`) — otherwise the server-side person delete silently no-ops
  for staging users.

### Env wiring

- `EXPO_PUBLIC_*` vars are bundled into client JS — only DSNs and public project keys
  here; never auth tokens or secrets.
- `Constants.expoConfig.extra.variant` tags events at runtime. Set in `app.config.ts`
  `extra` block, sourced from `process.env.APP_VARIANT` at build time. Single source of
  truth: Sentry and PostHog both read `extra.variant` rather than separate env vars.
- `APP_VARIANT` is a build-time var consumed only by `app.config.ts`; it is not
  `EXPO_PUBLIC_*` and never reaches the client bundle directly.

---

## Inline snippets

### Sentry init with `beforeSend` scrub + variant tag

```ts
import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";

// Replace with your project's sensitive field names. Examples for a health-domain
// app: "nutrients", "biometrics", "heartRate", "weight". Import from a shared
// constants file (so sentry.ts and posthog.ts can't drift).
const SENTRY_SCRUB_KEYS = [
  "<YOUR_SENSITIVE_FIELD_1>",
  "<YOUR_SENSITIVE_FIELD_2>",
] as const;

export function initSentry() {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  const variant =
    (Constants.expoConfig?.extra?.variant as string | undefined) ?? "development";

  Sentry.init({
    dsn,
    environment: variant,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.extra) {
        for (const key of SENTRY_SCRUB_KEYS) delete event.extra[key];
      }
      if (event.contexts) {
        for (const ctx of Object.values(event.contexts)) {
          if (ctx && typeof ctx === "object")
            for (const key of SENTRY_SCRUB_KEYS)
              delete (ctx as Record<string, unknown>)[key];
        }
      }
      if (event.breadcrumbs?.values) {
        for (const crumb of event.breadcrumbs.values)
          if (crumb.data)
            for (const key of SENTRY_SCRUB_KEYS) delete crumb.data[key];
      }
      return event;
    },
  });
}
```

### PostHog init with blocklist + env-prefixed `distinct_id`

```ts
import { PostHog } from "posthog-react-native";
import Constants from "expo-constants";

let posthogClient: PostHog | null = null;

const ENV = Constants.expoConfig?.extra?.variant ?? "development";

// Replace with your project's sensitive field names.
// Examples from a health domain: "nutrients","deficiencies","heightCm","weightKg","bmi"
const HEALTH_BLOCKLIST = [
  "<YOUR_SENSITIVE_FIELD_1>",
  "<YOUR_SENSITIVE_FIELD_2>",
] as const;

type EventProps = Record<string, string | number | boolean | null>;
type UserProps  = Record<string, string | number | boolean | null | undefined>;

function scrub(properties?: EventProps): EventProps | undefined {
  if (!properties) return properties;
  const safe: EventProps = { ...properties };
  for (const key of HEALTH_BLOCKLIST) delete safe[key];
  return safe;
}

function sanitizeUserProps(properties?: UserProps): EventProps | undefined {
  if (!properties) return properties;
  const safe: EventProps = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value == null) continue;
    if ((HEALTH_BLOCKLIST as readonly string[]).includes(key)) continue;
    safe[key] = value;
  }
  return safe;
}

// Mirror this prefix in analytics-deletion.ts — the /user DELETE cascade must
// produce the same id or the PostHog person delete silently no-ops.
function prefixDistinctId(userId: string): string {
  return ENV === "production" ? userId : `${ENV}_${userId}`;
}

export function initPostHog() {
  const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (!apiKey || posthogClient) return;
  posthogClient = new PostHog(apiKey, {
    host: "https://us.i.posthog.com",
    captureAppLifecycleEvents: false,
    enableSessionReplay: false,
    disableSurveys: true,
  });
  posthogClient.register({ environment: ENV });
}

export function trackEvent(event: string, properties?: EventProps) {
  if (!posthogClient) return;
  posthogClient.capture(event, scrub(properties));
}

export function identifyUser(userId: string, properties?: UserProps) {
  if (!posthogClient) return;
  posthogClient.identify(prefixDistinctId(userId), sanitizeUserProps(properties));
}
```

### `app.config.ts` variant plumbing

```ts
// Consumed at EAS build time (eas.json profiles set APP_VARIANT=staging|production).
// Local expo run:* without APP_VARIANT defaults to "development".
type Variant = "development" | "staging" | "production";
const variant = (process.env.APP_VARIANT ?? "development") as Variant;

// Exposed to runtime via Constants.expoConfig.extra.variant.
// Sentry and PostHog read this; no separate EXPO_PUBLIC_ENV needed for tagging.
const extra = {
  variant,
  eas: { projectId: "<YOUR_EAS_PROJECT_ID>" },
};
```

### Provider tree placement (`_layout.tsx`)

```ts
useEffect(() => {
  // Cold-start init order — Sentry first so subsequent init crashes are captured.
  // See expo-app-bootstrap (Phase 3) for the canonical order doc.
  initSentry();    // 1. error monitoring — before anything that can throw
  initPostHog();   // 2. analytics — before user identity resolves
  loadAuth();      // 3. reads stored JWT; triggers identity useEffect below
  initRevenueCat();
  void initSuperwall().then(syncSuperwallEntitlement);
}, [loadAuth]);

// After auth resolves, identify the user in both PostHog and RevenueCat.
useEffect(() => {
  if (!token || !userId) return;
  void (async () => {
    await setRevenueCatUser(userId);
    await syncRevenueCatPurchases();
    await identifySuperwall(userId);
    identifyUser(userId); // PostHog — prefixes distinct_id in non-prod
  })();
}, [token, userId]);
```

> `initSentry()` and `initPostHog()` both guard against missing env vars and
> re-initialization; they are safe to call unconditionally.

---

## Adapt for your project

- **Sensitive field names** — replace the `<YOUR_SENSITIVE_FIELD_*>` placeholders.
  Consider importing one canonical list into both `sentry.ts` and `posthog.ts`.
- **Env var names** — `EXPO_PUBLIC_SENTRY_DSN` and `EXPO_PUBLIC_POSTHOG_KEY` are common conventions; rename to match your project's `.env` schema. The environment/variant tag comes from `Constants.expoConfig?.extra?.variant`, not a separate `EXPO_PUBLIC_ENV` var.
- **Sample rates** — `tracesSampleRate: 0.1` is conservative. Raise during a launch or
  incident; set to `0` to disable tracing and keep only error reporting.
- **Env partitioning** — if you have separate PostHog projects per environment (paid tier),
  remove `prefixDistinctId()` and the `environment` super-property; use the raw `userId`.
- **`Sentry.wrap`** — wrap the root layout component (`export default Sentry.wrap(RootLayout)`)
  for automatic error boundaries and component breadcrumbs. Omit only if you manage your
  own `ErrorBoundary` hierarchy.
- **GDPR cascade** — `DELETE /user` must call PostHog's person-delete API with the same
  prefixed `distinct_id`. Mirror `prefixDistinctId()` in your server-side deletion service.
