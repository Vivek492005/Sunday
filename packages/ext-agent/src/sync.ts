// sunday-agent — end-to-end encrypted session sync (D3).
//
// CRYPTO DESIGN (why a passphrase, and not the session token):
// The sync blob must stay opaque to the gateway operator. The Sunday
// session JWT is issued BY the gateway, so a key derived from it could be
// re-derived server-side — that would not be end-to-end encryption. Instead
// the AES-GCM key comes from a user-chosen passphrase via PBKDF2-SHA256
// (100,000 iterations). The passphrase is asked through an input box, never
// stored, never logged, and never sent anywhere: only the ciphertext blob
// leaves the machine, and the server stores it verbatim (see the security
// contract in packages/hosted-gateway/src/sync.ts).
//
// Opt-in: `sunday.sync.enabled` (default false). When disabled, the
// commands explain how to enable instead of doing anything.

import { webcrypto } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  getSessionToken,
  resolveGatewayUrl,
  DEFAULT_GATEWAY_URL,
  type GatewayFetch,
} from './usage/gatewayClient.js';

/** PBKDF2 iteration count (matches the envelope's `iterations` field). */
export const PBKDF2_ITERATIONS = 100_000;
/** Client-side mirror of the gateway's 5 MiB blob cap. */
export const SYNC_BLOB_MAX_BYTES = 5 * 1024 * 1024;
/** Command ids. */
export const SYNC_UPLOAD_COMMAND = 'sunday.sync.upload';
export const SYNC_DOWNLOAD_COMMAND = 'sunday.sync.download';
/** Shown when the commands run while sync is disabled. */
export const SYNC_DISABLED_MESSAGE =
  'Session sync is disabled. Enable it in Settings → Sunday → Sync: Enabled ' +
  '(sunday.sync.enabled), then run this command again.';

/** What gets encrypted: sessions, memories metadata, and rules. */
export interface SyncPayload {
  version: 1;
  exportedAt: string;
  /** Session metadata (the sidecar owns live sessions; reserved for now). */
  sessions: unknown[];
  /** Long-term memory records (metadata; content stays local-first). */
  memoriesMeta: unknown;
  rules: unknown[];
}

/** Opaque envelope stored on the gateway. The server never looks inside. */
export interface EncryptedSyncEnvelope {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  /** base64 salt (16 bytes) */
  salt: string;
  /** base64 IV (12 bytes) */
  iv: string;
  /** base64 AES-GCM-256 ciphertext */
  data: string;
}

export class SyncCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncCryptoError';
  }
}

/** Decryption failed: wrong passphrase or tampered blob. */
export class WrongPassphraseError extends SyncCryptoError {
  constructor() {
    super('Could not decrypt the synced data — wrong passphrase or corrupted blob.');
    this.name = 'WrongPassphraseError';
  }
}

const b64encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const b64decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await webcrypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a sync payload with the user's passphrase. Returns the JSON
 * envelope string (the opaque blob sent to the gateway).
 */
export async function encryptSyncPayload(
  payload: SyncPayload,
  passphrase: string,
): Promise<string> {
  if (!passphrase) throw new SyncCryptoError('a passphrase is required');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource));
  const envelope: EncryptedSyncEnvelope = {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: b64encode(salt),
    iv: b64encode(iv),
    data: b64encode(ct),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(blobJson: string): EncryptedSyncEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blobJson);
  } catch {
    throw new SyncCryptoError('synced blob is not valid JSON');
  }
  const e = parsed as Partial<EncryptedSyncEnvelope>;
  if (
    e?.v !== 1 ||
    e?.kdf !== 'pbkdf2-sha256' ||
    e?.iterations !== PBKDF2_ITERATIONS ||
    typeof e?.salt !== 'string' ||
    typeof e?.iv !== 'string' ||
    typeof e?.data !== 'string'
  ) {
    throw new SyncCryptoError('synced blob has an unrecognized envelope');
  }
  return e as EncryptedSyncEnvelope;
}

/**
 * Decrypt a blob envelope with the user's passphrase. Throws
 * WrongPassphraseError when the passphrase is wrong or the blob was
 * tampered with (AES-GCM authentication failure).
 */
export async function decryptSyncPayload(
  blobJson: string,
  passphrase: string,
): Promise<SyncPayload> {
  if (!passphrase) throw new SyncCryptoError('a passphrase is required');
  const env = parseEnvelope(blobJson);
  const key = await deriveKey(passphrase, b64decode(env.salt));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(env.iv) as BufferSource },
      key,
      b64decode(env.data) as BufferSource,
    );
  } catch {
    throw new WrongPassphraseError();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new SyncCryptoError('decrypted payload is not valid JSON');
  }
  const p = payload as Partial<SyncPayload>;
  if (p?.version !== 1 || !Array.isArray(p?.sessions) || !Array.isArray(p?.rules)) {
    throw new SyncCryptoError('decrypted payload has an unrecognized shape');
  }
  return payload as SyncPayload;
}

// -- data sources (injectable; file-backed defaults) ---------------------------

/** Reads the local state that sync covers. */
export interface SyncDataSource {
  listSessions(): Promise<unknown[]>;
  listMemoriesMeta(): Promise<unknown>;
  listRules(): Promise<unknown[]>;
}

/** Applies downloaded state (after the user's confirmation). */
export interface SyncApplier {
  replaceMemoriesMeta(meta: unknown): Promise<void>;
  replaceRules(rules: unknown[]): Promise<void>;
}

function sundayDir(homeDir: string): string {
  return path.join(homeDir, '.sunday');
}

/**
 * File-backed data source over ~/.sunday (same files the memory/rules
 * panels read). Sessions live in the sidecar, not on disk — the sessions
 * list is reserved as [] until the daemon exposes export (documented).
 */
export function createFileSyncDataSource(homeDir: string = os.homedir()): SyncDataSource {
  const memoryFile = path.join(sundayDir(homeDir), 'memory', 'memories.jsonl');
  const rulesFile = path.join(sundayDir(homeDir), 'rules.md');
  return {
    listSessions: async () => [],
    listMemoriesMeta: async () => {
      try {
        const raw = await fs.promises.readFile(memoryFile, 'utf8');
        return raw
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              const m = JSON.parse(l) as Record<string, unknown>;
              // Metadata only: ids, timestamps, projects, tags — full text
              // stays local-first unless the user opts in.
              return {
                id: m.id,
                timestamp: m.timestamp ?? m.createdAt,
                project: m.project,
                tags: m.tags,
                source: m.source,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    listRules: async () => {
      try {
        const raw = await fs.promises.readFile(rulesFile, 'utf8');
        return raw
          .split('\n')
          .filter((l) => l.trim().startsWith('- '))
          .map((l) => l.trim().slice(2));
      } catch {
        return [];
      }
    },
  };
}

/**
 * File-backed applier. Backs up the current files (<name>.bak) before
 * overwriting so a bad download is recoverable.
 */
export function createFileSyncApplier(homeDir: string = os.homedir()): SyncApplier {
  const memoryFile = path.join(sundayDir(homeDir), 'memory', 'memories.jsonl');
  const rulesFile = path.join(sundayDir(homeDir), 'rules.md');

  const backupAndWrite = async (file: string, content: string): Promise<void> => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try {
      const current = await fs.promises.readFile(file, 'utf8');
      await fs.promises.writeFile(`${file}.bak`, current, 'utf8');
    } catch {
      /* nothing to back up */
    }
    await fs.promises.writeFile(file, content, 'utf8');
  };

  return {
    replaceMemoriesMeta: async (meta: unknown) => {
      // Meta-only sync restores the metadata records; full text is rebuilt
      // by the memory system on next write. Stored as JSONL like the source.
      const rows = Array.isArray(meta) ? meta : [];
      await backupAndWrite(
        memoryFile,
        rows.map((r) => JSON.stringify(r)).join('\n'),
      );
    },
    replaceRules: async (rules: unknown[]) => {
      const lines = (Array.isArray(rules) ? rules : []).map((r) => `- ${String(r)}`);
      await backupAndWrite(rulesFile, lines.join('\n') + '\n');
    },
  };
}

// -- upload / download orchestration (vscode-free, fully testable) -------------

export interface SyncOrchestrationDeps {
  isEnabled(): boolean;
  promptPassphrase(mode: 'upload' | 'download'): Promise<string | undefined>;
  /** Confirm destructive download; receives the blob's updated_at. */
  confirmDownload(updatedAt: string): Promise<boolean>;
  dataSource: SyncDataSource;
  applier: SyncApplier;
  fetchImpl: GatewayFetch;
  gatewayUrl: string;
  getToken(): Promise<string | undefined>;
  showInfo(msg: string): void | Promise<void>;
  showError(msg: string): void | Promise<void>;
  log(msg: string): void;
}

export type SyncOutcome =
  | 'uploaded'
  | 'applied'
  | 'cancelled'
  | 'disabled'
  | 'failed'
  | 'empty';

async function requireTokenAndPassphrase(
  deps: SyncOrchestrationDeps,
  mode: 'upload' | 'download',
): Promise<{ token: string; passphrase: string } | 'signed-out' | 'cancelled'> {
  const token = await deps.getToken();
  if (!token) {
    await deps.showError('Sign in to Sunday (status bar → Sunday Account) before syncing.');
    return 'signed-out';
  }
  const passphrase = await deps.promptPassphrase(mode);
  if (!passphrase) return 'cancelled'; // user dismissed the input box
  return { token, passphrase };
}

/** Encrypt the local state and push it to the gateway. */
export async function uploadSync(deps: SyncOrchestrationDeps): Promise<SyncOutcome> {
  if (!deps.isEnabled()) {
    await deps.showInfo(SYNC_DISABLED_MESSAGE);
    return 'disabled';
  }
  const creds = await requireTokenAndPassphrase(deps, 'upload');
  if (creds === 'signed-out') return 'failed';
  if (creds === 'cancelled') return 'cancelled';
  try {
    const [sessions, memoriesMeta, rules] = await Promise.all([
      deps.dataSource.listSessions(),
      deps.dataSource.listMemoriesMeta(),
      deps.dataSource.listRules(),
    ]);
    const payload: SyncPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions,
      memoriesMeta,
      rules,
    };
    const blob = await encryptSyncPayload(payload, creds.passphrase);
    if (Buffer.byteLength(blob, 'utf8') > SYNC_BLOB_MAX_BYTES) {
      await deps.showError(
        `Synced data is too large (${(Buffer.byteLength(blob, 'utf8') / 1048576).toFixed(1)} MiB > 5 MiB).`,
      );
      return 'failed';
    }
    const updatedAt = payload.exportedAt;
    const res = await deps.fetchImpl(`${deps.gatewayUrl}/sync/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blob, updated_at: updatedAt }),
    });
    if (!res.ok) {
      await deps.showError(`Sync upload failed (HTTP ${res.status}).`);
      return 'failed';
    }
    await deps.showInfo('Sunday session sync uploaded (end-to-end encrypted).');
    return 'uploaded';
  } catch (err) {
    deps.log(`sync upload failed: ${(err as Error).message}`);
    await deps.showError(`Sync upload failed: ${(err as Error).message}`);
    return 'failed';
  }
}

/** Pull the blob, decrypt it, and (after confirmation) apply it locally. */
export async function downloadSync(deps: SyncOrchestrationDeps): Promise<SyncOutcome> {
  if (!deps.isEnabled()) {
    await deps.showInfo(SYNC_DISABLED_MESSAGE);
    return 'disabled';
  }
  const creds = await requireTokenAndPassphrase(deps, 'download');
  if (creds === 'signed-out') return 'failed';
  if (creds === 'cancelled') return 'cancelled';
  try {
    const res = await deps.fetchImpl(`${deps.gatewayUrl}/sync/sessions`, {
      headers: { authorization: `Bearer ${creds.token}` },
    });
    if (res.status === 404) {
      await deps.showInfo('No synced data found for this Sunday account yet.');
      return 'empty';
    }
    if (!res.ok) {
      await deps.showError(`Sync download failed (HTTP ${res.status}).`);
      return 'failed';
    }
    const body = (await res.json()) as { blob?: unknown; updated_at?: unknown };
    if (typeof body.blob !== 'string' || typeof body.updated_at !== 'string') {
      await deps.showError('Sync download returned an unexpected response.');
      return 'failed';
    }
    let payload: SyncPayload;
    try {
      payload = await decryptSyncPayload(body.blob, creds.passphrase);
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        await deps.showError('Wrong passphrase — the synced data could not be decrypted.');
      } else {
        await deps.showError(`Could not read synced data: ${(err as Error).message}`);
      }
      return 'failed';
    }
    const confirmed = await deps.confirmDownload(body.updated_at);
    if (!confirmed) return 'cancelled';
    await deps.applier.replaceMemoriesMeta(payload.memoriesMeta);
    await deps.applier.replaceRules(payload.rules);
    await deps.showInfo(
      `Synced data from ${body.updated_at} applied (previous files backed up as .bak).`,
    );
    return 'applied';
  } catch (err) {
    deps.log(`sync download failed: ${(err as Error).message}`);
    await deps.showError(`Sync download failed: ${(err as Error).message}`);
    return 'failed';
  }
}

// -- vscode wiring --------------------------------------------------------------

export interface RegisterSyncDeps {
  context: vscode.ExtensionContext;
  log?: (msg: string) => void;
  /** Override for tests. */
  fetchImpl?: GatewayFetch;
  dataSource?: SyncDataSource;
  applier?: SyncApplier;
}

/**
 * Register `sunday.sync.upload` / `sunday.sync.download`. Thin shell over
 * the testable orchestration above.
 */
export function registerSyncCommands(deps: RegisterSyncDeps): vscode.Disposable[] {
  const { context } = deps;
  const log = deps.log ?? (() => undefined);
  const fetchImpl: GatewayFetch =
    deps.fetchImpl ??
    (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const r = await fetch(url, init);
      return {
        ok: r.ok,
        status: r.status,
        json: () => r.json() as Promise<unknown>,
      };
    });
  // NOTE: GatewayFetch lacks text(); the orchestration never calls it.
  const dataSource = deps.dataSource ?? createFileSyncDataSource();
  const applier = deps.applier ?? createFileSyncApplier();

  const base = (): SyncOrchestrationDeps => ({
    isEnabled: () => vscode.workspace.getConfiguration('sunday').get<boolean>('sync.enabled', false),
    promptPassphrase: async (mode) =>
      vscode.window.showInputBox({
        password: true,
        prompt:
          mode === 'upload'
            ? 'Passphrase to encrypt your synced data (never stored or sent)'
            : 'Passphrase to decrypt your synced data',
        placeHolder: 'Sync passphrase',
      }),
    confirmDownload: async (updatedAt) => {
      const pick = await vscode.window.showWarningMessage(
        `Replace local Sunday memories and rules with the synced copy from ${updatedAt}? ` +
          'Current files are backed up as .bak first.',
        { modal: true },
        'Replace',
      );
      return pick === 'Replace';
    },
    dataSource,
    applier,
    fetchImpl,
    gatewayUrl: (() => {
      try {
        return resolveGatewayUrl(vscode.workspace.getConfiguration('sunday'));
      } catch {
        return DEFAULT_GATEWAY_URL;
      }
    })(),
    getToken: () =>
      getSessionToken({
        getExtensionExports: (id) => vscode.extensions.getExtension(id)?.exports,
        secretGet: async (key) => {
          const v = await context.secrets.get(key);
          return v ?? undefined;
        },
      }),
    showInfo: (msg) => {
      void vscode.window.showInformationMessage(msg);
    },
    showError: (msg) => {
      void vscode.window.showErrorMessage(msg);
    },
    log,
  });

  return [
    vscode.commands.registerCommand(SYNC_UPLOAD_COMMAND, () => {
      void uploadSync(base());
    }),
    vscode.commands.registerCommand(SYNC_DOWNLOAD_COMMAND, () => {
      void downloadSync(base());
    }),
  ];
}
