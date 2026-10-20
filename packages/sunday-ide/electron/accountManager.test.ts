/**
 * Sunday IDE — accountManager tests (SIGN-IN / ACCOUNT feature).
 *
 * Vitest with stubbed fetch (session.ts HttpFetch shape) and a temp HOME
 * via the manager's homeDir override. No network, no daemon, no Electron.
 * Assertions cover REAL manager behavior: persistence (0600, atomic),
 * JWT-freshness short-circuit, refresh rotation, 401 clearing, offline
 * staleness, quota mapping, and machineId stability.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAccountStatus,
  getQuota,
  signOut,
  machineId,
  sessionFilePath,
  saveStoredSession,
  type StoredSession,
} from './accountManager.js';
import type {
  HttpFetch,
  HttpResponse,
} from '../../../vscode/extensions/sunday-google-auth/src/session.js';

// -- helpers -----------------------------------------------------------------

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Craft an unsigned JWT with the given exp (seconds since epoch). */
function makeJwt(expSeconds: number): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u_1', exp: expSeconds })}.sig`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const pastExp = () => Math.floor(Date.now() / 1000) - 3600;

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFetch(
  handler: (url: string, body: unknown) => HttpResponse | Promise<HttpResponse>,
): HttpFetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: HttpFetch = async (url, init) => {
    let body: unknown;
    if (init.body) {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init.method, body });
    return handler(url, body);
  };
  return Object.assign(fn, { calls });
}

const failingFetch: HttpFetch & { calls: RecordedCall[] } = Object.assign(
  async (): Promise<HttpResponse> => {
    throw new Error('fetch failed (offline)');
  },
  { calls: [] as RecordedCall[] },
);

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    session_token: makeJwt(futureExp()),
    refresh_token: 'refresh-1',
    user: {
      id: 'u_1',
      email: 'vivek@example.com',
      display_name: 'Vivek',
      avatar_url: 'https://example.com/a.png',
    },
    plan: 'basic',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-account-test-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// -- getAccountStatus ----------------------------------------------------------

describe('getAccountStatus', () => {
  it('returns signed out when there is no session file (and never throws)', async () => {
    const status = await getAccountStatus({ homeDir, fetchImpl: failingFetch });
    expect(status).toEqual({ signedIn: false });
  });

  it('returns signed out for a corrupt session file (loader never throws)', async () => {
    fs.mkdirSync(path.join(homeDir, '.sunday-ide'), { recursive: true });
    fs.writeFileSync(sessionFilePath(homeDir), '{not json', 'utf-8');
    const status = await getAccountStatus({ homeDir, fetchImpl: failingFetch });
    expect(status.signedIn).toBe(false);
  });

  it('fresh JWT → signed in WITHOUT any network call', async () => {
    saveStoredSession(storedSession(), homeDir);
    let calls = 0;
    const fetchImpl: HttpFetch = async () => {
      calls++;
      return jsonResponse(200, {});
    };
    const status = await getAccountStatus({ homeDir, fetchImpl });
    expect(calls).toBe(0);
    expect(status.signedIn).toBe(true);
    expect(status.stale).toBeUndefined();
    expect(status.plan).toBe('basic');
    expect(status.user).toEqual({
      id: 'u_1',
      email: 'vivek@example.com',
      displayName: 'Vivek',
      avatarUrl: 'https://example.com/a.png',
    });
  });

  it('expired JWT + refresh success → rotated pair saved, file mode is 0600', async () => {
    saveStoredSession(
      storedSession({ session_token: makeJwt(pastExp()), refresh_token: 'refresh-old' }),
      homeDir,
    );
    const newJwt = makeJwt(futureExp());
    const fetchImpl = makeFetch((url, body) => {
      expect(url).toContain('/auth/refresh');
      expect(body).toEqual({ refresh_token: 'refresh-old' });
      return jsonResponse(200, { session_token: newJwt, refresh_token: 'refresh-new' });
    });
    const status = await getAccountStatus({ homeDir, fetchImpl });
    expect(status.signedIn).toBe(true);
    expect(status.user?.id).toBe('u_1');

    const raw = JSON.parse(fs.readFileSync(sessionFilePath(homeDir), 'utf-8')) as StoredSession;
    expect(raw.session_token).toBe(newJwt);
    expect(raw.refresh_token).toBe('refresh-new');
    if (process.platform !== 'win32') {
      expect(fs.statSync(sessionFilePath(homeDir)).mode & 0o777).toBe(0o600);
    }
  });

  it('refresh 401 → session file deleted, signed out', async () => {
    saveStoredSession(
      storedSession({ session_token: makeJwt(pastExp()), refresh_token: 'replayed' }),
      homeDir,
    );
    const fetchImpl = makeFetch(() =>
      jsonResponse(401, { error: { code: 'invalid_refresh_token' } }),
    );
    const status = await getAccountStatus({ homeDir, fetchImpl });
    expect(status).toEqual({ signedIn: false });
    expect(fs.existsSync(sessionFilePath(homeDir))).toBe(false);
  });

  it('refresh network failure → signed in with stale=true, tokens kept on disk', async () => {
    saveStoredSession(storedSession({ session_token: makeJwt(pastExp()) }), homeDir);
    const status = await getAccountStatus({ homeDir, fetchImpl: failingFetch });
    expect(status.signedIn).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.user?.email).toBe('vivek@example.com');
    expect(fs.existsSync(sessionFilePath(homeDir))).toBe(true);
  });
});

// -- getQuota ------------------------------------------------------------------

describe('getQuota', () => {
  it('maps /me/usage/today fields to QuotaOut and sends the Bearer header', async () => {
    saveStoredSession(storedSession(), homeDir);
    let authHeader: string | undefined;
    const fetchImpl: HttpFetch & { calls: RecordedCall[] } = Object.assign(
      async (url: string, init: { headers: Record<string, string> }) => {
        expect(url).toContain('/me/usage/today?streak_days=0');
        authHeader = init.headers.Authorization;
        return jsonResponse(200, {
          requests: 12,
          tokens_in: 1000,
          tokens_out: 500,
          base_requests: 10,
          bonus_requests: 2,
          streak_days: 0,
          streak_bonus: 50,
          base_quota: 200,
          total_quota: 250,
          quota_remaining: 238,
          quota_reset_after_ms: 12345,
        });
      },
      { calls: [] as RecordedCall[] },
    );
    const quota = await getQuota({ homeDir, fetchImpl });
    expect(quota).toEqual({
      requestsUsed: 12,
      tokensIn: 1000,
      tokensOut: 500,
      baseQuota: 200,
      totalQuota: 250,
      quotaRemaining: 238,
    });
    expect(authHeader).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('returns not-signed-in error when there is no session', async () => {
    const quota = await getQuota({ homeDir, fetchImpl: failingFetch });
    expect(quota).toEqual({ error: 'not signed in' });
  });

  it('401 from quota endpoint → session cleared + session expired error', async () => {
    saveStoredSession(storedSession(), homeDir);
    const fetchImpl = makeFetch(() => jsonResponse(401, { error: 'unauthorized' }));
    const quota = await getQuota({ homeDir, fetchImpl });
    expect(quota).toEqual({ error: 'session expired' });
    expect(fs.existsSync(sessionFilePath(homeDir))).toBe(false);
  });
});

// -- signOut -------------------------------------------------------------------

describe('signOut', () => {
  it('logs out at the gateway, revokes Google tokens, and deletes the file', async () => {
    saveStoredSession(
      storedSession({ google_access_token: 'g-access', google_refresh_token: 'g-refresh' }),
      homeDir,
    );
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/auth/logout')) return jsonResponse(200, { ok: true });
      if (url.includes('oauth2.googleapis.com/revoke')) return jsonResponse(200, {});
      return jsonResponse(200, {});
    });
    await signOut({ homeDir, fetchImpl });
    expect(fs.existsSync(sessionFilePath(homeDir))).toBe(false);
    const urls = fetchImpl.calls.map((c) => c.url);
    expect(urls.some((u) => u.includes('/auth/logout'))).toBe(true);
    // Both Google tokens revoked (access-only revoke would leave refresh live).
    expect(urls.filter((u) => u.includes('/revoke')).length).toBe(2);
    const logout = fetchImpl.calls.find((c) => c.url.includes('/auth/logout'));
    expect(logout?.body).toEqual({ refresh_token: 'refresh-1' });
  });

  it('never throws when the gateway is unreachable', async () => {
    saveStoredSession(storedSession(), homeDir);
    await expect(signOut({ homeDir, fetchImpl: failingFetch })).resolves.toBeUndefined();
    expect(fs.existsSync(sessionFilePath(homeDir))).toBe(false);
  });
});

// -- machineId -----------------------------------------------------------------

describe('machineId', () => {
  it('is stable across calls and is a sha256 hex string', () => {
    const a = machineId(homeDir);
    const b = machineId(homeDir);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Different home → different id (homedir is part of the hash input).
    expect(machineId(path.join(homeDir, 'other'))).not.toBe(a);
  });
});
