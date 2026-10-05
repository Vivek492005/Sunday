#!/usr/bin/env bash
#
# sync-builtin.sh — stage the prebuilt sunday-agent extension as a VS Code
# built-in extension (fork-build §6.3).
#
# A CI step calls this once after the product build; it produces the exact
# layout the extension runtime expects and the fork's extension packager
# picks up automatically (vscode/build/lib/extensions.ts globs
# `extensions/*/package.json` — no registration step needed).
#
# Usage — pick exactly ONE source mode:
#
#   A. From a built VSIX (primary CI path: run scripts/package-vsix.mjs first):
#        scripts/sync-builtin.sh --vsix <path/to/sunday-agent-0.1.0.vsix> [--dest DIR]
#
#   B. From an already-unpacked VSIX tree (skips the unzip step):
#        scripts/sync-builtin.sh --unpacked <dir> [--dest DIR]
#
#   C. From product build outputs (no vsce needed; replicates what
#      scripts/package-vsix.mjs stages — same esbuild sidecar bundles):
#        scripts/sync-builtin.sh --repo <product-root> \
#            --sundayd-dist <product-root>/packages/sundayd/dist \
#            --browserd-dist <product-root>/packages/browserd/dist \
#            [--dest DIR]
#
# Every flag has an env-var equivalent (flag wins):
#   --vsix PATH          SUNDAY_VSIX
#   --unpacked DIR       SUNDAY_VSIX_DIR
#   --repo ROOT          SUNDAY_REPO
#   --sundayd-dist DIR   SUNDAY_SUNDAYD_DIST   (built @sunday/sundayd dist)
#   --browserd-dist DIR  SUNDAY_BROWSERD_DIST  (built @sunday/browserd dist)
#   --fork DIR           SUNDAY_FORK           (default: <repo>/../vscode)
#   --dest DIR           SUNDAY_DEST           (default: <fork>/extensions/sunday-agent)
#
# Resulting layout under the destination (mirrors the VSIX byte-for-byte in
# the parts that matter):
#   package.json              extension manifest (workspace/dev deps stripped)
#   dist/extension.cjs        extension host bundle (package.json "main")
#   ui-chat/dist/             chat webview (index.html)
#   ui-manager/dist/          manager webview (index.html)
#   sundayd/sundayd.mjs       sundayd sidecar (esbuild ESM bundle)
#   sundayd/browserd.mjs      browserd child  (esbuild ESM bundle, playwright external)
#
# Runtime discovery (packages/ext-agent/src/sidecar.ts,
# packages/sundayd/src/browserd.ts, chatView.ts, managerView.ts):
#   sundayd   -> <ext>/sundayd/sundayd.mjs | <ext>/sundayd/dist/cli.js | <ext>/sundayd/cli.js
#   browserd  -> <ext>/sundayd/browserd.mjs | <ext>/browserd/dist/cli.js
#   webviews  -> <ext>/ui-chat/dist | <ext>/ui-manager/dist
#
# Guarantees: fail-fast on any missing input (names it, exits non-zero);
# stages into a temp dir, verifies the full layout, then swaps it into place
# atomically — the destination is never left half-copied.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "sync-builtin: error: $*" >&2
  exit 1
}

VSIX="${SUNDAY_VSIX:-}"
UNPACKED="${SUNDAY_VSIX_DIR:-}"
REPO="${SUNDAY_REPO:-}"
SUNDAYD_DIST="${SUNDAY_SUNDAYD_DIST:-}"
BROWSERD_DIST="${SUNDAY_BROWSERD_DIST:-}"
FORK="${SUNDAY_FORK:-$SCRIPT_DIR/../vscode}"
DEST="${SUNDAY_DEST:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vsix)          VSIX="$2"; shift 2 ;;
    --unpacked)      UNPACKED="$2"; shift 2 ;;
    --repo)          REPO="$2"; shift 2 ;;
    --sundayd-dist)  SUNDAYD_DIST="$2"; shift 2 ;;
    --browserd-dist) BROWSERD_DIST="$2"; shift 2 ;;
    --fork)          FORK="$2"; shift 2 ;;
    --dest)          DEST="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -z "$DEST" ]] && DEST="$FORK/extensions/sunday-agent"

# ---- exactly one source mode ------------------------------------------------
modes=0
[[ -n "$VSIX" ]] && modes=$((modes + 1))
[[ -n "$UNPACKED" ]] && modes=$((modes + 1))
if [[ -n "$REPO$SUNDAYD_DIST$BROWSERD_DIST" ]]; then
  modes=$((modes + 1))
  [[ -n "$REPO" ]]         || die "mode C: --repo <product-root> is required alongside --sundayd-dist/--browserd-dist"
  [[ -n "$SUNDAYD_DIST" ]] || die "mode C: --sundayd-dist DIR is required (built @sunday/sundayd dist, e.g. <repo>/packages/sundayd/dist)"
  [[ -n "$BROWSERD_DIST" ]] || die "mode C: --browserd-dist DIR is required (built @sunday/browserd dist, e.g. <repo>/packages/browserd/dist)"
fi
if (( modes == 0 )); then
  die "no source given: pass exactly one of --vsix PATH, --unpacked DIR, or --repo ROOT with --sundayd-dist DIR and --browserd-dist DIR (see --help)"
fi
if (( modes > 1 )); then
  die "pass exactly one source mode: --vsix, --unpacked, or --repo (+ dists) — not several"
fi

# ---- staging area + atomic-swap safety net ----------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/sunday-builtin.XXXXXX")"
LAYOUT="$STAGE/layout"
BACKUP="" # previous $DEST, restored if the swap fails
cleanup() {
  local rc=$?
  if (( rc != 0 )) && [[ -n "$BACKUP" && -e "$BACKUP" && ! -e "$DEST" ]]; then
    mv "$BACKUP" "$DEST" 2>/dev/null || true
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
mkdir -p "$LAYOUT"

need_file() { # need_file <path> <description>
  [[ -f "$1" ]] || die "missing $2: $1"
}
need_dir() { # need_dir <path> <description>
  [[ -d "$1" ]] || die "missing $2: $1 (directory not found)"
}

# ---- verify the staged layout against every runtime discovery path ----------
verify_layout() { # verify_layout <dir>
  local dir="$1" main name
  need_file "$dir/package.json" "extension manifest"
  name="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"")' "$dir/package.json" 2>/dev/null)" \
    || die "staged layout invalid: $dir/package.json is not valid JSON"
  [[ -n "$name" ]] || die "staged layout invalid: $dir/package.json has no \"name\""
  main="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).main||"./dist/extension.cjs")' "$dir/package.json")"
  # sidecar.ts discovery: <ext>/sundayd/{sundayd.mjs,dist/cli.js,cli.js}
  # SUNDAY-CI: list dir contents on failure for debugging (Windows cp issues)
  if [[ ! -f "$dir/sundayd/sundayd.mjs" && ! -f "$dir/sundayd/dist/cli.js" && ! -f "$dir/sundayd/cli.js" ]]; then
    echo "sync-builtin: DEBUG: sundayd not found in $dir" >&2
    ls -la "$dir/" >&2 || true
    ls -la "$dir/sundayd/" >&2 || true
    die "staged layout invalid: no sundayd entrypoint (need sundayd/sundayd.mjs — see sidecar.ts)"
  fi
  # browserd.ts discovery: <sundaydDir>/browserd.mjs or <ext>/browserd/dist/cli.js
  [[ -f "$dir/sundayd/browserd.mjs" || -f "$dir/browserd/dist/cli.js" ]] \
    || die "staged layout invalid: no browserd entrypoint (need sundayd/browserd.mjs — see browserd.ts)"
  # extension host entry (package.json "main")
  [[ -f "$dir/$main" ]] \
    || die "staged layout invalid: extension entry missing: $main (package.json \"main\")"
  # webview discovery (chatView.ts / managerView.ts): <ext>/{ui-chat,ui-manager}/dist
  need_file "$dir/ui-chat/dist/index.html" "chat webview bundle"
  need_file "$dir/ui-manager/dist/index.html" "manager webview bundle"
  echo "sync-builtin: layout OK ($name): package.json, $main, ui-chat/dist, ui-manager/dist, sundayd/{sundayd,browserd}.mjs"
}

# ---- mode A/B: from a VSIX or its unpacked tree ------------------------------
stage_from_vsix_tree() { # stage_from_vsix_tree <src-dir>
  local src="$1"
  need_dir "$src" "unpacked VSIX tree"
  need_file "$src/package.json" "extension manifest in unpacked VSIX tree"
  cp -r "$src/." "$LAYOUT/"
}

if [[ -n "$VSIX" ]]; then
  need_file "$VSIX" "built sunday-agent VSIX (--vsix)"
  command -v unzip >/dev/null 2>&1 \
    || die "--vsix needs 'unzip' on PATH to unpack $VSIX (or pass --unpacked DIR instead)"
  unzip -q "$VSIX" 'extension/*' -d "$STAGE/unzip" \
    || die "--vsix: failed to unpack $VSIX (not a zip?)"
  # vsce-built VSIX files live under extension/ inside the archive
  [[ -f "$STAGE/unzip/extension/package.json" ]] \
    || die "--vsix: $VSIX contains no extension/package.json — is this a vsce-built sunday-agent VSIX?"
  echo "sync-builtin: unpacked $VSIX"
  stage_from_vsix_tree "$STAGE/unzip/extension"
elif [[ -n "$UNPACKED" ]]; then
  stage_from_vsix_tree "$UNPACKED"
fi

# ---- mode C: stage directly from product build outputs ------------------------
if [[ -n "$REPO" ]]; then
  need_dir "$REPO" "product repo (--repo)"
  need_dir "$SUNDAYD_DIST" "built @sunday/sundayd dist (--sundayd-dist)"
  need_dir "$BROWSERD_DIST" "built @sunday/browserd dist (--browserd-dist)"
  need_file "$REPO/packages/ext-agent/dist/extension.cjs" "extension bundle (run pnpm -r build first)"
  need_file "$REPO/packages/ui-chat/dist/index.html" "ui-chat build"
  need_file "$REPO/packages/ui-manager/dist/index.html" "ui-manager build"
  need_file "$REPO/packages/ext-agent/package.json" "ext-agent manifest"
  command -v node >/dev/null 2>&1 || die "mode C needs 'node' on PATH (sidecar bundling + manifest rewrite)"
  ESBUILD_MAIN="$REPO/packages/ext-agent/node_modules/esbuild/lib/main.js"
  need_file "$ESBUILD_MAIN" "esbuild module (run pnpm install first)"

  # Sanitize the manifest exactly like scripts/package-vsix.mjs: the staged
  # extension is fully bundled, so workspace deps and devDeps must go, or the
  # fork build's dependency pass will try to resolve them.
  node -e '
    const fs = require("fs");
    const out = process.argv[2];
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [k, v] of Object.entries(m.dependencies ?? {}))
      if (String(v).startsWith("workspace:")) delete m.dependencies[k];
    delete m.devDependencies;
    fs.writeFileSync(out, JSON.stringify(m, null, 2));
  ' "$REPO/packages/ext-agent/package.json" "$LAYOUT/package.json"

  mkdir -p "$LAYOUT/dist" "$LAYOUT/sundayd" "$LAYOUT/ui-chat" "$LAYOUT/ui-manager"
  cp "$REPO/packages/ext-agent/dist/extension.cjs" "$LAYOUT/dist/extension.cjs"
  cp -r "$REPO/packages/ui-chat/dist" "$LAYOUT/ui-chat/dist"
  cp -r "$REPO/packages/ui-manager/dist" "$LAYOUT/ui-manager/dist"
  [[ -f "$REPO/packages/ext-agent/README.md" ]] && cp "$REPO/packages/ext-agent/README.md" "$LAYOUT/README.md"

  # Bundle the sidecars with esbuild — same entries/options as
  # scripts/package-vsix.mjs step 1 (browserd keeps playwright external;
  # it is a lazy optional dep resolved at runtime).
  #
  # The createRequire banner is load-bearing: esbuild leaves require() calls
  # inside bundled CommonJS deps (e.g. cross-spawn's require('child_process'))
  # as runtime __require() calls, which throw "Dynamic require … is not
  # supported" in pure ESM output. Defining require via createRequire makes
  # those calls hit the real CJS loader (node builtins resolve; nothing else
  # changes because every npm dep is still bundled statically).
  # (Aliased import: sundayd's own sources already import createRequire.)
  need_file "$REPO/packages/sundayd/src/cli.ts" "sundayd bundle entry"
  need_file "$REPO/packages/browserd/src/cli.ts" "browserd bundle entry"
  echo "sync-builtin: bundling sidecars with esbuild"
  SUNDAY_ESBUILD_MAIN="$ESBUILD_MAIN" \
  SUNDAY_ENTRY_SUNDAYD="$REPO/packages/sundayd/src/cli.ts" \
  SUNDAY_ENTRY_BROWSERD="$REPO/packages/browserd/src/cli.ts" \
  SUNDAY_OUT_SUNDAYD="$LAYOUT/sundayd/sundayd.mjs" \
  SUNDAY_OUT_BROWSERD="$LAYOUT/sundayd/browserd.mjs" \
  node --input-type=module <<'EOF'
import { pathToFileURL } from 'node:url';
const { buildSync } = await import(pathToFileURL(process.env.SUNDAY_ESBUILD_MAIN).href);
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __sundayCreateRequire } from 'node:module'; const require = __sundayCreateRequire(import.meta.url);" },
};
buildSync({ ...common, entryPoints: [process.env.SUNDAY_ENTRY_SUNDAYD], outfile: process.env.SUNDAY_OUT_SUNDAYD });
buildSync({ ...common, entryPoints: [process.env.SUNDAY_ENTRY_BROWSERD], outfile: process.env.SUNDAY_OUT_BROWSERD, external: ['playwright'] });
console.log('sync-builtin: sidecars bundled');
EOF
fi

# ---- verify, then atomically swap into place ---------------------------------
verify_layout "$LAYOUT"

PARENT="$(dirname "$DEST")"
mkdir -p "$PARENT"
if [[ -e "$DEST" ]]; then
  BACKUP="$STAGE/backup"
  mv "$DEST" "$BACKUP"
fi
mv "$LAYOUT" "$DEST"
[[ -n "$BACKUP" ]] && rm -rf "$BACKUP"

echo "sync-builtin: staged -> $DEST"
