// Tests for Group B4 agent-mode tool gating in the agent loop.
// A mock provider emits write_file + read_file calls; restricted modes
// must deny the write with a mode-specific message without executing it.
import { describe, expect, it } from 'vitest';
import { toolDefinitionSchema, type ChatEvent } from '@sunday/protocol';
import { MockChatProvider, ProviderRegistry, type ChatChunk } from '@sunday/gateway';
import { ToolRegistry, type Tool, type ToolContext } from '@sunday/tools';
import { AgentLoop } from './loop.js';
import { PolicyGate } from './policy.js';
import type { StoredSession } from './sessions.js';

const executed: string[] = [];

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ['write_file', 'read_file']) {
    const tool: Tool = {
      definition: toolDefinitionSchema.parse({
        name,
        description: `${name} (test double)`,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }),
      execute: async (_args: Record<string, unknown>, _ctx: ToolContext) => {
        executed.push(name);
        return { output: `${name} executed` };
      },
    };
    reg.register(tool);
  }
  return reg;
}

function script(): ChatChunk[][] {
  return [
    [
      { type: 'tool-call', call: { id: 'c1', name: 'write_file', arguments: {} } },
      { type: 'tool-call', call: { id: 'c2', name: 'read_file', arguments: {} } },
    ],
    [{ type: 'done', finishReason: 'stop' }],
  ];
}

async function runTurn(mode: 'auto' | 'reviewer' | 'architect'): Promise<StoredSession> {
  executed.length = 0;
  const providers = new ProviderRegistry();
  providers.register(new MockChatProvider({ scripts: script(), id: 'mock' }));
  const events: ChatEvent[] = [];
  const loop = new AgentLoop(
    { tools: registry(), providers },
    { event: (_s, _t, e) => events.push(e) },
    { policy: new PolicyGate(), defaultModel: 'mock:mock-model', agentMode: mode },
  );
  const now = new Date().toISOString();
  const session: StoredSession = { id: 's1', title: 't', createdAt: now, updatedAt: now, messages: [] };
  await loop.runTurn('turn-1', session, 'go', { model: 'mock:mock-model' });
  return session;
}

function toolTexts(session: StoredSession): string[] {
  return session.messages
    .filter((m) => m.role === 'tool')
    .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
}

describe('agent-mode tool gating (B4)', () => {
  it('auto mode executes both reads and writes', async () => {
    const session = await runTurn('auto');
    expect(executed).toEqual(['write_file', 'read_file']);
    expect(toolTexts(session).some((t) => t.includes('write_file executed'))).toBe(true);
  });

  it('reviewer mode blocks write_file with the contract message, allows read_file', async () => {
    const session = await runTurn('reviewer');
    expect(executed).toEqual(['read_file']);
    const texts = toolTexts(session);
    expect(texts.some((t) => t.includes('Reviewer mode: writes disabled'))).toBe(true);
    expect(texts.some((t) => t.includes('read_file executed'))).toBe(true);
  });

  it('architect mode blocks write_file but allows read_file', async () => {
    const session = await runTurn('architect');
    expect(executed).toEqual(['read_file']);
    const texts = toolTexts(session);
    expect(texts.some((t) => t.includes('Architect mode'))).toBe(true);
  });
});
