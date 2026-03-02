# AgentHive — Bug Fixes

> Bugs discovered during codebase review. Ordered by tier (severity).
> Prefix convention: `BUG-` (all bugs are backend/core — assign to whoever owns the module).

---

## BUG-01: Hooks are not registered with Claude Code (Tier 1)

**File:** `src/commands/init.ts:126`
**Also:** `src/commands/init.ts:143-153` (worktree creation loop)
**Problem:** `hive init` copies hook scripts to `.hive/hooks/` but never creates `.claude/settings.json` in the agent worktrees. Claude Code discovers hooks via `.claude/settings.json` in the project root — without it, the destructive-guard and check-chat hooks are dead on arrival. Agents run with **zero safety hooks** despite `hive init` printing "Installing hooks... ✓".
**Fix:**
1. After creating each worktree (line 143-153), generate `.claude/settings.json` inside the worktree directory (e.g., `.hive/worktrees/sre/.claude/settings.json`).
2. The settings file must reference the hooks by absolute path or relative path from the worktree root:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "type": "command", "command": "/absolute/path/.hive/hooks/destructive-guard.sh" }
       ],
       "UserPromptSubmit": [
         { "type": "command", "command": "/absolute/path/.hive/hooks/check-chat.sh" }
       ],
       "PostToolUse": [
         { "type": "command", "command": "/absolute/path/.hive/hooks/check-chat.sh" }
       ]
     }
   }
   ```
3. Resolve the hook paths from `config.hooks.safety` and `config.hooks.coordination` — don't hardcode file names. Use the same hook names from config and append `.sh` to find the actual file.
4. Also handle `config.hooks.custom` — user-defined hooks should be resolved relative to the hive root.
5. Create a helper `generateClaudeSettings(worktreePath: string, hivePath: string, hooks: HooksConfig)` in a new file or in `init.ts`.
6. Decision needed: symlink to a shared `.claude/settings.json` (simpler, but all agents get same hooks) vs per-worktree copies (more flexible). Symlink is recommended for v1.

---

## BUG-02: Hook shell scripts not shipped in tsc/npm builds (Tier 1)

**File:** `src/commands/init.ts:244`
**Problem:** `copyHooks()` resolves hook source from `join(__dirname, '..', 'hooks')`. When compiled with `tsc`, `__dirname` = `dist/commands/`, so it looks for `dist/hooks/`. But `tsc` only compiles `.ts` files — it does not copy `.sh` files to `dist/`. The `existsSync` check on line 253 silently returns false, so `hive init` via `npm install -g` installs **zero hooks** without any error or warning.
**Fix:**
1. Add a `postbuild` script to `package.json` that copies `src/hooks/*.sh` to `dist/hooks/`:
   ```json
   "postbuild": "mkdir -p dist/hooks && cp src/hooks/*.sh dist/hooks/"
   ```
2. Alternatively, embed the hook scripts as string constants in a TypeScript file (`src/hooks/index.ts`) and write them via `writeFileSync` instead of `copyFileSync`. This makes them survive any bundling method (tsc, esbuild, Bun).
3. If keeping the file-copy approach: add a warning in `copyHooks()` when no hook files are found at the resolved source path, so the failure isn't silent:
   ```typescript
   if (!existsSync(srcPath)) {
     console.warn(chalk.yellow(`  Warning: hook source not found: ${srcPath}`));
   }
   ```
4. Test both `npm run build && node dist/index.js init` and `npm run build:binary && bin/hive init` to verify hooks arrive.

---

## BUG-03: Shell injection in tmux commands (Tier 1)

**File:** `src/commands/launch.ts:124,157,162,187,236`
**Also:** `src/commands/kill.ts:41,76,104`
**Problem:** All tmux invocations use `execSync` with raw string interpolation. The `sessionName` comes from `config.session` (user-editable YAML), and `agent.name` comes from agent keys. A config with `session: "foo;rm -rf /"` or agent names with shell metacharacters would execute arbitrary commands. While low-risk in practice (users control their own config), this is a command injection vulnerability in a tool that runs with full filesystem access.
**Fix:**
1. Replace all `execSync(\`tmux ...\`)` calls with `execFileSync('tmux', [...args])` which bypasses the shell entirely:
   ```typescript
   // Before (launch.ts:157)
   execSync(`tmux new-session -d -s ${sessionName} -n ${agent.name} '${loopCmd}'`);

   // After
   execFileSync('tmux', ['new-session', '-d', '-s', sessionName, '-n', agent.name, loopCmd]);
   ```
2. Apply to all 7 call sites across `launch.ts` and `kill.ts`:
   - `launch.ts:124` — `tmux kill-session -t`
   - `launch.ts:157` — `tmux new-session -d -s`
   - `launch.ts:162-163` — `tmux new-window -t`
   - `launch.ts:187` — `tmux attach -t` (this one needs `stdio: 'inherit'`, use `spawnSync`)
   - `launch.ts:236` — `tmux has-session -t`
   - `kill.ts:41` — `tmux kill-session -t`
   - `kill.ts:76` — `tmux kill-window -t`
   - `kill.ts:104` — `tmux has-session -t`
3. Also fix `buildLoopCommand()` (`launch.ts:243-258`) — it builds a shell string with unquoted paths. If `hiveBin` or `hiveRoot` contain spaces, the command breaks. Use `execFileSync` args array in the tmux spawn instead of passing a quoted shell string.
4. Extract a `tmux(args: string[]): void` helper to reduce duplication.

---

## BUG-04: `hive add` referenced in error message but command doesn't exist (Tier 2)

**File:** `src/commands/init.ts:82`
**Problem:** When `.hive/` already exists, `init.ts` prints: `"Error: .hive/ already exists. Use \`hive add\` to add agents."` But there is no `hive add` command registered in `src/index.ts` or implemented anywhere. This sends users to a dead end. Cross-ref: FEAT-12 in TASKS-FEATURES.md for the full `hive add` / `hive remove` implementation.
**Fix:**
1. Change the error message to be honest about the current state:
   ```typescript
   'Error: .hive/ already exists. Edit .hive/config.yaml to add agents, then create worktrees manually with `git worktree add`.'
   ```
2. Alternatively, add a minimal `hive add <agent>` stub that prints "Not yet implemented" with a tracking issue URL. This is less confusing than a nonexistent command.
3. The full implementation is tracked in FEAT-12 (TASKS-FEATURES.md).

---

## BUG-05: `--raw` flag on `hive config` declared but not handled (Tier 3)

**File:** `src/commands/config.ts:16-17`
**Also:** `src/commands/config.ts:28-30` (opts type), `src/commands/config.ts:48-86` (execution path)
**Problem:** The `--raw` option is declared on line 16 and accepted in the opts type on line 30, but `runConfig()` never checks `opts.raw`. The function goes straight to `opts.agents` (line 48), then falls through to the full resolved view (line 88). Users who pass `--raw` see the resolved config instead of the raw YAML, with no indication their flag was ignored.
**Fix:**
1. Add a `--raw` code path before the agents check (around line 47):
   ```typescript
   if (opts.raw) {
     const rawYaml = readFileSync(join(hivePath, 'config.yaml'), 'utf-8');
     if (opts.json) {
       const parsed = parseYaml(rawYaml);
       console.log(JSON.stringify(parsed, null, 2));
     } else {
       console.log(rawYaml);
     }
     return;
   }
   ```
2. Import `readFileSync` from `node:fs` (not currently imported in config.ts command).
3. `--raw` + `--agents` should be mutually exclusive — print a warning if both are passed.

---

## BUG-06: `model` field missing from generated config.yaml (Tier 3)

**File:** `src/commands/init.ts:206-211`
**Problem:** `buildConfig()` creates the `DefaultsConfig` object with `poll`, `budget`, `daily_max`, and `skip_permissions` — but omits `model`. The SPEC template shows `model: sonnet` as a default, and `core/config.ts:40` defines `DEFAULT_DEFAULTS.model = 'sonnet'`. Without it in the generated config, `hive config` shows `model: undefined` for the defaults section, confusing users about what model their agents will use. The runtime works (resolveAgent falls back to 'sonnet' on line 198 of core/config.ts), but the config file is misleading.
**Fix:**
1. Add `model: 'sonnet'` to the defaults object in `buildConfig()`:
   ```typescript
   const defaults: DefaultsConfig = {
     poll: 60,
     budget: 2.0,
     daily_max: 20.0,
     model: 'sonnet',
     skip_permissions: true,
   };
   ```
2. This is a one-line fix. The `DefaultsConfig` interface already supports `model?: string`.

---

## Implementation Order

1. **BUG-01** + **BUG-02** — ship together (hook wiring + hook distribution). Without these, the safety system is non-functional.
2. **BUG-03** — shell injection. Quick fix, high severity.
3. **BUG-04** — misleading error message. Quick fix.
4. **BUG-05** + **BUG-06** — polish. Low urgency.
