import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  ErrorCode,
  parseMessage,
  createRequest,
  createNotification,
  successResponse,
  errorResponse,
  parseParams,
  METHODS,
  helloParamsSchema,
  sessionSchema,
  toolDefinitionSchema,
  chatEventNotificationSchema,
  contentPartSchema,
  imagePartSchema,
  textPartSchema,
} from './index.js';

describe('envelopes', () => {
  it('round-trips a request through parseMessage', () => {
    const line = JSON.stringify(createRequest(1, 'sunday/ping', {}));
    const parsed = parseMessage(line);
    expect(parsed.kind).toBe('request');
    if (parsed.kind === 'request') expect(parsed.message.method).toBe('sunday/ping');
  });

  it('classifies notifications, responses and error responses', () => {
    expect(parseMessage(JSON.stringify(createNotification('chat/event', {}))).kind).toBe(
      'notification',
    );
    expect(parseMessage(JSON.stringify(successResponse('a', { ok: true }))).kind).toBe('response');
    expect(parseMessage(JSON.stringify(errorResponse(2, ErrorCode.PolicyDenied, 'nope'))).kind).toBe(
      'response',
    );
  });

  it('rejects garbage and malformed envelopes', () => {
    expect(parseMessage('not json').kind).toBe('invalid');
    expect(parseMessage('{"jsonrpc":"1.0","id":1,"method":"x"}').kind).toBe('invalid');
    // has an id but is neither a valid request nor a valid response
    expect(parseMessage('{"jsonrpc":"2.0","id":1}').kind).toBe('invalid');
  });
});

describe('method params', () => {
  it('chat/send accepts a string or content parts, but not empties', () => {
    expect(() => parseParams('chat/send', { sessionId: 's1', message: 'hello' })).not.toThrow();
    expect(() =>
      parseParams('chat/send', { sessionId: 's1', message: [{ type: 'text', text: 'hi' }] }),
    ).not.toThrow();
    expect(() => parseParams('chat/send', { sessionId: '', message: 'hi' })).toThrow();
    expect(() => parseParams('chat/send', { sessionId: 's1', message: '' })).toThrow();
  });

  it('tool names must be snake_case', () => {
    const good = { name: 'read_file', description: 'd', parameters: { type: 'object' } };
    expect(toolDefinitionSchema.safeParse(good).success).toBe(true);
    expect(toolDefinitionSchema.safeParse({ ...good, name: 'readFile' }).success).toBe(false);
  });

  it('chat events discriminate cleanly', () => {
    const n = {
      turnId: 't1',
      sessionId: 's1',
      event: { type: 'text-delta', delta: 'hello' },
    };
    expect(chatEventNotificationSchema.safeParse(n).success).toBe(true);
    expect(
      chatEventNotificationSchema.safeParse({ ...n, event: { type: 'nope' } }).success,
    ).toBe(false);
  });

  it('hello carries the protocol version', () => {
    const p = helloParamsSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'sunday-agent', version: '0.0.1', os: 'win32' },
    });
    expect(p.protocolVersion).toBe(1);
  });

  it('every registered method has params+result schemas and a namespaced name', () => {
    for (const [name, def] of Object.entries(METHODS)) {
      expect(typeof def.params.parse).toBe('function');
      expect(typeof def.result.parse).toBe('function');
      // Phase 6: browser/verify_ui carries an underscore (composed macro
      // name); method names are otherwise kebab-case.
      // Part A: the mcp/* family uses a second namespace segment
      // (mcp/<resource>/<action>) because the MCP surface groups servers,
      // tools, and call history.
      if (name.startsWith('mcp/')) {
        expect(name).toMatch(/^mcp\/[a-z]+\/[a-z]+$/);
      } else {
        expect(name).toMatch(/^[a-z]+\/[a-z-_]+$/);
      }
    }
  });

  it('session timestamps are strings (ISO-8601 by convention)', () => {
    const s = {
      id: 's1',
      title: 't',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(sessionSchema.safeParse(s).success).toBe(true);
  });
});

// Phase 2: context — appended. (Import at the end is hoisted; kept here so the
// append is purely additive.)
import { CONTEXT_METHODS } from './index.js';

describe('context methods', () => {
  it('registers context/map, context/index and context/search with params+result schemas', () => {
    expect(Object.keys(CONTEXT_METHODS).sort()).toEqual([
      'context/index',
      'context/map',
      'context/search',
    ]);
    for (const [name, def] of Object.entries(CONTEXT_METHODS)) {
      expect(name).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(typeof def.params.parse).toBe('function');
      expect(typeof def.result.parse).toBe('function');
    }
  });

  it('validates context/map payloads', () => {
    const params = CONTEXT_METHODS['context/map'].params.parse({ workspaceRoot: '/tmp/ws' });
    expect(params.workspaceRoot).toBe('/tmp/ws');
    expect(() => CONTEXT_METHODS['context/map'].params.parse({})).toThrow();
    const result = CONTEXT_METHODS['context/map'].result.parse({
      files: [{ path: 'src/a.ts', size: 12, lang: 'typescript' }],
      totalFiles: 1,
      totalBytes: 12,
    });
    expect(result.totalFiles).toBe(1);
  });

  it('validates context/index payloads', () => {
    expect(
      CONTEXT_METHODS['context/index'].params.parse({ workspaceRoot: '/tmp/ws', force: true }),
    ).toEqual({ workspaceRoot: '/tmp/ws', force: true });
    expect(
      CONTEXT_METHODS['context/index'].result.parse({ files: 2, chunks: 5, skipped: 1 }),
    ).toEqual({ files: 2, chunks: 5, skipped: 1 });
    expect(() =>
      CONTEXT_METHODS['context/index'].params.parse({ workspaceRoot: '/tmp/ws', force: 'x' }),
    ).toThrow();
  });

  it('validates context/search payloads', () => {
    expect(
      CONTEXT_METHODS['context/search'].params.parse({ query: 'zephyr', k: 3, maxChars: 100 }),
    ).toEqual({ query: 'zephyr', k: 3, maxChars: 100 });
    expect(() => CONTEXT_METHODS['context/search'].params.parse({ query: '' })).toThrow();
    expect(() => CONTEXT_METHODS['context/search'].params.parse({ query: 'x', k: 0 })).toThrow();
    expect(() =>
      CONTEXT_METHODS['context/search'].params.parse({ query: 'x', k: 51 }),
    ).toThrow();
    const result = CONTEXT_METHODS['context/search'].result.parse({
      hits: [{ path: 'a.ts', startLine: 1, endLine: 5, score: 2.5, snippet: 'const x = 1;' }],
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.score).toBe(2.5);
  });
});

describe('content parts', () => {
  it('accepts a text part', () => {
    expect(textPartSchema.parse({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' });
  });

  it('accepts an image part with a data: URL', () => {
    const part = imagePartSchema.parse({
      type: 'image',
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
    });
    expect(part.type).toBe('image');
    expect(contentPartSchema.parse(part).type).toBe('image');
  });

  it('rejects an image part without a dataUrl', () => {
    expect(() => imagePartSchema.parse({ type: 'image' })).toThrow();
    expect(() => contentPartSchema.parse({ type: 'image', dataUrl: '' })).toThrow();
  });

  it('still rejects unknown part types', () => {
    expect(() => contentPartSchema.parse({ type: 'video', url: 'x' })).toThrow();
  });

  it('chat/send accepts messages mixing text and image parts', () => {
    expect(() =>
      parseParams('chat/send', {
        sessionId: 's1',
        message: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo' },
        ],
      }),
    ).not.toThrow();
  });
});
