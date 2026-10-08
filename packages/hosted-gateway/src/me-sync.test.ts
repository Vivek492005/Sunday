// Route tests for POST/GET /sync/sessions (D3).
//
// - session auth required (401 without token / with API key)
// - POST validates the envelope; blob stored verbatim; 5 MiB cap enforced
// - GET returns the blob + updated_at; 404 when the user never synced
// - the server never decrypts: the stored blob equals the posted blob
//   byte-for-byte (asserted on the file on disk)
import { createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostedGatewayConfig } from './config.js';
import { HostedGatewayServer } from './server.js';
import { MAX_SYNC_BLOB_BYTES } from './sync.js';

const SESSION_SECRET = 'test-session-secret-not-for-production';

function baseConfig(): HostedGatewayConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    keys: [{ id: 'tester', secret: 'test-secret-1' }],
    requestsPerMinute: 1000,
    tokensPerMinute: 1_000_000,
    maxBodyBytes: 64 * 1024,
    maxMessages: 50,
    maxMessageChars: 10_000,
    maxTokensCap: 256,
    allowedModels: [],
    ipAllowlist: [],
    auditLog: '/dev/null',
    upstreamTimeoutMs: 10_000,
    socialAuth: false,
    oauthProviders: ['github'],
    dailyQuota: 200,
    sessionSecret: SESSION_SECRET,
  };
}

/** Mint a Sunday session JWT exactly the way AccountsService does. */
function sessionToken(userId: string): string {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64(JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }));
  const sig = createHmac('sha256', SESSION_SECRET).update(`${h}.${p}`, 'utf8').digest('base64url');
  return `${h}.${p}.${sig}`;
}

const servers: HostedGatewayServer[] = [];
const tmpDirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function startServer(): Promise<{ base: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sunday-sync-route-'));
  tmpDirs.push(dataDir);
  // Another in-flight change loads plans.json from the data dir at startup;
  // seed it so the server boots (harmless when that change lands or not).
  const seed = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'plans.json');
  if (existsSync(seed)) copyFileSync(seed, join(dataDir, 'plans.json'));
  const server = new HostedGatewayServer(baseConfig(), { dataDir });
  await server.listen();
  servers.push(server);
  const a = server.address();
  return { base: `http://${a.host}:${a.port}`, dataDir };
}

async function req(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

describe('/sync/sessions', () => {
  it('requires a valid Sunday session token', async () => {
    const { base } = await startServer();
    expect((await req(base, '/sync/sessions')).status).toBe(401);
    expect((await req(base, '/sync/sessions', { token: 'test-secret-1' })).status).toBe(401);
    expect(
      (
        await req(base, '/sync/sessions', {
          method: 'POST',
          token: 'test-secret-1',
          body: { blob: 'x', updated_at: 't' },
        })
      ).status,
    ).toBe(401);
  });

  it('POST stores the blob verbatim; GET returns it (server never decrypts)', async () => {
    const { base, dataDir } = await startServer();
    const token = sessionToken('sync-user-1');
    const blob = JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', salt: 'abc', iv: 'def', data: 'cipher==' });
    const updatedAt = '2026-10-08T05:30:00.000Z';

    const post = await req(base, '/sync/sessions', {
      method: 'POST',
      token,
      body: { blob, updated_at: updatedAt },
    });
    expect(post.status).toBe(200);
    expect(post.json).toEqual({ ok: true, updated_at: updatedAt });

    const get = await req(base, '/sync/sessions', { token });
    expect(get.status).toBe(200);
    expect(get.json.blob).toBe(blob);
    expect(get.json.updated_at).toBe(updatedAt);

    // On-disk proof: the file contains the posted blob byte-for-byte.
    // Nothing was decrypted, re-serialized, or otherwise transformed.
    const stored = readFileSync(join(dataDir, 'sync', 'sync-user-1.json'), 'utf8');
    expect(JSON.parse(stored).blob).toBe(blob);
    expect(stored).toContain(JSON.stringify(blob).slice(1, -1));
  });

  it('GET returns 404 when the user never synced', async () => {
    const { base } = await startServer();
    const r = await req(base, '/sync/sessions', { token: sessionToken('fresh-user') });
    expect(r.status).toBe(404);
  });

  it('POST validates the envelope', async () => {
    const { base } = await startServer();
    const token = sessionToken('u');
    for (const body of [
      {},
      { blob: '', updated_at: 't' },
      { blob: 42, updated_at: 't' },
      { blob: 'x' }, // missing updated_at
      { blob: 'x', updated_at: 't'.repeat(65) },
    ]) {
      expect((await req(base, '/sync/sessions', { method: 'POST', token, body })).status).toBe(400);
    }
    expect(
      (await req(base, '/sync/sessions', { method: 'POST', token, rawBody: 'not json' })).status,
    ).toBe(400);
  });

  it('enforces the 5 MiB blob cap', async () => {
    const { base } = await startServer();
    const token = sessionToken('u');
    const big = 'x'.repeat(MAX_SYNC_BLOB_BYTES + 100);
    const r = await req(base, '/sync/sessions', {
      method: 'POST',
      token,
      body: { blob: big, updated_at: 't' },
    });
    expect(r.status).toBe(413);
    // Just under the cap is accepted.
    const ok = 'y'.repeat(1024);
    const r2 = await req(base, '/sync/sessions', {
      method: 'POST',
      token,
      body: { blob: ok, updated_at: 't' },
    });
    expect(r2.status).toBe(200);
  });

  it('isolates blobs between users', async () => {
    const { base } = await startServer();
    await req(base, '/sync/sessions', {
      method: 'POST',
      token: sessionToken('alice'),
      body: { blob: 'alice-blob', updated_at: 't' },
    });
    const r = await req(base, '/sync/sessions', { token: sessionToken('bob') });
    expect(r.status).toBe(404);
  });
});
