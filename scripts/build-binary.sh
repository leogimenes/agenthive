#!/usr/bin/env bash
# ── AgentHive — Standalone Binary Builder ─────────────────────────────
#
# Thin wrapper that delegates to the TypeScript build script.
# The TS script uses Bun.build() with plugins to stub optional deps
# that can't be resolved in a compiled binary (e.g. react-devtools-core).
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

BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

if [ ! -x "$BUN" ]; then
  echo "Error: bun not found. Install it: https://bun.sh/docs/installation"
  exit 1
fi

"$BUN" "$SCRIPT_DIR/build-binary.ts" "$@"
