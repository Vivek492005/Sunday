// sundayd — F6 Durable Sessions: event-sourced session log.
//
// Every session mutation (message, tool call/result, approval, checkpoint,
// compaction, branch, rewind) is appended as one JSON object per line to
// `~/.sunday/sessions/<id>.log`. Session state is *derived* by replaying the
// log, so a crash or upgrade can never lose conversation history — the reader
// stops at the last checksum-consistent entry and quarantines any torn tail.
//
// Durability: appends are buffered and flushed in batches with fsync
// (SessionLog.flush). A torn final line (kill -9 mid-write) fails either
// JSON.parse or the checksum, so reopen recovers exactly the consistent
// prefix — never a half entry.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Log schema version. Readers accept <= current; writers stamp current.
 *  Bump when the entry shape changes (forward-compatible reader). */
export const SESSION_LOG_SCHEMA_VERSION = 1;

/** Flush the OS buffer after this many buffered entries (fsync batching). */
export const LOG_FLUSH_BATCH = 32;

/** Cap per-entry payload JSON at 256 KiB — tool outputs are summarized, not
 *  dumped whole, so one giant result can't bloat the log. */
export const MAX_ENTRY_PAYLOAD_BYTES = 256 * 1024;

export type SessionLogEntryType =
  | 'session_created'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'checkpoint'
  | 'compaction'
  | 'settings_snapshot'
  | 'branch'
  | 'rewind';

export interface SessionLogEntry {
  schemaVersion: number;
  /** 1-based, monotonic within one log file. */
  seq: number;
  /** Stable entry id — the rewind/branch target handle. */
  id: string;
  sessionId: string;
  /** ISO-8601. */
  ts: string;
  type: SessionLogEntryType;
  payload: Record<string, unknown>;
  /** sha256 over the canonical tuple (see entryChecksum). */
  checksum: string;
}

/** Canonical checksum input — array form, so key order can never drift. */
export function entryChecksum(e: Omit<SessionLogEntry, 'checksum'>): string {
  const canonical = JSON.stringify([
    e.schemaVersion,
    e.seq,
    e.id,
    e.sessionId,
    e.ts,
    e.type,
    e.payload,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function verifyEntry(e: SessionLogEntry): boolean {
  if (typeof e !== 'object' || e === null) return false;
  if (e.schemaVersion > SESSION_LOG_SCHEMA_VERSION) return false;
  if (!Number.isInteger(e.seq) || e.seq < 1) return false;
  if (typeof e.id !== 'string' || typeof e.sessionId !== 'string') return false;
  if (typeof e.ts !== 'string' || typeof e.type !== 'string') return false;
  if (typeof e.payload !== 'object' || e.payload === null) return false;
  if (typeof e.checksum !== 'string') return false;
  return entryChecksum(e) === e.checksum;
}

export interface ReadLogResult {
  entries: SessionLogEntry[];
  /** True when a torn/corrupt tail was found and excluded. */
  truncated: boolean;
  /** Raw bytes of the excluded tail (for forensics / .bad archival). */
  badTail: string;
  /** Byte offset of the first bad byte (= length of the good prefix). */
  goodBytes: number;
}

/**
 * Read + verify a log file. Returns the longest checksum-consistent prefix;
 * a torn final line (partial JSON, bad checksum, unknown future schema) ends
 * the prefix — the session recovers to the last good entry, never garbage.
 */
export async function readLogFile(logPath: string): Promise<ReadLogResult> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { entries: [], truncated: false, badTail: '', goodBytes: 0 };
    }
    throw e;
  }
  const entries: SessionLogEntry[] = [];
  let offset = 0;
  let truncated = false;
  let badTail = '';
  // Split keeping offsets: iterate lines manually so we know goodBytes.
  const lines = raw.split('\n');
  // A trailing newline after the last entry is fine (not a torn line).
  const lastIsEmpty = lines.length > 0 && lines[lines.length - 1] === '';
  const dataLines = lastIsEmpty ? lines.slice(0, -1) : lines;
  let expectedSeq = 1;
  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i];
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1; // + '\n'
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      truncated = true;
      badTail = raw.slice(lineStart);
      offset = lineStart;
      break;
    }
    const entry = parsed as SessionLogEntry;
    if (!verifyEntry(entry) || entry.seq !== expectedSeq) {
      truncated = true;
      badTail = raw.slice(lineStart);
      offset = lineStart;
      break;
    }
    entries.push(entry);
    expectedSeq++;
  }
  return { entries, truncated, badTail, goodBytes: offset };
}

/** Outcome of a replay: the derived session state. */
export interface ReplayResult {
  messages: Array<{ role: string; content: unknown; toolCallId?: string; toolCalls?: unknown }>;
  /** checkpoint entries in log order: { entryId, checkpointId, label }. */
  checkpoints: Array<{ entryId: string; checkpointId: string; label: string }>;
  /** The newest entry id per type — handy for "latest checkpoint" lookups. */
  latestByType: Partial<Record<SessionLogEntryType, string>>;
  created?: { title?: string; cwd?: string; model?: string };
}

/**
 * State = replay. Folds the entry stream into conversation + checkpoint
 * metadata. `rewind` entries are informational (the log was already
 * rewritten at rewind time); `branch` entries mark provenance.
 */
export function replayLog(entries: SessionLogEntry[]): ReplayResult {
  const messages: ReplayResult['messages'] = [];
  const checkpoints: ReplayResult['checkpoints'] = [];
  const latestByType: ReplayResult['latestByType'] = {};
  let created: ReplayResult['created'];
  for (const e of entries) {
    latestByType[e.type] = e.id;
    switch (e.type) {
      case 'session_created':
        created = {
          title: typeof e.payload.title === 'string' ? e.payload.title : undefined,
          cwd: typeof e.payload.cwd === 'string' ? e.payload.cwd : undefined,
          model: typeof e.payload.model === 'string' ? e.payload.model : undefined,
        };
        break;
      case 'message': {
        const p = e.payload;
        messages.push({
          role: typeof p.role === 'string' ? p.role : 'user',
          content: p.content,
          ...(typeof p.toolCallId === 'string' ? { toolCallId: p.toolCallId } : {}),
          ...(p.toolCalls !== undefined ? { toolCalls: p.toolCalls } : {}),
        });
        break;
      }
      case 'checkpoint':
        if (typeof e.payload.checkpointId === 'string') {
          checkpoints.push({
            entryId: e.id,
            checkpointId: e.payload.checkpointId as string,
            label: typeof e.payload.label === 'string' ? (e.payload.label as string) : '',
          });
        }
        break;
      default:
        break;
    }
  }
  return { messages, checkpoints, latestByType, created };
}

/** Append-only, checksum-verified session log with batched fsync. */
export class SessionLog {
  private handle: FileHandle | null = null;
  private buffer: string[] = [];
  private nextSeq: number;
  private closed = false;

  private constructor(
    readonly dir: string,
    readonly sessionId: string,
    startSeq: number,
  ) {
    this.nextSeq = startSeq;
  }

  static logPath(dir: string, sessionId: string): string {
    return path.join(dir, `${sessionId}.log`);
  }

  /**
   * Open (or create) a session log. On open, any torn tail from a crashed
   * writer is quarantined to `<id>.log.bad.<ts>` and the file is truncated
   * to the last consistent entry — the session always reopens clean.
   */
  static async open(dir: string, sessionId: string): Promise<SessionLog> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const logPath = SessionLog.logPath(dir, sessionId);
    const read = await readLogFile(logPath);
    if (read.truncated && read.badTail) {
      const badPath = `${logPath}.bad.${Date.now()}`;
      await fs.writeFile(badPath, read.badTail, { mode: 0o600 }).catch(() => undefined);
      const handle = await fs.open(logPath, 'r+').catch(() => null);
      if (handle) {
        await handle.truncate(read.goodBytes).catch(() => undefined);
        await handle.close().catch(() => undefined);
      }
    }
    const log = new SessionLog(dir, sessionId, read.entries.length + 1);
    log.handle = await fs.open(logPath, 'a', 0o600);
    return log;
  }

  get seq(): number {
    return this.nextSeq;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Append one entry. Buffered; call flush() (or rely on the batch
   *  threshold / close()) for durability. Returns the stamped entry. */
  async append(type: SessionLogEntryType, payload: Record<string, unknown> = {}): Promise<SessionLogEntry> {
    if (this.closed) throw new Error('session log is closed');
    let payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_ENTRY_PAYLOAD_BYTES) {
      payload = {
        ...payload,
        _truncated: true,
        _originalBytes: Buffer.byteLength(payloadJson, 'utf8'),
      };
      // Re-serialize with the largest string fields elided first.
      const slim: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > 32 * 1024) {
          slim[k] = `${v.slice(0, 32 * 1024)}…[truncated ${Buffer.byteLength(v, 'utf8')} bytes]`;
        } else {
          slim[k] = v;
        }
      }
      payload = slim;
      payloadJson = JSON.stringify(payload);
    }
    const base = {
      schemaVersion: SESSION_LOG_SCHEMA_VERSION,
      seq: this.nextSeq,
      id: randomUUID(),
      sessionId: this.sessionId,
      ts: new Date().toISOString(),
      type,
      payload,
    };
    const entry: SessionLogEntry = { ...base, checksum: entryChecksum(base) };
    this.buffer.push(`${JSON.stringify(entry)}\n`);
    this.nextSeq++;
    if (this.buffer.length >= LOG_FLUSH_BATCH) await this.flush();
    return entry;
  }

  /**
   * Copy entries from another log (rewind archive / branch source) into this
   * one, preserving seq/id/ts/type/payload. When `newSessionId` is given the
   * entries are re-attributed to it (branch); checksums are recomputed either
   * way. The caller must have verified the source entries already.
   */
  async importEntries(entries: SessionLogEntry[], newSessionId?: string): Promise<void> {
    if (this.closed) throw new Error('session log is closed');
    const sid = newSessionId ?? this.sessionId;
    for (const src of entries) {
      const base = {
        schemaVersion: src.schemaVersion,
        seq: src.seq,
        id: src.id,
        sessionId: sid,
        ts: src.ts,
        type: src.type,
        payload: src.payload,
      };
      const entry: SessionLogEntry = { ...base, checksum: entryChecksum(base) };
      this.buffer.push(`${JSON.stringify(entry)}\n`);
      this.nextSeq = Math.max(this.nextSeq, src.seq + 1);
    }
    if (this.buffer.length >= LOG_FLUSH_BATCH) await this.flush();
  }

  /** Write buffered entries + fsync so a kill -9 can't lose them. */
  async flush(): Promise<void> {
    if (this.closed || !this.handle || this.buffer.length === 0) return;
    const data = this.buffer.join('');
    this.buffer = [];
    await this.handle.appendFile(data, 'utf8');
    await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      // Flush BEFORE marking closed — flush() is a no-op once closed.
      await this.flush();
    } finally {
      this.closed = true;
      await this.handle?.close().catch(() => undefined);
      this.handle = null;
    }
  }
}

export function defaultSessionLogDir(): string {
  return path.join(os.homedir(), '.sunday', 'sessions');
}
