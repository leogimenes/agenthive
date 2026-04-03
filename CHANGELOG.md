# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-03

### Added
- TUI epic selection and dispatch interface with progress visualization (FE-02)
- TUI epic tree view panel with progress bars
- TUI transcript viewer panel with live-tailing and agent switching
- TUI chat message viewer panel with filtering
- Epic hierarchy model: `TaskType`, `getChildren`, `getAncestors`, `validateParentType` (BE-21)
- Computed parent status from children (BE-22)
- Session persistence and transcript rotation (BE-11)
- Real cost tracking using claude CLI JSON output
- `hive merge` command with rebase workflow
- Delivery config section with validation and defaults (BE-23)
- `--type` flag for `plan add`, board groups under epic headers, tree multi-level hierarchy (BE-24)
- `hive merge --epic` command: squash-merges agent commits matched by epic task IDs (BE-25)
- `hive merge --pr`: rebase, push, and create GitHub PR via `gh pr create` (BE-26)
- Auto-merge/pull-request/manual delivery strategies triggered on epic completion (BE-27)
- Epic-level progress tracking with chat notifications and cost aggregation (BE-28)
- `hive plan import` with nested YAML epics > stories > tasks hierarchy (BE-29)
- `hive release` command: auto-changelog, binary build, GitHub release with attachment (BE-32)
- GitHub Actions CI workflow
- Comprehensive test suites: delivery pipeline, epic completion, hierarchy, merge, security, polling

### Fixed
- CLAUDECODE environment variable detection in agent spawning
- Worktree sync recovery for interrupted sessions

## [0.1.0] - 2026-02-01

Initial release.

- Multi-agent orchestration via `hive` CLI
- Chat-based coordination between agents
- Budget tracking and daily spend limits
- Plan management with task board
- Git worktree isolation per agent
- TUI dashboard with agent status
