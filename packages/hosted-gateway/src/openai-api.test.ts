import { describe, it, expect } from 'vitest';
import { parseChatRequest, ApiError, errorBody } from './openai-api.js';

const LIMITS = {
  maxBodyBytes: 1024,
  maxMessages: 10,
  maxMessageChars: 100,
  maxTokensCap: 50,
  allowedModels: ['openrouter:m1'],
};

function expectApiError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error('expected ApiError, none thrown');
}

describe('parseChatRequest', () => {
  const valid = {
    model: 'openrouter:m1',
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('accepts a minimal valid request', () => {
    const r = parseChatRequest(valid, LIMITS);
    expect(r.model).toBe('openrouter:m1');
    expect(r.stream).toBe(false);
    expect(r.maxTokens).toBe(50);
    expect(r.messages).toHaveLength(1);
  });

  it('rejects tool use (tools, tool_choice, functions, function_call)', () => {
    for (const f of ['tools', 'tool_choice', 'functions', 'function_call']) {
      expectApiError(
        () => parseChatRequest({ ...valid, [f]: [] }, LIMITS),
        400,
        'tools_not_supported',
      );
    }
  });

  it('rejects disallowed models when an allowlist is set', () => {
    expectApiError(
      () => parseChatRequest({ ...valid, model: 'openrouter:evil' }, LIMITS),
      403,
      'model_not_allowed',
    );
  });

  it('allows any model when the allowlist is empty', () => {
    const r = parseChatRequest(valid, { ...LIMITS, allowedModels: [] });
    expect(r.model).toBe('openrouter:m1');
  });

  it('rejects bad roles, empty messages, too many messages', () => {
    expectApiError(() => parseChatRequest({ ...valid, messages: [] }, LIMITS), 400, 'invalid_messages');
    expectApiError(
      () => parseChatRequest({ ...valid, messages: [{ role: 'tool', content: 'x' }] }, LIMITS),
      400,
      'invalid_role',
    );
    const many = Array.from({ length: 11 }, () => ({ role: 'user', content: 'x' }));
    expectApiError(() => parseChatRequest({ ...valid, messages: many }, LIMITS), 400, 'too_many_messages');
  });

  it('rejects overlong content', () => {
    expectApiError(
      () =>
        parseChatRequest(
          { ...valid, messages: [{ role: 'user', content: 'x'.repeat(101) }] },
          LIMITS,
        ),
      400,
      'content_too_long',
    );
  });

  it('rejects image content parts', () => {
    expectApiError(
      () =>
        parseChatRequest(
          {
            ...valid,
            messages: [
              { role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://x' } }] },
            ],
          },
          LIMITS,
        ),
      400,
      'unsupported_content',
    );
  });

  it('clamps max_tokens to the cap instead of rejecting', () => {
    const r = parseChatRequest({ ...valid, max_tokens: 99999 }, LIMITS);
    expect(r.maxTokens).toBe(50);
  });

  it('rejects invalid temperature and max_tokens', () => {
    expectApiError(() => parseChatRequest({ ...valid, temperature: 5 }, LIMITS), 400, 'invalid_temperature');
    expectApiError(() => parseChatRequest({ ...valid, max_tokens: -1 }, LIMITS), 400, 'invalid_max_tokens');
  });

  it('accepts text content parts and stream:true', () => {
    const r = parseChatRequest(
      {
        ...valid,
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      LIMITS,
    );
    expect(r.stream).toBe(true);
    expect(r.promptTokensEst).toBeGreaterThan(0);
  });
});

describe('errorBody', () => {
  it('maps ApiError to an OpenAI-style envelope', () => {
    const { status, body } = errorBody(new ApiError(429, 'rate_limited', 'slow down'));
    expect(status).toBe(429);
    expect((body as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('hides internals on 500 by default', () => {
    const { status, body } = errorBody(new Error('db password=hunter2 exploded'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});
