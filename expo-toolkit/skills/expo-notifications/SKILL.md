---
name: expo-notifications
description: "Use when adding local notifications to a RN+Expo app — daily reminders, time-based scheduling, permission requests, or reconciling against an OS-level revoke. Enforces: a single setNotificationHandler at module load, identifier prefixing to avoid collisions, i18n-aware notification copy keyed by time-of-day, a permission flow with graceful denial fallback (Alert -> Settings deeplink), and a useFocusEffect-driven reconciliation that auto-disables the in-app toggle when the user revokes permissions outside the app."
---

> **Complements:** no specific authority skill covers this combination; the
> `expo-notifications` SDK docs cover the raw API surface but not the
> OS-revocation reconciliation pattern, the identifier-prefix discipline, or
> the cancel-then-schedule idempotency ordering captured here.

---

## Conventions

1. **`setNotificationHandler` once at module load** — top of
   `src/lib/notifications.ts`, never inside a component or hook. Set
   `shouldShowAlert: true`; choose `shouldPlaySound` / `shouldSetBadge` /
   `shouldShowBanner` explicitly per feature (no implicit defaults).

2. **Identifier prefix per feature** — prefix every identifier with a short
   stable string (e.g. `"reminder-"`, `"habit-"`). `cancelDailyReminders`
   filters on that prefix so it never touches another feature's notifications.
   Never rename a shipped prefix: old notifications become un-cancellable.

3. **`messageForHour(hour, t)`** — derive the notification title from the
   scheduled hour via i18n. Slots: morning / noon / evening / generic.
   All copy must go through `t()`; never hardcode strings. Keep the body
   absent or generic — see rule 9.

4. **Permission flow — check before asking** — `getPermissionsAsync()` first
   (cheap). If not granted and `canAskAgain`, call `requestPermissionsAsync()`.
   If `status === 'denied' && !canAskAgain`, show an `Alert` offering
   `Linking.openSettings()`. Never call `requestPermissionsAsync()` after
   a permanent denial (iOS silent no-op; Android may crash).

5. **OS-revocation reconciliation via `useFocusEffect`** — on the settings
   screen, re-run `getPermissionsAsync()` on every focus. If revoked while
   the in-app toggle is `enabled`: auto-disable, cancel scheduled
   notifications, fire an analytics event (`source: "os_revoked"`), and
   persist the disabled state to the server.

6. **Local-only** — server push (APNs / FCM) is out of scope; those require
   `getExpoPushTokenAsync` + a relay server + a native rebuild for the
   notification entitlement.

7. **Schedule with repeating daily trigger** — use
   `SchedulableTriggerInputTypes.DAILY` with `{ hour, minute }`. Cancel by
   the exact identifier string used at schedule time.

8. **Mutation order: cancel → schedule → sync** — cancel the old set first so
   stale notifications never linger. Persist to the server after the local
   update. Idempotent: running it twice leaves OS state correct.

9. **Lock-screen content — no sensitive copy** — notification bodies are
   visible on the lock screen. Generic copy ("Time for a daily check-in") is
   fine. Personally-derived or health-diagnostic copy must never appear in
   a notification payload.

---

## Inline snippets

### 1 — `src/lib/notifications.ts` — handler + schedule/cancel + `messageForHour`

```ts
import * as Notifications from "expo-notifications";
import i18n from "../i18n";

// Rule 1: configure once at module load, before any component mounts.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Rule 2: stable per-feature prefix.
const PREFIX = "<feature-prefix>-"; // e.g. "reminder-"

export interface Reminder {
  id: string;
  time: string; // "HH:mm"
}
export interface ReminderPrefs {
  enabled: boolean;
  reminders: Reminder[];
}

// Rule 3: i18n-aware title derived from the scheduled hour.
function messageForHour(h: number): string {
  if (h >= 5 && h < 11) return i18n.t("notifications.<feature>.morning");
  if (h >= 11 && h < 15) return i18n.t("notifications.<feature>.noon");
  if (h >= 15 && h < 21) return i18n.t("notifications.<feature>.evening");
  return i18n.t("notifications.<feature>.generic");
}

// Rule 8: cancel first, then schedule, then the caller syncs to server.
export async function scheduleDailyReminders(prefs: ReminderPrefs) {
  await cancelDailyReminders(); // always cancel old set first
  if (!prefs.enabled) return;
  for (const r of prefs.reminders) {
    const [h, m] = r.time.split(":").map((x) => parseInt(x, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}${r.id}`,
      content: {
        title: messageForHour(h),
        // Rule 9: keep body absent or generic — visible on lock screen.
        data: { deeplink: "/<your-target-route>" },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: h,
        minute: m,
      },
    });
  }
}

// Rule 2: filter on prefix so only this feature's notifications are cancelled.
export async function cancelDailyReminders() {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    all
      .filter((n) => n.identifier?.startsWith(PREFIX))
      .map((n) =>
        Notifications.cancelScheduledNotificationAsync(n.identifier)
      )
  );
}

export async function hasNotificationPermission(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted";
}
```

---

### 2 — Permission request flow with Alert → Settings fallback

```ts
// Rule 4: full permission-request flow.
// Call this before enabling the toggle; if it returns false, revert the UI.
async function requestPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();

  // Already granted — fast path.
  if (current.status === "granted") return true;

  // Can still ask: show the native prompt.
  if (current.canAskAgain) {
    const { status } = await Notifications.requestPermissionsAsync();
    return status === "granted";
  }

  // Permanently denied: offer to open system Settings.
  return new Promise((resolve) => {
    Alert.alert(
      t("notifications.permission_denied_title"),
      t("notifications.permission_denied_body"),
      [
        {
          text: t("common.cancel"),
          style: "cancel",
          onPress: () => resolve(false),
        },
        {
          text: t("notifications.open_settings"),
          onPress: async () => {
            await Linking.openSettings();
            // The user may grant the permission in Settings and return,
            // but we resolve false here; the useFocusEffect reconciliation
            // (rule 5) will detect the grant on next focus.
            resolve(false);
          },
        },
      ]
    );
  });
}
```

---

### 3 — `useFocusEffect` OS-revocation reconciliation

```ts
// Rule 5: re-check OS permission each time the screen gains focus.
// Place this inside the settings component that owns the notifications toggle.
const reconciledRef = useRef(false);

useFocusEffect(
  useCallback(() => {
    (async () => {
      const { status } = await Notifications.getPermissionsAsync();

      if (status !== "granted" && enabled) {
        // OS revoked: auto-disable before the user notices the mismatch.
        setEnabled(false);

        // Analytics — distinguish OS revoke from a manual toggle.
        trackEvent("notifications_toggled", {
          enabled: false,
          source: "os_revoked",
        });

        // Clear local OS state and persist disabled pref to server.
        await cancelDailyReminders();
        mutation.mutate({ enabled: false, reminders });
      }

      // Mark reconciled so derived state can safely render.
      reconciledRef.current = true;
    })();
  }, [enabled, reminders]) // re-run if either changes between focuses
);
```

---

## Adapt for your project

- **Feature prefix** — replace `<feature-prefix>-` with a short stable string
  (e.g. `"habit-"`, `"study-"`, `"checkin-"`). Never rename a shipped prefix.
- **Time slots and i18n keys** — adjust hour boundaries and key names to match
  your domain; add keys to every locale file your app supports.
- **Default reminder times** — seed `DEFAULT_REMINDERS` with times appropriate
  for your use case.
- **Settings deeplink** — `Linking.openSettings()` lands on the app's system
  Settings page; on iOS 16+ that is the notifications toggle, on older Android
  the app-info screen. Don't assume a specific path in the alert copy.
- **Server-side reset on revoke** — the reconciliation snippet persists
  `enabled: false` to the server. Omit `mutation.mutate` if your server pref
  is informational only and you prefer letting the user explicitly re-enable.
- **Push entitlement** — adding remote push later requires a native rebuild;
  OTA cannot add entitlements.
