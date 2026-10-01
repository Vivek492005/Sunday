import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@sunday/protocol';
import {
  ProviderRegistry,
  type ChatChunk,
  type ChatProvider,
  type ChatRequest,
  type ModelEntry,
} from '@sunday/gateway';
import { createDefaultRegistry as createDefaultTools } from '@sunday/tools';
import { SundayDaemon, type DaemonOptions } from './daemon.js';
import { SessionStore } from './sessions.js';
import { PolicyGate } from './policy.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A provider that plays a canned script per chat() call (one script per turn iteration). */
class MockProvider implements ChatProvider {
  readonly id = 'mock';
  readonly label = 'Mock provider';
  private queue: ChatChunk[][];

  constructor(scripts: ChatChunk[][] = []) {
    this.queue = scripts;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const script = this.queue.shift() ?? [{ type: 'done', finishReason: 'stop' } as ChatChunk];
    for (const c of script) {
      if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      yield c;
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    return [{ id: 'mock-model', label: 'Mock Model', contextWindow: 8192, supportsTools: true }];
  }
}

class HangingProvider extends MockProvider {
  override async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      if (req.signal?.aborted) return onAbort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
    });
    yield* [];
  }
}

interface Frame {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

interface Harness {
  dir: string;
  frames: Frame[];
  call(method: string, params: unknown): number;
  raw(line: string): void;
  close(): void;
}

async function makeHarness(provider: MockProvider, extra: Partial<DaemonOptions> = {}): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sundayd-test-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) frames.push(JSON.parse(line) as Frame);
    }
  });
  const providers = new ProviderRegistry();
  providers.register(provider);
  const daemon = new SundayDaemon(
    {
      sessionsDir: path.join(dir, 'sessions'),
      defaultModel: 'mock:mock-model',
      providers,
      tools: createDefaultTools(),
      onShutdown: () => undefined,
      onStdinClose: () => undefined,
      ...extra,
    },
    input,
    output,
  );
  await daemon.start();
  let nextId = 1;
  return {
    dir,
    frames,
    call(method: string, params: unknown): number {
      const id = nextId++;
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return id;
    },
    raw(line: string): void {
      input.write(line + '\n');
    },
    close(): void {
      input.end();
    },
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const response = (h: Harness, id: number): Frame | undefined =>
  h.frames.find((f) => f.id === id && ('result' in f || 'error' in f));
const notifications = (h: Harness): Frame[] => h.frames.filter((f) => f.method === 'chat/event');
const events = (h: Harness, turnId: string): any[] =>
  notifications(h)
    .filter((f) => f.params?.turnId === turnId)
    .map((f) => f.params.event);

async function createSession(h: Harness, params: Record<string, unknown> = {}): Promise<string> {
  const id = h.call('session/create', params);
  await waitFor(() => !!response(h, id));
  const r = response(h, id)!;
  expect(r.error).toBeUndefined();
  return r.result.session.id as string;
}

// ---------------------------------------------------------------------------
// Handshake & protocol
// ---------------------------------------------------------------------------

describe('handshake & protocol', () => {
  it('negotiates the protocol version', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('sunday/hello', {
      protocolVersion: 1,
      client: { name: 'test', version: '0', os: 'linux' },
    });
    await waitFor(() => !!response(h, id));
    const r = response(h, id)!;
    expect(r.result.protocolVersion).toBe(1);
    expect(r.result.negotiated).toBe(true);
    expect(r.result.server.name).toBe('sundayd');
    h.close();
  });

  it('reports negotiated=false on version mismatch', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('sunday/hello', {
      protocolVersion: 999,
      client: { name: 'test', version: '0', os: 'linux' },
    });
    await waitFor(() => !!response(h, id));
    expect(response(h, id)!.result.negotiated).toBe(false);
    h.close();
  });

  it('answers ping', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('sunday/ping', {});
    await waitFor(() => !!response(h, id));
    expect(response(h, id)!.result.ok).toBe(true);
    h.close();
  });

  it('rejects unknown methods', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('nope/method', {});
    await waitFor(() => !!response(h, id));
    expect(response(h, id)!.error?.code).toBe(ErrorCode.MethodNotFound);
    h.close();
  });

  it('rejects malformed JSON with ParseError', async () => {
    const h = await makeHarness(new MockProvider());
    h.raw('this is not json {{{');
    await waitFor(() => h.frames.some((f) => f.error?.code === ErrorCode.ParseError));
    h.close();
  });

  it('rejects invalid params', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('sunday/hello', { bogus: true });
    await waitFor(() => !!response(h, id));
    expect(response(h, id)!.error?.code).toBe(ErrorCode.InvalidParams);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('sessions', () => {
  it('create / list / restore / close round-trip', async () => {
    const h = await makeHarness(new MockProvider());
    const sid = await createSession(h, { title: 'demo' });

    const listId = h.call('session/list', {});
    await waitFor(() => !!response(h, listId));
    expect(response(h, listId)!.result.sessions).toHaveLength(1);
    expect(response(h, listId)!.result.sessions[0].title).toBe('demo');
    // History must not leak onto the protocol surface.
    expect(response(h, listId)!.result.sessions[0]).not.toHaveProperty('messages');

    const resId = h.call('session/restore', { sessionId: sid });
    await waitFor(() => !!response(h, resId));
    expect(response(h, resId)!.result.session.id).toBe(sid);

    const closeId = h.call('session/close', { sessionId: sid });
    await waitFor(() => !!response(h, closeId));
    expect(response(h, closeId)!.result.ok).toBe(true);

    const list2 = h.call('session/list', {});
    await waitFor(() => !!response(h, list2));
    expect(response(h, list2)!.result.sessions).toHaveLength(0);

    // ...but the file survives close, so restore still works.
    const res2 = h.call('session/restore', { sessionId: sid });
    await waitFor(() => !!response(h, res2));
    expect(response(h, res2)!.result.session.id).toBe(sid);
    h.close();
  });

  it('restore of an unknown session fails with SessionNotFound', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('session/restore', { sessionId: 'nope' });
    await waitFor(() => !!response(h, id));
    expect(response(h, id)!.error?.code).toBe(ErrorCode.SessionNotFound);
    h.close();
  });

  it('persists sessions to disk and reloads them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sundayd-sess-'));
    const sdir = path.join(dir, 'sessions');
    const a = new SessionStore(sdir);
    await a.init();
    const s = a.create({ title: 'persisted', cwd: dir });
    await a.persist(s);

    const b = new SessionStore(sdir);
    await b.init();
    expect(b.get(s.id)?.title).toBe('persisted');
    expect(b.list()).toHaveLength(1);
  });

  it('session/create only responds after the session file is durably written', async () => {
    const h = await makeHarness(new MockProvider());
    const sid = await createSession(h, { title: 'durable' });
    // The response was already received, so the file must be complete valid JSON.
    const raw = await fs.readFile(path.join(h.dir, 'sessions', `${sid}.json`), 'utf8');
    expect(raw.length).toBeGreaterThan(0);
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(sid);
    expect(parsed.messages).toEqual([]);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('policy gate', () => {
  it('allow-all permits writes', () => {
    expect(new PolicyGate().evaluate('write_file')).toEqual({ allow: true });
  });

  it('read-only blocks mutating tools but allows reads', () => {
    const p = new PolicyGate({ mode: 'read-only' });
    expect(p.evaluate('read_file')).toEqual({ allow: true });
    expect(p.evaluate('write_file').allow).toBe(false);
    expect(p.evaluate('run_terminal').allow).toBe(false);
  });

  it('deny-all blocks everything unless explicitly allowed', () => {
    const p = new PolicyGate({ mode: 'deny-all', allow: ['read_file'] });
    expect(p.evaluate('read_file')).toEqual({ allow: true });
    expect(p.evaluate('list_dir').allow).toBe(false);
  });

  it('explicit deny beats allow-all', () => {
    const p = new PolicyGate({ deny: ['run_terminal'] });
    expect(p.evaluate('run_terminal').allow).toBe(false);
    expect(p.evaluate('read_file')).toEqual({ allow: true });
  });
});

// ---------------------------------------------------------------------------
// Chat turns
// ---------------------------------------------------------------------------

const TOOL_TURN: ChatChunk[][] = [
  [
    { type: 'text-delta', delta: 'Reading: ' },
    {
      type: 'tool-call',
      call: { id: 'c1', name: 'read_file', arguments: { path: 'hello.txt' } },
    },
    { type: 'done', finishReason: 'tool_calls' },
  ],
  [{ type: 'text-delta', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
];

describe('chat turns', () => {
  it('runs a tool-calling turn and streams chat/event notifications', async () => {
    const h = await makeHarness(new MockProvider(TOOL_TURN.map((s) => [...s])));
    await fs.writeFile(path.join(h.dir, 'hello.txt'), 'hello sunday');
    const sid = await createSession(h, { cwd: h.dir });

    const id = h.call('chat/send', { sessionId: sid, message: 'read hello.txt' });
    await waitFor(() => !!response(h, id));
    const turnId = response(h, id)!.result.turnId as string;
    expect(typeof turnId).toBe('string');

    await waitFor(() => events(h, turnId).some((e) => e.type === 'turn-end'));
    const evts = events(h, turnId);
    const kinds = evts.map((e) => e.type);
    expect(kinds).toContain('text-delta');
    expect(kinds).toContain('tool-call');
    expect(kinds).toContain('tool-result');
    expect(kinds).toContain('turn-end');

    const toolCall = evts.find((e) => e.type === 'tool-call');
    expect(toolCall.call.name).toBe('read_file');
    const toolResult = evts.find((e) => e.type === 'tool-result');
    expect(toolResult.result.isError).toBe(false);
    expect(toolResult.result.content[0].text).toContain('hello sunday');
    expect(evts.find((e) => e.type === 'turn-end').finishReason).toBe('stop');

    // History (user + assistant + tool messages) was persisted to disk.
    await waitFor(async () => {
      try {
        const raw = await fs.readFile(path.join(h.dir, 'sessions', `${sid}.json`), 'utf8');
        const roles = (JSON.parse(raw).messages as any[]).map((m) => m.role);
        return roles.includes('user') && roles.includes('assistant') && roles.includes('tool');
      } catch {
        return false;
      }
    });
    h.close();
  });

  it('chat/send on a missing session fails fast with SessionNotFound', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('chat/send', { sessionId: 'nope', message: 'hi' });
    await waitFor(() => !!response(h, id));
    expect(response(h, id)!.error?.code).toBe(ErrorCode.SessionNotFound);
    h.close();
  });

  it('feeds policy denials back to the model as tool errors', async () => {
    const h = await makeHarness(
      new MockProvider([
        [
          {
            type: 'tool-call',
            call: { id: 'c1', name: 'write_file', arguments: { path: 'x.txt', content: 'x' } },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [{ type: 'done', finishReason: 'stop' }],
      ]),
      { policy: { mode: 'read-only' } },
    );
    const sid = await createSession(h, { cwd: h.dir });
    const id = h.call('chat/send', { sessionId: sid, message: 'write x' });
    await waitFor(() => !!response(h, id));
    const turnId = response(h, id)!.result.turnId as string;
    await waitFor(() => events(h, turnId).some((e) => e.type === 'turn-end'));
    const toolResult = events(h, turnId).find((e) => e.type === 'tool-result');
    expect(toolResult.result.isError).toBe(true);
    expect(toolResult.result.content[0].text).toContain('Policy denied');
    // ...and nothing was actually written.
    await expect(fs.stat(path.join(h.dir, 'x.txt'))).rejects.toThrow();
    h.close();
  });

  it('feeds malformed tool arguments back as a retryable tool error', async () => {
    const h = await makeHarness(
      new MockProvider([
        [
          {
            type: 'tool-call',
            call: { id: 'c1', name: 'read_file', arguments: {} },
          },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [{ type: 'done', finishReason: 'stop' }],
      ]),
    );
    // Simulate the gateway flagging non-JSON arguments.
    const sid = await createSession(h, { cwd: h.dir });
    const id = h.call('chat/send', { sessionId: sid, message: 'hi' });
    await waitFor(() => !!response(h, id));
    const turnId = response(h, id)!.result.turnId as string;
    await waitFor(() => events(h, turnId).some((e) => e.type === 'turn-end'));
    // read_file with {} fails arg validation -> isError tool result, turn still ends cleanly.
    const toolResult = events(h, turnId).find((e) => e.type === 'tool-result');
    expect(toolResult.result.isError).toBe(true);
    h.close();
  });
  it('chat/cancel aborts a running turn', async () => {
    const h = await makeHarness(new HangingProvider());
    const sid = await createSession(h, { cwd: h.dir });
    const id = h.call('chat/send', { sessionId: sid, message: 'hang' });
    await waitFor(() => !!response(h, id));
    const turnId = response(h, id)!.result.turnId as string;

    const cancelId = h.call('chat/cancel', { turnId });
    await waitFor(() => !!response(h, cancelId));
    expect(response(h, cancelId)!.result.ok).toBe(true);

    await waitFor(() =>
      events(h, turnId).some(
        (e) => e.type === 'turn-error' && e.code === ErrorCode.TurnCancelled,
      ),
    );
    h.close();
  });

  it('caps runaway tool loops at max-steps', async () => {
    const looping: ChatChunk[][] = Array.from({ length: 10 }, () => [
      {
        type: 'tool-call',
        call: { id: 'c-loop', name: 'list_dir', arguments: { path: '.' } },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
    const h = await makeHarness(new MockProvider(looping), { maxIterations: 3 });
    const sid = await createSession(h, { cwd: h.dir });
    const id = h.call('chat/send', { sessionId: sid, message: 'loop' });
    await waitFor(() => !!response(h, id));
    const turnId = response(h, id)!.result.turnId as string;
    await waitFor(() => events(h, turnId).some((e) => e.type === 'turn-end'));
    expect(events(h, turnId).find((e) => e.type === 'turn-end').finishReason).toBe('max-steps');
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Catalogues
// ---------------------------------------------------------------------------

describe('catalogues', () => {
  it('tools/list exposes the registry definitions', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('tools/list', {});
    await waitFor(() => !!response(h, id));
    const tools = response(h, id)!.result.tools as any[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain('read_file');
    h.close();
  });

  it('models/list exposes provider models', async () => {
    const h = await makeHarness(new MockProvider());
    const id = h.call('models/list', {});
    await waitFor(() => !!response(h, id));
    const models = response(h, id)!.result.models as any[];
    expect(models).toHaveLength(1);
    expect(models[0].provider).toBe('mock');
    h.close();
  });
});
