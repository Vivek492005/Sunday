#!/usr/bin/env bash
# Copy the prebuilt sunday-agent extension into the fork's built-in extensions dir (§6.3).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORK="${1:-$ROOT/..}"   # path to the fork checkout; default assumes sunday/ lives inside it
SRC="$ROOT/packages/ext-agent"
DEST="$FORK/extensions/sunday-agent"
mkdir -p "$DEST"
cp -r "$SRC/dist" "$SRC/package.json" "$DEST/"
echo "synced -> $DEST"
