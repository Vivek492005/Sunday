/**
 * @sunday/hosted-gateway — IP allowlist matching (exact IPs + IPv4 CIDR).
 */

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return undefined;
    const v = Number(p);
    if (v < 0 || v > 255) return undefined;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function cidrContains(cidr: string, ip: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const base = ipv4ToInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  const addr = ipv4ToInt(ip);
  if (base === undefined || addr === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (base & mask) === (addr & mask);
}

/** Normalize IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to plain IPv4. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  return m ? m[1]! : ip;
}

/**
 * True when `ip` is allowed. An empty allowlist allows everyone
 * (the operator opted out of IP restriction).
 */
export function ipAllowed(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const norm = normalizeIp(ip);
  for (const entry of allowlist) {
    if (entry.includes('/')) {
      if (cidrContains(entry, norm)) return true;
    } else if (normalizeIp(entry) === norm) {
      return true;
    }
  }
  return false;
}
