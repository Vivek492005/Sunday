/**
 * memoryService tests — REAL MemoryStore (@sunday/skills) over a temp
 * homeDir, no mocks. Covers the save→list round-trip, keyword search,
 * delete, the 4000-char cap, and the load-bearing secret refusal.
 *
 * The secret trigger is `api_key = …`, which matches the
 * 'api-key-assignment' pattern in SECRET_PATTERNS
 * (packages/protocol/src/secrets.ts: /\bapi[_-]?key\s*[:=]/i).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, SecretRefusedError } from '@sunday/skills';
import {
  createMemoryService,
  MAX_MEMORY_TEXT_CHARS,
  type MemoryService,
} from './memoryService.js';

let homeDir: string;
let svc: MemoryService;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-memory-'));
  svc = createMemoryService(new MemoryStore({ homeDir }));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('memoryService (real Second Brain store)', () => {
  it('save → list round-trip: fields, global project, manual source, tags', async () => {
    const saved = await svc.saveMemory({
      text: 'Vivek prefers the Sunday dark theme in the IDE',
      tags: ['preference', 'ui'],
    });
    expect(saved.id).toBeTruthy();
    expect(saved.project).toBe('global');
    expect(saved.source).toBe('manual');
    expect(saved.tags).toEqual(['preference', 'ui']);

    const listed = await svc.listMemories();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.id);
    expect(listed[0]?.text).toBe('Vivek prefers the Sunday dark theme in the IDE');

    // Really on disk, in the temp home — not in-memory state.
    const file = path.join(homeDir, '.sunday', 'memory', 'memories.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('Sunday dark theme');
  });

  it('search finds memories by keyword and returns [] for no match', async () => {
    await svc.saveMemory({ text: 'The release pipeline packages installers with GitHub Actions' });
    await svc.saveMemory({ text: 'Streak freezes are earned every seven days' });

    const hits = await svc.searchMemories('packaging installers');
    expect(hits.map((h) => h.text)).toContain(
      'The release pipeline packages installers with GitHub Actions',
    );

    const byTagWord = await svc.searchMemories('freezes');
    expect(byTagWord).toHaveLength(1);

    expect(await svc.searchMemories('nonexistentkeyword')).toEqual([]);
  });

  it('delete removes the record (true once, false after)', async () => {
    const a = await svc.saveMemory({ text: 'First memory about testing' });
    await svc.saveMemory({ text: 'Second memory about testing' });
    expect(await svc.listMemories()).toHaveLength(2);

    await expect(svc.deleteMemory(a.id)).resolves.toBe(true);
    const after = await svc.listMemories();
    expect(after).toHaveLength(1);
    expect(after[0]?.text).toBe('Second memory about testing');

    await expect(svc.deleteMemory(a.id)).resolves.toBe(false);
    await expect(svc.deleteMemory('')).resolves.toBe(false);
  });

  it('refuses secret-looking text with SecretRefusedError and stores nothing', async () => {
    await expect(
      svc.saveMemory({ text: 'staging api_key = <redacted>' }),
    ).rejects.toBeInstanceOf(SecretRefusedError);
    await expect(svc.listMemories()).resolves.toEqual([]);
  });

  it(`refuses text over the ${MAX_MEMORY_TEXT_CHARS}-char cap with a clear error`, async () => {
    await expect(
      svc.saveMemory({ text: 'x'.repeat(MAX_MEMORY_TEXT_CHARS + 1) }),
    ).rejects.toThrow(/too long/);
    await expect(svc.listMemories()).resolves.toEqual([]);
  });
});
