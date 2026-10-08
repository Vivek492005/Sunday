// Tests for the A1 async agent task store: lifecycle (create → claim →
// complete), ownership isolation, input validation, disk persistence
// (0600), and tolerance of a corrupt store file.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentTaskStore,
  validateTaskInput,
  publicTask,
  AGENT_TASK_PROMPT_MAX,
  AGENT_TASK_REPO_CONTEXT_MAX,
} from './agent-tasks.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunday-agent-tasks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateTaskInput', () => {
  it('accepts a minimal prompt', () => {
    expect(validateTaskInput('do the thing', undefined)).toEqual([]);
  });

  it('rejects missing/empty prompts', () => {
    expect(validateTaskInput(undefined, undefined).length).toBeGreaterThan(0);
    expect(validateTaskInput('   ', undefined).length).toBeGreaterThan(0);
    expect(validateTaskInput(42, undefined).length).toBeGreaterThan(0);
  });

  it('rejects oversized prompts and repo contexts', () => {
    expect(validateTaskInput('x'.repeat(AGENT_TASK_PROMPT_MAX + 1), undefined).length).toBeGreaterThan(0);
    expect(
      validateTaskInput('ok', 'x'.repeat(AGENT_TASK_REPO_CONTEXT_MAX + 1)).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a non-string repo_context', () => {
    expect(validateTaskInput('ok', { nope: 1 }).length).toBeGreaterThan(0);
  });
});

describe('AgentTaskStore lifecycle', () => {
  it('create → claim → complete', () => {
    const store = new AgentTaskStore(dir);
    const created = store.create('user-1', 'write tests', 'repo: sunday');
    expect(created.status).toBe('queued');
    expect(created.id).toMatch(/^task_[A-Za-z0-9]+$/);
    expect(created.createdAt).toBeTruthy();

    const claimed = store.claim('user-1', created.id);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimedAt).toBeTruthy();

    const done = store.complete('user-1', created.id, { result: 'all green' });
    expect(done?.status).toBe('completed');
    expect(done?.result).toBe('all green');
    expect(done?.completedAt).toBeTruthy();
  });

  it('complete with an error marks the task failed', () => {
    const store = new AgentTaskStore(dir);
    const t = store.create('user-1', 'p');
    store.claim('user-1', t.id);
    const failed = store.complete('user-1', t.id, { error: 'boom' });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('boom');
  });

  it('double-claim returns undefined and a second complete is rejected', () => {
    const store = new AgentTaskStore(dir);
    const t = store.create('user-1', 'p');
    expect(store.claim('user-1', t.id)?.status).toBe('claimed');
    expect(store.claim('user-1', t.id)).toBeUndefined();
    store.complete('user-1', t.id, { result: 'r' });
    expect(store.complete('user-1', t.id, { result: 'again' })).toBeUndefined();
  });

  it('claim on an unknown id returns undefined', () => {
    const store = new AgentTaskStore(dir);
    expect(store.claim('user-1', 'task_nope')).toBeUndefined();
  });

  it('lists newest-first', () => {
    const store = new AgentTaskStore(dir, { now: (() => { let t = 1000; return () => (t += 1000); })() });
    const a = store.create('user-1', 'first');
    const b = store.create('user-1', 'second');
    expect(a.id).not.toBe(b.id);
    const listed = store.list('user-1');
    expect(listed.map((t) => t.prompt)).toEqual(['second', 'first']);
  });
});

describe('ownership isolation', () => {
  it('a user cannot see, claim, or complete another identity\'s tasks', () => {
    const store = new AgentTaskStore(dir);
    const t = store.create('user-1', 'secret prompt');
    expect(store.list('user-2')).toEqual([]);
    expect(store.get('user-2', t.id)).toBeUndefined();
    expect(store.claim('user-2', t.id)).toBeUndefined();
    expect(store.complete('user-2', t.id, { result: 'x' })).toBeUndefined();
    // The owner's task is untouched.
    expect(store.get('user-1', t.id)?.status).toBe('queued');
  });

  it('publicTask strips the internal userId', () => {
    const store = new AgentTaskStore(dir);
    const t = store.create('user-1', 'p');
    const pub = publicTask(t);
    expect(pub).not.toHaveProperty('userId');
    expect(pub.id).toBe(t.id);
    expect(pub.prompt).toBe('p');
  });
});

describe('persistence', () => {
  it('survives a reload and the file is 0600', () => {
    const a = new AgentTaskStore(dir);
    const t = a.create('user-1', 'persist me');
    const file = join(dir, 'agent-tasks.json');
    expect(existsSync(file)).toBe(true);
    // Unix permission bits not supported on Windows.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const b = new AgentTaskStore(dir);
    expect(b.get('user-1', t.id)?.prompt).toBe('persist me');
    expect(b.size()).toBe(1);
  });

  it('tolerates a corrupt store file', () => {
    writeFileSync(join(dir, 'agent-tasks.json'), '{not json');
    const store = new AgentTaskStore(dir);
    expect(store.size()).toBe(0);
    // And it recovers on the next write.
    store.create('user-1', 'p');
    expect(new AgentTaskStore(dir).size()).toBe(1);
  });

  it('prunes terminal tasks older than the TTL on write', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const store = new AgentTaskStore(dir, { now: () => now });
    const t = store.create('user-1', 'old');
    store.complete('user-1', t.id, { result: 'r' });
    expect(store.size()).toBe(1);
    // Advance 8 days and trigger another persist.
    now = Date.parse('2026-10-09T00:00:00Z');
    store.create('user-1', 'new');
    expect(new AgentTaskStore(dir).size()).toBe(1);
    expect(new AgentTaskStore(dir).list('user-1')[0].prompt).toBe('new');
  });

  it('clamps huge results and errors', () => {
    const store = new AgentTaskStore(dir);
    const t = store.create('user-1', 'p');
    store.claim('user-1', t.id);
    const done = store.complete('user-1', t.id, {
      result: 'x'.repeat(300_000),
      error: 'e'.repeat(10_000),
    });
    expect(done?.result?.length).toBeLessThanOrEqual(200_000);
    expect(done?.error?.length).toBeLessThanOrEqual(4000);
  });
});
