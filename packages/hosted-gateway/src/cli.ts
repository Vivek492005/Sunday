#!/usr/bin/env node
/**
 * sunday-hosted-gateway — optional hosted gateway for users without their
 * own provider keys (Phase 8).
 *
 * The operator holds the provider keys (OPENROUTER_API_KEY / GROQ_API_KEY).
 * Remote clients authenticate with gateway-issued API keys and get
 * OpenAI-compatible text chat — nothing else.
 *
 *   SUNDAY_HOSTED_KEYS="alice:s3cret,bob:s3cret2" sunday-hosted-gateway --port 8080
 *
 * All settings: see README.md (env vars SUNDAY_HOSTED_*).
 */

import { loadConfig } from './config.js';
import { HostedGatewayServer } from './server.js';

function parseArgs(argv: string[]): { port?: number; host?: string } {
  const out: { port?: number; host?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1] !== undefined) {
      const p = Number(argv[++i]);
      if (!Number.isInteger(p) || p <= 0 || p > 65535) {
        throw new Error(`invalid --port: ${argv[i]}`);
      }
      out.port = p;
    } else if (a === '--host' && argv[i + 1] !== undefined) {
      out.host = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(`usage: sunday-hosted-gateway [--port N] [--host ADDR]

Serves an OpenAI-compatible chat API (text only) with API-key auth,
per-key rate limits, and audit logging.

Two auth modes:
  1. GitHub OAuth (zero-config free tier): set SUNDAY_HOSTED_GITHUB_AUTH=1.
     Clients send their GitHub OAuth token as the Bearer credential;
     quota is enforced per GitHub user per UTC day (SUNDAY_HOSTED_DAILY_QUOTA).
  2. Static API keys: SUNDAY_HOSTED_KEYS="alice:s3cret,bob:s3cret2".

Environment (see README.md):
  SUNDAY_HOSTED_GITHUB_AUTH   enable GitHub-token auth (default off)
  SUNDAY_HOSTED_DAILY_QUOTA   requests/day per GitHub user (default 200)
  SUNDAY_HOSTED_KEYS          comma-separated id:secret API keys
  SUNDAY_HOSTED_PORT          listen port (default 8080)
  SUNDAY_HOSTED_HOST          bind host (default 127.0.0.1)
  SUNDAY_HOSTED_RPM           requests/min per key (default 60)
  SUNDAY_HOSTED_TPM           input tokens/min per key (default 100000)
  SUNDAY_HOSTED_MODELS        model allowlist, comma-separated (default: all)
  SUNDAY_HOSTED_ALLOWLIST     IP/CIDR allowlist, comma-separated (default: none)
  SUNDAY_HOSTED_AUDIT_LOG     audit log path or "stdout" (default stdout)

Provider keys (operator's): OPENROUTER_API_KEY, GROQ_API_KEY.`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  if (args.port !== undefined) config.port = args.port;
  if (args.host !== undefined) config.host = args.host;

  const server = new HostedGatewayServer(config);
  await server.listen();
  const addr = server.address();
  console.log(`sunday-hosted-gateway listening on ${addr.host}:${addr.port}`);

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
