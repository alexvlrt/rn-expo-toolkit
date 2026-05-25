---
name: api-backend-patterns
description: "Use when designing or auditing a backend API that serves a RN+Expo mobile app. Backend-agnostic: each pattern leads with a language-neutral rule, shows a Hono+Drizzle reference implementation as the concrete example, and adds a Laravel note for porting. Patterns: per-resource authorization (the 404-for-missing-OR-not-owned rule + non-owner test), JWT auth with token-versioning revocation, Apple/Google OIDC at remote JWKS, webhook reconciliation (constant-time bearer + KV idempotency + never-trust-the-payload), shared Zod schema package, GDPR account-deletion cascade."
---

> **Complements:** no specific authority skill ties these together; this skill encodes a
> coherent set of rules for backends serving RN+Expo mobile apps with privacy-sensitive data.
> Combine with the `expo-state-data` skill (client-side contract) for end-to-end coverage.

---

## Pattern 1 — Per-resource authz-404

### Rule

Every route that returns or mutates a row identified by `:id` (or any resource-scoped
path parameter) **MUST** filter by `userId` in the same WHERE clause and return **404**
for both "row does not exist" and "row is not owned by this user."

- **Never return 403** for an owned-resource miss — doing so tells an attacker the resource
  exists. A consistent 404 prevents enumeration.
- The ownership check belongs **in the SQL query**, not a subsequent `if (row.userId !==
  userId)` guard. A separate guard is a TOCTOU window if the row is fetched first and
  checked later; collapsing both into the WHERE clause makes the check atomic.
- Write a dedicated **non-owner-returns-404** test for every protected route. Without an
  explicit test, the pattern is invisible to reviewers and silently regresses.

### Hono+Drizzle reference

```ts
// GET /resources/:id — authz-404 ownership pattern
resourceRoutes.get("/:id", async (c) => {
  const userId = c.get("userId"); // set by authMiddleware
  const { id } = c.req.param();
  const db = createDb(c.env);
  const { <items> } = db;

  // Both conditions collapse into one query.
  // Missing row AND foreign row both return an empty array → 404.
  const [row] = await db
    .select()
    .from(<items>)
    .where(and(eq(<items>.id, id), eq(<items>.userId, userId)))
    .limit(1);

  if (!row) return c.json({ error: "Not found" }, 404); // same code for both cases

  return c.json(serializeRow(row));
});

// DELETE /resources/:id — re-assert ownership on the write too
resourceRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.param();
  const db = createDb(c.env);
  const { <items> } = db;

  const [row] = await db
    .select({ id: <items>.id })
    .from(<items>)
    .where(and(eq(<items>.id, id), eq(<items>.userId, userId)))
    .limit(1);

  if (!row) return c.json({ error: "Not found" }, 404);

  await db.delete(<items>).where(and(eq(<items>.id, id), eq(<items>.userId, userId)));
  return c.json({ ok: true });
});
```

### Laravel note

Use an Eloquent Policy (`->authorize('view', $resource)`) combined with a query scope
`whereOwnedBy($userId)`. The same 404-not-403 rule applies: throw `ModelNotFoundException`
(which maps to 404) rather than `AuthorizationException` (which maps to 403). Add a
Feature test asserting that a second authenticated user's token receives `404` on the
first user's resource ID.

---

## Pattern 2 — JWT auth with token-versioning revocation

### Rule

Stateless JWTs can't be revoked before their `exp` unless you anchor them to a mutable
server-side value. The pattern: include a `v` (version) claim in the JWT; on every
authenticated request, look up `users.token_version` and reject the token if the claim
doesn't match. Bumping the column (on sign-out or account recovery) revokes all live
tokens for that user **instantly** without a token blocklist.

Critical guards:
- **Fail-closed on weak secret.** If `JWT_SECRET` is unset or shorter than the minimum
  length, the guard must throw immediately — do not fall back to signing with `undefined`
  (which silently produces valid tokens an attacker can forge by guessing the key is unset).
- **Three token variants:** `sign`, `verify` (strict — enforces `exp`), and
  `verifyAllowingExpiry` (for the `/auth/refresh` route — jose only throws `JWTExpired`
  **after** cryptographic verification, so the payload carried by the error is trustworthy).
- **OIDC identity tokens (Apple/Google)** must be verified against the provider's remote
  JWKS — never trust a client-supplied identity claim. Use `jose.createRemoteJWKSet` with
  the canonical provider URL. Validate `iss` and `aud` explicitly.

### Hono+Drizzle reference

```ts
// lib/jwt.ts
import { SignJWT, jwtVerify, errors, createRemoteJWKSet } from "jose";

const MIN_SECRET_LEN = 32;
function requireSecret(secret: string | undefined): Uint8Array {
  if (!secret || secret.length < MIN_SECRET_LEN)
    throw new Error("JWT_SECRET not configured or too short");
  return new TextEncoder().encode(secret);
}

export async function signUserToken(
  userId: string, version: number, secret: string
): Promise<string> {
  return new SignJWT({ sub: userId, v: version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("<your-app>")
    .setExpirationTime("30d")
    .sign(requireSecret(secret));
}

export async function verifyUserToken(token: string, secret: string) {
  const { payload } = await jwtVerify(token, requireSecret(secret), { issuer: "<your-app>" });
  if (!payload.sub) throw new Error("Token missing subject");
  return { sub: payload.sub, tokenVersion: typeof payload.v === "number" ? payload.v : 0 };
}

// For /auth/refresh — tolerates an expired exp, rejects everything else
export async function verifyUserTokenAllowingExpiry(token: string, secret: string) {
  try {
    return await verifyUserToken(token, secret);
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      if (err.payload.iss !== "<your-app>") throw err;
      const sub = err.payload.sub;
      if (!sub) throw err;
      return { sub, tokenVersion: typeof err.payload.v === "number" ? err.payload.v : 0 };
    }
    throw err;
  }
}

// OIDC: verify Apple/Google identity tokens at remote JWKS — never trust
// client-asserted identity. Cache the JWKS set at module scope (one instance
// per worker process).
const appleJWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
export async function verifyAppleIdToken(idToken: string, audience: string) {
  const { payload } = await jwtVerify(idToken, appleJWKS, {
    issuer: "https://appleid.apple.com",
    audience,
  });
  return { sub: payload.sub as string, email: payload.email as string | undefined };
}
```

```ts
// middleware/auth.ts
export const authMiddleware: MiddlewareHandler<{ ... }> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "Missing token" }, 401);
  let sub: string, tokenVersion: number;
  try {
    ({ sub, tokenVersion } = await verifyUserToken(header.slice(7), c.env.JWT_SECRET));
  } catch { return c.json({ error: "Invalid token" }, 401); }

  // One indexed PK lookup per request — token_version is the revocation primitive.
  const db = createDb(c.env);
  const [user] = await db.select({ tokenVersion: db.users.tokenVersion })
    .from(db.users).where(eq(db.users.id, sub)).limit(1);
  if (!user || user.tokenVersion !== tokenVersion)
    return c.json({ error: "Invalid token" }, 401);

  c.set("userId", sub);
  await next();
};
```

### Laravel note

Add a `token_version` integer column to `users` (default 0). Create a custom
`TokenVersionMiddleware` that reads the JWT claim, looks up `User::find($sub)`, and
rejects the request with 401 if the claim doesn't match `$user->token_version`.
Sanctum or Passport handle signing; the version column check is a one-line addition in
a middleware. Bump the column in the sign-out controller — all outstanding tokens become
invalid immediately.

---

## Pattern 3 — Webhook reconciliation

### Rule

A webhook payload identifies **which** event occurred. It is **not** the source of
truth for the current state. The source of truth is the external provider's REST API.
Always re-read the provider before writing state.

This pattern has four sub-rules:
1. **Constant-time bearer auth.** Compare the shared secret with `timingSafeEqual` to
   prevent timing attacks. Reject the request before touching the DB if comparison fails.
2. **Idempotency dedup on event ID.** Store the event ID in KV (Workers) or Redis (Node)
   with a TTL equal to the provider's retry window. If the ID is already present,
   return 200 immediately — do not re-process.
3. **Re-read the provider's REST API** before writing. The payload may be stale, replayed,
   or spoofed. The provider's current state is authoritative.
4. **Three-state result: `active | inactive | unknown`.** On `unknown` (provider
   unavailable), **never downgrade** the stored state. Return 503 so the provider retries.
   Silently accepting an outage as "inactive" would revoke paying users.

### Hono+Drizzle reference

```ts
// routes/webhooks.ts
webhookRoutes.post("/<provider>", async (c) => {
  // 1. Constant-time auth
  const provided = c.req.header("Authorization") ?? "";
  const expected = `Bearer ${c.env.<PROVIDER>_WEBHOOK_SECRET}`;
  const enc = new TextEncoder();
  const match = provided.length === expected.length &&
    timingSafeEqual(enc.encode(provided), enc.encode(expected));
  if (!match) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const eventId: string = body.event?.id ?? body.id;
  const eventType: string = body.event?.type ?? body.type;
  const userId: string = body.app_user_id ?? body.customer_id;
  if (!eventId || !userId) return c.json({ error: "Malformed payload" }, 400);

  // 2. Idempotency dedup (KV on Workers; swap for Redis on Node)
  const dedupKey = `webhook:<provider>:${eventId}`;
  const seen = await c.env.KV.get(dedupKey);
  if (seen) return c.json({ ok: true, status: "duplicate" }); // already processed
  await c.env.KV.put(dedupKey, "1", { expirationTtl: 60 * 60 * 24 }); // 24h TTL

  // 3. Re-read provider REST API — do not trust the payload
  const db = createDb(c.env);
  const result = await reconcileFromProvider(c.env, db, userId);

  // 4. Three-state result — NEVER downgrade on unknown
  if (result.kind === "unknown") return c.json({ error: "provider_unavailable" }, 503);
  // result.kind === "ok" or "inactive" — DB was updated inside reconcileFromProvider

  return c.json({ ok: true });
});

// services/subscription.ts (or equivalent reconciler)
export async function reconcileFromProvider(
  env: Env, db: ReturnType<typeof createDb>, userId: string
): Promise<{ kind: "ok" | "inactive" | "unknown" }> {
  // Hit the provider's REST API for current entitlement state
  const state = await fetchProviderEntitlementState(env, userId);
  if (state.kind === "unknown") return { kind: "unknown" }; // never downgrade

  const { subscriptions } = db;
  if (state.kind === "inactive") {
    // Lapse the active row
    await db.update(subscriptions)
      .set({ expiresAt: new Date() })
      .where(and(eq(subscriptions.userId, userId), isActiveRow(subscriptions)));
    return { kind: "inactive" };
  }
  // state.kind === "active": fetch plan + dates, upsert the subscription row
  const details = await fetchProviderSubscriptionDetails(env, userId);
  if (details.kind === "unknown") return { kind: "unknown" };
  await upsertSubscriptionRow(db, userId, details);
  return { kind: "ok" };
}
```

### Laravel note

Create a `WebhookController` with a `__invoke` method. Verify the HMAC header using
`hash_equals(hash_hmac('sha256', $request->getContent(), $secret), $provided)`.
Use `Cache::remember("webhook:<provider>:{$eventId}", 86400, fn() => true)` for
idempotency (or a `webhook_events` table if you need durability). Dispatch a queued
`ReconcileSubscriptionJob` that calls the provider's REST API — never act on the
payload directly.

---

## Pattern 4 — Shared Zod schema package

### Rule

Place all request/response validation schemas and their inferred TypeScript types in a
workspace package (e.g. `packages/shared/`) consumed by **both** the mobile client and
the API. This creates a single source of truth for:

- Request body shapes (`PATCH /user` body, scan input, etc.)
- Response shapes (the wire contract that mobile's `useQuery` deserializes)
- Enum values (`"free" | "premium" | "expired"`)
- Predicates that centralize business logic (`isPremium(subscription)`)

When the API changes a response shape, the shared package breaks the mobile build
immediately. Without this layer, the mobile client silently uses stale types and
regressions only surface at runtime.

### Hono+Drizzle reference

```ts
// packages/shared/src/schemas/resource.ts
import { z } from "zod";

// Enum — the only place this list is defined
export const SUBSCRIPTION_STATES = ["free", "premium", "expired"] as const;
export const subscriptionSchema = z.enum(SUBSCRIPTION_STATES);
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

// Predicate — centralized; a stringly-typed === "premium" won't creep back in
export function isPremium(s: SubscriptionState | null | undefined): boolean {
  return s === "premium";
}

// Request body schema — consumed by both the API validator and the mobile mutation
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  ageYears: z.number().int().min(18).max(100).optional(),
  // ... additional optional fields
});

// Response schema — the wire contract. Mobile types are inferred from this.
export const profileResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  ageYears: z.number().int().nullable(),
  subscription: subscriptionSchema,
  createdAt: z.string(),
});

// Inferred types — both API and mobile import these, never write them by hand
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
```

```ts
// API: zValidator enforces the contract at the route boundary
import { updateProfileSchema } from "@<workspace>/shared";
userRoutes.patch("/", zValidator("json", updateProfileSchema), async (c) => {
  const body = c.req.valid("json"); // typed as UpdateProfileInput
  // ...
});

// Mobile: the same type drives the mutation and query cache shape
import { type ProfileResponse, isPremium } from "@<workspace>/shared";
const { data } = useQuery<ProfileResponse>({ queryKey: ["user"], queryFn: fetchUser });
if (isPremium(data?.subscription)) { /* ... */ }
```

### Laravel note

An equivalent is an OpenAPI spec (`openapi.yaml`) with generated PHP DTOs and a
generated TypeScript client, or a hand-maintained `packages/types/` package published as
a private npm package. The goal is identical: one change to the contract breaks both
sides of the compile step, not just one. If using hand-maintained types, co-locate
validation (Laravel Form Requests) with the TS shape so they stay synchronized.

---

## Pattern 5 — GDPR account-deletion cascade

### Rule

`DELETE /user` is a legal obligation (GDPR Art. 17, CCPA, Washington My Health My Data
Act for health-adjacent data). The deletion must cascade to **every store that holds
user-identifiable data:**

1. **DB rows** — the primary cascade. Delete the `users` row (which foreign-key cascades
   to owned tables) inside the handler. This is the legally significant action.
2. **Object storage** (R2, S3, filesystem) — delete all objects under the user's prefix.
   List pages if the provider returns paginated results (avoid truncating at 1000 objects).
3. **Analytics providers** (PostHog person delete, Sentry user-feedback delete, etc.) —
   best-effort. Log failures; never throw. Provider APIs can be unavailable; the DB wipe
   is already legally sufficient.

Run storage and analytics cleanup **after** returning the response, via `waitUntil`
(Workers) or a queued job (Node/Laravel). This keeps the request latency short while
ensuring cleanup completes even if the connection closes.

Scope object deletion defensively: only delete keys that start with the user's prefix
(`<bucket>/<userId>/`). A row that somehow points to a foreign key would otherwise wipe
another user's data.

### Hono+Drizzle reference

```ts
// routes/user.ts — DELETE /user
userRoutes.delete("/", async (c) => {
  const userId = c.get("userId");
  const db = createDb(c.env);
  const { users, <items> } = db;

  // Collect storage keys BEFORE the DB delete drops the rows
  const logged = await db.select({ key: <items>.imageKey })
    .from(<items>).where(eq(<items>.userId, userId));

  // Also enumerate any orphan objects under the per-user prefix
  const orphanKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.<BUCKET>.list({ prefix: `<prefix>/${userId}/`, cursor });
    for (const o of page.objects) orphanKeys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Only delete keys scoped to this user — defense-in-depth
  const allKeys = new Set([...logged.map(r => r.key), ...orphanKeys]
    .filter(k => k.startsWith(`<prefix>/${userId}/`)));

  // 1. DB cascade — legally significant action
  await db.delete(users).where(eq(users.id, userId));

  // 2. Storage — best-effort, log failures, never throw
  const r2Results = await Promise.allSettled(
    Array.from(allKeys).map(key => c.env.<BUCKET>.delete(key))
  );
  const failures = r2Results.filter(r => r.status === "rejected").length;
  if (failures > 0) console.error("[user:delete] storage delete failures", { userId, failures });

  // 3. Analytics providers — non-blocking via waitUntil
  c.executionCtx.waitUntil(
    cascadeDeleteAnalytics(c.env, userId)
      .then(result => console.log("[user:delete] analytics cascade", { userId, ...result }))
  );

  return c.body(null, 204);
});

// services/analytics-deletion.ts
export async function cascadeDeleteAnalytics(env: Env, userId: string) {
  const [provider1, provider2] = await Promise.all([
    deleteFromAnalyticsProvider1(env, userId),
    deleteFromAnalyticsProvider2(env, userId),
  ]);
  return { provider1, provider2 }; // "ok" | "skipped" | "failed" per provider
}

async function deleteFromAnalyticsProvider1(
  env: Env, userId: string
): Promise<"ok" | "skipped" | "failed"> {
  if (!env.<PROVIDER_API_KEY>) return "skipped";
  try {
    const res = await fetch(`https://<provider>/api/persons/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.<PROVIDER_API_KEY>}` },
      signal: AbortSignal.timeout(5000),
    });
    return (res.ok || res.status === 404) ? "ok" : "failed";
  } catch { return "failed"; }
}
```

### Laravel note

Listen to the `User::deleting` Eloquent event (or a `SoftDeletes`-aware observer) and
dispatch one queued job per external provider. Wrap the in-database cascade in a
transaction so all owned tables are wiped atomically or not at all. The queued jobs run
after the transaction commits — they are best-effort by nature (the queue worker can
retry on failure, but DB+storage is already gone, satisfying the legal obligation).

---

## Pattern 6 — Background tasks

### Rule

Operations that are not required for the response should be moved off the request
critical path. Common candidates: locale sync writes, analytics events, storage
operations, cascade calls. Keeping them in the critical path adds latency for every
request and means a slow external API holds the connection open.

**Choose the mechanism that matches your runtime:**

| Runtime | Mechanism | Notes |
|---|---|---|
| Cloudflare Workers | `c.executionCtx.waitUntil(promise)` | Keeps the Worker alive after `Response` is returned |
| Node / Bun | BullMQ + Redis, or simple in-memory queue | Use durable queue for important work; in-memory for fire-and-forget |
| Laravel | `dispatch(new SomeJob(...))` | Queued jobs survive process restarts |

**Critical rule for Workers:** a `.then()` / `.catch()` chain attached to a fire-and-
forget promise is **not** guaranteed to run to completion after the response returns.
Always register non-critical work with `waitUntil`; otherwise the workerd runtime may
cancel the promise mid-execution.

### Hono+Drizzle reference

```ts
// Workers — locale sync and daily-summary recompute after a mutation
resourceRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  // ... primary mutation ...

  // Non-critical: recompute derived aggregate off the critical path
  c.executionCtx.waitUntil(
    recomputeDailySummary(db, userId, today)
      .catch(err => console.error("[resource:create] recompute failed", err))
  );

  // Non-critical: locale cross-device sync
  // Conditional update: only write if the stored locale differs (avoids write amplification)
  const localeWrite = db.update(db.users)
    .set({ locale })
    .where(and(eq(db.users.id, userId), ne(db.users.locale, locale)))
    .catch(() => undefined);
  c.executionCtx.waitUntil(localeWrite);

  return c.json({ ok: true }, 201);
});

// Node / Bun with BullMQ
import { Queue } from "bullmq";
const recomputeQueue = new Queue("recompute", { connection: redisConnection });
// Inside the route handler:
await recomputeQueue.add("daily-summary", { userId, date: today });

// Laravel
dispatch(new RecomputeDailySummaryJob($userId, $today));
```

### Laravel note

Use `dispatch()` for work that must survive restarts (anything touching external APIs or
storage). Use `dispatch()->afterResponse()` (Laravel 10+) for lightweight work that can
run inline after the HTTP response is sent, without a queue worker. Avoid `defer()` for
database writes in high-traffic scenarios — it runs synchronously on the same PHP-FPM
worker after the response, blocking the next request.

---

## Adapt for your project

- **Auth scheme** — the examples use `Authorization: Bearer <token>`. Cookie-based auth
  (e.g. Sanctum session tokens on a web frontend) uses the same token-versioning pattern;
  swap the header extraction for cookie parsing. Basic auth (internal service-to-service)
  requires different token handling entirely.
- **Token-versioning column name** — the examples use `token_version`. Rename to match
  your schema; the Drizzle column is `users.tokenVersion` (camelCase Drizzle → snake_case
  DB). If you use a separate `sessions` table instead of a column on `users`, the check
  becomes a session-row lookup instead of a column comparison.
- **Shared-types package layout** — the examples assume a pnpm workspace with
  `packages/shared/`. If your monorepo uses a different tool (Nx, Turborepo, Yarn
  workspaces), the package name changes but the pattern is identical. In a non-monorepo
  setup, publish the shared package to a private registry.
- **Storage backend** — the deletion cascade example uses Cloudflare R2 (S3-compatible).
  Swap `c.env.<BUCKET>.list(...)` / `.delete(...)` for the AWS S3 SDK, or filesystem
  `unlink`/`readdir` for local storage. The pagination loop and the per-user-prefix scope
  guard are the same regardless of backend.
- **Runtime** — the webhook idempotency example uses Workers KV. On Node/Bun, replace
  `c.env.KV.get/put` with `redis.get/setex`. On Laravel, use `Cache::get/put` backed by
  Redis. The idempotency semantics (check before processing, store with TTL) are identical.
- **Provider names** — replace `<PROVIDER>` with the actual billing/analytics provider.
  The three-state `active | inactive | unknown` result type and the "never downgrade on
  unknown" rule apply to any external provider, not just a specific one.
