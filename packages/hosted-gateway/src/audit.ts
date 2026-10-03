/**
 * @sunday/hosted-gateway — audit logging.
 *
 * Every request is logged as one JSON line: timestamp, request id, key
 * fingerprint (never the secret), client IP, method, path, model, outcome,
 * latency, and estimated token usage. Message *content* is never logged —
 * only sizes. The sink is a file (appended) or stdout.
 */

import { appendFileSync } from 'node:fs';

export interface AuditRecord {
  ts: string;
  requestId: string;
  /** Truncated SHA-256 of the API key, or "none"/"invalid". */
  keyId: string;
  ip: string;
  method: string;
  path: string;
  model?: string;
  status: number;
  latencyMs: number;
  /** Estimated input tokens (0 when unknown). */
  promptTokensEst: number;
  /** Estimated output tokens (0 when unknown). */
  completionTokensEst: number;
  error?: string;
}

export class AuditLog {
  private readonly dest: string;

  constructor(dest: string) {
    this.dest = dest;
  }

  write(rec: AuditRecord): void {
    const line = JSON.stringify(rec) + '\n';
    try {
      if (this.dest === 'stdout') {
        process.stdout.write(line);
      } else {
        appendFileSync(this.dest, line, { encoding: 'utf8' });
      }
    } catch {
      // Audit logging must never break request handling.
    }
  }
}
