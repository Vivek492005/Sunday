// Tests for sync.ts (D3): crypto round-trip, wrong-passphrase failure,
// envelope validation, upload/download orchestration (disabled path,
// cancel paths, confirm gate, error paths). No network, no vscode — the
// vscode shell is a thin wrapper over the tested orchestration.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showInputBox: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
  commands: { registerCommand: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  extensions: { getExtension: () => undefined },
}));

import {
  createFileSyncApplier,
  createFileSyncDataSource,
  decryptSyncPayload,
  downloadSync,
  encryptSyncPayload,
  PBKDF2_ITERATIONS,
  SYNC_BLOB_MAX_BYTES,
  SYNC_DISABLED_MESSAGE,
  SyncCryptoError,
  uploadSync,
  WrongPassphraseError,
  type SyncOrchestrationDeps,
  type SyncPayload,
} from './sync.js';

const payload: SyncPayload = {
  version: 1,
  exportedAt: '2026-10-08T05:30:00.000Z',
  sessions: [],
  memoriesMeta: [{ id: 'm1', project: 'p' }],
  rules: ['always run tests'],
};

function baseDeps(overrides: Partial<SyncOrchestrationDeps> = {}): SyncOrchestrationDeps {
  return {
    isEnabled: () => true,
    promptPassphrase: async () => 'correct horse battery staple',
    confirmDownload: async () => true,
    dataSource: {
      listSessions: async () => [],
      listMemoriesMeta: async () => [{ id: 'm1' }],
      listRules: async () => ['r1'],
    },
    applier: {
      replaceMemoriesMeta: async () => undefined,
      replaceRules: async () => undefined,
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    gatewayUrl: 'https://gw.example.com',
    getToken: async () => 'session-token',
    showInfo: () => undefined,
    showError: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

describe('encrypt/decrypt round-trip', () => {
  it('decrypts what it encrypts', async () => {
    const blob = await encryptSyncPayload(payload, 's3cret!');
    const back = await decryptSyncPayload(blob, 's3cret!');
    expect(back).toEqual(payload);
  });

  it('uses PBKDF2-SHA256 with 100k iterations (envelope documents it)', async () => {
    const blob = await encryptSyncPayload(payload, 'pw');
    const env = JSON.parse(blob);
    expect(env.v).toBe(1);
    expect(env.kdf).toBe('pbkdf2-sha256');
    expect(env.iterations).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(typeof env.salt).toBe('string');
    expect(typeof env.iv).toBe('string');
    expect(typeof env.data).toBe('string');
  });

  it('produces different ciphertexts for the same input (random salt/iv)', async () => {
    const a = await encryptSyncPayload(payload, 'pw');
    const b = await encryptSyncPayload(payload, 'pw');
    expect(a).not.toBe(b);
    expect(await decryptSyncPayload(a, 'pw')).toEqual(payload);
    expect(await decryptSyncPayload(b, 'pw')).toEqual(payload);
  });

  it('wrong passphrase fails with WrongPassphraseError', async () => {
    const blob = await encryptSyncPayload(payload, 'right');
    await expect(decryptSyncPayload(blob, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('tampered ciphertext fails authentication', async () => {
    const blob = await encryptSyncPayload(payload, 'pw');
    const env = JSON.parse(blob);
    // Flip a byte in the ciphertext.
    const data = Buffer.from(env.data, 'base64');
    data[0] ^= 0xff;
    env.data = data.toString('base64');
    await expect(decryptSyncPayload(JSON.stringify(env), 'pw')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it('rejects malformed envelopes', async () => {
    await expect(decryptSyncPayload('not json', 'pw')).rejects.toBeInstanceOf(SyncCryptoError);
    await expect(decryptSyncPayload('{"v":2}', 'pw')).rejects.toBeInstanceOf(SyncCryptoError);
  });

  it('requires a passphrase', async () => {
    await expect(encryptSyncPayload(payload, '')).rejects.toBeInstanceOf(SyncCryptoError);
    await expect(decryptSyncPayload('{}', '')).rejects.toBeInstanceOf(SyncCryptoError);
  });

  it('never embeds the passphrase in the blob', async () => {
    const blob = await encryptSyncPayload(payload, 'super-secret-passphrase');
    expect(blob).not.toContain('super-secret-passphrase');
  });
});

describe('uploadSync', () => {
  it('explains how to enable when disabled (no network, no prompt)', async () => {
    const showInfo = vi.fn();
    const fetchImpl = vi.fn();
    const promptPassphrase = vi.fn();
    const outcome = await uploadSync(
      baseDeps({ isEnabled: () => false, showInfo, fetchImpl: fetchImpl as any, promptPassphrase }),
    );
    expect(outcome).toBe('disabled');
    expect(showInfo).toHaveBeenCalledWith(SYNC_DISABLED_MESSAGE);
    expect(SYNC_DISABLED_MESSAGE).toContain('sunday.sync.enabled');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(promptPassphrase).not.toHaveBeenCalled();
  });

  it('POSTs the encrypted blob with the session bearer token', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fetchImpl = async (url: string, init: any) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const showInfo = vi.fn();
    const outcome = await uploadSync(baseDeps({ fetchImpl: fetchImpl as any, showInfo }));
    expect(outcome).toBe('uploaded');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://gw.example.com/sync/sessions');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers.authorization).toBe('Bearer session-token');
    const body = JSON.parse(seen[0].init.body);
    expect(typeof body.blob).toBe('string');
    expect(typeof body.updated_at).toBe('string');
    // The blob decrypts with the prompted passphrase.
    expect(await decryptSyncPayload(body.blob, 'correct horse battery staple')).toMatchObject({
      version: 1,
      rules: ['r1'],
    });
    expect(showInfo).toHaveBeenCalled();
  });

  it('returns cancelled when the passphrase prompt is dismissed', async () => {
    const fetchImpl = vi.fn();
    const outcome = await uploadSync(
      baseDeps({ promptPassphrase: async () => undefined, fetchImpl: fetchImpl as any }),
    );
    expect(outcome).toBe('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails gracefully when signed out', async () => {
    const showError = vi.fn();
    const outcome = await uploadSync(baseDeps({ getToken: async () => undefined, showError }));
    expect(outcome).toBe('failed');
    expect(showError).toHaveBeenCalled();
  });

  it('fails gracefully on HTTP errors', async () => {
    const showError = vi.fn();
    const outcome = await uploadSync(
      baseDeps({
        fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any,
        showError,
      }),
    );
    expect(outcome).toBe('failed');
    expect(showError).toHaveBeenCalled();
  });
});

describe('downloadSync', () => {
  const serverBlob = (pw: string) =>
    encryptSyncPayload(
      { version: 1, exportedAt: '2026-10-07T00:00:00.000Z', sessions: [], memoriesMeta: [{ id: 's1' }], rules: ['synced-rule'] },
      pw,
    );

  function downloadDeps(blob: string, overrides: Partial<SyncOrchestrationDeps> = {}) {
    const applier = {
      replaceMemoriesMeta: vi.fn(async () => undefined),
      replaceRules: vi.fn(async () => undefined),
    };
    return {
      deps: baseDeps({
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ blob, updated_at: '2026-10-07T00:00:00.000Z' }),
        })) as any,
        applier,
        ...overrides,
      }),
      applier,
    };
  }

  it('decrypts, confirms, and applies', async () => {
    const { deps, applier } = downloadDeps(await serverBlob('correct horse battery staple'));
    const showInfo = vi.fn();
    const outcome = await downloadSync({ ...deps, showInfo });
    expect(outcome).toBe('applied');
    expect(applier.replaceRules).toHaveBeenCalledWith(['synced-rule']);
    expect(applier.replaceMemoriesMeta).toHaveBeenCalledWith([{ id: 's1' }]);
    expect(showInfo).toHaveBeenCalled();
  });

  it('explains how to enable when disabled', async () => {
    const showInfo = vi.fn();
    const { deps } = downloadDeps(await serverBlob('x'), { isEnabled: () => false, showInfo });
    expect(await downloadSync(deps)).toBe('disabled');
    expect(showInfo).toHaveBeenCalledWith(SYNC_DISABLED_MESSAGE);
  });

  it('wrong passphrase fails without applying', async () => {
    const { deps, applier } = downloadDeps(await serverBlob('the-real-passphrase'));
    const showError = vi.fn();
    const outcome = await downloadSync({ ...deps, showError });
    expect(outcome).toBe('failed');
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('Wrong passphrase'));
    expect(applier.replaceRules).not.toHaveBeenCalled();
  });

  it('cancelled confirmation does not apply', async () => {
    const { deps, applier } = downloadDeps(await serverBlob('correct horse battery staple'), {
      confirmDownload: async () => false,
    });
    expect(await downloadSync(deps)).toBe('cancelled');
    expect(applier.replaceRules).not.toHaveBeenCalled();
  });

  it('404 means no synced data yet', async () => {
    const showInfo = vi.fn();
    const outcome = await downloadSync(
      baseDeps({
        fetchImpl: (async () => ({ ok: false, status: 404, json: async () => ({}) })) as any,
        showInfo,
      }),
    );
    expect(outcome).toBe('empty');
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining('No synced data'));
  });
});

describe('file-backed data source / applier', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reads memories metadata and rules from ~/.sunday', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sunday-sync-home-'));
    dirs.push(home);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(home, '.sunday', 'memory'), { recursive: true });
    writeFileSync(
      join(home, '.sunday', 'memory', 'memories.jsonl'),
      JSON.stringify({ id: 'm1', text: 'secret text', project: 'p', tags: ['t'], source: 'auto' }) + '\n',
    );
    writeFileSync(join(home, '.sunday', 'rules.md'), '- rule one\n- rule two\n');
    const ds = createFileSyncDataSource(home);
    expect(await ds.listSessions()).toEqual([]);
    const meta = (await ds.listMemoriesMeta()) as any[];
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe('m1');
    expect(meta[0].text).toBeUndefined(); // metadata only
    expect(await ds.listRules()).toEqual(['rule one', 'rule two']);
  });

  it('backs up before overwriting on apply', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sunday-sync-home-'));
    dirs.push(home);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(home, '.sunday', 'memory'), { recursive: true });
    writeFileSync(join(home, '.sunday', 'memory', 'memories.jsonl'), '{"id":"old"}\n');
    writeFileSync(join(home, '.sunday', 'rules.md'), '- old rule\n');
    const applier = createFileSyncApplier(home);
    await applier.replaceRules(['new rule']);
    expect(readFileSync(join(home, '.sunday', 'rules.md'), 'utf8')).toContain('- new rule');
    expect(readFileSync(join(home, '.sunday', 'rules.md.bak'), 'utf8')).toContain('- old rule');
    await applier.replaceMemoriesMeta([{ id: 'm9' }]);
    expect(readFileSync(join(home, '.sunday', 'memory', 'memories.jsonl.bak'), 'utf8')).toContain(
      '"old"',
    );
  });

  it('exposes the 5 MiB cap', () => {
    expect(SYNC_BLOB_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
