# AgentHive — Agent Definition Templates

> Bundled agent prompt templates that users can install during `hive init` or add later.
> These are `.claude/agents/<name>.md` files — the prompt definitions that Claude Code loads when invoked with `--agent <name>`.
> Prefix convention: `TMPL-`.
>
> **Dependency:** None. Templates are independent of bug fixes and feature work.

---

## TMPL-01: Design the agent template format and directory structure (Tier 2)

**File:** new `templates/agents/` directory
**Also:** `src/commands/init.ts` (integration point)
**Problem:** Users must write agent prompt files from scratch. There's no guidance on what a good agent definition looks like, what instructions to include for chat protocol compliance, or how to structure the system prompt for effective multi-agent behavior. The SPEC (line 260) explicitly listed this as out of scope for v0.1, but it's now the top friction point after init.
**Fix:**
1. Create `templates/agents/` directory alongside the existing `templates/config.yaml`.
2. Define the standard template structure. Each template is a Markdown file:
   ```markdown
   # Role: <Title>

   ## Identity
   <Who you are, what you own, your expertise>

   ## Responsibilities
   <What tasks you accept, what you refuse>

   ## Workflow
   1. Read the coordination chat for context
   2. Implement the requested change
   3. Run <build gate> and <test gate>
   4. Commit with conventional commit format
   5. Post DONE or BLOCKER to the chat

   ## Conventions
   <Project-specific coding standards, file naming, etc.>

   ## Communication Protocol
   - Write to chat file at `$HIVE_CHAT_FILE`
   - Format: `[ROLE] TYPE: message`
   - Always reference commit hashes and file paths
   - Keep messages to 1-2 lines
   ```
3. Templates should use `$HIVE_CHAT_FILE`, `$HIVE_AGENT_NAME`, and `$HIVE_AGENT_ROLE` env vars (already set by `polling.ts:208-213`) so they work generically across projects.
4. Templates must NOT contain project-specific details (framework names, file paths, etc.). They should be generic enough to work on any repository.

---

## TMPL-02: Write bundled templates for standard roles (Tier 2)

**File:** `templates/agents/sre.md`, `templates/agents/frontend.md`, `templates/agents/backend.md`, `templates/agents/qa.md`, `templates/agents/security.md`, `templates/agents/devops.md`, `templates/agents/pm.md`
**Problem:** The 7 built-in agent presets in `init.ts:24-32` (sre, frontend, backend, qa, security, devops, pm) have names and descriptions but no prompt templates. Users see "Create agent definitions in `.claude/agents/<name>.md`" in the init output but don't know what to put there.
**Fix:**
1. Write one template per built-in role. Each should be 40-80 lines covering identity, responsibilities, workflow, and communication protocol. Key differentiation per role:

   **sre.md** — Owns infrastructure, reliability, performance, monitoring. Build gates: all tests pass. Focuses on database, caching, observability, error handling. Refuses UI work.

   **frontend.md** — Owns UI components, pages, client-side logic, styling. Build gates: typecheck + lint + unit tests. Focuses on React/Next.js patterns, accessibility, responsive design. Refuses database schema changes.

   **backend.md** — Owns API endpoints, business logic, services, repositories. Build gates: typecheck + unit tests + integration tests. Focuses on clean architecture, validation, error handling. Refuses direct database migrations (defers to SRE).

   **qa.md** — Owns test coverage, test infrastructure, E2E tests. Build gates: all existing tests pass + new tests pass. Focuses on edge cases, regression tests, coverage gaps. Never modifies production code — only test files.

   **security.md** — Owns auth, authorization, input validation, secrets management, vulnerability remediation. Build gates: all tests pass + no new security warnings. Focuses on OWASP patterns, PII handling, rate limiting.

   **devops.md** — Owns CI/CD, Docker, deployment config, environment management. Build gates: config validation + deployment dry-run. Focuses on infrastructure-as-code, build optimization, environment parity.

   **pm.md** — Owns task triage, spec writing, backlog management, cross-agent coordination. Build gates: none (PM doesn't write production code). Focuses on reading codebase, identifying issues, writing task files, dispatching work to other agents.

2. Include the chat protocol instructions in every template — agents must know how to post DONE, BLOCKER, REQUEST, etc. This is currently only in the `buildPrompt()` method of `polling.ts:233-247`, but agents should also have it in their persistent context.
3. Keep templates framework-agnostic. Don't assume React, NestJS, or any specific stack. Use phrases like "follow the project's existing patterns" rather than prescribing specific frameworks.

---

## TMPL-03: Integrate template installation into `hive init` (Tier 2)

**File:** `src/commands/init.ts:143-172` (after worktree creation, before summary)
**Problem:** Even with templates written, `hive init` doesn't install them. Users still have to manually copy files. The init flow should optionally scaffold `.claude/agents/` with the selected templates.
**Fix:**
1. After worktree creation (line 153), add a step to install agent templates.
2. Add a `--templates` flag to `hive init`:
   - `--templates` (no value) — install templates for all selected agents.
   - `--templates=none` — skip template installation (explicit opt-out).
   - Default (no flag): in interactive mode, ask "Install agent prompt templates? (Y/n)". In `--yes` mode, install templates.
3. Create `.claude/agents/` directory in the **project root** (not in worktrees — Claude Code reads agents from the repo root, and worktrees share the git content).
4. For each selected agent, copy `templates/agents/<agent>.md` to `.claude/agents/<agent>.md`. Use the `agent` field from the preset (e.g., security agent has `agent: 'appsec'`, so copy to `.claude/agents/appsec.md`).
5. If `.claude/agents/<name>.md` already exists, skip it with a warning (don't overwrite user customizations).
6. Update the summary output to show which templates were installed.
7. Handle the same `__dirname` resolution issue as BUG-02 — template files must be shipped with compiled builds. Use the same fix (embed as strings or copy in postbuild).

---

## TMPL-04: `hive templates` command — list, preview, and install (Tier 3)

**File:** new `src/commands/templates.ts`
**Also:** `src/index.ts` (register command)
**Problem:** After `hive init`, users may want to add templates for new agents, preview what a template contains, or replace a customized template with the latest bundled version. There's no command for this.
**Fix:**
1. Register `hive templates` command with subcommands:

   **`hive templates list`** — Show all available bundled templates with name, description, and whether they're already installed:
   ```
   NAME        DESCRIPTION                    INSTALLED
   sre         Site Reliability Engineer       ✓ .claude/agents/sre.md
   frontend    Frontend Developer              ✗
   backend     Backend Engineer                ✓ .claude/agents/backend.md (modified)
   qa          Quality Analyst                 ✗
   security    Security Engineer               ✓ .claude/agents/appsec.md
   devops      DevOps Engineer                 ✗
   pm          Product Manager                 ✗
   ```
   Detect "modified" by comparing file hash of installed template vs bundled template.

   **`hive templates show <name>`** — Print the template content to stdout (with syntax highlighting if possible). Useful for previewing before installing or for piping into a file.

   **`hive templates install <name...>`** — Copy specified templates to `.claude/agents/`. Skip if exists (use `--force` to overwrite).

   **`hive templates diff <name>`** — Show the diff between the installed version and the bundled version. Helps users see what they've customized.

2. Support a `--dir <path>` flag to override the output directory (default: `.claude/agents/` relative to hive root).

---

## TMPL-05: Support user-defined template directories (Tier 3)

**File:** `src/commands/templates.ts`, `src/core/config.ts`
**Also:** new `~/.config/agenthive/templates/` convention
**Problem:** Power users working across multiple projects will develop custom agent templates. They need a way to share templates across projects without copying files manually.
**Fix:**
1. Support a global template directory at `~/.config/agenthive/templates/`. Any `.md` files placed here are available via `hive templates list` and `hive templates install`.
2. Template resolution order (later overrides earlier):
   1. Bundled templates (`templates/agents/` in the AgentHive installation)
   2. Global user templates (`~/.config/agenthive/templates/`)
   3. Project-local templates (`.hive/templates/` in the project root)
3. Add `templates.dir` config option in `.hive/config.yaml`:
   ```yaml
   templates:
     dir: .hive/templates  # project-local templates
   ```
4. `hive templates list` should show the source of each template (bundled, global, local).
5. `hive templates install` should prefer project-local → global → bundled when resolving which version to install.

---

## Implementation Order

1. **TMPL-01** — Define the format. Quick decision, unblocks everything.
2. **TMPL-02** — Write the 7 templates. Highest standalone value — even without CLI integration, users can manually copy these.
3. **TMPL-03** — Wire into `hive init`. Makes the first-run experience complete.
4. **TMPL-04** — `hive templates` command. Post-init management.
5. **TMPL-05** — User template directories. Power user polish.
