# Custom PurchaseController — Superwall ↔ RevenueCat bridge

## Why this exists

Superwall renders paywall UI remotely, but it does not drive purchases by itself. When you use a non-RevenueCatUI renderer (i.e. Superwall's own templates), Superwall hands the purchase off through a `PurchaseController` extension point that you implement.

The bridge pattern keeps RevenueCat as the single billing source of truth: every purchase and restore still flows through `Purchases.purchasePackage` / `Purchases.restorePurchases`. Superwall merely triggers the initiation; RC records the transaction, issues the entitlement, and remains the canonical ledger. No billing logic lives in Superwall — it is a presentation layer that delegates downward.

## Caveats RC documents (read before wiring)

- **Restore responsibility shifts to you.** When a custom controller is registered, RC no longer handles `restorePurchases` on Superwall's behalf. Your controller's `restorePurchases()` method must call `Purchases.restorePurchases()` and return a `RestorationResult`.

- **Superwall stops observing RC automatically.** With a custom controller registered, Superwall no longer subscribes to RC customer-info updates. You must push the entitlement state manually via `Superwall.shared.setSubscriptionStatus(...)` after every purchase, restore, and app-launch reconcile. Forgetting this causes `SWKPresentationError 105` — Superwall sees "unknown" entitlement state and times out every `register()` call instead of presenting.

- **Do not double-drive purchases.** Never render `RevenueCatUI.Paywall` alongside a custom `PurchaseController`. The two are mutually exclusive: once a custom controller is registered, RevenueCatUI paywall components no longer work correctly.

- **`basePlanId` / `offerId` cannot be honored through the package API.** `purchaseFromGooglePlay` receives these parameters but the RC package-based API resolves the active Play base plan internally. Note this limitation and revisit if your Play offerings use divergent base plans.

## The lifecycle — `purchaseByProductId`

`purchaseFromAppStore` and `purchaseFromGooglePlay` both delegate to the private `purchaseByProductId`. This is the complete method from `superwall-purchase-controller.ts`:

```ts
private async purchaseByProductId(productId: string): Promise<PurchaseResult> {
  // 1. Fetch the current RC offering. A failure here means we can't map the
  //    Superwall product id to an RC package — surface as Failed so Superwall
  //    can show an error state rather than hanging indefinitely.
  let offerings: Offerings;
  try {
    offerings = await getOfferings();
  } catch (err) {
    return new PurchaseResultFailed(`Failed to load offerings: ${errorMessage(err)}`);
  }

  // 2. Find the RC package whose store product id matches. Superwall passes the
  //    raw App Store / Play product id (e.g. "com.example.app.weekly"). RC's
  //    package wraps this as `package.product.identifier`.
  const pkg = offerings?.availablePackages?.find(
    (p) => p.product?.identifier === productId
  );
  if (!pkg) {
    return new PurchaseResultFailed(
      `No RevenueCat package found for product "${productId}".`
    );
  }

  // 3. Drive the purchase through RC. Three outcomes:
  //    a) throws userCancelled / PURCHASE_CANCELLED  → Cancelled (no sync)
  //    b) throws anything else                       → Failed(message)
  //    c) resolves boolean                           → see step 4
  let entitlementActive: boolean;
  try {
    entitlementActive = await purchasePackage(pkg);
  } catch (err) {
    if (isUserCancellation(err)) return new PurchaseResultCancelled();
    return new PurchaseResultFailed(errorMessage(err));
  }

  // 4. purchasePackage resolves `false` when the transaction completed but the
  //    premium entitlement is NOT active (wrong product, pending transaction,
  //    RC mapping gap). Treat as failure — the user is not entitled; do NOT
  //    call postPurchaseSync (would falsely mark them premium in Superwall).
  if (!entitlementActive) {
    return new PurchaseResultFailed(
      "Purchase completed but the entitlement is not active."
    );
  }

  // 5. Entitlement is active. Reconcile server + cache + Superwall, then
  //    signal success back to Superwall.
  await postPurchaseSync();
  return new PurchaseResultPurchased();
}
```

## `purchaseFromAppStore` vs `purchaseFromGooglePlay`

Both methods are thin wrappers around `purchaseByProductId`:

```ts
async purchaseFromAppStore(productId: string): Promise<PurchaseResult> {
  return this.purchaseByProductId(productId);
}

async purchaseFromGooglePlay(
  productId: string,
  _basePlanId?: string,
  _offerId?: string
): Promise<PurchaseResult> {
  // basePlanId / offerId cannot be honored through the RC package-based API.
  // RC resolves the active Play base plan / offer from the package internally.
  // Revisit if Play offerings diverge from base plans.
  return this.purchaseByProductId(productId);
}
```

RC abstracts the store: `purchasePackage` works identically on iOS (StoreKit) and Android (Play Billing). The `basePlanId` / `offerId` parameters passed by Superwall on Android are intentionally ignored in v1 — the package lookup by `productId` is sufficient for single-base-plan offerings.

## `restorePurchases`

The restore path mirrors `purchaseByProductId` but skips the package lookup:

```ts
async restorePurchases(): Promise<RestorationResult> {
  // rc.restorePurchases() pushes the device's store receipt to RC and returns
  // whether the PREMIUM_ENTITLEMENT became active as a result.
  let entitlementActive: boolean;
  try {
    entitlementActive = await restorePurchases();
  } catch (err) {
    return RestorationResult.failed(
      err instanceof Error ? err : new Error(errorMessage(err))
    );
  }

  // Nothing to restore — the user has no prior purchases for this product on
  // this store account. Superwall surfaces the error message to the user.
  if (!entitlementActive) {
    return RestorationResult.failed(
      new Error("No active entitlement to restore.")
    );
  }

  // Entitlement is active after restore. Reconcile exactly as after a purchase.
  await postPurchaseSync();
  return RestorationResult.restored();
}
```

Key difference from `purchaseByProductId`: `restorePurchases` never returns `Cancelled` — a restore that finds nothing active is an explicit `failed`, not a cancellation. This distinction matters for Superwall's error messaging.

## `postPurchaseSync` — the order matters

`postPurchaseSync` is called after every confirmed purchase or restore. It is also exported for use by any future purchase path that bypasses the controller (e.g. a standalone "restore" button). Best-effort throughout: a failure in any step must never block a confirmed entitlement.

```ts
async function postPurchaseSync(): Promise<void> {
  // 1. Tell the server to pull the latest RC state and update the DB.
  //    Best-effort: the server-side RC webhook is canonical; this call just
  //    makes the DB reflect premium immediately rather than waiting for the
  //    next webhook delivery.
  try {
    await api("/user/subscription/sync", { method: "POST" });
  } catch {
    /* swallow — server webhook is canonical */
  }

  // 2. Invalidate the TanStack Query cache so every screen re-fetches
  //    fresh data (subscription badge, scan gate, home dashboard).
  //    Both keys are invalidated: userKeys.me() for the profile/home data,
  //    subscriptionKeys.all for any subscription-specific queries.
  await queryClient.invalidateQueries({ queryKey: userKeys.me() });
  await queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });

  // 3. Push active status to Superwall. Required because a custom controller
  //    disables Superwall's automatic RC observation. Without this call,
  //    Superwall still sees "unknown" entitlement state and the next
  //    register() times out with SWKPresentationError 105.
  //    Non-fatal: if Superwall is mid-init, the next cold launch re-syncs
  //    from RC/API via syncSuperwallEntitlement().
  try {
    await Superwall.shared.setSubscriptionStatus(
      SubscriptionStatus.Active([PREMIUM_ENTITLEMENT])
    );
  } catch {
    /* non-fatal: next launch re-syncs status from RC/API */
  }
}
```

**Why this order:** The server sync and cache invalidations must happen first so that when the UI re-renders (triggered by the query invalidation), it reads fresh premium state from the API. The Superwall push is last because it only affects future paywall presentations — it has no effect on the current render cycle.

## Wiring at app start

The controller is passed to `Superwall.configure` once, at app launch. It must be registered **after** `initRevenueCat` completes, because `getOfferings()` (called inside `purchaseByProductId`) requires the RC SDK to be configured.

```ts
// From superwall.ts — initSuperwall()
await Superwall.configure({
  apiKey,
  purchaseController: new RcPurchaseController(),
});
```

After `configure` resolves, call `syncSuperwallEntitlement()` immediately to push the current RC state so Superwall is never left in "unknown":

```ts
// From _layout.tsx — after initSuperwall() resolves
await syncSuperwallEntitlement();
```

`subscribeSuperwallToRc` installs a live forward of RC's `addCustomerInfoUpdateListener` → `setSubscriptionStatus`. This covers server-driven state changes — webhook renewals, expirations, restores on another device — without requiring a cold restart:

```ts
// From _layout.tsx — mounted for app lifetime
const unsubscribe = subscribeSuperwallToRc();
// returns () => Purchases.removeCustomerInfoUpdateListener(handler)
```

Without `subscribeSuperwallToRc`, Superwall's entitlement status only updates after a cold launch (via `syncSuperwallEntitlement`). A user whose subscription was renewed server-side would see gated content until they force-quit and reopen the app.

## Detecting cancellation

RevenueCat throws a `PurchasesError` on cancellation rather than resolving a value. The shape varies across SDK versions:

```ts
function isUserCancellation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { userCancelled?: unknown; code?: unknown };
  // Modern RC SDK: PurchasesError.userCancelled === true
  if (e.userCancelled === true) return true;
  // Older RC SDK versions and some Android paths: code === "1" or code === 1
  // (PURCHASES_ERROR_CODE.PURCHASE_CANCELLED)
  if (e.code === "1" || e.code === 1) return true;
  return false;
}
```

Treat both as `PurchaseResultCancelled` — do not call `postPurchaseSync` and do not show an error to the user. Any other thrown error is `PurchaseResultFailed`. A user cancellation is an intentional dismissal, not a failure.

## Common errors and fixes

| Symptom | Root cause | Fix |
|---|---|---|
| `SWKPresentationError 105` on every `register()` | `setSubscriptionStatus` never called after purchase/restore, OR `syncSuperwallEntitlement()` not called at boot, OR `subscribeSuperwallToRc()` not mounted | Call `syncSuperwallEntitlement()` right after `initSuperwall()` resolves; ensure `subscribeSuperwallToRc()` is mounted; verify `postPurchaseSync` calls `setSubscriptionStatus` |
| `getOfferings()` returns `null` inside the controller | RC SDK not configured before the controller's first purchase attempt | Always call `initRevenueCat()` before `initSuperwall()` in `_layout.tsx`; the controller's `getOfferings` call requires RC to be configured |
| Purchase completes, receipt accepted, UI still shows free tier | TanStack Query cache not invalidated, or query key mismatch | Confirm `postPurchaseSync` invalidates the correct keys; use `setQueriesData` (prefix) not `setQueryData` (exact) if the query key includes a dynamic segment like locale (see Phase 0 `["user"]` vs `["user","me"]` dead-key bug) |
| "Restore" resolves `RestorationResult.restored()` but UI stays on free tier | `postPurchaseSync` not called inside `restorePurchases` on the success path | Ensure `await postPurchaseSync()` runs before `return RestorationResult.restored()` |
| `purchaseFromGooglePlay` silently uses wrong base plan | Multiple Play base plans active; `basePlanId` ignored | Revisit if your Play offering uses non-default base plans; the current implementation assumes one base plan per product |
| Controller purchase succeeds but PostHog `paywall_purchased` has no `plan` | `planSlugForProductId` couldn't resolve the product id | Check that the offering's `packageType` is `WEEKLY` or `MONTHLY`; custom package types are not mapped |
