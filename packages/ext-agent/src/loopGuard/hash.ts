// sunday-agent — F2 Loop Breaker: normalized hashing.
//
// Pure TS (no node:crypto) so the guard works in the extension host, the
// sidecar, and unit tests alike. cyrb53 is a well-known public-domain
// 53-bit string hash — good enough for loop detection, not for security.

/** cyrb53 hash → 12-char hex string. */
export function hashString(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0').slice(0, 4);
}

const SECRET_KEY_HINT = /(api[_-]?key|secret|token|password|passwd|auth|bearer|private[_-]?key)/i;

/**
 * Normalize tool arguments into a canonical string:
 * - object keys sorted recursively (arg order doesn't matter)
 * - floats rounded to 4dp (noise tolerance)
 * - values of secret-looking keys redacted (a rotated key must NOT look
 *   like a "different" call — and secrets must never land in a hash log)
 * - undefined dropped
 */
export function normalizeArgs(args: unknown): string {
  return JSON.stringify(normalizeValue(args));
}

function normalizeValue(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.round(v * 10000) / 10000;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v as Record<string, unknown>).sort()) {
    const val = (v as Record<string, unknown>)[key];
    if (val === undefined) continue;
    out[key] = SECRET_KEY_HINT.test(key) ? '<redacted>' : normalizeValue(val);
  }
  return out;
}

/** Stable identity for "same tool + near-identical args". */
export function hashToolCall(tool: string, args: unknown): string {
  return hashString(`${tool}\n${normalizeArgs(args)}`);
}

/**
 * Normalize a failing tool output into a stable error signature:
 * lowercase, strip volatile bits (timestamps, hex hashes, UUIDs, numbers,
 * absolute paths, line/col numbers), collapse whitespace, truncate.
 * Two runs of the "same" failure → same signature.
 */
export function errorSignature(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?\b/g, '<time>');
  s = s.replace(/\b[0-9a-f]{32,}\b/g, '<hex>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>');
  s = s.replace(/(["'(/\\]|\s)([a-z]:)?[/\\][\w\-./\\]+/g, '$1<path>');
  s = s.replace(/:\d+(:\d+)?\b/g, ':<n>');
  s = s.replace(/\b\d+(\.\d+)?\b/g, '<n>');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 240) s = s.slice(0, 240);
  return hashString(`err\n${s}`);
}
