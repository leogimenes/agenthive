import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import {
  discoverTemplates,
  globalTemplatesDir,
  localTemplatesDir,
} from '../../src/commands/templates.js';
import { EMBEDDED_TEMPLATES } from '../../src/templates/embedded.js';

describe('template discovery', () => {
  let testDir: string;
  let hivePath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hive-test-templates-'));
    hivePath = join(testDir, '.hive');
    mkdirSync(hivePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(
      join(hivePath, 'config.yaml'),
      yamlStringify(config),
      'utf-8',
    );
  }

  const minimalConfig = {
    agents: {
      sre: { description: 'SRE', agent: 'sre' },
    },
  };

  // ── discoverTemplates ──────────────────────────────────────────────

  describe('discoverTemplates', () => {
    it('should discover all bundled templates when no custom dirs exist', () => {
      const templates = discoverTemplates(testDir);

      // Should have at least all bundled templates
      for (const name of Object.keys(EMBEDDED_TEMPLATES)) {
        expect(templates.has(name)).toBe(true);
        const tmpl = templates.get(name)!;
        expect(tmpl.source).toBe('bundled');
        expect(tmpl.content).toBe(EMBEDDED_TEMPLATES[name]);
      }
    });

    it('should override bundled templates with project-local templates', () => {
      writeConfig(minimalConfig);

      const localDir = join(hivePath, 'templates');
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(localDir, 'sre.md'), '# Custom SRE\n', 'utf-8');

      const templates = discoverTemplates(testDir);
      const sre = templates.get('sre')!;

      expect(sre.source).toBe('local');
      expect(sre.content).toBe('# Custom SRE\n');
    });

    it('should discover new templates from project-local directory', () => {
      writeConfig(minimalConfig);

      const localDir = join(hivePath, 'templates');
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(localDir, 'custom-role.md'), '# Custom Role\n', 'utf-8');

      const templates = discoverTemplates(testDir);
      const custom = templates.get('custom-role')!;

      expect(custom.source).toBe('local');
      expect(custom.content).toBe('# Custom Role\n');
    });

    it('should only pick up .md files from template directories', () => {
      writeConfig(minimalConfig);

      const localDir = join(hivePath, 'templates');
      mkdirSync(localDir, { recursive: true });
      writeFileSync(join(localDir, 'valid.md'), '# Valid\n', 'utf-8');
      writeFileSync(join(localDir, 'ignored.txt'), 'not a template', 'utf-8');
      writeFileSync(join(localDir, 'also-ignored.yaml'), 'key: value', 'utf-8');

      const templates = discoverTemplates(testDir);

      expect(templates.has('valid')).toBe(true);
      expect(templates.has('ignored')).toBe(false);
      expect(templates.has('also-ignored')).toBe(false);
    });

    it('should respect templates.dir config override', () => {
      const customDir = join(testDir, 'my-templates');
      mkdirSync(customDir, { recursive: true });
      writeFileSync(join(customDir, 'sre.md'), '# Custom SRE from custom dir\n', 'utf-8');

      writeConfig({
        ...minimalConfig,
        templates: { dir: 'my-templates' },
      });

      const templates = discoverTemplates(testDir);
      const sre = templates.get('sre')!;

      expect(sre.source).toBe('local');
      expect(sre.content).toBe('# Custom SRE from custom dir\n');
    });
  });

  // ── localTemplatesDir ──────────────────────────────────────────────

  describe('localTemplatesDir', () => {
    it('should return .hive/templates/ by default', () => {
      writeConfig(minimalConfig);
      const dir = localTemplatesDir(testDir);
      expect(dir).toBe(join(testDir, '.hive', 'templates'));
    });

    it('should respect templates.dir config override', () => {
      writeConfig({
        ...minimalConfig,
        templates: { dir: 'custom/path' },
      });

      const dir = localTemplatesDir(testDir);
      expect(dir).toBe(join(testDir, 'custom/path'));
    });

    it('should fall back to cwd if no .hive/ directory found', () => {
      const noHive = mkdtempSync(join(tmpdir(), 'no-hive-'));
      try {
        const dir = localTemplatesDir(noHive);
        expect(dir).toBe(join(noHive, '.hive', 'templates'));
      } finally {
        rmSync(noHive, { recursive: true, force: true });
      }
    });
  });

  // ── globalTemplatesDir ─────────────────────────────────────────────

  describe('globalTemplatesDir', () => {
    it('should return ~/.config/agenthive/templates/', () => {
      const dir = globalTemplatesDir();
      expect(dir).toBe(join(homedir(), '.config', 'agenthive', 'templates'));
    });
  });
});
