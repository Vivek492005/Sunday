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
      expect(name).toMatch(/^[a-z]+\/[a-z-]+$/);
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
