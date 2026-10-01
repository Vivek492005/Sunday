import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderMessage } from '@sunday/gateway';
import { ErrorCode, type Session } from '@sunday/protocol';
import { RpcError } from './transport.js';

/** A session plus its conversation history (history is sundayd-private;
 *  the protocol Session surface stays lean). */
export interface StoredSession extends Session {
  messages: ProviderMessage[];
}

export interface SessionCreateParams {
  title?: string;
  cwd?: string;
  model?: string;
}

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.sunday', 'sessions');
}

function stripHistory(s: StoredSession): Session {
  const { messages: _messages, ...rest } = s;
  return rest;
}

/** Session lifecycle + JSON persistence (§7/§9). One file per session under
 *  `~/.sunday/sessions/<id>.json`; `close` drops the in-memory handle but
 *  keeps the file so `restore` can bring the session back. */
export class SessionStore {
  private sessions = new Map<string, StoredSession>();

  constructor(private dir: string = defaultSessionsDir()) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // Clean up temp files orphaned by a crashed persist.
    for (const f of await fs.readdir(this.dir).catch(() => [] as string[])) {
      if (f.endsWith('.tmp')) await fs.unlink(path.join(this.dir, f)).catch(() => undefined);
    }
    await this.loadAll();
  }

  create(params: SessionCreateParams = {}): StoredSession {
    const now = new Date().toISOString();
    const s: StoredSession = {
      id: randomUUID(),
      title: params.title ?? 'Untitled session',
      createdAt: now,
      updatedAt: now,
      cwd: params.cwd,
      model: params.model,
      messages: [],
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Protocol-safe session list (no conversation history). */
  list(): Session[] {
    return [...this.sessions.values()].map(stripHistory);
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  /** Get a live session or throw a SessionNotFound RpcError. */
  require(id: string): StoredSession {
    const s = this.sessions.get(id);
    if (!s) throw new RpcError(ErrorCode.SessionNotFound, `session not found: ${id}`);
    return s;
  }

  /** Like require(), but reloads the session file from disk if it was closed
   *  (close only unloads the in-memory handle — the file is the durable record). */
  async restore(id: string): Promise<StoredSession> {
    const live = this.sessions.get(id);
    if (live) return live;
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8'),
      ) as StoredSession;
      if (typeof raw?.id !== 'string' || !Array.isArray(raw.messages)) {
        throw new Error('bad session file');
      }
      this.sessions.set(raw.id, raw);
      return raw;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(ErrorCode.SessionNotFound, `session not found: ${id}`);
    }
  }

  /** Drop the in-memory handle; the file on disk is kept for `restore`. */
  close(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Persist one session (history included). The write is atomic (temp file +
   *  rename) so a crash or racing shutdown can never leave a truncated file. */
  async persist(s: StoredSession): Promise<void> {
    s.updatedAt = new Date().toISOString();
    const full = path.join(this.dir, `${s.id}.json`);
    const tmp = `${full}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s));
    await fs.rename(tmp, full);
  }

  /** Load every persisted session file into memory. Corrupt files are skipped
   *  (renamed to *.corrupt) so one bad file can't wedge the daemon. */
  private async loadAll(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(this.dir, f);
      try {
        const raw = JSON.parse(await fs.readFile(full, 'utf8')) as StoredSession;
        if (typeof raw?.id !== 'string' || !Array.isArray(raw.messages)) throw new Error('bad session file');
        this.sessions.set(raw.id, raw);
      } catch {
        await fs.rename(full, `${full}.corrupt`).catch(() => undefined);
      }
    }
  }
}
