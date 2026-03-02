#!/usr/bin/env bash
# ── AgentHive — Standalone Binary Builder ─────────────────────────────
#
# Builds a single self-contained binary via Bun compile.
# The binary includes the Node.js runtime — no dependencies needed.
#
# Usage:
#   ./scripts/build-binary.sh               # defaults to current platform
#   ./scripts/build-binary.sh linux-x64     # cross-compile target
#
# Output:
#   bin/hive       (or bin/hive.exe on Windows)
#
# Requires: bun >= 1.0
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_ROOT/bin"
ENTRY="$PROJECT_ROOT/src/index.ts"
TARGET="${1:-}"

# ── Find bun ──────────────────────────────────────────────────────────

BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

if [ ! -x "$BUN" ]; then
  echo "Error: bun not found. Install it: https://bun.sh/docs/installation"
  exit 1
fi

echo "Using bun: $BUN ($($BUN --version))"
echo ""

# ── Build ─────────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"

BUILD_ARGS=(
  build
  "$ENTRY"
  --compile
  --outfile "$BIN_DIR/hive"
)

if [ -n "$TARGET" ]; then
  BUILD_ARGS+=(--target "bun-$TARGET")
  echo "Cross-compiling for: $TARGET"
else
  echo "Building for current platform..."
fi

"$BUN" "${BUILD_ARGS[@]}"

# ── Result ────────────────────────────────────────────────────────────

echo ""
if [ -f "$BIN_DIR/hive" ]; then
  SIZE=$(du -h "$BIN_DIR/hive" | cut -f1)
  echo "✓ Built: $BIN_DIR/hive ($SIZE)"
  echo "  Test:  $BIN_DIR/hive --version"
  echo "  Install: cp $BIN_DIR/hive /usr/local/bin/hive"
else
  echo "Error: binary not found at $BIN_DIR/hive"
  exit 1
fi
