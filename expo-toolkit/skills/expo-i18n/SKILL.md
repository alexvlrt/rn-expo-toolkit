---
name: expo-i18n
description: "Use when adding i18n to a RN+Expo app, persisting the user's locale choice, syncing locale cross-device from a server payload, or adding a new locale file. Enforces: i18next + react-i18next + Zustand store with SecureStore-or-AsyncStorage persistence, a one-shot server-locale latch so a manual user choice is never overridden by a stale payload, missing-key dev warnings, EN as the source of truth, and a strict resolution hierarchy stored -> device -> fallback."
---

> **Complements:** No single authority skill covers i18next + Zustand together.
> `expo-app-bootstrap` describes where `i18nStore.hydrate()` is called and where
> the `ready` render gate lives. This skill encodes the full wiring: i18next
> init, Zustand store, resolution hierarchy, and the server-locale latch.

---

## Authority-preferred default

**i18next + react-i18next** — dominant RN i18n stack. Alternatives (FormatJS /
Lingui) require different wiring not covered here.

---

## Conventions / checklist

- **EN is the source of truth.** Every key MUST exist in `en.json`. Other
  locales fall back to EN via `fallbackLng`. Never add a key to a non-EN file
  first.

- **Resolution order on first launch:** stored (SecureStore / AsyncStorage)
  → device (`expo-localization` `getLocales()`) → fallback (`'en'`).

- **One-shot server-locale latch.** `applyServerLocale(locale)` MUST guard with
  `serverApplied: boolean`. Once applied (or once `setLocale` is called) no
  server payload may override the locale for the rest of the session. Without
  this a stale `/user.locale` response silently reverts a fresh manual switch.

- **`i18nStore.ready` render gate.** `_layout.tsx`: `if (!ready) return null`
  until `hydrate()` resolves. Rendering before hydration exposes raw keys.

- **Dev-only missing-key handler.** `saveMissing: __DEV__` + `console.warn`;
  both `false`/`undefined` in production. Never POST missing keys anywhere.

- **Bundled JSON only (Phase 1).** Static imports keep init synchronous — the
  `ready` gate depends on this. No remote downloads until Phase 2.

- **Plural rules polyfill.** `import "intl-pluralrules"` before i18next init.
  Hermes plural rules are incomplete on older Android runtimes.

---

## Inline snippets

### 1 — `i18n/index.ts`

```ts
import "intl-pluralrules"; // must precede i18next init

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
import it from "./locales/it.json";
import de from "./locales/de.json";

const resources = {
  en: { translation: en },
  fr: { translation: fr },
  es: { translation: es },
  it: { translation: it },
  de: { translation: de },
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: "en",            // immediately overridden by i18nStore.hydrate()
    fallbackLng: "en",
    supportedLngs: ["en", "fr", "es", "it", "de"],
    interpolation: { escapeValue: false }, // React handles XSS
    returnEmptyString: false,
    saveMissing: __DEV__,
    missingKeyHandler: __DEV__
      ? (lng, _ns, key) => console.warn(`[i18n] missing key '${key}' for locale '${lng}'`)
      : undefined,
  })
  .catch((err) => console.error("[i18n] init failed", err));

export default i18n;
```

---

### 2 — `i18n/i18n-store.ts` (Zustand + server-locale latch)

```ts
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage"; // swap for SecureStore if needed
import i18n from "i18next";
import { resolveDeviceLocale } from "./resolve-locale";

type AppLocale = "en" | "fr" | "es" | "it" | "de";
const SUPPORTED: AppLocale[] = ["en", "fr", "es", "it", "de"];
const DEFAULT: AppLocale = "en";
const KEY = "@i18n_locale";

const isSupported = (v: unknown): v is AppLocale =>
  typeof v === "string" && SUPPORTED.includes(v as AppLocale);

interface I18nState {
  locale: AppLocale;
  ready: boolean;
  serverApplied: boolean; // one-shot latch — see applyServerLocale
  hydrate: () => Promise<void>;
  setLocale: (next: AppLocale) => Promise<void>;
  applyServerLocale: (server: AppLocale | null | undefined) => Promise<void>;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  locale: DEFAULT,
  ready: false,
  serverApplied: false,

  hydrate: async () => {
    const stored = await AsyncStorage.getItem(KEY);
    const resolved = isSupported(stored) ? stored : resolveDeviceLocale();
    await i18n.changeLanguage(resolved);
    set({ locale: resolved, ready: true });
  },

  setLocale: async (next) => {
    if (next === get().locale) {
      if (!get().serverApplied) set({ serverApplied: true });
      return;
    }
    await AsyncStorage.setItem(KEY, next);
    await i18n.changeLanguage(next);
    set({ locale: next, serverApplied: true });
  },

  applyServerLocale: async (server) => {
    if (!isSupported(server)) return;
    if (get().serverApplied) return;
    // ⭐ Latch BEFORE the first await — prevents a second concurrent refetch
    // from slipping through while this one is mid-await on storage / i18next.
    set({ serverApplied: true });
    if (server === get().locale) return;
    await AsyncStorage.setItem(KEY, server);
    await i18n.changeLanguage(server);
    set({ locale: server });
  },
}));
```

> **Why the latch is set before any `await`:** Zustand updates are synchronous.
> Setting it after an `await` lets two concurrent `applyServerLocale` calls both
> pass the guard, race on AsyncStorage + i18next, and land on the wrong locale.

---

### 3 — `i18n/resolve-locale.ts`

```ts
import * as Localization from "expo-localization";
type AppLocale = "en" | "fr" | "es" | "it" | "de";
const SUPPORTED: AppLocale[] = ["en", "fr", "es", "it", "de"];
// First supported device locale → fallback 'en'. Called only when no stored value exists.
export function resolveDeviceLocale(): AppLocale {
  for (const loc of Localization.getLocales()) {
    const code = loc.languageCode?.toLowerCase();
    if (code && SUPPORTED.includes(code as AppLocale)) return code as AppLocale;
  }
  return "en";
}
```

---

### 4 — `i18n/format.ts` (Intl formatters)

```ts
type AppLocale = "en" | "fr" | "es" | "it" | "de";
export const formatNumber = (v: number, locale: AppLocale, opts?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat(locale, opts).format(v);
// Pass raw fraction (0.85), not integer percent (85).
export const formatPercent = (fraction: number, locale: AppLocale, digits = 0) =>
  new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(fraction);
// 5.2 in EN → "5.2", in FR → "5,2"
export const formatDecimal = (v: number, locale: AppLocale, digits = 1) =>
  formatNumber(v, locale, { minimumFractionDigits: 0, maximumFractionDigits: digits });
```

---

### 5 — Locale JSON skeleton (`locales/en.json`)

```json
{
  "common": {
    "continue": "Continue",
    "cancel": "Cancel",
    "done": "Done",
    "try_again": "Please try again."
  },
  "onboarding": {
    "welcome": {
      "title": "Welcome",
      "subtitle": "Track what matters",
      "cta": "Get started"
    },
    "quiz": {
      "gender": {
        "question": "Choose your gender",
        "options": { "male": "Male", "female": "Female", "other": "Other" }
      }
    }
  },
  "errors": {
    "network": "No internet connection.",
    "unknown": "Something went wrong."
  }
}
```

All non-EN files mirror this structure. A missing key silently falls back to EN
at runtime — treat any gap as a translation bug, not a safe fallback.

---

## Adapt for your project

- **Locale list** — the example uses `en, fr, es, it, de`. Update `resources`,
  `supportedLngs`, both `SUPPORTED` arrays, and all locale JSON files together.
- **Persistence backend** — `AsyncStorage` above. Swap to `expo-secure-store`
  for apps handling privacy-sensitive data; API surface is identical.
- **Server-locale field** — point `applyServerLocale` at your `/user` locale
  field. Pass `null` when absent; `isSupported` guards unsupported values.
- **Default / fallback** — change `DEFAULT`, `fallbackLng`, and the `lng` seed
  in `index.ts` atomically.
- **Remote translations (Phase 2+)** — add `i18next-http-backend`; store and
  resolution hierarchy unchanged, but `hydrate` must await async init.
