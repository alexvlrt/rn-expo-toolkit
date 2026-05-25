---
name: expo-offline-queue
description: "Use when an app must keep working offline — queueing user actions locally, applying them optimistically, and replaying them to the server on reconnect. Covers: a persisted Zustand mutation queue (idempotency keys, enqueue + optimistic apply + revert-on-fail), batch replay via a /sync-offline-style endpoint, per-op conflict policy, dead-letter handling for poison ops, and the NetInfo reconnect-flush wiring in the root layout. Complements native-data-fetching (offline guidance) and extends this toolkit's expo-state-data (online-only)."
---

> **Complements:** `native-data-fetching` (offline section — read caching, `networkMode`);
> extends this toolkit's `expo-state-data` (online-only Zustand + TanStack Query patterns).
> Use those skills first; this one adds the bespoke **mutation queue** you need when actions
> must survive an app kill while the device is offline.

---

## When to use this pattern vs. TanStack Query offline

| Scenario | Recommended approach |
|---|---|
| Offline **reads** — show stale data, refetch on reconnect | `persistQueryClient` + `networkMode: "offlineFirst"` (TanStack Query built-in) |
| Offline **mutations** that can be lost if the app is killed | *(good enough)* TanStack Query `networkMode: "offlineFirst"` — queued in memory only |
| Offline **mutations** that must survive an app kill / restart | **This pattern** — persisted Zustand queue + reconnect flush |

Roll your own queue only for mutations. For read caching, always reach for the TanStack Query persistence layer first.

---

## Conventions / checklist

1. **Reachability hook** — use `@react-native-community/netinfo`. Wrap it in a
   small `useReachability()` hook so components never import NetInfo directly.
   `isConnected` is a tri-state (`true / false / null`); treat `null` as offline.

2. **Persisted offline-mutation queue** — one Zustand store per domain that needs
   offline support, using `persist` + an AsyncStorage or SecureStore adapter.
   Each queued op carries:
   - `idempotencyKey` — a UUID generated at enqueue time. The server uses this to
     deduplicate replays. See snippet 1.
   - `type` — string discriminant (e.g. `"record_action"`, `"update_profile"`).
   - `payload` — serialisable record, no class instances.
   - `enqueuedAt` — `Date.now()` timestamp for ordering and TTL pruning.
   - `retryCount` — starts at `0`; incremented on each failed replay attempt.

3. **Optimistic local apply immediately** — when the user triggers an action,
   update the local store/TanStack Query cache at once so the UI reflects the
   change without waiting for the network. Keep a snapshot of the previous state
   to revert if the server later rejects the op.

4. **Batch replay on reconnect** — when `NetInfo.addEventListener` fires an event
   with `isConnected === true`, flush the queue by POSTing all pending ops in a
   single request to a `/sync-offline`-style endpoint. Idempotency keys make it
   safe to replay the same batch more than once.

5. **Per-op outcome policy** — the sync endpoint returns an array of per-op
   results. Handle each result independently:
   - `"applied"` — server accepted it; remove from queue.
   - `"duplicate"` — server already processed this idempotency key; remove from queue.
   - `"conflict"` — server state wins; revert the local optimistic value, remove from queue, optionally surface a toast to the user.
   - `"retry"` — transient error (5xx, timeout); increment `retryCount`, keep in queue.
   - `"drop"` — permanent error (400, 422, business-logic rejection); log it, remove from queue, notify user if consequential.

6. **Dead-letter / poison-op protection** — ops that exceed `MAX_RETRY` (default: 5)
   are moved to a dead-letter list (a separate persisted array). The dead-letter
   list is surfaced to the user ("some actions could not be synced") and cleared
   on explicit dismissal. This prevents one bad op from blocking the whole queue
   forever.

7. **Enqueue order must be preserved** — replay ops in `enqueuedAt` ascending order.
   Dependent ops (e.g. create-then-update the same record) rely on this. Never
   sort or parallelize ops for the same resource.

8. **Never block the UI** — `flushOfflineQueue` runs in the background. Errors
   during flush are caught and logged to Sentry; they must not propagate to the UI
   as unhandled rejections.

9. **Storage backend choice**:
   - `AsyncStorage` — fine for non-sensitive mutation payloads.
   - SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) — use when the payloads
     contain health, financial, or personal data. Note: SecureStore is
     synchronous-by-key and limited to ~2 KB per entry on iOS; store the queue as
     a single JSON blob under one key, not one key per op.

---

## Inline snippets

### 1 — Idempotency-key generation

```ts
import * as Crypto from "expo-crypto";

/**
 * Generate a stable idempotency key for an offline op.
 * Use at enqueue time only — never regenerate on retry.
 */
export async function generateIdempotencyKey(): Promise<string> {
  return Crypto.randomUUID(); // crypto-quality UUID, available in Expo SDK 44+
}
```

---

### 2 — `useReachability()` — thin NetInfo hook

```ts
import NetInfo from "@react-native-community/netinfo";
import { useEffect, useState } from "react";

/**
 * Returns whether the device currently has network access.
 * `null` = unknown (treat as offline until resolved).
 */
export function useReachability(): boolean | null {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  useEffect(() => {
    // Fetch current state immediately — addEventListener fires lazily
    NetInfo.fetch().then((s) => setIsConnected(s.isConnected));

    const unsubscribe = NetInfo.addEventListener((s) => {
      setIsConnected(s.isConnected);
    });
    return unsubscribe;
  }, []);

  return isConnected;
}
```

---

### 3 — Persisted queue store (enqueue + optimistic apply + revert-on-fail)

Replace `<resource>`, `<action>`, `<ResourceState>`, and `<ActionPayload>` with
your domain types. The pattern is the same regardless of resource.

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { generateIdempotencyKey } from "./idempotency";

const MAX_RETRY = 5;

export interface OfflineOp {
  idempotencyKey: string;
  type: string;             // discriminant — e.g. "record_action"
  payload: Record<string, unknown>;
  enqueuedAt: number;       // Date.now() at enqueue
  retryCount: number;
}

interface <ResourceState> {
  // Your domain state fields here, e.g.:
  value: number;

  // Queue fields — always include these:
  offlineQueue: OfflineOp[];
  deadLetter: OfflineOp[];

  // Actions
  performAction: (payload: <ActionPayload>) => Promise<void>;
  flushOfflineQueue: () => Promise<void>;
  dismissDeadLetter: () => void;
}

type <ActionPayload> = { /* your payload shape */ id: string; amount: number };

export const use<Resource>Store = create<<ResourceState>>()(
  persist(
    (set, get) => ({
      value: 0,
      offlineQueue: [],
      deadLetter: [],

      performAction: async (payload) => {
        // 1. Snapshot current state for revert-on-failure
        const snapshot = { value: get().value };

        // 2. Build the queued op before touching state
        const op: OfflineOp = {
          idempotencyKey: await generateIdempotencyKey(),
          type: "record_action",
          payload: payload as unknown as Record<string, unknown>,
          enqueuedAt: Date.now(),
          retryCount: 0,
        };

        // 3. Optimistic local apply + enqueue atomically
        set((s) => ({
          value: s.value + payload.amount,          // ← your optimistic delta
          offlineQueue: [...s.offlineQueue, op],
        }));

        // 4. Try online path; on success dequeue + reconcile with server state
        try {
          const result = await api.post<{ value: number }>(
            "/<YOUR_API_ENDPOINT>",
            { idempotency_key: op.idempotencyKey, ...payload }
          );
          set((s) => ({
            value: result.value,                    // server wins after success
            offlineQueue: s.offlineQueue.filter((o) => o !== op),
          }));
        } catch {
          // Network down or 5xx: keep optimistic value, leave op in queue.
          // flushOfflineQueue will reconcile on reconnect.
        }
      },

      flushOfflineQueue: async () => {
        const { offlineQueue } = get();
        if (offlineQueue.length === 0) return;

        // Sort ascending by enqueue time to preserve causal ordering
        const ordered = [...offlineQueue].sort((a, b) => a.enqueuedAt - b.enqueuedAt);

        let result: { value: number; outcomes: Array<{ idempotencyKey: string; status: string }> };
        try {
          result = await api.post("/<YOUR_SYNC_OFFLINE_ENDPOINT>", { ops: ordered });
        } catch {
          // Network still down — retry next time NetInfo fires
          return;
        }

        // Reconcile per-op outcomes
        const outcomeMap = new Map(result.outcomes.map((o) => [o.idempotencyKey, o.status]));

        set((s) => {
          const remaining: OfflineOp[] = [];
          const dead: OfflineOp[] = [...s.deadLetter];

          for (const op of s.offlineQueue) {
            const status = outcomeMap.get(op.idempotencyKey) ?? "retry";
            if (status === "applied" || status === "duplicate") {
              // Accepted — drop from queue (server state reconciled below)
            } else if (status === "drop" || status === "conflict") {
              // Permanent rejection — move to dead-letter if consequential
              dead.push(op);
            } else {
              // "retry" or unknown — increment counter; dead-letter if exhausted
              const updated = { ...op, retryCount: op.retryCount + 1 };
              if (updated.retryCount >= MAX_RETRY) {
                dead.push(updated);
              } else {
                remaining.push(updated);
              }
            }
          }

          return {
            offlineQueue: remaining,
            deadLetter: dead,
            value: result.value, // reconcile with authoritative server state
          };
        });
      },

      dismissDeadLetter: () => set({ deadLetter: [] }),
    }),
    {
      name: "<your-resource>-store-v1",
      storage: createJSONStorage(() => AsyncStorage),
      // partialize: persist data + queue; never persist action functions
      partialize: (s) => ({
        value: s.value,
        offlineQueue: s.offlineQueue,
        deadLetter: s.deadLetter,
      }),
    }
  )
);
```

---

### 4 — Reconnect-flush wiring in root layout

Wire the flush inside your root layout component so it fires every time the
device regains connectivity — including cold restarts with a pending queue.

```ts
import NetInfo from "@react-native-community/netinfo";
import { useEffect } from "react";
import { use<Resource>Store } from "../stores/<resource>-store";

function RootLayout() {
  const flushOfflineQueue = use<Resource>Store((s) => s.flushOfflineQueue);
  const fetchServerState  = use<Resource>Store((s) => s.fetchServerState);

  // Flush queued mutations whenever connectivity is restored.
  // flushOfflineQueue is fire-and-forget; errors are caught internally.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((netState) => {
      if (netState.isConnected) {
        flushOfflineQueue()
          .then(() => fetchServerState())  // re-sync authoritative state after flush
          .catch(() => {});                // guard: never let this propagate
      }
    });
    return () => unsubscribe();
  }, [flushOfflineQueue, fetchServerState]);

  // ... rest of layout
}
```

**Why fetch server state after flush?** The flush reconciles the authoritative
server value back into the store for each op that was applied. The follow-up
`fetchServerState()` ensures the full resource object (not just the field
touched by the queue) is fresh — important when other devices may have mutated
the same resource while this device was offline.

---

## Server-side: `/sync-offline` endpoint contract

The batch endpoint should accept an array of ops and return a per-op outcome array:

```ts
// Request body
interface SyncOfflineRequest {
  ops: Array<{
    idempotency_key: string;
    type: string;
    payload: Record<string, unknown>;
    enqueued_at: string; // ISO-8601
  }>;
}

// Response body
interface SyncOfflineResponse {
  // Authoritative state after all applied ops (shape depends on your resource)
  value: number; // example field — replace with your server's resource shape
  outcomes: Array<{
    idempotency_key: string;
    status: "applied" | "duplicate" | "conflict" | "retry" | "drop";
    reason?: string; // optional human-readable detail for logging
  }>;
}
```

The server processes ops **in the order received** (which matches `enqueuedAt`
ascending — the client sorts before sending). It must be idempotent per
`idempotency_key`: a key seen before returns `"duplicate"`, never re-applies.

---

## Adapt for your project

- **`<YOUR_API_ENDPOINT>`** — the online path for a single immediate mutation.
- **`<YOUR_SYNC_OFFLINE_ENDPOINT>`** — the batch replay endpoint (e.g. `/resource/sync-offline`).
- **Batch size** — if the queue can grow large, split into chunks of 50 ops per request.
- **Storage backend** — swap `AsyncStorage` for a SecureStore adapter (see `expo-state-data` snippet 6) when payloads contain sensitive data. Keep the entire queue under one SecureStore key to avoid per-key size limits.
- **Eligible mutations** — not every mutation needs to be offline-eligible. Prefer queueing idempotent, low-frequency writes (e.g. recording an action, saving a profile field). Avoid queueing operations that depend on real-time server state (e.g. payments, rate-limited actions, or anything where stale ordering causes data corruption).
- **TTL pruning** — add a startup effect that evicts ops with `enqueuedAt` older than N days (e.g. 7) to prevent the queue from growing unbounded across long offline periods.
- **Conflict policy** — `"conflict"` means the server state has diverged beyond a simple merge. Decide per action type: silently discard, overwrite server with local, or surface a "your changes could not be saved" notice. Never silently overwrite server state without telling the user.
- **Dead-letter UX** — consider showing a non-blocking banner ("Some actions couldn't sync — tap to dismiss") rather than a modal. The user was likely offline for an extended period; a modal is jarring.
- **Multiple stores** — if several feature stores have their own offline queues, extract a shared `flushAll()` in the reconnect effect that awaits each store's flush sequentially, then refreshes server state.
