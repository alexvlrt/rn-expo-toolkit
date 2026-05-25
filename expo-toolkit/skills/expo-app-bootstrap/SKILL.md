---
name: expo-app-bootstrap
description: "Use when bootstrapping a new RN+Expo app's root layout, configuring multi-environment builds via APP_VARIANT, or auditing the provider tree / cold-start init order. Enforces: outer GestureHandlerRootView, render gate on i18n+auth hydration, ordered cold-start init (i18n hydrate -> auth -> Sentry -> PostHog -> RC -> Superwall), fingerprint runtimeVersion, and the bundleId/appName variant derivation from a single APP_VARIANT env."
---

> **Complements:** `building-native-ui` — Software Mansion provider/layout patterns. This skill
> adds the variant-driven `app.config.ts`, the specific cold-start init ordering, and the
> identity-bound subscription reconciliation effect that those patterns assume is already wired.

---

## Authority-preferred default

- **Expo Router 4+** `app/_layout.tsx` is the root entry point. Never use a bare
  `App.tsx` + `NavigationContainer` — Expo Router owns the navigation container.
- **`app.config.ts`** (TypeScript), not `app.json`. Reading `process.env.APP_VARIANT`
  requires `.ts`; migrate before adding the first non-production environment.

---

## Conventions / checklist

- **Provider order** (outermost → innermost): `GestureHandlerRootView` → `I18nextProvider`
  → `SafeAreaProvider` → `QueryClientProvider` → `Stack`. Gesture handler must be
  outermost — placing it inside SafeArea or QueryClient causes gesture drops on Android.

- **Render gate**: `if (!i18nReady) return null` before the JSX return. Never render
  `Stack` against half-hydrated state — translation keys flash as raw keys and auth-gated
  screens briefly render unauthenticated.

- **Cold-start init effect** (`useEffect([loadAuth])`): `initSentry()` → `initPostHog()`
  → `loadAuth()` → `initRevenueCat()` (no userId — anonymous; passing userId here before
  hydration was the source of stale-identity bugs) →
  `initSuperwall().then(syncSuperwallEntitlement)` → `subscribeSuperwallToRc()` (return
  cleanup).

- **Identity-bound effect** (`useEffect([token, userId])`): guard `if (!token || !userId)
  return`. IN ORDER: `setRevenueCatUser` → `syncRevenueCatPurchases` (moves the receipt —
  `logIn` alone does NOT transfer it) → `identifySuperwall` → `syncSuperwallEntitlement`
  → analytics identify → `POST /user/subscription/sync`. Full `try/catch` (swallowed —
  safety net). Always `finally`: invalidate `userKeys.me()` + `subscriptionKeys.all`.
  Use a `cancelled` flag checked in `finally`; set it in the cleanup function.

- **`runtimeVersion: { policy: 'fingerprint' }`** — never `'appVersion'`. The
  `appVersion` policy ties OTA eligibility to the human-edited version string; a missed
  bump strands the embedded cohort on the old runtime (documented as the 1.0.0/1.1.0
  skew). Fingerprint derives the runtime from the actual native layer.

- **`app.config.ts` variant pattern**: read `APP_VARIANT` from `process.env`, derive
  `bundleIdentifier` (`base` for production, `base.variant` otherwise) and `name`
  (`Base` vs `Base (variant)`). Expose `extra.variant` for runtime SDK tagging.

- **`contentStyle.backgroundColor`** in `Stack.screenOptions` must match your canvas
  token. A stale dark hex on a light-only app flashes black behind every screen push.

- **`userInterfaceStyle`**: always explicit (`'light'` or `'automatic'`). Omitting it
  silently enables dark mode on iOS even if your tokens don't support it.

---

## Snippet 1 — Root `_layout.tsx` shape

```tsx
import "../global.css";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";

import { queryClient } from "../src/lib/query-client";
import { userKeys, subscriptionKeys } from "../src/lib/query-keys";
import { useAuthStore } from "../src/stores/auth-store";
import { useI18nStore } from "../src/i18n/i18n-store";
import i18n from "../src/i18n";
import {
  initSentry, initPostHog, initRevenueCat,
  setRevenueCatUser, syncRevenueCatPurchases,
  initSuperwall, syncSuperwallEntitlement,
  subscribeSuperwallToRc, identifySuperwall,
} from "../src/lib"; // your lib barrel

export default function RootLayout() {
  const loadAuth  = useAuthStore((s) => s.loadAuth);
  const token     = useAuthStore((s) => s.token);
  const userId    = useAuthStore((s) => s.userId);
  const hydrateI18n = useI18nStore((s) => s.hydrate);
  const i18nReady = useI18nStore((s) => s.ready);

  useEffect(() => { void hydrateI18n(); }, [hydrateI18n]); // hydrate locale first
  useEffect(() => { /* cold-start init — see Snippet 2 */ }, [loadAuth]);
  useEffect(() => { /* identity-bound — see Snippet 3 */ }, [token, userId]);

  if (!i18nReady) return null; // render gate: never render Stack with half-hydrated state

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <I18nextProvider i18n={i18n}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style="dark" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: "#FAFAFA" }, // your canvas token
              }}
            />
            {/* Portal-level overlays (toasts, sign-in modals) go here,
                inside QueryClientProvider but outside Stack */}
          </QueryClientProvider>
        </SafeAreaProvider>
      </I18nextProvider>
    </GestureHandlerRootView>
  );
}
```

---

## Snippet 2 — Cold-start init effect (isolated)

```tsx
useEffect(() => {
  initSentry();    // first — captures any error in subsequent steps
  initPostHog();
  loadAuth();      // hydrates token+userId into the auth store async
  // RC: no appUserId at boot — binding happens in the identity effect.
  // Re-configuring on userId change is a no-op in the SDK but caused
  // stale-identity bugs when userId was passed here before hydration.
  initRevenueCat();
  // Superwall: configure best-effort; push current RC entitlement immediately
  // so the SDK exits its "unknown" state before the first paywall open.
  void initSuperwall().then(syncSuperwallEntitlement);
  // Forward future RC entitlement changes live; cleanup on unmount.
  const unsubSw = subscribeSuperwallToRc();
  return () => unsubSw();
}, [loadAuth]);
```

---

## Snippet 3 — Identity-bound reconciliation effect (isolated)

```tsx
useEffect(() => {
  if (!token || !userId) return;
  let cancelled = false;

  void (async () => {
    try {
      // 1. Bind RC to current user first — syncPurchases must run after logIn.
      await setRevenueCatUser(userId);
      // 2. Move this device's store receipt to the bound userId.
      //    logIn alone does NOT transfer receipts — omitting this strands
      //    paid users on the free tier until the RC webhook fires.
      await syncRevenueCatPurchases();
      // 3. Superwall identity strictly after RC — its entitlement check needs
      //    the receipt already bound.
      await identifySuperwall(userId);
      await syncSuperwallEntitlement();
      // 4. Analytics identity (fire-and-forget).
      // await posthog.identify(userId, { ... });

      if (cancelled) return;
      // 5. Server-side reconciliation: ask the API to re-read RC and update
      //    the users.subscription field. RC webhook handles renewals/expirations;
      //    this is the cold-start safety net for anonymous->signed-in transitions.
      await api("/user/subscription/sync", { method: "POST" });
    } catch {
      // Swallowed — safety net only; retries on next cold start.
    } finally {
      if (!cancelled) {
        queryClient.invalidateQueries({ queryKey: userKeys.me() });
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
      }
    }
  })();

  return () => { cancelled = true; };
}, [token, userId]);
```

---

## Snippet 4 — `app.config.ts` variant derivation

```ts
import type { ExpoConfig } from "expo/config";

// Three variants cover all standard deploy targets.
// The build script (EAS profile / local wrapper) sets APP_VARIANT.
// Default to 'development' so `expo run:android` works without extra env setup.
type Variant = "development" | "staging" | "production";
const variant = (process.env.APP_VARIANT ?? "development") as Variant;

const BUNDLE_BASE = "<YOUR_BUNDLE_BASE>"; // e.g. "com.yourco.yourapp"
const bundleId =
  variant === "production" ? BUNDLE_BASE : `${BUNDLE_BASE}.${variant}`;

const APP_NAME_BASE = "<Your App Name>";
const appName =
  variant === "production" ? APP_NAME_BASE : `${APP_NAME_BASE} (${variant})`;

// Exposed at runtime via Constants.expoConfig.extra.variant — lets Sentry,
// PostHog, and feature flags tag events with the right environment without
// a separate runtime env var.
const extra = {
  variant,
  eas: { projectId: "<your-eas-project-id>" },
};

const config: ExpoConfig = {
  name: appName,
  slug: "<your-slug>",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light", // explicit — never leave unset if light-only
  updates: {
    url: "https://u.expo.dev/<your-eas-project-id>",
  },
  // fingerprint: OTA runtime changes only when the native layer changes.
  // Never use 'appVersion' — it ties OTA eligibility to the human-edited
  // version string and causes cohort splits when you forget to bump it.
  runtimeVersion: {
    policy: "fingerprint",
  },
  ios: {
    bundleIdentifier: bundleId,
    // ...
  },
  android: {
    package: bundleId,
    // ...
  },
  extra,
  // plugins: [...],
};

export default config;
```

---

## Adapt for your project

- **Bundle base ID / app name base**: replace `<YOUR_BUNDLE_BASE>` and `<Your App Name>`.
  The `.variant` suffix is convention — some teams use a separate bundle id per variant.
- **Supported variants**: add `preview` or `qa` if your EAS profiles need them.
- **`ThemeProvider` (`@react-navigation/native`)**: omitted here because all screens use
  `headerShown: false`. Add it between `SafeAreaProvider` and `QueryClientProvider` if
  you ship visible native headers.
- **Observability / billing SDKs**: swap `initSentry`/`initPostHog`/`initRevenueCat`/
  `initSuperwall` for your equivalents. Preserve the ordering principle (error monitoring
  before auth, auth before billing) and the `try/catch/finally` + `cancelled` structure.
- **Canvas color**: replace `#FAFAFA` with your canvas token. For dark-mode support,
  derive from `useColorScheme()` and pass dynamically.
- **`userInterfaceStyle`**: use `'automatic'` only if all color tokens have dark variants.
