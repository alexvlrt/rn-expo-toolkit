---
name: expo-env-setup
description: "Use when setting up a React Native + Expo dev machine from scratch (WSL / Linux / macOS) — Android SDK + JDK + ADB, the iOS toolchain on macOS (Xcode, CocoaPods, simulators), and the build scripts that tie it together. Produces an idempotent setup.sh and a doctor health-check. Run once per machine; re-run safely after a toolchain upgrade."
---

# expo-env-setup

One-time machine bootstrap: go from a fresh clone to "I can build & run a dev client."

> **Complements:** `expo-dev-client` (the EAS dev-client build flow this assumes is set up);
> cross-refs this toolkit's `expo-dx-scripts` (the daily run/build loop, ADB device picker,
> WSL2 USB auto-attach, and cloudflared tunnel that run _after_ this bootstrap is done).

---

## Conventions / checklist

- **One idempotent `scripts/setup.sh`** — detects OS (WSL2 / native Linux / macOS), checks
  each dependency, and only installs what's missing. Re-running it on an already-configured
  machine is safe.
- **Android (all OS):** JDK 17, Android SDK (cmdline-tools + platform-tools + a recent API
  level), `ANDROID_HOME` + PATH written into the shell rc once, `sdkmanager --licenses`
  auto-accepted.
- **ADB per OS:**
  - **WSL2** — USB devices are invisible to the Linux kernel. Bridge via `usbipd-win`:
    one-time admin `usbipd bind` (PowerShell elevated, once per device), then automated
    `usbipd attach` on every dev session. The attach logic lives in `expo-dx-scripts`
    (`scripts/lib/usbip.sh`) — cross-reference, do not duplicate here.
  - **Native Linux** — ADB works over USB once the udev rule is in place and the user is in
    the `plugdev` group (see snippet below).
  - **macOS** — USB ADB works out of the box once `android-platform-tools` is installed via
    Homebrew.
- **iOS (macOS only):** Xcode + CLI tools, license acceptance, CocoaPods via `rbenv`
  (never system Ruby — CocoaPods on system Ruby breaks silently on recent macOS), Watchman,
  at least one simulator runtime. _(This section is standard macOS RN practice — not
  distilled from a production app.)_
- **`doctor` script** — verifies Node / pnpm / JDK / Android SDK / ADB (+ Xcode /
  CocoaPods on macOS) and prints a clear pass/fail list. Run before every native rebuild to
  catch stale tool versions.
- **Build aliases:** `build-android.sh` wraps `expo run:android --no-bundler` (see
  `expo-dx-scripts` for the full daily-loop wrapper); `build-ios.sh` wraps
  `expo run:ios --no-bundler` (macOS only).

---

## Adapt for your project

| Decision | Default shown here | Your override |
|---|---|---|
| Node minimum | 18 | bump if your Expo SDK requires higher |
| JDK version | 17 | 17 is the Android-required minimum; 21 works too |
| Android API level | 35 | match `compileSdkVersion` in `android/build.gradle` |
| Build tools version | 35.0.0 | keep in sync with API level |
| SDK install location | `~/Android/Sdk` (Linux/WSL), `~/Library/Android/sdk` (macOS) | override via `ANDROID_HOME` |
| WSL Windows SDK reuse | yes — tries `%USERPROFILE%\AppData\Local\Android\Sdk` first | remove branch if you always install natively |
| iOS support | macOS only | drop the iOS block if Android-only |

---

## `setup.sh` skeleton

```bash
#!/usr/bin/env bash
# scripts/setup.sh — idempotent machine bootstrap for React Native + Expo dev.
# Safe to re-run. Only installs what is missing.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
step() { echo -e "\n${GREEN}[$1]${NC} $2"; }

SHELL_RC="$HOME/.bashrc"
[ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
NEEDS_RELOAD=false

# ── OS detection ────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux*)
    grep -qi microsoft /proc/version 2>/dev/null && OS="wsl" || OS="linux" ;;
  Darwin*) OS="macos" ;;
  *) fail "Unsupported OS: $(uname -s)" ;;
esac
echo -e "${GREEN}=== RN+Expo machine setup ===${NC}  (OS: ${YELLOW}${OS}${NC})"

# ── 1. Node.js (≥18) ────────────────────────────────────────────────────────
step "1" "Node.js"
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  [ "$NODE_MAJOR" -ge 18 ] && ok "Node.js $(node -v)" \
    || fail "Node.js $(node -v) found but ≥18 required — upgrade via nvm"
else
  fail "Node.js not found. Install via nvm: https://github.com/nvm-sh/nvm"
fi

# ── 2. pnpm ─────────────────────────────────────────────────────────────────
step "2" "pnpm"
command -v pnpm &>/dev/null \
  && ok "pnpm $(pnpm -v)" \
  || fail "pnpm not found — run: corepack enable && corepack prepare pnpm@latest --activate"

# ── 3. JDK 17 ───────────────────────────────────────────────────────────────
step "3" "Java JDK 17"
needs_java() {
  command -v java &>/dev/null || return 0
  local v; v=$(java -version 2>&1 | head -1 | grep -oP '\d+' | head -1)
  [ "$v" -lt 17 ]
}
if needs_java; then
  warn "Installing OpenJDK 17..."
  case "$OS" in
    linux|wsl) sudo apt-get update -qq && sudo apt-get install -y -qq openjdk-17-jdk ;;
    macos)     brew install openjdk@17 ;;
  esac
  ok "OpenJDK 17 installed"
else
  ok "Java $(java -version 2>&1 | head -1 | grep -oP '\d+' | head -1)"
fi

# ── 4. Android SDK ──────────────────────────────────────────────────────────
step "4" "Android SDK"

install_cmdline_tools() {
  local url="$1"
  warn "Downloading Android cmdline-tools..."
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  local tmp; tmp=$(mktemp)
  curl -fsSL "$url" -o "$tmp"
  unzip -qo "$tmp" -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -f "$tmp"
  export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"
  warn "Installing SDK packages..."
  yes | sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" 2>/dev/null || true
  yes | sdkmanager --licenses 2>/dev/null || true
  ok "Android SDK installed at $ANDROID_HOME"
}

case "$OS" in
  wsl)
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
    if [ -d "$ANDROID_HOME/cmdline-tools/latest/bin" ]; then
      ok "Android SDK at $ANDROID_HOME"
    else
      # Prefer reusing an existing Windows Android Studio SDK — avoids a 1 GB download.
      WIN_USER=$(cmd.exe /C "echo %USERNAME%" 2>/dev/null | tr -d '\r' || true)
      WIN_SDK="/mnt/c/Users/$WIN_USER/AppData/Local/Android/Sdk"
      if [ -n "$WIN_USER" ] && [ -d "$WIN_SDK/platform-tools" ]; then
        ANDROID_HOME="$WIN_SDK"
        ok "Reusing Windows Android Studio SDK: $ANDROID_HOME"
      else
        install_cmdline_tools \
          "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
      fi
    fi ;;
  linux)
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
    [ -d "$ANDROID_HOME/cmdline-tools/latest/bin" ] && ok "Android SDK at $ANDROID_HOME" \
      || install_cmdline_tools \
           "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" ;;
  macos)
    ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
    [ -d "$ANDROID_HOME/cmdline-tools/latest/bin" ] && ok "Android SDK at $ANDROID_HOME" \
      || install_cmdline_tools \
           "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip" ;;
esac

# Persist ANDROID_HOME + PATH to shell rc (idempotent — written only once)
if ! grep -q "ANDROID_HOME" "$SHELL_RC" 2>/dev/null; then
  { echo ""; echo "# Android SDK"; echo "export ANDROID_HOME=\"$ANDROID_HOME\""
    echo 'export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"'
  } >> "$SHELL_RC"
  ok "ANDROID_HOME written to $SHELL_RC"
  NEEDS_RELOAD=true
fi
export ANDROID_HOME
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

# ── 5. ADB ──────────────────────────────────────────────────────────────────
step "5" "ADB"
if ! command -v adb &>/dev/null; then
  warn "Installing ADB..."
  case "$OS" in
    linux|wsl) sudo apt-get update -qq && sudo apt-get install -y -qq android-tools-adb ;;
    macos)     brew install android-platform-tools ;;
  esac
fi
ok "adb $(adb --version | head -1)"

# ── 6. iOS toolchain (macOS only) ───────────────────────────────────────────
# (standard macOS RN practice — not distilled from a production app)
if [ "$OS" = "macos" ]; then
  step "6" "iOS toolchain (macOS)"

  # Xcode CLI tools
  if xcode-select -p &>/dev/null; then
    ok "Xcode CLI tools at $(xcode-select -p)"
  else
    warn "Installing Xcode CLI tools..."
    xcode-select --install
    warn "Re-run this script after the installer finishes."
    exit 0
  fi

  # Accept Xcode license (required before any xcodebuild invocation)
  if ! xcodebuild -checkFirstLaunchStatus &>/dev/null; then
    warn "Accepting Xcode license..."
    sudo xcodebuild -license accept
  fi
  ok "Xcode license accepted"

  # Watchman (fast file watcher — Metro lags without it)
  command -v watchman &>/dev/null && ok "watchman $(watchman --version)" \
    || { warn "Installing watchman..."; brew install watchman; ok "watchman installed"; }

  # rbenv + Ruby (system Ruby breaks CocoaPods on macOS ≥13)
  if command -v rbenv &>/dev/null; then
    ok "rbenv $(rbenv --version)"
  else
    warn "Installing rbenv..."
    brew install rbenv ruby-build
    echo 'eval "$(rbenv init - bash)"' >> "$SHELL_RC"
    NEEDS_RELOAD=true
  fi
  RUBY_VERSION="3.3.0"   # ← update to the latest stable when needed
  rbenv versions --bare | grep -q "^${RUBY_VERSION}$" \
    || { warn "Installing Ruby ${RUBY_VERSION}..."; rbenv install "$RUBY_VERSION"; }
  rbenv global "$RUBY_VERSION"
  ok "Ruby $(ruby --version | cut -d' ' -f2)"

  # CocoaPods
  command -v pod &>/dev/null && ok "CocoaPods $(pod --version)" \
    || { warn "Installing CocoaPods..."; gem install cocoapods; ok "CocoaPods installed"; }
fi

# ── 7. Deps + env file ──────────────────────────────────────────────────────
step "7" "Project"
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -d "$PROJ/node_modules" ] && ok "node_modules present" \
  || { warn "Running pnpm install..."; (cd "$PROJ" && pnpm install); ok "Dependencies installed"; }
[ -f "$PROJ/.env.local" ] && ok ".env.local present" \
  || { cp "$PROJ/.env.example" "$PROJ/.env.local"; ok ".env.local created from .env.example"; }

# ── Summary ─────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}=== Setup complete ===${NC}"
if [ "$NEEDS_RELOAD" = true ]; then
  echo -e "${YELLOW}Reload your shell:${NC}  source $SHELL_RC"
fi
echo -e "Next: run ${GREEN}pnpm build:android${NC} (or ${GREEN}build:ios${NC} on macOS) to compile the dev client."
```

---

## ADB setup notes by OS

### WSL2 — usbipd bridge

USB devices are not forwarded to the WSL2 kernel automatically. The fix is `usbipd-win`.

```
# One-time, in an ADMIN PowerShell (persists across replugs and reboots):
usbipd bind --busid <BUSID>       # find BUSID with: usbipd list

# Every dev session — done automatically by expo-dx-scripts (usbip.sh):
usbipd attach --wsl --busid <BUSID>
```

The `attach` step (non-admin) is automated in `expo-dx-scripts/scripts/lib/usbip.sh` —
see that skill for the full logic (retry loop, bound-device detection, mDNS fallback).
Do not duplicate it here.

Wireless debugging (ADB over Wi-Fi) also works without usbipd — enable it on the device
under **Developer Options → Wireless debugging**, then `adb connect <ip>:<port>`.

### Native Linux — udev rule

```bash
# Add a udev rule so ADB can open the device without root.
# Replace <VENDOR_ID> with your phone's USB vendor ID (e.g. 18d1 for Google/Pixel).
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="<VENDOR_ID>", MODE="0666", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/51-android.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo usermod -aG plugdev "$USER"
# Log out and back in for the group change to take effect.
```

Common USB vendor IDs: `18d1` Google/Pixel, `04e8` Samsung, `2717`/`2a45` Xiaomi,
`22d9` Oppo, `2a70` OnePlus, `0fce` Sony, `1004` LG.

### macOS — USB works out of the box

Install `android-platform-tools` via Homebrew (done in `setup.sh` above). Plug in the
phone, accept the "Allow USB Debugging" prompt on the device, and run `adb devices`.

---

## iOS toolchain detail _(standard macOS setup — not distilled from a production app)_

```bash
# 1. Install Xcode from the Mac App Store, then accept the license:
sudo xcodebuild -license accept

# 2. Install CLI tools (if Xcode.app is installed, the full toolchain is already present;
#    this is for CI or machines without the full IDE):
xcode-select --install

# 3. Install a simulator runtime if none is present:
#    Xcode → Settings → Platforms → + → iOS <version>
#    Or on the CLI (Xcode 14.3+):
xcodebuild -downloadPlatform iOS

# 4. rbenv + Ruby (never use /usr/bin/ruby for CocoaPods)
brew install rbenv ruby-build
rbenv install 3.3.0 && rbenv global 3.3.0
eval "$(rbenv init -)"

# 5. CocoaPods
gem install cocoapods

# 6. Watchman (Metro file-watcher — install before first `expo run:ios`)
brew install watchman
```

---

## `doctor` health-check

```bash
#!/usr/bin/env bash
# scripts/doctor.sh — verifies all required tools are present and at minimum versions.
# Exit 0 = all good; non-zero = at least one check failed.
set -uo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
FAIL=0
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=1; }

case "$(uname -s)" in
  Linux*) grep -qi microsoft /proc/version 2>/dev/null && OS=wsl || OS=linux ;;
  Darwin*) OS=macos ;;
  *) OS=unknown ;;
esac

echo "=== RN+Expo doctor (OS: $OS) ==="

# Node ≥18
command -v node &>/dev/null \
  && [ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge 18 ] \
  && ok "Node.js $(node -v)" \
  || fail "Node.js ≥18 missing"

# pnpm
command -v pnpm &>/dev/null && ok "pnpm $(pnpm -v)" || fail "pnpm missing"

# JDK ≥17
command -v java &>/dev/null \
  && [ "$(java -version 2>&1 | head -1 | grep -oP '\d+' | head -1)" -ge 17 ] \
  && ok "Java $(java -version 2>&1 | head -1 | grep -oP '\d+' | head -1)" \
  || fail "JDK 17+ missing"

# ANDROID_HOME + sdkmanager
[ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/cmdline-tools/latest/bin" ] \
  && ok "ANDROID_HOME=$ANDROID_HOME" \
  || fail "ANDROID_HOME not set or cmdline-tools missing"

# ADB
command -v adb &>/dev/null && ok "adb $(adb --version | head -1)" || fail "adb missing from PATH"

# macOS extras
if [ "$OS" = "macos" ]; then
  xcode-select -p &>/dev/null && ok "Xcode CLI tools" || fail "Xcode CLI tools missing"
  command -v pod &>/dev/null  && ok "CocoaPods $(pod --version)" || fail "CocoaPods missing"
  command -v watchman &>/dev/null && ok "watchman $(watchman --version)" || fail "watchman missing"
  command -v rbenv &>/dev/null && ok "rbenv $(rbenv --version)" || warn "rbenv not found (recommended for CocoaPods Ruby)"
fi

[ "$FAIL" -eq 0 ] && echo -e "\n${GREEN}All checks passed.${NC}" \
  || { echo -e "\n${RED}One or more checks failed. Re-run setup.sh.${NC}"; exit 1; }
```

---

## `build-ios.sh` skeleton _(macOS only)_

```bash
#!/usr/bin/env bash
# scripts/build-ios.sh — compile + install the Expo dev client on the iOS simulator
# or a connected device. Assumes expo-dev-client is in package.json dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env.sh"       # load APP_VARIANT / .env.local (see expo-dx-scripts)

# Run CocoaPods install if the Pods directory is stale
PODS_DIR="$(dirname "$SCRIPT_DIR")/ios/Pods"
if [ ! -d "$PODS_DIR" ] || [ "$(dirname "$SCRIPT_DIR")/ios/Podfile.lock" -nt "$PODS_DIR" ]; then
  echo "[pods] Running pod install..."
  (cd "$(dirname "$SCRIPT_DIR")/ios" && pod install --repo-update)
fi

# Build + install dev client (Metro starts separately via pnpm dev:ios)
npx expo run:ios --no-bundler "$@"
```

> For the Android equivalent and the Metro + tunnel start, see `expo-dx-scripts`.
