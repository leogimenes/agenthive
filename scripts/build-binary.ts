#!/usr/bin/env bun
// ── AgentHive — Standalone Binary Builder ─────────────────────────────
//
// Builds a single self-contained binary via Bun compile.
// The binary includes the runtime — no dependencies needed.
//
// Usage:
//   bun scripts/build-binary.ts               # defaults to current platform
//   bun scripts/build-binary.ts linux-x64     # cross-compile target
//
// Output:
//   bin/hive       (or bin/hive.exe on Windows)
//
// Requires: bun >= 1.0
// ──────────────────────────────────────────────────────────────────────

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { BunPlugin } from "bun";

const PROJECT_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const BIN_DIR = join(PROJECT_ROOT, "bin");
const ENTRY = join(PROJECT_ROOT, "src/index.ts");
const TARGET = process.argv[2] ?? undefined;

// Stub out react-devtools-core — it's an optional peer dep of ink that
// only loads when DEV=true. Without this plugin Bun marks it external
// and the compiled binary fails because there's no node_modules at runtime.
const stubDevtools: BunPlugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

mkdirSync(BIN_DIR, { recursive: true });

const outfile = join(BIN_DIR, "hive");

console.log(`Using bun: ${Bun.version}`);
if (TARGET) {
  console.log(`Cross-compiling for: ${TARGET}`);
} else {
  console.log("Building for current platform...");
}
console.log();

const result = await Bun.build({
  entrypoints: [ENTRY],
  compile: TARGET
    ? { outfile, target: `bun-${TARGET}` as any }
    : { outfile },
  plugins: [stubDevtools],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const stat = Bun.file(outfile);
const sizeMB = ((await stat.size) / 1024 / 1024).toFixed(1);
console.log(`✓ Built: ${outfile} (${sizeMB} MB)`);
console.log(`  Test:  ${outfile} --version`);
console.log(`  Install: cp ${outfile} /usr/local/bin/hive`);
