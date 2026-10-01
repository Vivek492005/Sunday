/** Browser navigation security policy (§18.2), enforced server-side.
 *
 * Rules:
 *  - `file://` is always blocked; only http:/https: may navigate.
 *  - Loopback (`localhost`, `127.0.0.1`, `::1`) is always allowed.
 *  - User-approved domains (exact or subdomain) are always allowed.
 *  - Private IP ranges are blocked unless user-approved.
 *  - Any other origin: the first navigation returns `needsApproval` and does
 *    NOT navigate; the client retries with `approve: true` to record the
 *    origin as approved for the rest of the session.
 *
 * Limitation: hostnames are classified lexically — a public hostname that
 * DNS-resolves to a private address (DNS rebinding) is not detected without
 * a resolver. The browser still runs in its own profile with downloads
 * disabled, so the blast radius stays small.
 */

export interface BrowserPolicyOptions {
  /** User-approved domains, e.g. ["example.com"] (covers subdomains). */
  approvedDomains?: string[];
}

/** A navigation the policy refuses outright. Surfaced as PolicyDenied. */
export class BrowserPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserPolicyError';
  }
}

export type NavigationDecision = { kind: 'allow' } | { kind: 'needsApproval'; origin: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function isIPv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function ipv4Bytes(host: string): [number, number, number, number] | null {
  if (!isIPv4(host)) return null;
  const parts = host.split('.').map(Number);
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts as [number, number, number, number];
}

/** True for RFC 1918 / link-local / carrier-grade-NAT ranges. Loopback is
 *  handled separately (always allowed) but included here for completeness. */
function isPrivateIPv4(host: string): boolean {
  const b = ipv4Bytes(host);
  if (!b) return false;
  const [a, c] = [b[0], b[1]];
  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && c >= 16 && c <= 31) || // 172.16.0.0/12
    (a === 192 && c === 168) || // 192.168.0.0/16
    (a === 169 && c === 254) || // 169.254.0.0/16
    a === 0 // 0.0.0.0/8
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h.startsWith('fc') || // fc00::/7 unique-local
    h.startsWith('fd') ||
    h.startsWith('fe80') // fe80::/10 link-local
  );
}

function normalizeHost(raw: string): string {
  let h = raw.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // IPv6 literal
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

export class BrowserPolicy {
  private readonly approvedDomains: string[];

  constructor(opts: BrowserPolicyOptions = {}) {
    this.approvedDomains = (opts.approvedDomains ?? []).map((d) =>
      normalizeHost(d.trim()).replace(/^\*\./, ''),
    );
  }

  private domainApproved(host: string): boolean {
    return this.approvedDomains.some((d) => host === d || host.endsWith('.' + d));
  }

  /**
   * Classify a navigation target. Throws BrowserPolicyError when the target
   * is blocked; returns needsApproval (without navigating) for first-seen
   * public origins.
   */
  checkNavigation(targetUrl: string, approvedOrigins: ReadonlySet<string>): NavigationDecision {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      throw new BrowserPolicyError(`blocked: not a valid URL: ${targetUrl}`);
    }
    if (url.protocol === 'file:') {
      throw new BrowserPolicyError('blocked: file:// URLs are never allowed in the agent browser');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BrowserPolicyError(`blocked: scheme "${url.protocol}" is not allowed (http/https only)`);
    }
    const host = normalizeHost(url.hostname);
    if (LOOPBACK.has(host)) return { kind: 'allow' };
    if (this.domainApproved(host)) return { kind: 'allow' };
    if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
      throw new BrowserPolicyError(
        `blocked: private network address "${url.hostname}" is not user-approved`,
      );
    }
    const origin = url.origin;
    if (approvedOrigins.has(origin)) return { kind: 'allow' };
    return { kind: 'needsApproval', origin };
  }
}
