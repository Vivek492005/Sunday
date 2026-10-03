/**
 * @sunday/hosted-gateway — API key authentication.
 *
 * Remote clients authenticate with gateway-issued keys via
 * `Authorization: Bearer <secret>`. Comparison is constant-time
 * (`crypto.timingSafeEqual`) so key validity isn't leaked through timing.
 * Audit logs reference keys by a truncated SHA-256 fingerprint — never the
 * secret itself.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface ApiKey {
  id: string;
  secret: string;
}

/** First 8 hex chars of SHA-256(secret) — safe to put in logs. */
export function keyFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class KeyStore {
  private readonly keys: ApiKey[];

  constructor(keys: ApiKey[]) {
    this.keys = keys;
  }

  /** Extract the Bearer secret from an Authorization header value. */
  static extractBearer(authorization: string | undefined): string | undefined {
    if (!authorization) return undefined;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    return m?.[1];
  }

  /** Find the key matching `secret`, or undefined. Constant-time per key. */
  verify(secret: string | undefined): ApiKey | undefined {
    if (!secret) return undefined;
    for (const k of this.keys) {
      if (safeEqual(k.secret, secret)) return k;
    }
    return undefined;
  }
}
