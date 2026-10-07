/**
 * @sunday/hosted-gateway — configuration (Phase 8, optional hosted gateway).
 *
 * All settings come from the environment (`SUNDAY_HOSTED_*`) with an
 * optional JSON config file (`SUNDAY_HOSTED_CONFIG`) for the API key list.
 * Env vars take precedence over the file for scalar settings; API keys are
 * merged (env keys + file keys).
 *
 * The gateway operator holds the *provider* keys (OPENROUTER_API_KEY /
 * GROQ_API_KEY, read by @sunday/gateway as usual). Remote clients
 * authenticate with *gateway-issued* API keys — never with provider keys.
 */

import { readFileSync } from 'node:fs';

export interface HostedGatewayConfig {
  /** TCP port to listen on. */
  port: number;
  /** Bind host. Default 127.0.0.1 — never 0.0.0.0 unless the operator opts in. */
  host: string;
  /**
   * Gateway API keys. Each entry: `{ id, secret }`.
   * From `SUNDAY_HOSTED_KEYS` as comma-separated `id:secret` pairs
   * (the id part is optional — `secret` alone gets an auto id), and/or
   * from the JSON config file's `keys` array.
   */
  keys: Array<{ id: string; secret: string }>;
  /** Requests per minute per API key (token bucket). */
  requestsPerMinute: number;
  /** Estimated input tokens per minute per API key (cost control). */
  tokensPerMinute: number;
  /** Max request body bytes. */
  maxBodyBytes: number;
  /** Max chat messages per request. */
  maxMessages: number;
  /** Max characters per message content. */
  maxMessageChars: number;
  /** Hard cap for `max_tokens` (client values are clamped, not rejected). */
  maxTokensCap: number;
  /**
   * Model allowlist as `provider:model` refs or bare ids
   * (comma-separated). Empty = all registered provider models.
   */
  allowedModels: string[];
  /** Optional IP allowlist: exact IPs or CIDR ranges (comma-separated). */
  ipAllowlist: string[];
  /** Audit log destination: file path, or "stdout". */
  auditLog: string;
  /** Upstream provider call timeout (ms). */
  upstreamTimeoutMs: number;
  /**
   * Social OAuth identity mode (GitHub / Google / Microsoft). When true,
   * clients authenticate with an OAuth token from the IDE sign-in instead
   * of a static gateway API key. Quota is enforced per user id.
   * Env: SUNDAY_HOSTED_SOCIAL_AUTH=1 (or legacy SUNDAY_HOSTED_GITHUB_AUTH=1)
   */
  socialAuth: boolean;
  /** Which OAuth providers to accept. Env: SUNDAY_HOSTED_OAUTH_PROVIDERS */
  oauthProviders: Array<'github' | 'google' | 'microsoft'>;
  /** Free-tier requests per GitHub user per UTC day. Env: SUNDAY_HOSTED_DAILY_QUOTA */
  dailyQuota: number;
}

interface FileConfig {
  keys?: Array<{ id?: string; secret: string }>;
}

function num(env: string | undefined, fallback: number): number {
  if (env === undefined || env.trim() === '') return fallback;
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid numeric config: ${env}`);
  }
  return n;
}

function list(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKeyEntry(entry: string, index: number): { id: string; secret: string } {
  const i = entry.indexOf(':');
  if (i > 0) {
    return { id: entry.slice(0, i).trim(), secret: entry.slice(i + 1).trim() };
  }
  return { id: `key-${index + 1}`, secret: entry.trim() };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostedGatewayConfig {
  let fileKeys: Array<{ id: string; secret: string }> = [];
  const configPath = env.SUNDAY_HOSTED_CONFIG?.trim();
  if (configPath) {
    let parsed: FileConfig;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8')) as FileConfig;
    } catch (err) {
      throw new Error(`cannot read SUNDAY_HOSTED_CONFIG=${configPath}: ${(err as Error).message}`);
    }
    fileKeys = (parsed.keys ?? []).map((k, i) => ({
      id: k.id?.trim() || `key-${i + 1}`,
      secret: k.secret,
    }));
  }

  const envKeys = list(env.SUNDAY_HOSTED_KEYS).map((e, i) => parseKeyEntry(e, i));
  const keys = [...envKeys, ...fileKeys].filter((k) => k.secret.length > 0);
  const socialAuth =
    env.SUNDAY_HOSTED_SOCIAL_AUTH?.trim() === '1' ||
    env.SUNDAY_HOSTED_GITHUB_AUTH?.trim() === '1'; // legacy alias
  const oauthProviders = list(env.SUNDAY_HOSTED_OAUTH_PROVIDERS)
    .map((p) => p.toLowerCase())
    .filter((p): p is 'github' | 'google' | 'microsoft' =>
      p === 'github' || p === 'google' || p === 'microsoft',
    );
  if (keys.length === 0 && !socialAuth) {
    throw new Error(
      'no API keys configured: set SUNDAY_HOSTED_KEYS (comma-separated id:secret), SUNDAY_HOSTED_CONFIG, or enable SUNDAY_HOSTED_SOCIAL_AUTH=1',
    );
  }

  return {
    port: num(env.SUNDAY_HOSTED_PORT, num(env.PORT, 8080)),
    host: env.SUNDAY_HOSTED_HOST?.trim() || '127.0.0.1',
    keys,
    requestsPerMinute: num(env.SUNDAY_HOSTED_RPM, 60),
    tokensPerMinute: num(env.SUNDAY_HOSTED_TPM, 100_000),
    maxBodyBytes: num(env.SUNDAY_HOSTED_MAX_BODY_BYTES, 256 * 1024),
    maxMessages: num(env.SUNDAY_HOSTED_MAX_MESSAGES, 100),
    maxMessageChars: num(env.SUNDAY_HOSTED_MAX_MESSAGE_CHARS, 32_768),
    maxTokensCap: num(env.SUNDAY_HOSTED_MAX_TOKENS, 4096),
    allowedModels: list(env.SUNDAY_HOSTED_MODELS),
    ipAllowlist: list(env.SUNDAY_HOSTED_ALLOWLIST),
    auditLog: env.SUNDAY_HOSTED_AUDIT_LOG?.trim() || 'stdout',
    upstreamTimeoutMs: num(env.SUNDAY_HOSTED_UPSTREAM_TIMEOUT_MS, 120_000),
    socialAuth,
    oauthProviders: oauthProviders.length > 0 ? oauthProviders : ['github', 'google', 'microsoft'],
    dailyQuota: num(env.SUNDAY_HOSTED_DAILY_QUOTA, 200),
  };
}
