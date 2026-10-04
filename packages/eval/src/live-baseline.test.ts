// @sunday/eval — live baseline tests.
//
// Covers the skip-mode key detection and the LiveBaselineAdapter against a
// fake daemon speaking the CURRENT wire protocol (nested chat/event params).
// No provider keys or network are needed.

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveBaselineAdapter, detectProviderKeys } from './adapters.js';
import type { EvalTask } from './types.js';

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'test/fixtures/fake-baseline-sundayd.mjs',
);

const dummyTask: EvalTask = {
  id: 'dummy',
  title: 'dummy',
  prompt: 'hello',
  setup: () => {},
  script: [],
  check: () => ({ pass: true, notes: '' }),
};

describe('detectProviderKeys', () => {
  it('returns empty when no keys are set', () => {
    expect(detectProviderKeys({})).toEqual([]);
  });

  it('ignores blank values', () => {
    expect(detectProviderKeys({ OPENROUTER_API_KEY: '   ', GROQ_API_KEY: '' })).toEqual([]);
  });

  it('detects each key independently and never returns values', () => {
    expect(detectProviderKeys({ OPENROUTER_API_KEY: 'sk-secret' })).toEqual(['OPENROUTER_API_KEY']);
    expect(detectProviderKeys({ GROQ_API_KEY: 'gsk-secret' })).toEqual(['GROQ_API_KEY']);
    expect(detectProviderKeys({ OPENROUTER_API_KEY: 'a', GROQ_API_KEY: 'b' })).toEqual([
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
    ]);
  });
});

describe('LiveBaselineAdapter (fake daemon, current wire protocol)', () => {
  it('harvests tool calls, result validity, and token usage from nested chat/event params', async () => {
    const adapter = new LiveBaselineAdapter(fixture, { taskTimeoutMs: 15_000 });
    const { transcript, usage } = await adapter.runTaskDetailed(dummyTask, '/tmp');

    expect(transcript.map((t) => t.tool)).toEqual(['read_file', 'run_command']);
    expect(transcript[0].args).toEqual({ path: 'a.txt' });
    expect(transcript[0].valid).toBe(true);
    expect(transcript[0].result.output).toBe('hello');
    // c2's tool-result had isError: true → marked invalid
    expect(transcript[1].valid).toBe(false);
    expect(transcript[1].result.output).toBe('boom');
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 25 });
  }, 30_000);

  it('runTask returns just the transcript', async () => {
    const adapter = new LiveBaselineAdapter(fixture, { taskTimeoutMs: 15_000 });
    const transcript = await adapter.runTask(dummyTask, '/tmp');
    expect(transcript).toHaveLength(2);
  }, 30_000);
});
