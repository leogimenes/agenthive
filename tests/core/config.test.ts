import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import {
  resolveHiveRoot,
  resolveHivePath,
  loadConfig,
  resolveAgent,
  resolveAllAgents,
  HiveConfigNotFoundError,
  HiveConfigValidationError,
} from '../../src/core/config.js';

describe('config', () => {
  let testDir: string;
  let hivePath: string;

  const minimalConfig = {
    agents: {
      sre: {
        description: 'Site Reliability Engineer',
        agent: 'sre',
      },
    },
  };

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(
      join(hivePath, 'config.yaml'),
      yamlStringify(config),
      'utf-8',
    );
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hive-test-config-'));
    hivePath = join(testDir, '.hive');
    mkdirSync(hivePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── resolveHiveRoot ───────────────────────────────────────────────

  describe('resolveHiveRoot', () => {
    it('should find .hive/ in the given directory', () => {
      const root = resolveHiveRoot(testDir);
      expect(root).toBe(testDir);
    });

    it('should walk up to find .hive/ in parent directories', () => {
      const subDir = join(testDir, 'some', 'deep', 'path');
      mkdirSync(subDir, { recursive: true });
      const root = resolveHiveRoot(subDir);
      expect(root).toBe(testDir);
    });

    it('should throw HiveConfigNotFoundError if .hive/ not found', () => {
      const noHive = mkdtempSync(join(tmpdir(), 'no-hive-'));
      try {
        expect(() => resolveHiveRoot(noHive)).toThrow(
          HiveConfigNotFoundError,
        );
      } finally {
        rmSync(noHive, { recursive: true, force: true });
      }
    });
  });

  // ── resolveHivePath ───────────────────────────────────────────────

  describe('resolveHivePath', () => {
    it('should return the .hive/ directory path', () => {
      const path = resolveHivePath(testDir);
      expect(path).toBe(join(testDir, '.hive'));
    });
  });

  // ── loadConfig ────────────────────────────────────────────────────

  describe('loadConfig', () => {
    it('should load a minimal config with defaults', () => {
      writeConfig(minimalConfig);
      const config = loadConfig(testDir);

      expect(config.session).toBe(testDir.split('/').pop());
      expect(config.defaults.poll).toBe(60);
      expect(config.defaults.budget).toBe(2);
      expect(config.defaults.daily_max).toBe(20);
      expect(config.defaults.skip_permissions).toBe(true);
      expect(config.agents.sre).toBeDefined();
      expect(config.chat.file).toBe('chat.md');
    });

    it('should use explicit session name', () => {
      writeConfig({ ...minimalConfig, session: 'my-project' });
      const config = loadConfig(testDir);
      expect(config.session).toBe('my-project');
    });

    it('should override defaults', () => {
      writeConfig({
        ...minimalConfig,
        defaults: {
          poll: 30,
          budget: 5,
          daily_max: 50,
          model: 'opus',
          skip_permissions: false,
        },
      });
      const config = loadConfig(testDir);
      expect(config.defaults.poll).toBe(30);
      expect(config.defaults.budget).toBe(5);
      expect(config.defaults.daily_max).toBe(50);
      expect(config.defaults.model).toBe('opus');
      expect(config.defaults.skip_permissions).toBe(false);
    });

    it('should parse role_map', () => {
      writeConfig({
        ...minimalConfig,
        chat: {
          role_map: {
            sre: 'INFRA',
          },
        },
      });
      const config = loadConfig(testDir);
      expect(config.chat.role_map.sre).toBe('INFRA');
    });

    it('should auto-generate role_map from agent names', () => {
      writeConfig({
        agents: {
          sre: { description: 'SRE', agent: 'sre' },
          'my-frontend': { description: 'FE', agent: 'frontend' },
        },
      });
      const config = loadConfig(testDir);
      expect(config.chat.role_map.sre).toBe('SRE');
      expect(config.chat.role_map['my-frontend']).toBe('MY_FRONTEND');
    });

    it('should throw if config.yaml is missing', () => {
      // hivePath exists but no config.yaml inside
      expect(() => loadConfig(testDir)).toThrow(HiveConfigNotFoundError);
    });

    it('should throw if agents section is missing', () => {
      writeConfig({ session: 'test' });
      expect(() => loadConfig(testDir)).toThrow(HiveConfigValidationError);
    });

    it('should throw if agents section is empty', () => {
      writeConfig({ agents: {} });
      expect(() => loadConfig(testDir)).toThrow(HiveConfigValidationError);
    });

    it('should parse hooks config', () => {
      writeConfig({
        ...minimalConfig,
        hooks: {
          safety: ['destructive-guard'],
          coordination: ['check-chat'],
          custom: ['my-hook.sh'],
        },
      });
      const config = loadConfig(testDir);
      expect(config.hooks.safety).toEqual(['destructive-guard']);
      expect(config.hooks.coordination).toEqual(['check-chat']);
      expect(config.hooks.custom).toEqual(['my-hook.sh']);
    });

    it('should apply delivery defaults when delivery section is absent', () => {
      writeConfig(minimalConfig);
      const config = loadConfig(testDir);
      expect(config.delivery.strategy).toBe('manual');
      expect(config.delivery.require_ci).toBe(true);
      expect(config.delivery.base_branch).toBe('main');
      expect(config.delivery.auto_release).toBe(false);
      expect(config.delivery.definition_of_done).toEqual(['all_tasks_done']);
    });

    it('should load explicit delivery config', () => {
      writeConfig({
        ...minimalConfig,
        delivery: {
          strategy: 'pull-request',
          require_ci: false,
          base_branch: 'develop',
          auto_release: true,
          definition_of_done: ['all_tasks_done', 'tests_pass'],
        },
      });
      const config = loadConfig(testDir);
      expect(config.delivery.strategy).toBe('pull-request');
      expect(config.delivery.require_ci).toBe(false);
      expect(config.delivery.base_branch).toBe('develop');
      expect(config.delivery.auto_release).toBe(true);
      expect(config.delivery.definition_of_done).toEqual([
        'all_tasks_done',
        'tests_pass',
      ]);
    });

    it('should accept all valid delivery strategies', () => {
      for (const strategy of ['auto-merge', 'pull-request', 'manual'] as const) {
        writeConfig({ ...minimalConfig, delivery: { strategy } });
        const config = loadConfig(testDir);
        expect(config.delivery.strategy).toBe(strategy);
      }
    });

    it('should throw on invalid delivery strategy', () => {
      writeConfig({ ...minimalConfig, delivery: { strategy: 'invalid' } });
      expect(() => loadConfig(testDir)).toThrow(HiveConfigValidationError);
    });
  });

  // ── resolveAgent ──────────────────────────────────────────────────

  describe('resolveAgent', () => {
    it('should merge defaults into agent config', () => {
      writeConfig(minimalConfig);
      const config = loadConfig(testDir);
      const resolved = resolveAgent(
        'sre',
        config.agents.sre,
        config,
        testDir,
      );

      expect(resolved.name).toBe('sre');
      expect(resolved.poll).toBe(60); // from defaults
      expect(resolved.budget).toBe(2); // from defaults
      expect(resolved.daily_max).toBe(20); // from defaults
      expect(resolved.model).toBe('sonnet'); // from defaults
      expect(resolved.chatRole).toBe('SRE');
      expect(resolved.worktreePath).toBe(
        join(testDir, '.hive', 'worktrees', 'sre'),
      );
    });

    it('should prefer agent-specific overrides', () => {
      writeConfig({
        agents: {
          sre: {
            description: 'SRE',
            agent: 'sre',
            poll: 30,
            budget: 5,
            daily_max: 50,
          },
        },
      });
      const config = loadConfig(testDir);
      const resolved = resolveAgent(
        'sre',
        config.agents.sre,
        config,
        testDir,
      );

      expect(resolved.poll).toBe(30);
      expect(resolved.budget).toBe(5);
      expect(resolved.daily_max).toBe(50);
    });

    it('should use role_map for chatRole', () => {
      writeConfig({
        agents: {
          backend: { description: 'BE', agent: 'debugger' },
        },
        chat: {
          role_map: { backend: 'DEBUGGER' },
        },
      });
      const config = loadConfig(testDir);
      const resolved = resolveAgent(
        'backend',
        config.agents.backend,
        config,
        testDir,
      );

      expect(resolved.chatRole).toBe('DEBUGGER');
    });
  });

  // ── resolveAllAgents ──────────────────────────────────────────────

  describe('resolveAllAgents', () => {
    it('should resolve all agents', () => {
      writeConfig({
        agents: {
          sre: { description: 'SRE', agent: 'sre' },
          frontend: { description: 'FE', agent: 'frontend' },
          qa: { description: 'QA', agent: 'qa' },
        },
      });
      const config = loadConfig(testDir);
      const agents = resolveAllAgents(config, testDir);

      expect(agents).toHaveLength(3);
      expect(agents.map((a) => a.name)).toEqual(['sre', 'frontend', 'qa']);
    });
  });
});
