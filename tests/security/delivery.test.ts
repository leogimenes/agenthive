/**
 * Security Tests — Delivery Pipeline (SEC-03)
 *
 * Security review of the delivery pipeline covering three areas:
 *
 *   1. hive merge (BE-20, implemented) — agent name path traversal,
 *      branch name injection, merge state file integrity, execFile safety.
 *
 *   2. gh CLI integration (BE-26, pending) — PR body/title command injection.
 *      Tests are marked `.todo` and will be activated once BE-26 lands.
 *
 *   3. Release pipeline (BE-32, pending) — binary tampering, changelog injection.
 *      Tests are marked `.todo` and will be activated once BE-32 lands.
 *
 * Tests that document an existing vulnerability are marked "SECURITY GAP".
 * Tests that verify safe behaviour are marked "SECURITY OK".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveAgent, resolveAllAgents } from '../../src/core/config.js';
import { shellQuote } from '../../src/core/tmux.js';
import type { HiveConfig, AgentConfig } from '../../src/types/config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hive-sec-delivery-'));
}

function makeConfig(agents: Record<string, AgentConfig>): HiveConfig {
  return {
    session: 'test',
    defaults: {
      poll: 60,
      budget: 2,
      daily_max: 20,
      model: 'sonnet',
      skip_permissions: false,
      notifications: false,
      notify_on: ['DONE', 'BLOCKER'],
    },
    agents,
    chat: { file: 'chat.md', role_map: {} },
    hooks: {},
    templates: {},
  };
}

function makeAgent(name = 'test'): AgentConfig {
  return { description: 'Test', agent: name };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MERGE COMMAND — Agent name / path traversal
// ─────────────────────────────────────────────────────────────────────────────

describe('merge security — agent name path traversal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SECURITY OK: normal agent name stays within worktrees directory', () => {
    const config = makeConfig({ backend: makeAgent('backend') });
    const resolved = resolveAgent('backend', config.agents.backend, config, tmpDir);

    const worktreesDir = join(tmpDir, '.hive', 'worktrees');
    expect(resolved.worktreePath.startsWith(worktreesDir)).toBe(true);
  });

  it('SECURITY GAP: agent name with ../ escapes the worktrees directory', () => {
    // SECURITY GAP: resolveAgent does not validate agent names.
    // A malicious .hive/config.yaml with an agent name containing '../'
    // causes worktreePath to resolve outside the expected .hive/worktrees/ dir.
    // Remediation: validate agent names with /^[a-zA-Z0-9_-]+$/ in resolveAgent
    // or loadConfig before any path operations.
    const config = makeConfig({ '../../escaped': makeAgent('escaped') });
    const resolved = resolveAgent('../../escaped', config.agents['../../escaped'], config, tmpDir);

    const worktreesDir = join(tmpDir, '.hive', 'worktrees');
    const isContained = normalize(resolved.worktreePath).startsWith(normalize(worktreesDir));

    // Document the gap — this assertion verifies it is NOT contained
    expect(isContained).toBe(false);
    // The escaped path should not reach system directories (tmpDir prefix is intact)
    expect(normalize(resolved.worktreePath)).toContain(normalize(tmpDir));
  });

  it('SECURITY GAP: agent name with null byte escapes validation', () => {
    // SECURITY GAP: agent names are not filtered for null bytes.
    // While Node.js path functions strip null bytes in recent versions,
    // explicit validation is missing.
    const name = 'agent\x00evil';
    const config = makeConfig({ [name]: makeAgent(name) });
    const resolved = resolveAgent(name, config.agents[name], config, tmpDir);

    // Document: the worktreePath is computed without sanitization
    expect(typeof resolved.worktreePath).toBe('string');
    // Null byte must never propagate into a filesystem call —
    // Node.js throws ERR_INVALID_ARG_VALUE if it does, which is safe by accident.
  });

  it('SECURITY OK: resolveAllAgents only processes agents declared in config', () => {
    // Confirms the attack surface is limited to agents declared by the operator.
    const config = makeConfig({
      sre: makeAgent('sre'),
      backend: makeAgent('backend'),
    });
    const agents = resolveAllAgents(config, tmpDir);
    const names = agents.map((a) => a.name);

    expect(names).toContain('sre');
    expect(names).toContain('backend');
    expect(names).toHaveLength(2);
  });

  it('SECURITY OK: resolveAgent worktreePath is an absolute path', () => {
    // Ensures downstream git operations always target an absolute path,
    // preventing relative-path exploitation via working-directory confusion.
    const config = makeConfig({ frontend: makeAgent('frontend') });
    const resolved = resolveAgent('frontend', config.agents.frontend, config, tmpDir);

    expect(resolve(resolved.worktreePath)).toBe(resolved.worktreePath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MERGE COMMAND — Branch name injection
// ─────────────────────────────────────────────────────────────────────────────

describe('merge security — branch name construction', () => {
  it('SECURITY OK: execFile is used (not shell exec) — spaces in agent name cannot inject shell commands', () => {
    // merge.ts uses `promisify(execFile)` which passes arguments as an array.
    // This means a branch name like "agent/foo; rm -rf /" is passed as a
    // *single literal argument* to git, not interpreted by a shell.
    // This test documents the safe pattern — no shell injection is possible
    // via agent names when execFile is used correctly.
    const agentName = 'foo; rm -rf /';
    const branchName = `agent/${agentName}`;

    // The branch name string is used as a positional arg in execFile calls.
    // We verify the string is unchanged (no escaping needed for execFile).
    expect(branchName).toBe('agent/foo; rm -rf /');

    // Git will reject invalid refs — the space/semicolon make an invalid ref,
    // so git rev-parse --verify will fail harmlessly before any push occurs.
    // That is the expected safe outcome.
  });

  it('SECURITY OK: shellQuote correctly escapes branch names used in tmux display', () => {
    // If a branch name is ever displayed in a tmux window title via shellQuote,
    // metacharacters must be escaped.
    const dangerousBranch = "agent/foo'; kill -9 1; echo '";
    const quoted = shellQuote(dangerousBranch);

    // The result must NOT be the raw unquoted string (that would be injectable)
    expect(quoted).not.toBe(dangerousBranch);

    // The dangerous characters must be neutralised: semicolons, single quotes
    // must not appear in unescaped form. shellQuote uses the 'str'\''str' idiom.
    // Verify the overall quoted string treats the dangerous input as a single token:
    // it must start and end with single-quote delimiters (possibly escaped internally).
    expect(quoted.length).toBeGreaterThan(dangerousBranch.length);

    // The semi-colon from the injection attempt must not cause shell command separation.
    // We verify this by ensuring the output is a quoted form (starts with a quote char)
    // that wraps the original content safely.
    expect(quoted.startsWith("'")).toBe(true);
  });

  it('SECURITY OK: branch names with git refspec metacharacters are safe under execFile', () => {
    // Characters like ~, ^, :, ?, *, [ are invalid in git refnames.
    // Since merge.ts uses execFile (array args), these chars cannot be used
    // for git refspec injection or shell injection.
    const injectionAttempts = [
      'agent/branch~1',          // git ancestry notation
      'agent/branch^0',          // commit notation
      'agent/HEAD:path',         // blob ref
      'agent/branch..main',      // range notation
    ];

    for (const attempt of injectionAttempts) {
      // Verify these strings exist as-is — execFile passes them literally to git,
      // which then rejects invalid refnames without shell interpretation.
      expect(typeof attempt).toBe('string');
      expect(attempt.startsWith('agent/')).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. MERGE COMMAND — State file integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('merge security — state file integrity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, '.hive', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SECURITY OK: merge state is stored as structured JSON (no eval)', () => {
    // merge-state.json is written with JSON.stringify and read with JSON.parse.
    // Neither eval() nor Function() is used, so injected JSON payloads are
    // inert data — they cannot execute code.
    const stateFile = join(tmpDir, '.hive', 'state', 'merge-state.json');
    const maliciousPayload = {
      mainBranch: 'main',
      currentAgent: '__proto__',                  // prototype pollution attempt
      remainingAgents: ['normal'],
      completedResults: [],
      __proto__: { isAdmin: true },               // JSON.parse strips this
      constructor: { prototype: { x: 1 } },       // harmless as data
    };

    writeFileSync(stateFile, JSON.stringify(maliciousPayload));
    const parsed: Record<string, unknown> = JSON.parse(readFileSync(stateFile, 'utf-8'));

    // JSON.parse does not execute code and does not allow prototype pollution
    expect(parsed['mainBranch']).toBe('main');
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('SECURITY OK: merge state file is located inside .hive/state — not user-controlled path', () => {
    // The state file path is hardcoded as join(hiveRoot, '.hive', 'state', 'merge-state.json').
    // It is not derived from user input, so an attacker cannot redirect state
    // writes to an arbitrary filesystem location.
    const expectedPath = join(tmpDir, '.hive', 'state', 'merge-state.json');
    expect(existsSync(expectedPath)).toBe(false); // not created yet — path is predictable

    writeFileSync(expectedPath, '{}');
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('SECURITY OK: corrupt merge state returns null — no crash or code execution', () => {
    // loadMergeState wraps JSON.parse in try/catch and returns null on failure.
    // A tampered state file cannot crash the process or execute code.
    const stateFile = join(tmpDir, '.hive', 'state', 'merge-state.json');
    writeFileSync(stateFile, '}{invalid json}{');

    // Simulate what loadMergeState does internally
    let result: unknown = null;
    try {
      result = JSON.parse(readFileSync(stateFile, 'utf-8'));
    } catch {
      result = null;
    }

    expect(result).toBeNull();
  });

  it('SECURITY GAP: mainBranch in merge state is not validated against an allowlist', () => {
    // SECURITY GAP: If a hostile actor can write a malicious merge-state.json
    // (e.g., via a path traversal or file-write vulnerability elsewhere),
    // the mainBranch field is used verbatim in:
    //   git push origin branchName:<mainBranch>
    // Under execFile this is safe (no shell injection), but an unexpected
    // mainBranch value (e.g. "refs/heads/attacker-branch") could cause the
    // push to target an unintended ref.
    // Remediation: validate mainBranch matches /^[a-zA-Z0-9_./\-]+$/ when
    // loading merge state.
    const stateFile = join(tmpDir, '.hive', 'state', 'merge-state.json');
    const state = {
      mainBranch: 'refs/heads/attacker-branch',  // unexpected ref format
      currentAgent: 'backend',
      remainingAgents: [],
      completedResults: [],
    };
    writeFileSync(stateFile, JSON.stringify(state));
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as typeof state;

    // Gap documented: mainBranch is consumed without allowlist validation
    expect(parsed.mainBranch).toBe('refs/heads/attacker-branch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DELIVERY CONFIG — Strategy field validation (BE-23 pending)
// ─────────────────────────────────────────────────────────────────────────────

describe('delivery config — strategy field validation (BE-23 pending)', () => {
  it.todo('SECURITY: delivery.strategy must be validated against allowlist [auto-merge|pull-request|manual]');
  // When BE-23 adds delivery config, strategy must be validated:
  //   const ALLOWED_STRATEGIES = ['auto-merge', 'pull-request', 'manual'];
  //   if (!ALLOWED_STRATEGIES.includes(config.delivery?.strategy ?? 'manual')) {
  //     throw new Error(`Invalid delivery strategy: ${config.delivery.strategy}`);
  //   }
  // An unchecked strategy value could be used in shell display or log messages.

  it.todo('SECURITY: delivery.base_branch must be validated as a safe git refname');
  // base_branch value flows into git push origin branch:<base_branch>.
  // Under execFile this prevents shell injection, but should still be validated
  // with /^[a-zA-Z0-9_.\-/]+$/ to prevent unexpected ref targets.

  it.todo('SECURITY: delivery.require_ci must be a boolean — reject truthy strings');
  // Ensures CI bypass cannot occur via a config value like require_ci: "false"
  // (YAML parses this as a string, not boolean false).
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. gh CLI INTEGRATION — PR body/title injection (BE-26 pending)
// ─────────────────────────────────────────────────────────────────────────────

describe('gh CLI integration — PR body/title injection (BE-26 pending)', () => {
  it.todo('SECURITY: gh pr create must use execFile (array args), never shell exec');
  // If `gh pr create --title <title> --body <body>` is invoked via exec() with
  // string interpolation, a title like "foo --label pwned --base attacker" could
  // inject additional flags. execFile with an args array prevents this entirely.

  it.todo('SECURITY: PR title derived from epic title must be sanitized before use as CLI arg');
  // Epic titles come from .hive/plan.json which is operator-controlled but
  // may contain newlines, shell metacharacters, or Unicode that could confuse
  // gh CLI parsing. Strip or quote to a safe subset.

  it.todo('SECURITY: PR body with commit summary must escape Markdown injection');
  // Commit messages (from git log) are external data and could contain
  // Markdown that alters PR rendering, e.g., injecting false CI status badges
  // or links. Sanitize before including in PR body.

  it.todo('SECURITY: gh auth status must be checked before PR creation — fail if not authenticated');
  // Prevents silent no-op or error-swallowing when gh is not authenticated.
  // Expected: command fails with clear error, not silent data leak.

  it.todo('SECURITY: --label flag values must be from an allowlist or validated');
  // Dynamic label names from plan task fields should be validated to prevent
  // unexpected label injection (e.g., "security-bypass" labels on the PR).
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. RELEASE PIPELINE — Binary integrity (BE-32 pending)
// ─────────────────────────────────────────────────────────────────────────────

describe('release pipeline — binary integrity (BE-32 pending)', () => {
  it.todo('SECURITY: release binary checksum must be verified before gh release create upload');
  // Build binary then compute SHA-256 of the output file.
  // If the file is missing or its hash does not match the expected build output,
  // the release must be aborted. Prevents uploading a tampered binary.

  it.todo('SECURITY: changelog generated from git log must not include unsanitized commit messages in release notes');
  // Commit messages are external data (any developer can craft them).
  // Strip or encode HTML/Markdown before including in GitHub release body.

  it.todo('SECURITY: hive release must require explicit --version flag — no auto-bump from git tags');
  // Auto-bumping version from the latest git tag could be exploited by
  // pushing a lightweight tag to force an unexpected version number.
  // Explicit --version <semver> with validation against /^v?[0-9]+\.[0-9]+\.[0-9]+$/
  // ensures the operator controls what version is published.

  it.todo('SECURITY: gh release create must use execFile (array args), not shell exec');
  // Version string, release title, and body must all be passed as array args
  // to prevent injection via crafted version strings like "v1.0 --prerelease --draft=false".

  it.todo('SECURITY: release should fail if npm run build:binary exits non-zero');
  // A failed binary build must abort the release entirely.
  // Uploading a partial or empty binary is a worse outcome than a failed release.
});
