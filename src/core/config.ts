import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  HiveConfig,
  DefaultsConfig,
  AgentConfig,
  ResolvedAgentConfig,
  ChatConfig,
  HooksConfig,
  TemplatesConfig,
  DeliveryConfig,
  DefinitionOfDoneStep,
} from '../types/config.js';

// ── Errors ──────────────────────────────────────────────────────────

export class HiveConfigNotFoundError extends Error {
  constructor(searchedFrom: string) {
    super(
      `No .hive/ directory found (searched from ${searchedFrom}). Run \`hive init\` first.`,
    );
    this.name = 'HiveConfigNotFoundError';
  }
}

export class HiveConfigValidationError extends Error {
  constructor(message: string) {
    super(`Invalid .hive/config.yaml: ${message}`);
    this.name = 'HiveConfigValidationError';
  }
}

// ── Constants ───────────────────────────────────────────────────────

const HIVE_DIR = '.hive';
const CONFIG_FILE = 'config.yaml';

export const VALID_DOD_STEPS: readonly DefinitionOfDoneStep[] = [
  'all_tasks_done',
  'tests_pass',
  'pr_created',
  'pr_merged',
  'released',
] as const;

const DEFAULT_DEFAULTS: DefaultsConfig = {
  poll: 60,
  budget: 2.0,
  daily_max: 20.0,
  model: 'sonnet',
  skip_permissions: true,
  notifications: false,
  notify_on: ['DONE', 'BLOCKER'],
  transcript_retention: 20,
};

// ── Path resolution ─────────────────────────────────────────────────

/**
 * Walk up from `startDir` to find the nearest `.hive/` directory.
 * Returns the absolute path to the directory containing `.hive/`.
 */
export function resolveHiveRoot(startDir?: string): string {
  let dir = resolve(startDir ?? process.cwd());
  const root = resolve('/');

  while (dir !== root) {
    if (existsSync(join(dir, HIVE_DIR))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }

  throw new HiveConfigNotFoundError(startDir ?? process.cwd());
}

/**
 * Returns the absolute path to the `.hive/` directory.
 */
export function resolveHivePath(startDir?: string): string {
  return join(resolveHiveRoot(startDir), HIVE_DIR);
}

// ── Config loading ──────────────────────────────────────────────────

/**
 * Load and validate `.hive/config.yaml`.
 * Merges defaults into each agent config.
 */
export function loadConfig(startDir?: string): HiveConfig {
  const hiveRoot = resolveHiveRoot(startDir);
  const configPath = join(hiveRoot, HIVE_DIR, CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new HiveConfigNotFoundError(hiveRoot);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new HiveConfigValidationError('File is empty or not valid YAML.');
  }

  return validateAndNormalize(parsed, hiveRoot);
}

// ── Validation ──────────────────────────────────────────────────────

function validateAndNormalize(
  raw: Record<string, unknown>,
  hiveRoot: string,
): HiveConfig {
  // Session
  const session =
    typeof raw.session === 'string' ? raw.session : basename(hiveRoot);

  // Defaults
  const rawDefaults = (raw.defaults ?? {}) as Partial<DefaultsConfig>;
  const defaults: DefaultsConfig = {
    poll: toNumber(rawDefaults.poll, DEFAULT_DEFAULTS.poll),
    budget: toNumber(rawDefaults.budget, DEFAULT_DEFAULTS.budget),
    daily_max: toNumber(rawDefaults.daily_max, DEFAULT_DEFAULTS.daily_max),
    model:
      typeof rawDefaults.model === 'string'
        ? rawDefaults.model
        : DEFAULT_DEFAULTS.model,
    skip_permissions:
      typeof rawDefaults.skip_permissions === 'boolean'
        ? rawDefaults.skip_permissions
        : DEFAULT_DEFAULTS.skip_permissions,
    notifications:
      typeof rawDefaults.notifications === 'boolean'
        ? rawDefaults.notifications
        : DEFAULT_DEFAULTS.notifications,
    notify_on:
      toStringArray(rawDefaults.notify_on) ?? DEFAULT_DEFAULTS.notify_on,
    transcript_retention: toNumber(
      rawDefaults.transcript_retention,
      DEFAULT_DEFAULTS.transcript_retention,
    ),
  };

  // Agents
  const rawAgents = raw.agents;
  if (!rawAgents || typeof rawAgents !== 'object') {
    throw new HiveConfigValidationError(
      'Missing or invalid "agents" section. At least one agent is required.',
    );
  }

  const agents: Record<string, AgentConfig> = {};
  for (const [name, agentRaw] of Object.entries(
    rawAgents as Record<string, unknown>,
  )) {
    if (!agentRaw || typeof agentRaw !== 'object') {
      throw new HiveConfigValidationError(
        `Agent "${name}" must be an object.`,
      );
    }
    const a = agentRaw as Record<string, unknown>;
    agents[name] = {
      description:
        typeof a.description === 'string' ? a.description : name,
      agent: typeof a.agent === 'string' ? a.agent : name,
      poll: a.poll !== undefined ? toNumber(a.poll, defaults.poll) : undefined,
      budget:
        a.budget !== undefined
          ? toNumber(a.budget, defaults.budget)
          : undefined,
      daily_max:
        a.daily_max !== undefined
          ? toNumber(a.daily_max, defaults.daily_max)
          : undefined,
      model: typeof a.model === 'string' ? a.model : undefined,
    };
  }

  if (Object.keys(agents).length === 0) {
    throw new HiveConfigValidationError('At least one agent must be defined.');
  }

  // Chat
  const rawChat = (raw.chat ?? {}) as Record<string, unknown>;
  const chat: ChatConfig = {
    file:
      typeof rawChat.file === 'string' ? rawChat.file : 'chat.md',
    role_map: buildRoleMap(rawChat.role_map, agents),
  };

  // Hooks
  const rawHooks = (raw.hooks ?? {}) as Record<string, unknown>;
  const hooks: HooksConfig = {
    safety: toStringArray(rawHooks.safety),
    coordination: toStringArray(rawHooks.coordination),
    custom: toStringArray(rawHooks.custom),
  };

  // Templates
  const rawTemplates = (raw.templates ?? {}) as Record<string, unknown>;
  const templates: TemplatesConfig = {
    dir:
      typeof rawTemplates.dir === 'string' ? rawTemplates.dir : undefined,
  };

  // Delivery
  const rawDelivery = (raw.delivery ?? {}) as Record<string, unknown>;
  const strategy = rawDelivery.strategy;
  const validStrategies = ['auto-merge', 'pull-request', 'manual'] as const;
  if (
    strategy !== undefined &&
    !validStrategies.includes(strategy as (typeof validStrategies)[number])
  ) {
    throw new HiveConfigValidationError(
      `delivery.strategy must be one of: ${validStrategies.join(', ')}.`,
    );
  }
  const rawDodArray = toStringArray(rawDelivery.definition_of_done);
  let definitionOfDone: DefinitionOfDoneStep[];
  if (rawDodArray === undefined) {
    definitionOfDone = ['all_tasks_done'];
  } else {
    for (const step of rawDodArray) {
      if (!VALID_DOD_STEPS.includes(step as DefinitionOfDoneStep)) {
        throw new HiveConfigValidationError(
          `delivery.definition_of_done contains unknown step "${step}". Valid steps: ${VALID_DOD_STEPS.join(', ')}.`,
        );
      }
    }
    definitionOfDone = rawDodArray as DefinitionOfDoneStep[];
  }

  const delivery: DeliveryConfig = {
    strategy: validStrategies.includes(strategy as (typeof validStrategies)[number])
      ? (strategy as DeliveryConfig['strategy'])
      : 'manual',
    require_ci:
      typeof rawDelivery.require_ci === 'boolean'
        ? rawDelivery.require_ci
        : true,
    base_branch:
      typeof rawDelivery.base_branch === 'string'
        ? rawDelivery.base_branch
        : 'main',
    auto_release:
      typeof rawDelivery.auto_release === 'boolean'
        ? rawDelivery.auto_release
        : false,
    definition_of_done: definitionOfDone,
  };

  return { session, defaults, agents, chat, hooks, templates, delivery };
}

// ── Resolution ──────────────────────────────────────────────────────

/**
 * Resolve a single agent config by merging with defaults and computing
 * derived fields (chatRole, worktreePath).
 */
export function resolveAgent(
  name: string,
  agent: AgentConfig,
  config: HiveConfig,
  hiveRoot: string,
): ResolvedAgentConfig {
  return {
    name,
    description: agent.description,
    agent: agent.agent,
    poll: agent.poll ?? config.defaults.poll,
    budget: agent.budget ?? config.defaults.budget,
    daily_max: agent.daily_max ?? config.defaults.daily_max,
    model: agent.model ?? config.defaults.model ?? 'sonnet',
    chatRole: config.chat.role_map[name] ?? name.toUpperCase(),
    worktreePath: join(hiveRoot, HIVE_DIR, 'worktrees', name),
    skip_permissions: config.defaults.skip_permissions,
  };
}

/**
 * Resolve all agents in the config.
 */
export function resolveAllAgents(
  config: HiveConfig,
  hiveRoot: string,
): ResolvedAgentConfig[] {
  return Object.entries(config.agents).map(([name, agent]) =>
    resolveAgent(name, agent, config, hiveRoot),
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function buildRoleMap(
  rawMap: unknown,
  agents: Record<string, AgentConfig>,
): Record<string, string> {
  const map: Record<string, string> = {};

  // Use explicit mapping if provided
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    for (const [key, val] of Object.entries(rawMap)) {
      if (typeof val === 'string') {
        map[key] = val;
      }
    }
  }

  // Fill in missing agents with uppercased name
  for (const name of Object.keys(agents)) {
    if (!map[name]) {
      map[name] = name.toUpperCase().replace(/-/g, '_');
    }
  }

  return map;
}
