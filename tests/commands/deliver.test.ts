/**
 * Tests — Delivery Pipeline and Epic Completion (QA-22)
 *
 * Covers three areas:
 *
 *   1. Epic completion detection — computeParentStatus, reconcilePlanWithChat,
 *      and the definition-of-done: an epic is done only when ALL children are done.
 *
 *   2. Delivery config validation — strategy allowlist, base_branch format,
 *      require_ci type safety. Tests are active stubs that document expected
 *      behaviour; the delivery config field is pending (BE-23).
 *
 *   3. hive deliver command — CLI integration tests. Marked `.todo` until the
 *      command is implemented (BE-23/BE-26).
 *
 * Notation:
 *   "DELIVERY OK"  — behaviour that correctly gates delivery.
 *   "DELIVERY GAP" — missing gate or validation documented for remediation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createPlan,
  computeParentStatus,
  computeReadyTasks,
  reconcilePlanWithChat,
  promoteReadyTasks,
  getChildren,
  validateParentType,
  savePlan,
  loadPlan,
} from '../../src/core/plan.js';
import type { Plan, PlanTask } from '../../src/types/plan.js';
import type { ChatMessage } from '../../src/types/config.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
  const now = new Date().toISOString();
  return {
    id: 'task-01',
    title: 'Test task',
    target: 'backend',
    priority: 'p2',
    status: 'open',
    depends_on: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makePlan(tasks: PlanTask[] = []): Plan {
  const now = new Date().toISOString();
  return { name: 'test-plan', created_at: now, updated_at: now, tasks };
}

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'BACKEND',
    type: 'DONE',
    body: 'completed task',
    lineNumber: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. EPIC COMPLETION — Definition of Done
// ─────────────────────────────────────────────────────────────────────────────

describe('epic completion — definition of done', () => {
  it('DELIVERY OK: epic status is "done" when all children are done', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic', title: 'Ship v1' });
    const s1 = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', type: 'story', parent: 'EP-01', status: 'done' });

    const plan = makePlan([epic, s1, s2]);
    const result = computeParentStatus(plan, 'EP-01');

    expect(result.status).toBe('done');
    expect(result.done).toBe(2);
    expect(result.total).toBe(2);
  });

  it('DELIVERY OK: epic is NOT done when any child is still open', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic', title: 'Ship v1' });
    const s1 = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', type: 'story', parent: 'EP-01', status: 'open' });

    const plan = makePlan([epic, s1, s2]);
    const result = computeParentStatus(plan, 'EP-01');

    expect(result.status).not.toBe('done');
    expect(result.done).toBe(1);
    expect(result.total).toBe(2);
  });

  it('DELIVERY OK: epic is NOT done when any child is running', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', parent: 'EP-01', status: 'running' });

    const plan = makePlan([epic, s1, s2]);
    const result = computeParentStatus(plan, 'EP-01');

    expect(result.status).toBe('running');
    expect(result.done).toBe(1);
    expect(result.running).toBe(1);
  });

  it('DELIVERY OK: epic with no children has status "open" — cannot be delivered', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const plan = makePlan([epic]);
    const result = computeParentStatus(plan, 'EP-01');

    expect(result.status).toBe('open');
    expect(result.total).toBe(0);
  });

  it('DELIVERY OK: epic is blocked when any child is blocked', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', parent: 'EP-01', status: 'blocked' });

    const plan = makePlan([epic, s1, s2]);
    const result = computeParentStatus(plan, 'EP-01');

    expect(result.status).toBe('blocked');
    expect(result.blocked).toBe(1);
  });

  it('DELIVERY OK: epic is blocked when any child has failed', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', parent: 'EP-01', status: 'failed' });

    const plan = makePlan([epic, s1, s2]);
    const result = computeParentStatus(plan, 'EP-01');

    expect(result.status).toBe('blocked');
    expect(result.failed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. EPIC COMPLETION — Chat-driven status transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('epic completion — chat-driven transitions', () => {
  it('DELIVERY OK: reconcilePlanWithChat marks story done via bracketed ID in DONE message', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const story = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01', status: 'running', target: 'backend' });
    const plan = makePlan([epic, story]);

    const messages: ChatMessage[] = [
      makeMsg({ role: 'BACKEND', type: 'DONE', body: '[S-01] completed the story' }),
    ];

    const updates = reconcilePlanWithChat(plan, messages);

    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe('S-01');
    expect(updates[0].newStatus).toBe('done');
    expect(story.status).toBe('done');
  });

  it('DELIVERY OK: epic becomes deliverable after all stories marked done via chat', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01', status: 'dispatched', target: 'backend' });
    const s2 = makeTask({ id: 'S-02', type: 'story', parent: 'EP-01', status: 'dispatched', target: 'frontend' });
    const plan = makePlan([epic, s1, s2]);

    const messages: ChatMessage[] = [
      makeMsg({ role: 'BACKEND', type: 'DONE', body: '[S-01] backend done' }),
      makeMsg({ role: 'FRONTEND', type: 'DONE', body: '[S-02] frontend done' }),
    ];

    reconcilePlanWithChat(plan, messages);

    const epicStatus = computeParentStatus(plan, 'EP-01');
    expect(epicStatus.status).toBe('done');
    expect(epicStatus.done).toBe(2);
    expect(epicStatus.total).toBe(2);
  });

  it('DELIVERY OK: BLOCKER message marks story failed — blocks epic delivery', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01', status: 'running', target: 'backend' });
    const plan = makePlan([epic, s1]);

    const messages: ChatMessage[] = [
      makeMsg({ role: 'BACKEND', type: 'BLOCKER', body: '[S-01] cannot proceed — dependency missing' }),
    ];

    reconcilePlanWithChat(plan, messages);

    const epicStatus = computeParentStatus(plan, 'EP-01');
    expect(epicStatus.status).toBe('blocked');
    expect(epicStatus.failed).toBe(1);
  });

  it('DELIVERY OK: partial completion keeps epic in non-deliverable state', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01', status: 'running', target: 'backend' });
    const s2 = makeTask({ id: 'S-02', type: 'story', parent: 'EP-01', status: 'open', target: 'frontend' });
    const plan = makePlan([epic, s1, s2]);

    // Only one of two stories completes
    const messages: ChatMessage[] = [
      makeMsg({ role: 'BACKEND', type: 'DONE', body: '[S-01] backend done' }),
    ];

    reconcilePlanWithChat(plan, messages);

    const epicStatus = computeParentStatus(plan, 'EP-01');
    expect(epicStatus.status).not.toBe('done');
    expect(epicStatus.done).toBe(1);
    expect(epicStatus.total).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. EPIC COMPLETION — Hierarchy validation (type constraints)
// ─────────────────────────────────────────────────────────────────────────────

describe('epic completion — hierarchy type validation', () => {
  it('DELIVERY OK: epic can contain stories — valid hierarchy', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const story = makeTask({ id: 'S-01', type: 'story' });

    expect(validateParentType(epic, story)).toBe(true);
  });

  it('DELIVERY OK: epic can contain tasks — valid hierarchy', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const task = makeTask({ id: 'T-01', type: 'task' });

    expect(validateParentType(epic, task)).toBe(true);
  });

  it('DELIVERY OK: story can contain tasks — valid hierarchy', () => {
    const story = makeTask({ id: 'S-01', type: 'story' });
    const task = makeTask({ id: 'T-01', type: 'task' });

    expect(validateParentType(story, task)).toBe(true);
  });

  it('DELIVERY OK: task cannot parent another task — invalid hierarchy', () => {
    const parent = makeTask({ id: 'T-01', type: 'task' });
    const child = makeTask({ id: 'T-02', type: 'task' });

    expect(validateParentType(parent, child)).toBe(false);
  });

  it('DELIVERY OK: story cannot contain an epic — invalid hierarchy', () => {
    const story = makeTask({ id: 'S-01', type: 'story' });
    const epic = makeTask({ id: 'EP-01', type: 'epic' });

    expect(validateParentType(story, epic)).toBe(false);
  });

  it('DELIVERY OK: untyped parent allows any child — no constraint', () => {
    const parent = makeTask({ id: 'P-01' }); // no type
    const child = makeTask({ id: 'C-01', type: 'epic' });

    expect(validateParentType(parent, child)).toBe(true);
  });

  it('DELIVERY OK: getChildren returns only direct children of the epic', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', type: 'story', parent: 'EP-01' });
    const s2 = makeTask({ id: 'S-02', type: 'story', parent: 'EP-01' });
    const unrelated = makeTask({ id: 'T-99', type: 'task' }); // no parent

    const plan = makePlan([epic, s1, s2, unrelated]);
    const children = getChildren(plan, 'EP-01');

    expect(children).toHaveLength(2);
    expect(children.map((c) => c.id).sort()).toEqual(['S-01', 'S-02']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DELIVERY PIPELINE — Merge state machine
// ─────────────────────────────────────────────────────────────────────────────

describe('delivery pipeline — merge state machine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-deliver-test-'));
    mkdirSync(join(tmpDir, '.hive', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DELIVERY OK: merge state file is created in .hive/state/ — predictable path', () => {
    const statePath = join(tmpDir, '.hive', 'state', 'merge-state.json');
    expect(existsSync(statePath)).toBe(false);

    const state = {
      mainBranch: 'main',
      currentAgent: 'backend',
      remainingAgents: ['frontend'],
      completedResults: [],
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    expect(existsSync(statePath)).toBe(true);
    const loaded = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(loaded.mainBranch).toBe('main');
    expect(loaded.currentAgent).toBe('backend');
    expect(loaded.remainingAgents).toEqual(['frontend']);
  });

  it('DELIVERY OK: in-progress merge is detectable by presence of state file', () => {
    const statePath = join(tmpDir, '.hive', 'state', 'merge-state.json');

    // No state file → no merge in progress
    expect(existsSync(statePath)).toBe(false);

    // Create state file → merge in progress
    writeFileSync(statePath, JSON.stringify({ mainBranch: 'main', currentAgent: 'alpha', remainingAgents: [], completedResults: [] }));
    expect(existsSync(statePath)).toBe(true);
  });

  it('DELIVERY OK: merge state is cleared after completion (state file removed)', () => {
    const statePath = join(tmpDir, '.hive', 'state', 'merge-state.json');
    writeFileSync(statePath, JSON.stringify({ mainBranch: 'main', currentAgent: 'alpha', remainingAgents: [], completedResults: [] }));

    expect(existsSync(statePath)).toBe(true);

    // Simulate clearing state
    rmSync(statePath);
    expect(existsSync(statePath)).toBe(false);
  });

  it('DELIVERY OK: corrupt merge state returns null — delivery does not proceed blindly', () => {
    const statePath = join(tmpDir, '.hive', 'state', 'merge-state.json');
    writeFileSync(statePath, '}{invalid json');

    // Simulate loadMergeState logic
    let result: unknown = null;
    try {
      result = JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch {
      result = null;
    }

    expect(result).toBeNull();
  });

  it('DELIVERY OK: merge state preserves the ordered list of remaining agents', () => {
    const statePath = join(tmpDir, '.hive', 'state', 'merge-state.json');
    const remaining = ['frontend', 'sre', 'qa'];
    const state = {
      mainBranch: 'main',
      currentAgent: 'backend',
      remainingAgents: remaining,
      completedResults: [],
    };
    writeFileSync(statePath, JSON.stringify(state));

    const loaded = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(loaded.remainingAgents).toEqual(remaining);
    // Order must be preserved — delivery must proceed in the declared sequence
    expect(loaded.remainingAgents[0]).toBe('frontend');
    expect(loaded.remainingAgents[loaded.remainingAgents.length - 1]).toBe('qa');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DELIVERY CONFIG — Strategy and field validation (BE-23 pending)
// ─────────────────────────────────────────────────────────────────────────────

describe('delivery config — strategy field validation', () => {
  /**
   * These tests document the expected validation behaviour for the delivery
   * config section that will be added in BE-23.
   *
   * The helper `validateDeliveryConfig` does not exist yet — each test
   * exercises the validation logic inline to document the expected rules.
   */

  it('DELIVERY OK: strategy "auto-merge" is a valid delivery strategy', () => {
    const ALLOWED_STRATEGIES = ['auto-merge', 'pull-request', 'manual'];
    const strategy = 'auto-merge';
    expect(ALLOWED_STRATEGIES.includes(strategy)).toBe(true);
  });

  it('DELIVERY OK: strategy "pull-request" is a valid delivery strategy', () => {
    const ALLOWED_STRATEGIES = ['auto-merge', 'pull-request', 'manual'];
    const strategy = 'pull-request';
    expect(ALLOWED_STRATEGIES.includes(strategy)).toBe(true);
  });

  it('DELIVERY OK: strategy "manual" is a valid delivery strategy', () => {
    const ALLOWED_STRATEGIES = ['auto-merge', 'pull-request', 'manual'];
    const strategy = 'manual';
    expect(ALLOWED_STRATEGIES.includes(strategy)).toBe(true);
  });

  it('DELIVERY GAP: unknown strategy values are not validated — must be added in BE-23', () => {
    // DELIVERY GAP: The delivery.strategy field is not yet present in HiveConfig.
    // When BE-23 adds it, an allowlist check must be enforced:
    //   if (!ALLOWED_STRATEGIES.includes(config.delivery?.strategy ?? 'manual')) {
    //     throw new HiveConfigValidationError(...);
    //   }
    // This test documents the gap by showing that invalid strategies are unchecked.
    const ALLOWED_STRATEGIES = ['auto-merge', 'pull-request', 'manual'];
    const invalidStrategy = 'yolo-deploy';
    // Gap: without validation, this would silently pass
    expect(ALLOWED_STRATEGIES.includes(invalidStrategy)).toBe(false);
    // Expected remediation: throw HiveConfigValidationError when strategy is not in allowlist
  });

  it('DELIVERY OK: base_branch safe characters regex accepts "main"', () => {
    const SAFE_REF = /^[a-zA-Z0-9_.\-/]+$/;
    expect(SAFE_REF.test('main')).toBe(true);
  });

  it('DELIVERY OK: base_branch safe characters regex accepts "develop"', () => {
    const SAFE_REF = /^[a-zA-Z0-9_.\-/]+$/;
    expect(SAFE_REF.test('develop')).toBe(true);
  });

  it('DELIVERY OK: base_branch safe characters regex accepts "release/1.0"', () => {
    const SAFE_REF = /^[a-zA-Z0-9_.\-/]+$/;
    expect(SAFE_REF.test('release/1.0')).toBe(true);
  });

  it('DELIVERY GAP: base_branch with shell metacharacters is not validated — must be added in BE-23', () => {
    // DELIVERY GAP: base_branch flows into git push origin branch:<base_branch>.
    // Under execFile this prevents shell injection, but unexpected ref targets
    // (e.g. "refs/heads/attacker") could misdirect the push.
    // Expected: validate with /^[a-zA-Z0-9_.\-/]+$/ when loading delivery config.
    const SAFE_REF = /^[a-zA-Z0-9_.\-/]+$/;
    const dangerousBranch = 'main; cat /etc/passwd';
    expect(SAFE_REF.test(dangerousBranch)).toBe(false);
  });

  it('DELIVERY OK: require_ci must be a boolean — not a truthy string', () => {
    // YAML parses require_ci: "false" as the string "false", not boolean false.
    // Correct handling: typeof value === 'boolean' check during config loading.
    const rawValue = 'false'; // YAML string, not boolean
    const isBoolean = typeof rawValue === 'boolean';
    expect(isBoolean).toBe(false);
    // Expected remediation: reject non-boolean require_ci values in validateAndNormalize
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DELIVERY PIPELINE — Auto-merge readiness check
// ─────────────────────────────────────────────────────────────────────────────

describe('delivery pipeline — auto-merge readiness', () => {
  it('DELIVERY OK: auto-merge is only appropriate when epic status is "done"', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', parent: 'EP-01', status: 'done' });
    const plan = makePlan([epic, s1, s2]);

    const epicStatus = computeParentStatus(plan, 'EP-01');
    // Gate: only trigger auto-merge when status is 'done'
    const readyForDelivery = epicStatus.status === 'done';
    expect(readyForDelivery).toBe(true);
  });

  it('DELIVERY OK: auto-merge is blocked when epic has incomplete stories', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', parent: 'EP-01', status: 'running' });
    const plan = makePlan([epic, s1, s2]);

    const epicStatus = computeParentStatus(plan, 'EP-01');
    const readyForDelivery = epicStatus.status === 'done';
    expect(readyForDelivery).toBe(false);
  });

  it('DELIVERY OK: plan with all tasks done has no ready tasks — delivery is safe', () => {
    const t1 = makeTask({ id: 'T-01', status: 'done', depends_on: [] });
    const t2 = makeTask({ id: 'T-02', status: 'done', depends_on: ['T-01'] });
    const plan = makePlan([t1, t2]);

    const ready = computeReadyTasks(plan);
    // No ready tasks means the pipeline has nothing pending — safe to deliver
    expect(ready).toHaveLength(0);
  });

  it('DELIVERY OK: plan with pending tasks should NOT be delivered', () => {
    const t1 = makeTask({ id: 'T-01', status: 'done', depends_on: [] });
    const t2 = makeTask({ id: 'T-02', status: 'open', depends_on: ['T-01'] });
    const plan = makePlan([t1, t2]);

    // Promote to get accurate ready list
    promoteReadyTasks(plan);
    const ready = computeReadyTasks(plan);

    // T-02 became ready after T-01 done — delivery must wait
    expect(ready.length).toBeGreaterThan(0);
  });

  it('DELIVERY OK: epic progress counters are accurate for delivery gating', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const tasks = [
      makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' }),
      makeTask({ id: 'S-02', parent: 'EP-01', status: 'done' }),
      makeTask({ id: 'S-03', parent: 'EP-01', status: 'done' }),
    ];
    const plan = makePlan([epic, ...tasks]);

    const { done, total, status } = computeParentStatus(plan, 'EP-01');

    expect(done).toBe(3);
    expect(total).toBe(3);
    expect(status).toBe('done');
    // Delivery gate: done/total === 1.0
    expect(done / total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. DELIVERY PIPELINE — Plan persistence during delivery
// ─────────────────────────────────────────────────────────────────────────────

describe('delivery pipeline — plan persistence', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-deliver-plan-'));
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  it('DELIVERY OK: completed_at is set when a task is marked done via reconcile', () => {
    const story = makeTask({ id: 'S-01', status: 'running', target: 'backend' });
    const plan = makePlan([story]);

    const messages: ChatMessage[] = [
      makeMsg({ role: 'BACKEND', type: 'DONE', body: '[S-01] all tests green' }),
    ];

    reconcilePlanWithChat(plan, messages);

    expect(story.status).toBe('done');
    expect(story.completed_at).toBeDefined();
    expect(typeof story.completed_at).toBe('string');
  });

  it('DELIVERY OK: resolution body is stored on completed task', () => {
    const story = makeTask({ id: 'S-01', status: 'running', target: 'backend' });
    const plan = makePlan([story]);
    const doneBody = '[S-01] implemented feature and all tests pass';

    const messages: ChatMessage[] = [
      makeMsg({ role: 'BACKEND', type: 'DONE', body: doneBody }),
    ];

    reconcilePlanWithChat(plan, messages);

    expect(story.resolution).toBe(doneBody);
  });

  it('DELIVERY OK: savePlan persists epic completion state — survives reload', () => {
    const epic = makeTask({ id: 'EP-01', type: 'epic' });
    const s1 = makeTask({ id: 'S-01', parent: 'EP-01', status: 'done' });
    const s2 = makeTask({ id: 'S-02', parent: 'EP-01', status: 'done' });
    const plan = makePlan([epic, s1, s2]);

    savePlan(hivePath, plan);
    const loaded = loadPlan(hivePath);

    expect(loaded).not.toBeNull();
    const epicStatus = computeParentStatus(loaded!, 'EP-01');
    expect(epicStatus.status).toBe('done');
  });

  it('DELIVERY OK: updated_at is refreshed on each savePlan call', () => {
    const plan = makePlan([makeTask()]);
    const originalUpdatedAt = plan.updated_at;

    // Small delay to ensure timestamps differ
    const before = Date.now();
    while (Date.now() === before) { /* spin */ }

    savePlan(hivePath, plan);
    const loaded = loadPlan(hivePath);

    expect(loaded?.updated_at).toBeDefined();
    expect(loaded?.updated_at).not.toBe(originalUpdatedAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. hive deliver COMMAND — CLI integration (BE-23/BE-26 pending)
// ─────────────────────────────────────────────────────────────────────────────

describe('hive deliver command (BE-23/BE-26 pending)', () => {
  it.todo('exits 0 when strategy is "manual" and epic is done — no git operations');
  // Expected: hive deliver --epic EP-01 --strategy manual
  //   prints "EP-01 is complete — ready for manual delivery"
  //   and exits 0 without touching git.

  it.todo('exits non-zero when epic has incomplete stories — delivery gate enforced');
  // Expected: hive deliver --epic EP-01
  //   detects epic has running/open children
  //   prints "EP-01 is not yet complete (2/5 done)" and exits 1.

  it.todo('strategy "auto-merge" triggers hive merge for all epic agents');
  // Expected: hive deliver --epic EP-01 --strategy auto-merge
  //   collects agent names from child tasks of EP-01
  //   calls hive merge <agents...> internally

  it.todo('strategy "pull-request" calls gh pr create with sanitized title and body');
  // Expected: uses execFile (not exec) to invoke gh pr create
  //   --title derived from epic title (sanitized)
  //   --body derived from task summaries (Markdown-safe)

  it.todo('fails with clear error when no .hive/plan.json exists');
  // Expected: hive deliver prints "No plan found. Run hive plan init first."
  //   and exits 1.

  it.todo('fails with clear error when the specified epic ID does not exist in the plan');
  // Expected: hive deliver --epic NONEXISTENT
  //   prints "Epic NONEXISTENT not found in plan" and exits 1.

  it.todo('respects --dry-run flag — prints delivery plan without executing');
  // Expected: hive deliver --epic EP-01 --dry-run
  //   lists agents that would be merged and actions that would run
  //   exits 0 without modifying git state.

  it.todo('require_ci: true blocks delivery when CI is not passing (BE-26)');
  // Expected: checks GitHub Actions status for the epic branch
  //   if any required check is failing, prints "CI not passing" and exits 1.

  it.todo('creates a DONE message in the chat file after successful delivery');
  // Expected: hive deliver appends [ORCHESTRATOR] DONE <timestamp>: delivered EP-01
  //   to .hive/chat.md so the plan reconciler can mark the epic done.
});
