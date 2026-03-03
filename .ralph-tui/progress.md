# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

- **Embedded assets pattern**: Hooks are bundled as string constants in `src/hooks/embedded.ts` for distribution compatibility (tsc, Bun compile, npm). Templates will likely need similar treatment for US-003 (see `EMBEDDED_HOOKS` in that file).
- **Agent presets**: `src/commands/init.ts` defines `AVAILABLE_AGENTS` with 7 presets (sre, frontend, backend, qa, security→appsec, devops, pm). The `agent` field maps to `.claude/agents/<agent>.md`.
- **Env vars for agents**: `polling.ts:300-302` sets `HIVE_CHAT_FILE`, `HIVE_AGENT_NAME`, `HIVE_AGENT_ROLE` in the spawned claude process environment.
- **Chat message format**: `[ROLE] TYPE <ISO8601_TIMESTAMP>: message` — defined in `buildPrompt()` at `polling.ts:323-338`.

---

## 2026-03-03 - agenthive-9b5.1
- Created `templates/agents/` directory with 7 template files: sre.md, frontend.md, backend.md, qa.md, appsec.md, devops.md, pm.md
- Each template has 5 standard sections: Identity, Responsibilities, Workflow, Conventions, Communication Protocol
- All templates reference `$HIVE_CHAT_FILE`, `$HIVE_AGENT_NAME`, `$HIVE_AGENT_ROLE` and include the `[ROLE] TYPE` chat format
- Templates are 67-68 lines each, generic (no framework-specific details), with HTML comment headers
- **Learnings:**
  - Template filenames must match the `agent` field in presets (e.g., security preset uses `agent: 'appsec'` so template is `appsec.md`)
  - The `buildPrompt()` in polling.ts already provides DONE/BLOCKER format — templates add richer protocol docs (STATUS, REQUEST, QUESTION, etc.)
  - This is a content-only change (markdown files) — no TypeScript changes needed for US-001
---

## 2026-03-03 - agenthive-9b5.2
- Verified all 7 bundled templates (sre, frontend, backend, qa, appsec, devops, pm) already meet US-002 acceptance criteria
- Each template is 67-69 lines (within the 40-80 requirement), with role-specific focus areas and out-of-scope boundaries
- Role-specific content verified: SRE→infra/reliability, Frontend→UI/a11y, Backend→API/services, QA→tests only, Security→auth/OWASP, DevOps→CI/CD/Docker, PM→coordination/specs
- All templates include full chat protocol (DONE, BLOCKER, REQUEST, STATUS, QUESTION) with role-appropriate examples
- No code changes needed — templates were fully authored in US-001
- **Learnings:**
  - US-001 and US-002 overlap significantly — US-001 created the format AND the content, so US-002 was verification-only
  - Quality checks: typecheck, 113 tests (5 suites), build all pass
---

