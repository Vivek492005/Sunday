// Tests for the Second Brain memory store: save/list roundtrip, secret
// refusal, search relevance ordering, heuristic transcript extraction, and
// delete. All tests run against a temp homeDir so the real home is untouched.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { SecretRefusedError } from './memory.js';
import {
  MemoryStore,
  extractMemories,
  formatMemoriesForPrompt,
} from './second-brain.js';

let homeDir: string;
let store: MemoryStore;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'sunday-second-brain-'));
  store = new MemoryStore({ homeDir });
});

describe('MemoryStore.save / list', () => {
  it('round-trips a memory with assigned id and timestamp', async () => {
    const saved = await store.save({
      text: 'We decided to use pnpm for all packages.',
      project: 'sunday',
      tags: ['decision'],
      source: 'manual',
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved.text).toBe('We decided to use pnpm for all packages.');
    expect(saved.source).toBe('manual');

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.id);
  });

  it('lists newest first', async () => {
    await store.save({ text: 'first memory kept', project: 'p', tags: [], source: 'manual' });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ text: 'second memory kept', project: 'p', tags: [], source: 'manual' });

    const listed = await store.list();
    expect(listed.map((m) => m.text)).toEqual(['second memory kept', 'first memory kept']);
  });

  it('refuses empty text', async () => {
    await expect(
      store.save({ text: '   ', project: 'p', tags: [], source: 'manual' }),
    ).rejects.toThrow(/empty/);
  });
});

describe('secret refusal', () => {
  it('throws SecretRefusedError and writes nothing for an api_key assignment', async () => {
    await expect(
      store.save({
        text: 'my api_key=sk-1234567890abcdef is stored somewhere',
        project: 'p',
        tags: [],
        source: 'manual',
      }),
    ).rejects.toThrowError(SecretRefusedError);
    expect(await store.list()).toHaveLength(0);
  });

  it('refuses OpenAI-style sk- keys inline', async () => {
    await expect(
      store.save({
        text: 'the token was sk-abcdefghijklmnopqrstuvwxyz',
        project: 'p',
        tags: [],
        source: 'manual',
      }),
    ).rejects.toThrowError(SecretRefusedError);
  });
});

describe('MemoryStore.search', () => {
  it('orders by relevance: tag + keyword matches beat keyword-only matches', async () => {
    await store.save({
      text: 'The build machine has only two CPUs.',
      project: 'sunday',
      tags: ['note'],
      source: 'manual',
    });
    await store.save({
      text: 'We decided to build sequentially with concurrency one.',
      project: 'sunday',
      tags: ['decision', 'build'],
      source: 'auto',
    });

    const results = await store.search('build', { tags: ['decision'] });
    expect(results).toHaveLength(2);
    expect(results[0]?.text).toContain('concurrency one');
    expect(results[1]?.text).toContain('two CPUs');
  });

  it('filters by project', async () => {
    await store.save({ text: 'shared decision about builds', project: 'sunday', tags: [], source: 'auto' });
    await store.save({ text: 'other decision about builds', project: 'other', tags: [], source: 'auto' });

    const results = await store.search('builds', { project: 'sunday' });
    expect(results).toHaveLength(1);
    expect(results[0]?.project).toBe('sunday');
  });

  it('returns empty when nothing matches', async () => {
    await store.save({ text: 'unrelated note here', project: 'p', tags: [], source: 'manual' });
    expect(await store.search('zebra')).toHaveLength(0);
  });

  it('honours limit', async () => {
    await store.save({ text: 'alpha one note', project: 'p', tags: [], source: 'manual' });
    await store.save({ text: 'alpha two note', project: 'p', tags: [], source: 'manual' });
    expect(await store.search('alpha', { limit: 1 })).toHaveLength(1);
  });
});

describe('MemoryStore.delete', () => {
  it('removes by id and returns true', async () => {
    const saved = await store.save({ text: 'to be deleted', project: 'p', tags: [], source: 'manual' });
    expect(await store.delete(saved.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });

  it('returns false for an unknown id', async () => {
    expect(await store.delete('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('extractMemories', () => {
  it('detects decisions, preferences, and bug fixes', async () => {
    const transcript = [
      { role: 'assistant', content: 'We decided to vendor the VS Code tree instead of using a submodule.' },
      { role: 'user', content: 'I prefer sequential builds. Always build with concurrency one.' },
      { role: 'assistant', content: 'Fixed the Windows NSIS failure by using an absolute OutFile path.' },
      { role: 'user', content: 'Hello, how is your day going?' },
    ];

    const candidates = extractMemories(transcript, 'sunday');
    expect(candidates).toHaveLength(4);
    expect(candidates.map((c) => c.tags)).toEqual([
      ['decision'],
      ['preference'],
      ['preference'],
      ['bugfix'],
    ]);
    for (const c of candidates) {
      expect(c.source).toBe('auto');
      expect(c.project).toBe('sunday');
    }
    expect(candidates[0]?.text).toContain('decided to vendor');
  });

  it('skips candidates that contain secrets', async () => {
    const transcript = [
      { role: 'assistant', content: 'We decided to use api_key=sk-1234567890abcdef for the demo.' },
    ];
    expect(extractMemories(transcript)).toHaveLength(0);
  });

  it('dedupes repeated statements', async () => {
    const transcript = [
      { role: 'user', content: 'I prefer pnpm. I prefer pnpm.' },
    ];
    expect(extractMemories(transcript)).toHaveLength(1);
  });
});

describe('formatMemoriesForPrompt', () => {
  it('produces a compact bullet list', async () => {
    const saved = await store.save({
      text: 'We decided to use pnpm for all packages in the monorepo.',
      project: 'sunday',
      tags: ['decision'],
      source: 'auto',
    });
    const out = formatMemoriesForPrompt([saved]);
    expect(out).toContain('Relevant memories from past sessions:');
    expect(out).toContain('[sunday][decision]');
    expect(out).toContain('We decided to use pnpm');
  });

  it('truncates long labels at 60 chars', async () => {
    const saved = await store.save({
      text: 'x'.repeat(100),
      project: 'p',
      tags: ['note'],
      source: 'manual',
    });
    const out = formatMemoriesForPrompt([saved]);
    expect(out).toContain(`${'x'.repeat(60)}…`);
  });

  it('returns empty string for no memories', () => {
    expect(formatMemoriesForPrompt([])).toBe('');
  });
});

describe('cross-project learning (B5)', () => {
  it('projectId is a stable 16-char hash of the workspace root', async () => {
    const { projectId } = await import('./second-brain.js');
    const id = projectId('/tmp/some/workspace');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(projectId('/tmp/some/workspace')).toBe(id);
    expect(projectId('/tmp/other/workspace')).not.toBe(id);
  });

  it('tags memories with the project id on write', async () => {
    const { projectId } = await import('./second-brain.js');
    const pid = projectId('/tmp/proj-a');
    const saved = await store.save({ text: 'project a decision note', project: pid, tags: [], source: 'manual' });
    expect(saved.project).toBe(pid);
  });

  it('listProjects returns distinct sorted project ids', async () => {
    await store.save({ text: 'note one here', project: 'proj-b', tags: [], source: 'manual' });
    await store.save({ text: 'note two here', project: 'proj-a', tags: [], source: 'manual' });
    await store.save({ text: 'note three here', project: 'proj-b', tags: [], source: 'manual' });
    expect(await store.listProjects()).toEqual(['proj-a', 'proj-b']);
  });

  it('queryByProject isolates projects (no cross-project leakage)', async () => {
    await store.save({ text: 'alpha uses pnpm workspaces', project: 'proj-a', tags: [], source: 'manual' });
    await store.save({ text: 'beta uses pnpm workspaces', project: 'proj-b', tags: [], source: 'manual' });
    const a = await store.queryByProject('proj-a', 'pnpm workspaces');
    expect(a).toHaveLength(1);
    expect(a[0]?.project).toBe('proj-a');
    const b = await store.queryByProject('proj-b', 'pnpm workspaces');
    expect(b).toHaveLength(1);
    expect(b[0]?.project).toBe('proj-b');
    const none = await store.queryByProject('proj-c', 'pnpm workspaces');
    expect(none).toHaveLength(0);
  });

  it('queryByProject respects the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save({ text: `shared keyword memory ${i}`, project: 'p', tags: [], source: 'manual' });
    }
    expect(await store.queryByProject('p', 'shared keyword', 3)).toHaveLength(3);
  });

  it('migrates untagged (legacy) memories to "global" on first use', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(homeDir, '.sunday', 'memory');
    await mkdir(dir, { recursive: true });
    // Legacy records: missing/empty project field.
    await writeFile(
      join(dir, 'memories.jsonl'),
      [
        JSON.stringify({ id: 'legacy-1', text: 'old memory without project', timestamp: '2025-01-01T00:00:00.000Z', tags: [], source: 'auto' }),
        JSON.stringify({ id: 'legacy-2', text: 'old memory with empty project', timestamp: '2025-01-02T00:00:00.000Z', project: '', tags: [], source: 'auto' }),
        JSON.stringify({ id: 'tagged-1', text: 'already tagged memory', timestamp: '2025-01-03T00:00:00.000Z', project: 'proj-x', tags: [], source: 'auto' }),
      ].join('\n') + '\n',
    );
    const listed = await store.list();
    expect(listed.find((m) => m.id === 'legacy-1')?.project).toBe('global');
    expect(listed.find((m) => m.id === 'legacy-2')?.project).toBe('global');
    expect(listed.find((m) => m.id === 'tagged-1')?.project).toBe('proj-x');
    expect(await store.listProjects()).toEqual(['global', 'proj-x']);
    // Tagged records are untouched by the migration.
    expect((await store.list()).filter((m) => m.project === 'proj-x')).toHaveLength(1);
  });
});
