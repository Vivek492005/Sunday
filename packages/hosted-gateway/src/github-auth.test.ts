import { describe, it, expect, afterEach } from 'vitest';
import { GitHubVerifier } from './github-auth.js';

describe('GitHubVerifier', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mockFetch(status: number, body: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status })) as typeof fetch;
  }

  it('returns identity for a valid token', async () => {
    mockFetch(200, { id: 12345, login: 'octocat' });
    const v = new GitHubVerifier();
    const id = await v.verify('good-token');
    expect(id).toEqual({ id: 12345, login: 'octocat' });
  });

  it('returns null for an invalid token', async () => {
    mockFetch(401, { message: 'Bad credentials' });
    const v = new GitHubVerifier();
    expect(await v.verify('bad-token')).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    const v = new GitHubVerifier();
    expect(await v.verify('any')).toBeNull();
  });

  it('returns null for empty token', async () => {
    const v = new GitHubVerifier();
    expect(await v.verify('')).toBeNull();
  });

  it('caches successful verifications', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ id: 1, login: 'u' }), { status: 200 });
    }) as typeof fetch;
    const v = new GitHubVerifier();
    await v.verify('tok');
    await v.verify('tok');
    expect(calls).toBe(1);
  });
});
