// Tests for the self-improving agent learning loop (rule-extractor.ts):
// correction detection, rule extraction templates, the file-backed
// RuleStore roundtrip, and system-prompt rendering.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuleStore,
  detectCorrection,
  extractRule,
  rulesToPrompt,
  type LearnedRule,
} from './rule-extractor.js';

describe('detectCorrection', () => {
  const corrections: Array<[string, string?]> = [
    ['no, use pnpm instead of npm'],
    ['Nope, that branch is wrong'],
    ['wrong, the port should be 3000'],
    ['not quite — we deploy on Fridays'],
    ['Actually, write the tests in vitest'],
    ["don't run tests in parallel"],
    ["don't do that"],
    ['do not commit directly to main'],
    ['never use var, use const'],
    ['I said the staging branch, not main'],
    ['use pnpm instead of npm'],
    ['you should have asked before deleting'],
    ["that's not what I asked for"],
  ];
  for (const [msg, action] of corrections) {
    it(`detects correction: "${msg}"`, () => {
      const { isCorrection, confidence } = detectCorrection(msg, action);
      expect(isCorrection).toBe(true);
      expect(confidence).toBeGreaterThanOrEqual(0.5);
      expect(confidence).toBeLessThanOrEqual(1);
    });
  }

  const nonCorrections: Array<[string, string?]> = [
    ['run the tests'],
    ['what does this file do?'],
    ['yes, that looks good', 'ran the tests'],
    ['add a login page'],
    ['can you explain the error?'],
    ['thanks'],
    [''],
    ['please run the build now'],
  ];
  for (const [msg, action] of nonCorrections) {
    it(`ignores non-correction: "${msg}"`, () => {
      const { isCorrection, confidence } = detectCorrection(msg, action);
      expect(isCorrection).toBe(false);
      expect(confidence).toBeLessThan(0.5);
    });
  }

  it('boosts confidence when the message references the previous action', () => {
    const without = detectCorrection('hmm, try that again');
    const withAction = detectCorrection('hmm, try that again', 'deleted the file');
    expect(withAction.confidence).toBeGreaterThan(without.confidence);
  });

  it('clamps confidence to [0, 1] on stacked signals', () => {
    const { confidence } = detectCorrection(
      "no, don't do that, I said use pnpm instead of npm, you should have asked",
    );
    expect(confidence).toBeLessThanOrEqual(1);
    expect(confidence).toBeGreaterThanOrEqual(0);
  });
});

describe('extractRule', () => {
  it('maps "use X instead of Y" to an Always rule', () => {
    expect(extractRule('no, use pnpm instead of npm')).toBe('Always use pnpm instead of npm.');
  });

  it('appends the context scope when provided', () => {
    expect(extractRule('no, use pnpm instead of npm', 'for package commands')).toBe(
      'Always use pnpm instead of npm for package commands.',
    );
  });

  it('maps "don\'t ..." to a Never rule', () => {
    expect(extractRule("don't run tests in parallel")).toBe('Never run tests in parallel.');
  });

  it('maps "do not ..." to a Never rule', () => {
    expect(extractRule('do not commit directly to main')).toBe('Never commit directly to main.');
  });

  it('maps leading "never ..." to a Never rule', () => {
    expect(extractRule('never use var')).toBe('Never use var.');
  });

  it('maps leading "always ..." to an Always rule', () => {
    expect(extractRule('always sign your commits')).toBe('Always sign your commits.');
  });

  it('falls back to a "User preference:" rule for free-form corrections', () => {
    expect(extractRule('actually the API key lives in the vault')).toBe(
      'User preference: The API key lives in the vault.',
    );
  });

  it('returns null when nothing extractable remains', () => {
    expect(extractRule('nope')).toBeNull();
    expect(extractRule('')).toBeNull();
    expect(extractRule('  ')).toBeNull();
  });
});

describe('RuleStore', () => {
  let dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function freshStore(): Promise<RuleStore> {
    const dir = await mkdtemp(join(tmpdir(), 'sunday-rules-'));
    dirs.push(dir);
    return new RuleStore({ homeDir: dir });
  }

  it('lists nothing when the file does not exist', async () => {
    const store = await freshStore();
    expect(await store.list()).toEqual([]);
  });

  it('roundtrips add/list/remove', async () => {
    const store = await freshStore();
    const a = await store.add('Always use pnpm instead of npm.', 'myapp');
    const b = await store.add('Never run tests in parallel.');
    expect(a.id).toBeTruthy();
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(a.source).toBe('correction');

    const listed = await store.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toEqual(a);
    expect(listed[1]).toEqual(b);
    expect(listed[0]!.project).toBe('myapp');
    expect(listed[1]!.project).toBe('');

    expect(await store.remove(a.id)).toBe(true);
    const after = await store.list();
    expect(after.map((r) => r.id)).toEqual([b.id]);

    expect(await store.remove('does-not-exist')).toBe(false);
  });

  it('survives a fresh store instance over the same home dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sunday-rules-'));
    dirs.push(dir);
    const first = new RuleStore({ homeDir: dir });
    const added = await first.add('Always use pnpm instead of npm.');
    const second = new RuleStore({ homeDir: dir });
    expect(await second.list()).toEqual([added]);
  });
});

describe('rulesToPrompt', () => {
  it('returns an empty string for no rules', () => {
    expect(rulesToPrompt([])).toBe('');
  });

  it('formats rules as a prompt section', () => {
    const rules: LearnedRule[] = [
      { id: 'a', rule: 'Always use pnpm instead of npm.', createdAt: '2026-10-07T00:00:00.000Z', source: 'correction', project: '' },
      { id: 'b', rule: 'Never run tests in parallel.', createdAt: '2026-10-07T00:01:00.000Z', source: 'correction', project: '' },
    ];
    expect(rulesToPrompt(rules)).toBe(
      'Learned rules (from your corrections):\n' +
        '- Always use pnpm instead of npm.\n' +
        '- Never run tests in parallel.',
    );
  });
});
