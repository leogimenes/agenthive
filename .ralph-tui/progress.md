# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

- **Claude Code hook registration**: Settings go in `.claude/settings.json` inside each worktree. Format: `{ "hooks": { "PreToolUse": [{ "type": "command", "command": "/abs/path" }] } }`. Hook events: PreToolUse (safety), UserPromptSubmit/PostToolUse (coordination).
- **Embedded shell scripts**: Hook `.sh` files are embedded as string constants in `src/hooks/embedded.ts` and written via `writeFileSync` in `copyHooks()`. This ensures hooks ship with tsc builds, Bun compile binaries, and npm packages. When embedding shell scripts in JS template literals, escape `\s` → `\\s`, `${VAR}` → `\${VAR}`, and trailing `\` → `\\`.
- **Safe tmux execution**: All tmux calls go through `src/core/tmux.ts` helpers (`tmux()`, `tmuxSessionExists()`, `shellQuote()`). Uses `execFileSync('tmux', [...args])` to bypass shell interpretation. For commands that tmux itself runs in a shell (e.g. `new-session` shell-command arg), use `shellQuote()` to protect paths/names with spaces or metacharacters.

---

## 2026-03-02 - agenthive-a29.1
- Implemented hook registration with Claude Code in `hive init`
- After worktree creation, `registerHooksInWorktree()` creates `.claude/settings.json` in each worktree
- Safety hooks (`config.hooks.safety`) → mapped to `PreToolUse` events
- Coordination hooks (`config.hooks.coordination`) → mapped to `UserPromptSubmit` + `PostToolUse` events
- Custom hooks (`config.hooks.custom`) → mapped to `PreToolUse` events
- All hook paths are absolute (resolved via `resolve()`)
- Files changed: `src/commands/init.ts`
- **Learnings:**
  - The `HiveConfig['hooks']` type works well for accessing the hooks sub-type without a separate import
  - The `buildConfig()` function returns the config object before it's written to YAML, so it's available for `registerHooksInWorktree()` without needing to re-parse
  - Worktrees are created at `.hive/worktrees/<name>/`, so `.claude/settings.json` goes at `.hive/worktrees/<name>/.claude/settings.json`
---

## 2026-03-02 - agenthive-a29.2
- Embedded hook shell scripts as string constants in `src/hooks/embedded.ts`
- Updated `copyHooks()` in `src/commands/init.ts` to use `writeFileSync` from embedded content instead of `copyFileSync` from filesystem
- Added warning log when a hook name isn't found in the embedded map (was silently skipping)
- Added `postbuild` script in `package.json` to copy `src/hooks/*.sh` → `dist/hooks/` for inspection
- Removed unused imports (`copyFileSync`, `fileURLToPath`, `dirname`, `__dirname`/`__filename`)
- Files changed: `src/hooks/embedded.ts` (new), `src/commands/init.ts`, `package.json`
- **Learnings:**
  - `tsc` only compiles `.ts` files — non-TS assets like `.sh` need a separate copy step or embedding
  - Embedding shell scripts in JS template literals requires careful escaping: `\s` → `\\s`, `${VAR}` → `\${VAR}`, trailing `\` → `\\`
  - Verified embedded output is byte-identical to originals by diffing node output against source files
---

## 2026-03-02 - agenthive-a29.3
- Prevented shell injection in all tmux commands across `launch.ts` and `kill.ts`
- Created shared `src/core/tmux.ts` module with `tmux()`, `tmuxSessionExists()`, and `shellQuote()` helpers
- Replaced all `execSync` string-interpolated tmux calls with `execFileSync('tmux', [...args])` via the helper
- Updated `buildLoopCommand()` in `launch.ts` to shell-quote paths (hiveBin, hiveRoot, agentName) for safety
- Removed duplicate `tmuxSessionExists()` functions from both `launch.ts` and `kill.ts`
- Removed unused `execSync` import from `kill.ts`
- Files changed: `src/core/tmux.ts` (new), `src/commands/launch.ts`, `src/commands/kill.ts`
- **Learnings:**
  - `execFileSync` bypasses shell interpretation entirely — arguments are passed directly to the executable, preventing injection
  - tmux `new-session`/`new-window` shell-command args are still shell-interpreted by tmux itself, so paths need `shellQuote()` protection
  - The single-quote-with-escaped-embedded-quotes pattern (`'` + replace `'` with `'\''` + `'`) is the standard POSIX shell quoting approach
---

