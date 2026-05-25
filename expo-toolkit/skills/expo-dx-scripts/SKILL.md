---
description: "Use when setting up local dev for a RN+Expo app on Linux/WSL/macOS, exposing a local backend to a physical device, picking an ADB device automatically, or auto-attaching USB devices into WSL2. Wraps expo run / Metro / cloudflared tunnel / ADB reverse / usbipd into pnpm scripts that source per-variant .env files. Companion to expo-dev-client (which covers the EAS-blessed dev-client build flow)."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# expo-dx-scripts

Local dev-loop wrappers for a React Native + Expo project: per-variant env sourcing,
cloudflared backend tunnel, ADB device picker, WSL2 USB auto-attach, and an idempotent
machine-bootstrap script — all driven from `pnpm` aliases so no developer ever calls
`expo`/`eas` directly at the app level.

> **Complements:** `expo-dev-client` — the EAS path (`eas build --profile development`)
> is Expo's blessed approach to dev-client builds. The wrappers documented here are a
> **local-loop optimization** that skips the EAS queue and invokes
> `expo run:android --no-bundler` + a separate Metro start; both produce an equivalent
> dev-client APK. Use the EAS path for CI, remote team members, or when you lack a
> reliable USB/wireless ADB setup.

---

## Authority-preferred default

```bash
# EAS-blessed — works everywhere, no local Android SDK required
eas build --profile development --platform android
eas build --profile development --platform android --local   # build locally, no queue
```

The scripts below replace the EAS queue for the **local inner loop** only.
They require a local Android SDK, ADB, and (on WSL2) usbipd-win.

---

## Conventions

Follow all nine of these when wiring up your own wrappers.

1. **One `pnpm` wrapper per common action** — `pnpm dev` (Metro + tunnel + ADB
   reverse), `pnpm dev:ios` (Metro + two tunnels + `EXPO_PACKAGER_PROXY_URL`),
   `pnpm build:android` (compile + install), `pnpm install:env` (one-time machine
   setup). Document these in `CLAUDE.md`; never call `expo`/`eas` raw at the app level.

2. **Per-variant `.env` files** — keep `.env.development`, `.env.staging`, and
   `.env.production` (never commit secrets). Each wrapper sources the correct file with
   `set -a; source .env.<variant>; set +a` before spawning `expo run` or `pnpm start`,
   so `EXPO_PUBLIC_*` vars are baked into the right JS bundle.

3. **cloudflared for backend tunneling** — do NOT use Expo's `--tunnel` flag for the
   backend. `--tunnel` only tunnels Metro (port 8081). If your backend runs on a
   different port (e.g. 8787 for a Workers dev server, 3000/4000 for Node/Express),
   start a separate `cloudflared tunnel --url http://localhost:<backend-port>` and
   write the resulting `trycloudflare.com` URL into `EXPO_PUBLIC_API_URL` in
   `.env.local`. That way both Metro and the API are reachable from the device.

4. **iOS Metro via `EXPO_PACKAGER_PROXY_URL`** — on iOS / physical iPhone (especially
   from WSL, where `adb reverse` is unavailable), the device cannot reach `localhost`.
   Tunnel Metro through cloudflared AND set
   `EXPO_PACKAGER_PROXY_URL="<metro-tunnel-url>"` before starting Metro. This env var
   overrides the `bundleUrl` embedded in the Metro manifest so the dev client fetches
   the bundle from the tunnel instead of `localhost:8081`. Without it the dev client
   shows "Could not connect to development server".

5. **Android Metro via `adb reverse`** — for Android there is no need to tunnel Metro.
   Run `adb reverse tcp:8081 tcp:8081` after Metro starts; the device then resolves
   `localhost:8081` through the USB/wireless ADB bridge. Simpler and faster than a
   cloudflared tunnel for the bundle.

6. **ADB device picker waterfall** (`lib/adb.sh`) — check in order: (a) already
   connected device → leave it, (b) USB auto-attach via usbipd (WSL only), (c) mDNS
   wireless-debugging scan → auto-pick if one match, prompt if multiple. Exit the
   script with an error if none is found.

7. **usbipd auto-attach (WSL2 only, `lib/usbip.sh`)** — USB devices are invisible to
   the WSL2 kernel without forwarding. Binding is a **one-time admin step** on the
   Windows side (`usbipd bind --busid X-Y` in an elevated PowerShell; persists across
   reboots). Attaching does NOT require admin (usbipd 4.x+) and is done automatically
   by the script on every `pnpm dev`. The library is a no-op on macOS and native
   Linux; safe to source unconditionally.

8. **`setup.sh` = idempotent bootstrap** — one script that checks and installs every
   prerequisite: OS detection, Node ≥ 18, pnpm, Docker (optional), Java 17, Android
   SDK + ADB (downloads, or reuses the Windows-side Android Studio SDK on WSL2),
   `pnpm install`, `.env.local` copy from `.env.example`, and a final hint to run
   `pnpm build:android`.  Re-running must be safe: each check is a no-op if already
   satisfied.

9. **No raw `expo`/`eas` at the app level** — document in the project's `CLAUDE.md`:
   "Use `pnpm dev`, `pnpm dev:ios`, `pnpm build:android`. Never call `expo run:*` or
   `eas build` directly from the app directory." This ensures the per-variant env is
   always loaded and the ADB handshake always happens.

---

## Inline snippets

### 1. `scripts/dev.sh` — Android Metro + backend tunnel

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/adb.sh"      # provides ensure_adb_device, pick_device_serial
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env.local"

# Source per-run overrides (.env.local is rewritten by this script on each run)
[ -f "$ENV_FILE" ] && { set -a; source "$ENV_FILE"; set +a; }

CLOUDFLARED="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
TUNNEL_LOG="$(mktemp)"

CLEAR_FLAG=""
for arg in "$@"; do [ "$arg" = "--clear" ] && CLEAR_FLAG="--clear"; done

cleanup() { jobs -p | xargs -r kill 2>/dev/null; rm -f "$TUNNEL_LOG"; exit 0; }
trap cleanup SIGINT SIGTERM

# 1. Ensure an ADB device is reachable (USB → usbipd → mDNS waterfall)
ensure_adb_device
DEVICE_SERIAL="$(pick_device_serial)"

# Guard: fail early if no dev build exists — avoids a confusing Metro error
APK_PATH="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK_PATH" ] || { echo "No dev build found. Run 'pnpm build:android' first."; exit 1; }

# 2. Start cloudflared tunnel for the backend (e.g. Workers on :8787)
# Replace 8787 with your backend dev port (3000, 4000, …)
"$CLOUDFLARED" tunnel --url http://localhost:8787 --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
TUNNEL_URL=""
for i in $(seq 1 120); do
  TUNNEL_URL="$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$TUNNEL_URL" ] && break
  sleep 0.5
done
[ -z "$TUNNEL_URL" ] && { echo "Tunnel failed — see $TUNNEL_LOG"; exit 1; }

# 3. Write tunnel URL into .env.local so Metro bundles the right API base URL
sed -i "s|^EXPO_PUBLIC_API_URL=.*|EXPO_PUBLIC_API_URL=${TUNNEL_URL}|" "$ENV_FILE" \
  || echo "EXPO_PUBLIC_API_URL=${TUNNEL_URL}" >> "$ENV_FILE"

# 4. ADB reverse — device resolves localhost:8081 over the ADB bridge; no Metro tunnel needed
adb -s "$DEVICE_SERIAL" reverse tcp:8081 tcp:8081

# 5. Start Metro (APP_VARIANT drives per-variant app.config.ts logic)
APP_VARIANT="${APP_VARIANT:-development}" \
  REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  pnpm start $CLEAR_FLAG
```

---

### 2. `scripts/dev-ios.sh` — iOS Metro + dual cloudflared tunnels

```bash
#!/usr/bin/env bash
set -euo pipefail

# iOS has no ADB bridge, so both Metro (8081) and the backend need cloudflared tunnels.
# The Metro tunnel URL is printed at the end — paste it into the dev client's
# "Enter URL manually" prompt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env.local"

[ -f "$ENV_FILE" ] && { set -a; source "$ENV_FILE"; set +a; }

CLOUDFLARED="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
API_LOG="$(mktemp)"
METRO_LOG="$(mktemp)"

CLEAR_FLAG=""
for arg in "$@"; do [ "$arg" = "--clear" ] && CLEAR_FLAG="--clear"; done

cleanup() { jobs -p | xargs -r kill 2>/dev/null; rm -f "$API_LOG" "$METRO_LOG"; exit 0; }
trap cleanup SIGINT SIGTERM

# Helper: start a cloudflared tunnel on a given port, return the public URL
start_tunnel() {
  local port="$1" log="$2"
  "$CLOUDFLARED" tunnel --url "http://localhost:${port}" --no-autoupdate > "$log" 2>&1 &
  for _ in $(seq 1 120); do
    local url; url="$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && { echo "$url"; return 0; }
    sleep 0.5
  done
  return 1
}

# 1. Backend tunnel (replace 8787 with your backend dev port)
API_URL="$(start_tunnel 8787 "$API_LOG")" \
  || { echo "API tunnel failed"; cat "$API_LOG"; exit 1; }
sed -i "s|^EXPO_PUBLIC_API_URL=.*|EXPO_PUBLIC_API_URL=${API_URL}|" "$ENV_FILE" \
  || echo "EXPO_PUBLIC_API_URL=${API_URL}" >> "$ENV_FILE"

# 2. Metro tunnel — needed because iPhone can't reach the dev machine's localhost
METRO_URL="$(start_tunnel 8081 "$METRO_LOG")" \
  || { echo "Metro tunnel failed"; cat "$METRO_LOG"; exit 1; }

# 3. Start Metro with EXPO_PACKAGER_PROXY_URL so the manifest embeds the tunnel URL.
#    Without this var the dev client receives a manifest pointing at localhost:8081
#    and immediately fails with "Could not connect to development server".
APP_VARIANT="${APP_VARIANT:-development}" \
  REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  EXPO_PACKAGER_PROXY_URL="$METRO_URL" \
  pnpm start $CLEAR_FLAG &

# Wait for Metro to be listening, then print the connect URL
for _ in $(seq 1 120); do
  ss -tln 2>/dev/null | grep -q ':8081 ' && break
  sleep 0.5
done

echo ""
echo "API tunnel  : $API_URL"
echo "Metro tunnel: $METRO_URL"
echo ""
echo "On the iPhone dev client → Enter URL manually:"
echo "$METRO_URL"
echo ""
echo "Ctrl-C to stop everything."
wait
```

---

### 3. `scripts/lib/adb.sh` — ADB device-picker library

```bash
# Shell library — source, do not execute directly.
# Provides ensure_adb_device and pick_device_serial.
#
# Usage:
#   source "$SCRIPT_DIR/lib/adb.sh"
#   ensure_adb_device
#   DEVICE_SERIAL="$(pick_device_serial)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# Pull in usbipd helper (no-op on macOS / native Linux)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/usbip.sh"

_get_connected_devices() {
  adb devices 2>/dev/null | tail -n +2 | grep -w "device\|unauthorized" | head -20 || true
}

# Strategy:
#   1. Device already connected (USB or a prior adb connect) → done.
#   2. WSL + usbipd: attach bound-but-detached USB device, poll adb.
#   3. mDNS wireless-debugging scan: auto-pick if one, prompt if multiple.
# Exits the calling script with code 1 if no device is found.
ensure_adb_device() {
  command -v adb &>/dev/null \
    || { echo -e "${RED}adb not in PATH. Install Android SDK platform-tools.${NC}"; exit 1; }

  local devices
  devices="$(_get_connected_devices)"
  [ -n "$devices" ] && { echo -e "${GREEN}Device already connected.${NC}"; return 0; }

  # WSL USB auto-attach (no-op elsewhere)
  if declare -f ensure_usb_attached >/dev/null 2>&1 && ensure_usb_attached; then
    for _ in $(seq 1 10); do
      devices="$(_get_connected_devices)"; [ -n "$devices" ] && break; sleep 0.5
    done
    [ -n "$devices" ] && { echo -e "${GREEN}Device ready (USB).${NC}"; return 0; }
  fi

  # mDNS fallback (Android 11+ wireless debugging)
  echo -e "${YELLOW}No USB device. Scanning mDNS...${NC}"
  local mdns; mdns="$(timeout 5 adb mdns services 2>/dev/null | grep "_adb-tls-connect" | head -20 || true)"
  [ -z "$mdns" ] && { echo -e "${RED}No device found. Enable wireless debugging.${NC}"; exit 1; }

  local count; count="$(echo "$mdns" | wc -l)"
  if [ "$count" -eq 1 ]; then
    local addr; addr="$(echo "$mdns" | grep -oP '\d+\.\d+\.\d+\.\d+:\d+' || true)"
    [ -n "$addr" ] && adb connect "$addr"
  else
    echo -e "${YELLOW}Multiple mDNS devices:${NC}"
    local i=1; while IFS= read -r line; do
      echo "  $i) $(echo "$line" | grep -oP '\d+\.\d+\.\d+\.\d+:\d+' || true)"
      i=$((i+1))
    done <<< "$mdns"
    local choice; read -rp "Select device number: " choice
    local sel; sel="$(echo "$mdns" | sed -n "${choice}p" | grep -oP '\d+\.\d+\.\d+\.\d+:\d+' || true)"
    [ -n "$sel" ] && adb connect "$sel" || { echo -e "${RED}Invalid selection.${NC}"; exit 1; }
  fi

  devices="$(_get_connected_devices)"
  [ -z "$devices" ] && { echo -e "${RED}mDNS device found but adb connect failed.${NC}"; exit 1; }
  echo -e "${GREEN}Device ready (mDNS).${NC}"
}

# Return the serial of the first ready device.
# Prefers IP:port (wireless) over USB serial so a re-used adb-connect session wins.
pick_device_serial() {
  local s
  s="$(adb devices 2>/dev/null | tail -n +2 | grep -w device | grep -oP '^\S+' \
        | grep -P '^\d+\.\d+\.\d+\.\d+' | head -1 || true)"
  [ -z "$s" ] && s="$(adb devices 2>/dev/null | tail -n +2 | grep -w device \
        | grep -oP '^\S+' | head -1 || true)"
  echo "$s"
}
```

---

### 4. `scripts/lib/usbip.sh` — WSL2 usbipd auto-attach library

```bash
# Shell library — source, do not execute directly.
# Auto-attaches a USB Android phone into WSL2 via usbipd-win.
# No-op on macOS / native Linux (no usbipd.exe).
#
# One-time admin setup (elevated PowerShell, done once per machine):
#   usbipd bind --busid <X-Y>
#
# Usage:
#   source "$SCRIPT_DIR/lib/usbip.sh"
#   ensure_usb_attached    # returns 0 if a device was attached; 1 otherwise

# Locate usbipd.exe (not on the WSL PATH by default)
_usbipd_bin() {
  command -v usbipd.exe &>/dev/null && { command -v usbipd.exe; return 0; }
  local default="/mnt/c/Program Files/usbipd-win/usbipd.exe"
  [ -x "$default" ] && { printf '%s\n' "$default"; return 0; }
  return 1
}

# Parse `usbipd state` JSON and emit:
#   "attach\t<busid>"  — bound device not yet attached (PersistedGuid set, ClientIPAddress null)
#   "hint\t<busid>"    — Android vendor-ID device that is NOT bound yet (needs manual bind)
_usbip_plan() {
  python3 -c '
import sys, json
try: devices = json.load(sys.stdin).get("Devices", [])
except Exception: sys.exit(0)
for d in devices:
    busid = d.get("BusId") or ""
    if not busid: continue
    bound    = d.get("PersistedGuid") is not None
    attached = d.get("ClientIPAddress") is not None
    if bound and not attached:
        print("attach\t%s" % busid)
' 2>/dev/null
}

# Attach every bound-but-detached device. Idempotent — already-attached devices are skipped.
# Returns 0 if at least one device was attached; 1 otherwise (nothing to do, no device, no usbipd).
ensure_usb_attached() {
  local usbipd; usbipd="$(_usbipd_bin)" || return 1

  local attempt state plan did_attach action busid
  for attempt in 1 2 3 4 5; do
    state="$("$usbipd" state 2>/dev/null | tr -d '\r')" || return 1
    plan="$(printf '%s' "$state" | _usbip_plan)" || return 1

    did_attach=0
    while IFS=$'\t' read -r action busid; do
      [ -n "${busid:-}" ] || continue
      if [ "$action" = "attach" ]; then
        echo "[USB] Attaching bound device ${busid} into WSL..."
        "$usbipd" attach --wsl --busid "$busid" 2>&1 | tr -d '\r' || true
        did_attach=1
      fi
    done <<< "$plan"

    [ "$did_attach" = "1" ] && return 0
    sleep 0.5
  done
  return 1
}
```

---

## Adapt for your project

| Item | Default shown | What to change |
|---|---|---|
| Backend dev port | `8787` (Cloudflare Workers) | `3000` / `4000` for Node/Express/Bun; match your backend's listen port |
| Backend service name in tunnel log | `EXPO_PUBLIC_API_URL` | rename to match your env var convention |
| Linter / formatter | (not called by these scripts) | add `pnpm lint` / `pnpm format` to `setup.sh` post-install step if desired |
| Deeplink scheme | not present in skeletons | if your backend webhook or auth redirect uses a custom scheme, note it in `.env.*` and update `EXPO_SCHEME` accordingly |
| WSL support | included via `usbip.sh` | remove `source usbip.sh` and the `ensure_usb_attached` block from `adb.sh` for macOS-only or Linux-native teams; delete `lib/usbip.sh` |
| iOS support | `dev-ios.sh` provided | remove if Android-only; or add a `--staging-api` flag that skips the local backend tunnel and points at a deployed staging URL |

### `package.json` script block

```json
{
  "scripts": {
    "dev":           "bash scripts/dev.sh",
    "dev:ios":       "bash scripts/dev-ios.sh",
    "build:android": "bash scripts/build-android.sh",
    "install:env":   "bash scripts/setup.sh",
    "start":         "expo start",
    "lint":          "oxlint",
    "typecheck":     "tsc --noEmit"
  }
}
```

`build:android` contains the `expo run:android --no-bundler` invocation (plus optional
`--clean` to re-run `expo prebuild`). It should source the per-variant env and call
`ensure_adb_device` so the build lands on the right device automatically. After a
successful build, prompt the user to run `pnpm dev` — the two steps are intentionally
separate so Metro can be restarted without recompiling.

### When to rebuild vs when to just restart Metro

| Change | Action |
|---|---|
| JS / TSX / styles / copy | `pnpm dev` reload — no rebuild |
| New pure-JS dependency | `pnpm dev` reload |
| `app.config.ts` change | `pnpm build:android` (add `--clean` to regenerate `android/`) |
| New native dependency | `pnpm build:android --clean` (re-runs autolinking) |
| Icon / splash / capability change | `pnpm build:android --clean` |
