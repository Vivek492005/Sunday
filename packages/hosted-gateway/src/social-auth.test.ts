import { describe, it, expect, afterEach } from 'vitest';
import { SocialVerifier } from './social-auth.js';

describe('SocialVerifier', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const { status, body } = handler(url);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it('verifies a GitHub token', async () => {
    mockFetch((url) =>
      url.includes('api.github.com')
        ? { status: 200, body: { id: 123, login: 'octocat' } }
        : { status: 401, body: {} },
    );
    const v = new SocialVerifier(['github']);
    const id = await v.verify('tok');
    expect(id).toEqual({ provider: 'github', key: 'gh:123', label: 'octocat' });
  });

  it('verifies a Google token', async () => {
    mockFetch((url) =>
      url.includes('googleapis.com')
        ? { status: 200, body: { sub: 'google-uid-1', email: 'u@example.com' } }
        : { status: 401, body: {} },
    );
    const v = new SocialVerifier(['google']);
    const id = await v.verify('tok');
    expect(id).toEqual({ provider: 'google', key: 'google:google-uid-1', label: 'u@example.com' });
  });

  it('verifies a Microsoft token', async () => {
    mockFetch((url) =>
      url.includes('graph.microsoft.com')
        ? { status: 200, body: { id: 'ms-uid-9', userPrincipalName: 'u@contoso.com' } }
        : { status: 401, body: {} },
    );
    const v = new SocialVerifier(['microsoft']);
    const id = await v.verify('tok');
    expect(id).toEqual({ provider: 'microsoft', key: 'ms:ms-uid-9', label: 'u@contoso.com' });
  });

  it('falls through providers until one succeeds', async () => {
    mockFetch((url) =>
      url.includes('graph.microsoft.com')
        ? { status: 200, body: { id: 'ms-1', displayName: 'MS User' } }
        : { status: 401, body: {} },
    );
    const v = new SocialVerifier(['github', 'google', 'microsoft']);
    const id = await v.verify('tok');
    expect(id?.provider).toBe('microsoft');
    expect(id?.key).toBe('ms:ms-1');
  });

  it('returns null when no provider accepts the token', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    const v = new SocialVerifier();
    expect(await v.verify('bad')).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const v = new SocialVerifier();
    expect(await v.verify('tok')).toBeNull();
  });

  it('caches negative results briefly', async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return { status: 401, body: {} };
    });
    const v = new SocialVerifier(['github']);
    await v.verify('bad');
    await v.verify('bad');
    expect(calls).toBe(1); // second hit served from negative cache
  });
});
