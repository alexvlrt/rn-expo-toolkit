---
name: expo-state-data
description: "Use when wiring TanStack Query and Zustand into a RN+Expo app, designing query keys, writing optimistic-update mutations, or persisting auth/onboarding state to SecureStore. Enforces: a centralized query-keys factory (no inline ['user', ...] literals), the 4-step optimistic-update lifecycle, setQueriesData (prefix) for locale-keyed caches, SecureStore for tokens (never AsyncStorage), and a single-flight identity-pinned token-refresh wrapper that never rebinds the device to a different userId."
---

> **Complements:** `tanstack-query-best-practices` (qk-factory-pattern,
> mut-optimistic-updates, mut-invalidate-queries, cache-stale-time) and
> `native-data-fetching` (fetch wrapper + error handling). Use those first —
> this skill adds the locale-keyed-prefix optimistic-update gotcha, the
> identity-pinned refresh wrapper, and the SecureStore Zustand-persist adapter.

## Authority-preferred defaults

- **TanStack Query v5** for server state; **Zustand v5** for local state.
- Native screen data: **`useQuery`**, not Expo Router loaders (web-only; see
  `native-data-fetching` → `expo-router-loaders.md`).

---

## Conventions

1. **QueryClient defaults** — `staleTime: 1000 * 60 * 5` (5 min), `retry: 2`.
   Override per-query when needed (`staleTime: 0` for feeds, `retry: 0` for auth).

2. **Centralized `query-keys.ts` factory** — mandatory past ~10 queries. Inline
   literals drift silently: Phase 0 caught a `["user"]` vs `["user","me"]` split
   that stranded subscription invalidations for weeks. Return types: `as const`
   tuples so TypeScript can verify key shapes.

3. **Factory key shapes** — `userKeys.me() → ["user","me"]`, `subscriptionKeys.all → ["subscription"]`,
   `scanKeys.detail(id, locale) → ["scan", id, locale]`, `scanKeys.forId(id) → ["scan", id]` (prefix).

4. **Optimistic-update lifecycle** (4 steps, all required): `onMutate` →
   `cancelQueries` then snapshot with `getQueryData` then `setQueryData` and
   return `{ previous }`. `onError` → restore via `setQueryData(KEY, ctx.previous)`.
   `onSettled` → `invalidateQueries` always, even on success.

5. **⭐ Locale-keyed-prefix gotcha** — when the query key has a dynamic locale
   suffix (e.g. `["me", "home", "en"]`), optimistic writes MUST use
   `setQueriesData({ queryKey: ["me", "home"] }, updater)` (prefix match), NOT
   `setQueryData(["me", "home"], updater)` (exact match). The exact form targets
   a cache slot nobody subscribes to — the mutation appears to succeed while the
   deleted/changed item stays visible until the next network refetch (a silent
   no-op). Same applies to `cancelQueries` and `invalidateQueries`. **A production
   app shipped this bug: a `useDeleteX` mutation used `setQueryData` and the
   deleted item reappeared on every page until the user pulled to refresh.**

6. **Auth tokens in SecureStore, never AsyncStorage** — writes to iOS Keychain /
   Android Keystore. Use `WHEN_UNLOCKED_THIS_DEVICE_ONLY` for health-adjacent
   apps (blocks iCloud Keychain sync; Apple requires this for health data).

7. **Persisted Zustand stores** — wire a thin `secureStorage` adapter via
   `createJSONStorage(() => secureStorage)`. Always `partialize` to strip
   actions/getters; persisting functions crashes on cold restore.

8. **⭐ Single-flight identity-pinned token refresh** — a module-level promise
   guard ensures concurrent 401s share one in-flight refresh call. After the
   response, verify `data.user.id === storedUserId` and return `"unavailable"`
   on a mismatch — never let a refresh silently rebind the device to a different
   identity (all health data is keyed by userId).

9. **Three-valued refresh outcome** — `"refreshed" | "rejected" | "unavailable"`:
   - `"refreshed"` → new token received; replay the original request.
   - `"rejected"` → `/auth/refresh` returned 401; session is genuinely dead —
     surface the 401 so `RootRedirect` can clear it.
   - `"unavailable"` → network error, 429, 5xx, or identity mismatch. **Never
     clear the token here** — the session may still be valid and clearing it
     would orphan the anonymous userId plus every scan tied to it.

10. **Network errors normalize to `ApiError(0, "NETWORK_ERROR")`** — catch the
    transport-level `TypeError` at the fetch call site, re-throw as a typed
    `ApiError`. Error UIs branch on `err.status === 0`.

---

## Inline snippets

### 1 — `src/lib/query-client.ts`

```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 min — most screens tolerate slightly stale data
      retry: 2,                  // 3 total attempts before surfacing an error
    },
  },
});
```

### 2 — `src/lib/query-keys.ts`

```ts
// One definition per resource. A typo-or-drift in inline literals caused a
// ["user"] vs ["user","me"] split that stranded subscription invalidations.
export const userKeys = {
  me: () => ["user", "me"] as const,
};

export const subscriptionKeys = {
  all: ["subscription"] as const,  // blanket invalidation prefix
};

export const scanKeys = {
  // Locale is part of the cache identity — the API localizes scan copy.
  detail: (id: string, locale: string) => ["scan", id, locale] as const,
  // Prefix matching every locale variant — use for invalidation, NOT as useQuery key.
  forId:  (id: string)                 => ["scan", id] as const,
};
```

### 3 — `src/lib/api.ts` — wrapper key parts (abridged)

```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiRequest<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const token = await SecureStore.getItemAsync("auth_token");
  const locale = useI18nStore.getState().locale;
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    "X-App-Locale": locale,                 // adapt header name per app
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      body: options.body instanceof FormData ? options.body
          : options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR"); // transport failure — never let a bare TypeError escape
  }

  if (!res.ok) {
    if (res.status === 401 && !isRetry && path !== "/auth/refresh") {
      const outcome = await refreshTokenOnce();
      if (outcome === "refreshed") return apiRequest<T>(path, options, true);
      if (outcome === "unavailable") throw new ApiError(503, "auth_refresh_unavailable");
      // "rejected" → fall through, surface the 401
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (body as { error: string }).error);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
```

### 4 — `refreshTokenOnce()` — single-flight + identity guard

```ts
type RefreshOutcome = "refreshed" | "rejected" | "unavailable";

let refreshInFlight: Promise<RefreshOutcome> | null = null; // module-level: shared by concurrent 401s

async function refreshAuthToken(): Promise<RefreshOutcome> {
  const current = await SecureStore.getItemAsync("auth_token");
  if (!current) return "rejected";

  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${current}`, "X-App-Locale": useI18nStore.getState().locale },
    });
  } catch { return "unavailable"; } // network down — keep token, don't orphan session

  if (res.status === 401) return "rejected"; // definitively dead
  if (!res.ok) return "unavailable";         // 429 / 5xx — transient

  try {
    const data = (await res.json()) as { token: string; user: { id: string } };
    // Identity guard: never let a refresh silently rebind this device to a
    // different userId — that would cross-contaminate health data.
    const prevUserId = useAuthStore.getState().userId;
    if (prevUserId && data.user.id !== prevUserId) return "unavailable";
    await useAuthStore.getState().setAuth(data.token, data.user.id);
    return "refreshed";
  } catch { return "unavailable"; }
}

export function refreshTokenOnce(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = refreshAuthToken().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
```

### 5 — `src/stores/auth-store.ts` — SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`

```ts
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

// Strongest iOS Keychain tier: no iCloud sync, no cross-device restore.
// Required for apps that store health-adjacent credentials.
const SECURE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  userId: null,
  isAuthenticated: false,
  isLoading: true,

  setAuth: async (token, userId) => {
    await SecureStore.setItemAsync("auth_token", token, SECURE_OPTIONS);
    await SecureStore.setItemAsync("user_id",   userId, SECURE_OPTIONS);
    set({ token, userId, isAuthenticated: true, isLoading: false });
  },

  loadAuth: async () => {
    const token  = await SecureStore.getItemAsync("auth_token");
    const userId = await SecureStore.getItemAsync("user_id");
    set({ token, userId, isAuthenticated: !!token, isLoading: false });
  },

  logout: async () => {
    await SecureStore.deleteItemAsync("auth_token");
    await SecureStore.deleteItemAsync("user_id");
    set({ token: null, userId: null, isAuthenticated: false });
  },
}));
```

### 6 — `src/stores/onboarding-store.ts` — Zustand `persist` + SecureStore adapter + `partialize`

```ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";

// Thin Storage-shaped adapter over expo-secure-store.
// WHEN_UNLOCKED_THIS_DEVICE_ONLY prevents iCloud from syncing health-adjacent answers.
const secureStorage = {
  getItem:    (name: string)                => SecureStore.getItemAsync(name),
  setItem:    (name: string, value: string) =>
    SecureStore.setItemAsync(name, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  removeItem: (name: string)                => SecureStore.deleteItemAsync(name),
};

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      ...initial,
      setAnswer: (key, value) => set({ [key]: value } as Partial<OnboardingState>),
      reset: () => set(initial),
    }),
    {
      name: "onboarding-v2",
      storage: createJSONStorage(() => secureStorage),
      // partialize: strip all action functions — persisting them crashes on cold restore.
      partialize: (state) => {
        const { setAnswer: _a, reset: _b, ...rest } = state;
        return rest;
      },
    }
  )
);
```

### 7 — 4-step optimistic update (`useUpdatePreferences`)

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PatchPreferencesInput, UserPreferencesResponse } from "@app/shared";
import { api } from "../../lib/api";

// Exact key — safe here because preferences are NOT locale-keyed (no dynamic suffix).
const PREFERENCES_KEY = ["me", "preferences"] as const;

export function useUpdatePreferences() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (body: PatchPreferencesInput) =>
      api.patch<UserPreferencesResponse>("/me/preferences", body),

    onMutate: async (body) => {           // Step 1: cancel → snapshot → optimistic write
      await qc.cancelQueries({ queryKey: PREFERENCES_KEY });
      const previous = qc.getQueryData<UserPreferencesResponse>(PREFERENCES_KEY);
      qc.setQueryData<UserPreferencesResponse>(PREFERENCES_KEY, (old) =>
        old ? { ...old, ...body } : old
      );
      return { previous };
    },

    onError: (_err, _body, ctx) => {      // Step 2: rollback
      if (ctx?.previous !== undefined) qc.setQueryData(PREFERENCES_KEY, ctx.previous);
    },

    onSettled: () => {                    // Step 3: re-sync (always, even on success)
      void qc.invalidateQueries({ queryKey: PREFERENCES_KEY });
      // Home embeds preference-derived content; it's locale-keyed → use PREFIX.
      void qc.invalidateQueries({ queryKey: ["me", "home"] });
    },
  });
}
```

### 8 — ⭐ Locale-keyed-prefix optimistic mutation (`useDeleteScan`)

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { scanKeys } from "../../lib/query-keys";
import type { HomeData } from "../use-home";

export function useDeleteScan() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string }) => api.delete<{ ok: true }>(`/scan/${id}`),

    onMutate: ({ id }) => {
      void qc.cancelQueries({ queryKey: ["me", "home"] });

      // getQueriesData returns ALL entries whose key starts with ["me","home"] —
      // i.e. every locale variant. Snapshot the whole set for rollback.
      const snapshot = qc.getQueriesData<HomeData>({ queryKey: ["me", "home"] });

      // ⭐ setQueriesData (plural) hits ["me","home","en"], ["me","home","fr"], etc.
      // setQueryData(["me","home"], …) would be an exact no-op — nobody subscribes
      // to that bare key. A production app shipped this bug; deleted items
      // reappeared until the user pulled to refresh.
      qc.setQueriesData<HomeData>({ queryKey: ["me", "home"] }, (prev) =>
        prev ? { ...prev, recentScans: prev.recentScans.filter((s) => s.id !== id) } : prev
      );
      return { snapshot };
    },

    onSuccess: (_res, { id }) => {
      qc.removeQueries({ queryKey: scanKeys.forId(id) });
      void qc.invalidateQueries({ queryKey: ["me", "home"] });
    },

    onError: (err, { id }, ctx) => {
      if (err instanceof ApiError && err.status === 404) {
        // Another device already deleted it — goal achieved, keep optimistic state.
        qc.removeQueries({ queryKey: scanKeys.forId(id) });
        void qc.invalidateQueries({ queryKey: ["me", "home"] });
        return;
      }
      // Restore every snapshotted locale variant.
      if (ctx?.snapshot) {
        for (const [key, data] of ctx.snapshot) qc.setQueryData(key, data);
      }
    },
  });
}
```

## Adapt for your project

- **Auth header** — snippets use `Authorization: Bearer`. Change in both
  `apiRequest` and `refreshAuthToken` if your API uses a different scheme.
- **Locale header** — the example uses `X-App-Locale`. Rename or drop as needed.
- **`staleTime` / `retry`** — 5 min / 2 fits a health app with infrequent
  server writes. Use `staleTime: 0` for real-time feeds; `retry: 0` for auth
  endpoints (avoid hammering the server on bad credentials).
- **`WHEN_UNLOCKED_THIS_DEVICE_ONLY`** — strongest iOS tier; blocks iCloud
  Keychain sync and device-to-device restoration. Required when you store health
  data (Apple rejects apps that let health data reach iCloud). For non-health
  apps, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` survives device restarts and is
  a reasonable default.
- **Refresh endpoint** — assumes `POST /auth/refresh` → `{ token, user: { id } }`.
  Adjust the URL and response shape to match your API.
- **Locale-keyed queries** — if none of your query keys include a locale segment,
  `setQueryData` (exact) is correct everywhere; `setQueriesData` is only needed
  when the same resource is cached once per locale.
