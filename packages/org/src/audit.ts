/**
 * @sunday/org — F15: audit log.
 *
 * Append-only JSONL audit trail: every approval, budget breach, policy
 * decision, hook block, loop-guard trip, and session event is recorded with
 * actor + timestamp. Written to `~/.sunday/audit/<yyyy-mm-dd>.jsonl`;
 * `exportAudit()` produces a portable JSONL dump for compliance review.
 *
 * This is the file-based audit sink from the F15 spec (OTLP comes later,
 * on demand signal).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const AuditEventTypeSchema = z.enum([
  'approval', // F7: user approved / denied a tool call
  'budget-breach', // F1: soft warning or hard pause
  'policy-decision', // F7: allow/ask/deny evaluation
  'hook-block', // F8: hook blocked or modified a tool call
  'loop-guard', // F2: runaway loop detected
  'session', // F6: session create/rewind/branch/export
  'org-policy', // F15: org bundle loaded / lock enforced
  'custom',
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  /** Unique event id. */
  id: z.string().min(1),
  /** ISO-8601 timestamp. */
  ts: z.string().datetime(),
  type: AuditEventTypeSchema,
  /** Who/what acted: user email, agent session id, or `system`. */
  actor: z.string().min(1),
  /** Org id when an org bundle is active. */
  orgId: z.string().optional(),
  /** One-line human summary. */
  summary: z.string().min(1).max(500),
  /** Structured details (never secrets — callers must redact). */
  details: z.record(z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface AuditLogOptions {
  /** Base dir; defaults to ~/.sunday/audit. Overridable for tests. */
  dir?: string;
  /** Override "today" (tests). Format yyyy-mm-dd. */
  dateOverride?: string;
}

let eventCounter = 0;

function newEventId(): string {
  eventCounter += 1;
  return `ae-${Date.now().toString(36)}-${eventCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Append-only JSONL audit log. Safe for concurrent writers (O_APPEND). */
export class AuditLog {
  private readonly dir: string;
  private readonly dateOverride?: string;

  constructor(opts: AuditLogOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.sunday', 'audit');
    this.dateOverride = opts.dateOverride;
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(ts: string): string {
    return join(this.dir, `${ts.slice(0, 10)}.jsonl`);
  }

  /** Record one event. Returns the stored event (with id + ts filled). */
  record(input: {
    type: AuditEventType;
    actor: string;
    summary: string;
    orgId?: string;
    details?: Record<string, unknown>;
  }): AuditEvent {
    const event = AuditEventSchema.parse({
      id: newEventId(),
      ts: new Date().toISOString(),
      type: input.type,
      actor: input.actor,
      orgId: input.orgId,
      summary: input.summary,
      details: input.details ?? {},
    });
    const line = JSON.stringify(event) + '\n';
    const stamp = this.dateOverride ?? todayStamp();
    appendFileSync(join(this.dir, `${stamp}.jsonl`), line, { encoding: 'utf8' });
    return event;
  }

  /** Convenience: F7 approval decision. */
  recordApproval(input: {
    actor: string;
    summary: string;
    orgId?: string;
    details?: Record<string, unknown>;
  }): AuditEvent {
    return this.record({ ...input, type: 'approval' });
  }

  /** Convenience: F1 budget soft-warning / hard-pause. */
  recordBudgetBreach(input: {
    actor: string;
    summary: string;
    orgId?: string;
    details?: Record<string, unknown>;
  }): AuditEvent {
    return this.record({ ...input, type: 'budget-breach' });
  }

  /** Convenience: F7/F15 policy evaluation outcome. */
  recordPolicyDecision(input: {
    actor: string;
    summary: string;
    orgId?: string;
    details?: Record<string, unknown>;
  }): AuditEvent {
    return this.record({ ...input, type: 'policy-decision' });
  }

  /**
   * Export events as a JSONL string. Optional ISO date-range filter
   * (inclusive, yyyy-mm-dd) and type filter.
   */
  export(opts: { from?: string; to?: string; type?: AuditEventType } = {}): string {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    const out: string[] = [];
    for (const f of files) {
      const day = f.slice(0, 10);
      if (opts.from && day < opts.from) continue;
      if (opts.to && day > opts.to) continue;
      const content = readFileSync(join(this.dir, f), 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (opts.type) {
          try {
            const parsed = JSON.parse(trimmed) as { type?: string };
            if (parsed.type !== opts.type) continue;
          } catch {
            continue; // skip corrupt lines on export, never fail the dump
          }
        }
        out.push(trimmed);
      }
    }
    return out.length > 0 ? out.join('\n') + '\n' : '';
  }

  /** Parse the export back into events (round-trip helper for tests/UIs). */
  exportParsed(opts: { from?: string; to?: string; type?: AuditEventType } = {}): AuditEvent[] {
    return this.export(opts)
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => AuditEventSchema.parse(JSON.parse(l)));
  }
}

/** Default process-wide audit log (lazy singleton). */
let defaultLog: AuditLog | null = null;
export function getAuditLog(dir?: string): AuditLog {
  if (!defaultLog || dir) {
    defaultLog = new AuditLog(dir ? { dir } : {});
  }
  return defaultLog;
}

/** True when the on-disk dir exists (used by UIs to show audit availability). */
export function auditDirExists(dir?: string): boolean {
  return existsSync(dir ?? join(homedir(), '.sunday', 'audit'));
}
