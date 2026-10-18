// Tests for the F2 Loop Breaker wiring in sundayd's AgentLoop.
// A scripted mock provider loops the same tool call; the guard must trip
// within threshold steps, emit `loop-guard-paused`, and stop the turn.
import { describe, expect, it } from 'vitest';
import { toolDefinitionSchema, type ChatEvent } from '@sunday/protocol';
import { MockChatProvider, ProviderRegistry, type ChatChunk } from '@sunday/gateway';
import { ToolRegistry, type Tool, type ToolContext } from '@sunday/tools';
import { AgentLoop, type AgentLoopOptions } from './loop.js';
import { PolicyGate } from './policy.js';
import type { StoredSession } from './sessions.js';

function registry(opts?: { failReads?: boolean }): { reg: ToolRegistry; executed: string[] } {
  const executed: string[] = [];
  const reg = new ToolRegistry();
  const mk = (name: string): Tool => ({
    definition: toolDefinitionSchema.parse({
      name,
      description: `${name} (test double)`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }),
    execute: async (_args: Record<string, unknown>, _ctx: ToolContext) => {
      executed.push(name);
      if (opts?.failReads && name === 'read_file') {
        return { output: 'Error: ENOENT: no such file or directory', isError: true };
      }
      return { output: `${name} executed` };
    },
  });
  reg.register(mk('read_file'));
  reg.register(mk('list_dir'));
  return { reg, executed };
}

function callChunk(id: string, name: string, args: Record<string, unknown>): ChatChunk {
  return { type: 'tool-call', call: { id, name, arguments: args } };
}

const doneChunk: ChatChunk = { type: 'done', finishReason: 'stop' };

function newSession(): StoredSession {
  const now = new Date().toISOString();
  return { id: 's1', title: 't', createdAt: now, updatedAt: now, messages: [] };
}

async function runWithScript(opts: {
  scripts: ChatChunk[][];
  loopGuard?: AgentLoopOptions['loopGuard'];
  failReads?: boolean;
}): Promise<{ events: ChatEvent[]; executed: string[] }> {
  const { reg, executed } = registry({ failReads: opts.failReads });
  const providers = new ProviderRegistry();
  providers.register(new MockChatProvider({ scripts: opts.scripts, id: 'mock' }));
  const events: ChatEvent[] = [];
  const loop = new AgentLoop(
    { tools: reg, providers },
    { event: (_s, _t, e) => events.push(e) },
    { policy: new PolicyGate(), defaultModel: 'mock:mock-model', loopGuard: opts.loopGuard },
  );
  await loop.runTurn('turn-1', newSession(), 'go', { model: 'mock:mock-model' });
  return { events, executed };
}

function pauseEvents(events: ChatEvent[]) {
  return events.filter((e) => e.type === 'loop-guard-paused');
}

describe('F2 Loop Breaker wiring (AgentLoop)', () => {
  it('trips on the 3rd identical call and pauses the turn', async () => {
    const stuck = { path: '/stuck.ts' };
    const { events, executed } = await runWithScript({
      scripts: [
        [callChunk('c1', 'read_file', stuck)],
        [callChunk('c2', 'read_file', stuck)],
        [callChunk('c3', 'read_file', stuck)],
        [callChunk('c4', 'read_file', stuck)], // never reached
        [doneChunk],
      ],
    });
    // Only 2 executions — the 3rd was blocked pre-execution.
    expect(executed).toEqual(['read_file', 'read_file']);
    const paused = pauseEvents(events);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({
      type: 'loop-guard-paused',
      kind: 'repeated-tool-args',
      action: 'pause',
    });
    // Pause ends the turn gracefully.
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: 'turn-end', finishReason: 'stop' });
  });

  it('abort action ends the turn with turn-error', async () => {
    const stuck = { path: '/stuck.ts' };
    const { events, executed } = await runWithScript({
      loopGuard: { action: 'abort' },
      scripts: [
        [callChunk('c1', 'read_file', stuck)],
        [callChunk('c2', 'read_file', stuck)],
        [callChunk('c3', 'read_file', stuck)],
        [doneChunk],
      ],
    });
    expect(executed).toHaveLength(2);
    expect(pauseEvents(events)[0]).toMatchObject({ action: 'abort' });
    const last = events[events.length - 1];
    expect(last.type).toBe('turn-error');
  });

  it('disabled guard lets the loop run free', async () => {
    const stuck = { path: '/stuck.ts' };
    const { events, executed } = await runWithScript({
      loopGuard: { enabled: false },
      scripts: [
        [callChunk('c1', 'read_file', stuck)],
        [callChunk('c2', 'read_file', stuck)],
        [callChunk('c3', 'read_file', stuck)],
        [doneChunk],
      ],
    });
    expect(executed).toHaveLength(3);
    expect(pauseEvents(events)).toHaveLength(0);
  });

  it('trips on repeated failures', async () => {
    const { events, executed } = await runWithScript({
      failReads: true,
      scripts: [
        [callChunk('c1', 'read_file', { path: '/a.ts' })],
        [callChunk('c2', 'read_file', { path: '/b.ts' })],
        [callChunk('c3', 'read_file', { path: '/c.ts' })],
        [doneChunk],
      ],
    });
    // All 3 executed (failures are only known post-execution), then paused.
    expect(executed).toHaveLength(3);
    expect(pauseEvents(events)[0]).toMatchObject({ kind: 'repeated-failure' });
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', finishReason: 'stop' });
  });

  it('varied calls do not trip (integration false-positive check)', async () => {
    const { events, executed } = await runWithScript({
      scripts: [
        [callChunk('c1', 'read_file', { path: '/a.ts' })],
        [callChunk('c2', 'list_dir', { path: '/src' })],
        [callChunk('c3', 'read_file', { path: '/b.ts' })],
        [doneChunk],
      ],
    });
    expect(executed).toEqual(['read_file', 'list_dir', 'read_file']);
    expect(pauseEvents(events)).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end', finishReason: 'stop' });
  });

  it('custom threshold is honored', async () => {
    const stuck = { path: '/stuck.ts' };
    const { executed } = await runWithScript({
      loopGuard: { threshold: 2 },
      scripts: [
        [callChunk('c1', 'read_file', stuck)],
        [callChunk('c2', 'read_file', stuck)],
        [callChunk('c3', 'read_file', stuck)],
        [doneChunk],
      ],
    });
    expect(executed).toHaveLength(1);
  });
});
