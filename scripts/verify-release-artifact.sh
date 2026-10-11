#!/usr/bin/env bash
# verify-release-artifact.sh — PRE-RELEASE gate for Sunday IDE builds.
#
# Written 2026-10-11 after Beta.2 shipped with the default-theme change
# UNCOMMITTED: every individual feature had been "verified" in source,
# but nobody opened the built artifact. This script opens it.
#
# Usage:
#   1. Download the Windows (or Linux) artifact from the CI run.
#   2. Extract it (zip/tar.gz; for the .exe installer, install once into a
#      scratch dir or extract with 7z) so you have the app folder that
#      contains resources/app.
#   3. ./scripts/verify-release-artifact.sh <path-to-app-folder>
#      (the folder containing resources/, or the resources/app folder itself)
#
# Exit 0 = all checks pass. Exit 1 = DO NOT RELEASE; the failed lines say why.
set -u

ROOT="${1:-}"
if [ -z "$ROOT" ]; then
  echo "usage: $0 <extracted-app-folder>" >&2; exit 2
fi
# Accept either <app> or <app>/resources/app
if [ -d "$ROOT/resources/app" ]; then APP="$ROOT/resources/app";
elif [ -d "$ROOT/out" ] && [ -d "$ROOT/extensions" ]; then APP="$ROOT";
else echo "FATAL: $ROOT does not look like an extracted Sunday app (no resources/app)" >&2; exit 2; fi

FAIL=0
ok()   { echo "PASS  $1"; }
bad()  { echo "FAIL  $1"; FAIL=1; }
has()  { grep -qF "$2" "$1" 2>/dev/null; }

echo "== App: $APP"

# 1. Sunday theme ships built-in, with the yellow status bar (#f5b942).
T="$APP/extensions/theme-sunday/themes/sunday-dark.json"
if [ -f "$T" ] && has "$T" '"statusBar.background":"#f5b942"'; then
  ok "theme-sunday present; Sunday Dark statusBar.background = #f5b942 (yellow bar)"
else
  bad "theme-sunday missing or statusBar.background != #f5b942 — yellow status bar will NOT show"
fi

# 2. Default theme is wired in the COMPILED workbench (the Beta.2 failure:
#    ThemeSettingDefaults change never made it into the shipped build).
if grep -rqF "Sunday Dark" "$APP/out" 2>/dev/null; then
  ok "compiled workbench references 'Sunday Dark' (default-theme wiring present in build)"
else
  bad "compiled workbench has NO 'Sunday Dark' — fresh installs will open in stock Dark 2026 again"
fi

# 3. Welcome walkthrough rebrand.
if grep -rqF "Get started with Sunday" "$APP/out" 2>/dev/null; then
  ok "walkthrough title rebranded: 'Get started with Sunday'"
else
  bad "walkthrough still says 'Get started with VS Code' in the build"
fi

# 4. Google sign-in extension actually compiled (the Beta.2 root-cause class:
#    core-ci packages but never compiles; fixed for this extension in 58f3f170).
if [ -f "$APP/extensions/sunday-google-auth/out/extension.js" ]; then
  ok "sunday-google-auth compiled (out/extension.js exists) — Google sign-in can activate"
else
  bad "sunday-google-auth/out/extension.js MISSING — Google sign-in dead in this build"
fi

# 5. Bundled sunday-agent carries the 2026-10-11 feature set (login modal,
#    streak panel, @sunday chat participant). Bundle is dist/extension.cjs,
#    staged into the fork by scripts/sync-builtin.sh from the VSIX.
B="$APP/extensions/sunday-agent/dist/extension.cjs"
if [ -f "$B" ]; then
  ok "sunday-agent bundle present (dist/extension.cjs)"
  if has "$B" "sunday.account.showLoginModal"; then
    ok "login modal command in bundle (sunday.account.showLoginModal, ca1c26b4)"
  else bad "login modal command NOT in bundle — centered login popup will not open"; fi
  if has "$B" "sunday.agent"; then
    ok "@sunday chat participant id in bundle (sunday.agent, 51d34549)"
  else bad "@sunday chat participant NOT in bundle — chat will show setup failed again"; fi
  if has "$B" "sunday.streakView"; then
    ok "streak view in bundle (e2be49f6 panel line)"
  else bad "streak view NOT in bundle — streak panel missing"; fi
else
  bad "sunday-agent bundle MISSING at extensions/sunday-agent/dist/extension.cjs — no Sunday features at all"
fi

# 6. User Guide (6941bb7b — the 2026-10-11 user request: users must be able to
#    discover themes/features). Guide code lives in the sunday-agent bundle;
#    the keybinding lives in the bundled extension's package.json.
if [ -f "$B" ]; then
  if has "$B" "sunday.guide.open"; then
    ok "User Guide command in bundle (sunday.guide.open, 6941bb7b)"
  else bad "User Guide command NOT in bundle — Ctrl+Alt+G guide will not open"; fi
  if has "$B" "sunday.guideSeen.v1"; then
    ok "guide auto-open-once flag in bundle (sunday.guideSeen.v1) — first-run discovery wired"
  else bad "guideSeen flag NOT in bundle — guide will not auto-open on first run"; fi
fi
PJ="$APP/extensions/sunday-agent/package.json"
if [ -f "$PJ" ] && has "$PJ" '"key": "ctrl+alt+g"'; then
  ok "guide keybinding in bundled package.json (ctrl+alt+g / cmd+alt+g)"
else
  bad "guide keybinding MISSING from bundled package.json — Ctrl+Alt+G will not trigger the guide"
fi

# 7. Sanity: it is Sunday, not a stock VS Code leak.
if has "$APP/product.json" '"nameShort": "Sunday"' || grep -q '"applicationName": "sunday"' "$APP/product.json" 2>/dev/null; then
  ok "product.json is Sunday-branded"
else
  bad "product.json does not look Sunday-branded"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL CHECKS PASS — artifact is release-eligible (install test still required)."
else
  echo "RELEASE BLOCKED — fix the FAIL lines above and rebuild. Do not ship on source-level verification alone."
fi
exit $FAIL
