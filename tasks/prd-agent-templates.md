# Agent Definition Templates

## Overview

Bundled agent prompt templates (`.claude/agents/<name>.md` files) that provide ready-to-use role definitions for Claude Code agents. Templates encode each role's identity, responsibilities, coding conventions, build/test gates, and the chat communication protocol. Users can install them during `hive init` or manage them later via `hive templates`. Templates are generic and framework-agnostic — they work on any repository.

## User Stories

### US-001: Define the template format and directory structure

**As a** contributor writing agent templates
**I want** a documented, consistent template format with standard sections
**So that** all templates follow the same structure and agents receive uniform coordination instructions

#### Acceptance Criteria
- [ ] A `templates/agents/` directory exists alongside the existing `templates/config.yaml`
- [ ] Each template is a Markdown file with standard sections: Identity, Responsibilities, Workflow, Conventions, Communication Protocol
- [ ] The Communication Protocol section includes instructions for posting to `$HIVE_CHAT_FILE` with `[ROLE] TYPE: message` format
- [ ] Templates reference environment variables `$HIVE_CHAT_FILE`, `$HIVE_AGENT_NAME`, and `$HIVE_AGENT_ROLE` (already set by `polling.ts:208-213`)
- [ ] Templates contain no project-specific details (no framework names, no file paths) — only generic role-based instructions
- [ ] A brief README or header comment in each template explains what it is and how to customize it

### US-002: Write bundled templates for all standard roles

**As a** developer setting up AgentHive for the first time
**I want** high-quality prompt templates for common engineering roles
**So that** my agents have effective system prompts without me writing them from scratch

#### Acceptance Criteria
- [ ] Templates exist for all 7 built-in presets: `templates/agents/sre.md`, `frontend.md`, `backend.md`, `qa.md`, `appsec.md`, `devops.md`, `pm.md`
- [ ] Each template is 40-80 lines covering identity, responsibilities, workflow, conventions, and communication protocol
- [ ] SRE template focuses on infrastructure, reliability, performance, and monitoring; refuses UI work
- [ ] Frontend template focuses on UI components, accessibility, and client-side logic; refuses database schema changes
- [ ] Backend template focuses on API endpoints, business logic, and services; defers database migrations to SRE
- [ ] QA template focuses on test coverage, edge cases, and regression tests; never modifies production code
- [ ] Security template focuses on auth, input validation, secrets management, and OWASP patterns
- [ ] DevOps template focuses on CI/CD, Docker, deployment config, and build optimization
- [ ] PM template focuses on task triage, spec writing, backlog management, and cross-agent coordination; does not write production code
- [ ] All templates include the chat protocol instructions (DONE, BLOCKER, REQUEST format) in addition to what `buildPrompt()` in `polling.ts` already provides

### US-003: Install templates during hive init

**As a** developer initializing a new AgentHive project
**I want** `hive init` to optionally scaffold agent prompt files
**So that** I can start agents immediately without manually creating `.claude/agents/*.md` files

#### Acceptance Criteria
- [ ] `hive init --templates` installs templates for all selected agents into `.claude/agents/` in the project root
- [ ] `hive init --templates=none` explicitly skips template installation
- [ ] In interactive mode (no `--yes`), init asks "Install agent prompt templates? (Y/n)"
- [ ] In `--yes` mode, templates are installed by default
- [ ] Template filenames match the `agent` field from presets (e.g., security preset has `agent: 'appsec'` so it copies to `.claude/agents/appsec.md`)
- [ ] If `.claude/agents/<name>.md` already exists, it is skipped with a warning (no overwrites)
- [ ] The init summary output lists which templates were installed
- [ ] Templates survive the same build/distribution issue as hooks (BUG-02) — they must be available in compiled builds

### US-004: Template management command

**As a** developer who wants to add or update agent templates after initialization
**I want** a `hive templates` command to list, preview, and install available templates
**So that** I can manage templates without manually copying files or re-running init

#### Acceptance Criteria
- [ ] `hive templates list` shows all bundled templates with name, description, and installation status (installed, modified, or not installed)
- [ ] "Modified" detection works by comparing file hash of installed template vs bundled template
- [ ] `hive templates show <name>` prints the template content to stdout
- [ ] `hive templates install <name...>` copies specified templates to `.claude/agents/`; skips existing files unless `--force` is passed
- [ ] `hive templates diff <name>` shows the diff between installed and bundled versions
- [ ] `--dir <path>` flag overrides the output directory (default: `.claude/agents/` relative to hive root)

### US-005: User-defined template directories

**As a** power user working across multiple projects
**I want** to maintain custom templates in a global directory that are available in all projects
**So that** I can share refined role definitions without copying files between repos

#### Acceptance Criteria
- [ ] Templates in `~/.config/agenthive/templates/` are discovered by `hive templates list` and `hive templates install`
- [ ] Template resolution order is: project-local (`.hive/templates/`) → global user (`~/.config/agenthive/templates/`) → bundled (`templates/agents/`)
- [ ] `hive templates list` shows the source of each template (bundled, global, or local)
- [ ] A `templates.dir` config option in `.hive/config.yaml` can override the project-local template path
- [ ] Later sources override earlier ones — a project-local template takes precedence over a global one with the same name

## Quality Gates

These commands must pass for every user story:
- `npm run typecheck` - Type checking
- `npm test` - All vitest tests pass
- `npm run build` - TypeScript compilation succeeds
