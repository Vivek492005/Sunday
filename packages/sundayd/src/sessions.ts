import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderMessage } from '@sunday/gateway';
import { ErrorCode, type Session } from '@sunday/protocol';
import { RpcError } from './transport.js';
import { CheckpointManager, defaultWorkspacesDir } from './checkpoints.js';
import {
  SessionLog,
  readLogFile,
  replayLog,
  type SessionLogEntry,
  type SessionLogEntryType,
} from './sessionLog.js';

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

/** Default shadow-git base dir for session checkpoints (injectable in tests). */
export function defaultCheckpointsBaseDir(): string {
  return defaultWorkspacesDir();
}

/** Render a human-readable Markdown transcript of a session's event log. */
export function renderMarkdownTranscript(sessionId: string, entries: SessionLogEntry[]): string {
  const lines: string[] = [`# Sunday session transcript`, ``, `- session: \`${sessionId}\``, ``];
  const textOf = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((p) =>
          typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : '',
        )
        .filter(Boolean)
        .join('\n');
    }
    return typeof content === 'object' && content !== null ? JSON.stringify(content) : String(content ?? '');
  };
  for (const e of entries) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'session_created':
        lines.push(`_Created ${e.ts}${p.title ? ` — ${String(p.title)}` : ''}_`, ``);
        break;
      case 'message': {
        const role = typeof p.role === 'string' ? p.role : 'user';
        lines.push(`## ${role}`, ``, textOf(p.content), ``);
        break;
      }
      case 'tool_call':
        lines.push(`### 🔧 tool_call \`${String(p.name ?? '?')}\``, ``, '```json', JSON.stringify(p.args ?? {}, null, 2), '```', ``);
        break;
      case 'tool_result':
        lines.push(`_tool_result (${p.ok ? 'ok' : 'error'})_`, ``, '```', String(p.summary ?? '').slice(0, 2000), '```', ``);
        break;
      case 'approval':
        lines.push(`_approval: \`${String(p.action ?? '?')}\` → **${String(p.decision ?? '?')}**${p.scope ? ` (scope: ${String(p.scope)})` : ''}_`, ``);
        break;
      case 'checkpoint':
        lines.push(`_checkpoint: \`${String(p.checkpointId ?? '?')}\`${p.label ? ` — ${String(p.label)}` : ''}_`, ``);
        break;
      case 'compaction':
        lines.push(`_compaction: ${String(p.summarizedMessages ?? '?')} messages summarized_`, ``);
        break;
      case 'branch':
        lines.push(`_branched from \`${String(p.parentSessionId ?? '?')}\`_`, ``);
        break;
      case 'rewind':
        lines.push(`_rewound to \`${String(p.targetEntryId ?? '?')}\` (${String(p.droppedEntries ?? 0)} entries dropped)_`, ``);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

/** Retention: sessions older than this are purged on daemon start.
 *  Override with SUNDAY_RETENTION_DAYS (0 = keep forever). Default 30. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SUNDAY_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === '') return 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/** Session lifecycle + JSON persistence (§7/§9). One file per session under
 *  `~/.sunday/sessions/<id>.json`; `close` drops the in-memory handle but
 *  keeps the file so `restore` can bring the session back.
 *
 *  F6 Durable Sessions: every session additionally owns an append-only
 *  event-sourced log (`<id>.log`, see sessionLog.ts). The log is the durable
 *  record — state is replayed from it; the legacy `.json` file is kept as a
 *  migration source and write-through copy. */
export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private logs = new Map<string, SessionLog>();
  /** Messages already reflected in the log, per session (persist reconciles). */
  private loggedMessageCounts = new Map<string, number>();
  private checkpoints: CheckpointManager;

  constructor(
    private dir: string = defaultSessionsDir(),
    checkpointBaseDir?: string,
  ) {
    this.checkpoints = new CheckpointManager(checkpointBaseDir ?? defaultCheckpointsBaseDir());
  }

  /** Lazily open (or create) the event log for a session. */
  private async logFor(sessionId: string): Promise<SessionLog> {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = await SessionLog.open(this.dir, sessionId);
      this.logs.set(sessionId, log);
    }
    return log;
  }

  /** Append one event-sourced entry to a session's log. Never throws for
   *  missing sessions — callers log best-effort during teardown paths. */
  async logEvent(
    sessionId: string,
    type: SessionLogEntryType,
    payload: Record<string, unknown> = {},
  ): Promise<SessionLogEntry | null> {
    try {
      const log = await this.logFor(sessionId);
      return await log.append(type, payload);
    } catch {
      return null;
    }
  }

  /** Convenience: record an approval decision in the log (F6 audit trail). */
  async logApproval(
    sessionId: string,
    action: string,
    decision: 'allow' | 'deny' | 'allow_once',
    scope?: string,
  ): Promise<void> {
    await this.logEvent(sessionId, 'approval', { action, decision, scope });
  }

  /** Flush all open logs (fsync). Called on graceful shutdown. */
  async flushLogs(): Promise<void> {
    for (const log of this.logs.values()) {
      await log.flush().catch(() => undefined);
    }
  }

  /** Close all open log handles (flushes first). */
  async closeLogs(): Promise<void> {
    for (const [id, log] of this.logs) {
      await log.close().catch(() => undefined);
      this.logs.delete(id);
    }
  }

  async init(): Promise<void> {
    // Owner-only: session files contain full conversation history, which
    // may include secrets the user pasted or the model echoed (SEC-12).
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Clean up temp files orphaned by a crashed persist.
    for (const f of await fs.readdir(this.dir).catch(() => [] as string[])) {
      if (f.endsWith('.tmp')) await fs.unlink(path.join(this.dir, f)).catch(() => undefined);
    }
    // P1-2 retention sweep: purge sessions older than the retention window.
    await this.sweepExpired();
    await this.loadAll();
  }

  /** Delete sessions whose updatedAt is older than the retention window.
   *  Returns the number of sessions purged. */
  async sweepExpired(now: number = Date.now()): Promise<number> {
    const days = retentionDays();
    if (days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let purged = 0;
    for (const f of await fs.readdir(this.dir).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(this.dir, f);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(full);
          purged++;
        }
      } catch {
        // ignore races
      }
    }
    return purged;
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
    this.loggedMessageCounts.set(s.id, 0);
    // F6: the session_created entry is written by the caller via logEvent
    // (daemon's session/create handler) so create() stays synchronous.
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

  /** Like require(), but reloads the session from disk if it was closed.
   *  F6: the event log (`<id>.log`) is the primary durable record — state is
   *  replayed from it. The legacy `<id>.json` is used only for one-time
   *  migration of pre-F6 sessions (then the log takes over). */
  async restore(id: string): Promise<StoredSession> {
    const live = this.sessions.get(id);
    if (live) return live;
    const logPath = SessionLog.logPath(this.dir, id);
    const logExists = await fs
      .stat(logPath)
      .then((st) => st.isFile())
      .catch(() => false);
    try {
      if (logExists) {
        const { entries } = await readLogFile(logPath);
        if (entries.length === 0) throw new Error('empty session log');
        const replayed = replayLog(entries);
        const first = entries[0];
        if (first.type !== 'session_created') throw new Error('log missing session_created');
        const now = new Date().toISOString();
        const s: StoredSession = {
          id,
          title: replayed.created?.title ?? 'Untitled session',
          createdAt: first.ts,
          updatedAt: now,
          cwd: replayed.created?.cwd,
          model: replayed.created?.model,
          messages: replayed.messages as ProviderMessage[],
        };
        this.sessions.set(id, s);
        this.loggedMessageCounts.set(id, s.messages.length);
        return s;
      }
      const raw = JSON.parse(
        await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8'),
      ) as StoredSession;
      if (typeof raw?.id !== 'string' || !Array.isArray(raw.messages)) {
        throw new Error('bad session file');
      }
      this.sessions.set(raw.id, raw);
      this.loggedMessageCounts.set(raw.id, 0);
      // One-time migration: seed the event log from the legacy file so all
      // future restores are log-backed.
      await this.migrateLegacyToLog(raw).catch(() => undefined);
      return raw;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(ErrorCode.SessionNotFound, `session not found: ${id}`);
    }
  }

  /** Seed a fresh event log from a pre-F6 legacy session file. */
  private async migrateLegacyToLog(s: StoredSession): Promise<void> {
    const log = await this.logFor(s.id);
    await log.append('session_created', {
      title: s.title,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.model ? { model: s.model } : {}),
      migratedFrom: 'legacy-json',
    });
    for (const m of s.messages) {
      await log.append('message', {
        role: (m as { role?: string }).role ?? 'user',
        content: (m as { content?: unknown }).content,
      });
    }
    await log.flush();
    this.loggedMessageCounts.set(s.id, s.messages.length);
  }

  /** Drop the in-memory handle; the file on disk is kept for `restore`. */
  close(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Permanently delete a session: drops the in-memory handle AND removes
   *  the persisted file + event log. Used by `session/delete` (Privacy M7 —
   *  the user has a right to delete their conversation history). */
  async delete(id: string): Promise<boolean> {
    this.sessions.delete(id);
    this.loggedMessageCounts.delete(id);
    const log = this.logs.get(id);
    if (log) {
      await log.close().catch(() => undefined);
      this.logs.delete(id);
    }
    try {
      await fs.unlink(path.join(this.dir, `${id}.json`));
    } catch {
      // legacy file may not exist for log-only sessions
    }
    try {
      await fs.unlink(SessionLog.logPath(this.dir, id));
      return true;
    } catch {
      return false;
    }
  }

  /** Verified log entries for a session (used by `session/log` RPC). */
  async getLogEntries(id: string): Promise<SessionLogEntry[]> {
    const { entries } = await readLogFile(SessionLog.logPath(this.dir, id));
    return entries;
  }

  /** Create a shadow-git checkpoint of the session workspace and link it in
   *  the event log. Returns the checkpoint id + the log entry id. */
  async createCheckpoint(
    id: string,
    label?: string,
  ): Promise<{ checkpointId: string; entryId: string }> {
    const s = this.require(id);
    const workspaceRoot = s.cwd ?? process.cwd();
    // Reconcile first: the checkpoint entry must land after every message
    // that causally precedes the code snapshot (rewind replays in order).
    await this.reconcileLog(s).catch(() => undefined);
    const record = await this.checkpoints.create({
      workspaceRoot,
      sessionId: id,
      label,
    });
    const entry = await this.logEvent(id, 'checkpoint', {
      checkpointId: record.id,
      label: label ?? '',
      workspaceRoot,
    });
    await this.logs.get(id)?.flush().catch(() => undefined);
    return { checkpointId: record.id, entryId: entry?.id ?? '' };
  }

  /**
   * F6 rewind: restore conversation AND code to the log entry `entryId`.
   * The current log is archived (`<id>.log.rewind.<ts>`), the log is
   * rewritten through the target entry plus a `rewind` marker, and the
   * newest shadow-git checkpoint at-or-before the target is restored into
   * the workspace. Returns the new session state summary.
   */
  async rewind(
    id: string,
    entryId: string,
  ): Promise<{ rewoundTo: string; droppedEntries: number; codeRestored: boolean }> {
    const s = this.require(id);
    const logPath = SessionLog.logPath(this.dir, id);
    const { entries } = await readLogFile(logPath);
    const targetIdx = entries.findIndex((e) => e.id === entryId);
    if (targetIdx < 0) {
      throw new RpcError(ErrorCode.InvalidParams, `log entry not found: ${entryId}`);
    }
    const kept = entries.slice(0, targetIdx + 1);
    const dropped = entries.length - kept.length;

    // Archive the full pre-rewind log for audit, then rewrite.
    const archivePath = `${logPath}.rewind.${Date.now()}`;
    await fs.copyFile(logPath, archivePath).catch(() => undefined);
    const oldLog = this.logs.get(id);
    if (oldLog) {
      await oldLog.close().catch(() => undefined);
      this.logs.delete(id);
    }
    await fs.writeFile(logPath, '', { mode: 0o600 }).catch(() => undefined);
    const log = await this.logFor(id);
    await log.importEntries(kept);
    await log.append('rewind', {
      targetEntryId: entryId,
      archivedPath: archivePath,
      droppedEntries: dropped,
    });
    await log.flush();

    // Conversation state = replay through the target.
    const replayed = replayLog(kept);
    s.messages = replayed.messages as ProviderMessage[];
    this.loggedMessageCounts.set(id, s.messages.length);

    // Code state = newest checkpoint at-or-before the target entry.
    let codeRestored = false;
    const checkpointsBefore = replayed.checkpoints;
    if (checkpointsBefore.length > 0) {
      const latest = checkpointsBefore[checkpointsBefore.length - 1];
      try {
        await this.checkpoints.restore({
          workspaceRoot: s.cwd ?? process.cwd(),
          id: latest.checkpointId,
        });
        codeRestored = true;
      } catch {
        codeRestored = false;
      }
    }
    await this.persist(s);
    return { rewoundTo: entryId, droppedEntries: dropped, codeRestored };
  }

  /**
   * F6 branch: fork a new session from `entryId` (or the log head). The new
   * session's log starts as a copy of the parent's prefix plus a `branch`
   * entry recording provenance; code is left untouched (use rewind first if
   * the workspace should also move).
   */
  async branch(
    id: string,
    entryId?: string,
    title?: string,
  ): Promise<{ session: StoredSession; parentSessionId: string }> {
    const parent = this.require(id);
    const { entries } = await readLogFile(SessionLog.logPath(this.dir, id));
    let slice = entries;
    if (entryId) {
      const idx = entries.findIndex((e) => e.id === entryId);
      if (idx < 0) {
        throw new RpcError(ErrorCode.InvalidParams, `log entry not found: ${entryId}`);
      }
      slice = entries.slice(0, idx + 1);
    }
    const replayed = replayLog(slice);
    const now = new Date().toISOString();
    const s: StoredSession = {
      id: randomUUID(),
      title: title ?? `Branch of ${parent.title}`,
      createdAt: now,
      updatedAt: now,
      cwd: parent.cwd,
      model: parent.model,
      messages: replayed.messages as ProviderMessage[],
    };
    this.sessions.set(s.id, s);
    const log = await this.logFor(s.id);
    await log.importEntries(slice, s.id);
    await log.append('branch', {
      parentSessionId: id,
      parentEntryId: entryId ?? entries[entries.length - 1]?.id ?? null,
      parentTitle: parent.title,
    });
    await log.flush();
    this.loggedMessageCounts.set(s.id, s.messages.length);
    await this.persist(s);
    return { session: s, parentSessionId: id };
  }

  /**
   * F6 export: session transcript as JSONL (raw log) or Markdown.
   * Lock-in kam, trust zyada.
   */
  async exportTranscript(id: string, format: 'jsonl' | 'markdown'): Promise<string> {
    this.require(id);
    const { entries } = await readLogFile(SessionLog.logPath(this.dir, id));
    if (format === 'jsonl') {
      return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    }
    return renderMarkdownTranscript(id, entries);
  }

  /** Persist one session (history included). The write is atomic (temp file +
   *  rename) so a crash or racing shutdown can never leave a truncated file.
   *  Files are owner-only (0600): history may contain pasted secrets.
   *
   *  F6: before the JSON write-through, any messages not yet in the event
   *  log are appended as `message` entries and the log is fsync-flushed —
   *  the log (not this file) is the durable record of truth. */
  /** Append `message` entries for any in-memory messages not yet in the log.
   *  Keeps log order == causal order (e.g. a checkpoint entry always lands
   *  after the messages that precede it). */
  private async reconcileLog(s: StoredSession): Promise<void> {
    const log = await this.logFor(s.id);
    const logged = this.loggedMessageCounts.get(s.id) ?? 0;
    for (let i = logged; i < s.messages.length; i++) {
      const m = s.messages[i] as {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        toolCalls?: unknown;
      };
      await log.append('message', {
        role: m.role ?? 'user',
        content: m.content,
        ...(typeof m.toolCallId === 'string' ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
      });
    }
    this.loggedMessageCounts.set(s.id, s.messages.length);
    await log.flush();
  }

  async persist(s: StoredSession): Promise<void> {
    s.updatedAt = new Date().toISOString();
    try {
      await this.reconcileLog(s);
    } catch {
      // Log failure must never break the legacy persist path.
    }
    const full = path.join(this.dir, `${s.id}.json`);
    const tmp = `${full}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
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
        this.loggedMessageCounts.set(raw.id, 0);
        // F6 one-time migration: seed the event log for pre-F6 sessions so
        // every session on disk becomes log-backed after one daemon boot.
        const hasLog = await fs
          .stat(SessionLog.logPath(this.dir, raw.id))
          .then((st) => st.isFile())
          .catch(() => false);
        if (!hasLog) await this.migrateLegacyToLog(raw).catch(() => undefined);
      } catch {
        await fs.rename(full, `${full}.corrupt`).catch(() => undefined);
      }
    }
  }
}
