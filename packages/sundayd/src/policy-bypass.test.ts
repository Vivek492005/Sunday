// SEC-01 regression: orchestrator sub-agent loops must enforce the daemon's
// approval gate. Before the fix, runSubAgent built its AgentLoop with a fresh
// default PolicyGate (empty dangerous set), so dangerous tools ran without
// approval inside feature-agent / verifier turns.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolDefinitionSchema, type ChatEvent } from '@sunday/protocol';
import { MockChatProvider, ProviderRegistry, type ChatChunk } from '@sunday/gateway';
import { ToolRegistry, type Tool, type ToolContext } from '@sunday/tools';
import { SundayDaemon } from './daemon.js';
import { PolicyGate, syncDangerousFlags } from './policy.js';

/** A registry with a single dangerous tool that records execution. */
function dangerousRegistry(onExecute: () => void): ToolRegistry {
  const registry = new ToolRegistry();
  const definition = toolDefinitionSchema.parse({
    name: 'dangerous_tool',
    description: 'A dangerous test tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    dangerous: true,
  });
  const tool: Tool = {
    definition,
    execute: async (_args: Record<string, unknown>, _ctx: ToolContext) => {
      onExecute();
      return { output: 'executed' };
    },
  };
  registry.register(tool);
  return registry;
}

function toolCallScript(): ChatChunk[][] {
  return [
    [
      {
        type: 'tool-call',
        call: { id: 'call-1', name: 'dangerous_tool', arguments: {} },
      },
    ],
    [{ type: 'done', finishReason: 'stop' }],
  ];
}

async function makeDaemon(tools: ToolRegistry, gate: PolicyGate): Promise<SundayDaemon> {
  const dir = await mkdtemp(join(tmpdir(), 'sunday-policy-bypass-'));
  const providers = new ProviderRegistry();
  providers.register(new MockChatProvider({ scripts: toolCallScript(), id: 'mock' }));
  return new SundayDaemon({
    sessionsDir: join(dir, 'sessions'),
    defaultModel: 'mock:mock-model',
    providers,
    tools,
    policyGate: gate,
    onShutdown: () => undefined,
    onStdinClose: () => undefined,
  });
}

describe('SEC-01: sub-agent approval gate', () => {
  it('denies a dangerous tool in a sub-agent turn without approval', async () => {
    let executed = 0;
    const tools = dangerousRegistry(() => {
      executed += 1;
    });
    const gate = new PolicyGate();
    syncDangerousFlags(gate, tools);
    const daemon = await makeDaemon(tools, gate);

    const seen: ChatEvent[] = [];
    await daemon.getOrchestratorHost().runSubAgent({
      title: 'test sub-agent',
      cwd: process.cwd(),
      systemPrompt: 'test',
      prompt: 'run the dangerous tool',
      tools,
      maxIterations: 5,
      onEvent: (e) => seen.push(e),
    });

    expect(executed).toBe(0);
    const results = seen.filter((e) => e.type === 'tool-result');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('tool-result');
    if (results[0].type === 'tool-result') {
      expect(results[0].result.isError).toBe(true);
      const text = results[0].result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      expect(text).toContain('Policy denied');
    }
  });

  it('runs the dangerous tool in a sub-agent turn once approved on the shared gate', async () => {
    let executed = 0;
    const tools = dangerousRegistry(() => {
      executed += 1;
    });
    const gate = new PolicyGate();
    syncDangerousFlags(gate, tools);
    gate.approve('dangerous_tool');
    const daemon = await makeDaemon(tools, gate);

    const seen: ChatEvent[] = [];
    await daemon.getOrchestratorHost().runSubAgent({
      title: 'test sub-agent',
      cwd: process.cwd(),
      systemPrompt: 'test',
      prompt: 'run the dangerous tool',
      tools,
      maxIterations: 5,
      onEvent: (e) => seen.push(e),
    });

    expect(executed).toBe(1);
  });
});
