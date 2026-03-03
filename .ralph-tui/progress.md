# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---

## 2026-03-03 - agenthive-2h2.1
- Fixed stale `hive add --force` reference in `src/core/worktree.ts:25`
- Replaced with actionable message: tells user to run `git worktree remove <path>` and retry, or delete the directory manually
- Files changed: `src/core/worktree.ts`
- **Learnings:**
  - `init.ts:81` was already fixed in a prior iteration (references `git worktree add` correctly)
  - The `hive add` command does not exist yet (planned as US-010); when it's implemented, both `init.ts` and `worktree.ts` should be updated to reference it
---
