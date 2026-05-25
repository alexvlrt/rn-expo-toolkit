---
name: expo-revenuecat-superwall
description: "Use when wiring RevenueCat + Superwall into a RN+Expo app, gating UI behind premium, syncing subscription state to a server, or handling the anon-to-identified user transition. Covers: RC init/identity, the custom Superwall PurchaseController bridge, the gate + fallback-overlay pattern, the logOut anonymous guard, the appUserID↔JWT-sub↔REST-customerId coupling, and server-side webhook reconciliation that never trusts the payload."
---

## Complements

Complements `RevenueCat:integrate-revenuecat` (base SDK setup — use that first),
`revenuecat-identify-user` (logIn/logOut and the anonymous-id rules),
`revenuecat-entitlements-gate` (CustomerInfo + listener), `revenuecat-purchase-flow`,
`revenuecat-paywall`, `revenuecat-troubleshoot`. This skill adds: the Superwall ↔ RC
bridge via a custom `PurchaseController`, the subscription gate hook + shared fallback
overlay, the anon-identity continuity pattern (`/auth/refresh` keeps the anonymous
appUserID stable across JWT expiry), and the server-side never-trust-the-webhook
reconciliation against RC REST v2.

## Authority-preferred default

**RevenueCatUI.Paywall** (the built-in remote-template paywall) is the right default
when you don't need Superwall's A/B / holdout / audience-matching features. It requires
zero `PurchaseController` wiring, handles restore automatically, and Superwall docs
explicitly call the custom-controller path "advanced". Only adopt the
`PurchaseController`-with-Superwall path when you need Superwall-specific features
(remote A/B tests on paywall copy, holdout experiments, audience-matched paywalls).

## Conventions

### Identity

- Configure RC **once** at app launch: `Purchases.configure({ apiKey, appUserID: undefined })`.
  `appUserID: undefined` starts anonymous — RC mints `$RCAnonymousID:<uuid>`. Pass a
  known `userId` only when you already have an authenticated identity at launch.
- `appUserID` must be a **stable opaque UUID** — never a sequential integer, email, or phone.
  This UUID is also your JWT `sub` and the `customerId` you pass to RC REST v2. Document
  this three-way coupling explicitly — it's the root cause of the "orphaned anonymous
  purchases" pitfall when it drifts.
- Call `Purchases.logIn(userId)` after a user signs in (not `configure` again — RC ignores
  repeated `configure` calls; the `configured` guard prevents double-init).
- **`Purchases.logOut()` MUST be guarded** behind an anonymous-id check. RC throws
  `LogOutWithAnonymousUserError` if the current appUserID starts with `$RCAnonymousID:`.
  See snippet 1 below.
- Keep the anonymous appUserID stable across JWT expiry by having your `/auth/refresh`
  endpoint return the same `users.id` instead of minting a new one. Rotating the id
  orphans all purchases made under the old id — the user appears "free" on the next cold
  start even though they paid.

### Entitlements

- Export exactly **one** `PREMIUM_ENTITLEMENT` constant. Never duplicate the literal
  anywhere — a typo silently gates every user out.
- Runtime source of truth: `customerInfo.entitlements.active[PREMIUM_ENTITLEMENT]?.isActive ?? false`.
- Subscribe to live entitlement flips (webhook-driven renewals / expirations / restores)
  via `Purchases.addCustomerInfoUpdateListener`. Returns an unsubscribe handle; mount at
  app root for the app lifetime. See snippet 2.

### Custom PurchaseController (Superwall bridge)

Only when the paywall renderer is Superwall (not RevenueCatUI). When used:

- **You own restore.** Implement `restorePurchases()` returning `RestorationResult`.
- **You own the status push.** After every purchase/restore, call
  `Superwall.shared.setSubscriptionStatus(SubscriptionStatus.Active([PREMIUM_ENTITLEMENT]))`.
  Without this, Superwall stays on `unknown` and every `register({ placement })` times
  out with `SWKPresentationError 105` ("entitlement status failed to change from unknown").
- **You own the boot-time push.** Call `syncSuperwallEntitlement()` right after
  `Superwall.configure()` resolves to seed the initial status; also call it after every
  `Purchases.logIn` + `syncPurchases` sequence.
- Map Superwall's `productId` to an RC package via `getOfferings()` — find the package
  where `package.product.identifier === productId`, then drive `Purchases.purchasePackage`.
- User cancellation surfaces as a **thrown error** (`userCancelled: true` or `code === "1"`),
  not a resolved `false` — detect it before mapping to `PurchaseResultFailed`. See snippet 3.

See `references/superwall-bridge.md` for the full lifecycle deep-dive.

### Gate UI

- `resolveGateAction` is a **pure async function** (no React, no global state — testable
  without mocking hooks). It takes `{ isSubscribed, placement, action, presentFallback }`.
  If subscribed, call `action()` immediately. If not, call `registerPlacement(placement)`
  and pass the `PaywallOutcome` through `shouldShowFallback`. See snippet 4.
- `useSubscriptionGate()` wraps `resolveGateAction` in a `useCallback`, reading
  `isSubscribed` from the user query. Returns `{ isSubscribed, gateOr }`.
- `PaywallFallbackStore` (Zustand): a single `{ request, present, dismiss }` store. The
  gate writes `present(placement)` when Superwall cannot show anything; a single
  `<PaywallFallback>` overlay mounted at the tab-layout root reads it. This guarantees
  at most one overlay app-wide — two gate callers never stack overlays.
- **Tab-press gating** attaches to `Tabs.Screen listeners={{ tabPress }}` with
  `e.preventDefault()` before calling `gateOr`. This is one of the few legitimate
  reasons to keep JS `<Tabs>` (Expo Router) over `NativeTabs` — `NativeTabs` does not
  expose a JS `tabPress` interceptor. See snippet 5.

### Server-side reconciliation

- **Never trust the webhook payload** for subscription state. Use the event only for
  routing (`app_user_id`, idempotency `event.id`). Re-read RC REST v2
  (`/v2/projects/.../customers/.../active_entitlements` then `/subscriptions`) and derive
  state from there.
- Three-state `RcEntitlementState`: `active` / `inactive` / `unknown`. **Never downgrade
  on `unknown`** — a transient RC outage must not revoke a paying user. Return 503 to
  trigger RC retry. See snippet 6.
- KV idempotency dedupe on `event.id` (7-day TTL covers RC's full retry window).
- **Constant-time bearer comparison** on the webhook `Authorization` header — use
  `timingSafeEqual` (Node's `node:crypto` or the Workers-compatible polyfill).
- Reconcile function is shared between the webhook route and the mobile
  `/user/subscription/sync` safety-net endpoint — one implementation, two callers.
- Development sandbox guard: never revoke premium in `development` environment (StoreKit /
  Play sandbox subscriptions renew on an accelerated ~5-minute clock; RevenueCat reports
  them expired almost immediately while entitlement still says active).

See `references/server-reconciliation.md` (co-authored with `api-backend-patterns` in
Phase 4 of this toolkit; not on disk yet). The canonical pattern is a Hono + Drizzle +
RC REST v2 reconciler — your backend's webhook handler should follow the rules in this
section regardless of the framework.

---

## Inline snippets

### Snippet 1 — `PREMIUM_ENTITLEMENT` constant + `clearRevenueCatUser` with anonymous guard

```ts
import Purchases from "react-native-purchases";

// Single source of truth. A typo here silently gates every user out.
export const PREMIUM_ENTITLEMENT = "<YOUR_ENTITLEMENT_ID>";

let configured = false;

export async function initRevenueCat(userId?: string) {
  const key = Platform.OS === "ios" ? IOS_API_KEY : ANDROID_API_KEY;
  if (!key || configured) return;
  Purchases.configure({ apiKey: key, appUserID: userId });
  configured = true;
}

export async function setRevenueCatUser(userId: string) {
  if (!configured) return;
  await Purchases.logIn(userId);
}

// logOut throws LogOutWithAnonymousUserError when the SDK is on an anonymous id
// (prefixed "$RCAnonymousID:"). Guard before calling.
export async function clearRevenueCatUser() {
  if (!configured) return;
  try {
    const info = await Purchases.getCustomerInfo();
    if (info.originalAppUserId.startsWith("$RCAnonymousID:")) return;
  } catch {
    return; // can't read identity → safest to skip logOut
  }
  await Purchases.logOut();
}
```

### Snippet 2 — Customer-info listener + entitlement check

```ts
import Purchases, { type CustomerInfo } from "react-native-purchases";
import { PREMIUM_ENTITLEMENT } from "./revenue-cat";

// Point-in-time check — call on cold start and after logIn/syncPurchases.
export async function checkSubscription(): Promise<boolean> {
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return customerInfo.entitlements.active[PREMIUM_ENTITLEMENT]?.isActive ?? false;
  } catch {
    return false;
  }
}

// Forwards a boolean so callers don't need to know the entitlement key.
// Returns unsubscribe handle — mount at app root for the app lifetime.
export function onCustomerInfoUpdate(cb: (isPremium: boolean) => void): () => void {
  const handler = (info: CustomerInfo) => {
    cb(info.entitlements.active[PREMIUM_ENTITLEMENT]?.isActive ?? false);
  };
  Purchases.addCustomerInfoUpdateListener(handler);
  return () => Purchases.removeCustomerInfoUpdateListener(handler);
}
```

### Snippet 3 — Custom `PurchaseController` shape (summary)

```ts
import {
  PurchaseController, PurchaseResult,
  PurchaseResultCancelled, PurchaseResultFailed, PurchaseResultPurchased,
  RestorationResult,
} from "expo-superwall/compat";
import { getOfferings, purchasePackage, restorePurchases } from "./revenue-cat";

// Bridges Superwall's purchasing to RevenueCat.
// Superwall hands a store product id; we map it to an RC package and drive the
// purchase through RC so RC stays the single billing source of truth.
export class RcPurchaseController extends PurchaseController {
  async purchaseFromAppStore(productId: string): Promise<PurchaseResult> {
    return this.purchaseByProductId(productId);
  }

  async purchaseFromGooglePlay(productId: string): Promise<PurchaseResult> {
    // RC abstracts the store; basePlanId/offerId not honored in v1.
    return this.purchaseByProductId(productId);
  }

  private async purchaseByProductId(productId: string): Promise<PurchaseResult> {
    const offerings = await getOfferings().catch((e) =>
      Promise.reject(new PurchaseResultFailed(`offerings: ${e}`))
    );
    const pkg = offerings?.availablePackages?.find(
      (p) => p.product?.identifier === productId
    );
    if (!pkg) return new PurchaseResultFailed(`No RC package for "${productId}"`);

    let active: boolean;
    try {
      active = await purchasePackage(pkg);
    } catch (err) {
      // RC surfaces user cancellation as a thrown error, not a false result.
      if (isUserCancellation(err)) return new PurchaseResultCancelled();
      return new PurchaseResultFailed(errorMessage(err));
    }
    if (!active) return new PurchaseResultFailed("Entitlement not active after purchase.");
    await postPurchaseSync(); // server sync + query invalidation + Superwall status push
    return new PurchaseResultPurchased();
  }

  async restorePurchases(): Promise<RestorationResult> {
    const active = await restorePurchases().catch((e) =>
      RestorationResult.failed(e instanceof Error ? e : new Error(String(e)))
    );
    if (typeof active === "object") return active; // already a RestorationResult from catch
    if (!active) return RestorationResult.failed(new Error("No active entitlement."));
    await postPurchaseSync();
    return RestorationResult.restored();
  }
}

// See references/superwall-bridge.md for the full lifecycle, postPurchaseSync
// implementation, cancellation detection, and the setSubscriptionStatus coupling.
```

### Snippet 4 — Gate hook + fallback store

```ts
import { create } from "zustand";
import { registerPlacement, shouldShowFallback } from "../lib/superwall";
import { useUser } from "./use-user";
import { isPremium } from "@your-shared/types";

// Single fallback store — at most one overlay app-wide.
export const usePaywallFallbackStore = create<{
  request: { placement: string } | null;
  present: (placement: string) => void;
  dismiss: () => void;
}>((set) => ({
  request: null,
  present: (placement) => set({ request: { placement } }),
  dismiss: () => set({ request: null }),
}));

// Pure decision function (no React — unit-testable without mocking hooks).
export async function resolveGateAction(opts: {
  isSubscribed: boolean;
  placement: string;
  action: () => void;
  presentFallback: (placement: string) => void;
  params?: Record<string, unknown>;
}): Promise<void> {
  if (opts.isSubscribed) { opts.action(); return; }
  const outcome = await registerPlacement(opts.placement, opts.params);
  if (shouldShowFallback(outcome)) opts.presentFallback(opts.placement);
}

export function useSubscriptionGate() {
  const { data: user } = useUser();
  const isSubscribed = isPremium(user?.subscription);
  const gateOr = useCallback(
    (callback: () => void, trigger = "unknown", params?: Record<string, unknown>) => {
      void resolveGateAction({
        isSubscribed, placement: trigger, action: callback,
        presentFallback: usePaywallFallbackStore.getState().present, params,
      });
    },
    [isSubscribed]
  );
  return { isSubscribed, gateOr };
}
```

### Snippet 5 — Tab-press gating (why JS `<Tabs>` stays over `NativeTabs`)

```tsx
// In app/(tabs)/_layout.tsx
// NativeTabs does not expose a JS tabPress interceptor — this is why we keep
// JS <Tabs> (Expo Router) for any tab that needs a premium gate.
<Tabs.Screen
  name="scan"
  options={{ title: t("tabs.scan"), tabBarIcon: ({ color, size }) => <ScanLine size={size} color={color} /> }}
  listeners={{
    tabPress: (e) => {
      if (!isSubscribed) {
        e.preventDefault(); // block default navigation
        gateOr(() => router.push("/(tabs)/scan"), PLACEMENTS.SCAN_TAB);
      }
    },
  }}
/>
```

### Snippet 6 — Server reconciliation: three-state never-downgrade

```ts
// lib/revenuecat.ts (server, Hono/Cloudflare Workers)
//
// Three-state discriminated union — TypeScript exhaustiveness ensures callers
// handle unknown separately. The previous `boolean | null` invited patterns
// that silently downgraded paying users on every RC transient blip.
export type RcEntitlementState =
  | { kind: "active" }
  | { kind: "inactive" }
  | { kind: "unknown"; reason: "unconfigured" | "fetch_failed" | "http_error" };

// services/subscription.ts — the reconcile function
export async function reconcileSubscriptionFromRC(
  env: Env, db: DB, userId: string
): Promise<{ kind: "ok" | "unmapped" | "rc_unavailable" }> {
  const ent = await rcCustomerEntitlementState(env, userId);
  // NEVER downgrade on unknown — RC outage must not revoke premium.
  if (ent.kind === "unknown") return { kind: "rc_unavailable" };

  if (ent.kind === "inactive") {
    // Lapse the active row (except in development — sandbox subs expire fast).
    if (env.ENVIRONMENT !== "development") await lapseActiveRow(db, userId);
    return { kind: "ok" };
  }
  // ent.kind === "active": resolve plan + dates from /subscriptions endpoint.
  // ...upsert subscription row... (see apps/api/src/services/subscription.ts)
  return { kind: "ok" };
}

// In the webhook route: return 503 on rc_unavailable so RC retries.
const result = await reconcileSubscriptionFromRC(env, db, userId);
if (result.kind === "rc_unavailable") return c.json({ error: "rc_unavailable" }, 503);
```

---

## Heavy patterns (references/)

Two sub-patterns are too dense for this SKILL.md:

### `references/superwall-bridge.md` (Task 4 of Phase 2)

The complete `RcPurchaseController` lifecycle: `purchaseFromAppStore` → `getOfferings` →
package lookup → `purchasePackage` → result mapping; `restorePurchases` mirror;
`postPurchaseSync` order (server sync → query invalidation → `setSubscriptionStatus`);
the `addCustomerInfoUpdateListener` → Superwall status wire-up at boot; cancellation
detection (`userCancelled === true` OR `code === "1"` / `code === 1`); common
`SWKPresentationError 105` cause and fix.

### Server reconciliation deep-dive (deferred, planned for Phase 4)

The dedicated `references/<…>.md` file for the webhook + RC REST v2 reconciliation
pattern is co-authored with the `api-backend-patterns` skill in Phase 4 (not yet
on disk — do not look for a broken link). For now, the canonical Hono + Drizzle
implementation is `apps/api/src/services/subscription.ts` in the source monorepo.
Key patterns it encodes: KV idempotency dedupe on `event.id` (7-day TTL),
constant-time bearer comparison, the three-state never-downgrade logic,
development-sandbox guard, and `rc_unavailable → 503` so RC retries on transient
outages.

---

## Adapt for your project

- **Entitlement id** — replace `<YOUR_ENTITLEMENT_ID>` with your RC entitlement
  identifier (the `lookup_key` from the RC dashboard, e.g. `"premium"`).
- **RC API key env names** — the example uses `EXPO_PUBLIC_REVENUECAT_IOS_KEY` /
  `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`. Adapt to your `.env` convention.
- **Superwall placement names** — define a `PLACEMENTS` registry (a `const` object) in
  a single module. Never scatter placement string literals across screens.
- **A/B holdout policy** — `shouldShowFallback` skips the hard gate for `"holdout"` and
  `"user_subscribed"` reasons (intentional product decisions). Adjust if your product
  treats holdouts differently.
- **Backend route paths** — `/user/subscription/sync`, `/webhooks/revenuecat`, and the
  RC REST v2 endpoint URLs above are example paths. Swap for your own route structure.
- **JWT auth shape** — the `users.id` ↔ JWT `sub` ↔ RC `appUserID` three-way coupling
  is load-bearing. If your auth shape is different (e.g. a separate `rcCustomerId`
  column), update the reconcile logic to look up by that column, not `users.id`.
- **`postPurchaseSync`** — the server-sync call (`POST /user/subscription/sync`) and
  query keys to invalidate will be different in your app. Extract as a named function
  in your `PurchaseController` to keep the reconcile path easy to audit.
