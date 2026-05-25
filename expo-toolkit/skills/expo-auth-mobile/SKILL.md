---
name: expo-auth-mobile
description: "Use when wiring Sign in with Apple / Google into a RN+Expo app, establishing a stable device identity, or upgrading an anonymous user to a named account WITHOUT losing their data. Covers: obtaining raw provider ID tokens, POSTing to your backend, the single-flight silent-refresh loop that keeps anonymous sessions alive across token expiry, the device-id helper (SecureStore native / localStorage web), and the in-place anonymous→identified merge pattern — including the email-vs-OAuth parity trap that caused silent data loss in production apps."
---

> **Complements:** `api-backend-patterns` (server-side OIDC verify at provider JWKS,
> per-resource authz-404 rule, token-version revocation); `RevenueCat:revenuecat-identify-user`
> (keeping `appUserID` continuous across the anon→identified transition).

---

## Conventions checklist

### Sign in with Apple / Google (mobile side)

- Obtain the **raw provider ID token** from the SDK — do not decode it client-side or
  derive any identity from it. The mobile app is a messenger, not a verifier.
- **POST the raw token to your backend**. The backend verifies it at the provider's JWKS
  endpoint (cross-ref `api-backend-patterns` — OIDC verify pattern).
- **Apple:** always generate and send a `nonce`. Include it in the Apple sign-in request
  (`nonce`) and echo it in your backend POST so the backend can assert `nonce` in the
  decoded token, which prevents replay.
- **Google:** use `@react-native-google-signin/google-signin`. Call
  `GoogleSignin.hasPlayServices()` before `signIn()` on Android.
- Pass the current **anonymous user id** (from your auth store) as `anonymousUserId` in
  the POST body so the backend can perform an in-place upgrade rather than create a new
  account (see Merge section below).
- **Clear the query cache** (`queryClient.removeQueries()`) immediately after a successful
  sign-in POST and before writing the new JWT — stale cache entries from the previous
  session must never briefly flash under the new identity.
- After sign-in: write the new token to SecureStore, update the auth store with the new
  `userId`, then call `Purchases.logIn(userId)` (RevenueCat) so future purchase events
  attribute to the correct RC profile.

### Stable device identity

- Generate a UUID at first launch and persist it in `expo-secure-store` (native) or
  `localStorage` (web). Never regenerate it unless the user explicitly triggers a full
  reset.
- **Platform-split the implementation**: the native file imports `expo-secure-store`; the
  `.web.ts` sibling uses `localStorage`. This keeps the bundle clean — Expo Router's
  platform-resolution picks the right one automatically.
- Include structured **device metadata** in anonymous-auth requests: `platform`, `model`,
  `os_version`, `app_version`, `locale`, `timezone`. The backend uses these (plus
  `device_id`) for idempotence — a relaunch after a crash re-issues the same anonymous
  account rather than minting a new one.
- Provide a `clearDeviceId()` utility for dev reset flows. Without it, "fresh-install"
  simulation resurrects the previous anonymous user via the backend's idempotence check,
  masking the real first-launch behavior.

### Anonymous-first auth

- Issue an anonymous account at first launch via `POST /auth/anonymous` with the device
  metadata above. Every piece of user data is keyed by `userId` from that point on.
- **The token must stay alive across expiry.** Without a refresh mechanism, a short-lived
  JWT silently expires; the next 401 clears the token and re-mints a fresh anonymous
  account, orphaning all scans/progress permanently. This failure mode is deterministic
  and time-delayed — it appears days after shipping.
- Implement a **single-flight silent-refresh interceptor** (see snippet below). The
  outcome must be three-valued: `"refreshed"` (replay the request), `"rejected"` (token
  is genuinely dead — clear session, return to onboarding), `"unavailable"` (transient
  network/5xx — do NOT clear the token; surface a retryable error instead). Clearing on a
  transient error is a silent data-loss bug.
- **Identity-swap guard**: before committing a refreshed token, compare the returned
  `userId` to the stored one. Reject the refresh if they differ. All user data is keyed by
  `userId`; a silent rebind would cross-contaminate health/financial data.

### The anonymous → identified MERGE (critical — caused data loss in production, twice)

The fundamental requirement is an **in-place account upgrade**: link the OAuth (or email)
credential to the existing anonymous user row, keeping the **same `userId`**. Creating a
new user row and redirecting the session to it orphans all progress.

**Failure mode 1 — "happy path only" backend**: OAuth merges correctly (backend detects
`anonymousUserId` in the POST body and upgrades in-place), but the email/password
registration route is a public endpoint that always calls `User::create()` — token
ignored, new account created. Both code paths must merge into the existing anonymous user.

**Failure mode 2 — anon token already expired**: if the anonymous JWT has expired by the
time the user signs in, `anonymousUserId` may not be in the store (cleared on rejected
refresh). The backend must also accept a device-id-based lookup as a fallback merge key.

**RevenueCat continuity**: call `Purchases.logIn(newUserId)` immediately after the server
confirms the upgrade. The RC SDK keeps purchase history on the pre-merge anonymous RC
profile; `logIn` transfers it to the identified profile. Do this before routing the user
onward — a paywall check on the destination screen must see the merged entitlements.

**Token-version bump**: on a successful account link, the server must increment
`token_version` for that user so all pre-link anonymous tokens are revoked. This
prevents a stolen anon token from continuing to authenticate as the now-identified user.

**Authz-404 still applies**: after merge the `userId` is unchanged, so all existing
per-resource ownership checks continue to pass without modification (cross-ref
`api-backend-patterns`).

#### Merge correctness checklist

Run this against your backend before shipping the sign-in flow:

- [ ] `POST /auth/apple` and `POST /auth/google` with a valid `anonymousUserId`: response
  `user.id` equals `anonymousUserId` (upgrade), not a new UUID (new account).
- [ ] Same test for any email/password registration path if you support one.
- [ ] All data rows previously owned by the anonymous `userId` are still visible after
  sign-in (no orphaning).
- [ ] `token_version` incremented in the DB row after a successful link.
- [ ] Old anonymous JWT rejected by a protected endpoint after the link.
- [ ] `Purchases.logIn(userId)` called — RC profile shows pre-merge purchase history.
- [ ] If the anon JWT was expired at sign-in time, the merge still succeeds (device-id
  fallback or graceful new-account creation without data loss).
- [ ] Non-owner test: the merged `userId` cannot read another user's resources (authz-404
  unchanged).

---

## Snippets

### Apple sign-in — nonce + raw token → POST

```ts
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { useAuthStore } from "@/stores/auth-store";
import { api } from "@/lib/api";
import { setRevenueCatUser } from "@/lib/revenue-cat";

async function handleAppleSignIn(queryClient: ReturnType<typeof useQueryClient>) {
  // Generate a random nonce; the backend echoes it in the JWKS verification.
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce
  );

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
    ],
    nonce: hashedNonce,
  });
  if (!credential.identityToken) throw new Error("No identity token");

  const { userId: anonymousUserId } = useAuthStore.getState();

  // Clear stale cache BEFORE the new JWT lands.
  queryClient.removeQueries();

  const resp = await api.post<{ token: string; user: { id: string } }>("/auth/apple", {
    identityToken: credential.identityToken,
    nonce: rawNonce,          // raw — backend hashes before comparing
    anonymousUserId: anonymousUserId ?? undefined,
    fullName: [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean).join(" ") || undefined,
  });

  await useAuthStore.getState().setAuth(resp.token, resp.user.id);
  await setRevenueCatUser(resp.user.id);    // RC identity continuity
}
```

### Google sign-in — raw idToken → POST

```ts
import { GoogleSignin } from "@react-native-google-signin/google-signin";

// Call once at app startup (e.g. in your root _layout.tsx):
GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
});

async function handleGoogleSignIn(queryClient: ReturnType<typeof useQueryClient>) {
  await GoogleSignin.hasPlayServices();   // no-op on iOS; required on Android
  const result = await GoogleSignin.signIn();
  if (result.type === "cancelled") return;

  const idToken = result.data.idToken;
  if (!idToken) throw new Error("No idToken");

  const { userId: anonymousUserId } = useAuthStore.getState();
  queryClient.removeQueries();

  const resp = await api.post<{ token: string; user: { id: string } }>("/auth/google", {
    idToken,
    anonymousUserId: anonymousUserId ?? undefined,
  });

  await useAuthStore.getState().setAuth(resp.token, resp.user.id);
  await setRevenueCatUser(resp.user.id);
}
```

### Device-id helper (native + web)

`src/lib/device-id.ts` — native implementation:

```ts
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import * as Localization from "expo-localization";
import Constants from "expo-constants";
import { Platform } from "react-native";

const DEVICE_ID_KEY = "<YOUR_APP_PREFIX>_device_id";

export async function getOrCreateDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
  }
  return id;
}

export async function clearDeviceId(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
}

export async function collectDeviceMetadata() {
  const device_id = await getOrCreateDeviceId();
  return {
    device_id,
    platform: Platform.OS as "ios" | "android",
    device_model: Device.modelName ?? null,
    os_version: Device.osVersion ?? null,
    app_version: Constants.expoConfig?.version ?? null,
    locale: Localization.getLocales()[0]?.languageTag ?? null,
    timezone: Localization.getCalendars()[0]?.timeZone ?? null,
  };
}
```

`src/lib/device-id.web.ts` — web stub (same export shape):

```ts
const DEVICE_ID_KEY = "<YOUR_APP_PREFIX>_device_id";

export function getOrCreateDeviceId(): Promise<string> {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_ID_KEY, id); }
  return Promise.resolve(id);
}
export function clearDeviceId(): Promise<void> {
  localStorage.removeItem(DEVICE_ID_KEY); return Promise.resolve();
}
// collectDeviceMetadata() web stub omitted — fill in as needed.
```

Expo Router resolves `device-id.web.ts` over `device-id.ts` on web automatically.

### Single-flight silent-refresh interceptor

```ts
// src/lib/api.ts  (excerpt — add to your fetch wrapper)

type RefreshOutcome = "refreshed" | "rejected" | "unavailable";
let refreshInFlight: Promise<RefreshOutcome> | null = null;

async function refreshAuthToken(): Promise<RefreshOutcome> {
  const current = await SecureStore.getItemAsync("auth_token");
  if (!current) return "rejected";

  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${current}` },
    });
  } catch {
    return "unavailable"; // network down — keep the token
  }

  if (res.status === 401) return "rejected";
  if (!res.ok) return "unavailable"; // 429 / 5xx — transient

  const data = await res.json() as { token: string; user: { id: string } };

  // Identity-swap guard: never rebind this device to a different userId.
  const prevUserId = useAuthStore.getState().userId;
  if (prevUserId && data.user.id !== prevUserId) return "unavailable";

  await useAuthStore.getState().setAuth(data.token, data.user.id);
  return "refreshed";
}

export function refreshTokenOnce(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = refreshAuthToken().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// In your fetch wrapper, on a 401 (first attempt only):
//   const outcome = await refreshTokenOnce();
//   if (outcome === "refreshed")   return retry(request);
//   if (outcome === "unavailable") throw new ApiError(503, "auth_refresh_unavailable");
//   // "rejected" → fall through, let the 401 surface → clear session → onboarding
```

### Anonymous → identified upgrade (client side)

```ts
// Called after the user completes OAuth or email sign-in on a screen
// where the session is still anonymous.

async function upgradeToIdentifiedUser(
  provider: "apple" | "google" | "email",
  credentials: Record<string, string>,
  queryClient: ReturnType<typeof useQueryClient>
) {
  const { userId: anonymousUserId, token: currentToken } = useAuthStore.getState();

  // The in-place merge endpoint — must return the SAME userId, not a new one.
  const resp = await api.post<{ token: string; user: { id: string } }>("/auth/link", {
    provider,
    ...credentials,
    anonymousUserId,
  });

  // Guard: confirm the server upgraded in place. A new UUID means the backend
  // created a fresh account — data is already orphaned; surface the bug loudly.
  if (resp.user.id !== anonymousUserId) {
    // Log to your error tracker; do not silently proceed.
    throw new Error(`Merge failed: server returned new userId ${resp.user.id}`);
  }

  // Commit the new (token-version-bumped) JWT.
  queryClient.removeQueries();
  await useAuthStore.getState().setAuth(resp.token, resp.user.id);

  // RC identity: logIn transfers pre-merge purchase history to the identified profile.
  // Do this before navigating to any paywalled screen.
  try {
    const { customerInfo } = await Purchases.logIn(resp.user.id);
    // Optionally refresh your entitlement store with customerInfo here.
  } catch {
    // RC failure must never block sign-in — log and continue.
  }
}
```

---

## Adapt for your project

| Placeholder | Fill in |
|---|---|
| `<YOUR_APP_PREFIX>_device_id` | Your bundle-scoped SecureStore key (e.g. `com.example.app_device_id`) |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | OAuth 2.0 Web client ID from Google Cloud Console |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | iOS client ID from Google Cloud Console |
| `/auth/apple`, `/auth/google` | Your backend sign-in endpoints |
| `/auth/link` | Your in-place upgrade endpoint (may be `/auth/upgrade` or provider-specific) |
| `/auth/refresh` | Your token-refresh endpoint (must re-sign same `userId`, gate on `token_version`) |
| `setRevenueCatUser` | Your RC identity helper — wraps `Purchases.logIn` with error swallowing |
| `useAuthStore` | Your Zustand (or equivalent) auth store |
| Email path | If you support email+password, wire the same `anonymousUserId` merge logic into your registration endpoint — OAuth merging while email silently creates a new account is the most common parity bug (see Merge checklist item 2) |
