// Unit tests for githubRepos.ts — pure functions + mocked GitHub API.
// No real network calls; the vscode API is never touched here.
import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';

vi.mock('vscode', () => ({}));

import {
  buildCloneUrl,
  repoPickLabel,
  repoPickDetail,
  defaultCloneDir,
  classifyApiError,
  apiErrorMessage,
  fetchUserReposPage,
  fetchAllUserRepos,
  fetchViewerLogin,
  type GitHubRepo,
} from './githubRepos.js';

const repo = (over: Partial<GitHubRepo> = {}): GitHubRepo => ({
  id: 1,
  name: 'hello-world',
  full_name: 'octocat/hello-world',
  private: false,
  description: 'My first repo',
  updated_at: '2026-01-15T10:00:00Z',
  default_branch: 'main',
  clone_url: 'https://github.com/octocat/hello-world.git',
  ...over,
});

describe('buildCloneUrl', () => {
  it('embeds the token without logging it', () => {
    const url = buildCloneUrl(repo(), 'test-fake-token-xyz');
    expect(url).toBe('https://test-fake-token-xyz@github.com/octocat/hello-world.git');
    // The raw token must not appear anywhere except the URL itself — callers
    // must never log the returned string.
    expect(url).not.toContain('octocat/hello-world.git'.replace('/', '%2F'));
  });

  it('strips pre-existing credentials from the clone URL', () => {
    const r = repo({ clone_url: 'https://olduser@github.com/octocat/hello-world.git' });
    expect(buildCloneUrl(r, 'newtoken')).toBe(
      'https://newtoken@github.com/octocat/hello-world.git',
    );
  });

  it('URL-encodes tokens with special characters', () => {
    const url = buildCloneUrl(repo(), 'tok/en+with=special');
    expect(url).toBe('https://tok%2Fen%2Bwith%3Dspecial@github.com/octocat/hello-world.git');
  });
});

describe('repoPickLabel / repoPickDetail', () => {
  it('labels public and private repos distinctly', () => {
    expect(repoPickLabel(repo())).toContain('octocat/hello-world');
    expect(repoPickLabel(repo())).toContain('repo');
    expect(repoPickLabel(repo({ private: true }))).toContain('lock');
  });

  it('formats the detail line with description and date', () => {
    const detail = repoPickDetail(repo());
    expect(detail).toContain('My first repo');
    expect(detail).toContain('2026');
  });

  it('falls back when description is missing', () => {
    expect(repoPickDetail(repo({ description: null }))).toContain('No description');
  });

  it('keeps the raw date string when parsing fails', () => {
    expect(repoPickDetail(repo({ updated_at: 'not-a-date' }))).toContain('not-a-date');
  });
});

describe('defaultCloneDir', () => {
  it('puts repos under ~/Sunday-repos/<name>', () => {
    const dir = defaultCloneDir('my-app');
    expect(dir.endsWith(`Sunday-repos${path.sep}my-app`)).toBe(true);
  });
});

describe('classifyApiError', () => {
  it('maps 401/403 to auth', () => {
    expect(classifyApiError(401, new Error('x'))).toBe('auth');
    expect(classifyApiError(403, new Error('forbidden'))).toBe('auth');
  });
  it('maps rate-limit signals', () => {
    expect(classifyApiError(429, new Error('x'))).toBe('rate-limit');
    expect(classifyApiError(403, new Error('API rate limit exceeded'))).toBe('rate-limit');
  });
  it('maps network failures', () => {
    expect(classifyApiError(undefined, new Error('fetch failed'))).toBe('network');
    expect(classifyApiError(undefined, new Error('ENOTFOUND'))).toBe('network');
  });
  it('maps everything else to unknown', () => {
    expect(classifyApiError(500, new Error('boom'))).toBe('unknown');
    expect(classifyApiError(undefined, new Error('weird'))).toBe('unknown');
  });
});

describe('apiErrorMessage', () => {
  it('never includes tokens or raw error text', () => {
    for (const kind of ['auth', 'rate-limit', 'network', 'unknown'] as const) {
      const msg = apiErrorMessage(kind);
      expect(msg).not.toMatch(/ghp_|github_pat/i);
      expect(msg.length).toBeGreaterThan(10);
    }
  });
});

// -- Mocked GitHub API ------------------------------------------------------------

function mockFetch(
  handler: (url: string) => { status: number; body: unknown },
) {
  return vi.fn(async (url: string) => {
    const { status, body } = handler(url as string);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
}

describe('fetchUserReposPage', () => {
  it('returns parsed repos on success', async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: [repo()] }));
    const repos = await fetchUserReposPage('tok', 1, { fetchImpl });
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('octocat/hello-world');
  });

  it('sends the bearer token and API version headers', async () => {
    const seen: Record<string, string> = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      for (const [k, v] of Object.entries(init?.headers ?? {})) seen[k] = String(v);
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }) as unknown as typeof fetch;
    await fetchUserReposPage('tok123', 1, { fetchImpl });
    expect(seen['Authorization']).toBe('Bearer tok123');
    expect(seen['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('throws a classified auth error on 401', async () => {
    const fetchImpl = mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    await expect(fetchUserReposPage('bad', 1, { fetchImpl })).rejects.toThrow(
      /authentication failed/i,
    );
  });

  it('throws a rate-limit error on 429', async () => {
    const fetchImpl = mockFetch(() => ({ status: 429, body: { message: 'slow down' } }));
    const err = await fetchUserReposPage('tok', 1, { fetchImpl }).catch((e) => e);
    expect((err as { kind?: string }).kind).toBe('rate-limit');
  });

  it('wraps network failures', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchUserReposPage('tok', 1, { fetchImpl })).rejects.toThrow(/network error/i);
  });
});

describe('fetchAllUserRepos', () => {
  it('paginates until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => repo({ id: i, full_name: `u/r${i}` }));
    const page2 = [repo({ id: 101, full_name: 'u/last' })];
    const fetchImpl = mockFetch((url) => {
      const page = new URL(url).searchParams.get('page');
      return { status: 200, body: page === '1' ? page1 : page2 };
    });
    const all = await fetchAllUserRepos('tok', { fetchImpl });
    expect(all).toHaveLength(101);
  });

  it('stops after 10 pages max', async () => {
    const full = Array.from({ length: 100 }, (_, i) => repo({ id: i }));
    const fetchImpl = mockFetch(() => ({ status: 200, body: full }));
    const all = await fetchAllUserRepos('tok', { fetchImpl });
    expect(all).toHaveLength(1000);
  });
});

describe('fetchViewerLogin', () => {
  it('returns the login name', async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: { login: 'octocat' } }));
    expect(await fetchViewerLogin('tok', { fetchImpl })).toBe('octocat');
  });
});
