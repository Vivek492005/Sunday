// F8 User Hooks — acceptance tests (sundayd wiring).
//
// Acceptance gates from the spec:
//  1. Block hook → the tool executes ZERO times.
//  2. Untrusted workspace → ZERO hook execution.
//  3. Hook timeout → the agent loop never hangs.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolDefinitionSchema, type ChatEvent } from '@sunday/protocol';
import { MockChatProvider, ProviderRegistry, type ChatChunk } from '@sunday/gateway';
import { ToolRegistry, type Tool, type ToolContext } from '@sunday/tools';
import { hashHooksBytes, recordConsent } from '@sunday/hooks';
import { AgentLoop, type AgentLoopOptions } from './loop.js';
import { PolicyGate } from './policy.js';
import type { StoredSession } from './sessions.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function workspace(home: string, hooksJson: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'hooks-ws-'));
  dirs.push(root);
  mkdirSync(join(root, '.sunday'), { recursive: true });
  const raw = JSON.stringify(hooksJson);
  writeFileSync(join(root, '.sunday', 'hooks.json'), raw);
  // Grant first-run consent for this exact hash (as the extension UI would).
  recordConsent(hashHooksBytes(raw), root, home);
  return root;
}

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'hooks-home-'));
  dirs.push(h);
  return h;
}

function registry(): { reg: ToolRegistry; executed: string[] } {
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
      return { output: `${name} executed` };
    },
  });
  reg.register(mk('read_file'));
  reg.register(mk('write_file'));
  return { reg, executed };
}

function callChunk(id: string, name: string, args: Record<string, unknown>): ChatChunk {
  return { type: 'tool-call', call: { id, name, arguments: args } };
}
const doneChunk: ChatChunk = { type: 'done', finishReason: 'stop' };

function newSession(cwd: string): StoredSession {
  const now = new Date().toISOString();
  return { id: 's1', title: 't', createdAt: now, updatedAt: now, messages: [], cwd };
}

async function runWithScript(opts: {
  scripts: ChatChunk[][];
  hooks?: AgentLoopOptions['hooks'];
  cwd: string;
}): Promise<{ events: ChatEvent[]; executed: string[] }> {
  const { reg, executed } = registry();
  const providers = new ProviderRegistry();
  providers.register(new MockChatProvider({ scripts: opts.scripts, id: 'mock' }));
  const events: ChatEvent[] = [];
  const loop = new AgentLoop(
    { tools: reg, providers },
    { event: (_s, _t, e) => events.push(e) },
    {
      policy: new PolicyGate(),
      defaultModel: 'mock:mock-model',
      loopGuard: { enabled: false },
      hooks: opts.hooks,
    },
  );
  await loop.runTurn('turn-1', newSession(opts.cwd), 'go', { model: 'mock:mock-model' });
  return { events, executed };
}

const BLOCK_SECRET_HOOKS = {
  version: 1,
  hooks: [
    {
      name: 'test:block-secret',
      event: 'pre_tool',
      match: { tools: ['read_file'], paths: ['**/secrets.txt'] },
      actions: [{ type: 'block', reason: 'policy: no secrets.txt reads' }],
    },
  ],
};

describe('F8 hooks (AgentLoop wiring)', () => {
  it('ACCEPTANCE: block hook → tool executes ZERO times', async () => {
    const h = home();
    const root = workspace(h, BLOCK_SECRET_HOOKS);
    const { events, executed } = await runWithScript({
      cwd: root,
      hooks: { trusted: true, homeDir: h, workspaceRoot: root },
      scripts: [[callChunk('c1', 'read_file', { path: join(root, 'secrets.txt') })], [doneChunk]],
    });
    // The tool must NEVER execute.
    expect(executed).toEqual([]);
    // The block reason is fed back as the tool result.
    const results = events.filter((e) => e.type === 'tool-result');
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('policy: no secrets.txt reads');
    // Turn still ends cleanly.
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-end' });
  });

  it('ACCEPTANCE: untrusted workspace → ZERO hook execution', async () => {
    const h = home();
    const root = workspace(h, BLOCK_SECRET_HOOKS);
    const { executed } = await runWithScript({
      cwd: root,
      hooks: { trusted: false, homeDir: h, workspaceRoot: root },
      scripts: [[callChunk('c1', 'read_file', { path: join(root, 'secrets.txt') })], [doneChunk]],
    });
    // Hooks don't run in an untrusted workspace — the tool executes normally.
    expect(executed).toEqual(['read_file']);
  });

  it('ACCEPTANCE: hook timeout never hangs the loop', async () => {
    const h = home();
    const sleepCmd = process.platform === 'win32' ? 'powershell' : 'sleep';
    const sleepArgs =
      process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 30'] : ['30'];
    const root = workspace(h, {
      version: 1,
      hooks: [
        {
          name: 'test:slow-hook',
          event: 'pre_tool',
          actions: [
            { type: 'run_command', command: sleepCmd, args: sleepArgs, timeoutMs: 400 },
          ],
        },
      ],
    });
    const start = Date.now();
    const { executed } = await runWithScript({
      cwd: root,
      hooks: { trusted: true, homeDir: h, workspaceRoot: root },
      scripts: [[callChunk('c1', 'read_file', { path: 'a.ts' })], [doneChunk]],
    });
    const elapsed = Date.now() - start;
    // The 30s sleep was killed at ~400ms; the tool still executed.
    expect(elapsed).toBeLessThan(15000);
    expect(executed).toEqual(['read_file']);
  });

  it('modify_input rewrites args before dispatch', async () => {
    const h = home();
    const root = workspace(h, {
      version: 1,
      hooks: [
        {
          name: 'test:add-flag',
          event: 'pre_tool',
          match: { tools: ['write_file'] },
          actions: [{ type: 'modify_input', op: 'set_arg', key: 'injected', value: 'yes' }],
        },
      ],
    });
    const { reg, executed } = registry();
    // Capture the args the tool actually received.
    let seenArgs: Record<string, unknown> | undefined;
    const providers = new ProviderRegistry();
    providers.register(
      new MockChatProvider({
        scripts: [[callChunk('c1', 'write_file', { path: 'a.ts' })], [doneChunk]],
        id: 'mock',
      }),
    );
    const origCall = reg.call.bind(reg);
    (reg as unknown as { call: typeof origCall }).call = async (name, args, ctx) => {
      seenArgs = args as Record<string, unknown>;
      return origCall(name, args, ctx);
    };
    const events: ChatEvent[] = [];
    const loop = new AgentLoop(
      { tools: reg, providers },
      { event: (_s, _t, e) => events.push(e) },
      {
        policy: new PolicyGate(),
        defaultModel: 'mock:mock-model',
        loopGuard: { enabled: false },
        hooks: { trusted: true, homeDir: h, workspaceRoot: root },
      },
    );
    await loop.runTurn('turn-1', newSession(root), 'go', { model: 'mock:mock-model' });
    expect(executed).toEqual(['write_file']);
    expect(seenArgs?.injected).toBe('yes');
    expect(seenArgs?.path).toBe('a.ts'); // original args preserved
  });

  it('repo hooks without consent do not run (pending consent)', async () => {
    const h = home();
    // NOTE: no recordConsent call — consent is missing.
    const root = mkdtempSync(join(tmpdir(), 'hooks-ws-'));
    dirs.push(root);
    mkdirSync(join(root, '.sunday'), { recursive: true });
    writeFileSync(join(root, '.sunday', 'hooks.json'), JSON.stringify(BLOCK_SECRET_HOOKS));
    const { executed } = await runWithScript({
      cwd: root,
      hooks: { trusted: true, homeDir: h, workspaceRoot: root },
      scripts: [[callChunk('c1', 'read_file', { path: join(root, 'secrets.txt') })], [doneChunk]],
    });
    // No consent → hook skipped → tool executes.
    expect(executed).toEqual(['read_file']);
  });

  it('post_edit hook fires after write_file', async () => {
    const h = home();
    const root = workspace(h, {
      version: 1,
      hooks: [
        {
          name: 'test:annotate-edit',
          event: 'post_edit',
          match: { tools: ['write_file'] },
          actions: [{ type: 'annotate', text: 'edit noted' }],
        },
      ],
    });
    const { events } = await runWithScript({
      cwd: root,
      hooks: { trusted: true, homeDir: h, workspaceRoot: root },
      scripts: [[callChunk('c1', 'write_file', { path: 'a.ts' })], [doneChunk]],
    });
    const results = events.filter((e) => e.type === 'tool-result');
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain('edit noted');
  });
});
