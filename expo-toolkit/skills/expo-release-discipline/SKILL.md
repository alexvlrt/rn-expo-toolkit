---
name: expo-release-discipline
description: "Use before shipping any change to a published RN+Expo app — classifies the change as OTA-safe vs native-rebuild, verifies the runtime policy (fingerprint, never appVersion), prescribes a CHANGELOG entry template, and runs a pre-OTA runtime guard via eas channel:insights. Composes expo-deployment + expo-cicd-workflows + eas-update-insights with the project-tuned classification discipline."
---

# expo-release-discipline

> **Complements:** `expo-deployment`, `expo-cicd-workflows`, `eas-update-insights`.
> This skill adds: the OTA-vs-native classification rule list, the CHANGELOG entry template, and the pre-OTA cohort runtime guard.

---

## 1. Authority-Preferred Default — `runtimeVersion.policy: 'fingerprint'`

Always use `fingerprint` as the runtime version policy. **Never use `'appVersion'`.**

`appVersion` couples the OTA runtime to a human-edited string (`version` in `app.config.ts`). This is the documented root cause of runtime-skew incidents where OTAs pushed at runtime `X` are invisible to the embedded cohort sitting at runtime `Y` — because the two values diverged when the version string was bumped for a store submission without a corresponding JS update.

`fingerprint` computes the runtime hash from the actual native layer (native modules, plugins, infoPlist, build config). The hash only changes when the native surface actually changes, decoupling OTA eligibility from manually edited strings.

```ts
// app.config.ts — the only accepted runtime policy
export default {
  // ... other config
  runtimeVersion: {
    policy: 'fingerprint',
  },
} satisfies ExpoConfig;
```

---

## 2. OTA-vs-Native Classification

**Classify every change before deploying.** This table is the spine of release discipline.

| Change type | Deploy path | Rationale |
|---|---|---|
| Any edit to `app.config.ts` (plugins, infoPlist, icon, splash, scheme, `version`, `runtimeVersion`, owner, bundleIdentifier, capabilities) | **Native rebuild** | Config drives native codegen; any change can alter the fingerprint |
| Adding or removing a native dependency (`react-native-*`, `expo-*` modules, any non-pure-JS package) | **Native rebuild** | New or removed native modules change autolinking |
| Capability changes in App Store Connect or Play Console | **Native rebuild** | Entitlements must match the signed binary |
| Icon or splash screen asset changes | **Native rebuild** | Assets are compiled into the native binary |
| Minimum iOS or Android version bump | **Native rebuild** | Requires a new binary submission |
| App Privacy declaration changes (new data collection, new sharing) | **Native rebuild** | Store submission must be updated to match |
| Age-rating-affecting content changes | **Native rebuild** | Apple/Google re-evaluate the binary |
| Subscription product, price, or trial term changes | **Native rebuild** | Must align with what the store has approved |
| JS / TSX / styles / hooks / components | **OTA (`eas update`)** | Pure JS bundle; no native layer touched |
| Bundled copy, layout changes | **OTA** | Bundle only |
| Logic fixes, performance optimizations | **OTA** | Bundle only |
| Bug fixes | **OTA** | Bundle only |
| Localizations | **OTA** | Bundle only |
| A/B tests of existing UX (not paywall structure changes) | **OTA** | Bundle only |

### Rule of Thumb

**When unsure → native rebuild.**

The cost of an unnecessary native rebuild is approximately 30 minutes of build time. The cost of a mistaken OTA in a sensitive app category (health, finance, children) is potential account suspension. The asymmetry strongly favors the rebuild when classification is ambiguous.

---

## 3. CHANGELOG Discipline

### Rules

- Append **one entry per shipped production build** (submitted to TestFlight / App Store / Play Console) or **per production OTA** (`eas update --branch production`).
- **Skip** development and staging builds — only entries for changes that reached real users.
- CHANGELOG = **human intent** (what you meant to ship). Cohort truth = machine records:
  ```bash
  eas update:list --branch production --json
  eas channel:insights --channel production --runtime-version <v>
  ```

### Entry Template

```markdown
## [Build|OTA] vX.Y.Z (build N) — iOS + Android — YYYY-MM-DD — <3-7 word recap>

**ID**: <eas-build-id or eas-update-group-id>
**iOS update ID**: <uuid>          # OTA only
**Android update ID**: <uuid>      # OTA only
**Channel/Track**: production
**Runtime version**: <fingerprint-hash or explicit string>
**Commit**: <git-sha>
**API deploy**: <worker-deploy-id or "n/a">

### Changes
- <bullet 1>
- <bullet 2, optional>
- <bullet 3, optional>
```

**Fill in only the fields relevant to the delivery type.** A native build entry will have a build ID; an OTA entry will have an update group ID plus per-platform update IDs. The `API deploy` field is optional but valuable when a backend change ships in the same cohort window.

---

## 4. Pre-OTA Runtime Guard

Before every `eas update --branch production`, verify that the runtime version you are about to target actually has an embedded cohort in production. An OTA pushed at runtime `abc123` is **invisible** to all devices running a binary built at a different fingerprint.

```bash
# Step 1 — list the live runtime(s) in production + their embedded device counts
eas channel:view production
# Output shows each runtime hash currently serving devices. Note the hash you are about to target.

# Step 2 (optional) — per-runtime cohort detail for the specific runtime you will push to
eas channel:insights --channel production --runtime-version <runtime-from-above>
# Shows device counts, update adoption, and platform split for that runtime.
# A count of 0 means no devices are running that binary — the OTA will be invisible.

# Step 3 — push only if the runtime has a non-zero embedded cohort
eas update --branch production --environment production --message "<short summary>"
```

If `eas channel:view production` shows the runtime you intend to target has zero or no matching devices, the binary in production does not match that fingerprint. You likely need a native rebuild first, or you are targeting the wrong channel.

---

## 5. EAS Profile Structure

Use three profiles: `development` for local iteration (APK, internal distribution), `staging` for QA (APK, internal distribution, preview channel), and `production` for store submissions (AAB, autoIncrement, production channel).

```json
{
  "cli": {
    "version": ">= 16.0.1",
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "channel": "development",
      "environment": "development",
      "android": { "buildType": "apk" }
    },
    "staging": {
      "distribution": "internal",
      "channel": "staging",
      "environment": "preview",
      "android": { "buildType": "apk" },
      "ios": { "simulator": false }
    },
    "production": {
      "channel": "production",
      "autoIncrement": true,
      "environment": "production",
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "<YOUR_APPLE_ID>",
        "ascAppId": "<YOUR_ASC_APP_ID>",
        "appleTeamId": "<YOUR_APPLE_TEAM_ID>",
        "bundleIdentifier": "<YOUR_BUNDLE_ID>"
      },
      "android": {
        "serviceAccountKeyPath": "./secrets/eas-play-service-account.json",
        "track": "internal",
        "releaseStatus": "draft"
      }
    }
  }
}
```

**Key settings:**

- `cli.version: ">= 16.0.1"` — enforces a minimum EAS CLI floor; older versions have known bugs in fingerprint computation.
- `appVersionSource: "remote"` — EAS manages build numbers; the local `app.config.ts` is never the authoritative build counter.
- `autoIncrement: true` on production — build numbers increment automatically per submission, avoiding conflicts in App Store Connect and Play Console.
- `autoSubmit` is **off by default** — requiring a deliberate `eas submit` call prevents accidental App Store submissions and gives a review window before the binary reaches the store.

---

## 6. CI Workflows

Defer full pipeline definition to the `expo-cicd-workflows` skill. Recommended pair:

- **`publish-preview-update.yml`** — triggers on push to `staging` branch; runs `eas update --branch staging --environment preview`. Used by QA and internal testers.
- **`production-build.yml`** — triggers on a version tag (e.g. `v1.2.0`); runs `eas build --profile production --platform all`. Requires explicit tag push from a human to avoid accidental store submissions.

Validate the workflow files with `expo-cicd-workflows`'s `scripts/validate.js` after any pipeline change.

---

## 7. Core EAS Commands Reference

```bash
# OTA to production (classify first; --environment pulls env vars from EAS dashboard)
eas update --branch production --environment production --message "<short summary>"

# OTA to staging / internal QA
eas update --branch staging --environment preview --message "<short summary>"

# Native production build
eas build --profile production --platform ios
eas build --profile production --platform android

# Submit a completed build artifact to the store
eas submit --profile production --platform ios
eas submit --profile production --platform android

# Rollback: republish a previous update group on the same branch
eas update --branch production --republish --group <previous-update-group-id>

# Inspect production OTA state
eas update:list --branch production --limit 10
eas channel:view production
```

The `--environment production` flag on `eas update` is required so EAS pulls environment variables from the dashboard rather than any local `.env*` file. Skipping it risks leaking development or sandbox credentials to production users.

---

## 8. Adapt to Your Project

- **Channel names** — the examples use `production` / `staging` / `development`. Rename as your project requires; update both `eas.json` and every `eas update --branch` call consistently.
- **Branch-to-channel mapping** — the recommended mapping is `main` → production channel, `staging` → staging channel, `feature/*` → no automatic channel (deploy manually or via PR preview). Adjust to match your git branching model.
- **Build-number scheme** — `autoIncrement: true` with `appVersionSource: "remote"` is the recommended default. If you need a different scheme (e.g. date-based), configure `buildNumberPattern` per profile.
- **Paired API deploy convention** — if your backend and mobile are versioned together (e.g. a monorepo), the CHANGELOG `API deploy` field records the backend deploy ID or commit SHA that shipped alongside the mobile OTA. Use `n/a` when the API was not touched.
- **`autoSubmit` policy** — keeping it off (the default above) is safest for regulated or health-adjacent categories. Enable it per profile only if your CI pipeline has a manual approval gate before the submit step.
- **Sensitive categories** — apps in health, finance, or children categories face stricter App Store review. The "when unsure → native rebuild" rule is especially important: Apple treats runtime-skew issues as policy violations, not just technical bugs.
